import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";

test("idempotent submissions preserve task identity and reject changed input", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.db"));
    const first = store.submit({ principalId: "alice", scope: "team-a", idempotencyKey: "k1", problem: "OTA failed" });
    const again = store.submit({ principalId: "alice", scope: "team-a", idempotencyKey: "k1", problem: "OTA failed" });
    assert.equal(first.taskId, again.taskId);
    assert.throws(
      () => store.submit({ principalId: "alice", scope: "team-a", idempotencyKey: "k1", problem: "Other failure" }),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.notEqual(
      store.submit({ principalId: "bob", scope: "team-a", idempotencyKey: "k1", problem: "OTA failed" }).taskId,
      first.taskId,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim uses fencing and stale workers cannot complete the task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.db"));
    const task = store.submit({ principalId: "alice", scope: "team-a", idempotencyKey: "k1", problem: "OTA failed" });
    const first = store.claim("worker-1", 100, 10);
    assert.equal(first?.taskId, task.taskId);
    assert.equal(store.claim("worker-2", 105, 10), null);
    const second = store.claim("worker-2", 111, 10);
    assert.ok(second);
    assert.notEqual(second.runId, first?.runId);
    assert.throws(() => store.complete(first!, "old result", 112), /STALE_ATTEMPT/);
    store.complete(second!, "root cause", 113);
    assert.equal(store.get(task.taskId, "alice", "team-a").result, "root cause");
    assert.throws(() => store.get(task.taskId, "bob", "team-a"), /TASK_NOT_FOUND_OR_FORBIDDEN/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tasks survive reopen; cancelling queued work blocks claims", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-"));
  const file = path.join(dir, "runtime.db");
  try {
    const first = new ExpertTaskStore(file);
    const task = first.submit({ principalId: "alice", scope: "team-a", idempotencyKey: "k1", problem: "OTA failed" });
    first.close();
    const second = new ExpertTaskStore(file);
    assert.equal(second.get(task.taskId, "alice", "team-a").status, "queued");
    second.cancel(task.taskId, "alice", "team-a");
    assert.equal(second.claim("worker", 100), null);
    assert.equal(second.get(task.taskId, "alice", "team-a").status, "cancelled");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a legacy task database migrates expert routing columns in place", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-migration-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE expert_tasks (
        task_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        problem TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        run_id TEXT,
        worker_id TEXT,
        lease_until INTEGER,
        fencing INTEGER NOT NULL DEFAULT 0,
        UNIQUE(principal_id, scope, idempotency_key)
      );
    `);
    legacy.close();

    const store = new ExpertTaskStore(file);
    const task = store.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "migrated",
      problem: "inspect ota",
      expertId: "ota",
      repositoryId: "ota-repo",
      selectionMode: "auto",
      schemaVersion: 1,
    });
    assert.equal(task.expertId, "ota");
    assert.equal(task.repositoryId, "ota-repo");
    assert.equal(task.selectionMode, "auto");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
