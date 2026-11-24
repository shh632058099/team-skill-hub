import { createHash } from "node:crypto";
import type { ExpertDispatchService, ResolvedDispatch } from "./expert-dispatch-service.js";
import type { ExpertTaskStore, TaskRecord } from "./task-store.js";
import type { WorkAttemptRecord, WorkItemRecord, WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { VerificationPolicyStep } from "./verification-policy.js";
import { normalizeVerificationPolicy } from "./verification-policy.js";
import { resolveRuntimeProfilePolicy } from "./runtime-profile-policy.js";
import type { DagDeferredExecution, WorkDagExecutionContext, WorkDagExecutorAdapter } from "./work-dag-engine.js";
import type { DagNodeResult } from "./work-dag-runtime.js";

function workspaceAccess(
  workflow: ReturnType<WorkOrchestrationStore["getWorkflow"]>,
): "read-only" | "read-write" | undefined {
  if (
    workflow.definition.change?.mode === "code_change" ||
    workflow.definition.change?.mode === "conditional_code_change"
  )
    return "read-write";
  if (workflow.definition.change?.mode === "readonly") return "read-only";
  return undefined;
}

function preferredBackend(work: WorkItemRecord): "claude" | "codex" | undefined {
  const source = (work.sourceScope ?? "").split("/", 1)[0]!.toLowerCase();
  if (source.includes("claude")) return "claude";
  if (source.includes("codex")) return "codex";
  return undefined;
}

function asResolved(binding: Record<string, unknown>): ResolvedDispatch {
  const expertId = String(binding.expertId ?? "").trim();
  const deploymentId = String(binding.deploymentId ?? "").trim();
  const deploymentConfigVersion = Number(binding.deploymentConfigVersion);
  if (!expertId || !deploymentId || !Number.isSafeInteger(deploymentConfigVersion) || deploymentConfigVersion < 1) {
    throw new Error("INVALID_ATTEMPT_DISPATCH_BINDING");
  }
  return binding as unknown as ResolvedDispatch;
}

function taskSubject(task: TaskRecord): string {
  if (task.workspaceChangeSummary) return "workspace:" + task.workspaceChangeSummary.contentRevision;
  if (task.commitSha) return task.commitSha;
  return (
    "task-result:" +
    createHash("sha256")
      .update(task.result ?? task.taskId)
      .digest("hex")
  );
}

function verificationSteps(
  workflow: ReturnType<WorkOrchestrationStore["getWorkflow"]>,
  resolved: ResolvedDispatch,
  capability: string,
): VerificationPolicyStep[] {
  const combined = [
    ...workflow.definition.validation.required,
    ...(workflow.definition.change?.mode === "code_change" ||
    workflow.definition.change?.mode === "conditional_code_change"
      ? (resolved.deploymentSnapshot?.repository?.verificationPolicy?.required ?? [])
      : []),
  ];
  const unique = new Map<string, VerificationPolicyStep>();
  for (const step of normalizeVerificationPolicy(combined)) {
    const existing = unique.get(step.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(step)) throw new Error("VERIFICATION_POLICY_CONFLICT");
    unique.set(step.id, step);
  }
  const all = [...unique.values()];
  if (capability === "verification" || capability === "all") return all;
  const selected = all.filter((step) => step.id === capability || step.evidenceType === capability);
  if (selected.length === 0) throw new Error("VERIFICATION_CAPABILITY_NOT_CONFIGURED");
  return selected;
}

function taskKey(context: WorkDagExecutionContext): string {
  return "dag:" + context.execution.idempotencyKey;
}

function taskForCorrelation(tasks: ExpertTaskStore, context: WorkDagExecutionContext): TaskRecord | null {
  const ref = context.execution.externalRef;
  if (!ref) return null;
  if (ref.startsWith("expert-task:")) {
    const taskId = ref.slice("expert-task:".length);
    try {
      return tasks.get(taskId, context.work.principalId, context.work.scope);
    } catch {
      return null;
    }
  }
  if (ref.startsWith("expert-task-key:")) {
    return tasks.getByIdempotency(context.work.principalId, context.work.scope, ref.slice("expert-task-key:".length));
  }
  return null;
}

function taskTerminalResult(
  tasks: ExpertTaskStore,
  context: WorkDagExecutionContext,
  onSucceeded: (task: TaskRecord) => DagNodeResult,
): DagNodeResult | null {
  const task = taskForCorrelation(tasks, context);
  if (!task || task.status === "queued" || task.status === "running") return null;
  if (task.status === "cancelled") return { status: "failed", summary: "TASK_CANCELLED" };
  if (task.status === "failed") return { status: "failed", summary: task.result ?? "TASK_FAILED" };
  return onSucceeded(task);
}

function pendingAttemptContext(work: WorkItemRecord): {
  reason: "human_rework" | "review_rework" | "policy_replan";
  originWorkAttemptId?: string;
  reviewContext?: string;
  whatShouldChange?: string;
  createdBy?: string;
} | null {
  if (work.status !== "rework" || !work.nextActionContext) return null;
  try {
    const value = JSON.parse(work.nextActionContext) as Record<string, unknown>;
    const reason = value.reason;
    if (reason !== "human_rework" && reason !== "review_rework" && reason !== "policy_replan") return null;
    return {
      reason,
      ...(typeof value.originWorkAttemptId === "string" ? { originWorkAttemptId: value.originWorkAttemptId } : {}),
      ...(typeof value.reviewContext === "string" ? { reviewContext: value.reviewContext } : {}),
      ...(typeof value.whatShouldChange === "string" ? { whatShouldChange: value.whatShouldChange } : {}),
      ...(typeof value.createdBy === "string" ? { createdBy: value.createdBy } : {}),
    };
  } catch {
    return null;
  }
}

class ExpertTaskDagAdapterBase {
  constructor(
    protected readonly workStore: WorkOrchestrationStore,
    protected readonly tasks: ExpertTaskStore,
    protected readonly dispatch: ExpertDispatchService,
  ) {}

  protected resolve(work: WorkItemRecord, attempt?: WorkAttemptRecord): ResolvedDispatch {
    if (attempt?.dispatchBinding) return asResolved(attempt.dispatchBinding);
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const resolved = this.dispatch.resolve({
      principalId: work.principalId,
      scope: work.scope,
      problem: work.description,
      expertId: attempt?.expertId ?? work.requestedExpertId ?? undefined,
      selectionMode: attempt?.expertId || work.requestedExpertId ? "explicit" : "auto",
      repositoryId: work.repositoryId ?? undefined,
      deploymentId: attempt?.deploymentId ?? work.requestedDeploymentId ?? undefined,
      requiredRuntimeProfile: workflow.definition.execution.requiredRuntimeProfile,
      requiredWorkspaceAccess: workspaceAccess(workflow),
      preferredBackend: preferredBackend(work),
    });
    if (attempt && resolved.deploymentConfigVersion !== attempt.deploymentConfigVersion) {
      throw new Error("STALE_DEPLOYMENT_CONFIG");
    }
    return resolved;
  }

  protected ensureAttempt(context: WorkDagExecutionContext): {
    attempt: WorkAttemptRecord;
    resolved: ResolvedDispatch;
  } {
    let attempt = this.workStore.getActiveAttempt(context.work.workItemId);
    if (attempt) return { attempt, resolved: this.resolve(context.work, attempt) };
    const currentWork = this.workStore.getWorkInternal(context.work.workItemId);
    const resolved = this.resolve(currentWork);
    const attempts = this.workStore.listAttempts(context.work.workItemId);
    const pending = pendingAttemptContext(currentWork);
    const reason = attempts.length === 0 ? "initial" : (pending?.reason ?? "policy_replan");
    const parentWorkAttemptId = pending?.originWorkAttemptId ?? attempts.at(-1)?.workAttemptId;
    attempt = this.workStore.createWorkAttempt(
      currentWork.workItemId,
      currentWork.principalId,
      currentWork.scope,
      currentWork.stateRevision,
      {
        reason,
        expertId: resolved.expertId,
        deploymentId: resolved.deploymentId,
        deploymentConfigVersion: resolved.deploymentConfigVersion,
        ...(parentWorkAttemptId ? { parentWorkAttemptId } : {}),
        ...(pending?.reviewContext ? { reviewContext: pending.reviewContext } : {}),
        ...(pending?.whatShouldChange ? { whatShouldChange: pending.whatShouldChange } : {}),
        createdBy: pending?.createdBy ?? "dynamic-dag",
        dispatchBinding: resolved as unknown as Record<string, unknown>,
      },
    );
    const workflow = this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion);
    this.workStore.ensureWorkspace(context.work.workItemId, attempt.workAttemptId, {
      ...(resolved.deploymentSnapshot?.repository?.url
        ? { repositoryUrl: resolved.deploymentSnapshot.repository.url }
        : {}),
      ...(resolved.deploymentSnapshot?.repository?.branch
        ? { branch: resolved.deploymentSnapshot.repository.branch }
        : {}),
      cleanupPolicy: workflow.definition.execution.workspace.cleanup,
    });
    return { attempt: this.workStore.getWorkAttempt(attempt.workAttemptId), resolved };
  }

  protected submitTask(
    context: WorkDagExecutionContext,
    attempt: WorkAttemptRecord,
    resolved: ResolvedDispatch,
    executionKind: "agent" | "verification",
    validationSnapshot: VerificationPolicyStep[],
    problem: string,
  ): TaskRecord {
    const workspace = attempt.workspaceId
      ? this.workStore.getWorkspace(attempt.workspaceId)
      : this.workStore.ensureWorkspace(context.work.workItemId, attempt.workAttemptId, {});
    let task = this.dispatch.submitResolved(
      {
        principalId: context.work.principalId,
        scope: context.work.scope,
        idempotencyKey: taskKey(context),
        sourceClient: "work_dag",
        problem,
        expertId: resolved.expertId,
        selectionMode: "explicit",
        repositoryId: resolved.repositoryId,
        deploymentId: resolved.deploymentId,
        workItemId: context.work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workflowId: attempt.workflowId,
        workflowVersion: attempt.workflowVersion,
        workspaceKey: workspace.workspaceKey,
        validationSnapshot,
        executionKind,
      },
      resolved,
    );
    if (workspace.ownerWorkerId && task.status === "queued") {
      task = this.tasks.requireWorker(task.taskId, workspace.ownerWorkerId);
    }
    return task;
  }
}

