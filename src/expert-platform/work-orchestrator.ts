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
  type WorkOrchestrationFence,
  type WorkReworkRequest,
  type WorkSourceObservationRecord,
  type WorkSubmission,
  type WorkspaceRecord,
  WorkOrchestrationStore,
} from "./work-orchestration-store.js";
import { WorkPublicationStore, type WorkPublicationRecord } from "./work-publication-store.js";
import { WorkChangeRequestStore, type WorkChangeRequestRecord } from "./work-change-request-store.js";
import { buildPublicationCommitMetadata, buildWorkBranchName } from "./publication-policy.js";
import { resolveRuntimeProfilePolicy } from "./runtime-profile-policy.js";
import { normalizeVerificationPolicy, type VerificationPolicyStep } from "./verification-policy.js";
import { WorkDagShadowProjector } from "./work-dag-shadow-projector.js";
import type { WorkDagDeliveryTarget } from "./work-dag-delivery-adapters.js";

export interface SubmitWorkInput extends WorkSubmission {
  sourceSessionId?: string;
  sourceClient?: string;
  sourceRequestId?: string;
}

export interface WorkDetail {
  work: WorkItemRecord;
  attempts: WorkAttemptRecord[];
  evidence: WorkEvidenceRecord[];
  sourceObservations: WorkSourceObservationRecord[];
  currentTask: TaskRecord | null;
  reviewTask: TaskRecord | null;
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
  dag: {
    currentRevision: number;
    requirementRevision: number;
    revision: ReturnType<WorkOrchestrationStore["getDagRevision"]> | null;
    revisions: ReturnType<WorkOrchestrationStore["listDagRevisions"]>;
    requirementSnapshot: ReturnType<WorkOrchestrationStore["getRequirementSnapshot"]> | null;
    replanRequests: ReturnType<WorkOrchestrationStore["listDagReplanRequests"]>;
    proposals: ReturnType<WorkOrchestrationStore["listDagProposals"]>;
    executions: ReturnType<WorkOrchestrationStore["listDagExecutions"]>;
    facts: ReturnType<WorkOrchestrationStore["listDagFacts"]>;
    evidence: ReturnType<WorkOrchestrationStore["listDagEvidence"]>;
    evidenceView: Array<
      ReturnType<WorkOrchestrationStore["listDagEvidence"]>[number] & {
        stale: boolean;
      }
    >;
    artifacts: ReturnType<WorkOrchestrationStore["listDagArtifacts"]>;
    waits: ReturnType<WorkOrchestrationStore["listDagWaits"]>;
    lateResults: ReturnType<WorkOrchestrationStore["listDagLateResults"]>;
    decisions: ReturnType<WorkOrchestrationStore["listDagDecisions"]>;
    completion: ReturnType<WorkOrchestrationStore["evaluateDagCompletion"]>;
    shadow: ReturnType<WorkOrchestrationStore["getShadowDag"]>;
  } | null;
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
  changeRequest: {
    changeRequestId: string;
    publicationId: string;
    state: WorkChangeRequestRecord["state"];
    provider: string | null;
    externalId: string | null;
    url: string | null;
    headBranch: string;
    headCommit: string;
    baseBranch: string;
    retryCount: number;
    nextAttemptAt: number | null;
    lastErrorCode: string | null;
  } | null;
}

