import type { Claim } from "./task-store.js";

export interface RemoteWorkerClient {
  claimTask(workerId: string, expertId: string, capability: string): Promise<Claim | null>;
  renewLease(claim: Claim): Promise<unknown>;
  completeTask(claim: Claim, result: string): Promise<unknown>;
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
  executor: (claim: Claim, signal: AbortSignal) => Promise<string>,
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
  const heartbeat = setInterval(() => {
    void client.renewLease(claim).catch(() => {
      if (!leaseLost) {
        leaseLost = new Error("WORKER_LEASE_LOST");
        controller.abort();
      }
    });
  }, heartbeatMs);

  try {
    let result: string;
    try {
      result = await executor(claim, controller.signal);
    } catch {
      if (leaseLost) throw leaseLost;
      await client.failTask(claim, "EXECUTION_FAILED");
      return true;
    }
    if (leaseLost) throw leaseLost;
    await client.completeTask(claim, result);
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}
