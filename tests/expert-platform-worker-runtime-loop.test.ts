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
