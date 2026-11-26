import type { Claim } from "./task-store.js";
import type { VerificationEvidenceResult } from "./verification-policy.js";
import type { WorkspaceChangeSummary } from "./workspace-change-summary.js";
import { agentFailureReason, type AgentExecutionOutcome } from "./agent-execution-outcome.js";
import { safeExecutorFailureCode } from "./executor-failure.js";
import { executorFailureDiagnostic, type ExecutorFailureDiagnostic } from "./executor-diagnostic.js";
import type { PublicationOperationLease, PublicationOperationResult } from "./work-publication-store.js";
import type { ChangeRequestOperationLease, ChangeRequestOperationResult } from "./work-change-request-store.js";

export type WorkerExecutionResult = {
  result: string;
  source?: { repositoryUrl?: string; repositoryBranch?: string; commitSha?: string };
  verificationResults?: VerificationEvidenceResult[];
  workspaceChangeSummary?: WorkspaceChangeSummary;
  runtimeSessionId?: string;
  executionOutcome?: AgentExecutionOutcome;
};

export type WorkspaceCleanupLease = {
  workspaceId: string;
  workspaceKey: string;
  ownerWorkerId: string;
  fencing: number;
};

export interface RemoteWorkerClient {
  claimPublicationOperation?(workerId: string): Promise<PublicationOperationLease | null>;
  completePublicationOperation?(claim: PublicationOperationLease, result: PublicationOperationResult): Promise<unknown>;
  claimChangeRequestOperation?(workerId: string): Promise<ChangeRequestOperationLease | null>;
  completeChangeRequestOperation?(
    claim: ChangeRequestOperationLease,
    result: ChangeRequestOperationResult,
  ): Promise<unknown>;
  claimWorkspaceCleanup?(workerId: string): Promise<WorkspaceCleanupLease | null>;
  completeWorkspaceCleanup?(claim: WorkspaceCleanupLease, success: boolean, errorCode?: string): Promise<unknown>;
  claimTask(workerId: string, expertId: string, capability: string): Promise<Claim | null>;
  renewLease(claim: Claim): Promise<unknown>;
  completeTask(
    claim: Claim,
    result: string,
    source?: WorkerExecutionResult["source"],
    verificationResults?: VerificationEvidenceResult[],
    workspaceChangeSummary?: WorkspaceChangeSummary,
    runtimeSessionId?: string,
  ): Promise<unknown>;
  failTask(claim: Claim, reason: string, diagnostic?: ExecutorFailureDiagnostic): Promise<unknown>;
  reportTaskStage?(claim: Claim, stage: string, details?: string): Promise<unknown>;
}
export interface RemoteWorkerOptions {
  heartbeatMs?: number;
  expertId?: string;
}

// Only these fixed, non-secret codes may cross the Worker -> Hub failure boundary.
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
export async function runRemoteWorkerOnce(
  client: RemoteWorkerClient,
  workerId: string,
  capability: string,
  executor: (claim: Claim, signal: AbortSignal) => Promise<string | WorkerExecutionResult>,
  options: RemoteWorkerOptions = {},
): Promise<boolean> {
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  if (!workerId.trim() || !capability.trim() || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new Error("INVALID_WORKER");
  }
  const expertId = options.expertId?.trim() || capability;
  const claim = await client.claimTask(workerId, expertId, capability);
  if (!claim) return false;

  const stage = async (name: string, details = "") => {
    if (!client.reportTaskStage) return;
    try {
      await client.reportTaskStage(claim, name, details);
    } catch {
      /* Diagnostics are best-effort and must not turn success into failure. */
    }
  };
  const controller = new AbortController();
  let leaseLost: Error | undefined;
  let cancellationRequested = false;
  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void client
      .renewLease(claim)
      .then((response) => {
        if (
          response &&
          typeof response === "object" &&
          "cancellation_requested" in response &&
          response.cancellation_requested === true
        ) {
          cancellationRequested = true;
          controller.abort();
        }
      })
      .catch(() => {
        if (!leaseLost) {
          leaseLost = new Error("WORKER_LEASE_LOST");
          controller.abort();
        }
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatMs);

  try {
    let execution: string | WorkerExecutionResult;
    try {
      await stage("execution.started");
      execution = await executor(claim, controller.signal);
      await stage("execution.completed");
    } catch (error) {
      if (leaseLost) throw leaseLost;
      if (
        cancellationRequested &&
        error instanceof Error &&
        (error.message === "EXECUTOR_CANCELLED" || error.message === "CODEX_CANCELLED")
      ) {
        await stage("execution.failed", "TASK_CANCELLED");
        await client.failTask(claim, "TASK_CANCELLED");
        return true;
      }
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      const errorCode = message.split(/[:\s]/, 1)[0] ?? "UNKNOWN_ERROR";
      const safeExecutorCode = safeExecutorFailureCode(message);
      const forwardedCode = DETERMINISTIC_WORKSPACE_ERRORS.has(errorCode)
        ? errorCode
        : (safeExecutorCode ?? "EXECUTION_FAILED");
      await stage("execution.failed", forwardedCode);
      console.error(
        JSON.stringify({
          event: "expert_worker.execution_failed",
          taskId: claim.taskId,
          expertId,
          errorCode: /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : "UNCLASSIFIED",
        }),
      );
      await client.failTask(claim, forwardedCode, executorFailureDiagnostic(error));
      return true;
    }
    if (leaseLost) throw leaseLost;
    if (cancellationRequested) {
      await client.failTask(claim, "TASK_CANCELLED");
      return true;
    }
    const result = typeof execution === "string" ? execution : execution.result;
    const source = typeof execution === "string" ? undefined : execution.source;
    const verificationResults = typeof execution === "string" ? undefined : execution.verificationResults;
    const workspaceChangeSummary = typeof execution === "string" ? undefined : execution.workspaceChangeSummary;
    const runtimeSessionId = typeof execution === "string" ? undefined : execution.runtimeSessionId;
    const executionOutcome = typeof execution === "string" ? undefined : execution.executionOutcome;
    if (executionOutcome && executionOutcome.status !== "succeeded") {
      await client.failTask(claim, agentFailureReason(result, executionOutcome));
      return true;
    }
    await client.completeTask(claim, result, source, verificationResults, workspaceChangeSummary, runtimeSessionId);
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}
