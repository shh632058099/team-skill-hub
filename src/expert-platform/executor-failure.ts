export type ExecutorFailureDisposition = "transient" | "timeout" | "non_retryable";

const TRANSIENT_EXECUTOR_FAILURES = new Set([
  "MODEL_REQUEST_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_NETWORK_FAILED",
  "NETWORK_CONNECTION_FAILED",
  "PROXY_CONNECTION_FAILED",
  "EXECUTOR_PROCESS_FAILED",
]);

const TIMEOUT_EXECUTOR_FAILURES = new Set(["EXECUTOR_TIMEOUT", "EXECUTOR_IDLE_TIMEOUT"]);

const NON_RETRYABLE_EXECUTOR_FAILURES = new Set([
  "EXECUTOR_OUTPUT_LIMIT",
  "AUTHENTICATION_FAILED",
  "MODEL_ACCESS_DENIED",
  "MODEL_NOT_FOUND",
  "MODEL_QUOTA_EXCEEDED",
  "SANDBOX_INIT_FAILED",
  "DOCKER_IMAGE_UNAVAILABLE",
  "DISK_FULL",
  "DOCKER_MOUNT_PERMISSION",
  "DOCKER_CONFIG_PERMISSION",
  "DOCKER_SOCKET_PERMISSION",
  "READ_ONLY_FILESYSTEM",
  "FILE_ACCESS_DENIED",
  "PERMISSION_DENIED",
  "EXPERT_STREAM_INVALID",
  "PUBLICATION_SOURCE_STALE",
  "PUBLICATION_BASE_MISMATCH",
  "PUBLICATION_REPOSITORY_MISMATCH",
  "PUBLICATION_POLICY_MISSING",
  "PUBLICATION_NOT_ALLOWED",
]);

const SAFE_EXECUTOR_FAILURES = new Set([
  ...TRANSIENT_EXECUTOR_FAILURES,
  ...TIMEOUT_EXECUTOR_FAILURES,
  ...NON_RETRYABLE_EXECUTOR_FAILURES,
]);

function firstCode(value: string): string {
  return value.trim().split(/[:\s]/, 1)[0] ?? "";
}

export function safeExecutorFailureCode(value: string): string | null {
  const code = firstCode(value);
  return SAFE_EXECUTOR_FAILURES.has(code) ? code : null;
}

export function executorFailureDisposition(value: string): ExecutorFailureDisposition | null {
  const code = firstCode(value);
  if (TRANSIENT_EXECUTOR_FAILURES.has(code)) return "transient";
  if (TIMEOUT_EXECUTOR_FAILURES.has(code)) return "timeout";
  if (NON_RETRYABLE_EXECUTOR_FAILURES.has(code)) return "non_retryable";
  return null;
}

export function executorRetryDelayMs(generation: number): number {
  const safeGeneration = Number.isSafeInteger(generation) && generation > 0 ? generation : 1;
  return Math.min(30_000, 5_000 * 2 ** Math.min(safeGeneration - 1, 3));
}
