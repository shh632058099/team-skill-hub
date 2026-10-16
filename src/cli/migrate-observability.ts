import path from "node:path";
import { openSkillHubDatabase } from "../storage/database.js";
import { SqliteObservabilityRepository } from "../storage/sqlite-observability-repository.js";
import { importObservabilityJsonl } from "../storage/jsonl-import.js";
import { observabilityStorageMetrics } from "../storage/maintenance.js";
function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dataDir = path.resolve(arg("--data-dir") ?? process.env.DATA_DIR ?? "./data");
const dbPath = path.resolve(
  arg("--db") ?? process.env.OBSERVABILITY_SQLITE_PATH ?? path.join(dataDir, "db", "team-skill-hub.sqlite3"),
);
const db = openSkillHubDatabase(dbPath);
try {
  const repo = new SqliteObservabilityRepository(db);
  const imported = await importObservabilityJsonl(path.join(dataDir, "observability"), repo);
  const metrics = await observabilityStorageMetrics(db);
  console.log(JSON.stringify({ dataDir, dbPath, imported, metrics }, null, 2));
} finally {
  db.close();
}