export interface WorkReviewInput {
  expectedRevision: number;
  subjectRevision: string;
  decision: ReviewDecision;
  reason?: string;
  actorPrincipalId?: string;
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

const DETERMINISTIC_WORKSPACE_ERRORS = new Set([
  "WORKER_CHECKOUT_OWNER_NOT_ALLOWED",
  "WORKER_GIT_METADATA_OWNERSHIP_INVALID",
  "WORKER_CHECKOUT_GROUP_NOT_CONFIGURED",
  "WORKER_CHECKOUT_PERMISSION_NOT_SHARED",
  "WORKER_RUNTIME_STATE_OWNER_INVALID",
  "WORKER_RUNTIME_STATE_GROUP_NOT_CONFIGURED",
  "WORKSPACE_PREPARATION_INCOMPLETE",
  "WORKSPACE_PREPARATION_REVISION_MISMATCH",
]);
function isBlocker(reason: string): string | null {
  const normalized = reason.trim().toUpperCase();
  if (DETERMINISTIC_WORKSPACE_ERRORS.has(normalized)) return "policy_blocked";
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
    normalized.includes("VERIFICATION_POLICY_") ||
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

function requiredWorkspaceAccessForWorkflow(
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

function preferredBackendForWork(work: WorkItemRecord): "claude" | "codex" | undefined {
  const source = (work.sourceScope ?? "").split("/", 1)[0]!.toLowerCase();
  if (source.includes("claude")) return "claude";
  if (source.includes("codex")) return "codex";
  return undefined;
}

function effectiveVerificationSteps(
  workflow: ReturnType<WorkOrchestrationStore["getWorkflow"]>,
  resolved: ResolvedDispatch,
): VerificationPolicyStep[] {
  const repositorySteps =
    workflow.definition.change?.mode === "code_change" || workflow.definition.change?.mode === "conditional_code_change"
      ? (resolved.deploymentSnapshot?.repository?.verificationPolicy?.required ?? [])
      : [];
  let steps: VerificationPolicyStep[];
  try {
    steps = normalizeVerificationPolicy([...workflow.definition.validation.required, ...repositorySteps]);
  } catch {
    throw new Error("VERIFICATION_POLICY_INVALID");
  }
  if (
    workflow.definition.change?.mode === "code_change" ||
    workflow.definition.change?.mode === "conditional_code_change"
  ) {
    const evidenceTypes = new Set(steps.map((step) => step.evidenceType));
    const missing = ["build", "unit_test"].filter((type) => !evidenceTypes.has(type));
    if (missing.length > 0) throw new Error("VERIFICATION_POLICY_MISSING:" + missing.join(","));
  }
  return steps;
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

function workAttemptExecutionProblem(work: WorkItemRecord, attempt: WorkAttemptRecord): string {
  return [
    "You are the execution agent for an existing Team Skill Hub WorkAttempt.",
    `WorkItem: ${work.workItemId}`,
    `WorkAttempt: ${attempt.workAttemptId}`,
    "The durable Work and ExpertTask have already been created by the platform.",
    "Do NOT call submit_work, submit_expert_task, submit_expert_task_auto, or any equivalent tool that creates/delegates another Work or ExpertTask.",
    "Do NOT stop or ask the caller to resubmit merely because the original request mentions Team Skill Hub submission; that orchestration step has already happened.",
    "Work directly in the provided repository/workspace. Use allowed Skill/Knowledge MCP tools only for execution context when useful.",
    "Implement or analyze the requested work. The platform will separately enforce verification, review, rework, branch publication, and completion gates.",
    "",
    "Original work:",
    work.description,
  ].join("\n");
}

function parseAgentReviewResult(result: string | null): { decision: "accepted" | "rework"; reason?: string } {
  if (!result) throw new Error("AGENT_REVIEW_RESULT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error("AGENT_REVIEW_RESULT_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AGENT_REVIEW_RESULT_INVALID");
  const decision = (parsed as { decision?: unknown }).decision;
  const reason =
    typeof (parsed as { reason?: unknown }).reason === "string" ? (parsed as { reason: string }).reason.trim() : "";
  if (decision !== "accepted" && decision !== "rework") throw new Error("AGENT_REVIEW_RESULT_INVALID");
  if (decision === "rework" && !reason) throw new Error("AGENT_REVIEW_RESULT_INVALID");
  return { decision, ...(reason ? { reason } : {}) };
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

function parseReworkRequest(context: string | null): WorkReworkRequest {
  if (!context) throw new Error("INVALID_REWORK_CONTEXT");
  let value: unknown;
  try {
    value = JSON.parse(context);
  } catch {
    throw new Error("INVALID_REWORK_CONTEXT");
  }
  if (!value || typeof value !== "object") throw new Error("INVALID_REWORK_CONTEXT");
  const input = value as Record<string, unknown>;
  if (
    !["human_rework", "review_rework", "policy_replan"].includes(String(input.reason ?? "")) ||
    typeof input.originWorkAttemptId !== "string" ||
    typeof input.createdBy !== "string"
  ) {
    throw new Error("INVALID_REWORK_CONTEXT");
  }
  return {
    reason: input.reason as WorkReworkRequest["reason"],
    originWorkAttemptId: input.originWorkAttemptId,
    ...(typeof input.reviewContext === "string" ? { reviewContext: input.reviewContext } : {}),
    ...(typeof input.whatShouldChange === "string" ? { whatShouldChange: input.whatShouldChange } : {}),
    createdBy: input.createdBy,
  };
}

export class WorkOrchestrator {
  private readonly orchestrationOwnerId = randomUUID();
  private readonly orchestrationLeaseMs = 30_000;
  private readonly shadowProjector: WorkDagShadowProjector;
  constructor(
    private readonly workStore: WorkOrchestrationStore,
    private readonly tasks: ExpertTaskStore,
    private readonly dispatch: ExpertDispatchService,
    private readonly workerAvailable: (workerId: string, now: number) => boolean = () => true,
    private readonly publications?: WorkPublicationStore,
    private readonly changeRequests?: WorkChangeRequestStore,
  ) {
    this.shadowProjector = new WorkDagShadowProjector(
      this.workStore,
      this.tasks,
      this.publications,
      this.changeRequests,
    );
  }

  stageWork(input: SubmitWorkInput, now = Date.now()): WorkDetail {
    const work = this.workStore.createOrReuseWork(input, now);
    this.workStore.ensureRequirementSnapshot(work.workItemId, now);
    this.refreshShadowProjection(work.workItemId, now);
    const detail = this.detail(work.workItemId, input.principalId, input.scope);
    if (work.reusedExistingWork !== undefined) detail.work.reusedExistingWork = work.reusedExistingWork;
    if (work.deduplicationReason !== undefined) detail.work.deduplicationReason = work.deduplicationReason;
    return detail;
  }

  submitWork(input: SubmitWorkInput, now = Date.now()): WorkDetail {
    const staged = this.stageWork(input, now);
    if (staged.work.orchestrationEngine === "dynamic-dag") return staged;
    return this.reconcileWork(staged.work.workItemId, input.principalId, input.scope, now);
  }

  getWork(workItemId: string, principalId: string, scope: string): WorkDetail {
    return this.detail(workItemId, principalId, scope);
  }

  reconcileSourceObservation(observationId: string, principalId: string, scope: string, now = Date.now()): WorkDetail {
    const observation = this.workStore.getSourceObservation(observationId);
    const initialWork = this.workStore.getWork(observation.workItemId, principalId, scope);
    if (observation.reconciledAt !== null) return this.detail(initialWork.workItemId, principalId, scope);
    const claim = this.workStore.claimWorkForOrchestration(
      initialWork.workItemId,
      this.orchestrationOwnerId,
      now,
      this.orchestrationLeaseMs,
    );
    try {
      const fence = this.orchestrationFence(claim.epoch, now);
      this.workStore.assertWorkOrchestrationClaim(initialWork.workItemId, this.orchestrationOwnerId, claim.epoch, now);
      return this.reconcileSourceObservationClaimed(observationId, principalId, scope, now, fence);
    } finally {
      this.workStore.releaseWorkOrchestrationClaim(initialWork.workItemId, this.orchestrationOwnerId, claim.epoch, now);
    }
  }

  private reconcileSourceObservationClaimed(
    observationId: string,
    principalId: string,
    scope: string,
    now: number,
    _fence: WorkOrchestrationFence,
  ): WorkDetail {
    const currentObservation = this.workStore.getSourceObservation(observationId);
    const work = this.workStore.getWork(currentObservation.workItemId, principalId, scope);
    if (currentObservation.reconciledAt !== null) return this.detail(work.workItemId, principalId, scope);
    if (currentObservation.state === "active") {
      this.workStore.markSourceObservationReconciled(observationId, "noop", now);
      return this.detail(work.workItemId, principalId, scope);
    }
    if (TERMINAL_WORK.has(work.status)) {
      this.workStore.markSourceObservationReconciled(observationId, "noop", now);
      return this.detail(work.workItemId, principalId, scope);
    }
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const policy = workflow.definition.source?.terminal ?? {
      active: "cancel",
      waitingReview: "retain_review" as const,
    };
    if (work.status === "waiting_review" && policy.waitingReview === "retain_review") {
      this.workStore.markSourceObservationReconciled(observationId, "retain_review", now);
      return this.detail(work.workItemId, principalId, scope);
    }
    this.cancelWork(work.workItemId, principalId, scope, now);
    this.workStore.markSourceObservationReconciled(observationId, "cancel", now);
    return this.detail(work.workItemId, principalId, scope);
  }

  private reconcilePendingSourceForClaimedWork(
    workItemId: string,
    principalId: string,
    scope: string,
    now: number,
    fence: WorkOrchestrationFence,
  ): WorkItemRecord {
    for (const observationId of this.workStore.listPendingSourceObservationIdsForWork(workItemId, 100)) {
      this.reconcileSourceObservationClaimed(observationId, principalId, scope, now, fence);
      const current = this.workStore.getWork(workItemId, principalId, scope);
      if (TERMINAL_WORK.has(current.status)) return current;
    }
    return this.workStore.getWork(workItemId, principalId, scope);
  }

  requestContinuation(
    workItemId: string,
    principalId: string,
    scope: string,
    reason: string,
    now = Date.now(),
    fence?: WorkOrchestrationFence,
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
        fence,
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
        fence,
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
        fence,
      );
      return this.detail(workItemId, principalId, scope);
    }
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const consumedTurns = Math.max(
      task.continuationCount + 1,
      this.tasks.listRunTurns(task.taskId, principalId, scope).length,
    );
    if (consumedTurns >= workflow.definition.lifecycle.continuation.maxTurnsPerRun) {
      this.workStore.blockWork(
        work.workItemId,
        work.principalId,
        work.scope,
        work.stateRevision,
        "continuation_limit",
        "WORK_CONTINUATION_LIMIT_REACHED",
        now,
        {
          resumeCondition: "manual",
          blockedByType: "continuation",
          blockedByRef: attempt.workAttemptId,
        },
        fence,
      );
      return this.detail(workItemId, principalId, scope);
    }
    if (work.nextActionType !== null) {
      if (work.nextActionType === "continuation" && work.nextActionContext === normalizedReason)
        return this.detail(workItemId, principalId, scope);
      throw new Error("WORK_NEXT_ACTION_PENDING");
    }
    this.workStore.scheduleNextAction(
      workItemId,
      work.stateRevision,
      "continuation",
      now,
      now,
      normalizedReason,
      fence,
    );
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
      const fence = this.orchestrationFence(claim.epoch, now);
      this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, claim.epoch, now);
      const sourceFenced = this.reconcilePendingSourceForClaimedWork(workItemId, principalId, scope, now, fence);
      if (TERMINAL_WORK.has(sourceFenced.status)) return this.detail(workItemId, principalId, scope);
      const claimedCurrent = this.workStore.getWork(workItemId, principalId, scope);
      const attempt = this.workStore.getActiveAttempt(workItemId);
      let continuationRequired = false;
      const pendingRework =
        !attempt && claimedCurrent.nextActionType === "rework" && claimedCurrent.nextActionContext !== null;
      if (claimedCurrent.blockedByType === "workspace") {
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
        claimedCurrent.stateRevision,
        attempt ? "running" : pendingRework ? "rework" : "queued",
        now,
        fence,
      );
      if (pendingRework) {
        resumed = this.workStore.scheduleNextAction(
          workItemId,
          resumed.stateRevision,
          "rework",
          now,
          now,
          claimedCurrent.nextActionContext,
          fence,
        );
        return this.reconcileWorkClaimed(workItemId, principalId, scope, now, claim.epoch);
      }
      if (continuationRequired) {
        this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, claim.epoch, now);
        resumed = this.workStore.scheduleNextAction(
          workItemId,
          resumed.stateRevision,
          "continuation",
          now,
          now,
          "resumed_after_block",
          fence,
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
    const fence = this.orchestrationFence(orchestrationEpoch, now);
    this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
    let work = this.workStore.getWork(workItemId, principalId, scope);
    if (TERMINAL_WORK.has(work.status)) return this.detail(workItemId, principalId, scope);
    this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
    work = this.reconcilePendingSourceForClaimedWork(workItemId, principalId, scope, now, fence);
    if (TERMINAL_WORK.has(work.status)) return this.detail(workItemId, principalId, scope);
    if (work.orchestrationEngine === "dynamic-dag") {
      return this.detail(workItemId, principalId, scope);
    }
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
    work = this.reconcilePublicationLifecycle(work, now, fence);
    if (TERMINAL_WORK.has(work.status) || work.status === "blocked") {
      return this.detail(workItemId, principalId, scope);
    }

    let attempt = this.workStore.getActiveAttempt(workItemId);
    if (!attempt && work.status === "rework") {
      if (work.nextActionType !== "rework") throw new Error("REWORK_ACTION_MISSING");
      const request = parseReworkRequest(work.nextActionContext);
      try {
        attempt = this.startAttempt(
          work,
          request.reason,
          request.originWorkAttemptId,
          now,
          {
            ...(request.reviewContext ? { reviewContext: request.reviewContext } : {}),
            ...(request.whatShouldChange ? { whatShouldChange: request.whatShouldChange } : {}),
            createdBy: request.createdBy,
          },
          fence,
        );
        work = this.workStore.getWork(workItemId, principalId, scope);
      } catch (error) {
        const blocked = this.handleDispatchFailure(workItemId, principalId, scope, error, now, fence, true);
        if (blocked) return blocked;
        throw error;
      }
    }
    if (attempt && work.nextActionType === "rework") {
      work = this.workStore.getWork(workItemId, principalId, scope);
      work = this.workStore.scheduleNextAction(workItemId, work.stateRevision, null, null, now, null, fence);
    }
    if (!attempt) {
      if (work.status === "queued") {
        try {
          this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
          attempt = this.startAttempt(work, "initial", null, now, {}, fence);
          work = this.workStore.getWork(workItemId, principalId, scope);
        } catch (error) {
          const blocked = this.handleDispatchFailure(workItemId, principalId, scope, error, now, fence);
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
        const blocked = this.handleDispatchFailure(workItemId, principalId, scope, error, now, fence);
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
            { resumeCondition: "manual", blockedByType: "workspace", blockedByRef: workspace.workspaceId },
            fence,
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
            fence,
          );
          return this.detail(workItemId, principalId, scope);
        }
        this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
        this.tasks.scheduleContinuation(task.taskId, task.runId, continuationReason, now, workspace.ownerWorkerId);
        this.workStore.recordRunContinued(
          workItemId,
          attempt.workAttemptId,
          task.taskId,
          task.runId,
          continuationReason,
          now,
        );
      } else if (
        (task.status !== "queued" && task.status !== "running") ||
        task.continuationReason !== continuationReason
      ) {
        throw new Error("TASK_CONTINUATION_STATE_MISMATCH");
      }
      work = this.workStore.getWork(workItemId, principalId, scope);
      this.workStore.scheduleNextAction(workItemId, work.stateRevision, null, null, now, null, fence);
      work = this.workStore.getWork(workItemId, principalId, scope);
    }
    task = this.tasks.get(attempt.taskId!, principalId, scope);
    if (attempt.reviewTaskId) {
      const reviewTask = this.tasks.get(attempt.reviewTaskId, principalId, scope);
      return this.reconcileAgentReview(work, attempt, reviewTask, now, fence);
    }
    if (task.status === "queued" || task.status === "running") {
      return this.detail(workItemId, principalId, scope);
    }

    if (task.status === "succeeded") {
      this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
      return this.reconcileSucceeded(work, attempt, task, now, fence);
    }

    if (task.status === "failed") {
      this.workStore.assertWorkOrchestrationClaim(workItemId, this.orchestrationOwnerId, orchestrationEpoch, now);
      return this.reconcileFailed(work, attempt, task, now, fence);
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
          fence,
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

  reconcilePendingSourceObservations(now = Date.now(), limit = 100): string[] {
    const processed: string[] = [];
    for (const observationId of this.workStore.listPendingSourceObservationIds(limit)) {
      const observation = this.workStore.getSourceObservation(observationId);
      const work = this.workStore.getWorkInternal(observation.workItemId);
      this.reconcileSourceObservation(observationId, work.principalId, work.scope, now);
      processed.push(work.workItemId);
    }
    return processed;
  }

  reconcileActive(now = Date.now(), limit = 100): string[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const processed = new Set<string>();
    for (const workItemId of this.reconcilePendingSourceObservations(now, boundedLimit)) processed.add(workItemId);
    const remaining = Math.max(0, boundedLimit - processed.size);
    if (remaining > 0) {
      for (const workItemId of this.workStore.listReconciliationWorkIds(now, remaining)) {
        const work = this.workStore.getWorkInternal(workItemId);
        this.reconcileWork(workItemId, work.principalId, work.scope, now);
        processed.add(workItemId);
      }
    }
    return [...processed];
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

    if (work.orchestrationEngine === "dynamic-dag") {
      if (!work.currentSubjectRevision) throw new Error("WORK_SUBJECT_REQUIRED");
      this.workStore.submitReviewDecision(
        work.workItemId,
        principalId,
        scope,
        {
          expectedRevision: work.stateRevision,
          subjectRevision: work.currentSubjectRevision,
          decision: "rework",
          reason: feedback.reason?.trim() || "Expert task feedback requested rework",
          actorPrincipalId: principalId,
        },
        now,
      );
      return this.detail(work.workItemId, principalId, scope);
    }

    work = this.workStore.requestRework(
      work.workItemId,
      principalId,
      scope,
      work.stateRevision,
      {
        reason: "human_rework",
        originWorkAttemptId: originAttempt.workAttemptId,
        reviewContext: JSON.stringify({
          disposition: feedback.disposition,
          needsRework: feedback.needsRework === true,
        }),
        whatShouldChange: feedback.reason,
        createdBy: principalId,
      },
      now,
    );
    return this.reconcileWork(work.workItemId, principalId, scope, now);
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
    if (work.orchestrationEngine === "dynamic-dag") {
      return this.detail(workItemId, principalId, scope);
    }

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
      if (!latest) throw new Error("WORK_ATTEMPT_NOT_FOUND");
      work = this.workStore.requestRework(
        workItemId,
        principalId,
        scope,
        work.stateRevision,
        {
          reason: "review_rework",
          originWorkAttemptId: latest.workAttemptId,
          reviewContext: JSON.stringify({
            decision: input.decision,
            subjectRevision: input.subjectRevision,
            reason: input.reason ?? null,
          }),
          whatShouldChange: input.reason,
          createdBy: principalId,
        },
        now,
      );
      return this.reconcileWork(workItemId, principalId, scope, now);
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
      if (work.orchestrationEngine === "dynamic-dag") {
        return this.detail(workItemId, principalId, scope);
      }
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

  ensurePublication(
    workItemId: string,
    principalId: string,
    scope: string,
    now = Date.now(),
    target?: WorkDagDeliveryTarget,
  ): WorkPublicationRecord {
    if (!this.publications) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
    const work = this.workStore.getWork(workItemId, principalId, scope);
    if (target) {
      const subjectRevision = target.subjectRevision?.trim() || "";
      if (!subjectRevision || !/^workspace:[a-f0-9]{64}$/i.test(subjectRevision)) {
        throw new Error("PUBLICATION_SOURCE_STALE");
      }
      const attempts = this.workStore.listAttempts(workItemId);
      const attempt = [...attempts]
        .reverse()
        .find((candidate) =>
          Boolean(this.workStore.getWorkspaceForResource(candidate.workAttemptId, target.resourceKey)),
        );
      if (!attempt) throw new Error("PUBLICATION_WORK_ATTEMPT_NOT_READY");
      const workspace = this.workStore.getWorkspaceForResource(attempt.workAttemptId, target.resourceKey);
      if (
        !workspace ||
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
      const task = this.tasks
        .listByWorkAttempt(attempt.workAttemptId, principalId, scope)
        .filter(
          (candidate) =>
            candidate.executionKind === "agent" &&
            candidate.status === "succeeded" &&
            candidate.workspaceKey === workspace.workspaceKey &&
            candidate.repositoryId === (target.repositoryId ?? workspace.repositoryId) &&
            candidate.workspaceChangeSummary !== null &&
            "workspace:" + candidate.workspaceChangeSummary.contentRevision === subjectRevision,
        )
        .at(-1);
      if (!task?.workspaceChangeSummary) throw new Error("PUBLICATION_SOURCE_STALE");
      const summary = task.workspaceChangeSummary;
      if (summary.baseCommit !== workspace.baseCommit) throw new Error("PUBLICATION_SOURCE_STALE");
      const repository = task.deploymentSnapshot?.repository;
      const policy = repository?.publicationPolicy;
      if (!repository || !policy) throw new Error("PUBLICATION_POLICY_MISSING");
      if (!policy.permissions.includes("prepare-commit") || !policy.permissions.includes("push-work-branch")) {
        throw new Error("PUBLICATION_NOT_ALLOWED");
      }
      if (target.repositoryId && repository.id !== target.repositoryId) {
        throw new Error("PUBLICATION_REPOSITORY_MISMATCH");
      }

      const existingPublication = this.publications
        .listPublications(workItemId)
        .find(
          (publication) =>
            publication.workAttemptId === attempt.workAttemptId && publication.repositoryId === repository.id,
        );
      if (existingPublication) {
        if (existingPublication.sourceSubjectRevision !== subjectRevision) {
          throw new Error("PUBLICATION_SOURCE_REVISION_CONFLICT");
        }
        return existingPublication;
      }

      const branchName = buildWorkBranchName(policy.branchPrefix, workItemId, attempt.sequence);
      const commitMetadata = buildPublicationCommitMetadata({
        title: work.title,
        workItemId,
        workAttemptId: attempt.workAttemptId,
        sourceSubjectRevision: subjectRevision,
        timestamp: now,
      });
      return this.publications.createOrReusePublication(
        {
          workItemId,
          workAttemptId: attempt.workAttemptId,
          workspaceId: workspace.workspaceId,
          sourceSubjectRevision: subjectRevision,
          baseCommit: workspace.baseCommit,
          repositoryId: repository.id,
          repositoryIdentityRevision: task.deploymentConfigVersion ?? attempt.deploymentConfigVersion,
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
            ...((policy.credentialRef ?? repository.credentialRef)
              ? { credentialRef: policy.credentialRef ?? repository.credentialRef }
              : {}),
            expectedContentRevision: summary.contentRevision,
            approvedChangeSummary: summary,
          },
        },
        now,
      );
    }
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
          // The repository credential is the safe default for template-based publication.
          // An explicit publication credential can still override it.
          ...((policy.credentialRef ?? repository.credentialRef)
            ? { credentialRef: policy.credentialRef ?? repository.credentialRef }
            : {}),
          expectedContentRevision: summary.contentRevision,
          approvedChangeSummary: summary,
        },
      },
      now,
    );
  }

  ensureChangeRequest(
    workItemId: string,
    principalId: string,
    scope: string,
    now = Date.now(),
    target?: WorkDagDeliveryTarget,
  ): WorkChangeRequestRecord {
    if (!this.publications || !this.changeRequests) throw new Error("CHANGE_REQUEST_STORE_UNAVAILABLE");
    const work = this.workStore.getWork(workItemId, principalId, scope);
    const publication = this.publications
      .listPublications(workItemId)
      .filter((item) =>
        target
          ? item.sourceSubjectRevision === target.subjectRevision &&
            (target.repositoryId === null || item.repositoryId === target.repositoryId)
          : item.sourceSubjectRevision === work.currentSubjectRevision,
      )
      .at(-1);
    if (!publication || publication.state !== "pushed" || !publication.commitSha) {
      throw new Error("CHANGE_REQUEST_PUBLICATION_NOT_READY");
    }
    const existing = this.changeRequests.getByPublication(publication.publicationId);
    if (existing) return existing;
    const attempt = this.workStore
      .listAttempts(workItemId)
      .find((item) => item.workAttemptId === publication.workAttemptId);
    let repository = attempt?.dispatchBinding
      ? asResolvedDispatch(attempt.dispatchBinding).deploymentSnapshot?.repository
      : null;
    if (target && attempt) {
      const workspace = this.workStore.getWorkspace(publication.workspaceId);
      const task = this.tasks
        .listByWorkAttempt(attempt.workAttemptId, principalId, scope)
        .filter(
          (candidate) =>
            candidate.executionKind === "agent" &&
            candidate.status === "succeeded" &&
            candidate.workspaceKey === workspace.workspaceKey &&
            candidate.repositoryId === publication.repositoryId,
        )
        .at(-1);
      repository = task?.deploymentSnapshot?.repository ?? null;
    }
    const policy = repository?.publicationPolicy;
    if (!repository || !policy?.permissions.includes("create-change-request")) {
      throw new Error("CHANGE_REQUEST_NOT_ALLOWED");
    }
    const snapshot = publication.executionSnapshot;
    const credentialGrantRef = snapshot?.credentialRef;
    if (!snapshot || !credentialGrantRef) throw new Error("CHANGE_REQUEST_CREDENTIAL_UNAVAILABLE");
    return this.changeRequests.createOrReuse(
      {
        workItemId,
        workAttemptId: publication.workAttemptId,
        publicationId: publication.publicationId,
        ownerWorkerId: publication.ownerWorkerId,
        repositoryIdentity:
          publication.repositoryId +
          "@" +
          (publication.repositoryIdentityRevision ?? publication.publicationPolicyRevision),
        repositoryUrl: snapshot.repositoryUrl,
        headBranch: publication.branchName,
        headCommit: publication.commitSha,
        baseBranch: snapshot.defaultBranch,
        title: work.title,
        body:
          "Created by Team Skill Hub Work Orchestration.\n\n" +
          "Work Item: " +
          workItemId +
          "\nPublication: " +
          publication.publicationId +
          "\nCommit: " +
          publication.commitSha,
        idempotencyKey: "publication:" + publication.publicationId,
        credentialGrantRef,
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
    target?: WorkDagDeliveryTarget,
  ): WorkDetail {
    if (!this.publications) throw new Error("PUBLICATION_STORE_UNAVAILABLE");
    const work = this.workStore.getWork(workItemId, principalId, scope);
    const publication = this.publications.getPublication(publicationId);
    if (publication.workItemId !== workItemId) throw new Error("PUBLICATION_WORK_MISMATCH");
    const expectedSubject = target
      ? (this.workStore.listDagResourceSubjects(workItemId)[target.resourceKey] ?? null)
      : work.currentSubjectRevision;
    if (
      (target?.repositoryId && publication.repositoryId !== target.repositoryId) ||
      expectedSubject !== publication.sourceSubjectRevision
    ) {
      if (["preparing", "prepared", "approved", "pushing"].includes(publication.state)) {
        this.publications.transitionPublication(
          publicationId,
          "blocked",
          {
            lastErrorCode: "PUBLICATION_SOURCE_STALE",
            lastErrorContext: expectedSubject ?? "missing_current_subject",
          },
          now,
        );
      }
      throw new Error("PUBLICATION_SOURCE_STALE");
    }
    const artifact = this.publications.getPublicationArtifact(publicationId);
    if (!artifact) throw new Error("PUBLICATION_ARTIFACT_NOT_PREPARED");
    if (target) {
      return this.detail(workItemId, principalId, scope);
    }
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
    if (detail.reviewTask && (detail.reviewTask.status === "queued" || detail.reviewTask.status === "running")) {
      this.tasks.cancel(detail.reviewTask.taskId, principalId, scope);
    }
    if (detail.work.orchestrationEngine === "dynamic-dag") {
      const publicationCancellation = this.publications?.cancelForWork(workItemId, now) ?? {
        cancelledPublicationIds: [],
        outcomeUnknownPublicationIds: [],
      };
      const changeRequestCancellation = this.changeRequests?.cancelForWork(workItemId, now) ?? {
        cancelledChangeRequestIds: [],
        outcomeUnknownChangeRequestIds: [],
      };
      if (
        publicationCancellation.outcomeUnknownPublicationIds.length > 0 ||
        changeRequestCancellation.outcomeUnknownChangeRequestIds.length > 0
      ) {
        const dagRevision =
          detail.work.currentDagRevision > 0
            ? this.workStore.getDagRevision(workItemId, detail.work.currentDagRevision)
            : null;
        const nodes = new Map(dagRevision?.graph.nodes.map((node) => [node.id, node]) ?? []);
        const executions = this.workStore.listDagExecutions(workItemId);
        const latest = new Map<string, (typeof executions)[number]>();
        for (const execution of executions) {
          const previous = latest.get(execution.nodeId);
          if (!previous || previous.generation < execution.generation) {
            latest.set(execution.nodeId, execution);
          }
        }
        const markUnknown = (
          kind: "publication" | "change_request",
          capability: string,
          subject: string | null,
          externalRef: string,
          reason: string,
        ) => {
          const candidate = [...latest.values()].find((execution) => {
            if (execution.state !== "running" && execution.state !== "claimed") return false;
            const node = nodes.get(execution.nodeId);
            return (
              node?.kind === kind && node.capability === capability && (subject === null || node.subject === subject)
            );
          });
          if (candidate) {
            this.workStore.markDagExecutionOutcomeUnknown(candidate.nodeExecutionId, externalRef, reason, now);
          }
        };

        for (const publicationId of publicationCancellation.outcomeUnknownPublicationIds) {
          const publication = this.publications!.getPublication(publicationId);
          markUnknown(
            "publication",
            "push",
            publication.sourceSubjectRevision,
            "publication:" + publicationId,
            "Work was cancelled while publication push was in flight; reconcile the remote branch outcome.",
          );
        }
        for (const changeRequestId of changeRequestCancellation.outcomeUnknownChangeRequestIds) {
          const request = this.changeRequests!.get(changeRequestId);
          const publication = this.publications?.getPublication(request.publicationId);
          markUnknown(
            "change_request",
            "create",
            publication?.sourceSubjectRevision ?? null,
            "change-request:" + changeRequestId,
            "Work was cancelled while change-request creation was in flight; reconcile the remote provider outcome.",
          );
        }
      }
    }
    if (detail.work.orchestrationEngine === "dynamic-dag") {
      for (const execution of this.workStore.listDagExecutions(workItemId)) {
        if (!["pending", "claimed", "running"].includes(execution.state)) continue;
        const ref = execution.externalRef;
        if (!ref) continue;
        let task: TaskRecord | null = null;
        if (ref.startsWith("expert-task:")) {
          try {
            task = this.tasks.get(ref.slice("expert-task:".length), principalId, scope);
          } catch {
            task = null;
          }
        } else if (ref.startsWith("expert-task-key:")) {
          task = this.tasks.getByIdempotency(principalId, scope, ref.slice("expert-task-key:".length));
        }
        if (task && (task.status === "queued" || task.status === "running")) {
          this.tasks.cancel(task.taskId, principalId, scope);
        }
      }
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
    if (detail.work.orchestrationEngine === "dynamic-dag") {
      this.workStore.cancelDagExecutions(workItemId, now);
      this.workStore.cancelDagWaits(workItemId, now);
    }
    return this.detail(workItemId, principalId, scope);
  }

  private startAttempt(
    work: WorkItemRecord,
    reason: WorkAttemptReason,
    parentWorkAttemptId: string | null,
    now: number,
    audit: { reviewContext?: string; whatShouldChange?: string; createdBy?: string } = {},
    fence?: WorkOrchestrationFence,
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
      requiredWorkspaceAccess: requiredWorkspaceAccessForWorkflow(workflow),
      preferredBackend: preferredBackendForWork(work),
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
        ...(audit.reviewContext ? { reviewContext: audit.reviewContext } : {}),
        ...(audit.whatShouldChange ? { whatShouldChange: audit.whatShouldChange } : {}),
        ...(audit.createdBy ? { createdBy: audit.createdBy } : {}),
        dispatchBinding: resolved as unknown as Record<string, unknown>,
      },
      now,
      fence,
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
        requiredWorkspaceAccess: requiredWorkspaceAccessForWorkflow(
          this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion),
        ),
        preferredBackend: preferredBackendForWork(work),
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

    const workflow = this.workStore.getWorkflow(attempt.workflowId, attempt.workflowVersion);
    const validationSnapshot = effectiveVerificationSteps(workflow, resolved);
    const workspace = this.ensureWorkspace(work.workItemId, attempt, resolved, Date.now());
    attempt = this.workStore.getWorkAttempt(attempt.workAttemptId);

    const task = this.dispatch.submitResolved(
      {
        principalId: work.principalId,
        scope: work.scope,
        idempotencyKey: `work:${work.workItemId}:attempt:${attempt.sequence}`,
        sourceClient: "work_orchestrator",
        problem: workAttemptExecutionProblem(work, attempt),
        expertId: resolved.expertId,
        selectionMode: "explicit",
        repositoryId: resolved.repositoryId,
        deploymentId: resolved.deploymentId,
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workflowId: attempt.workflowId,
        workflowVersion: attempt.workflowVersion,
        workspaceKey: workspace.workspaceKey,
        validationSnapshot,
      },
      resolved,
    );
    return this.workStore.linkAttemptTask(attempt.workAttemptId, task.taskId);
  }

  private dispatchReviewTask(
    work: WorkItemRecord,
    attempt: WorkAttemptRecord,
    reviewerExpertId: string,
    now: number,
  ): WorkAttemptRecord {
    if (!attempt.workspaceId) throw new Error("WORKSPACE_NOT_FOUND");
    const workspace = this.workStore.getWorkspace(attempt.workspaceId);
    if (!workspace.ownerWorkerId || !workspace.path || ["removed", "failed"].includes(workspace.state)) {
      throw new Error("WORKSPACE_OWNER_UNAVAILABLE");
    }
    const resolved = this.dispatch.resolve({
      principalId: work.principalId,
      scope: work.scope,
      problem: work.description,
      expertId: reviewerExpertId,
      selectionMode: "explicit",
      repositoryId: work.repositoryId ?? undefined,
      requiredWorkspaceAccess: "read-only",
      preferredBackend: preferredBackendForWork(work),
    });
    if (
      !resolved.runtimeProfile ||
      resolveRuntimeProfilePolicy(resolved.runtimeProfile).workspaceAccess !== "read-only"
    ) {
      throw new Error("RUNTIME_PROFILE_MISMATCH: review requires read-only runtime");
    }
    const task = this.dispatch.submitResolved(
      {
        principalId: work.principalId,
        scope: work.scope,
        idempotencyKey: `work:${work.workItemId}:attempt:${attempt.sequence}:review`,
        sourceClient: "work_orchestrator_review",
        problem:
          "Perform an independent code review of the current workspace changes for this work item. Do not modify files. " +
          "Review correctness, regressions, tests, maintainability, and requirement coverage. " +
          'Return ONLY JSON: {"decision":"accepted"|"rework","reason":"..."}. ' +
          "Use rework when any blocking issue remains.\n\nOriginal work:\n" +
          work.description,
        expertId: resolved.expertId,
        selectionMode: "explicit",
        repositoryId: resolved.repositoryId,
        deploymentId: resolved.deploymentId,
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workflowId: attempt.workflowId,
        workflowVersion: attempt.workflowVersion,
        workspaceKey: workspace.workspaceKey,
        validationSnapshot: [],
      },
      resolved,
    );
    this.tasks.requireWorker(task.taskId, workspace.ownerWorkerId);
    return this.workStore.linkAttemptReviewTask(attempt.workAttemptId, task.taskId);
  }

  private reconcileAgentReview(
    work: WorkItemRecord,
    attempt: WorkAttemptRecord,
    reviewTask: TaskRecord,
    now: number,
    fence?: WorkOrchestrationFence,
  ): WorkDetail {
    if (reviewTask.status === "queued" || reviewTask.status === "running")
      return this.detail(work.workItemId, work.principalId, work.scope);
    if (reviewTask.status === "failed" || reviewTask.status === "cancelled") {
      const current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
      if (current.status !== "blocked") {
        this.workStore.blockWork(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          "review_unavailable",
          reviewTask.result ?? "AGENT_REVIEW_FAILED",
          now,
          { resumeCondition: "manual", blockedByType: "review", blockedByRef: reviewTask.taskId },
          fence,
        );
      }
      return this.detail(work.workItemId, work.principalId, work.scope);
    }
    let review: { decision: "accepted" | "rework"; reason?: string };
    try {
      review = parseAgentReviewResult(reviewTask.result);
    } catch (error) {
      const current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
      if (current.status !== "blocked") {
        this.workStore.blockWork(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          "review_invalid",
          error instanceof Error ? error.message : "AGENT_REVIEW_RESULT_INVALID",
          now,
          { resumeCondition: "manual", blockedByType: "review", blockedByRef: reviewTask.taskId },
          fence,
        );
      }
      return this.detail(work.workItemId, work.principalId, work.scope);
    }
    let current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
    if (!current.currentSubjectRevision) throw new Error("WORK_SUBJECT_REQUIRED");
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
        fence,
      );
    }
    current = this.workStore.getWork(current.workItemId, current.principalId, current.scope);
    return this.submitReview(
      current.workItemId,
      current.principalId,
      current.scope,
      {
        expectedRevision: current.stateRevision,
        subjectRevision: current.currentSubjectRevision!,
        decision: review.decision,
        ...(review.reason ? { reason: review.reason } : {}),
        actorPrincipalId: `agent:${reviewTask.expertId}`,
      },
      now,
    );
  }

  private handleDispatchFailure(
    workItemId: string,
    principalId: string,
    scope: string,
    error: unknown,
    now: number,
    fence?: WorkOrchestrationFence,
    preservePendingAction = false,
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
        { ...blockerMetadata(blocker, current), preserveNextAction: preservePendingAction },
        fence,
      );
    }
    return this.detail(workItemId, principalId, scope);
  }

