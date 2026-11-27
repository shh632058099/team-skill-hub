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
    assert.equal(first.reusedExistingTask, false);
    assert.equal(again.reusedExistingTask, true);
    assert.equal(again.deduplicationReason, "idempotency_key");
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

test("workspace permission model selection is durable before owner identity is bound", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-workspace-model-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.db"));
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-model",
      problem: "modify",
      workspaceKey: "work-model-a1",
    });
    const v2Claim = store.claim("v2-worker", 100, 10, undefined, {
      runtimeProfiles: [],
      workspacePermissionModels: ["shared-gid-v1", "single-uid-v2"],
    });
    assert.equal(v2Claim?.taskId, task.taskId);
    assert.equal((v2Claim as any)?.workspacePermissionModel, "single-uid-v2");
    assert.equal((v2Claim as any)?.workspaceOwnerUid, null);
    assert.equal((v2Claim as any)?.workspaceOwnerGid, null);

    let selected = store.getByIdempotency("alice", "team-a", "workspace-model")!;
    assert.equal((selected as any).workspacePermissionModel, "single-uid-v2");
    assert.equal((selected as any).workspaceOwnerUid, null);
    assert.equal((selected as any).workspaceOwnerGid, null);

    assert.equal(
      store.claim("legacy-worker", 111, 10, undefined, {
        runtimeProfiles: [],
        workspacePermissionModels: ["shared-gid-v1"],
      }),
      null,
    );
    const reclaimed = store.claim("v2-worker", 111, 10, undefined, {
      runtimeProfiles: [],
      workspacePermissionModels: ["shared-gid-v1", "single-uid-v2"],
    });
    assert.equal(reclaimed?.taskId, task.taskId);

    store.bindWorkspaceIdentity(task.taskId, "work-model-a1", {
      permissionModel: "single-uid-v2",
      ownerUid: 999,
      ownerGid: 988,
    });
    selected = store.getByIdempotency("alice", "team-a", "workspace-model")!;
    assert.equal((selected as any).workspaceOwnerUid, 999);
    assert.equal((selected as any).workspaceOwnerGid, 988);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task execution kind defaults to agent and verification kind is durable through claim", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-kind-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.db"));
    const agent = store.submit({ principalId: "alice", scope: "team-a", idempotencyKey: "agent", problem: "analyze" });
    assert.equal(agent.executionKind, "agent");
    const verification = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "verify",
      problem: "verify only",
      executionKind: "verification",
    });
    assert.equal(verification.executionKind, "verification");
    const claimedAgent = store.claim("worker", 100, 10)!;
    assert.equal(claimedAgent.executionKind, "agent");
    store.complete(claimedAgent, "done", 101);
    const claimedVerification = store.claim("worker", 102, 10)!;
    assert.equal(claimedVerification.taskId, verification.taskId);
    assert.equal(claimedVerification.executionKind, "verification");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin task history returns creation timestamps newest first", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-time-order-"));
  const file = path.join(dir, "runtime.db");
  try {
    const store = new ExpertTaskStore(file);
    const older = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "older",
      problem: "older task",
    });
    const newer = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "newer",
      problem: "newer task",
    });
    const db = new DatabaseSync(file);
    db.prepare("UPDATE expert_tasks SET created_at=? WHERE task_id=?").run(1_000, older.taskId);
    db.prepare("UPDATE expert_tasks SET created_at=? WHERE task_id=?").run(2_000, newer.taskId);
    db.close();
    const result = store.adminTasks();
    assert.deepEqual(
      result.tasks.map((row: any) => row.task_id),
      [newer.taskId, older.taskId],
    );
    assert.deepEqual(
      result.tasks.map((row: any) => row.created_at),
      [2_000, 1_000],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task event retention keeps the newest 1000 and admin timeline paginates newest-first", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-event-retention-"));
  const file = path.join(dir, "runtime.db");
  try {
    const store = new ExpertTaskStore(file);
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "events",
      problem: "event retention",
    });
    const db = new DatabaseSync(file);
    const insert = db.prepare(
      "INSERT INTO expert_events(task_id,run_id,event_type,details,created_at) VALUES(?,NULL,'test.event','',?)",
    );
    for (let i = 0; i < 1000; i++) insert.run(task.taskId, 10_000 + i);
    db.close();

    // A lifecycle write trims old rows in the same store operation.
    store.cancel(task.taskId, "alice", "team-a");
    const countDetail = store.adminTaskDetail(task.taskId, { limit: 100 });
    assert.ok(countDetail);
    assert.equal(countDetail.eventsPage.total, 1000);
    const latest = store.adminTaskDetail(task.taskId, { limit: 50, offset: 0 });
    assert.ok(latest);
    const ids = latest.events.map((event: any) => Number(event.event_id));
    assert.equal(ids.length, 50);
    assert.ok(ids.every((id: number, index: number) => index === 0 || ids[index - 1]! > id));
    const older = store.adminTaskDetail(task.taskId, { limit: 50, offset: 50 });
    assert.ok(older);
    assert.equal(older.eventsPage.hasNewer, true);
    assert.equal(older.eventsPage.hasOlder, true);
    assert.ok(Number((latest.events[49] as any).event_id) > Number((older.events[0] as any).event_id));
    const oldest = store.adminTaskDetail(task.taskId, { limit: 50, offset: 950 });
    assert.ok(oldest);
    assert.equal(oldest.eventsPage.hasOlder, false);
    assert.equal(oldest.eventsPage.hasNewer, true);
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
        workspace_key TEXT,
        UNIQUE(principal_id, scope, idempotency_key)
      );
      INSERT INTO expert_tasks(task_id,principal_id,scope,idempotency_key,request_digest,problem,status,workspace_key)
        VALUES('legacy-task','legacy-user','org','legacy-key','digest','legacy task','queued','legacy-work-a1');
      INSERT INTO expert_tasks(task_id,principal_id,scope,idempotency_key,request_digest,problem,status,workspace_key)
        VALUES('legacy-readonly','legacy-user','org','legacy-readonly-key','digest-2','legacy readonly task','queued',NULL);
      CREATE TABLE expert_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_id TEXT,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO expert_events(task_id,run_id,event_type,created_at)
        VALUES('legacy-task',NULL,'queued',123456789);
    `);
    legacy.close();

    const store = new ExpertTaskStore(file);
    assert.equal((store.adminTasks({ q: "legacy-task" }).tasks[0] as any).created_at, 123456789);
    const migratedLegacy = store.getByIdempotency("legacy-user", "org", "legacy-key")!;
    assert.equal((migratedLegacy as any).workspacePermissionModel, "shared-gid-v1");
    assert.equal((migratedLegacy as any).workspaceOwnerUid, null);
    assert.equal((migratedLegacy as any).workspaceOwnerGid, null);
    const migratedReadonly = store.getByIdempotency("legacy-user", "org", "legacy-readonly-key")!;
    assert.equal((migratedReadonly as any).workspacePermissionModel, null);
    assert.equal((migratedReadonly as any).workspaceOwnerUid, null);
    assert.equal((migratedReadonly as any).workspaceOwnerGid, null);
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

test("legacy current run migration backfills its reconstructable execution problem", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-run-problem-migration-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(
      [
        "CREATE TABLE expert_tasks (task_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, problem TEXT NOT NULL, status TEXT NOT NULL, result TEXT, run_id TEXT, worker_id TEXT, lease_until INTEGER, fencing INTEGER NOT NULL DEFAULT 0, UNIQUE(principal_id, scope, idempotency_key));",
        "INSERT INTO expert_tasks(task_id,principal_id,scope,idempotency_key,request_digest,problem,status,run_id,worker_id,fencing) VALUES('legacy-running','alice','team','legacy-running-key','digest','legacy running prompt','running','legacy-run','worker-a',1);",
        "CREATE TABLE expert_runs (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, fencing INTEGER NOT NULL, status TEXT NOT NULL);",
        "INSERT INTO expert_runs(run_id,task_id,worker_id,fencing,status) VALUES('legacy-run','legacy-running','worker-a',1,'running');",
        "CREATE TABLE expert_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT, event_type TEXT NOT NULL, created_at INTEGER NOT NULL);",
        "INSERT INTO expert_events(task_id,run_id,event_type,created_at) VALUES('legacy-running','legacy-run','running',123456789);",
      ].join("\n"),
    );
    legacy.close();

    const store = new ExpertTaskStore(file);
    const detail = store.adminTaskDetail("legacy-running")!;
    const run = (detail.runs as Array<{ run_id: string; problem: string | null }>)[0]!;
    assert.equal(run.run_id, "legacy-run");
    assert.equal(run.problem, "legacy running prompt");
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
    const eventIds = detail.events.map((event) => Number((event as any).event_id));
    assert.ok(
      eventIds.every((eventId, index) => index === 0 || eventIds[index - 1]! > eventId),
      "admin task timeline is newest-first",
    );
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
    assert.equal(duplicate.reusedExistingTask, true);
    assert.equal(duplicate.deduplicationReason, "same_active_session_task");
    assert.equal(duplicate.activeSessionTaskId, a.taskId);
    const b = store.submit({ ...common, idempotencyKey: "c", problem: "inspect rollback conditions" });
    assert.notEqual(a.taskId, b.taskId);
    assert.equal(b.reusedExistingTask, false);
    assert.equal(b.activeSessionTaskId, a.taskId);
    assert.equal(b.activeSessionTaskStatus, "queued");
    const runA = store.claim("worker-1", 100, 1000, "ota")!;
    assert.equal(runA.taskId, a.taskId);
    assert.equal(store.claim("worker-2", 101, 1000, "ota"), null);
    const c = store.submit({ ...common, idempotencyKey: "d", problem: "inspect a third OTA issue" });
    assert.equal(c.activeSessionTaskId, a.taskId);
    assert.equal(c.activeSessionTaskStatus, "running");
    store.complete(runA, "first report", 102);
    const runB = store.claim("worker-2", 103, 1000, "ota")!;
    assert.equal(runB.taskId, b.taskId);
    store.fail(runB, "FAILED", 104);
    assert.equal(store.get(b.taskId, "alice", "tenant-a").status, "failed");
    assert.equal(store.claim("worker-3", 105, 1000, "ota")?.taskId, c.taskId);
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

test("failed runs persist admin-only executor diagnostics", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-run-diagnostic-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({ principalId: "owner", scope: "tenant", idempotencyKey: "run-diag", problem: "debug" });
    const claim = store.claim("worker", 100, 100_000)!;
    store.fail(claim, "MODEL_RATE_LIMITED", 110, {
      errorCode: "MODEL_RATE_LIMITED",
      backend: "codex",
      exitCode: 1,
      httpStatus: 429,
      requestId: "req-123",
      endpointHost: "api.example.test",
      message: "rate limited token=[REDACTED]",
      retryable: true,
      retryAttempt: 3,
      maxAttempts: 3,
    });

    const detail = store.adminTaskDetail(task.taskId)!;
    assert.deepEqual((detail.runs as Array<{ diagnostic?: unknown }>)[0]?.diagnostic, {
      errorCode: "MODEL_RATE_LIMITED",
      backend: "codex",
      exitCode: 1,
      httpStatus: 429,
      requestId: "req-123",
      endpointHost: "api.example.test",
      message: "rate limited token=[REDACTED]",
      retryable: true,
      retryAttempt: 3,
      maxAttempts: 3,
    });
    assert.deepEqual(store.latestRunDiagnostic(task.taskId, "owner", "tenant"), {
      errorCode: "MODEL_RATE_LIMITED",
      backend: "codex",
      exitCode: 1,
      httpStatus: 429,
      requestId: "req-123",
      endpointHost: "api.example.test",
      message: "rate limited token=[REDACTED]",
      retryable: true,
      retryAttempt: 3,
      maxAttempts: 3,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call((detail.runs as Array<Record<string, unknown>>)[0] ?? {}, "diagnostic_json"),
      false,
    );
    const ownerEvents = store.ownerEvents(task.taskId, "owner", "tenant", 0, 50);
    assert.doesNotMatch(JSON.stringify(ownerEvents), /req-123|api\.example\.test/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model output activity persists safe diagnostic details for owner reads", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-model-output-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "owner",
      scope: "tenant",
      idempotencyKey: "model-output",
      problem: "debug",
    });
    const claim = store.claim("worker", 100, 100_000)!;

    store.recordActivity(
      claim,
      "model.output",
      1,
      "",
      0,
      101,
      "Investigating retry failure. Authorization: Bearer secret-token",
    );
    store.recordActivity(claim, "model.failed", 2, "", 0, 102, "MODEL_RATE_LIMITED");
    store.recordStage(
      claim,
      "model.retry",
      JSON.stringify({
        errorCode: "MODEL_RATE_LIMITED",
        backend: "codex",
        httpStatus: 429,
        message: "rate limited token=[REDACTED]",
        retryable: true,
        retryAttempt: 1,
        maxAttempts: 3,
      }),
      102,
    );
    store.recordStage(claim, "agent.protocol_warning", "AGENT_OUTCOME_PROTOCOL_MISSING", 103);
    assert.throws(
      () => store.recordActivity(claim, "model.failed", 3, "", 0, 103, "HTTP 429 secret-provider-message"),
      /INVALID_ACTIVITY_EVENT/,
    );

    const events = store.ownerEvents(task.taskId, "owner", "tenant", 0, 20).events;
    assert.equal(
      events.find((event) => event.type === "model.output")?.details,
      "Investigating retry failure. Authorization: Bearer [REDACTED]",
    );
    assert.equal(events.find((event) => event.type === "model.failed")?.details, "MODEL_RATE_LIMITED");
    assert.equal(
      events.find((event) => event.type === "agent.protocol_warning")?.details,
      "AGENT_OUTCOME_PROTOCOL_MISSING",
    );
    assert.deepEqual(JSON.parse(events.find((event) => event.type === "model.retry")?.details ?? "{}"), {
      errorCode: "MODEL_RATE_LIMITED",
      backend: "codex",
      httpStatus: 429,
      message: "rate limited token=[REDACTED]",
      retryable: true,
      retryAttempt: 1,
      maxAttempts: 3,
    });
    assert.doesNotMatch(JSON.stringify(events), /secret-token|secret-provider-message/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run turns are persisted, deduplicated and fenced by the active run", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-run-turns-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({ principalId: "owner", scope: "tenant", idempotencyKey: "turns", problem: "read code" });
    const claim = store.claim("worker", 100, 10_000)!;

    store.recordActivity(claim, "model.started", 1, "", 0, 101);
    store.recordActivity(claim, "model.started", 2, "", 0, 102);
    store.recordActivity(claim, "model.completed", 3, "", 0, 103);
    store.recordActivity(claim, "model.started", 4, "", 0, 104);
    store.recordActivity(claim, "model.failed", 5, "", 0, 105);
    store.recordActivity(claim, "model.failed", 5, "", 0, 106);

    const turns = store.listRunTurns(task.taskId, "owner", "tenant");
    assert.deepEqual(
      turns.map((turn) => ({
        runId: turn.runId,
        turnIndex: turn.turnIndex,
        status: turn.status,
        startSequence: turn.startSequence,
        finishSequence: turn.finishSequence,
      })),
      [
        { runId: claim.runId, turnIndex: 1, status: "succeeded", startSequence: 1, finishSequence: 3 },
        { runId: claim.runId, turnIndex: 2, status: "failed", startSequence: 4, finishSequence: 5 },
      ],
    );

    store.fail(claim, "EXECUTION_FAILED", 110);
    assert.throws(() => store.recordActivity(claim, "model.started", 6, "", 0, 111), /STALE_ATTEMPT/);
    assert.throws(() => store.listRunTurns(task.taskId, "other", "tenant"), /TASK_NOT_FOUND_OR_FORBIDDEN/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source request dedup reuses active auto delegation despite changed problem and idempotency key", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-source-request-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const common = {
      principalId: "alice",
      scope: "tenant-a",
      sourceClient: "claude_code",
      sourceSessionId: "session-1",
      sourceRequestId: "srq_" + "a".repeat(64),
      selectionMode: "auto" as const,
    };
    const first = store.submit({ ...common, idempotencyKey: "first", problem: "locate pipe ring full" });
    const replay = store.submit({ ...common, idempotencyKey: "second", problem: "find OTA pipe writer timeout log" });
    assert.equal(replay.taskId, first.taskId);
    assert.equal(replay.reusedExistingTask, true);
    assert.equal(replay.deduplicationReason, "same_source_request");

    const autoOtherRepository = store.submit({
      ...common,
      repositoryId: "repo-other",
      idempotencyKey: "auto-other-repository",
      problem: "same source request but another repository",
    });
    assert.notEqual(autoOtherRepository.taskId, first.taskId);

    const nextTurn = store.submit({
      ...common,
      sourceRequestId: "srq_" + "b".repeat(64),
      idempotencyKey: "third",
      problem: "same issue, new user turn",
    });
    assert.notEqual(nextTurn.taskId, first.taskId);

    const explicitSameTarget = store.submit({
      ...common,
      selectionMode: "explicit",
      expertId: "ota",
      repositoryId: "repo-1",
      deploymentId: "deployment-1",
      idempotencyKey: "fourth",
      problem: "explicit first wording",
    });
    const explicitSameTargetReplay = store.submit({
      ...common,
      selectionMode: "explicit",
      expertId: "ota",
      repositoryId: "repo-1",
      deploymentId: "deployment-1",
      idempotencyKey: "fourth-replay",
      problem: "explicit rephrased wording",
    });
    assert.equal(explicitSameTargetReplay.taskId, explicitSameTarget.taskId);
    assert.equal(explicitSameTargetReplay.deduplicationReason, "same_source_request");

    const explicitOtherExpert = store.submit({
      ...common,
      selectionMode: "explicit",
      expertId: "code-review",
      idempotencyKey: "sixth",
      problem: "review same issue",
    });
    assert.notEqual(explicitOtherExpert.taskId, first.taskId);

    const explicitOtherRepo = store.submit({
      ...common,
      selectionMode: "explicit",
      expertId: "ota",
      repositoryId: "repo-2",
      idempotencyKey: "fifth",
      problem: "inspect same issue",
    });
    assert.notEqual(explicitOtherRepo.taskId, first.taskId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source request dedup applies only to active tasks; terminal task can be resubmitted", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-source-terminal-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const common = {
      principalId: "alice",
      scope: "tenant-a",
      sourceClient: "claude_code",
      sourceSessionId: "session-1",
      sourceRequestId: "srq_" + "c".repeat(64),
      selectionMode: "auto" as const,
    };
    const first = store.submit({ ...common, idempotencyKey: "first", problem: "inspect OTA" });
    const claim = store.claim("worker-1", Date.now(), 30_000)!;
    store.complete(claim, "done");
    const rerun = store.submit({ ...common, idempotencyKey: "rerun", problem: "inspect OTA again" });
    assert.notEqual(rerun.taskId, first.taskId);
    assert.equal(rerun.reusedExistingTask, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work-linked task metadata survives and failed tasks can create a new run without a new task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-work-link-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "tenant-a",
      idempotencyKey: "work-link-1",
      problem: "inspect OTA",
      expertId: "ota",
      workItemId: "work-1",
      workAttemptId: "attempt-1",
      workflowId: "code-fix-default",
      workflowVersion: 1,
    });
    assert.equal(task.workItemId, "work-1");
    assert.equal(task.workAttemptId, "attempt-1");
    assert.equal(task.workflowId, "code-fix-default");
    assert.equal(task.workflowVersion, 1);

    const firstClaim = store.claim("worker-1", 1_000, 30_000, "ota")!;
    store.fail(firstClaim, "EXECUTION_FAILED", 2_000);
    assert.equal(store.get(task.taskId, "alice", "tenant-a").status, "failed");

    assert.throws(
      () => store.requeueForRetry(task.taskId, "other-attempt", "EXECUTION_FAILED", 3_000),
      /STALE_WORK_ATTEMPT/,
    );
    const queued = store.requeueForRetry(task.taskId, "attempt-1", "EXECUTION_FAILED", 3_000);
    assert.equal(queued.status, "queued");
    assert.equal(queued.taskId, task.taskId);
    assert.equal(queued.workAttemptId, "attempt-1");

    const secondClaim = store.claim("worker-1", 4_000, 30_000, "ota")!;
    assert.equal(secondClaim.taskId, task.taskId);
    assert.notEqual(secondClaim.runId, firstClaim.runId);
    assert.ok(secondClaim.fencing > firstClaim.fencing);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful work task can schedule a fenced continuation on the same task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-continuation-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "tenant",
      idempotencyKey: "continuation",
      problem: "inspect",
      workItemId: "work-1",
      workAttemptId: "attempt-1",
      workflowId: "work-default",
      workflowVersion: 1,
    });
    const first = store.claim("worker-a", 100, 10_000)!;
    store.complete(first, "first result", 200);

    const continued = store.scheduleContinuation(
      task.taskId,
      first.runId,
      "verification_failed",
      300,
      undefined,
      "inspect with RequirementSnapshot revision 2",
    );
    assert.equal(continued.taskId, task.taskId);
    assert.equal(continued.status, "queued");
    assert.equal(continued.result, null);
    assert.equal(continued.continuationCount, 1);
    assert.equal((store.adminTaskDetail(task.taskId)!.task as { problem: string }).problem, "inspect");

    assert.throws(
      () => store.scheduleContinuation(task.taskId, first.runId, "duplicate", 301),
      /TASK_CONTINUATION_NOT_ALLOWED/,
    );

    const second = store.claim("worker-a", 400, 10_000)!;
    assert.equal(second.taskId, task.taskId);
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.fencing, first.fencing + 1);
    assert.match(second.problem, /RequirementSnapshot revision 2/);
    assert.match(second.problem, /verification_failed/);
    const runs = store.adminTaskDetail(task.taskId)!.runs as Array<{ run_id: string; problem: string | null }>;
    assert.equal(runs.find((run) => run.run_id === first.runId)?.problem, "inspect");
    assert.match(runs.find((run) => run.run_id === second.runId)?.problem ?? "", /RequirementSnapshot revision 2/);
    store.complete(second, "second result", 500);

    assert.throws(() => store.scheduleContinuation(task.taskId, first.runId, "stale", 600), /STALE_RUN/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("continuation can be pinned to its workspace owner worker", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-continuation-owner-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "tenant",
      idempotencyKey: "continuation-owner",
      problem: "inspect",
      workItemId: "work-owner",
      workAttemptId: "attempt-owner",
      workflowId: "work-default",
      workflowVersion: 1,
      workspaceKey: "work-owner-a1",
    });
    const first = store.claim("worker-a", 100, 10_000)!;
    store.complete(first, "first result", 200);

    store.scheduleContinuation(task.taskId, first.runId, "verification_failed", 300, "worker-a");
    assert.equal(store.claim("worker-b", 400, 10_000), null);
    const second = store.claim("worker-a", 401, 10_000)!;
    assert.equal(second.taskId, task.taskId);
    assert.equal(second.workerId, "worker-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed task retry preserves required worker affinity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-retry-owner-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "tenant",
      idempotencyKey: "retry-owner",
      problem: "inspect",
      workItemId: "work-owner-retry",
      workAttemptId: "attempt-owner-retry",
      workflowId: "work-default",
      workflowVersion: 1,
      workspaceKey: "work-owner-retry-a1",
    });
    store.requireWorker(task.taskId, "worker-a");
    const first = store.claim("worker-a", 100, 10_000)!;
    store.fail(first, "EXECUTION_FAILED", 200);

    const retried = store.requeueForRetry(task.taskId, "attempt-owner-retry", "EXECUTION_FAILED", 300);
    assert.equal(retried.requiredWorkerId, "worker-a");
    assert.equal(store.claim("worker-b", 400, 10_000), null);
    const second = store.claim("worker-a", 401, 10_000)!;
    assert.equal(second.taskId, task.taskId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime session identity survives process-level continuation and is fenced", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-continuation-session-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "tenant",
      idempotencyKey: "continuation-session",
      problem: "inspect",
      workItemId: "work-session",
      workAttemptId: "attempt-session",
      workflowId: "work-default",
      workflowVersion: 1,
      workspaceKey: "work-session-a1",
    });
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const first = store.claim("worker-a", 100, 10_000)!;
    assert.equal(first.runtimeSessionId ?? null, null);
    store.complete(first, "first result", 200, undefined, undefined, undefined, sessionId);
    assert.equal(store.get(task.taskId, "alice", "tenant").runtimeSessionId, sessionId);

    store.scheduleContinuation(task.taskId, first.runId, "continue", 300, "worker-a");
    const second = store.claim("worker-a", 400, 10_000)!;
    assert.equal(second.runtimeSessionId, sessionId);
    assert.throws(
      () =>
        store.complete(
          second,
          "second result",
          500,
          undefined,
          undefined,
          undefined,
          "66666666-6666-4666-8666-666666666666",
        ),
      /RUNTIME_SESSION_MISMATCH/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone expert tasks keep null work linkage", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-standalone-link-"));
  try {
    const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
    const task = store.submit({
      principalId: "alice",
      scope: "tenant-a",
      idempotencyKey: "standalone-1",
      problem: "legacy standalone task",
    });
    assert.equal(task.workItemId, null);
    assert.equal(task.workAttemptId, null);
    assert.equal(task.workflowId, null);
    assert.equal(task.workflowVersion, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task completion persists revision-bound verification results and rejects mismatched subjects", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-verification-results-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    let store = new ExpertTaskStore(db);
    const task = store.submit({
      principalId: "alice",
      scope: "tenant-a",
      idempotencyKey: "verification-results",
      problem: "verify",
      workItemId: "work-1",
      workAttemptId: "attempt-1",
      workflowId: "verified",
      workflowVersion: 1,
    });
    const first = store.claim("worker-a", 1_000, 30_000)!;
    const result = {
      stepId: "unit",
      type: "command",
      evidenceType: "unit_test",
      status: "passed" as const,
      exitCode: 0,
      durationMs: 25,
      errorCode: null,
      subjectRevision: "a".repeat(40),
      environmentIdentity: "worker:worker-a",
      verifierIdentity: "team-skill-hub-worker",
    };
    assert.throws(
      () => store.complete(first, "done", 2_000, { commitSha: "b".repeat(40) }, [result]),
      /VERIFICATION_SUBJECT_MISMATCH/,
    );

    const second = store.claim("worker-a", 40_000, 30_000)!;
    store.complete(second, "done", 41_000, { commitSha: "a".repeat(40) }, [result]);
    assert.deepEqual(store.get(task.taskId, "alice", "tenant-a").verificationResults, [result]);
    store.close();

    store = new ExpertTaskStore(db);
    assert.deepEqual(store.get(task.taskId, "alice", "tenant-a").verificationResults, [result]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expert task feedback is owner-scoped, success-only, replaceable, and nullable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-task-feedback-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const store = new ExpertTaskStore(file);
    const task = store.submit({
      principalId: "alice",
      scope: "tenant-a",
      idempotencyKey: "feedback-1",
      problem: "inspect OTA feedback flow",
      expertId: "ota",
    });
    assert.equal(store.getFeedback(task.taskId, "alice", "tenant-a"), null, "legacy/unreviewed tasks have no feedback");
    assert.throws(
      () => store.submitFeedback(task.taskId, "alice", "tenant-a", { disposition: "adopted" }),
      /TASK_FEEDBACK_NOT_ALLOWED/,
    );
    const claim = store.claim("worker-1", Date.now(), 30_000, "ota")!;
    store.complete(claim, "done");
    assert.throws(
      () => store.submitFeedback(task.taskId, "bob", "tenant-a", { disposition: "adopted" }),
      /TASK_NOT_FOUND_OR_FORBIDDEN/,
    );
    assert.throws(
      () => store.submitFeedback(task.taskId, "alice", "tenant-b", { disposition: "adopted" }),
      /TASK_NOT_FOUND_OR_FORBIDDEN/,
    );
    const first = store.submitFeedback(
      task.taskId,
      "alice",
      "tenant-a",
      { disposition: "partially_adopted", reason: "需要补验证", needsRework: true },
      1000,
    );
    assert.deepEqual(first, {
      taskId: task.taskId,
      disposition: "partially_adopted",
      reason: "需要补验证",
      needsRework: true,
      updatedAt: 1000,
    });
    const replaced = store.submitFeedback(task.taskId, "alice", "tenant-a", { disposition: "adopted" }, 2000);
    assert.deepEqual(replaced, {
      taskId: task.taskId,
      disposition: "adopted",
      reason: null,
      needsRework: null,
      updatedAt: 2000,
    });
    const db = new DatabaseSync(file);
    assert.equal(
      (db.prepare("SELECT count(*) n FROM expert_task_feedback WHERE task_id=?").get(task.taskId) as any).n,
      1,
    );
    db.close();
    store.adminDeleteTask(task.taskId);
    const afterDelete = new DatabaseSync(file);
    assert.equal(
      (afterDelete.prepare("SELECT count(*) n FROM expert_task_feedback WHERE task_id=?").get(task.taskId) as any).n,
      0,
    );
    afterDelete.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task completion persists workspace change summary and validates verification against workspace revision", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-workspace-summary-persist-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    let store = new ExpertTaskStore(db);
    const task = store.submit({
      principalId: "alice",
      scope: "tenant-a",
      idempotencyKey: "workspace-summary",
      problem: "modify fixture",
      workItemId: "work-write",
      workAttemptId: "attempt-write",
      workflowId: "write-flow",
      workflowVersion: 1,
    });
    const summary = {
      baseCommit: "a".repeat(40),
      changedFiles: ["fixture.txt"],
      addedFiles: ["added.txt"],
      deletedFiles: [],
      diffStat: { filesChanged: 2, insertions: 3, deletions: 1 },
      contentRevision: "c".repeat(64),
    };
    const verification = [
      {
        stepId: "unit",
        type: "command",
        evidenceType: "unit_test",
        status: "passed" as const,
        exitCode: 0,
        durationMs: 20,
        errorCode: null,
        subjectRevision: "workspace:" + summary.contentRevision,
        environmentIdentity: "worker:worker-a",
        verifierIdentity: "team-skill-hub-worker",
      },
    ];

    const first = store.claim("worker-a", 1_000, 30_000)!;
    assert.throws(
      () =>
        store.complete(
          first,
          "done",
          2_000,
          { commitSha: summary.baseCommit },
          [{ ...verification[0]!, subjectRevision: summary.baseCommit }],
          summary,
        ),
      /VERIFICATION_SUBJECT_MISMATCH/,
    );
    const second = store.claim("worker-a", 40_000, 30_000)!;
    store.complete(second, "done", 41_000, { commitSha: summary.baseCommit }, verification, summary);
    const completed = store.get(task.taskId, "alice", "tenant-a");
    assert.deepEqual(completed.workspaceChangeSummary, summary);
    assert.deepEqual(completed.verificationResults, verification);
    store.close();

    store = new ExpertTaskStore(db);
    assert.deepEqual(store.get(task.taskId, "alice", "tenant-a").workspaceChangeSummary, summary);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
