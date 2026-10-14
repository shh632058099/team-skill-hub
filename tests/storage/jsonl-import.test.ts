import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";
import { SqliteObservabilityRepository } from "../../src/storage/sqlite-observability-repository.js";
import { importObservabilityJsonl } from "../../src/storage/jsonl-import.js";

const event=(id:string,actor="a")=>({id,ts:"2026-10-13T10:00:00.000Z",schemaVersion:1,client:"codex",event:"SessionStart",sessionId:"same",actorId:actor,tenantId:"t",metadata:{}});
const call={id:"c1",ts:"2026-10-13T10:00:01.000Z",traceId:"tr",sessionId:"same",actorId:"a",tenantId:"t",tool:"discover",latencyMs:1,success:false,error:"x"};

test("JSONL importer reads current and archives, skips corruption, and is idempotent",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"skill-hub-import-"));try{
  const obs=path.join(root,"observability");await mkdir(obs,{recursive:true});
  await writeFile(path.join(obs,"client-events.jsonl"),JSON.stringify(event("e1"))+"\n{broken\n"+JSON.stringify(event("e2","b"))+"\n");
  await writeFile(path.join(obs,"client-events.jsonl.archive.2026.jsonl"),JSON.stringify(event("e0"))+"\n");
  await writeFile(path.join(obs,"mcp-calls.jsonl"),JSON.stringify(call)+"\n"+JSON.stringify(call)+"\n");
  const db=openSkillHubDatabase(path.join(root,"db.sqlite3"));const repo=new SqliteObservabilityRepository(db);
  const first=await importObservabilityJsonl(obs,repo);assert.deepEqual(first.clientEvents,{valid:3,invalid:1});assert.equal(first.mcpCalls.valid,2);
  assert.equal((await repo.listClientEvents({limit:20})).items.length,3);assert.equal((await repo.listMcpCalls({limit:20})).items.length,1);
  assert.equal((await repo.listSessions({limit:20})).items.length,2);
  const second=await importObservabilityJsonl(obs,repo);assert.equal((await repo.listClientEvents({limit:20})).items.length,3);assert.equal(second.clientEvents.valid,3);
  assert.match(await readFile(path.join(obs,"client-events.jsonl"),"utf8"),/broken/);db.close();
 }finally{await rm(root,{recursive:true,force:true})}
});

test("JSONL importer aborts on database write errors instead of counting them as invalid JSON",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"skill-hub-import-write-fail-"));try{
  const obs=path.join(root,"observability");await mkdir(obs,{recursive:true});
  await writeFile(path.join(obs,"client-events.jsonl"),JSON.stringify(event("e1"))+"\n");
  const db=openSkillHubDatabase(path.join(root,"db.sqlite3"));const repo=new SqliteObservabilityRepository(db);
  repo.recordClientEvent=async()=>{throw new Error("SQLITE_FULL simulated")};
  await assert.rejects(()=>importObservabilityJsonl(obs,repo),/SQLITE_FULL/);
  db.close();
 }finally{await rm(root,{recursive:true,force:true})}
});
