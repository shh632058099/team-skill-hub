import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSkillHubDatabase } from "../src/storage/database.js";
import { SqliteSkillBundleRepository } from "../src/storage/skill-bundle-repository.js";
import { createSkillBundleSnapshot, normalizeSkillBundleInput, type SkillBundleImport } from "../src/skill-bundles.js";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-storage-"));
  const db = openSkillHubDatabase(path.join(dir, "hub.sqlite3"));
  const repo = new SqliteSkillBundleRepository(db);
  return { dir, db, repo };
}

function sampleImport(snapshotId: string, snapshotSha256: string): SkillBundleImport {
  const now = "2026-10-14T00:00:00.000Z";
  return {
    id: "sbi_test",
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    replacementRoot: "skills/ota/design",
    collection: "rd-skills",
    repository: "rd-skills",
    sourceType: "mcp",
    snapshotId,
    snapshotSha256,
    status: "pending",
    submitter: "user-1",
    submissionKey: "retry-1",
    requestSemanticsSha256: "semantics-1",
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test("import updates use optimistic revision and reject stale writers", async () => {
  const { dir, db, repo } = await fixture();
  try {
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    );
    repo.saveSnapshot(snapshot);
    const created = repo.createImport(sampleImport(snapshot.id, snapshot.sha256));
    const approved = repo.updateImport({ ...created, status: "approved", updatedAt: "2026-10-14T00:01:00.000Z" });
    assert.equal(approved.revision, 1);
    assert.throws(
      () => repo.updateImport({ ...created, status: "rejected", updatedAt: "2026-10-14T00:02:00.000Z" }),
      /state conflict/i,
    );
    assert.equal(repo.getImport(created.id)?.status, "approved");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot files are immutable and stored once while import history stays metadata-only", async () => {
  const { dir, db, repo } = await fixture();
  try {
    const normalized = normalizeSkillBundleInput({
      namespace: "ota",
      importType: "skill",
      skillPath: "design",
      files: [
        { path: "SKILL.md", content: "---\nname: design\n---\n" },
        { path: "scripts/run.sh", content: "#!/bin/sh\n", mode: "0755" },
      ],
    });
    const snapshot = createSkillBundleSnapshot(normalized, "2026-10-14T00:00:00.000Z");
    const saved = repo.saveSnapshot(snapshot);
    const reused = repo.saveSnapshot({ ...snapshot, id: "sbs_other" });
    assert.equal(saved.id, reused.id);
    const record = sampleImport(saved.id, saved.sha256);
    repo.createImport(record);
    repo.updateImport({ ...record, status: "approved", updatedAt: "2026-10-14T00:01:00.000Z" });
    assert.equal((db.raw.prepare("select count(*) n from skill_bundle_file").get() as any).n, 2);
    assert.equal((db.raw.prepare("select count(*) n from skill_bundle_import_history").get() as any).n, 2);
    const historyJson = (
      db.raw.prepare("select record_json from skill_bundle_import_history order by seq").all() as any[]
    ).map((x) => String(x.record_json));
    assert.ok(historyJson.every((text) => !text.includes('"files"')));
    assert.equal(repo.getSnapshot(saved.id)?.files[1]?.mode, "0755");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("binary snapshot files survive SQLite round-trip without byte changes", async () => {
  const { dir, db, repo } = await fixture();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "skill-creator",
        importType: "skill",
        files: [
          { path: "SKILL.md", content: "---\nname: skill-creator\n---\n" },
          { path: "assets/icon.png", contentBase64: png.toString("base64") },
        ],
      }),
    );
    repo.saveSnapshot(snapshot);
    const reloaded = repo.getSnapshot(snapshot.id);
    assert.equal(
      reloaded?.files.find((file) => file.path === "assets/icon.png")?.contentBase64,
      png.toString("base64"),
    );
    assert.equal(reloaded?.files.find((file) => file.path === "assets/icon.png")?.content, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot save recovers when a concurrent writer wins the content-addressed insert", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-snapshot-race-"));
  const file = path.join(dir, "hub.sqlite3");
  const db1 = openSkillHubDatabase(file);
  const db2 = openSkillHubDatabase(file);
  const repo1 = new SqliteSkillBundleRepository(db1);
  const repo2 = new SqliteSkillBundleRepository(db2);
  try {
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    );
    const competing = { ...snapshot, id: "sbs_competing" };
    const originalTransaction = db1.transaction.bind(db1);
    let injected = false;
    (db1 as any).transaction = (fn: () => unknown) => {
      if (!injected) {
        injected = true;
        repo2.saveSnapshot(competing);
      }
      return originalTransaction(fn);
    };
    const saved = repo1.saveSnapshot(snapshot);
    assert.equal(saved.id, competing.id);
    assert.equal(
      (db1.raw.prepare("select count(*) n from skill_bundle_snapshot where sha256=?").get(snapshot.sha256) as any).n,
      1,
    );
  } finally {
    db1.close();
    db2.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("import and history survive database reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-reopen-"));
  const file = path.join(dir, "hub.sqlite3");
  try {
    let db = openSkillHubDatabase(file);
    let repo = new SqliteSkillBundleRepository(db);
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    );
    repo.saveSnapshot(snapshot);
    repo.createImport(sampleImport(snapshot.id, snapshot.sha256));
    db.close();
    db = openSkillHubDatabase(file);
    repo = new SqliteSkillBundleRepository(db);
    assert.equal(repo.getImport("sbi_test")?.replacementRoot, "skills/ota/design");
    assert.equal(repo.getImportHistory("sbi_test").length, 1);
    assert.equal(repo.getSnapshot(snapshot.id)?.files[0]?.content, "x");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("submission key lookup preserves request semantics for conflict detection", async () => {
  const { dir, db, repo } = await fixture();
  try {
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    );
    repo.saveSnapshot(snapshot);
    repo.createImport(sampleImport(snapshot.id, snapshot.sha256));
    const found = repo.findBySubmissionKey("user-1", "retry-1");
    assert.equal(found?.id, "sbi_test");
    assert.equal(found?.requestSemanticsSha256, "semantics-1");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting imports removes history and only deletes an unreferenced snapshot", async () => {
  const { dir, db, repo } = await fixture();
  try {
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    );
    repo.saveSnapshot(snapshot);
    const first = repo.createImport(sampleImport(snapshot.id, snapshot.sha256));
    const second = repo.createImport({
      ...sampleImport(snapshot.id, snapshot.sha256),
      id: "sbi_second",
      submissionKey: "retry-2",
    });

    assert.equal(repo.deleteImport(first.id), true);
    assert.equal(repo.getImport(first.id), undefined);
    assert.equal(repo.getImportHistory(first.id).length, 0);
    assert.ok(repo.getSnapshot(snapshot.id), "shared snapshot must remain while another import references it");

    assert.equal(repo.deleteImport(second.id), true);
    assert.equal(repo.getImportHistory(second.id).length, 0);
    assert.equal(repo.getSnapshot(snapshot.id), undefined, "orphaned snapshot should be removed");
    assert.equal(repo.deleteImport(second.id), false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("admin import paging filters in SQLite before applying the page limit", async () => {
  const { dir, db, repo } = await fixture();
  try {
    const snapshot = createSkillBundleSnapshot(
      normalizeSkillBundleInput({
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    );
    repo.saveSnapshot(snapshot);
    const base = sampleImport(snapshot.id, snapshot.sha256);
    repo.createImport({
      ...base,
      id: "pending-old",
      status: "pending",
      submissionKey: undefined,
      updatedAt: "2026-10-14T00:00:00.000Z",
    });
    repo.createImport({
      ...base,
      id: "published-new",
      status: "published",
      submissionKey: undefined,
      updatedAt: "2026-10-14T00:02:00.000Z",
    });
    const page = (repo as any).listImportsPage?.({ limit: 1, cursor: 0, status: "pending" });
    assert.equal(page?.items?.[0]?.id, "pending-old");
    assert.equal(page?.total, 1);
    repo.createImport({
      ...base,
      id: "filtered",
      status: "approved",
      sourceType: "web-files",
      submitter: "review-author",
      review: {
        reviewer: "reviewer-1",
        reason: "ok",
        reviewedAt: "2026-10-14T00:03:00.000Z",
        targetRevision: "r",
        targetTreeSha256: "t",
        diffSha256: "d",
        added: 0,
        modified: 0,
        deleted: 0,
      },
      submissionKey: undefined,
      updatedAt: "2026-10-14T00:03:00.000Z",
    });
    assert.equal(repo.listImportsPage({ sourceType: "web-files" } as any).total, 1);
    assert.equal(repo.listImportsPage({ reviewer: "reviewer-1" } as any).total, 1);
    assert.equal(repo.listImportsPage({ submitter: "review-author" } as any).total, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