class AgentDagAdapter extends ExpertTaskDagAdapterBase implements WorkDagExecutorAdapter {
  readonly kind = "agent" as const;

  private continuationReason(context: WorkDagExecutionContext): string {
    const failed = this.workStore
      .listDagExecutions(context.work.workItemId)
      .filter((execution) => execution.state === "failed" && execution.nodeId !== context.node.id)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const parts = ["dag:" + context.node.id];
    if (failed) {
      parts.push("previous_failure:" + failed.nodeId);
      const summary = failed.result?.summary?.trim();
      if (summary) parts.push("summary:" + summary);
      const failedEvidence = failed.result?.evidence?.filter((item) => !item.passed).map((item) => item.type) ?? [];
      if (failedEvidence.length > 0) parts.push("failed_evidence:" + failedEvidence.join(","));
    }
    return parts.join(" | ").slice(0, 200);
  }

  correlationRef(context: WorkDagExecutionContext): string {
    const keyed = this.tasks.getByIdempotency(context.work.principalId, context.work.scope, taskKey(context));
    if (keyed) return "expert-task:" + keyed.taskId;
    const attempt = this.workStore.getActiveAttempt(context.work.workItemId);
    if (attempt?.taskId) {
      const primary = this.tasks.get(attempt.taskId, context.work.principalId, context.work.scope);
      if (primary.status === "succeeded" || primary.status === "failed") {
        return "expert-task:" + primary.taskId;
      }
    }
    return "expert-task-key:" + taskKey(context);
  }

  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution> {
    const { attempt, resolved } = this.ensureAttempt(context);
    const attemptContext = [
      attempt.reviewContext ? "Review context: " + attempt.reviewContext : null,
      attempt.whatShouldChange ? "Required rework: " + attempt.whatShouldChange : null,
    ].filter((item): item is string => Boolean(item));
    const submitNew = () =>
      this.submitTask(
        context,
        attempt,
        resolved,
        "agent",
        [],
        [
          "You are executing one node in a durable Team Skill Hub Dynamic Runtime DAG.",
          "Do not submit or delegate another Work.",
          "Do not query, wait on, submit, cancel, update, or otherwise control this WorkItem or DAG through MCP.",
          "Team Skill Hub owns lifecycle progression. If MCP is available, use it only for authorized Skill/Knowledge lookup; do not use Work control tools.",
          "Perform the requested work in the provided workspace.",
          "WorkItem: " + context.work.workItemId,
          "DAG node: " + context.node.id,
          ...attemptContext,
          "",
          context.work.description,
        ].join("\n"),
      );
    let task = this.tasks.getByIdempotency(context.work.principalId, context.work.scope, taskKey(context));
    if (!task && attempt.taskId) {
      const primary = this.tasks.get(attempt.taskId, context.work.principalId, context.work.scope);
      if (primary.status === "succeeded" && primary.runId) {
        task = this.tasks.scheduleContinuation(
          primary.taskId,
          primary.runId,
          this.continuationReason(context),
          Date.now(),
          attempt.workspaceId
            ? (this.workStore.getWorkspace(attempt.workspaceId).ownerWorkerId ?? undefined)
            : undefined,
        );
      } else if (primary.status === "failed") {
        task = this.tasks.requeueForRetry(primary.taskId, attempt.workAttemptId, this.continuationReason(context));
      } else {
        task = submitNew();
      }
    } else if (!task) {
      task = submitNew();
      this.workStore.linkAttemptTask(attempt.workAttemptId, task.taskId);
    }
    return { kind: "deferred", externalRef: context.execution.externalRef ?? "expert-task:" + task.taskId };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    return taskTerminalResult(this.tasks, context, (task) => {
      const subject = taskSubject(task);
      const current = this.workStore.getWorkInternal(context.work.workItemId);
      if (current.currentSubjectRevision !== subject) {
        this.workStore.setCurrentSubjectRevision(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          subject,
        );
      }
      const workspaceChanged =
        task.workspaceChangeSummary === null
          ? undefined
          : task.workspaceChangeSummary.diffStat.filesChanged > 0 ||
            task.workspaceChangeSummary.changedFiles.length > 0 ||
            task.workspaceChangeSummary.addedFiles.length > 0 ||
            task.workspaceChangeSummary.deletedFiles.length > 0;
      return {
        status: "succeeded",
        summary: task.result ?? "Agent completed",
        facts: [
          { key: "agent.completed", value: true },
          ...(workspaceChanged === undefined ? [] : [{ key: "workspace.changed", value: workspaceChanged }]),
        ],
        evidence: [
          {
            type: "expert_result",
            passed: true,
            subjectRevision: subject,
            verifierIdentity: "team-skill-hub",
          },
        ],
      };
    });
  }
}

