import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../../src/observability.js";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";

const principal = { id: "dev", tenantId: "rd", roles: ["developer"] };
test("sqlite session projection matches JSONL core aggregation semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-parity-"));
  try {
    const legacy = new McpObservabilityStore(path.join(root, "legacy"));
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const sqlite = new SqliteObservabilityRepository(db);
    const start = await legacy.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "s",
      metadata: { project_context: { repositoryId: "repo" } },
    });
    await sqlite.recordClientEvent(start);
    const call = await legacy.recordCall({
      traceId: "tr",
      sessionId: "s",
      actorId: "dev",
      tenantId: "rd",
      tool: "search_knowledge",
      latencyMs: 4,
      success: false,
      error: "x",
    });
    await sqlite.recordMcpCall(call);
    const end = await legacy.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "SessionEnd",
      sessionId: "s",
      metadata: {},
    });
    await sqlite.recordClientEvent(end);
    const old = (await legacy.listClientSessions(20))[0]!;
    const fresh = await sqlite.getSession({ tenantId: "rd", actorId: "dev", sessionId: "s" });
    assert.equal(fresh?.eventCount, old.eventCount);
    assert.equal(fresh?.callCount, old.callCount);
    assert.equal(fresh?.failedCallCount, old.failedCallCount);
    assert.equal(fresh?.repositoryId, old.repositoryId);
    assert.equal(fresh?.status, "FAILED");
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
