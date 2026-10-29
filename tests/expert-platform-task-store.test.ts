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

test("admin task history and bounded per-run stages reject stale workers and unsafe details", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-run-log-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.db"));
    const task = store.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "event",
      problem: "investigate OTA",
      expertId: "ota",
    });
    const first = store.claim("worker-a", 100, 10, "ota")!;
    assert.equal(store.adminTasks({ status: "running", expertId: "ota" }).total, 1);
    store.recordStage(first, "repository.started", "", 101);
    store.recordStage(first, "repository.completed", "", 102);
    assert.throws(() => store.recordStage(first, "codex.started", "Bearer secret", 103), /INVALID_STAGE_EVENT/);
    assert.throws(() => store.recordStage(first, "invalid.event", "", 103), /INVALID_STAGE_EVENT/);
    const second = store.claim("worker-b", 111, 10, "ota")!;
    assert.throws(() => store.recordStage(first, "codex.started", "", 112), /STALE_ATTEMPT/);
    store.recordStage(second, "codex.started", "", 112);
    store.recordStage(second, "codex.failed", "EXECUTION_FAILED", 113);
    store.fail(second, "EXECUTION_FAILED", 114);
    const detail = store.adminTaskDetail(task.taskId)!;
    assert.equal(detail.runs.length, 2);
    assert.ok(Object.prototype.hasOwnProperty.call(detail.task, "source_session_id"));
    assert.ok(Object.prototype.hasOwnProperty.call(detail.task, "source_client"));
    assert.ok(detail.events.some((event) => (event as any).event_type === "lease_expired"));
    assert.ok(
      detail.events.some(
        (event) => (event as any).event_type === "codex.failed" && (event as any).run_id === second.runId,
      ),
    );
    assert.equal(store.adminTasks({ status: "failed" }).total, 1);
    assert.equal(store.adminTasks({ workerId: "worker-b" }).total, 1);
    assert.equal(store.adminTasks({ q: task.taskId }).total, 1);
    assert.equal(store.adminTaskDetail("missing"), null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-session expert queue reuses identical active work and serializes different tasks across workers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-session-queue-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const common = {
      principalId: "alice",
      scope: "tenant-a",
      sourceClient: "codex",
      sourceSessionId: "session-1",
      expertId: "ota",
    };
    const a = store.submit({ ...common, idempotencyKey: "a", problem: "check OTA state machine" });
    const duplicate = store.submit({ ...common, idempotencyKey: "b", problem: "check OTA state machine" });
    assert.equal(duplicate.taskId, a.taskId);
    const b = store.submit({ ...common, idempotencyKey: "c", problem: "inspect rollback conditions" });
    assert.notEqual(a.taskId, b.taskId);
    const runA = store.claim("worker-1", 100, 1000, "ota")!;
    assert.equal(runA.taskId, a.taskId);
    assert.equal(store.claim("worker-2", 101, 1000, "ota"), null);
    store.complete(runA, "first report", 102);
    const runB = store.claim("worker-2", 103, 1000, "ota")!;
    assert.equal(runB.taskId, b.taskId);
    store.fail(runB, "FAILED", 104);
    assert.equal(store.get(b.taskId, "alice", "tenant-a").status, "failed");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session queue isolation, cancellation, and expired lease remain safe", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-session-isolation-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const base = {
      principalId: "alice",
      scope: "tenant-a",
      sourceClient: "codex",
      sourceSessionId: "session-1",
      expertId: "ota",
    };
    const a = store.submit({ ...base, idempotencyKey: "a", problem: "first" });
    const b = store.submit({ ...base, idempotencyKey: "b", problem: "second" });
    const otherSession = store.submit({
      ...base,
      sourceSessionId: "session-2",
      idempotencyKey: "c",
      problem: "independent",
    });
    const otherExpert = store.submit({
      ...base,
      expertId: "review",
      idempotencyKey: "d",
      problem: "independent expert",
    });
    const runA = store.claim("worker-a", 100, 10, "ota")!;
    assert.equal(runA.taskId, a.taskId);
    const parallel = store.claim("worker-b", 105, 10, "ota")!;
    assert.equal(parallel.taskId, otherSession.taskId);
    assert.equal(store.claim("worker-c", 106, 10, "ota"), null);
    assert.equal(store.claim("worker-d", 106, 10, "review")?.taskId, otherExpert.taskId);
    const reclaimA = store.claim("worker-e", 111, 10, "ota")!;
    assert.equal(reclaimA.taskId, a.taskId);
    assert.equal(store.claim("worker-f", 112, 10, "ota"), null);
    store.cancel(a.taskId, "alice", "tenant-a");
    store.fail(reclaimA, "TASK_CANCELLED", 113);
    assert.equal(store.claim("worker-f", 114, 10, "ota")?.taskId, b.taskId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy tasks without source session continue to claim independently", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-no-session-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const a = store.submit({
      principalId: "alice",
      scope: "tenant",
      expertId: "ota",
      idempotencyKey: "a",
      problem: "first",
    });
    const b = store.submit({
      principalId: "alice",
      scope: "tenant",
      expertId: "ota",
      idempotencyKey: "b",
      problem: "second",
    });
    assert.equal(store.claim("worker-a", 100, 1000, "ota")?.taskId, a.taskId);
    assert.equal(store.claim("worker-b", 101, 1000, "ota")?.taskId, b.taskId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activity events are bounded, deduplicated and owner-cursor scoped", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-activity-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const input = { principalId: "owner", scope: "tenant", idempotencyKey: "progress", problem: "read code" };
    const task = store.submit(input);
    const claim = store.claim("worker", 100, 100000)!;
    store.recordActivity(claim, "model.started", 1, "", 0, 101);
    store.recordActivity(claim, "tool.activity", 2, "Read", 3, 102);
    store.recordActivity(claim, "tool.activity", 2, "Read", 3, 103);
    assert.throws(() => store.recordActivity(claim, "tool.activity", 2, "Read", 4, 104), /PROGRESS_SEQUENCE_CONFLICT/);
    assert.throws(() => store.ownerEvents(task.taskId, "other", "tenant"), /TASK_NOT_FOUND_OR_FORBIDDEN/);
    const first = store.ownerEvents(task.taskId, "owner", "tenant", 0, 4);
    assert.equal(first.events.length, 4);
    assert.equal(first.hasMore, false);
    assert.equal(first.events[3]?.type, "tool.activity");
    assert.equal(first.events[3]?.tool, "Read");
    assert.equal(first.events[3]?.count, 3);
    for (let i = 3; i < 160; i++) store.recordActivity(claim, "model.active", i, "", 0, 105 + i);
    store.recordStage(claim, "execution.completed", "", 300);
    store.complete(claim, "result", 301);
    const all = store.ownerEvents(task.taskId, "owner", "tenant", 0, 100);
    assert.equal(all.events.length, 100);
    const later = store.ownerEvents(task.taskId, "owner", "tenant", all.nextEventId, 100);
    assert.ok(later.events.some((event) => event.type === "execution.completed"));
    assert.ok(later.events.some((event) => event.type === "succeeded"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
