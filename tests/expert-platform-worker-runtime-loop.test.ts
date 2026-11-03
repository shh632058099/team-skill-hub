import assert from "node:assert/strict";
import { test } from "node:test";
import { runExpertWorkerLoop } from "../src/expert-platform/worker-runtime.js";

test("worker loop retries transient Hub connection failures without exposing error details", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const stop = setTimeout(() => controller.abort(), 35);

  try {
    await runExpertWorkerLoop(
      async () => {
        attempts += 1;
        throw new Error("14 UNAVAILABLE: private endpoint detail");
      },
      { pollMs: 5, signal: controller.signal },
    );
  } finally {
    clearTimeout(stop);
    console.error = originalError;
  }

  assert.ok(attempts >= 2, "worker should retry after transient connection failures");
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((line) => line.includes("expert_worker.poll_failed")));
  assert.ok(logs.every((line) => line.includes('"errorCode":"14"')));
  assert.ok(logs.every((line) => !line.includes("private endpoint detail")));
});

test("worker loop exits promptly when aborted during retry backoff", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const running = runExpertWorkerLoop(
    async () => {
      attempts += 1;
      throw new Error("14 UNAVAILABLE");
    },
    { pollMs: 10_000, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await running;
  assert.equal(attempts, 1);
});

test("worker loop logs actionable Hub reason for permission denied without leaking arbitrary details", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const stop = setTimeout(() => controller.abort(), 12);

  try {
    await runExpertWorkerLoop(
      async () => {
        const error = new Error("7 PERMISSION_DENIED: WORKER_EXPERT_CAPABILITY_MISMATCH") as Error & {
          code: number;
          details: string;
        };
        error.code = 7;
        error.details = "WORKER_EXPERT_CAPABILITY_MISMATCH";
        throw error;
      },
      { pollMs: 5, signal: controller.signal },
    );
  } finally {
    clearTimeout(stop);
    console.error = originalError;
  }

  assert.ok(logs.length >= 1);
  assert.ok(logs.every((line) => line.includes('"grpcStatus":"PERMISSION_DENIED"')));
  assert.ok(logs.every((line) => line.includes('"reasonCode":"WORKER_EXPERT_CAPABILITY_MISMATCH"')));
  assert.ok(logs.every((line) => line.includes("Expert 配置的 capabilities 不包含该 Worker 的 EXPERT_CAPABILITY")));
  assert.ok(logs.every((line) => !line.includes("private endpoint detail")));
});

test("worker loop does not expose unknown server details in poll failure logs", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const stop = setTimeout(() => controller.abort(), 12);

  try {
    await runExpertWorkerLoop(
      async () => {
        const error = new Error("7 PERMISSION_DENIED: internal-secret-or-private-detail") as Error & {
          code: number;
          details: string;
        };
        error.code = 7;
        error.details = "internal-secret-or-private-detail";
        throw error;
      },
      { pollMs: 5, signal: controller.signal },
    );
  } finally {
    clearTimeout(stop);
    console.error = originalError;
  }

  assert.ok(logs.length >= 1);
  assert.ok(logs.every((line) => line.includes('"grpcStatus":"PERMISSION_DENIED"')));
  assert.ok(logs.every((line) => !line.includes("internal-secret-or-private-detail")));
});