class VerificationDagAdapter extends ExpertTaskDagAdapterBase implements WorkDagExecutorAdapter {
  readonly kind = "verification" as const;

  correlationRef(context: WorkDagExecutionContext): string {
    return "expert-task-key:" + taskKey(context);
  }

  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution> {
    const { attempt, resolved } = this.ensureAttempt(context);
    const workflow = this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion);
    const validationSnapshot = verificationSteps(workflow, resolved, context.node.capability);
    this.submitTask(
      context,
      attempt,
      resolved,
      "verification",
      validationSnapshot,
      "Run the pinned verification policy for DAG node " + context.node.id + ". Do not modify source files.",
    );
    return { kind: "deferred", externalRef: context.execution.externalRef ?? "expert-task-key:" + taskKey(context) };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    return taskTerminalResult(this.tasks, context, (task) => {
      const evidence = task.verificationResults.map((result) => ({
        type: result.evidenceType,
        passed: result.status === "passed",
        subjectRevision: result.subjectRevision,
        verifierIdentity: result.verifierIdentity,
      }));
      const failed = task.validationSnapshot.some((step) => {
        const result = task.verificationResults.find((candidate) => candidate.stepId === step.id);
        return !result || result.status !== "passed";
      });
      const subject = task.verificationResults.find((result) => Boolean(result.subjectRevision))?.subjectRevision;
      if (subject) {
        const current = this.workStore.getWorkInternal(context.work.workItemId);
        if (current.currentSubjectRevision !== subject) {
          this.workStore.setCurrentSubjectRevision(
            current.workItemId,
            current.principalId,
            current.scope,
            current.stateRevision,
            subject,
          );
        }
      }
      return {
        status: failed ? "failed" : "succeeded",
        summary: failed ? "VERIFICATION_FAILED" : "Verification passed",
        evidence,
        facts: [{ key: "verification.completed", value: true }],
      };
    });
  }
}

