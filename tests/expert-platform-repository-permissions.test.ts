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
