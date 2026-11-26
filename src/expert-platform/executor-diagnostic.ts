import { sanitizeModelOutputPreview } from "./execution-activity.js";

export type ExecutorDiagnosticBackend = "claude" | "codex" | "generic";

export interface ExecutorFailureDiagnostic {
  errorCode: string;
  backend: ExecutorDiagnosticBackend;
  exitCode?: number;
  httpStatus?: number;
  requestId?: string;
  endpointHost?: string;
  message?: string;
  retryable?: boolean;
  retryAttempt?: number;
  maxAttempts?: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.trim()) ? value.trim() : null;
}

function safeBackend(value: unknown): ExecutorDiagnosticBackend | null {
  return value === "claude" || value === "codex" || value === "generic" ? value : null;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized) ? normalized : undefined;
}

function safeEndpointHost(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.hostname || undefined;
  } catch {
    const normalized = value.trim().toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(normalized) ? normalized : undefined;
  }
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

export function modelFailureDiagnostic(
  raw: unknown,
  backend: Exclude<ExecutorDiagnosticBackend, "generic">,
  errorCode: string,
  exitCode?: number,
): ExecutorFailureDiagnostic {
  const event = object(raw) ?? {};
  const failure = object(event.error) ?? {};
  const response = object(event.response) ?? object(failure.response) ?? {};
  const messageRaw = firstDefined(failure.message, event.message, event.result);
  const status = safeInteger(
    firstDefined(failure.status, failure.status_code, failure.http_status, response.status, event.status),
    100,
    599,
  );
  const requestId = safeRequestId(
    firstDefined(
      failure.request_id,
      failure.requestId,
      response.request_id,
      response.requestId,
      event.request_id,
      event.requestId,
    ),
  );
  const endpointHost = safeEndpointHost(
    firstDefined(
      failure.url,
      failure.endpoint,
      failure.request_url,
      response.url,
      event.url,
      event.endpoint,
      event.request_url,
    ),
  );
  const message =
    typeof messageRaw === "string" && messageRaw.trim() ? sanitizeModelOutputPreview(messageRaw, 500) : undefined;
  return {
    errorCode,
    backend,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(requestId ? { requestId } : {}),
    ...(endpointHost ? { endpointHost } : {}),
    ...(message ? { message } : {}),
  };
}

export function normalizeExecutorFailureDiagnostic(
  raw: unknown,
  expectedErrorCode?: string,
): ExecutorFailureDiagnostic | null {
  const value = object(raw);
  if (!value) return null;
  const errorCode = safeCode(value.errorCode);
  const backend = safeBackend(value.backend);
  if (!errorCode || !backend || (expectedErrorCode && errorCode !== expectedErrorCode)) return null;
  const exitCode = safeInteger(value.exitCode, 0, 255);
  const httpStatus = safeInteger(value.httpStatus, 100, 599);
  const requestId = safeRequestId(value.requestId);
  const endpointHost = safeEndpointHost(value.endpointHost);
  const message =
    typeof value.message === "string" && value.message.trim()
      ? sanitizeModelOutputPreview(value.message, 500)
      : undefined;
  const retryable = typeof value.retryable === "boolean" ? value.retryable : undefined;
  const retryAttempt = safeInteger(value.retryAttempt, 1, 100);
  const maxAttempts = safeInteger(value.maxAttempts, 1, 100);
  return {
    errorCode,
    backend,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(requestId ? { requestId } : {}),
    ...(endpointHost ? { endpointHost } : {}),
    ...(message ? { message } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(retryAttempt === undefined ? {} : { retryAttempt }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

const TRANSIENT_EXECUTOR_FAILURES = new Set([
  "MODEL_REQUEST_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_NETWORK_FAILED",
  "EXECUTOR_TIMEOUT",
  "CLAUDE_PROCESS_EXIT_NONZERO",
  "CODEX_PROCESS_EXIT_NONZERO",
]);

export function isTransientExecutorFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const diagnostic = executorFailureDiagnostic(error);
  const code = diagnostic?.errorCode ?? error.message.trim().split(/[:\s]/, 1)[0] ?? "";
  if (!TRANSIENT_EXECUTOR_FAILURES.has(code)) return false;
  if (diagnostic?.httpStatus !== undefined) {
    return diagnostic.httpStatus === 408 || diagnostic.httpStatus === 429 || diagnostic.httpStatus >= 500;
  }
  return true;
}

export class ExecutorFailureError extends Error {
  readonly diagnostic: ExecutorFailureDiagnostic;

  constructor(errorCode: string, diagnostic: ExecutorFailureDiagnostic) {
    super(errorCode);
    this.name = "ExecutorFailureError";
    this.diagnostic = diagnostic;
  }
}

export function executorFailureDiagnostic(error: unknown): ExecutorFailureDiagnostic | undefined {
  if (!(error instanceof Error)) return undefined;
  return (
    normalizeExecutorFailureDiagnostic((error as Error & { diagnostic?: unknown }).diagnostic, error.message) ??
    undefined
  );
}
