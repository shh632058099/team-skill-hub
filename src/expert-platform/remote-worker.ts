import type { Claim } from "./task-store.js";

export type WorkerExecutionResult = {
  result: string;
  source?: { repositoryUrl?: string; repositoryBranch?: string; commitSha?: string };
};

export interface RemoteWorkerClient {
  claimTask(workerId: string, expertId: string, capability: string): Promise<Claim | null>;
  renewLease(claim: Claim): Promise<unknown>;
  completeTask(claim: Claim, result: string, source?: WorkerExecutionResult["source"]): Promise<unknown>;
  failTask(claim: Claim, reason: string): Promise<unknown>;
}

export interface RemoteWorkerOptions {
  heartbeatMs?: number;
  expertId?: string;
}

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
      execution = await executor(claim, controller.signal);
    } catch (error) {
      if (leaseLost) throw leaseLost;
      if (cancellationRequested && error instanceof Error && error.message === "CODEX_CANCELLED") {
        await client.failTask(claim, "TASK_CANCELLED");
        return true;
      }
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      const errorCode = message.split(/[:\\s]/, 1)[0] ?? "UNKNOWN_ERROR";
      console.error(
        JSON.stringify({
          event: "expert_worker.execution_failed",
          taskId: claim.taskId,
          expertId,
          errorCode: /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : "UNCLASSIFIED",
        }),
      );
      await client.failTask(claim, "EXECUTION_FAILED");
      return true;
    }
    if (leaseLost) throw leaseLost;
    if (cancellationRequested) {
      await client.failTask(claim, "TASK_CANCELLED");
      return true;
    }
    const result = typeof execution === "string" ? execution : execution.result;
    const source = typeof execution === "string" ? undefined : execution.source;
    await client.completeTask(claim, result, source);
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}
