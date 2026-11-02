import assert from "node:assert/strict";
import { test } from "node:test";
import { runExpertWorkerLoop } from "../src/expert-platform/worker-runtime.js";

test("worker runtime polls repeatedly and stops on abort", async () => {
  let calls = 0;
  const controller = new AbortController();
  const result = runExpertWorkerLoop(
    async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return false;
    },
    { pollMs: 5, signal: controller.signal },
  );
  await result;
  assert.equal(calls, 2);
});

test("worker runtime continues after an idle poll", async () => {
  let calls = 0;
  const controller = new AbortController();
  await runExpertWorkerLoop(
    async () => {
      calls += 1;
      if (calls === 3) controller.abort();
      return calls === 2;
    },
    { pollMs: 5, signal: controller.signal },
  );
  assert.equal(calls, 3);
});
