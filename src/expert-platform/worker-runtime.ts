const GRPC_STATUS_NAMES: Record<number, string> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

function workerPollErrorFields(error: unknown): Record<string, string | number> {
  const candidate =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          details?: unknown;
          message?: unknown;
          metadata?: { get?: (key: string) => unknown[] };
        })
      : {};
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const parsed = /^(\d+)\s+([A-Z_]+):?\s*(.*)$/.exec(message);
  const grpcCode = typeof candidate.code === "number" ? candidate.code : parsed ? Number(parsed[1]) : undefined;
  const grpcStatus = grpcCode === undefined ? undefined : GRPC_STATUS_NAMES[grpcCode];
  const metadataGet =
    typeof candidate.metadata?.get === "function" ? candidate.metadata.get.bind(candidate.metadata) : undefined;
  const metadataReason = String(metadataGet?.("x-expert-error-code")?.[0] ?? "");
  const rawHint = metadataGet?.("x-expert-error-hint-bin")?.[0];
  const metadataHint = Buffer.isBuffer(rawHint) ? rawHint.toString("utf8") : "";
  // Only trust explicitly structured Hub metadata and validate its shape before logging it.
  const reasonCode = /^[A-Z][A-Z0-9_]{1,79}$/.test(metadataReason) ? metadataReason : undefined;
  const diagnosis = metadataHint.length > 0 && metadataHint.length <= 500 ? metadataHint : undefined;
  const fields: Record<string, string | number> = {};
  if (grpcCode !== undefined) fields.errorCode = String(grpcCode);
  else {
    const fallback = message.split(/[: ]/, 1)[0] ?? "UNKNOWN_ERROR";
    fields.errorCode = /^[A-Z0-9_]{1,80}$/.test(fallback) ? fallback : "UNCLASSIFIED";
  }
  if (grpcStatus) fields.grpcStatus = grpcStatus;
  if (reasonCode) fields.reasonCode = reasonCode;
  if (reasonCode && diagnosis) fields.diagnosis = diagnosis;
  return fields;
}

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
      console.error(
        JSON.stringify({
          event: "expert_worker.poll_failed",
          ...workerPollErrorFields(error),
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
