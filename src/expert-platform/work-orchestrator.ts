import { createHash, randomUUID } from "node:crypto";
import type { ExpertDispatchService, ResolvedDispatch } from "./expert-dispatch-service.js";
import type { ExpertTaskFeedbackInput, ExpertTaskStore, TaskRecord, TaskRunTurnRecord } from "./task-store.js";
import {
  type CompletionGateResult,
  type ReviewDecision,
  type ReviewDecisionRecord,
  type WorkApprovalRecord,
  type WorkAttemptReason,
  type WorkAttemptRecord,
  type WorkEvidenceRecord,
  type WorkItemRecord,
  type WorkSubmission,
  type WorkspaceRecord,
  WorkOrchestrationStore,
} from "./work-orchestration-store.js";
import { WorkPublicationStore, type WorkPublicationRecord } from "./work-publication-store.js";
import { buildPublicationCommitMetadata, buildWorkBranchName } from "./publication-policy.js";

export interface SubmitWorkInput extends WorkSubmission {
  sourceSessionId?: string;
  sourceClient?: string;
  sourceRequestId?: string;
}

export interface WorkDetail {
  work: WorkItemRecord;
  attempts: WorkAttemptRecord[];
  evidence: WorkEvidenceRecord[];
  currentTask: TaskRecord | null;
  turns: TaskRunTurnRecord[];
  workspace: WorkspaceRecord | null;
  verification: {
    requiredEvidence: string[];
    requiredSteps: TaskRecord["validationSnapshot"];
    results: TaskRecord["verificationResults"];
    passed: number;
    failed: number;
  };
  gate: CompletionGateResult;
  runtime: {
    requiredProfile: string | null;
    effectiveProfile: string | null;
  };
  workspaceChangeSummary: TaskRecord["workspaceChangeSummary"];
  reviews: ReviewDecisionRecord[];
  approvals: WorkApprovalRecord[];
  publication: {
    publicationId: string;
    state: WorkPublicationRecord["state"];
    sourceSubjectRevision: string;
    repositoryId: string;
    publicationPolicyRevision: number;
    branchName: string;
    commitSha: string | null;
    treeSha: string | null;
    artifactRef: string | null;
    approvalState: "pending" | "approved" | "rejected";
    retryCount: number;
    nextAttemptAt: number | null;
    lastErrorCode: string | null;
    lastErrorContext: string | null;
    preparedAt: number | null;
    approvedAt: number | null;
    pushedAt: number | null;
  } | null;
}

export interface WorkReviewInput {
  expectedRevision: number;
  subjectRevision: string;
  decision: ReviewDecision;
  reason?: string;
}

export interface WorkApprovalInput {
  expectedRevision: number;
  subjectRevision: string;
  approvalScope: "work_completion" | "publish_work_branch";
  decision: "approved" | "rejected";
}

export interface WorkApprovalActor {
  actor: string;
  role: "admin" | "developer";
}

const TERMINAL_WORK = new Set(["completed", "failed", "cancelled"]);

function isBlocker(reason: string): string | null {
  const normalized = reason.trim().toUpperCase();
  if (normalized.includes("MISSING_PERMISSION") || normalized.includes("PERMISSION_DENIED"))
    return "missing_permission";
  if (normalized.includes("MISSING_SECRET") || normalized.includes("SECRET_REQUIRED")) return "missing_secret";
  if (normalized.includes("MISSING_TOOL") || normalized.includes("TOOL_REQUIRED")) return "missing_tool";
  if (normalized.includes("APPROVAL_REQUIRED")) return "approval_required";
  if (
    normalized.includes("REPOSITORY_FORBIDDEN") ||
    normalized.includes("REPOSITORY_ACCESS") ||
    normalized.includes("REPOSITORY_UNAVAILABLE")
  ) {
    return "repository_access";
  }
  if (normalized.includes("OPERATOR_INPUT")) return "operator_input";
  if (normalized.includes("SOURCE_REPOSITORY_UNAVAILABLE")) return "repository_access";
  if (normalized.includes("DEPLOYMENT_REQUIRED") || normalized.includes("REPOSITORY_REQUIRED")) return "operator_input";
  if (normalized.includes("EXPERT_NOT_FOUND") || normalized.includes("EXPERT_UNAVAILABLE"))
    return "resource_unavailable";
  if (
    normalized.includes("DEPLOYMENT_FORBIDDEN") ||
    normalized.includes("RUNTIME_PROFILE_MISMATCH") ||
    normalized.includes("RUNTIME_PROFILE_UNAVAILABLE") ||
    normalized.includes("RUNTIME_PROFILE_UNSUPPORTED") ||
    normalized.includes("RUNTIME_PROFILE_REQUIRED") ||
    normalized.includes("WORKSPACE_WRITE_NOT_ALLOWED") ||
    normalized.includes("EXPERT_FORBIDDEN") ||
    normalized.includes("MCP_PROFILE_TOOL_NOT_ALLOWED") ||
    normalized.includes("STALE_DEPLOYMENT_CONFIG") ||
    normalized.includes("INVALID_PINNED_DISPATCH_BINDING")
  ) {
    return "policy_blocked";
  }
  return null;
}

function blockerMetadata(
  blocker: string,
  work: WorkItemRecord,
): {
  resumeCondition: string;
  blockedByType: string;
  blockedByRef?: string;
} {
  const blockedByType =
    blocker === "missing_permission"
      ? "permission"
      : blocker === "missing_secret"
        ? "secret"
        : blocker === "missing_tool"
          ? "tool"
          : blocker === "approval_required"
            ? "approval"
            : blocker === "repository_access"
              ? "repository"
              : blocker === "operator_input"
                ? "operator"
                : blocker === "resource_unavailable"
                  ? "resource"
                  : blocker === "policy_blocked"
                    ? "policy"
                    : "condition";
  const blockedByRef =
    blockedByType === "repository"
      ? (work.repositoryId ?? undefined)
      : blockedByType === "policy" || blockedByType === "resource"
        ? (work.requestedDeploymentId ?? work.requestedExpertId ?? undefined)
        : undefined;
  return { resumeCondition: "manual", blockedByType, ...(blockedByRef ? { blockedByRef } : {}) };
}

function isRetryable(reason: string): boolean {
  const normalized = reason.trim().toUpperCase();
  return ["TEMPORARY", "NETWORK", "TIMEOUT", "UNAVAILABLE", "EXECUTION_FAILED", "WORKER_LOST", "LEASE_EXPIRED"].some(
    (token) => normalized.includes(token),
  );
}

