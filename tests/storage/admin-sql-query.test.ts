import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";

test("admin SQL queries filter before pagination and report filtered totals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-sql-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    for (let i = 0; i < 45; i++) {
      await repo.recordClientEvent({
        id: `e${i}`,
        ts: new Date(1700000000000 + i).toISOString(),
        schemaVersion: 1,
        client: "codex",
        event: i % 2 ? "PostToolUse" : "SessionStart",
        sessionId: `s${i % 5}`,
        actorId: i % 3 ? "other" : "alice",
        tenantId: "t",
        metadata: { project_context: { repositoryId: i % 4 ? "r2" : "r1" } },
      });
      await repo.recordMcpCall({
        id: `c${i}`,
        ts: new Date(1700000100000 + i).toISOString(),
        traceId: `tr${i}`,
        sessionId: `s${i % 5}`,
        actorId: i % 3 ? "other" : "alice",
        tenantId: "t",
        tool: i % 2 ? "discover" : "other",
        latencyMs: 1,
        success: i % 7 !== 0,
      });
    }
    const calls = repo.adminMcpCalls({ limit: "5", cursor: "5", actorId: "alice" }, "all");
    assert.equal(calls.page.total, 15);
    assert.equal(calls.items.length, 5);
    assert.ok(calls.items.every((x) => x.actorId === "alice"));
    const reuse = repo.adminMcpCalls({ limit: "100" }, "reuse");
    assert.equal(reuse.page.total, 22);
    assert.ok(reuse.items.every((x) => x.tool === "discover"));
    const failures = repo.adminMcpCalls({ limit: "100" }, "failures");
    assert.equal(failures.page.total, 7);
    assert.ok(failures.items.every((x) => !x.success));
    const sessions = repo.adminSessions({ limit: "20", actorId: "alice", repositoryId: "r1" });
    assert.ok(sessions.items.every((x) => x.actorId === "alice" && x.repositoryId === "r1"));
    assert.equal(sessions.page.total, sessions.items.length);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admin SQL candidate and feedback queries use latest state before filtering and paging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-state-sql-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    const base = {
      id: "kc",
      ts: "2026-10-13T10:00:00.000Z",
      updatedAt: "2026-10-13T10:00:00.000Z",
      actorId: "a",
      tenantId: "t",
      title: "Database fix",
      content: "secret detail",
      sourceType: "manual",
      suggestedType: "knowledge",
      repository: "repo",
      status: "pending",
    } as const;
    await repo.recordKnowledgeCandidate(base);
    await repo.recordKnowledgeCandidate({
      ...base,
      updatedAt: "2026-10-13T10:01:00.000Z",
      status: "approved",
      reviewer: "r",
      automation: {
        detector: "d",
        classification: "verified-fix",
        generationReason: "g",
        reasons: ["r"],
        evidenceCount: 0,
        evidence: [],
      },
    } as any);
    await repo.recordFeedback({
      id: "fb",
      ts: "2026-10-13T10:02:00.000Z",
      actorId: "a",
      tenantId: "t",
      targetType: "knowledge",
      target: "k",
      rating: "negative",
      reason: "database docs",
    });
    assert.equal(repo.adminCandidates({ status: "pending" }).page.total, 0);
    const approved = repo.adminCandidates({ status: "approved", automatic: "true", q: "database" });
    assert.equal(approved.page.total, 1);
    assert.equal(approved.items[0]?.status, "approved");
    assert.equal(repo.adminCandidates({ submitter: "a" }).page.total, 1);
    assert.equal(repo.adminCandidates({ submitter: "nobody" }).page.total, 0);
    assert.equal(repo.adminFeedback({ q: "database" }).page.total, 1);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
