export interface WorkerLoopOptions {
  pollMs: number;
  signal: AbortSignal;
}

export async function runExpertWorkerLoop(runOnce: () => Promise<boolean>, options: WorkerLoopOptions): Promise<void> {
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error("INVALID_WORKER_CONFIG");
  }

  while (!options.signal.aborted) {
    const handled = await runOnce();
    if (options.signal.aborted) break;
    if (!handled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
