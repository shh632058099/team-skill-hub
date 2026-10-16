import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";
import { cleanupObservabilityRetention, observabilityStorageMetrics } from "../../src/storage/maintenance.js";

test("retention follows data-governance windows and only rebuilds affected sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-retention-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    await repo.recordClientEvent({
      id: "old",
      ts: "2026-09-01T00:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "old",
      actorId: "a",
      tenantId: "t",
      metadata: {},
    });
    await repo.recordClientEvent({
      id: "new",
      ts: "2026-10-13T00:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "new",
      actorId: "a",
      tenantId: "t",
      metadata: {},
    });
    await repo.recordCandidateDetection({
      id: "det-60",
      ts: "2026-08-15T00:00:00.000Z",
      actorId: "a",
      tenantId: "t",
      sessionId: "new",
      outcome: "skipped",
      reason: "x",
      evidenceCount: 0,
    });
    await repo.recordFeedback({
      id: "fb-200",
      ts: "2026-03-28T00:00:00.000Z",
      actorId: "a",
      tenantId: "t",
      targetType: "knowledge",
      rating: "positive",
    });
    await repo.recordKnowledgeCandidate({
      id: "kc-old",
      ts: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      actorId: "a",
      tenantId: "t",
      title: "old",
      content: "old",
      sourceType: "manual",
      suggestedType: "knowledge",
      status: "pending",
    });
    await repo.recordKnowledgeGapManagement({
      gapKey: "g-old",
      status: "active",
      keywords: [],
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const result = await cleanupObservabilityRetention(db, repo, { batchSize: 5000, now });
    assert.equal(result.clientEventsDeleted, 1);
    assert.equal(result.candidateDetectionsDeleted, 0, "engineering evidence keeps 90 days");
    assert.equal(result.feedbackDeleted, 0, "audit feedback keeps 365 days");
    assert.equal(result.candidateHistoryDeleted, 1);
    assert.equal(result.knowledgeGapManagementHistoryDeleted, 1);
    assert.equal(await repo.getClientEvent("old"), undefined);
    assert.ok(await repo.getClientEvent("new"));
    assert.equal(await repo.getSession({ tenantId: "t", actorId: "a", sessionId: "old" }), undefined);
    const metrics = await observabilityStorageMetrics(db);
    assert.equal(metrics.clientEvents, 1);
    assert.ok(metrics.databaseBytes > 0);
    assert.equal(metrics.quickCheck, true);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention does not rebuild sessions when no session facts are deleted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-retention-noop-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent({
      id: "new",
      ts: "2026-10-13T00:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "s",
      actorId: "a",
      tenantId: "t",
      metadata: {},
    });
    let rebuilds = 0;
    const original = repo.rebuildSessions.bind(repo);
    repo.rebuildSessions = async (...args) => {
      rebuilds++;
      return original(...args);
    };
    await cleanupObservabilityRetention(db, repo, { now: Date.parse("2026-10-14T00:00:00.000Z") });
    assert.equal(rebuilds, 0);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
