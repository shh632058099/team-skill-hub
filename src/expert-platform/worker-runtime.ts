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

const WORKER_ERROR_DIAGNOSES: Record<string, string> = {
  WORKER_EXPERT_CAPABILITY_MISMATCH:
    "Expert 配置的 capabilities 不包含该 Worker 的 EXPERT_CAPABILITY；请对比 Admin 专家配置与 Worker instance 配置。",
  WORKER_FORBIDDEN: "Worker 未获授权使用当前 capability；请检查 Admin 中 Worker 的审批状态和注册 capabilities。",
  WORKER_IDENTITY_MISMATCH:
    "请求中的 Worker ID 与 credential 对应身份不一致；请检查 EXPERT_WORKER_ID 和该 instance 使用的 credential。",
  EXPERT_NOT_FOUND: "Worker 配置的 EXPERT_ID 在 Hub 中不存在；请核对 Worker instance 配置和 Admin 中的 Expert ID。",
  EXPERT_INACTIVE: "Worker 配置的 Expert 已停用；请在 Admin 中启用该 Expert，或改用已启用的 Expert。",
  WORKER_UNAUTHENTICATED: "Worker 身份认证失败；请检查审批/吊销状态以及该 instance 的 credential 文件。",
};

function workerPollErrorFields(error: unknown): Record<string, string | number> {
  const candidate =
    error && typeof error === "object" ? (error as { code?: unknown; details?: unknown; message?: unknown }) : {};
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const parsed = /^(\d+)\s+([A-Z_]+):?\s*(.*)$/.exec(message);
  const grpcCode = typeof candidate.code === "number" ? candidate.code : parsed ? Number(parsed[1]) : undefined;
  const grpcStatus = grpcCode === undefined ? undefined : GRPC_STATUS_NAMES[grpcCode];
  const rawDetails = typeof candidate.details === "string" ? candidate.details : (parsed?.[3] ?? "");
  // Only expose known Hub business reasons; never print arbitrary server details or endpoints.
  const reasonCode =
    /^[A-Z][A-Z0-9_]{1,79}$/.test(rawDetails) && WORKER_ERROR_DIAGNOSES[rawDetails] ? rawDetails : undefined;
  const fields: Record<string, string | number> = {};
  if (grpcCode !== undefined) fields.errorCode = String(grpcCode);
  else {
    const fallback = message.split(/[: ]/, 1)[0] ?? "UNKNOWN_ERROR";
    fields.errorCode = /^[A-Z0-9_]{1,80}$/.test(fallback) ? fallback : "UNCLASSIFIED";
  }
  if (grpcStatus) fields.grpcStatus = grpcStatus;
  if (reasonCode) {
    fields.reasonCode = reasonCode;
    fields.diagnosis = WORKER_ERROR_DIAGNOSES[reasonCode]!;
  }
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