function resultSubject(task: TaskRecord): string {
  if (task.workspaceChangeSummary) {
    return `workspace:${task.workspaceChangeSummary.contentRevision}`;
  }
  if (task.commitSha) return task.commitSha;
  return (
    "task-result:" +
    createHash("sha256")
      .update(task.result ?? task.taskId)
      .digest("hex")
  );
}

function asResolvedDispatch(binding: Record<string, unknown>): ResolvedDispatch {
  const expertId = typeof binding.expertId === "string" ? binding.expertId : "";
  const deploymentId = typeof binding.deploymentId === "string" ? binding.deploymentId : "";
  const selectionMode = binding.selectionMode === "auto" ? "auto" : "explicit";
  const deploymentConfigVersion = Number(binding.deploymentConfigVersion);
  const runtimeProfile = typeof binding.runtimeProfile === "string" ? binding.runtimeProfile : undefined;
  if (!expertId || !deploymentId || !Number.isSafeInteger(deploymentConfigVersion) || deploymentConfigVersion < 1) {
    throw new Error("INVALID_PINNED_DISPATCH_BINDING");
  }
  return {
    expertId,
    selectionMode,
    ...(typeof binding.repositoryId === "string" && binding.repositoryId ? { repositoryId: binding.repositoryId } : {}),
    deploymentId,
    deploymentConfigVersion,
    ...(runtimeProfile ? { runtimeProfile } : {}),
    ...(binding.deploymentSnapshot && typeof binding.deploymentSnapshot === "object"
      ? { deploymentSnapshot: binding.deploymentSnapshot as ResolvedDispatch["deploymentSnapshot"] }
      : {}),
  };
}

export class WorkOrchestrator {
  private readonly orchestrationOwnerId = randomUUID();
  private readonly orchestrationLeaseMs = 30_000;
  constructor(
    private readonly workStore: WorkOrchestrationStore,
    private readonly tasks: ExpertTaskStore,
    private readonly dispatch: ExpertDispatchService,
    private readonly workerAvailable: (workerId: string, now: number) => boolean = () => true,
    private readonly publications?: WorkPublicationStore,
  ) {}

  submitWork(input: SubmitWorkInput, now = Date.now()): WorkDetail {
    const work = this.workStore.createOrReuseWork(input, now);
    return this.reconcileWork(work.workItemId, input.principalId, input.scope, now);
  }

  getWork(workItemId: string, principalId: string, scope: string): WorkDetail {
    return this.detail(workItemId, principalId, scope);
  }

