import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../../src/observability.js";
import { openSkillHubDatabase } from "../../src/storage/database.js";

test("shadow read detects JSONL and SQLite parity drift without changing primary result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-shadow-"));
  try {
    const dbPath = path.join(root, "db", "team-skill-hub.sqlite3");
    const store = new McpObservabilityStore(root, 10000, {
      writeBackend: "dual",
      readBackend: "jsonl",
      shadowSqlite: true,
      sqlitePath: dbPath,
    });
    const call = await store.recordCall({
      traceId: "tr",
      sessionId: "s",
      actorId: "a",
      tenantId: "t",
      tool: "discover",
      latencyMs: 1,
      success: true,
    });
    const db = openSkillHubDatabase(dbPath);
    db.raw.prepare("DELETE FROM mcp_calls WHERE id=?").run(call.id);
    db.close();
    const primary = await store.listCalls(20);
    assert.equal(primary[0]?.id, call.id);
    const status = await store.getStorageStatus();
    assert.equal(status.shadowReadMismatches, 1);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
