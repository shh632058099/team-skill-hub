import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runReadOnlyDiagnostic } from "../src/expert-platform/diagnostic-executor.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { executeClaimedTask } from "../src/expert-platform/worker.js";

test("queued task executes through real read-only Docker container and persists its result", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "expert-docker-flow-"));
  try {
    const store = new ExpertTaskStore(path.join(directory, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "test",
      idempotencyKey: "docker-flow",
      problem: "check runtime",
    });
    const executed = await executeClaimedTask(store, "test-worker", () =>
      runReadOnlyDiagnostic({ sourcePath: path.resolve("."), operation: "node-version" }),
    );
    assert.equal(executed, true);
    const result = store.get(task.taskId, "alice", "test");
    assert.equal(result.status, "succeeded");
    assert.match(result.result ?? "", /^v24\./);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
