import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeWorkspaceChangeSummary } from "../src/expert-platform/workspace-change-summary.js";

function initRepo(root: string) {
  execFileSync("git", ["init", "-b", "main", root]);
  writeFileSync(path.join(root, "a.txt"), "one\n");
  writeFileSync(path.join(root, "delete.txt"), "remove\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("workspace change summary is deterministic and captures modified added and deleted files", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workspace-summary-"));
  const repo = path.join(dir, "repo");
  try {
    const baseCommit = initRepo(repo);
    const unchanged = await computeWorkspaceChangeSummary(repo, baseCommit);
    assert.deepEqual(unchanged.changedFiles, []);
    assert.deepEqual(unchanged.addedFiles, []);
    assert.deepEqual(unchanged.deletedFiles, []);
    assert.equal(unchanged.diffStat.filesChanged, 0);

    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(repo, "new.txt"), "new\n");
    unlinkSync(path.join(repo, "delete.txt"));
    const summary = await computeWorkspaceChangeSummary(repo, baseCommit);
    assert.deepEqual(summary.changedFiles, ["a.txt"]);
    assert.deepEqual(summary.addedFiles, ["new.txt"]);
    assert.deepEqual(summary.deletedFiles, ["delete.txt"]);
    assert.equal(summary.diffStat.filesChanged, 3);
    assert.ok(summary.diffStat.insertions >= 2);
    assert.ok(summary.diffStat.deletions >= 1);
    assert.match(summary.contentRevision, /^[a-f0-9]{64}$/);

    const clone = path.join(dir, "clone");
    execFileSync("git", ["clone", "--quiet", repo, clone]);
    execFileSync("git", ["-C", clone, "checkout", "--quiet", baseCommit]);
    writeFileSync(path.join(clone, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(clone, "new.txt"), "new\n");
    unlinkSync(path.join(clone, "delete.txt"));
    const same = await computeWorkspaceChangeSummary(clone, baseCommit);
    assert.equal(same.contentRevision, summary.contentRevision);

    writeFileSync(path.join(clone, "new.txt"), "different\n");
    const changed = await computeWorkspaceChangeSummary(clone, baseCommit);
    assert.notEqual(changed.contentRevision, summary.contentRevision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace summary hashes symlink identity without following targets outside the repository", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workspace-summary-link-"));
  const repo = path.join(dir, "repo");
  const outside = path.join(dir, "outside.txt");
  try {
    const baseCommit = initRepo(repo);
    writeFileSync(outside, "secret-one\n");
    symlinkSync(outside, path.join(repo, "outside-link"));
    const first = await computeWorkspaceChangeSummary(repo, baseCommit);
    writeFileSync(outside, "secret-two\n");
    const second = await computeWorkspaceChangeSummary(repo, baseCommit);
    assert.deepEqual(first.addedFiles, ["outside-link"]);
    assert.equal(second.contentRevision, first.contentRevision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace summary path list is sorted and bounded", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workspace-summary-limit-"));
  const repo = path.join(dir, "repo");
  try {
    const baseCommit = initRepo(repo);
    for (let index = 0; index < 501; index++) {
      writeFileSync(path.join(repo, `new-${String(index).padStart(3, "0")}.txt`), "x\n");
    }
    await assert.rejects(() => computeWorkspaceChangeSummary(repo, baseCommit), /WORKSPACE_CHANGE_LIMIT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
