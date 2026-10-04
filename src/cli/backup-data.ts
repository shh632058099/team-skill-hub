import path from "node:path";
import { createDataBackup } from "../backup.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = path.resolve(arg("--data-dir") ?? process.env.DATA_DIR ?? "./data");
const out = arg("--out");
if (!out) {
  console.error("Usage: npm run backup:data -- --out <backup-dir> [--data-dir <data-dir>]");
  process.exitCode = 2;
} else {
  try {
    const manifest = await createDataBackup(dataDir, out);
    console.log(JSON.stringify({
      backup: path.resolve(out),
      dataDir,
      createdAt: manifest.createdAt,
      files: manifest.files.length
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
