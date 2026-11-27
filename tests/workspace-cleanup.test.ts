import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildWorkspaceCleanupRepairDockerArgs,
  removeWorkspaceDirectory,
} from "../src/expert-platform/workspace-cleanup.js";

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

test("workspace cleanup repairs only execution-container-owned permissions after EPERM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-cleanup-repair-"));
  const key = "work-22222222-a1";
  const target = path.join(root, key);
  await mkdir(target);
  const calls: string[][] = [];
  let removals = 0;

  const removed = await removeWorkspaceDirectory(root, key, {
    image: "expert-worker:test",
    workerGroupId: 988,
    removeDirectory: async () => {
      removals++;
      if (removals === 1) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    },
    runDocker: async (args) => {
      calls.push([...args]);
      return 0;
    },
  });

  assert.equal(removed, target);
  assert.equal(removals, 2);
  assert.equal(calls.length, 1);
  const args = calls[0]!;
  assert.ok(args.some((arg, index) => arg === "--user" && args[index + 1] === "10001:988"));
  assert.ok(args.some((arg, index) => arg === "--network" && args[index + 1] === "none"));
  assert.ok(args.includes("no-new-privileges"));
  assert.match(args.at(-1)!, /find \/workspace -xdev -uid 10001 -exec chmod g\+rwX/);
});

test("single-uid-v2 cleanup repairs same-owner permissions without Docker helper", async () => {
  const { chmod, chown } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-cleanup-v2-"));
  const key = "work-v2-a1";
  const target = path.join(root, key);
  const nested = path.join(target, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "private"), "x");
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(target, 999, 988);
    await chown(nested, 999, 988);
    await chown(path.join(nested, "private"), 999, 988);
  }
  await chmod(target, 0o000);
  let removals = 0;
  let dockerCalls = 0;

  const removed = await removeWorkspaceDirectory(root, key, {
    image: "expert-worker:test",
    workerGroupId: 988,
    permissionModel: "single-uid-v2",
    workerUid: typeof process.getuid === "function" && process.getuid() === 0 ? 999 : process.getuid!(),
    removeDirectory: async (candidate: string) => {
      removals++;
      if (removals === 1) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      await import("node:fs/promises").then(({ rm }) => rm(candidate, { recursive: true, force: true }));
    },
    runDocker: async () => {
      dockerCalls++;
      return 0;
    },
  } as any);

  assert.equal(removed, target);
  assert.equal(removals, 2);
  assert.equal(dockerCalls, 0);
  await assert.rejects(stat(target));
});

test("workspace cleanup repair invocation validates image and shared group", () => {
  assert.throws(
    () => buildWorkspaceCleanupRepairDockerArgs("/srv/workspaces/work-a", "-bad", 988),
    /INVALID_WORKSPACE_CLEANUP_IMAGE/,
  );
  assert.throws(
    () => buildWorkspaceCleanupRepairDockerArgs("/srv/workspaces/work-a", "worker", 0),
    /INVALID_WORKSPACE_CLEANUP_GROUP/,
  );
});
