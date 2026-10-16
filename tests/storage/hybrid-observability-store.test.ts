import assert from "node:assert/strict";
import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../../src/observability.js";

const principal = { id: "dev", tenantId: "rd", roles: ["developer"] };

test("dual write persists JSONL and SQLite while sqlite read preserves public store API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-hybrid-"));
  try {
    const store = new McpObservabilityStore(root, 10000, { writeBackend: "dual", readBackend: "sqlite" });
    const event = await store.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "s1",
      metadata: {},
    });
    const call = await store.recordCall({
      traceId: "tr",
      sessionId: "s1",
      actorId: "dev",
      tenantId: "rd",
      tool: "discover",
      latencyMs: 3,
      success: true,
    });
    await access(path.join(root, "observability", "client-events.jsonl"));
    await access(path.join(root, "observability", "mcp-calls.jsonl"));
    await access(path.join(root, "db", "team-skill-hub.sqlite3"));
    assert.equal((await store.getClientEvent(event.id))?.id, event.id);
    assert.equal((await store.getCall(call.id))?.id, call.id);
    const session = (await store.listClientSessions(20))[0];
    assert.equal(session?.sessionId, "s1");
    assert.equal(session?.callCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite read continues after current JSONL files are unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-hybrid-sqlite-read-"));
  try {
    const store = new McpObservabilityStore(root, 10000, { writeBackend: "dual", readBackend: "sqlite" });
    const call = await store.recordCall({
      traceId: "tr",
      sessionId: "s",
      actorId: "dev",
      tenantId: "rd",
      tool: "search_knowledge",
      latencyMs: 1,
      success: true,
    });
    await unlink(path.join(root, "observability", "mcp-calls.jsonl"));
    assert.equal((await store.getCall(call.id))?.id, call.id);
    assert.equal((await store.listCalls(20))[0]?.id, call.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite store exposes backend and health metrics without creating realtime JSONL in sqlite-only mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-only-"));
  try {
    const store = new McpObservabilityStore(root, 10000, { writeBackend: "sqlite", readBackend: "sqlite" });
    await store.recordCall({
      traceId: "tr",
      sessionId: "s",
      actorId: "dev",
      tenantId: "rd",
      tool: "discover",
      latencyMs: 1,
      success: true,
    });
    const status = await store.getStorageStatus();
    assert.equal(status.writeBackend, "sqlite");
    assert.equal(status.readBackend, "sqlite");
    assert.equal(status.storageReady, true);
    assert.equal(status.sqlite?.quickCheck, true);
    assert.equal(status.sqlite?.mcpCalls, 1);
    await assert.rejects(() => access(path.join(root, "observability", "mcp-calls.jsonl")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dual write survives JSONL failure when SQLite succeeds and reports the failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-dual-failure-"));
  try {
    const invalidDataDir = path.join(root, "not-a-dir");
    await writeFile(invalidDataDir, "x");
    const store = new McpObservabilityStore(invalidDataDir, 10000, {
      writeBackend: "dual",
      readBackend: "sqlite",
      sqlitePath: path.join(root, "db.sqlite3"),
    });
    const call = await store.recordCall({
      traceId: "tr",
      sessionId: "s",
      actorId: "dev",
      tenantId: "rd",
      tool: "discover",
      latencyMs: 1,
      success: true,
    });
    assert.equal((await store.getCall(call.id))?.id, call.id);
    const status = await store.getStorageStatus();
    assert.equal(status.writeFailures.jsonl, 1);
    assert.equal(status.writeFailures.sqlite, 0);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maintenance failures are reported and a closed SQLite backend is not ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-maintenance-health-"));
  try {
    const store = new McpObservabilityStore(root, 10000, {
      writeBackend: "sqlite",
      readBackend: "sqlite",
      retentionDays: 1,
    });
    const sqlite = (store as any).sqlite;
    await sqlite.recordClientEvent({
      id: "old",
      ts: "2020-01-01T00:00:00.000Z",
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "s",
      actorId: "a",
      tenantId: "t",
      metadata: {},
    });
    const original = sqlite.rebuildSessionsSync.bind(sqlite);
    sqlite.rebuildSessionsSync = () => {
      throw new Error("maintenance boom");
    };
    await assert.rejects(() => store.runRetentionMaintenance(), /maintenance boom/);
    sqlite.rebuildSessionsSync = original;
    assert.ok(
      await sqlite.getClientEvent("old"),
      "maintenance transaction rolls fact deletion back when projection rebuild fails",
    );
    const status = await store.getStorageStatus();
    assert.equal(status.maintenance.failureCount, 1);
    assert.match(status.maintenance.lastError ?? "", /maintenance boom/);
    assert.ok(status.maintenance.lastAt);
    store.close();
    assert.equal(store.isStorageReady(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
