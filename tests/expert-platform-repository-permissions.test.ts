import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { grantExecutionContainerReadAccess } from "../src/expert-platform/repository-workspace.js";

test("execution checkout is group-readable without exposing world permissions or following symlinks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-permissions-"));
  try {
    const outside = path.join(root, "outside");
    const source = path.join(root, "source");
    writeFileSync(outside, "private", { mode: 0o600 });
    mkdirSync(source, { mode: 0o700 });
    const file = path.join(source, "README.md");
    writeFileSync(file, "hello", { mode: 0o600 });
    symlinkSync(outside, path.join(source, "external"));
    grantExecutionContainerReadAccess(source, process.getgid!());
    const dir = lstatSync(source);
    const content = lstatSync(file);
    assert.equal(dir.mode & 0o777, 0o750);
    assert.equal(content.mode & 0o777, 0o640);
    assert.equal(content.gid, process.getgid!());
    assert.equal(lstatSync(outside).mode & 0o777, 0o600);
    assert.equal(readFileSync(outside, "utf8"), "private");
    chmodSync(file, 0o600);
    grantExecutionContainerReadAccess(source, process.getgid!());
    assert.equal(lstatSync(file).mode & 0o777, 0o640, "repeat preparation should restore readable mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace-write grants group write only to the working tree and keeps git metadata read-only", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-write-permissions-"));
  try {
    const outside = path.join(root, "outside");
    const source = path.join(root, "source");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(path.join(source, ".git"), { mode: 0o700 });
    const file = path.join(source, "README.md");
    const gitFile = path.join(source, ".git", "config");
    writeFileSync(file, "hello", { mode: 0o600 });
    writeFileSync(gitFile, "git", { mode: 0o600 });
    writeFileSync(outside, "private", { mode: 0o600 });
    symlinkSync(outside, path.join(source, "external"));

    const { grantExecutionContainerAccess } = await import("../src/expert-platform/repository-workspace.js");
    grantExecutionContainerAccess(source, "read-write", process.getgid!());

    assert.equal(lstatSync(source).mode & 0o777, 0o770);
    assert.equal(lstatSync(file).mode & 0o777, 0o660);
    assert.equal(lstatSync(path.join(source, ".git")).mode & 0o777, 0o750);
    assert.equal(lstatSync(gitFile).mode & 0o777, 0o640);
    assert.equal(lstatSync(outside).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
