import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeWorkspaceDirectory } from "../src/expert-platform/workspace-cleanup.js";

test("workspace cleanup deletes only one validated workspace-key directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-cleanup-"));
  const key = "work-11111111-a1";
  const target = path.join(root, key);
  await mkdir(target);
  await writeFile(path.join(target, "marker"), "x");

  const removed = await removeWorkspaceDirectory(root, key);
  assert.equal(removed, target);
  await assert.rejects(stat(target));

  await assert.rejects(removeWorkspaceDirectory(root, "../escape"), /INVALID_WORKSPACE_KEY/);
  await assert.rejects(removeWorkspaceDirectory("/", key), /INVALID_WORKSPACE_ROOT/);
});