  requestContinuation(
    workItemId: string,
    principalId: string,
    scope: string,
    reason: string,
    now = Date.now(),
  ): WorkDetail {
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 500) throw new Error("INVALID_CONTINUATION_REASON");
    const work = this.workStore.getWork(workItemId, principalId, scope);
    if (TERMINAL_WORK.has(work.status)) throw new Error("WORK_ALREADY_TERMINAL");
    const attempt = this.workStore.getActiveAttempt(workItemId);
    if (!attempt?.taskId) throw new Error("ACTIVE_WORK_ATTEMPT_REQUIRED");
    const task = this.tasks.get(attempt.taskId, principalId, scope);
    if (task.status !== "succeeded" || !task.runId) throw new Error("TASK_CONTINUATION_NOT_ALLOWED");
    if (!attempt.workspaceId) {
      this.workStore.blockWork(
        work.workItemId,
        work.principalId,
        work.scope,
        work.stateRevision,
        "workspace_unavailable",
        "WORKSPACE_NOT_ALLOCATED",
        now,
        { resumeCondition: "manual", blockedByType: "workspace", blockedByRef: attempt.workAttemptId },
      );
      return this.detail(workItemId, principalId, scope);
    }
    const workspace = this.workStore.getWorkspace(attempt.workspaceId);
    if (!workspace.ownerWorkerId || !workspace.path || ["removed", "failed"].includes(workspace.state)) {
      this.workStore.blockWork(
        work.workItemId,
        work.principalId,
        work.scope,
        work.stateRevision,
        "workspace_unavailable",
        "WORKSPACE_OWNER_UNAVAILABLE",
        now,
        {
          resumeCondition: "manual",
          blockedByType: "workspace",
          blockedByRef: workspace.ownerWorkerId ?? workspace.workspaceId,
        },
      );
      return this.detail(workItemId, principalId, scope);
    }
    if (!this.workerAvailable(workspace.ownerWorkerId, now)) {
      this.workStore.blockWork(
        work.workItemId,
        work.principalId,
        work.scope,
        work.stateRevision,
        "workspace_unavailable",
        "WORKSPACE_OWNER_OFFLINE",
        now,
        { resumeCondition: "manual", blockedByType: "workspace", blockedByRef: workspace.ownerWorkerId },
      );
      return this.detail(workItemId, principalId, scope);
    }
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const consumedTurns = Math.max(
      task.continuationCount + 1,
      this.tasks.listRunTurns(task.taskId, principalId, scope).length,
    );
    if (consumedTurns >= workflow.definition.lifecycle.continuation.maxTurnsPerRun) {
      throw new Error("WORK_CONTINUATION_LIMIT_REACHED");
    }
    if (work.nextActionType !== null) {
      if (work.nextActionType === "continuation" && work.nextActionContext === normalizedReason)
        return this.detail(workItemId, principalId, scope);
      throw new Error("WORK_NEXT_ACTION_PENDING");
    }
    this.workStore.scheduleNextAction(workItemId, work.stateRevision, "continuation", now, now, normalizedReason);
    return this.detail(workItemId, principalId, scope);
  }

  resumeWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    now = Date.now(),
  ): WorkDetail {
    const current = this.workStore.getWork(workItemId, principalId, scope);
    if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
    if (current.status !== "blocked") throw new Error("WORK_NOT_BLOCKED");
    const claim = this.workStore.claimWorkForOrchestration(
      workItemId,
      this.orchestrationOwnerId,
      now,
      this.orchestrationLeaseMs,
    );
    try {
      this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, claim.epoch, now);
      const attempt = this.workStore.getActiveAttempt(workItemId);
      let continuationRequired = false;
      if (current.blockedByType === "workspace") {
        if (!attempt?.workspaceId) throw new Error("WORKSPACE_NOT_ALLOCATED");
        const workspace = this.workStore.getWorkspace(attempt.workspaceId);
        if (!workspace.ownerWorkerId || !workspace.path || ["removed", "failed"].includes(workspace.state)) {
          throw new Error("WORKSPACE_OWNER_UNAVAILABLE");
        }
        if (!this.workerAvailable(workspace.ownerWorkerId, now)) throw new Error("WORKSPACE_OWNER_OFFLINE");
        if (attempt.taskId) {
          const task = this.tasks.get(attempt.taskId, principalId, scope);
          continuationRequired = task.status === "succeeded";
        }
      }
      let resumed = this.workStore.resumeBlockedWork(
        workItemId,
        principalId,
        scope,
        expectedRevision,
        attempt ? "running" : "queued",
        now,
      );
      if (continuationRequired) {
        this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, claim.epoch, now);
        resumed = this.workStore.scheduleNextAction(
          workItemId,
          resumed.stateRevision,
          "continuation",
          now,
          now,
          "resumed_after_block",
        );
        return this.detail(workItemId, principalId, scope);
      }
      return this.reconcileWorkClaimed(workItemId, principalId, scope, now, claim.epoch);
    } finally {
      this.workStore.releaseWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, claim.epoch, now);
    }
  }

  getEvents(workItemId: string, principalId: string, scope: string, afterEventId = 0, limit = 100) {
    this.workStore.getWork(workItemId, principalId, scope);
    return this.workStore.listEvents(workItemId, afterEventId, limit);
  }

  reconcileWork(workItemId: string, principalId: string, scope: string, now = Date.now()): WorkDetail {
    const current = this.workStore.getWork(workItemId, principalId, scope);
    if (TERMINAL_WORK.has(current.status)) return this.detail(workItemId, principalId, scope);
    const claim = this.workStore.claimWorkForOrchestration(
      workItemId,
      this.orchestrationOwnerId,
      now,
      this.orchestrationLeaseMs,
    );
    try {
      return this.reconcileWorkClaimed(workItemId, principalId, scope, now, claim.epoch);
    } finally {
      this.workStore.releaseWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, claim.epoch, now);
    }
  }

  private reconcileWorkClaimed(
    workItemId: string,
    principalId: string,
    scope: string,
    now: number,
    orchestrationEpoch: number,
  ): WorkDetail {
    this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
    let work = this.workStore.getWork(workItemId, principalId, scope);
    if (TERMINAL_WORK.has(work.status)) return this.detail(workItemId, principalId, scope);
    this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
    work = this.reconcilePublicationLifecycle(work, now);
    if (TERMINAL_WORK.has(work.status) || work.status === "blocked") {
      return this.detail(workItemId, principalId, scope);
    }

    let attempt = this.workStore.getActiveAttempt(workItemId);
    if (!attempt) {
      if (work.status === "queued") {
        try {
          this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
          attempt = this.startAttempt(work, "initial", null, now);
          work = this.workStore.getWork(workItemId, principalId, scope);
        } catch (error) {
          const blocked = this.handleDispatchFailure(workItemId, principalId, scope, error, now);
          if (blocked) return blocked;
          throw error;
        }
      } else {
        return this.detail(workItemId, principalId, scope);
      }
    }

    if (!attempt.taskId) {
      try {
        this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
        attempt = this.dispatchAttempt(work, attempt);
      } catch (error) {
        const blocked = this.handleDispatchFailure(workItemId, principalId, scope, error, now);
        if (blocked) return blocked;
        throw error;
      }
    }

    let task = this.tasks.get(attempt.taskId!, principalId, scope);
    if (work.nextActionType === "continuation" && work.nextActionAt !== null && work.nextActionAt <= now) {
      const continuationReason = work.nextActionContext ?? "continuation";
      if (task.status === "succeeded") {
        if (!task.runId) throw new Error("TASK_RUN_REQUIRED");
        if (!attempt.workspaceId) throw new Error("WORKSPACE_NOT_FOUND");
        const workspace = this.workStore.getWorkspace(attempt.workspaceId);
        if (!workspace.ownerWorkerId || !workspace.path || ["removed", "failed"].includes(workspace.state)) {
          this.workStore.blockWork(
            work.workItemId,
            work.principalId,
            work.scope,
            work.stateRevision,
            "workspace_unavailable",
            "WORKSPACE_OWNER_UNAVAILABLE",
            now,
          );
          return this.detail(workItemId, principalId, scope);
        }
        if (!this.workerAvailable(workspace.ownerWorkerId, now)) {
          this.workStore.blockWork(
            work.workItemId,
            work.principalId,
            work.scope,
            work.stateRevision,
            "workspace_unavailable",
            "WORKSPACE_OWNER_OFFLINE",
            now,
          );
          return this.detail(workItemId, principalId, scope);
        }
        this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
        this.tasks.scheduleContinuation(task.taskId, task.runId, continuationReason, now, workspace.ownerWorkerId);
      } else if (
        (task.status !== "queued" && task.status !== "running") ||
        task.continuationReason !== continuationReason
      ) {
        throw new Error("TASK_CONTINUATION_STATE_MISMATCH");
      }
      work = this.workStore.getWork(workItemId, principalId, scope);
      this.workStore.scheduleNextAction(workItemId, work.stateRevision, null, null, now);
      work = this.workStore.getWork(workItemId, principalId, scope);
    }
    task = this.tasks.get(attempt.taskId!, principalId, scope);
    if (task.status === "queued" || task.status === "running") {
      return this.detail(workItemId, principalId, scope);
    }

    if (task.status === "succeeded") {
      this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
      return this.reconcileSucceeded(work, attempt, task, now);
    }

    if (task.status === "failed") {
      this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
      return this.reconcileFailed(work, attempt, task, now);
    }

    if (task.status === "cancelled") {
      work = this.workStore.getWork(workItemId, principalId, scope);
      if (work.activeWorkAttemptId === attempt.workAttemptId) {
        this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
        this.workStore.finishWorkAttempt(
          workItemId,
          attempt.workAttemptId,
          principalId,
          scope,
          work.stateRevision,
          "cancelled",
          "cancelled",
          now,
        );
      }
      this.workStore.requestTerminalWorkspaceCleanup(workItemId, now);
    }
    return this.detail(workItemId, principalId, scope);
  }

  reconcileDue(now = Date.now(), limit = 100): string[] {
    const processed: string[] = [];
    for (const workItemId of this.workStore.listDueWorkIds(now, limit)) {
      const work = this.workStore.getWorkInternal(workItemId);
      this.reconcileWork(workItemId, work.principalId, work.scope, now);
      processed.push(workItemId);
    }
    return processed;
  }

  reconcileActive(now = Date.now(), limit = 100): string[] {
    const processed: string[] = [];
    for (const workItemId of this.workStore.listReconciliationWorkIds(now, limit)) {
      const work = this.workStore.getWorkInternal(workItemId);
      this.reconcileWork(workItemId, work.principalId, work.scope, now);
      processed.push(workItemId);
    }
    return processed;
  }

  reconcileStartup(now = Date.now(), limit = 100): string[] {
    return this.reconcileActive(now, limit);
  }

  handleTaskFeedback(
    taskId: string,
    principalId: string,
    scope: string,
    feedback: ExpertTaskFeedbackInput,
    now = Date.now(),
  ): WorkDetail | null {
    const originAttempt = this.workStore.getAttemptByTask(taskId);
    if (!originAttempt) return null;
    let work = this.workStore.getWork(originAttempt.workItemId, principalId, scope);
    if (!feedback.needsRework || TERMINAL_WORK.has(work.status)) {
      return this.detail(work.workItemId, principalId, scope);
    }

    const attempts = this.workStore.listAttempts(work.workItemId);
    const latest = attempts.at(-1);
    if (!latest || latest.sequence > originAttempt.sequence) {
      return this.detail(work.workItemId, principalId, scope);
    }
    if (work.status !== "waiting_review") {
      return this.detail(work.workItemId, principalId, scope);
    }

    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const reworkCount = attempts.filter(
      (item) => item.reason === "human_rework" || item.reason === "review_rework",
    ).length;
    if (reworkCount >= workflow.definition.lifecycle.attempt.maxReworks) {
      this.workStore.transitionWork(work.workItemId, principalId, scope, work.stateRevision, "failed", now);
      return this.detail(work.workItemId, principalId, scope);
    }

    work = this.workStore.transitionWork(work.workItemId, principalId, scope, work.stateRevision, "rework", now);
    this.startAttempt(work, "human_rework", originAttempt.workAttemptId, now);
    return this.detail(work.workItemId, principalId, scope);
  }

  submitReview(
    workItemId: string,
    principalId: string,
    scope: string,
    input: WorkReviewInput,
    now = Date.now(),
  ): WorkDetail {
    this.workStore.submitReviewDecision(workItemId, principalId, scope, input, now);
    let work = this.workStore.getWork(workItemId, principalId, scope);

    if (input.decision === "accepted") {
      const gate = this.workStore.evaluateCompletionGate(workItemId, principalId, scope);
      if (gate.ready && !TERMINAL_WORK.has(work.status)) {
        work = this.workStore.transitionWork(workItemId, principalId, scope, work.stateRevision, "completed", now);
      }
      const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
      if (workflow.definition.publication?.required && !TERMINAL_WORK.has(work.status)) {
        return this.reconcileWork(workItemId, principalId, scope, now);
      }
    } else if (input.decision === "rework" && work.status === "waiting_review") {
      const attempts = this.workStore.listAttempts(workItemId);
      const latest = attempts.at(-1);
      work = this.workStore.transitionWork(workItemId, principalId, scope, work.stateRevision, "rework", now);
      this.startAttempt(work, "review_rework", latest?.workAttemptId ?? null, now);
    } else if (input.decision === "rejected" && !TERMINAL_WORK.has(work.status)) {
      this.workStore.transitionWork(workItemId, principalId, scope, work.stateRevision, "failed", now);
    }

    const terminalReviewWork = this.workStore.getWork(workItemId, principalId, scope);
    if (TERMINAL_WORK.has(terminalReviewWork.status)) {
      this.workStore.requestTerminalWorkspaceCleanup(workItemId, now);
    }
    return this.detail(workItemId, principalId, scope);
  }

  submitApproval(
    workItemId: string,
    principalId: string,
    scope: string,
    input: WorkApprovalInput,
    actor: WorkApprovalActor,
    now = Date.now(),
  ): WorkDetail {
    if (actor.actor !== principalId || (actor.role !== "admin" && actor.role !== "developer")) {
      throw new Error("INVALID_WORK_APPROVAL");
    }

    if (input.approvalScope === "work_completion") {
      if (!/^workspace:[a-f0-9]{64}$/i.test(input.subjectRevision)) throw new Error("INVALID_WORK_APPROVAL");
      this.workStore.recordApproval(
        workItemId,
        principalId,
        scope,
        {
          expectedRevision: input.expectedRevision,
          actor: actor.actor,
          role: actor.role,
          approvalScope: "work_completion",
          subjectType: "workspace_revision",
          subjectRevision: input.subjectRevision,
          decision: input.decision,
        },
        now,
      );
      let work = this.workStore.getWork(workItemId, principalId, scope);
      if (input.decision === "approved") {
        const gate = this.workStore.evaluateCompletionGate(workItemId, principalId, scope);
        if (gate.ready && !TERMINAL_WORK.has(work.status)) {
          work = this.workStore.transitionWork(workItemId, principalId, scope, work.stateRevision, "completed", now);
        }
      }
      if (TERMINAL_WORK.has(work.status)) this.workStore.requestTerminalWorkspaceCleanup(workItemId, now);
      return this.detail(workItemId, principalId, scope);
    }

    if (!this.publications) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
    const match = /^publication:([0-9a-f-]{36}):([a-f0-9]{40,64})$/i.exec(input.subjectRevision);
    if (!match) throw new Error("INVALID_WORK_APPROVAL");
    const publicationId = match[1]!;
    const commitSha = match[2]!.toLowerCase();
    const publication = this.publications.getPublication(publicationId);
    const work = this.workStore.getWork(workItemId, principalId, scope);
    const artifact = this.publications.getPublicationArtifact(publicationId);
    if (
      publication.workItemId !== workItemId ||
      publication.state !== "prepared" ||
      !artifact ||
      publication.commitSha?.toLowerCase() !== commitSha ||
      artifact.commitSha.toLowerCase() !== commitSha ||
      publication.sourceSubjectRevision !== work.currentSubjectRevision
    ) {
      throw new Error("PUBLICATION_APPROVAL_STALE");
    }
    this.workStore.recordApproval(
      workItemId,
      principalId,
      scope,
      {
        expectedRevision: input.expectedRevision,
        actor: actor.actor,
        role: actor.role,
        approvalScope: "publish_work_branch",
        subjectType: "publication_artifact",
        subjectRevision: input.subjectRevision,
        decision: input.decision,
      },
      now,
    );
    if (input.decision === "approved") {
      this.publications.transitionPublication(publicationId, "approved", {}, now);
    } else {
      this.publications.transitionPublication(
        publicationId,
        "blocked",
        { lastErrorCode: "PUBLICATION_APPROVAL_REJECTED", lastErrorContext: input.subjectRevision },
        now,
      );
    }
    return this.detail(workItemId, principalId, scope);
  }

  recordEvidence(
    workItemId: string,
    principalId: string,
    scope: string,
    input: Parameters<WorkOrchestrationStore["recordEvidence"]>[3],
    now = Date.now(),
  ): WorkDetail {
    this.workStore.recordEvidence(workItemId, principalId, scope, input, now);
    return this.detail(workItemId, principalId, scope);
  }

  ensurePublication(workItemId: string, principalId: string, scope: string, now = Date.now()): WorkPublicationRecord {
    if (!this.publications) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
    const work = this.workStore.getWork(workItemId, principalId, scope);
    if (!work.currentSubjectRevision || !/^workspace:[a-f0-9]{64}$/i.test(work.currentSubjectRevision)) {
      throw new Error("PUBLICATION_SOURCE_STALE");
    }
    const attempts = this.workStore.listAttempts(workItemId);
    const attempt = attempts.at(-1);
    if (!attempt || attempt.status !== "succeeded" || !attempt.taskId || !attempt.workspaceId) {
      throw new Error("PUBLICATION_WORK_ATTEMPT_NOT_READY");
    }
    const acceptedReview = this.workStore
      .listReviewDecisions(workItemId)
      .some((review) => review.subjectRevision === work.currentSubjectRevision && review.decision === "accepted");
    if (!acceptedReview) throw new Error("PUBLICATION_REVIEW_REQUIRED");

    const workspace = this.workStore.getWorkspace(attempt.workspaceId);
    if (
      !workspace.ownerWorkerId ||
      !workspace.path ||
      !workspace.baseCommit ||
      workspace.state === "removed" ||
      workspace.state === "failed"
    ) {
      throw new Error("PUBLICATION_WORKSPACE_UNAVAILABLE");
    }
    if (!this.workerAvailable(workspace.ownerWorkerId, now)) {
      throw new Error("PUBLICATION_WORKSPACE_UNAVAILABLE");
    }

    const task = this.tasks.get(attempt.taskId, principalId, scope);
    const summary = task.workspaceChangeSummary;
    if (
      !summary ||
      "workspace:" + summary.contentRevision !== work.currentSubjectRevision ||
      summary.baseCommit !== workspace.baseCommit
    ) {
      throw new Error("PUBLICATION_SOURCE_STALE");
    }

    if (!attempt.dispatchBinding) throw new Error("PUBLICATION_POLICY_MISSING");
    const resolved = asResolvedDispatch(attempt.dispatchBinding);
    const repository = resolved.deploymentSnapshot?.repository;
    const policy = repository?.publicationPolicy;
    if (!repository || !policy) throw new Error("PUBLICATION_POLICY_MISSING");
    if (!policy.permissions.includes("prepare-commit") || !policy.permissions.includes("push-work-branch")) {
      throw new Error("PUBLICATION_NOT_ALLOWED");
    }
    if (repository.id !== task.repositoryId) throw new Error("PUBLICATION_REPOSITORY_MISMATCH");

    const existingPublication = this.publications
      .listPublications(workItemId)
      .find(
        (publication) =>
          publication.workAttemptId === attempt.workAttemptId && publication.repositoryId === repository.id,
      );
    if (existingPublication) {
      if (existingPublication.sourceSubjectRevision !== work.currentSubjectRevision) {
        throw new Error("PUBLICATION_SOURCE_REVISION_CONFLICT");
      }
      return existingPublication;
    }

    const branchName = buildWorkBranchName(policy.branchPrefix, workItemId, attempt.sequence);
    const commitMetadata = buildPublicationCommitMetadata({
      title: work.title,
      workItemId,
      workAttemptId: attempt.workAttemptId,
      sourceSubjectRevision: work.currentSubjectRevision,
      timestamp: now,
    });
    return this.publications.createOrReusePublication(
      {
        workItemId,
        workAttemptId: attempt.workAttemptId,
        workspaceId: workspace.workspaceId,
        sourceSubjectRevision: work.currentSubjectRevision,
        baseCommit: workspace.baseCommit,
        repositoryId: repository.id,
        repositoryIdentityRevision: resolved.deploymentConfigVersion,
        publicationPolicyRevision: policy.version,
        branchName,
        pushRemoteName: "origin",
        ownerWorkerId: workspace.ownerWorkerId,
        commitTimestamp: commitMetadata.timestamp,
        commitAuthorName: commitMetadata.authorName,
        commitAuthorEmail: commitMetadata.authorEmail,
        commitMessage: commitMetadata.message,
        executionSnapshot: {
          workspacePath: workspace.path,
          repositoryUrl: repository.url,
          defaultBranch: repository.branch,
          branchPrefix: policy.branchPrefix,
          protectedBranches: [...policy.protectedBranches],
          allowedPushRemote: policy.allowedPushRemote,
          ...(policy.credentialRef ? { credentialRef: policy.credentialRef } : {}),
          expectedContentRevision: summary.contentRevision,
          approvedChangeSummary: summary,
        },
      },
      now,
    );
  }

  recordPreparedPublicationArtifact(
    workItemId: string,
    principalId: string,
    scope: string,
    publicationId: string,
    now = Date.now(),
  ): WorkDetail {
    if (!this.publications) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
    const work = this.workStore.getWork(workItemId, principalId, scope);
    const publication = this.publications.getPublication(publicationId);
    if (publication.workItemId !== workItemId) throw new Error("PUBLICATION_WORK_MISMATCH");
    if (work.currentSubjectRevision !== publication.sourceSubjectRevision) {
      if (["preparing", "prepared", "approved", "pushing"].includes(publication.state)) {
        this.publications.transitionPublication(
          publicationId,
          "blocked",
          {
            lastErrorCode: "PUBLICATION_SOURCE_STALE",
            lastErrorContext: work.currentSubjectRevision ?? "missing_current_subject",
          },
          now,
        );
      }
      throw new Error("PUBLICATION_SOURCE_STALE");
    }
    const artifact = this.publications.getPublicationArtifact(publicationId);
    if (!artifact) throw new Error("PUBLICATION_ARTIFACT_NOT_PREPARED");
    this.workStore.recordEvidence(
      workItemId,
      principalId,
      scope,
      {
        workAttemptId: publication.workAttemptId,
        type: "artifact",
        status: "passed",
        source: "worker_verified",
        summary: "git_commit:" + artifact.commitSha,
        artifactRef: artifact.artifactId,
        subjectRevision: publication.sourceSubjectRevision,
        environmentIdentity: "publication-policy@" + publication.publicationPolicyRevision,
        verifierIdentity: "team-skill-hub-publication",
      },
      now,
    );
    return this.detail(workItemId, principalId, scope);
  }

  cancelWork(workItemId: string, principalId: string, scope: string, now = Date.now()): WorkDetail {
    const detail = this.detail(workItemId, principalId, scope);
    if (TERMINAL_WORK.has(detail.work.status)) return detail;
    if (detail.currentTask && (detail.currentTask.status === "queued" || detail.currentTask.status === "running")) {
      this.tasks.cancel(detail.currentTask.taskId, principalId, scope);
    }
    const current = this.workStore.getWork(workItemId, principalId, scope);
    if (current.activeWorkAttemptId) {
      this.workStore.finishWorkAttempt(
        workItemId,
        current.activeWorkAttemptId,
        principalId,
        scope,
        current.stateRevision,
        "cancelled",
        "cancelled",
        now,
      );
    } else {
      this.workStore.transitionWork(workItemId, principalId, scope, current.stateRevision, "cancelled", now);
    }
    this.workStore.requestTerminalWorkspaceCleanup(workItemId, now);
    return this.detail(workItemId, principalId, scope);
  }

  private startAttempt(
    work: WorkItemRecord,
    reason: WorkAttemptReason,
    parentWorkAttemptId: string | null,
    now: number,
  ): WorkAttemptRecord {
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const resolved = this.dispatch.resolve({
      principalId: work.principalId,
      scope: work.scope,
      problem: work.description,
      expertId: work.requestedExpertId ?? undefined,
      selectionMode: work.requestedExpertId ? "explicit" : "auto",
      repositoryId: work.repositoryId ?? undefined,
      deploymentId: work.requestedDeploymentId ?? undefined,
      requiredRuntimeProfile: workflow.definition.execution.requiredRuntimeProfile,
    });
    const attempt = this.workStore.createWorkAttempt(
      work.workItemId,
      work.principalId,
      work.scope,
      work.stateRevision,
      {
        reason,
        expertId: resolved.expertId,
        deploymentId: resolved.deploymentId,
        deploymentConfigVersion: resolved.deploymentConfigVersion,
        ...(parentWorkAttemptId ? { parentWorkAttemptId } : {}),
        dispatchBinding: resolved as unknown as Record<string, unknown>,
      },
      now,
    );
    this.ensureWorkspace(work.workItemId, attempt, resolved, now);
    return this.dispatchAttempt(this.workStore.getWork(work.workItemId, work.principalId, work.scope), attempt);
  }

  private ensureWorkspace(
    workItemId: string,
    attempt: WorkAttemptRecord,
    resolved: ResolvedDispatch,
    now: number,
  ): WorkspaceRecord {
    const workflow = this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion);
    return this.workStore.ensureWorkspace(
      workItemId,
      attempt.workAttemptId,
      {
        ...(resolved.deploymentSnapshot?.repository?.url
          ? { repositoryUrl: resolved.deploymentSnapshot.repository.url }
          : {}),
        ...(resolved.deploymentSnapshot?.repository?.branch
          ? { branch: resolved.deploymentSnapshot.repository.branch }
          : {}),
        cleanupPolicy: workflow.definition.execution.workspace.cleanup,
      },
      now,
    );
  }

  private dispatchAttempt(work: WorkItemRecord, attempt: WorkAttemptRecord): WorkAttemptRecord {
    let resolved: ResolvedDispatch;
    if (attempt.dispatchBinding) {
      resolved = asResolvedDispatch(attempt.dispatchBinding);
    } else {
      const fresh = this.dispatch.resolve({
        principalId: work.principalId,
        scope: work.scope,
        problem: work.description,
        expertId: attempt.expertId,
        selectionMode: "explicit",
        repositoryId: work.repositoryId ?? undefined,
        deploymentId: attempt.deploymentId,
        requiredRuntimeProfile: this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion).definition
          .execution.requiredRuntimeProfile,
      });
      if (fresh.deploymentConfigVersion !== attempt.deploymentConfigVersion) {
        throw new Error("STALE_DEPLOYMENT_CONFIG");
      }
      resolved = fresh;
      attempt = this.workStore.bindAttemptDispatch(
        attempt.workAttemptId,
        fresh as unknown as Record<string, unknown>,
        attempt.deploymentConfigVersion,
      );
    }

    const workspace = this.ensureWorkspace(work.workItemId, attempt, resolved, Date.now());
    attempt = this.workStore.getWorkAttempt(attempt.workAttemptId);

    const task = this.dispatch.submitResolved(
      {
        principalId: work.principalId,
        scope: work.scope,
        idempotencyKey: `work:${work.workItemId}:attempt:${attempt.sequence}`,
        sourceClient: "work_orchestrator",
        problem: work.description,
        expertId: resolved.expertId,
        selectionMode: "explicit",
        repositoryId: resolved.repositoryId,
        deploymentId: resolved.deploymentId,
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workflowId: attempt.workflowId,
        workflowVersion: attempt.workflowVersion,
        workspaceKey: workspace.workspaceKey,
        validationSnapshot: this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion).definition
          .validation.required,
      },
      resolved,
    );
    return this.workStore.linkAttemptTask(attempt.workAttemptId, task.taskId);
  }

  private handleDispatchFailure(
    workItemId: string,
    principalId: string,
    scope: string,
    error: unknown,
    now: number,
  ): WorkDetail | null {
    const reason = error instanceof Error ? error.message : String(error);
    const blocker = isBlocker(reason);
    if (!blocker) return null;
    const current = this.workStore.getWork(workItemId, principalId, scope);
    if (current.status !== "blocked") {
      this.workStore.blockWork(
        current.workItemId,
        current.principalId,
        current.scope,
        current.stateRevision,
        blocker,
        reason,
        now,
        blockerMetadata(blocker, current),
      );
    }
    return this.detail(workItemId, principalId, scope);
  }

  private reconcilePublicationLifecycle(work: WorkItemRecord, now: number): WorkItemRecord {
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    if (!workflow.definition.publication?.required) return work;
    if (!this.publications) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
    if (!work.currentSubjectRevision || !/^workspace:[a-f0-9]{64}$/i.test(work.currentSubjectRevision)) return work;

    const acceptedReview = this.workStore
      .listReviewDecisions(work.workItemId)
      .some((review) => review.subjectRevision === work.currentSubjectRevision && review.decision === "accepted");
    if (!acceptedReview) return work;

    let publication = this.publications
      .listPublications(work.workItemId)
      .filter((item) => item.sourceSubjectRevision === work.currentSubjectRevision)
      .at(-1);

    if (!publication) {
      try {
        publication = this.ensurePublication(work.workItemId, work.principalId, work.scope, now);
      } catch (error) {
        const code = error instanceof Error ? error.message : "PUBLICATION_PREPARATION_FAILED";
        if (
          code === "PUBLICATION_WORKSPACE_UNAVAILABLE" ||
          code === "PUBLICATION_POLICY_MISSING" ||
          code === "PUBLICATION_NOT_ALLOWED" ||
          code === "PUBLICATION_REPOSITORY_MISMATCH"
        ) {
          return this.workStore.blockWork(
            work.workItemId,
            work.principalId,
            work.scope,
            work.stateRevision,
            "publication_blocked",
            code,
            now,
            { resumeCondition: "manual", blockedByType: "publication", blockedByRef: work.workItemId },
          );
        }
        throw error;
      }
    }

    if (publication.state === "blocked" || publication.state === "failed") {
      if (work.status !== "blocked") {
        return this.workStore.blockWork(
          work.workItemId,
          work.principalId,
          work.scope,
          work.stateRevision,
          "publication_blocked",
          publication.lastErrorCode ?? "PUBLICATION_FAILED",
          now,
          { resumeCondition: "manual", blockedByType: "publication", blockedByRef: publication.publicationId },
        );
      }
      return work;
    }

    if (["prepared", "approved", "pushing", "pushed"].includes(publication.state)) {
      const artifact = this.publications.getPublicationArtifact(publication.publicationId);
      if (artifact) {
        const hasArtifactEvidence = this.workStore
          .listEvidence(work.workItemId)
          .some(
            (evidence) =>
              !evidence.stale &&
              evidence.type === "artifact" &&
              evidence.artifactRef === artifact.artifactId &&
              evidence.subjectRevision === publication!.sourceSubjectRevision,
          );
        if (!hasArtifactEvidence) {
          this.recordPreparedPublicationArtifact(
            work.workItemId,
            work.principalId,
            work.scope,
            publication.publicationId,
            now,
          );
        }
      }
    }

    publication = this.publications.getPublication(publication.publicationId);
    if (publication.state !== "pushed" || !publication.commitSha || !publication.artifactRef) {
      return this.workStore.getWork(work.workItemId, work.principalId, work.scope);
    }

    const publicationSubject = "publication:" + publication.publicationId + ":" + publication.commitSha;
    const hasPublicationEvidence = this.workStore
      .listEvidence(work.workItemId)
      .some(
        (evidence) =>
          !evidence.stale &&
          evidence.type === "publication" &&
          evidence.status === "passed" &&
          evidence.subjectRevision === publicationSubject &&
          evidence.artifactRef === publication!.artifactRef,
      );
    if (!hasPublicationEvidence) {
      this.workStore.recordEvidence(
        work.workItemId,
        work.principalId,
        work.scope,
        {
          workAttemptId: publication.workAttemptId,
          type: "publication",
          status: "passed",
          source: "worker_verified",
          summary: "work_branch:" + publication.branchName + "@" + publication.commitSha,
          artifactRef: publication.artifactRef,
          subjectRevision: publicationSubject,
          environmentIdentity: "publication-policy@" + publication.publicationPolicyRevision,
          verifierIdentity: "team-skill-hub-publication",
        },
        now,
      );
    }

    let current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
    const gate = this.workStore.evaluateCompletionGate(current.workItemId, current.principalId, current.scope);
    if (gate.ready && !TERMINAL_WORK.has(current.status)) {
      current = this.workStore.transitionWork(
        current.workItemId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "completed",
        now,
      );
      this.workStore.requestTerminalWorkspaceCleanup(current.workItemId, now);
    }
    return current;
  }

  private reconcileSucceeded(
    work: WorkItemRecord,
    attempt: WorkAttemptRecord,
    task: TaskRecord,
    now: number,
  ): WorkDetail {
    let current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
    const subjectRevision = resultSubject(task);
    if (current.currentSubjectRevision !== subjectRevision) {
      current = this.workStore.setCurrentSubjectRevision(
        current.workItemId,
        current.principalId,
        current.scope,
        current.stateRevision,
        subjectRevision,
        now,
      );
    }

    this.workStore.recordEvidence(
      current.workItemId,
      current.principalId,
      current.scope,
      {
        workAttemptId: attempt.workAttemptId,
        taskId: task.taskId,
        type: "expert_result",
        status: "passed",
        source: "worker_verified",
        subjectRevision,
        environmentIdentity: task.deploymentId
          ? `${task.deploymentId}@${task.deploymentConfigVersion ?? "legacy"}`
          : "legacy-expert-runtime",
        verifierIdentity: "team-skill-hub",
        ...(task.result ? { summary: task.result } : {}),
      },
      now,
    );

    for (const verification of task.verificationResults) {
      this.workStore.recordEvidence(
        current.workItemId,
        current.principalId,
        current.scope,
        {
          workAttemptId: attempt.workAttemptId,
          taskId: task.taskId,
          ...(task.runId ? { runId: task.runId } : {}),
          type: verification.evidenceType,
          status: verification.status,
          source: "worker_verified",
          subjectRevision: verification.subjectRevision,
          environmentIdentity: verification.environmentIdentity,
          verifierIdentity: verification.verifierIdentity,
          summary: verification.errorCode ? `${verification.stepId}:${verification.errorCode}` : verification.stepId,
        },
        now,
      );
    }

    const verificationByStep = new Map(task.verificationResults.map((item) => [item.stepId, item]));
    const requiredVerificationFailed = task.validationSnapshot.some((step) => {
      const verification = verificationByStep.get(step.id);
      return !verification || verification.status !== "passed";
    });
    if (requiredVerificationFailed) {
      return this.requestContinuation(
        current.workItemId,
        current.principalId,
        current.scope,
        "verification_failed",
        now,
      );
    }

    current = this.workStore.getWork(current.workItemId, current.principalId, current.scope);
    if (current.activeWorkAttemptId === attempt.workAttemptId) {
      this.workStore.finishWorkAttempt(
        current.workItemId,
        attempt.workAttemptId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "succeeded",
        "waiting_review",
        now,
      );
    }
    return this.detail(current.workItemId, current.principalId, current.scope);
  }

  private reconcileFailed(work: WorkItemRecord, attempt: WorkAttemptRecord, task: TaskRecord, now: number): WorkDetail {
    let current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
    const reason = task.result ?? "EXECUTION_FAILED";
    const blocker = isBlocker(reason);
    if (blocker) {
      if (current.status !== "blocked") {
        this.workStore.blockWork(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          blocker,
          reason,
          now,
          blockerMetadata(blocker, current),
        );
      }
      return this.detail(current.workItemId, current.principalId, current.scope);
    }

    const workflow = this.workStore.getWorkflow(current.workflowId, current.workflowVersion);
    const runCount = this.tasks.runCount(task.taskId);
    if (isRetryable(reason) && runCount < workflow.definition.lifecycle.retry.failure.maxRunsPerWorkAttempt) {
      if (current.nextActionType === "failure_retry" && current.nextActionAt !== null) {
        if (current.nextActionAt <= now) {
          this.tasks.requeueForRetry(task.taskId, attempt.workAttemptId, reason, now);
          current = this.workStore.getWork(current.workItemId, current.principalId, current.scope);
          this.workStore.scheduleNextAction(current.workItemId, current.stateRevision, null, null, now);
        }
        return this.detail(current.workItemId, current.principalId, current.scope);
      }
      const retryIndex = Math.max(0, runCount - 1);
      const backoff = Math.min(
        workflow.definition.lifecycle.retry.failure.initialBackoffMs * 2 ** retryIndex,
        workflow.definition.lifecycle.retry.failure.maxBackoffMs,
      );
      this.workStore.scheduleNextAction(current.workItemId, current.stateRevision, "failure_retry", now + backoff, now);
      return this.detail(current.workItemId, current.principalId, current.scope);
    }

    if (current.activeWorkAttemptId === attempt.workAttemptId) {
      this.workStore.finishWorkAttempt(
        current.workItemId,
        attempt.workAttemptId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "failed",
        "failed",
        now,
      );
      this.workStore.requestTerminalWorkspaceCleanup(current.workItemId, now);
    }
    return this.detail(current.workItemId, current.principalId, current.scope);
  }

  private detail(workItemId: string, principalId: string, scope: string): WorkDetail {
    const work = this.workStore.getWork(workItemId, principalId, scope);
    const attempts = this.workStore.listAttempts(workItemId);
    const latest = attempts.at(-1);
    const currentTask = latest?.taskId ? this.tasks.get(latest.taskId, principalId, scope) : null;
    const turns = currentTask ? this.tasks.listRunTurns(currentTask.taskId, principalId, scope) : [];
    const workspace = latest?.workspaceId ? this.workStore.getWorkspace(latest.workspaceId) : null;
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const verificationResults = currentTask?.verificationResults ?? [];
    const approvals = this.workStore.listApprovals(workItemId);
    const publicationRecord = this.publications?.listPublications(workItemId).at(-1) ?? null;
    const publicationSubject = publicationRecord?.commitSha
      ? "publication:" + publicationRecord.publicationId + ":" + publicationRecord.commitSha
      : null;
    const publicationApproval = publicationSubject
      ? approvals
          .filter(
            (approval) =>
              !approval.stale &&
              approval.approvalScope === "publish_work_branch" &&
              approval.subjectType === "publication_artifact" &&
              approval.subjectRevision === publicationSubject,
          )
          .at(-1)
      : undefined;
    const publication = publicationRecord
      ? {
          publicationId: publicationRecord.publicationId,
          state: publicationRecord.state,
          sourceSubjectRevision: publicationRecord.sourceSubjectRevision,
          repositoryId: publicationRecord.repositoryId,
          publicationPolicyRevision: publicationRecord.publicationPolicyRevision,
          branchName: publicationRecord.branchName,
          commitSha: publicationRecord.commitSha,
          treeSha: publicationRecord.treeSha,
          artifactRef: publicationRecord.artifactRef,
          approvalState: (publicationApproval?.decision ?? "pending") as "pending" | "approved" | "rejected",
          retryCount: publicationRecord.retryCount,
          nextAttemptAt: publicationRecord.nextAttemptAt,
          lastErrorCode: publicationRecord.lastErrorCode,
          lastErrorContext: publicationRecord.lastErrorContext,
          preparedAt: publicationRecord.preparedAt,
          approvedAt: publicationRecord.approvedAt,
          pushedAt: publicationRecord.pushedAt,
        }
      : null;
    return {
      work,
      attempts,
      evidence: this.workStore.listEvidence(workItemId),
      currentTask,
      turns,
      workspace,
      verification: {
        requiredEvidence: workflow.definition.validation.requiredEvidence,
        requiredSteps: currentTask?.validationSnapshot ?? workflow.definition.validation.required,
        results: verificationResults,
        passed: verificationResults.filter((item) => item.status === "passed").length,
        failed: verificationResults.filter((item) => item.status === "failed").length,
      },
      gate: this.workStore.evaluateCompletionGate(workItemId, principalId, scope),
      runtime: {
        requiredProfile: workflow.definition.execution.requiredRuntimeProfile ?? null,
        effectiveProfile:
          (latest?.dispatchBinding && typeof latest.dispatchBinding.runtimeProfile === "string"
            ? latest.dispatchBinding.runtimeProfile
            : currentTask?.deploymentSnapshot?.runtimeProfile) ?? null,
      },
      workspaceChangeSummary: currentTask?.workspaceChangeSummary ?? null,
      reviews: this.workStore.listReviewDecisions(workItemId),
      approvals,
      publication,
    };
  }
}
