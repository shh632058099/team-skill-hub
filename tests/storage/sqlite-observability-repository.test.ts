import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";

const event = {
  id: "evt-1",
  ts: "2026-10-13T10:00:00.000Z",
  schemaVersion: 1,
  client: "codex",
  event: "SessionStart",
  sessionId: "s1",
  actorId: "a1",
  tenantId: "t1",
  metadata: { project_context: { repositoryId: "repo-1" }, runtime_version: "1.2.3", hook_schema_version: 2 },
};
const call = {
  id: "call-1",
  ts: "2026-10-13T10:00:01.000Z",
  traceId: "tr1",
  sessionId: "s1",
  actorId: "a1",
  tenantId: "t1",
  client: "codex",
  tool: "search_knowledge",
  args: { query: "hello" },
  latencyMs: 12,
  success: true,
};

test("sqlite observability persists and returns events and calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-observability-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent(event);
    await repo.recordMcpCall(call);
    assert.deepEqual(await repo.getClientEvent("evt-1"), event);
    assert.deepEqual(await repo.getMcpCall("call-1"), call);
    assert.deepEqual(
      (await repo.listClientEvents({ limit: 20 })).items.map((x) => x.id),
      ["evt-1"],
    );
    assert.deepEqual(
      (await repo.listMcpCalls({ limit: 20 })).items.map((x) => x.id),
      ["call-1"],
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate IDs are idempotent and do not double count projections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-idempotent-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent(event);
    await repo.recordClientEvent(event);
    await repo.recordMcpCall(call);
    await repo.recordMcpCall(call);
    const session = await repo.getSession({ tenantId: "t1", actorId: "a1", sessionId: "s1" });
    assert.equal(session?.eventCount, 1);
    assert.equal(session?.callCount, 1);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuse query filters real HIT/MISS/LOAD records by event and asset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-reuse-query-"));
  try {
    const db = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordMcpCall({
      ...call,
      id: "hit",
      reuse: {
        event: "hit",
        resultCount: 1,
        topScore: 0.9,
        assets: [{ repository: "rd-knowledges", path: "knowledge/ota.md", score: 0.9 }],
      },
    });
    await repo.recordMcpCall({ ...call, id: "miss", reuse: { event: "miss", resultCount: 0, assets: [] } });
    await repo.recordMcpCall({
      ...call,
      id: "load",
      tool: "get_knowledge",
      reuse: { event: "load", assets: [{ repository: "rd-knowledges", path: "knowledge/ota.md" }] },
    });
    await repo.recordMcpCall({ ...call, id: "legacy" });
    assert.equal(repo.adminMcpCalls({ event: "hit" }, "reuse").page.total, 1);
    assert.equal(repo.adminMcpCalls({ event: "miss" }, "reuse").items[0]?.id, "miss");
    assert.equal(repo.adminMcpCalls({ event: "load", asset: "ota.md" }, "reuse").items[0]?.id, "load");
    assert.equal(repo.adminMcpCalls({ event: "hit", asset: "does-not-exist" }, "reuse").page.total, 0);
    assert.equal(repo.adminMcpCalls({ event: "nope" }, "reuse").page.total, 0);
    assert.equal(repo.adminMcpCalls({ q: "ota.md" }, "reuse").page.total, 2);
    assert.equal(repo.adminMcpCalls({}, "reuse").page.total, 4);
    const metrics = repo.adminReuseSummary({});
    assert.deepEqual(metrics.counts, { total: 4, hit: 1, miss: 1, load: 1, unknown: 1 });
    assert.deepEqual(metrics.topAssets[0], {
      repository: "rd-knowledges",
      path: "knowledge/ota.md",
      title: null,
      hits: 1,
      loads: 1,
    });
    assert.equal(repo.adminReuseSummary({ tool: "get_knowledge" }).counts.load, 1);

    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
