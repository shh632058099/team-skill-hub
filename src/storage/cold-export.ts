import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import type { SkillHubDatabase } from "./database.js";

const EXPORTS = [
  ["client_events", "client-events", "ts,id"],
  ["mcp_calls", "mcp-calls", "ts,id"],
  ["candidate_detections", "candidate-detections", "ts,id"],
  ["feedback", "feedback", "ts,id"],
  ["candidate_history", "knowledge-candidates", "updated_at,seq"],
  ["knowledge_gap_management_history", "knowledge-gap-management", "updated_at,seq"],
] as const;

async function dumpTable(
  database: SkillHubDatabase,
  outDir: string,
  stamp: string,
  table: string,
  name: string,
  order: string,
) {
  const target = path.join(outDir, `${stamp}-${name}.jsonl.gz`);
  const gzip = createGzip();
  const output = createWriteStream(target, { mode: 0o600 });
  gzip.pipe(output);
  for (const row of database.raw.prepare(`SELECT record_json FROM ${table} ORDER BY ${order}`).iterate() as Iterable<{
    record_json: string;
  }>) {
    if (!gzip.write(row.record_json + "\n")) await once(gzip, "drain");
  }
  gzip.end();
  await once(output, "close");
  return target;
}

export async function exportObservabilityColdArchive(
  database: SkillHubDatabase,
  outDir: string,
  stamp = new Date().toISOString().slice(0, 10),
) {
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const [table, name, order] of EXPORTS) files.push(await dumpTable(database, outDir, stamp, table, name, order));
  return files;
}
