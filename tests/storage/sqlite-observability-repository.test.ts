import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";

const event = { id:"evt-1", ts:"2026-10-13T10:00:00.000Z", schemaVersion:1, client:"codex", event:"SessionStart", sessionId:"s1", actorId:"a1", tenantId:"t1", metadata:{ project_context:{ repositoryId:"repo-1" }, runtime_version:"1.2.3", hook_schema_version:2 } };
const call = { id:"call-1", ts:"2026-10-13T10:00:01.000Z", traceId:"tr1", sessionId:"s1", actorId:"a1", tenantId:"t1", client:"codex", tool:"search_knowledge", args:{query:"hello"}, latencyMs:12, success:true };

test("sqlite observability persists and returns events and calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-observability-"));
  try {
    const db = openSkillHubDatabase(path.join(root,"db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent(event);
    await repo.recordMcpCall(call);
    assert.deepEqual(await repo.getClientEvent("evt-1"), event);
    assert.deepEqual(await repo.getMcpCall("call-1"), call);
    assert.deepEqual((await repo.listClientEvents({limit:20})).items.map(x=>x.id), ["evt-1"]);
    assert.deepEqual((await repo.listMcpCalls({limit:20})).items.map(x=>x.id), ["call-1"]);
    db.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("duplicate IDs are idempotent and do not double count projections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-idempotent-"));
  try {
    const db = openSkillHubDatabase(path.join(root,"db.sqlite3"));
    const repo = new SqliteObservabilityRepository(db);
    await repo.recordClientEvent(event); await repo.recordClientEvent(event);
    await repo.recordMcpCall(call); await repo.recordMcpCall(call);
    const session = await repo.getSession({tenantId:"t1",actorId:"a1",sessionId:"s1"});
    assert.equal(session?.eventCount,1); assert.equal(session?.callCount,1);
    db.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});
