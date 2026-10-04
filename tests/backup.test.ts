import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDataBackup, restoreDataBackup, verifyDataBackup } from "../src/backup.js";

test("DATA_DIR backup verifies and restores while preserving replaced data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-backup-"));
  try {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backup-1");
    const restoreDir = path.join(root, "restore");
    await mkdir(path.join(dataDir, "config"), { recursive: true });
    await mkdir(path.join(dataDir, "observability"), { recursive: true });
    await writeFile(path.join(dataDir, "config", "admin-config.json"), "{\"ok\":true}\n", "utf8");
    await writeFile(path.join(dataDir, "config", "api-keys.json"), "[{\"hash\":\"abc\"}]\n", "utf8");
    await writeFile(path.join(dataDir, "observability", "mcp-calls.jsonl"), "{\"id\":1}\n", "utf8");

    const manifest = await createDataBackup(dataDir, backupDir);
    assert.equal(manifest.files.length, 3);
    assert.equal((await verifyDataBackup(backupDir)).files.length, 3);

    await mkdir(restoreDir, { recursive: true });
    await writeFile(path.join(restoreDir, "old.txt"), "keep me", "utf8");
    await assert.rejects(
      () => restoreDataBackup(backupDir, restoreDir),
      /not empty/
    );

    const restored = await restoreDataBackup(backupDir, restoreDir, { force: true });
    assert.equal(restored.restoredFiles, 3);
    assert.ok(restored.previousDataDir);
    assert.equal(await readFile(path.join(restoreDir, "config", "admin-config.json"), "utf8"), "{\"ok\":true}\n");
    assert.equal(await readFile(path.join(restored.previousDataDir!, "old.txt"), "utf8"), "keep me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup verification rejects tampered files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-backup-tamper-"));
  try {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backup");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "state.json"), "{\"value\":1}", "utf8");
    await createDataBackup(dataDir, backupDir);
    await writeFile(path.join(backupDir, "data", "state.json"), "{\"value\":2}", "utf8");
    await assert.rejects(() => verifyDataBackup(backupDir), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
