import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";
import { exportObservabilityColdArchive } from "../../src/storage/cold-export.js";

test("cold export emits gzip JSONL for realtime and state history tables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-cold-export-"));
  try {
    const database = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(database);
    await repo.recordClientEvent({ id: "e1", ts: "2026-01-01T00:00:00.000Z", schemaVersion: 1, client: "codex", event: "SessionStart", sessionId: "s1", actorId: "a", tenantId: "t", metadata: {} });
    await repo.recordFeedback({ id: "f1", ts: "2026-01-01T00:00:01.000Z", actorId: "a", tenantId: "t", targetType: "knowledge", rating: "negative", reason: "gap" });
    await repo.recordKnowledgeCandidate({ id: "c1", ts: "2026-01-01T00:00:02.000Z", updatedAt: "2026-01-01T00:00:02.000Z", actorId: "a", tenantId: "t", title: "T", content: "C", sourceType: "manual", suggestedType: "knowledge", status: "pending" });
    await repo.recordKnowledgeGapManagement({ gapKey: "g1", status: "active", keywords: ["x"], updatedAt: "2026-01-01T00:00:03.000Z" });
    const files = await exportObservabilityColdArchive(database, path.join(root, "out"), "2026-01-02");
    assert.equal(files.length, 6);
    const names = files.map((file) => path.basename(file));
    assert.ok(names.includes("2026-01-02-client-events.jsonl.gz"));
    assert.ok(names.includes("2026-01-02-feedback.jsonl.gz"));
    assert.ok(names.includes("2026-01-02-knowledge-candidates.jsonl.gz"));
    assert.ok(names.includes("2026-01-02-knowledge-gap-management.jsonl.gz"));
    const feedbackFile = files.find((file) => file.endsWith("feedback.jsonl.gz"))!;
    const feedback = gunzipSync(await readFile(feedbackFile)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(feedback.map((row) => row.id), ["f1"]);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
