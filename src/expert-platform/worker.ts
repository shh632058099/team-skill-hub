import type { ExpertTaskStore, Claim } from "./task-store.js";

/**
 * Runs one already queued task with an injected, separately authorized executor.
 * This coordinator deliberately does not spawn arbitrary commands or bypass the Sandbox.
 * The caller must authenticate the worker before invoking it.
 */
export async function executeClaimedTask(
  store: ExpertTaskStore,
  workerId: string,
  executor: (claim: Claim) => Promise<string>,
): Promise<boolean> {
  if (!workerId.trim()) throw new Error("INVALID_WORKER");
  const claim = store.claim(workerId);
  if (!claim) return false;
  try {
    const result = await executor(claim);
    store.complete(claim, result);
  } catch (error) {
    if (error instanceof Error && error.message === "STALE_ATTEMPT") throw error;
    store.fail(claim, "EXECUTION_FAILED");
  }
  return true;
}
