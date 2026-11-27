import { randomUUID } from "node:crypto";
import type { WorkItemRecord, WorkOrchestrationStore, WorkflowDefinition } from "./work-orchestration-store.js";
import { subjectForResource, type DagGraph, type DagNode } from "./work-dag.js";
import { WorkDagPlannerCoordinator, WorkDagScheduler } from "./work-dag-engine.js";
import type { WorkDagNodeExecutionRecord, WorkDagProposalRecord } from "./work-dag-runtime.js";
import { DEFAULT_WORK_DAG_PLANNING_POLICY } from "./work-dag-policy.js";
import {
  deterministicWorkspaceFailureCode,
  executorFailureDisposition,
  executorRetryDelayMs,
  safeExecutorFailureCode,
} from "./executor-failure.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type ReplanTrigger =
  | "initial"
  | "agent_result"
  | "verification_failure"
  | "review_rework"
  | "failure"
  | "user_update"
  | "new_information"
  | "blocker_resolution"
  | "manual"
  | "deadlock";

function latestCurrentExecutions(
  nodes: readonly DagNode[],
  executions: readonly WorkDagNodeExecutionRecord[],
): Map<string, WorkDagNodeExecutionRecord> {
  const ids = new Set(nodes.map((node) => node.id));
  const result = new Map<string, WorkDagNodeExecutionRecord>();
  for (const execution of executions) {
    if (!ids.has(execution.nodeId)) continue;
    const old = result.get(execution.nodeId);
    if (!old || old.generation < execution.generation) result.set(execution.nodeId, execution);
  }
  return result;
}

function failureActivatedReadyNodeId(
  graph: DagGraph,
  failedNodeId: string,
  readyNodeIds: readonly string[],
): string | null {
  const ready = new Set(readyNodeIds);
  const isFailurePredicate = (predicate: DagGraph["edges"][number]["predicate"]) =>
    predicate?.kind === "node_result" && predicate.nodeId === failedNodeId && predicate.state === "failed";
  return (
    graph.nodes.find(
      (node) =>
        ready.has(node.id) &&
        (node.requirements.some((predicate) => isFailurePredicate(predicate)) ||
          graph.edges.some((edge) => edge.to === node.id && isFailurePredicate(edge.predicate))),
    )?.id ?? null
  );
}

function triggerAllowed(definition: WorkflowDefinition, trigger: ReplanTrigger): boolean {
  if (trigger === "initial" || trigger === "deadlock") return true;
  const policy = definition.planning?.replanPolicy ?? DEFAULT_WORK_DAG_PLANNING_POLICY.replanPolicy;
  switch (trigger) {
    case "agent_result":
      return policy.includes("always_after_agent_turn");
    case "verification_failure":
    case "failure":
      return policy.includes("on_failure");
    case "review_rework":
      return policy.includes("on_review_rework");
    case "manual":
      return policy.includes("manual");
    case "blocker_resolution":
      return policy.includes("on_blocker_resolution");
    case "user_update":
      return policy.includes("on_user_update");
    case "new_information":
      return policy.includes("on_new_information");
    default:
      return false;
  }
}

const NON_RETRYABLE_EXECUTOR_ROUTING_CODES = new Set([
  "EXPERT_UNAVAILABLE",
  "AMBIGUOUS_EXPERT",
  "EXPERT_FORBIDDEN",
  "DEPLOYMENT_REQUIRED",
  "DEPLOYMENT_FORBIDDEN",
  "REPOSITORY_REQUIRED",
  "REPOSITORY_FORBIDDEN",
  "RUNTIME_PROFILE_UNAVAILABLE",
  "RUNTIME_PROFILE_MISMATCH",
  "SOURCE_REPOSITORY_UNAVAILABLE",
]);

function executorRoutingFailureCode(execution: WorkDagNodeExecutionRecord): string | null {
  const summary = execution.result?.summary?.trim() ?? "";
  return NON_RETRYABLE_EXECUTOR_ROUTING_CODES.has(summary) ? summary : null;
}