function parseDagAgentReviewResult(result: string | null): { decision: "accepted" | "rework"; reason?: string } {
  if (!result) throw new Error("AGENT_REVIEW_RESULT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error("AGENT_REVIEW_RESULT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENT_REVIEW_RESULT_INVALID");
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.some((key) => key !== "decision" && key !== "reason")) {
    throw new Error("AGENT_REVIEW_RESULT_INVALID");
  }
  const decision = (parsed as { decision?: unknown }).decision;
  const reason =
    typeof (parsed as { reason?: unknown }).reason === "string" ? (parsed as { reason: string }).reason.trim() : "";
  if (decision !== "accepted" && decision !== "rework") {
    throw new Error("AGENT_REVIEW_RESULT_INVALID");
  }
  if (decision === "rework" && !reason) throw new Error("AGENT_REVIEW_RESULT_INVALID");
  if (reason.length > 4_000) throw new Error("AGENT_REVIEW_RESULT_INVALID");
  return { decision, ...(reason ? { reason } : {}) };
}

class ReviewDagAdapter extends ExpertTaskDagAdapterBase implements WorkDagExecutorAdapter {
  readonly kind = "review" as const;

  private workflowDefinition(context: WorkDagExecutionContext) {
    return this.workStore.getWorkflow(context.work.workflowId, context.work.workflowVersion).definition;
  }

