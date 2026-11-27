import assert from "node:assert/strict";
import {
  chmodSync,
  chownSync,
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
import {
  EXECUTION_CONTAINER_UID,
  grantExecutionContainerReadAccess,
  prepareRuntimeStateDirectory,
} from "../src/expert-platform/repository-workspace.js";

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
    mkdirSync(path.join(source, "nested"), { mode: 0o700 });
    const file = path.join(source, "README.md");
    const gitFile = path.join(source, ".git", "config");
    writeFileSync(file, "hello", { mode: 0o600 });
    writeFileSync(gitFile, "git", { mode: 0o600 });
    writeFileSync(outside, "private", { mode: 0o600 });
    symlinkSync(outside, path.join(source, "external"));

    const { grantExecutionContainerAccess } = await import("../src/expert-platform/repository-workspace.js");
    grantExecutionContainerAccess(source, "read-write", process.getgid!());

    assert.equal(lstatSync(source).mode & 0o777, 0o770);
    assert.equal(lstatSync(source).mode & 0o2000, 0o2000);
    assert.equal(lstatSync(path.join(source, "nested")).mode & 0o2000, 0o2000);
    assert.equal(lstatSync(file).mode & 0o777, 0o660);
    assert.equal(lstatSync(path.join(source, ".git")).mode & 0o777, 0o750);
    assert.equal(lstatSync(path.join(source, ".git")).mode & 0o2000, 0);
    assert.equal(lstatSync(gitFile).mode & 0o777, 0o640);
    assert.equal(lstatSync(outside).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-uid-v2 accepts normal git layout without normalizing working-tree file modes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-single-uid-layout-"));
  try {
    const source = path.join(root, "source");
    mkdirSync(path.join(source, ".git"), { recursive: true, mode: 0o700 });
    const file = path.join(source, "private.txt");
    writeFileSync(file, "private", { mode: 0o600 });
    const modeBefore = lstatSync(file).mode & 0o7777;
    const module = await import("../src/expert-platform/repository-workspace.js");
    const gitPath = path.join(source, ".git");
    let gitOwner = lstatSync(gitPath).uid;
    if (gitOwner === 0 && typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(gitPath, 999, lstatSync(gitPath).gid);
      gitOwner = 999;
    }
    (module as any).validateSingleUidWorkspaceLayout(source, gitOwner);
    assert.equal(lstatSync(file).mode & 0o7777, modeBefore);
    assert.throws(
      () => (module as any).validateSingleUidWorkspaceLayout(source, gitOwner + 1),
      /WORKSPACE_GIT_METADATA_OWNERSHIP_INVALID/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-uid-v2 restores owner access after Agent chmod without changing executable semantics", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-single-uid-owner-access-"));
  try {
    const source = path.join(root, "source");
    const nested = path.join(source, "nested");
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    const plain = path.join(nested, "plain.txt");
    const executable = path.join(nested, "run.sh");
    writeFileSync(plain, "plain", { mode: 0o600 });
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });

    let ownerUid = lstatSync(source).uid;
    if (ownerUid === 0 && typeof process.getuid === "function" && process.getuid() === 0) {
      for (const candidate of [source, nested, plain, executable]) {
        chownSync(candidate, 999, lstatSync(candidate).gid);
      }
      ownerUid = 999;
    }

    chmodSync(source, 0o000);
    chmodSync(nested, 0o000);
    chmodSync(plain, 0o000);
    chmodSync(executable, 0o100);

    const module = await import("../src/expert-platform/repository-workspace.js");
    const repair = (module as any).ensureSingleUidWorkspaceOwnerAccess as
      ((workspace: string, ownerUid: number) => void) | undefined;
    assert.equal(typeof repair, "function");
    repair!(source, ownerUid);

    assert.equal(lstatSync(source).mode & 0o700, 0o700);
    assert.equal(lstatSync(nested).mode & 0o700, 0o700);
    assert.equal(lstatSync(plain).mode & 0o700, 0o600);
    assert.equal(lstatSync(executable).mode & 0o700, 0o700);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-uid-v2 rejects initialized submodule metadata inside the working tree", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-single-uid-submodule-"));
  try {
    const source = path.join(root, "source");
    const gitPath = path.join(source, ".git");
    const submodule = path.join(source, "vendor", "submodule");
    mkdirSync(gitPath, { recursive: true, mode: 0o700 });
    mkdirSync(submodule, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(submodule, ".git"), "gitdir: ../../.git/modules/vendor/submodule\n");

    let gitOwner = lstatSync(gitPath).uid;
    if (gitOwner === 0 && typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(gitPath, 999, lstatSync(gitPath).gid);
      gitOwner = 999;
    }

    const module = await import("../src/expert-platform/repository-workspace.js");
    assert.throws(
      () => (module as any).validateSingleUidWorkspaceLayout(source, gitOwner),
      /WORKSPACE_GIT_LAYOUT_UNSUPPORTED/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-uid-v2 rejects git files and symlinked metadata", async () => {
  const module = await import("../src/expert-platform/repository-workspace.js");
  for (const kind of ["file", "symlink"] as const) {
    const root = mkdtempSync(path.join(os.tmpdir(), "expert-single-uid-invalid-"));
    try {
      const source = path.join(root, "source");
      mkdirSync(source, { mode: 0o700 });
      if (kind === "file") writeFileSync(path.join(source, ".git"), "gitdir: ../outside\n");
      else {
        const outside = path.join(root, "outside-git");
        mkdirSync(outside);
        symlinkSync(outside, path.join(source, ".git"));
      }
      assert.throws(() => (module as any).validateSingleUidWorkspaceLayout(source), /WORKSPACE_GIT_LAYOUT_UNSUPPORTED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("runtime session preparation changes only the Worker-owned mount root", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-runtime-state-"));
  try {
    const runtime = path.join(root, "runtime");
    const privateDir = path.join(runtime, "projects", "session");
    mkdirSync(privateDir, { recursive: true, mode: 0o755 });
    const privateFile = path.join(privateDir, "session.jsonl");
    writeFileSync(privateFile, "secret", { mode: 0o600 });
    const beforeMode = lstatSync(privateFile).mode & 0o7777;

    prepareRuntimeStateDirectory(runtime, process.getgid!());

    assert.equal(lstatSync(runtime).mode & 0o7777, 0o2770);
    assert.equal(
      lstatSync(privateFile).mode & 0o7777,
      beforeMode,
      "private Agent state must not be recursively chmod'ed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "container-owned shared workspace paths are validated without Worker chmod or chown",
  { skip: typeof process.getuid !== "function" || process.getuid() !== 0 },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "expert-container-owned-"));
    try {
      const source = path.join(root, "source");
      mkdirSync(source, { mode: 0o770 });
      const generated = path.join(source, "generated");
      mkdirSync(generated, { mode: 0o775 });
      const file = path.join(generated, "new.txt");
      writeFileSync(file, "new", { mode: 0o664 });
      chownSync(generated, EXECUTION_CONTAINER_UID, process.getgid!());
      chownSync(file, EXECUTION_CONTAINER_UID, process.getgid!());
      chmodSync(generated, 0o775);
      chmodSync(file, 0o664);
      const modeBefore = lstatSync(file).mode & 0o7777;

      const { grantExecutionContainerAccess } = await import("../src/expert-platform/repository-workspace.js");
      grantExecutionContainerAccess(source, "read-write", process.getgid!());
      assert.equal(lstatSync(file).uid, EXECUTION_CONTAINER_UID);
      assert.equal(lstatSync(file).mode & 0o7777, modeBefore);

      chmodSync(file, 0o644);
      grantExecutionContainerAccess(source, "read-write", process.getgid!());
      assert.equal(
        lstatSync(file).mode & 0o7777,
        0o644,
        "the next execution container reuses the same uid, so group-write is not required",
      );

      chmodSync(file, 0o600);
      assert.throws(
        () => grantExecutionContainerAccess(source, "read-write", process.getgid!()),
        /WORKER_CHECKOUT_PERMISSION_NOT_SHARED/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