function semanticAgentBlocker(execution: WorkDagNodeExecutionRecord): { code: string; summary: string } | null {
  const summary = execution.result?.summary?.trim() ?? "";
  const firstLine = summary.split(/\r?\n/, 1)[0] ?? "";
  const match = /^AGENT_BLOCKED(?::([A-Z][A-Z0-9_]{0,79}))?$/.exec(firstLine);
  if (!match) return null;
  return { code: match[1] ?? "AGENT_BLOCKED", summary };
}

export class WorkDagRuntime {
  private readonly ownerId = "work-dag-runtime:" + randomUUID();

  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly planner: WorkDagPlannerCoordinator,
    private readonly scheduler: WorkDagScheduler,
  ) {}

  private planningBudget(work: WorkItemRecord): number {
    return (
      this.store.getWorkflow(work.workflowId, work.workflowVersion).definition.planning?.maxReplans ??
      DEFAULT_WORK_DAG_PLANNING_POLICY.maxReplans
    );
  }

  private planningAttempts(workItemId: string): number {
    const proposals = this.store.listDagProposals(workItemId).length;
    const failures = this.store
      .listDagDecisions(workItemId)
      .filter((decision) => decision.action === "planner.failed").length;
    return proposals + failures;
  }

  private block(
    workItemId: string,
    principalId: string,
    scope: string,
    reason: string,
    context: string | null,
    now: number,
    blockedByType = "dag",
    blockedByRef?: string,
  ): boolean {
    const work = this.store.getWork(workItemId, principalId, scope);
    if (work.status === "blocked" || TERMINAL.has(work.status)) return false;
    this.store.blockWork(workItemId, principalId, scope, work.stateRevision, reason, context, now, {
      resumeCondition: "manual",
      blockedByType,
      ...(blockedByRef ? { blockedByRef } : {}),
    });
    return true;
  }

  private async replan(
    workItemId: string,
    principalId: string,
    scope: string,
    trigger: ReplanTrigger,
    now: number,
  ): Promise<boolean> {
    const work = this.store.getWork(workItemId, principalId, scope);
    const workflow = this.store.getWorkflow(work.workflowId, work.workflowVersion);
    if (trigger === "deadlock" && !this.store.evaluateDagCompletion(workItemId).deadlocked) {
      return true;
    }
    if (!triggerAllowed(workflow.definition, trigger)) {
      return this.block(workItemId, principalId, scope, "DAG_REPLAN_NOT_ALLOWED", JSON.stringify({ trigger }), now);
    }

    const budget = this.planningBudget(work);
    if (this.planningAttempts(workItemId) >= budget) {
      return this.block(
        workItemId,
        principalId,
        scope,
        "DAG_REPLAN_LIMIT_REACHED",
        JSON.stringify({ trigger, maxReplans: budget }),
        now,
      );
    }

    const proposal = await this.planner.replan(workItemId, principalId, scope, trigger, now);
    if (!proposal) {
      if (this.planningAttempts(workItemId) >= budget) {
        return this.block(
          workItemId,
          principalId,
          scope,
          "DAG_REPLAN_LIMIT_REACHED",
          JSON.stringify({ trigger, maxReplans: budget }),
          now,
        );
      }
      return true;
    }

    if (proposal.status === "rejected") {
      if (proposal.decisionCodes.includes("PLAN_POLICY_CONTEXT_DRIFT")) {
        const current = this.store.getWork(workItemId, principalId, scope);
        if (current.activeWorkAttemptId) {
          this.store.finishWorkAttempt(
            workItemId,
            current.activeWorkAttemptId,
            principalId,
            scope,
            current.stateRevision,
            "cancelled",
            "queued",
            now,
          );
          return true;
        }
      }
      return this.block(
        workItemId,
        principalId,
        scope,
        "DAG_PLAN_REJECTED",
        JSON.stringify({
          proposalId: proposal.proposalId,
          trigger,
          codes: proposal.decisionCodes,
        }),
        now,
        "dag_proposal",
        proposal.proposalId,
      );
    }
    if (proposal.status === "noop") {
      if (trigger === "deadlock") {
        return this.block(
          workItemId,
          principalId,
          scope,
          "DAG_PLAN_DEADLOCK",
          JSON.stringify({ proposalId: proposal.proposalId, trigger }),
          now,
          "dag_proposal",
          proposal.proposalId,
        );
      }
      return true;
    }
    // A stale proposal mutated no current plan. Returning true causes the next reconcile
    // to capture a fresh Planner input instead of installing a stale result.
    return proposal.status === "accepted" || proposal.status === "stale";
  }

  private currentFailureReason(
    work: WorkItemRecord,
    nodes: readonly DagNode[],
    executions: Map<string, WorkDagNodeExecutionRecord>,
  ): { trigger: ReplanTrigger; execution: WorkDagNodeExecutionRecord; node: DagNode } | null {
    for (const node of nodes) {
      const execution = executions.get(node.id);
      if (execution?.state !== "failed") continue;
      if (node.kind === "verification") return { trigger: "verification_failure", execution, node };
      if (node.kind === "review" && work.status === "rework") {
        return { trigger: "review_rework", execution, node };
      }
      return { trigger: "failure", execution, node };
    }
    return null;
  }

  private canFinishAttempt(missing: readonly string[]): boolean {
    return missing.every(
      (item) =>
        item === "policy:latest_work_attempt_succeeded" ||
        item === "PLAN_DEADLOCK" ||
        item.startsWith("ACTIVE_WORK_ATTEMPT:"),
    );
  }

  async reconcileWork(workItemId: string, principalId: string, scope: string, now = Date.now()): Promise<boolean> {
    let work = this.store.getWork(workItemId, principalId, scope);
    const workflow = this.store.getWorkflow(work.workflowId, work.workflowVersion);
    if (work.orchestrationEngine !== "dynamic-dag" || TERMINAL.has(work.status)) return false;
    if (work.status === "blocked") return false;

    if (work.currentRequirementRevision === 0) {
      this.store.ensureRequirementSnapshot(workItemId, now);
      return true;
    }

    // Recover a durable intent that was claimed before the process crashed but before
    // the external executor was entered. No new execution generation is created.
    if (await this.scheduler.recoverOne(workItemId, principalId, scope, this.ownerId, now)) return true;

    // Reconcile a previously dispatched asynchronous/external action before scheduling
    // any new mutation. This also performs lease/fence handoff after restart.
    if (await this.scheduler.reconcileOne(workItemId, principalId, scope, this.ownerId, now)) return true;

    work = this.store.getWork(workItemId, principalId, scope);
    if (work.currentDagRevision === 0) {
      return this.replan(workItemId, principalId, scope, "initial", now);
    }

    const revision = this.store.getDagRevision(workItemId, work.currentDagRevision);
    const currentExecutions = latestCurrentExecutions(revision.graph.nodes, this.store.listDagExecutions(workItemId));
    const unknown = [...currentExecutions.values()].find((execution) => execution.state === "external_outcome_unknown");
    if (unknown) {
      const scopedEvaluation = this.store.evaluateDagCompletion(workItemId);
      if (scopedEvaluation.readyNodeIds.length > 0) {
        try {
          return await this.scheduler.runOne(workItemId, principalId, scope, this.ownerId, now);
        } catch (error) {
          const code =
            error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "DAG_EXECUTOR_FAILED";
          return this.block(
            workItemId,
            principalId,
            scope,
            code === "DAG_EXECUTOR_NOT_FOUND" ? "DAG_EXECUTOR_UNAVAILABLE" : "DAG_EXECUTOR_FAILED",
            JSON.stringify({ code }),
            now,
            "dag_executor",
          );
        }
      }
      if (scopedEvaluation.runningNodeIds.length > 0 || scopedEvaluation.waitingNodeIds.length > 0) return false;
      return this.block(
        workItemId,
        principalId,
        scope,
        "DAG_EXTERNAL_OUTCOME_UNKNOWN",
        JSON.stringify({
          nodeId: unknown.nodeId,
          nodeExecutionId: unknown.nodeExecutionId,
          externalRef: unknown.externalRef,
        }),
        now,
        "dag_execution",
        unknown.nodeExecutionId,
      );
    }
    const inFlight = [...currentExecutions.values()].some(
      (execution) => execution.state === "claimed" || execution.state === "running",
    );
    const manualRequest = this.store.listDagReplanRequests(workItemId).find((request) => request.state === "pending");
    if (manualRequest) {
      if (inFlight) return false;
      const beforeProposalIds = new Set(this.store.listDagProposals(workItemId).map((proposal) => proposal.proposalId));
      const changed = await this.replan(workItemId, principalId, scope, "manual", now);
      const proposal = this.store
        .listDagProposals(workItemId)
        .filter((candidate) => candidate.reasonCode === "manual" && !beforeProposalIds.has(candidate.proposalId))
        .at(-1);
      const after = this.store.getWorkInternal(workItemId);
      const terminalPolicyRejection =
        after.status === "blocked" &&
        (after.blockedReason === "DAG_REPLAN_NOT_ALLOWED" || after.blockedReason === "DAG_REPLAN_LIMIT_REACHED");
      if (proposal || terminalPolicyRejection) {
        this.store.consumeDagReplanRequest(manualRequest.requestId, proposal?.proposalId ?? null, now);
      }
      return changed;
    }
    const blockerResolved = this.store
      .listDagFacts(workItemId)
      .filter((fact) => fact.key === "blocker.resolved")
      .at(-1);
    const blockerResolutionProposal = this.store
      .listDagProposals(workItemId)
      .filter((proposal) => proposal.reasonCode === "blocker_resolution")
      .at(-1);
    if (
      blockerResolved &&
      triggerAllowed(workflow.definition, "blocker_resolution") &&
      (!blockerResolutionProposal || blockerResolutionProposal.createdAt < blockerResolved.createdAt)
    ) {
      if (inFlight) return false;
      return this.replan(workItemId, principalId, scope, "blocker_resolution", now);
    }
    if (revision.requirementSnapshotRevision !== work.currentRequirementRevision) {
      if (inFlight) return false;
      const requirementUpdateConsumed = this.store
        .listDagProposals(workItemId)
        .some(
          (proposal) =>
            proposal.parentRevision === revision.revision &&
            proposal.expectedRequirementRevision === work.currentRequirementRevision &&
            proposal.reasonCode === "user_update" &&
            proposal.status === "noop",
        );
      if (!requirementUpdateConsumed) {
        return this.replan(workItemId, principalId, scope, "user_update", now);
      }
    }

    const subjectBoundKinds = new Set(["verification", "review", "publication", "approval", "change_request"]);
    const dagContext = this.store.getDagContext(workItemId);
    const stalePending = revision.graph.nodes.find((node) => {
      const execution = currentExecutions.get(node.id);
      const currentSubject = subjectForResource(dagContext, node.resource);
      return (
        execution?.state === "pending" &&
        ((node.subject !== null && node.subject !== currentSubject) ||
          (subjectBoundKinds.has(node.kind) && currentSubject !== null && node.subject !== currentSubject))
      );
    });
    if (stalePending) {
      if (inFlight) return false;
      return this.replan(workItemId, principalId, scope, "new_information", now);
    }

    const failure = this.currentFailureReason(work, revision.graph.nodes, currentExecutions);
    if (failure) {
      const agentBlocker = semanticAgentBlocker(failure.execution);
      if (agentBlocker) {
        return this.block(
          workItemId,
          principalId,
          scope,
          "DAG_AGENT_BLOCKED",
          JSON.stringify({ code: agentBlocker.code, nodeId: failure.node.id, summary: agentBlocker.summary }),
          now,
          "dag_execution",
          failure.execution.nodeExecutionId,
        );
      }
      const routingCode = executorRoutingFailureCode(failure.execution);
      if (routingCode) {
        return this.block(
          workItemId,
          principalId,
          scope,
          "DAG_EXECUTOR_UNAVAILABLE",
          JSON.stringify({ code: routingCode, nodeId: failure.node.id }),
          now,
          "dag_executor",
          failure.execution.nodeExecutionId,
        );
      }

      const failureEvaluation = this.store.evaluateDagCompletion(workItemId);
      const failureBranchNodeId = failureActivatedReadyNodeId(
        revision.graph,
        failure.node.id,
        failureEvaluation.readyNodeIds,
      );
      if (failureBranchNodeId) {
        try {
          return await this.scheduler.runOne(
            workItemId,
            principalId,
            scope,
            this.ownerId,
            now,
            undefined,
            failureBranchNodeId,
          );
        } catch (error) {
          const code =
            error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "DAG_EXECUTOR_FAILED";
          return this.block(
            workItemId,
            principalId,
            scope,
            code === "DAG_EXECUTOR_NOT_FOUND" ? "DAG_EXECUTOR_UNAVAILABLE" : "DAG_EXECUTOR_FAILED",
            JSON.stringify({ code }),
            now,
            "dag_executor",
          );
        }
      }

      const failureSummary = failure.execution.result?.summary ?? "";
      const executorFailureCode = safeExecutorFailureCode(failureSummary);
      const deterministicWorkspaceCode = deterministicWorkspaceFailureCode(failureSummary);
      const executorDisposition = executorFailureDisposition(failureSummary);
      if (executorDisposition === "timeout") {
        return this.block(
          workItemId,
          principalId,
          scope,
          "DAG_EXECUTOR_TIMEOUT",
          JSON.stringify({
            code: executorFailureCode,
            nodeId: failure.node.id,
            nodeKind: failure.node.kind,
            summary: failure.execution.result?.summary ?? null,
          }),
          now,
          "dag_execution",
          failure.execution.nodeExecutionId,
        );
      }
      if (executorDisposition === "non_retryable") {
        return this.block(
          workItemId,
          principalId,
          scope,
          deterministicWorkspaceCode ?? "DAG_EXECUTOR_FAILED",
          JSON.stringify({
            code: executorFailureCode,
            nodeId: failure.node.id,
            nodeKind: failure.node.kind,
            summary: failure.execution.result?.summary ?? null,
          }),
          now,
          "dag_execution",
          failure.execution.nodeExecutionId,
        );
      }

      const executorRetry =
        failure.node.kind === "agent" || (failure.node.kind === "review" && work.status !== "rework");
      if (executorRetry) {
        if (executorDisposition === "transient") {
          const retryAfter =
            (failure.execution.finishedAt ?? failure.execution.updatedAt) +
            executorRetryDelayMs(failure.execution.generation);
          if (now < retryAfter) return false;
        }
        try {
          this.store.retryDagNode(
            workItemId,
            failure.node.id,
            executorFailureCode ? "executor_failure:" + executorFailureCode : "executor_failure",
            now,
          );
          return true;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !["DAG_RETRY_LIMIT_REACHED", "DAG_RETRY_NOT_ALLOWED"].includes(error.message)
          ) {
            throw error;
          }
          return this.block(
            workItemId,
            principalId,
            scope,
            "DAG_EXECUTOR_FAILED",
            JSON.stringify({
              code: error.message,
              nodeId: failure.node.id,
              nodeKind: failure.node.kind,
              summary: failure.execution.result?.summary ?? null,
            }),
            now,
            "dag_execution",
            failure.execution.nodeExecutionId,
          );
        }
      }
      return this.replan(workItemId, principalId, scope, failure.trigger, now);
    }
    let evaluation = this.store.evaluateDagCompletion(workItemId);
    if (evaluation.ready) {
      work = this.store.getWork(workItemId, principalId, scope);
      this.store.completeDagWork(
        workItemId,
        principalId,
        scope,
        work.stateRevision,
        work.currentDagRevision,
        work.currentRequirementRevision,
        work.currentSubjectRevision,
        now,
      );
      return true;
    }

    if (evaluation.readyNodeIds.length > 0) {
      try {
        return await this.scheduler.runOne(workItemId, principalId, scope, this.ownerId, now);
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "DAG_EXECUTOR_FAILED";
        return this.block(
          workItemId,
          principalId,
          scope,
          code === "DAG_EXECUTOR_NOT_FOUND" ? "DAG_EXECUTOR_UNAVAILABLE" : "DAG_EXECUTOR_FAILED",
          JSON.stringify({ code }),
          now,
          "dag_executor",
        );
      }
    }

    if (evaluation.runningNodeIds.length > 0 || evaluation.waitingNodeIds.length > 0) {
      return false;
    }

    const allSucceeded =
      revision.graph.nodes.length > 0 &&
      revision.graph.nodes.every((node) => currentExecutions.get(node.id)?.state === "succeeded");

    if (allSucceeded) {
      const activeAttempt = this.store.getActiveAttempt(workItemId);
      if (activeAttempt && this.canFinishAttempt(evaluation.missing)) {
        work = this.store.getWork(workItemId, principalId, scope);
        this.store.finishWorkAttempt(
          workItemId,
          activeAttempt.workAttemptId,
          principalId,
          scope,
          work.stateRevision,
          "succeeded",
          "running",
          now,
        );
        return true;
      }

      const lastNode = revision.graph.nodes.at(-1);
      if (lastNode?.kind === "agent" && !this.store.evaluateDagCompletion(workItemId).ready) {
        return this.replan(workItemId, principalId, scope, "agent_result", now);
      }
    }

    evaluation = this.store.evaluateDagCompletion(workItemId);
    if (evaluation.deadlocked) {
      return this.replan(workItemId, principalId, scope, "deadlock", now);
    }
    return false;
  }

  async reconcileUntilBoundary(
    workItemId: string,
    principalId: string,
    scope: string,
    now = Date.now(),
    maxSteps = 16,
  ): Promise<boolean> {
    const boundedSteps = Math.max(1, Math.min(64, Math.floor(maxSteps)));
    let changedAny = false;
    for (let step = 0; step < boundedSteps; step++) {
      const before = this.store.getWork(workItemId, principalId, scope);
      if (before.orchestrationEngine !== "dynamic-dag" || TERMINAL.has(before.status)) return changedAny;
      const changed = await this.reconcileWork(workItemId, principalId, scope, now + step);
      changedAny ||= changed;
      const current = this.store.getWork(workItemId, principalId, scope);
      if (!changed) return changedAny;
      if (TERMINAL.has(current.status) || current.status === "blocked" || current.status === "waiting_review") {
        return changedAny;
      }
      if (this.store.listDagExecutions(workItemId).some((execution) => execution.state === "running")) {
        return changedAny;
      }
    }
    return changedAny;
  }

  async reconcileActive(now = Date.now(), limit = 100): Promise<string[]> {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const processed: string[] = [];
    for (const workItemId of this.store.listReconciliationWorkIds(now, bounded)) {
      const work = this.store.getWorkInternal(workItemId);
      if (work.orchestrationEngine !== "dynamic-dag") continue;
      if (await this.reconcileWork(workItemId, work.principalId, work.scope, now)) {
        processed.push(workItemId);
      }
    }
    return processed;
  }
}
