import path from "node:path";
import { restoreDataBackup } from "../backup.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const backup = arg("--backup");
const dataDir = path.resolve(arg("--data-dir") ?? process.env.DATA_DIR ?? "./data");
const force = process.argv.includes("--force");
const verifyOnly = process.argv.includes("--verify-only");

if (!backup) {
  console.error("Usage: npm run restore:data -- --backup <backup-dir> [--data-dir <data-dir>] [--force] [--verify-only]");
  process.exitCode = 2;
} else {
  try {
    const result = await restoreDataBackup(backup, dataDir, { force, verifyOnly });
    console.log(JSON.stringify({
      backup: path.resolve(backup),
      dataDir,
      verifyOnly,
      restoredFiles: result.restoredFiles,
      previousDataDir: result.previousDataDir
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