  private configuredReviewerExpertId(context: WorkDagExecutionContext): string | null {
    return this.workflowDefinition(context).review.reviewerExpertId ?? null;
  }

  private usesAgentReview(context: WorkDagExecutionContext): boolean {
    const workflow = this.workflowDefinition(context);
    return Boolean(workflow.review.reviewerExpertId) || workflow.change?.mode === "conditional_code_change";
  }
  correlationRef(context: WorkDagExecutionContext): string {
    if (this.usesAgentReview(context)) {
      const attempt = this.workStore.getActiveAttempt(context.work.workItemId);
      if (attempt?.reviewTaskId) return "expert-task:" + attempt.reviewTaskId;
      return "expert-task-key:" + taskKey(context);
    }
    return "human-review:" + context.work.workItemId + ":" + (context.work.currentSubjectRevision ?? "missing");
  }
  private dispatchAgentReview(context: WorkDagExecutionContext, reviewerExpertId?: string): TaskRecord {
    const current = this.workStore.getWorkInternal(context.work.workItemId);
    const ensured = this.workStore.getActiveAttempt(current.workItemId) ?? this.ensureAttempt(context).attempt;
    const attempt = this.workStore.getWorkAttempt(ensured.workAttemptId);
    const effectiveReviewerExpertId = reviewerExpertId ?? attempt.expertId;
    if (!attempt.workspaceId) throw new Error("WORKSPACE_NOT_FOUND");
    const workspace = this.workStore.getWorkspace(attempt.workspaceId);
    if (attempt.reviewTaskId) {
      let existing = this.tasks.get(attempt.reviewTaskId, current.principalId, current.scope);
      if (existing.expertId !== effectiveReviewerExpertId) {
        throw new Error("WORK_ATTEMPT_REVIEW_TASK_CONFLICT");
      }
      if (existing.status === "failed") {
        existing = this.tasks.requeueForRetry(existing.taskId, attempt.workAttemptId, "dag:" + context.node.id);
      } else if (existing.status === "succeeded" && existing.runId && context.execution.generation > 1) {
        existing = this.tasks.scheduleContinuation(
          existing.taskId,
          existing.runId,
          "dag:" + context.node.id,
          Date.now(),
          workspace.ownerWorkerId ?? undefined,
        );
      }
      return existing;
    }
    if (["removed", "failed", "cleaning"].includes(workspace.state)) {
      throw new Error("WORKSPACE_OWNER_UNAVAILABLE");
    }
    const resolved = this.dispatch.resolve({
      principalId: current.principalId,
      scope: current.scope,
      problem: current.description,
      expertId: effectiveReviewerExpertId,
      selectionMode: "explicit",
      repositoryId: current.repositoryId ?? undefined,
      requiredWorkspaceAccess: "read-only",
      preferredBackend: preferredBackend(current),
    });
    if (
      !resolved.runtimeProfile ||
      resolveRuntimeProfilePolicy(resolved.runtimeProfile).workspaceAccess !== "read-only"
    ) {
      throw new Error("RUNTIME_PROFILE_MISMATCH");
    }

    const initialReview = attempt.taskId === null;
    let task = this.dispatch.submitResolved(
      {
        principalId: current.principalId,
        scope: current.scope,
        idempotencyKey: taskKey(context),
        sourceClient: "work_dag_review",
        problem:
          (initialReview
            ? "Perform an independent review of the repository/workspace baseline for this work item. "
            : "Perform an independent code review of the current workspace changes for this work item. ") +
          "Do not modify files. Review correctness, regressions, tests, maintainability, and requirement coverage. " +
          "Do not query, wait on, submit, cancel, update, or otherwise control this WorkItem or DAG through MCP. " +
          "Team Skill Hub owns lifecycle progression. If MCP is available, use it only for authorized Skill/Knowledge lookup. " +
          'Return ONLY JSON: {"decision":"accepted"|"rework","reason":"..."}. ' +
          "Use rework when any blocking issue remains.\n\nOriginal work:\n" +
          current.description,
        expertId: resolved.expertId,
        selectionMode: "explicit",
        repositoryId: resolved.repositoryId,
        deploymentId: resolved.deploymentId,
        workItemId: current.workItemId,
        workAttemptId: attempt.workAttemptId,
        workflowId: attempt.workflowId,
        workflowVersion: attempt.workflowVersion,
        workspaceKey: workspace.workspaceKey,
        validationSnapshot: [],
        executionKind: "agent",
      },
      resolved,
    );
    if (task.status === "queued" && workspace.ownerWorkerId) {
      task = this.tasks.requireWorker(task.taskId, workspace.ownerWorkerId);
    }
    this.workStore.linkAttemptReviewTask(attempt.workAttemptId, task.taskId);
    return task;
  }

