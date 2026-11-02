import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexExecutor } from "../src/expert-platform/codex-executor.js";
import type { Claim } from "../src/expert-platform/task-store.js";

const claim: Claim = {
  workerId: "worker-1",
  taskId: "task-1",
  runId: "run-1",
  fencing: 1,
  problem: "Investigate OTA failure",
};

test("Codex executor passes read-only arguments and abort signal to process runner", async () => {
  let seen: { executable: string; args: readonly string[]; signal?: AbortSignal } | undefined;
  const executor = createCodexExecutor({
    executable: "/usr/bin/codex",
    timeoutMs: 1000,
    runProcess: async (options) => {
      seen = options;
      return "analysis result";
    },
  });
  const controller = new AbortController();
  assert.equal(await executor(claim, controller.signal), "analysis result");
  assert.equal(seen?.executable, "/usr/bin/codex");
  assert.deepEqual(seen?.args.slice(0, 5), ["exec", "--sandbox", "read-only", "--ephemeral", "--json"]);
  assert.equal(seen?.args.at(-1), claim.problem);
  assert.equal(seen?.signal, controller.signal);
});

test("Codex executor rejects empty or oversized task prompts", async () => {
  const executor = createCodexExecutor({
    executable: "codex",
    timeoutMs: 1000,
    runProcess: async () => "unused",
  });
  await assert.rejects(() => executor({ ...claim, problem: " " }, new AbortController().signal), /INVALID_REQUEST/);
});