  private reconcilePublicationLifecycle(
    work: WorkItemRecord,
    now: number,
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
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
            fence,
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
          fence,
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
    if (publication.state === "prepared" && workflow.definition.publication?.approvalRequired === false) {
      publication = this.publications.transitionPublication(publication.publicationId, "approved", {}, now);
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

    if (workflow.definition.completion.require.includes("change_request_created") && this.changeRequests) {
      let changeRequest = this.changeRequests.getByPublication(publication.publicationId);
      if (!changeRequest) {
        const attempt = this.workStore
          .listAttempts(work.workItemId)
          .find((item) => item.workAttemptId === publication!.workAttemptId);
        const resolved = attempt?.dispatchBinding ? asResolvedDispatch(attempt.dispatchBinding) : null;
        const repository = resolved?.deploymentSnapshot?.repository;
        const policy = repository?.publicationPolicy;
        if (policy?.permissions.includes("create-change-request")) {
          const snapshot = publication.executionSnapshot;
          const credentialGrantRef = snapshot?.credentialRef;
          if (!snapshot || !credentialGrantRef) {
            const current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
            if (current.status !== "blocked") {
              return this.workStore.blockWork(
                current.workItemId,
                current.principalId,
                current.scope,
                current.stateRevision,
                "publication_blocked",
                "CHANGE_REQUEST_CREDENTIAL_UNAVAILABLE",
                now,
                {
                  resumeCondition: "manual",
                  blockedByType: "change_request",
                  blockedByRef: publication.publicationId,
                },
                fence,
              );
            }
            return current;
          }
          changeRequest = this.changeRequests.createOrReuse(
            {
              workItemId: work.workItemId,
              workAttemptId: publication.workAttemptId,
              publicationId: publication.publicationId,
              ownerWorkerId: publication.ownerWorkerId,
              repositoryIdentity:
                publication.repositoryId +
                "@" +
                (publication.repositoryIdentityRevision ?? publication.publicationPolicyRevision),
              repositoryUrl: snapshot.repositoryUrl,
              headBranch: publication.branchName,
              headCommit: publication.commitSha,
              baseBranch: snapshot.defaultBranch,
              title: work.title,
              body:
                "Created by Team Skill Hub Work Orchestration.\n\n" +
                "Work Item: " +
                work.workItemId +
                "\nPublication: " +
                publication.publicationId +
                "\nCommit: " +
                publication.commitSha,
              idempotencyKey: "publication:" + publication.publicationId,
              credentialGrantRef,
            },
            now,
          );
        }
      }

      if (changeRequest?.state === "blocked") {
        const current = this.workStore.getWork(work.workItemId, work.principalId, work.scope);
        if (current.status !== "blocked") {
          return this.workStore.blockWork(
            current.workItemId,
            current.principalId,
            current.scope,
            current.stateRevision,
            "publication_blocked",
            changeRequest.lastErrorCode ?? "CHANGE_REQUEST_CREATE_FAILED",
            now,
            {
              resumeCondition: "manual",
              blockedByType: "change_request",
              blockedByRef: changeRequest.changeRequestId,
            },
            fence,
          );
        }
        return current;
      }

      if (
        changeRequest?.state === "created" &&
        changeRequest.provider &&
        changeRequest.externalId &&
        changeRequest.url
      ) {
        const artifactRef = "change-request:" + changeRequest.provider + ":" + changeRequest.externalId;
        const hasChangeRequestEvidence = this.workStore
          .listEvidence(work.workItemId)
          .some(
            (evidence) =>
              !evidence.stale &&
              evidence.type === "pull_request" &&
              evidence.status === "passed" &&
              evidence.subjectRevision === publicationSubject &&
              evidence.artifactRef === artifactRef,
          );
        if (!hasChangeRequestEvidence) {
          this.workStore.recordEvidence(
            work.workItemId,
            work.principalId,
            work.scope,
            {
              workAttemptId: publication.workAttemptId,
              type: "pull_request",
              status: "passed",
              source: "external_verified",
              summary: changeRequest.url,
              artifactRef,
              subjectRevision: publicationSubject,
              environmentIdentity: changeRequest.provider,
              verifierIdentity: "team-skill-hub-change-request",
            },
            now,
          );
        }
      }
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
        fence,
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
    fence?: WorkOrchestrationFence,
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
        fence,
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
      const environmentFailure = task.validationSnapshot
        .map((step) => verificationByStep.get(step.id))
        .find(
          (verification) =>
            verification?.status === "failed" &&
            (verification.exitCode === 127 || verification.errorCode === "VERIFICATION_PROCESS_FAILED"),
        );
      if (environmentFailure) {
        const context =
          environmentFailure.exitCode === 127
            ? `${environmentFailure.stepId}:VERIFICATION_EXIT_127`
            : `${environmentFailure.stepId}:${environmentFailure.errorCode}`;
        this.workStore.blockWork(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          "verification_environment",
          context,
          now,
          {
            resumeCondition: "manual",
            blockedByType: "verification",
            blockedByRef: environmentFailure.stepId,
          },
          fence,
        );
        return this.detail(current.workItemId, current.principalId, current.scope);
      }
      return this.requestContinuation(
        current.workItemId,
        current.principalId,
        current.scope,
        "verification_failed",
        now,
        fence,
      );
    }
    current = this.workStore.getWork(current.workItemId, current.principalId, current.scope);
    const evidenceGate = this.workStore.evaluateCompletionGate(current.workItemId, current.principalId, current.scope);
    const missingRequiredEvidence = evidenceGate.missing.filter((item) => item.startsWith("required_evidence:"));
    if (missingRequiredEvidence.length > 0) {
      this.workStore.blockWork(
        current.workItemId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "verification_required",
        missingRequiredEvidence.join(","),
        now,
        {
          resumeCondition: "verification_evidence",
          blockedByType: "verification",
          blockedByRef: attempt.workAttemptId,
        },
        fence,
      );
      return this.detail(current.workItemId, current.principalId, current.scope);
    }
    current = this.workStore.getWork(current.workItemId, current.principalId, current.scope);
    const workflow = this.workStore.getWorkflow(current.workflowId, current.workflowVersion);
    if (workflow.definition.review.required && workflow.definition.review.reviewerExpertId) {
      try {
        this.dispatchReviewTask(current, attempt, workflow.definition.review.reviewerExpertId, now);
        return this.detail(current.workItemId, current.principalId, current.scope);
      } catch (error) {
        const blocked = this.handleDispatchFailure(
          current.workItemId,
          current.principalId,
          current.scope,
          error,
          now,
          fence,
        );
        if (blocked) return blocked;
        throw error;
      }
    }
    if (current.activeWorkAttemptId === attempt.workAttemptId) {
      current = this.workStore.finishWorkAttempt(
        current.workItemId,
        attempt.workAttemptId,
        current.principalId,
        current.scope,
        current.stateRevision,
        "succeeded",
        workflow.definition.review.required ? "waiting_review" : "running",
        now,
        fence,
      );
    }
    if (!workflow.definition.review.required) {
      const gate = this.workStore.evaluateCompletionGate(current.workItemId, current.principalId, current.scope);
      if (gate.ready && !TERMINAL_WORK.has(current.status)) {
        current = this.workStore.transitionWork(
          current.workItemId,
          current.principalId,
          current.scope,
          current.stateRevision,
          "completed",
          now,
          fence,
        );
        this.workStore.requestTerminalWorkspaceCleanup(current.workItemId, now);
      }
    }
    return this.detail(current.workItemId, current.principalId, current.scope);
  }
  private reconcileFailed(
    work: WorkItemRecord,
    attempt: WorkAttemptRecord,
    task: TaskRecord,
    now: number,
    fence?: WorkOrchestrationFence,
  ): WorkDetail {
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
          fence,
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
          this.workStore.scheduleNextAction(current.workItemId, current.stateRevision, null, null, now, null, fence);
        }
        return this.detail(current.workItemId, current.principalId, current.scope);
      }
      const retryIndex = Math.max(0, runCount - 1);
      const backoff = Math.min(
        workflow.definition.lifecycle.retry.failure.initialBackoffMs * 2 ** retryIndex,
        workflow.definition.lifecycle.retry.failure.maxBackoffMs,
      );
      this.workStore.scheduleNextAction(
        current.workItemId,
        current.stateRevision,
        "failure_retry",
        now + backoff,
        now,
        null,
        fence,
      );
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
        fence,
      );
      this.workStore.requestTerminalWorkspaceCleanup(current.workItemId, now);
    }
    return this.detail(current.workItemId, current.principalId, current.scope);
  }

  private refreshShadowProjection(workItemId: string, now = Date.now()): void {
    try {
      this.shadowProjector.reconcile(workItemId, now);
    } catch (error) {
      // Phase A projection is deliberately non-authoritative: projection failure must never alter
      // existing Work/Attempt/Task behavior. Keep only a bounded diagnostic code.
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
          ? error.message
          : "SHADOW_DAG_RECONCILE_FAILED";
      console.error(JSON.stringify({ event: "work_dag.shadow_reconcile_failed", workItemId, code }));
    }
  }

  private orchestrationFence(epoch: number, now: number): WorkOrchestrationFence {
    return { ownerId: this.orchestrationOwnerId, epoch, now };
  }

  private detail(workItemId: string, principalId: string, scope: string): WorkDetail {
    this.refreshShadowProjection(workItemId);
    const work = this.workStore.getWork(workItemId, principalId, scope);
    const attempts = this.workStore.listAttempts(workItemId);
    const latest = attempts.at(-1);
    const currentTask = latest?.taskId ? this.tasks.get(latest.taskId, principalId, scope) : null;
    const reviewTask = latest?.reviewTaskId ? this.tasks.get(latest.reviewTaskId, principalId, scope) : null;
    const turns = currentTask ? this.tasks.listRunTurns(currentTask.taskId, principalId, scope) : [];
    const workspace = latest?.workspaceId ? this.workStore.getWorkspace(latest.workspaceId) : null;
    const workflow = this.workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const verificationResults = currentTask?.verificationResults ?? [];
    const approvals = this.workStore.listApprovals(workItemId);
    const publicationRecord = this.publications?.listPublications(workItemId).at(-1) ?? null;
    const changeRequestRecord = publicationRecord
      ? (this.changeRequests?.getByPublication(publicationRecord.publicationId) ?? null)
      : null;
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
    const changeRequest = changeRequestRecord
      ? {
          changeRequestId: changeRequestRecord.changeRequestId,
          publicationId: changeRequestRecord.publicationId,
          state: changeRequestRecord.state,
          provider: changeRequestRecord.provider,
          externalId: changeRequestRecord.externalId,
          url: changeRequestRecord.url,
          headBranch: changeRequestRecord.headBranch,
          headCommit: changeRequestRecord.headCommit,
          baseBranch: changeRequestRecord.baseBranch,
          retryCount: changeRequestRecord.retryCount,
          nextAttemptAt: changeRequestRecord.nextAttemptAt,
          lastErrorCode: changeRequestRecord.lastErrorCode,
        }
      : null;
    const dagEvidence = work.orchestrationEngine === "dynamic-dag" ? this.workStore.listDagEvidence(workItemId) : [];
    const dagContext = work.orchestrationEngine === "dynamic-dag" ? this.workStore.getDagContext(workItemId) : null;
    const dag =
      work.orchestrationEngine === "dynamic-dag"
        ? {
            currentRevision: work.currentDagRevision,
            requirementRevision: work.currentRequirementRevision,
            revision:
              work.currentDagRevision > 0 ? this.workStore.getDagRevision(workItemId, work.currentDagRevision) : null,
            revisions: this.workStore.listDagRevisions(workItemId),
            requirementSnapshot:
              work.currentRequirementRevision > 0
                ? this.workStore.getRequirementSnapshot(workItemId, work.currentRequirementRevision)
                : null,
            replanRequests: this.workStore.listDagReplanRequests(workItemId),
            proposals: this.workStore.listDagProposals(workItemId),
            executions: this.workStore.listDagExecutions(workItemId),
            facts: this.workStore.listDagFacts(workItemId),
            evidence: dagEvidence,
            evidenceView: dagEvidence.map((evidence) => ({
              ...evidence,
              stale:
                dagContext?.evidence.find(
                  (item) =>
                    item.type === evidence.type &&
                    item.subject === evidence.subjectRevision &&
                    (item.resource ?? null) === evidence.resourceIdentity &&
                    item.passed === evidence.passed &&
                    item.createdAt === evidence.createdAt,
                )?.stale ?? true,
            })),
            artifacts: this.workStore.listDagArtifacts(workItemId),
            waits: this.workStore.listDagWaits(workItemId),
            lateResults: this.workStore.listDagLateResults(workItemId),
            decisions: this.workStore.listDagDecisions(workItemId),
            completion: this.workStore.evaluateDagCompletion(workItemId),
            shadow: this.workStore.getShadowDag(workItemId),
          }
        : null;
    const gate: CompletionGateResult = dag
      ? {
          ready: dag.completion.ready,
          missing: [...dag.completion.missing],
          workflowId: work.workflowId,
          workflowVersion: work.workflowVersion,
          subjectRevision: work.currentSubjectRevision,
        }
      : this.workStore.evaluateCompletionGate(workItemId, principalId, scope);

    return {
      work,
      attempts,
      evidence: this.workStore.listEvidence(workItemId),
      sourceObservations: this.workStore.listSourceObservations(workItemId),
      currentTask,
      reviewTask,
      turns,
      workspace,
      verification: {
        requiredEvidence: this.workStore.getEffectiveRequiredEvidence(workItemId),
        requiredSteps: currentTask?.validationSnapshot ?? workflow.definition.validation.required,
        results: verificationResults,
        passed: verificationResults.filter((item) => item.status === "passed").length,
        failed: verificationResults.filter((item) => item.status === "failed").length,
      },
      gate,
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
      dag,
      publication,
      changeRequest,
    };
  }
}
