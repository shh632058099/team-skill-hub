import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";

test("worker heartbeat extends lease and expired claim cannot finish", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-lease-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "db.sqlite"));
    store.submit({ principalId: "alice", scope: "a", problem: "check OTA", idempotencyKey: "k" });
    const claim = store.claim("worker-1", 100, 10)!;
    store.renew(claim, 105, 10);
    assert.equal(store.claim("worker-2", 112, 10), null);
    assert.throws(() => store.renew(claim, 116, 10), /STALE_ATTEMPT/);
    const next = store.claim("worker-2", 116, 10)!;
    assert.throws(() => store.complete(claim, "stale", 116), /STALE_ATTEMPT/);
    store.complete(next, "valid", 117);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("failing current attempt records failed result while preserving authorization", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-fail-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "db.sqlite"));
    const task = store.submit({ principalId: "alice", scope: "a", problem: "check OTA", idempotencyKey: "k" });
    const claim = store.claim("worker-1", 100, 10)!;
    store.fail(claim, "SANDBOX_FAILED", 101);
    assert.equal(store.get(task.taskId, "alice", "a").status, "failed");
    assert.equal(store.claim("worker-2", 102), null);
    assert.throws(() => store.fail(claim, "again", 102), /STALE_ATTEMPT/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
