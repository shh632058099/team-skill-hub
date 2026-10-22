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

test("completion persists structured source repository URL, branch, and commit metadata", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-source-metadata-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const store = new ExpertTaskStore(file);
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "source-meta",
      problem: "inspect ota",
    });
    const claim = store.claim("worker-1", 100, 30_000);
    assert.ok(claim);
    const report =
      "Source repository: https://github.com/example/ota.git\nBranch: release\nCommit: abcdef0123456789abcdef0123456789abcdef01\n\nVerified report";
    store.complete(claim!, report, 101);
    const result = store.get(task.taskId, "alice", "team-a");
    assert.equal(result.repositoryUrl, "https://github.com/example/ota.git");
    assert.equal(result.repositoryBranch, "release");
    assert.equal(result.commitSha, "abcdef0123456789abcdef0123456789abcdef01");
    assert.equal(result.result, report);
    store.close();
    const reopened = new ExpertTaskStore(file);
    const persisted = reopened.get(task.taskId, "alice", "team-a");
    assert.equal(persisted.commitSha, "abcdef0123456789abcdef0123456789abcdef01");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired lease marks the prior run expired before reclaim and fences its late completion", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-expired-run-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const store = new ExpertTaskStore(file);
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "lease-reclaim",
      problem: "inspect ota",
    });
    const first = store.claim("worker-1", 100, 10);
    assert.ok(first);
    assert.equal(store.claim("worker-2", 110, 10), null, "lease is valid through its expiry timestamp");
    const second = store.claim("worker-2", 111, 10);
    assert.ok(second);
    const db = new DatabaseSync(file);
    const previous = db.prepare("SELECT status FROM expert_runs WHERE run_id=?").get(first!.runId) as {
      status: string;
    };
    assert.equal(previous.status, "expired");
    db.close();
    assert.throws(() => store.complete(first!, "late result", 112), /STALE_ATTEMPT/);
    store.complete(second!, "current result", 113);
    assert.equal(store.get(task.taskId, "alice", "team-a").result, "current result");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired or superseded claims cannot renew or fail a reclaimed task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-stale-ops-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "stale-ops",
      problem: "inspect ota",
    });
    const first = store.claim("worker-1", 100, 10);
    assert.ok(first);
    assert.throws(() => store.renew(first!, 111, 10), /STALE_ATTEMPT/);
    const second = store.claim("worker-2", 111, 10);
    assert.ok(second);
    assert.throws(() => store.renew(first!, 112, 10), /STALE_ATTEMPT/);
    assert.throws(() => store.fail(first!, "late failure", 112), /STALE_ATTEMPT/);
    store.complete(second!, "current result", 113);
    assert.equal(store.get(task.taskId, "alice", "team-a").status, "succeeded");
    assert.equal(store.get(task.taskId, "alice", "team-a").result, "current result");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running task cancellation is requested then acknowledged by its worker", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-running-cancel-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "running-cancel",
      problem: "inspect ota",
    });
    const claim = store.claim("worker-1", 100, 10_000);
    assert.ok(claim);
    const result = store.cancel(task.taskId, "alice", "team-a");
    assert.equal(result.status, "running");
    assert.equal(result.cancellationRequested, true);
    assert.equal(store.renew(claim!, 101, 10_000), true);
    assert.throws(() => store.complete(claim!, "late result", 102), /STALE_ATTEMPT/);
    store.fail(claim!, "TASK_CANCELLED", 102);
    assert.equal(store.get(task.taskId, "alice", "team-a").status, "cancelled");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
