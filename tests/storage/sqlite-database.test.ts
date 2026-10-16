import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";

test("sqlite database boots in WAL mode and passes quick_check", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-"));
  try {
    const database = openSkillHubDatabase(path.join(root, "db", "skill-hub.sqlite3"));
    assert.equal(database.pragmaValue("journal_mode"), "wal");
    assert.equal(database.quickCheck(), true);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite transaction rolls back atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-tx-"));
  try {
    const database = openSkillHubDatabase(path.join(root, "db.sqlite3"));
    assert.throws(() =>
      database.transaction(() => {
        database.raw.exec("CREATE TABLE tx_probe(value TEXT NOT NULL)");
        database.raw.prepare("INSERT INTO tx_probe(value) VALUES (?)").run("should-rollback");
        throw new Error("rollback");
      }),
    );
    const tables = database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tx_probe'").all();
    assert.equal(tables.length, 0);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sqlite reopen preserves committed WAL data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-reopen-"));
  try {
    const file = path.join(root, "db.sqlite3");
    let database = openSkillHubDatabase(file);
    database.raw.exec("CREATE TABLE reopen_probe(value TEXT NOT NULL)");
    database.raw.prepare("INSERT INTO reopen_probe(value) VALUES (?)").run("committed");
    database.close();
    database = openSkillHubDatabase(file);
    assert.equal(
      (database.raw.prepare("SELECT value FROM reopen_probe").get() as { value: string }).value,
      "committed",
    );
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed database fails closed during initialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-malformed-"));
  try {
    const file = path.join(root, "db.sqlite3");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "this is not sqlite", "utf8");
    assert.throws(() => openSkillHubDatabase(file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent writer lock fails instead of corrupting data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-lock-"));
  try {
    const file = path.join(root, "db.sqlite3");
    const first = openSkillHubDatabase(file);
    const second = openSkillHubDatabase(file);
    first.raw.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(
        () => second.transaction(() => second.raw.exec("CREATE TABLE locked_probe(value TEXT)")),
        /busy|locked/i,
      );
    } finally {
      first.raw.exec("ROLLBACK");
      first.close();
      second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
