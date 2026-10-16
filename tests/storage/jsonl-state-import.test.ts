import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";
import { importObservabilityJsonl } from "../../src/storage/jsonl-import.js";

test("JSONL importer migrates feedback candidate history and gap management idempotently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-state-import-"));
  try {
    const obs = path.join(root, "observability");
    await mkdir(obs, { recursive: true });
    const feedback = {
      id: "fb1",
      ts: "2026-10-13T10:00:00.000Z",
      actorId: "a",
      tenantId: "t",
      targetType: "knowledge",
      target: "k",
      rating: "negative",
      reason: "r",
    };
    const c1 = {
      id: "kc1",
      ts: "2026-10-13T10:00:00.000Z",
      updatedAt: "2026-10-13T10:00:00.000Z",
      actorId: "a",
      tenantId: "t",
      title: "T",
      content: "C",
      sourceType: "manual",
      suggestedType: "knowledge",
      status: "pending",
    };
    const c2 = { ...c1, updatedAt: "2026-10-13T10:01:00.000Z", status: "approved", reviewer: "r" };
    const g1 = {
      gapKey: "g1",
      status: "ignored",
      keywords: ["x"],
      updatedAt: "2026-10-13T10:00:00.000Z",
      ignoredAt: "2026-10-13T10:00:00.000Z",
    };
    const g2 = { gapKey: "g1", status: "active", keywords: ["x"], updatedAt: "2026-10-13T10:01:00.000Z" };
    await writeFile(path.join(obs, "feedback.jsonl"), JSON.stringify(feedback) + "\n");
    await writeFile(
      path.join(obs, "knowledge-candidates.jsonl"),
      JSON.stringify(c1) + "\n" + JSON.stringify(c2) + "\n",
    );
    await writeFile(
      path.join(obs, "knowledge-gap-management.jsonl"),
      JSON.stringify(g1) + "\n" + JSON.stringify(g2) + "\n",
    );
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    const result = await importObservabilityJsonl(obs, repo);
    assert.equal(result.feedback.valid, 1);
    assert.equal(result.knowledgeCandidates.valid, 2);
    assert.equal(result.knowledgeGapManagement.valid, 2);
    assert.equal((await repo.listFeedback())[0]?.id, "fb1");
    assert.equal((await repo.getCandidate("kc1"))?.status, "approved");
    assert.equal((await repo.getCandidateHistory("kc1")).length, 2);
    assert.equal((await repo.listKnowledgeGapManagement()).get("g1")?.status, "active");
    await importObservabilityJsonl(obs, repo);
    assert.equal((await repo.getCandidateHistory("kc1")).length, 2);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
