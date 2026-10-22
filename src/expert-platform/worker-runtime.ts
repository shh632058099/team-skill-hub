export interface WorkerLoopOptions {
  pollMs: number;
  signal: AbortSignal;
}

export async function runExpertWorkerLoop(runOnce: () => Promise<boolean>, options: WorkerLoopOptions): Promise<void> {
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error("INVALID_WORKER_CONFIG");
  }

  while (!options.signal.aborted) {
    let handled = false;
    try {
      handled = await runOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      const errorCode = message.split(/[: ]/, 1)[0] ?? "UNKNOWN_ERROR";
      console.error(
        JSON.stringify({
          event: "expert_worker.poll_failed",
          errorCode: /^[A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : "UNCLASSIFIED",
        }),
      );
    }
    if (options.signal.aborted) break;
    if (!handled) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, options.pollMs);
        options.signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
}
