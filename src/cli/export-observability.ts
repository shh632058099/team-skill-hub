import path from "node:path";
import { openSkillHubDatabase } from "../storage/database.js";
import { exportObservabilityColdArchive } from "../storage/cold-export.js";

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = path.resolve(arg("--data-dir") ?? process.env.DATA_DIR ?? "./data");
const outDir = path.resolve(arg("--out") ?? path.join(dataDir, "archive"));
const dbPath = path.resolve(
  arg("--db") ?? process.env.OBSERVABILITY_SQLITE_PATH ?? path.join(dataDir, "db", "team-skill-hub.sqlite3"),
);
const database = openSkillHubDatabase(dbPath);
try {
  const files = await exportObservabilityColdArchive(database, outDir);
  console.log(JSON.stringify({ dbPath, files }, null, 2));
} finally {
  database.close();
}
