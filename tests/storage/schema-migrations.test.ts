import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSkillHubDatabase } from "../../src/storage/database.js";

test("schema migrations are versioned and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-migrations-"));
  try {
    const file = path.join(root, "db.sqlite3");
    let db = openSkillHubDatabase(file);
    const first = db.raw.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
      name: string;
    }>;
    assert.ok(first.length >= 1);
    assert.equal(first[0]?.version, 1);
    db.close();
    db = openSkillHubDatabase(file);
    const second = db.raw.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    assert.deepEqual(second, first);
    for (const table of ["client_events", "mcp_calls", "candidate_detections", "sessions"]) {
      const found = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      assert.ok(found, table + " should exist");
    }
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("database refuses schema versions newer than this binary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-newer-schema-"));
  try {
    const file = path.join(root, "db.sqlite3");
    const db = openSkillHubDatabase(file);
    db.raw
      .prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)")
      .run(999, "future-schema", Date.now());
    db.close();
    assert.throws(() => openSkillHubDatabase(file), /newer|unsupported|schema/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
