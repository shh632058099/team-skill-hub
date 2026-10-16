import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";

test("SQLite Admin MCP filters preserve legacy success and searchable-field semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-parity-"));
  const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
  try {
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordMcpCall({
      id: "visible-call",
      ts: "2026-10-14T00:00:00.000Z",
      traceId: "trace-visible",
      actorId: "actor-visible",
      tenantId: "tenant",
      sessionId: "session-visible",
      client: "codex",
      tool: "search_knowledge",
      args: { hiddenOnly: "needle-only-in-args" },
      latencyMs: 1,
      success: true,
    });
    await repo.recordMcpCall({
      id: "failed-call",
      ts: "2026-10-14T00:00:01.000Z",
      traceId: "trace-failed",
      actorId: "actor-failed",
      tenantId: "tenant",
      tool: "other_tool",
      latencyMs: 1,
      success: false,
      error: "visible-error",
    });
    assert.equal(repo.adminMcpCalls({ success: "nonsense" }, "all").page.total, 0);
    assert.equal(repo.adminMcpCalls({ success: "" }, "all").page.total, 2);
    assert.equal(repo.adminMcpCalls({ q: "needle-only-in-args" }, "all").page.total, 0);
    assert.equal(repo.adminMcpCalls({ q: "  trace-visible  " }, "all").page.total, 1);
    assert.equal(repo.adminMcpCalls({ q: "visible-error" }, "all").page.total, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite Admin Candidate and Feedback q filters only search legacy user-facing fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-parity-fields-"));
  const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
  try {
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordFeedback({
      id: "fb1",
      ts: "2026-10-14T00:00:00.000Z",
      actorId: "alice",
      tenantId: "hidden-tenant-needle",
      targetType: "knowledge",
      target: "doc-visible",
      rating: "negative",
      reason: "reason-visible",
    });
    await repo.recordKnowledgeCandidate({
      id: "kc1",
      ts: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z",
      actorId: "author-hidden-needle",
      tenantId: "tenant",
      title: "title-visible",
      content: "content-visible",
      sourceType: "manual",
      suggestedType: "knowledge",
      status: "pending",
      automation: undefined,
    });
    assert.equal(repo.adminFeedback({ q: "hidden-tenant-needle" }).page.total, 0);
    assert.equal(repo.adminFeedback({ q: "reason-visible" }).page.total, 1);
    assert.equal(repo.adminCandidates({ q: "author-hidden-needle" }).page.total, 0);
    assert.equal(repo.adminCandidates({ q: "content-visible" }).page.total, 1);
    assert.equal(repo.adminCandidates({ automatic: "false" }).page.total, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite Admin candidate history lists every state transition and filters before paging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-candidate-history-"));
  const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
  try {
    const repo = new SqliteObservabilityRepository(db);
    const base = {
      id: "kc-history",
      ts: "2026-10-14T00:00:00.000Z",
      actorId: "alice",
      tenantId: "tenant",
      title: "OTA 恢复",
      content: "content",
      sourceType: "troubleshooting" as const,
      suggestedType: "knowledge" as const,
    };
    await repo.recordKnowledgeCandidate({ ...base, updatedAt: "2026-10-14T00:00:00.000Z", status: "pending" });
    await repo.recordKnowledgeCandidate({
      ...base,
      updatedAt: "2026-10-14T00:01:00.000Z",
      status: "approved",
      reviewer: "reviewer-a",
      reviewReason: "useful",
    });
    await repo.recordKnowledgeCandidate({
      ...base,
      updatedAt: "2026-10-14T00:02:00.000Z",
      status: "published",
      reviewer: "reviewer-a",
      reviewReason: "useful",
    });
    const all = repo.adminCandidateHistory({ limit: "2", cursor: "0" });
    assert.equal(all.page.total, 3);
    assert.deepEqual(
      all.items.map((item) => item.status),
      ["published", "approved"],
    );
    assert.equal(all.page.nextCursor, "2");
    const approved = repo.adminCandidateHistory({ status: "approved", reviewer: "reviewer-a", q: "OTA" });
    assert.equal(approved.page.total, 1);
    assert.equal(approved.items[0]?.id, "kc-history");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite Admin session ordering is deterministic across duplicate session ids and timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-session-order-"));
  const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
  try {
    const repo = new SqliteObservabilityRepository(db);
    for (const [tenantId, actorId] of [
      ["tenant-a", "actor-a"],
      ["tenant-b", "actor-b"],
    ] as const) {
      await repo.recordClientEvent({
        id: `${tenantId}-${actorId}`,
        ts: "2026-10-14T00:00:00.000Z",
        schemaVersion: 1,
        client: "codex",
        event: "SessionStart",
        sessionId: "same-session",
        actorId,
        tenantId,
        metadata: {},
      });
    }
    const first = repo.adminSessions({ limit: "1", cursor: "0" });
    const second = repo.adminSessions({ limit: "1", cursor: "1" });
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.deepEqual(
      [first.items[0]!.tenantId, first.items[0]!.actorId, second.items[0]!.tenantId, second.items[0]!.actorId],
      ["tenant-b", "actor-b", "tenant-a", "actor-a"],
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite Admin Hook and Candidate Detection q filters preserve legacy searchable fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-parity-event-fields-"));
  const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
  try {
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent({
      id: "hidden-event-id",
      ts: "2026-10-14T00:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "PostToolUse",
      sessionId: "session-visible",
      actorId: "actor-visible",
      tenantId: "hidden-tenant",
      turnId: "turn-visible",
      metadata: { note: "metadata-visible" },
    });
    await repo.recordCandidateDetection({
      id: "hidden-detection-id",
      ts: "2026-10-14T00:00:00.000Z",
      actorId: "actor-visible",
      tenantId: "hidden-tenant",
      sessionId: "session-visible",
      outcome: "skipped",
      reason: "reason-visible",
      evidenceCount: 999,
    });
    assert.equal(repo.adminClientEvents({ q: "hidden-event-id" }).page.total, 0);
    assert.equal(repo.adminClientEvents({ q: "metadata-visible" }).page.total, 1);
    assert.equal(repo.adminCandidateDetections({ q: "hidden-detection-id" }).page.total, 0);
    assert.equal(repo.adminCandidateDetections({ q: "999" }).page.total, 0);
    assert.equal(repo.adminCandidateDetections({ q: "reason-visible" }).page.total, 1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