  private applyDecision(
    context: WorkDagExecutionContext,
    decision: {
      decision: "accepted" | "rework" | "rejected";
      reason: string | null;
      actorPrincipalId: string;
      initialReview?: boolean;
    },
  ): DagNodeResult {
    let current = this.workStore.getWorkInternal(context.work.workItemId);
    const subject = current.currentSubjectRevision;
    if (!subject) throw new Error("WORK_SUBJECT_REQUIRED");

    if (decision.decision === "accepted") {
      if (current.status === "waiting_review") {
        current = this.workStore.transitionWork(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          "running",
        );
      }
      return {
        status: "succeeded",
        summary: decision.reason ?? "Review accepted",
        facts: [
          { key: "review.accepted", value: true },
          ...(decision.initialReview ? [{ key: "workspace.changed", value: false }] : []),
        ],
      };
    }

    if (decision.decision === "rework") {
      if (current.status === "waiting_review") {
        const origin = this.workStore.listAttempts(current.workItemId).at(-1);
        if (!origin) throw new Error("WORK_ATTEMPT_NOT_FOUND");
        this.workStore.requestRework(current.workItemId, current.principalId, current.scope, current.stateRevision, {
          reason: "review_rework",
          originWorkAttemptId: origin.workAttemptId,
          reviewContext: JSON.stringify({
            decision: decision.decision,
            subjectRevision: subject,
            reason: decision.reason,
          }),
          whatShouldChange: decision.reason ?? undefined,
          createdBy: decision.actorPrincipalId,
        });
      }
      return {
        status: "failed",
        summary: decision.reason ?? "REVIEW_REWORK",
        facts: [{ key: "review.rework", value: true }],
      };
    }

    if (current.status !== "failed" && current.status !== "cancelled" && current.status !== "completed") {
      this.workStore.transitionWork(
        current.workItemId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "failed",
      );
    }
    return {
      status: "failed",
      summary: decision.reason ?? "REVIEW_REJECTED",
      facts: [{ key: "review.rejected", value: true }],
    };
  }

  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution> {
    const current = this.workStore.getWorkInternal(context.work.workItemId);
    if (this.usesAgentReview(context)) {
      const task = this.dispatchAgentReview(context, this.configuredReviewerExpertId(context) ?? undefined);
      return {
        kind: "deferred",
        externalRef: context.execution.externalRef ?? "expert-task-key:" + taskKey(context),
      };
    }
    if (!current.currentSubjectRevision) throw new Error("WORK_SUBJECT_REQUIRED");
    const attempt = this.workStore.getActiveAttempt(context.work.workItemId);
    if (attempt) {
      this.workStore.finishWorkAttempt(
        current.workItemId,
        attempt.workAttemptId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "succeeded",
        "waiting_review",
      );
    } else if (current.status !== "waiting_review") {
      this.workStore.transitionWork(
        current.workItemId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "waiting_review",
      );
    }
    return {
      kind: "deferred",
      externalRef:
        context.execution.externalRef ??
        "human-review:" + context.work.workItemId + ":" + current.currentSubjectRevision,
    };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    if (this.usesAgentReview(context)) {
      const task = taskForCorrelation(this.tasks, context);
      if (!task || task.status === "queued" || task.status === "running") return null;
      if (task.status === "failed" || task.status === "cancelled") {
        return {
          status: "failed",
          summary: task.result ?? "AGENT_REVIEW_FAILED",
          facts: [{ key: "review.agent_failed", value: true }],
        };
      }

      let parsed: { decision: "accepted" | "rework"; reason?: string };
      try {
        parsed = parseDagAgentReviewResult(task.result);
      } catch {
        return {
          status: "failed",
          summary: "AGENT_REVIEW_RESULT_INVALID",
          facts: [{ key: "review.agent_invalid", value: true }],
        };
      }

      let current = this.workStore.getWorkInternal(context.work.workItemId);
      const activeBeforeDecision = this.workStore.getActiveAttempt(current.workItemId);
      const initialReview = activeBeforeDecision?.taskId === null;
      const subject = taskSubject(task);
      if (current.currentSubjectRevision !== subject) {
        current = this.workStore.setCurrentSubjectRevision(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          subject,
        );
      }
      const actor = "agent:" + task.expertId;
      let stored = this.workStore
        .listReviewDecisions(current.workItemId)
        .filter(
          (item) =>
            item.subjectRevision === subject &&
            item.actorPrincipalId === actor &&
            item.decision === parsed.decision &&
            (item.reason ?? null) === (parsed.reason ?? null),
        )
        .at(-1);

      if (!stored) {
        const activeAttempt = this.workStore.getActiveAttempt(current.workItemId);
        if (activeAttempt) {
          this.workStore.finishWorkAttempt(
            current.workItemId,
            activeAttempt.workAttemptId,
            current.principalId,
            current.scope,
            current.stateRevision,
            "succeeded",
            "waiting_review",
          );
          current = this.workStore.getWorkInternal(current.workItemId);
        } else if (current.status !== "waiting_review" && current.status !== "rework") {
          current = this.workStore.transitionWork(
            current.workItemId,
            current.principalId,
            current.scope,
            current.stateRevision,
            "waiting_review",
          );
        }

        stored = this.workStore.submitReviewDecision(current.workItemId, current.principalId, current.scope, {
          expectedRevision: current.stateRevision,
          subjectRevision: subject,
          decision: parsed.decision,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          actorPrincipalId: actor,
        });
      }

      return this.applyDecision(context, {
        decision: stored.decision,
        reason: stored.reason,
        actorPrincipalId: stored.actorPrincipalId,
        initialReview,
      });
    }

    const current = this.workStore.getWorkInternal(context.work.workItemId);
    const subject = current.currentSubjectRevision;
    if (!subject) return null;
    const decision = this.workStore
      .listReviewDecisions(current.workItemId)
      .filter((item) => item.subjectRevision === subject)
      .at(-1);
    if (!decision) return null;
    return this.applyDecision(context, {
      decision: decision.decision,
      reason: decision.reason,
      actorPrincipalId: decision.actorPrincipalId,
    });
  }
}
export function createExpertTaskDagAdapters(
  workStore: WorkOrchestrationStore,
  tasks: ExpertTaskStore,
  dispatch: ExpertDispatchService,
): WorkDagExecutorAdapter[] {
  return [
    new AgentDagAdapter(workStore, tasks, dispatch),
    new VerificationDagAdapter(workStore, tasks, dispatch),
    new ReviewDagAdapter(workStore, tasks, dispatch),
  ];
}
