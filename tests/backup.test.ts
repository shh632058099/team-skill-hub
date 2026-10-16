import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDataBackup, restoreDataBackup, verifyDataBackup } from "../src/backup.js";
import { openSkillHubDatabase } from "../src/storage/database.js";

test("DATA_DIR backup verifies and restores while preserving replaced data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-backup-"));
  try {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backup-1");
    const restoreDir = path.join(root, "restore");
    await mkdir(path.join(dataDir, "config"), { recursive: true });
    await mkdir(path.join(dataDir, "observability"), { recursive: true });
    await writeFile(path.join(dataDir, "config", "admin-config.json"), '{"ok":true}\n', "utf8");
    await writeFile(path.join(dataDir, "config", "api-keys.json"), '[{"hash":"abc"}]\n', "utf8");
    await writeFile(path.join(dataDir, "observability", "mcp-calls.jsonl"), '{"id":1}\n', "utf8");

    const manifest = await createDataBackup(dataDir, backupDir);
    assert.equal(manifest.files.length, 3);
    assert.equal((await verifyDataBackup(backupDir)).files.length, 3);

    await mkdir(restoreDir, { recursive: true });
    await writeFile(path.join(restoreDir, "old.txt"), "keep me", "utf8");
    await assert.rejects(() => restoreDataBackup(backupDir, restoreDir), /not empty/);

    const restored = await restoreDataBackup(backupDir, restoreDir, { force: true });
    assert.equal(restored.restoredFiles, 3);
    assert.ok(restored.previousDataDir);
    assert.equal(await readFile(path.join(restoreDir, "config", "admin-config.json"), "utf8"), '{"ok":true}\n');
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
    await writeFile(path.join(dataDir, "state.json"), '{"value":1}', "utf8");
    await createDataBackup(dataDir, backupDir);
    await writeFile(path.join(backupDir, "data", "state.json"), '{"value":2}', "utf8");
    await assert.rejects(() => verifyDataBackup(backupDir), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite backup uses a consistent database snapshot and excludes WAL sidecars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-backup-"));
  try {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backup");
    const restoreDir = path.join(root, "restore");
    const db = openSkillHubDatabase(path.join(dataDir, "db", "team-skill-hub.sqlite3"));
    db.raw.exec("CREATE TABLE backup_probe(value TEXT NOT NULL)");
    db.raw.prepare("INSERT INTO backup_probe(value) VALUES (?)").run("committed");
    const manifest = await createDataBackup(dataDir, backupDir);
    assert.ok(manifest.files.some((f) => f.path === "db/team-skill-hub.sqlite3"));
    assert.equal(
      manifest.files.some((f) => f.path.endsWith("-wal") || f.path.endsWith("-shm")),
      false,
    );
    await restoreDataBackup(backupDir, restoreDir);
    const restored = openSkillHubDatabase(path.join(restoreDir, "db", "team-skill-hub.sqlite3"));
    assert.equal(restored.quickCheck(), true);
    assert.equal(
      (restored.raw.prepare("SELECT value FROM backup_probe").get() as { value: string }).value,
      "committed",
    );
    restored.close();
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite backup detects a custom .db filename by file content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-custom-backup-"));
  try {
    const dataDir = path.join(root, "data"),
      backupDir = path.join(root, "backup"),
      restoreDir = path.join(root, "restore");
    const db = openSkillHubDatabase(path.join(dataDir, "custom", "observability.db"));
    db.raw.exec("CREATE TABLE probe(value TEXT)");
    db.raw.prepare("INSERT INTO probe(value) VALUES (?)").run("ok");
    const manifest = await createDataBackup(dataDir, backupDir);
    assert.ok(manifest.files.some((f) => f.path === "custom/observability.db"));
    assert.equal(
      manifest.files.some((f) => f.path.endsWith("-wal") || f.path.endsWith("-shm")),
      false,
    );
    await restoreDataBackup(backupDir, restoreDir);
    const restored = openSkillHubDatabase(path.join(restoreDir, "custom", "observability.db"));
    assert.equal((restored.raw.prepare("SELECT value FROM probe").get() as { value: string }).value, "ok");
    restored.close();
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup refuses a configured SQLite database outside DATA_DIR", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-outside-backup-"));
  try {
    const dataDir = path.join(root, "data"),
      outside = path.join(root, "outside.db"),
      backupDir = path.join(root, "backup");
    await mkdir(dataDir, { recursive: true });
    const db = openSkillHubDatabase(outside);
    await assert.rejects(() => createDataBackup(dataDir, backupDir, { sqlitePath: outside }), /inside DATA_DIR/);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup preserves ordinary files whose names end with SQLite sidecar suffixes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-backup-sidecar-name-"));
  try {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backup");
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "ordinary-wal"), "ordinary wal content", "utf8");
    await writeFile(path.join(dataDir, "ordinary-shm"), "ordinary shm content", "utf8");
    const dbPath = path.join(dataDir, "db", "observability.db");
    const db = openSkillHubDatabase(dbPath);
    db.raw.exec("CREATE TABLE probe(value TEXT)");
    db.raw.prepare("INSERT INTO probe(value) VALUES (?)").run("ok");
    const manifest = await createDataBackup(dataDir, backupDir, { sqlitePath: dbPath });
    assert.ok(manifest.files.some((file) => file.path === "ordinary-wal"));
    assert.ok(manifest.files.some((file) => file.path === "ordinary-shm"));
    assert.equal(
      manifest.files.some((file) => file.path === "db/observability.db-wal"),
      false,
    );
    assert.equal(
      manifest.files.some((file) => file.path === "db/observability.db-shm"),
      false,
    );
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
