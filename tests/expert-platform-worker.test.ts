import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { executeClaimedTask } from "../src/expert-platform/worker.js";

test("worker coordinator commits successful execution result", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-worker-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "db.sqlite"));
    const task = store.submit({ principalId: "a", scope: "org", problem: "inspect", idempotencyKey: "a" });
    assert.equal(await executeClaimedTask(store, "approved-worker", async () => "verified evidence"), true);
    assert.equal(store.get(task.taskId, "a", "org").result, "verified evidence");
    assert.equal(await executeClaimedTask(store, "approved-worker", async () => "unused"), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker coordinator writes a bounded generic failure instead of leaking exception detail", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-worker-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "db.sqlite"));
    const task = store.submit({ principalId: "a", scope: "org", problem: "inspect", idempotencyKey: "a" });
    await executeClaimedTask(store, "approved-worker", async () => {
      throw new Error("secret=private");
    });
    const outcome = store.get(task.taskId, "a", "org");
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.result, "EXECUTION_FAILED");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
