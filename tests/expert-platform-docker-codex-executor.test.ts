import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerCodexExecutor } from "../src/expert-platform/docker-codex-executor.js";
import type { Claim } from "../src/expert-platform/task-store.js";

const claim: Claim = {
  workerId: "worker-1",
  taskId: "task-1",
  runId: "run-1",
  fencing: 1,
  problem: "Investigate OTA failure",
};

test("Docker Codex executor runs codex JSONL through docker with read-only source", async () => {
  let seen: { executable: string; args: readonly string[]; signal?: AbortSignal } | undefined;
  const executor = createDockerCodexExecutor({
    image: "team-skill-hub-expert-worker-prototype",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: ["OPENAI_API_KEY"],
    timeoutMs: 1000,
    runProcess: async (options) => {
      seen = options;
      return "container result";
    },
  });
  const signal = new AbortController().signal;
  assert.equal(await executor(claim, signal), "container result");
  assert.equal(seen?.executable, "docker");
  assert.ok(seen?.args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(seen?.args.includes("team-skill-hub-expert-worker-prototype"));
  assert.ok(seen?.args.includes("OPENAI_API_KEY"));
  assert.ok(seen?.args.includes("--json"));
  assert.equal(seen?.args.at(-1), claim.problem);
  assert.equal(seen?.signal, signal);
});
