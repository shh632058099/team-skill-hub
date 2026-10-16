import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";

test("session projection preserves identity, counts, failure and reuse semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-projection-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    for (const actorId of ["alice", "bob"])
      await repo.recordClientEvent({
        id: "start-" + actorId,
        ts: "2026-10-13T10:00:00.000Z",
        schemaVersion: 1,
        client: "codex",
        event: "SessionStart",
        sessionId: "same",
        actorId,
        tenantId: "tenant",
        metadata: {},
      });
    await repo.recordClientEvent({
      id: "evidence",
      ts: "2026-10-13T10:00:01.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "PostToolUse",
      sessionId: "same",
      actorId: "alice",
      tenantId: "tenant",
      metadata: { evidence: { exitCode: 0 } },
    });
    await repo.recordMcpCall({
      id: "reuse",
      ts: "2026-10-13T10:00:02.000Z",
      traceId: "t",
      sessionId: "same",
      actorId: "alice",
      tenantId: "tenant",
      tool: "discover",
      latencyMs: 1,
      success: true,
    });
    await repo.recordMcpCall({
      id: "failed",
      ts: "2026-10-13T10:00:03.000Z",
      traceId: "t",
      sessionId: "same",
      actorId: "alice",
      tenantId: "tenant",
      tool: "other",
      latencyMs: 1,
      success: false,
      error: "boom",
    });
    await repo.recordClientEvent({
      id: "end",
      ts: "2026-10-13T10:00:04.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionEnd",
      sessionId: "same",
      actorId: "alice",
      tenantId: "tenant",
      metadata: {},
    });
    const alice = await repo.getSession({ tenantId: "tenant", actorId: "alice", sessionId: "same" });
    const bob = await repo.getSession({ tenantId: "tenant", actorId: "bob", sessionId: "same" });
    assert.deepEqual(
      {
        eventCount: alice?.eventCount,
        callCount: alice?.callCount,
        failed: alice?.failedCallCount,
        evidence: alice?.evidenceCount,
        hasReuse: alice?.hasReuse,
        status: alice?.status,
      },
      { eventCount: 3, callCount: 2, failed: 1, evidence: 1, hasReuse: true, status: "FAILED" },
    );
    assert.equal(bob?.eventCount, 1);
    assert.equal(bob?.callCount, 0);
    assert.equal(bob?.status, "ACTIVE");
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rebuildSessions reconstructs projections from fact tables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-rebuild-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent({
      id: "start",
      ts: "2026-10-13T10:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "s",
      actorId: "a",
      tenantId: "t",
      metadata: {},
    });
    db.raw.exec("DELETE FROM sessions");
    assert.equal(await repo.getSession({ tenantId: "t", actorId: "a", sessionId: "s" }), undefined);
    await repo.rebuildSessions();
    assert.equal((await repo.getSession({ tenantId: "t", actorId: "a", sessionId: "s" }))?.eventCount, 1);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("out-of-order events do not reopen an ended session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-order-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent({
      id: "end",
      ts: "2026-10-13T10:10:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionEnd",
      sessionId: "s",
      actorId: "a",
      tenantId: "t",
      metadata: { runtime_version: "new", hook_schema_version: 2 },
    });
    await repo.recordClientEvent({
      id: "late-old",
      ts: "2026-10-13T10:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "PostToolUse",
      sessionId: "s",
      actorId: "a",
      tenantId: "t",
      metadata: { runtime_version: "old", hook_schema_version: 1 },
    });
    const session = await repo.getSession({ tenantId: "t", actorId: "a", sessionId: "s" });
    assert.equal(session?.ended, true);
    assert.equal(session?.status, "ENDED");
    assert.equal(session?.runtimeVersion, "new");
    assert.equal(session?.hookSchemaVersion, 2);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session keyset cursor includes tenant and actor identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-cursor-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    for (const [tenantId, actorId] of [
      ["t1", "a1"],
      ["t1", "a2"],
      ["t2", "a1"],
    ] as const)
      await repo.recordClientEvent({
        id: tenantId + actorId,
        ts: "2026-10-13T10:00:00.000Z",
        schemaVersion: 1,
        client: "codex",
        event: "SessionStart",
        sessionId: "same",
        actorId,
        tenantId,
        metadata: {},
      });
    const first = await repo.listSessions({ limit: 1 });
    assert.ok(first.nextCursor);
    const second = await repo.listSessions({ limit: 1, cursor: first.nextCursor });
    assert.ok(second.nextCursor);
    const third = await repo.listSessions({ limit: 1, cursor: second.nextCursor });
    const ids = [first.items[0], second.items[0], third.items[0]].map(
      (x) => x && `${x.tenantId}/${x.actorId}/${x.sessionId}`,
    );
    assert.equal(new Set(ids).size, 3);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
