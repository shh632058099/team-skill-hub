import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runVerificationPolicy } from "../src/expert-platform/verification-runner.js";

test("verification runner executes steps only through an isolated read-only Docker container", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-runner-"));
  try {
    const calls: string[][] = [];
    const results = await runVerificationPolicy(
      root,
      [
        {
          id: "pass",
          type: "command",
          argv: ["node", "-e", "process.exit(0)"],
          timeoutMs: 2_000,
          evidenceType: "unit_test",
        },
        {
          id: "fail",
          type: "command",
          argv: ["node", "-e", "process.exit(7)"],
          timeoutMs: 2_000,
          evidenceType: "lint",
        },
      ],
      new AbortController().signal,
      {
        image: "expert-worker:test",
        containerNamePrefix: "verify-task-run",
        primaryGroupId: 988,
        supplementalGroupId: 988,
        tmpfsSizeMb: 1024,
        runDocker: async (args) => {
          calls.push([...args]);
          return {
            exitCode: args.includes("process.exit(7)") ? 7 : 0,
            timedOut: false,
          };
        },
      },
    );

    assert.equal(calls.length, 2);
    for (const args of calls) {
      assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--name", args[3]!]);
      assert.ok(args.includes("--network"));
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.ok(args.includes("--read-only"));
      assert.ok(args.some((arg, index) => arg === "--user" && args[index + 1] === "10001:988"));
      assert.ok(!args.includes("--group-add"));
      assert.ok(args.includes("/home/expert:rw,uid=10001,gid=988,size=64m"));
      assert.ok(args.includes("/tmp:rw,exec,uid=10001,gid=988,size=1024m"));
      assert.ok(args.includes("--cap-drop"));
      assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
      assert.ok(args.includes("no-new-privileges"));
      const mount = args[args.indexOf("--mount") + 1]!;
      assert.match(mount, /dst=\/workspace,readonly$/);
      assert.equal(args[args.indexOf("--entrypoint") + 1], "node");
      assert.ok(args.includes("GIT_CONFIG_COUNT=1"));
      assert.ok(args.includes("GIT_CONFIG_KEY_0=safe.directory"));
      assert.ok(args.includes("GIT_CONFIG_VALUE_0=/workspace"));
      const imageIndex = args.indexOf("expert-worker:test");
      assert.ok(imageIndex > 0);
      assert.equal(args[imageIndex + 1], "-e");
      assert.doesNotMatch(args.join(" "), /HTTP_PROXY|API_KEY|TOKEN|credential/i);
    }

    assert.deepEqual(
      results.map((result) => ({
        stepId: result.stepId,
        evidenceType: result.evidenceType,
        status: result.status,
        exitCode: result.exitCode,
        errorCode: result.errorCode,
      })),
      [
        { stepId: "pass", evidenceType: "unit_test", status: "passed", exitCode: 0, errorCode: null },
        { stepId: "fail", evidenceType: "lint", status: "failed", exitCode: 7, errorCode: "VERIFICATION_EXIT_NONZERO" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-uid-v2 verification uses Worker uid/gid without supplemental groups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-single-uid-"));
  try {
    let seen: readonly string[] = [];
    await runVerificationPolicy(
      root,
      [{ id: "test", type: "command", argv: ["true"], timeoutMs: 2000, evidenceType: "unit_test" }],
      new AbortController().signal,
      {
        image: "expert-worker:test",
        containerNamePrefix: "verify-single-uid",
        runAsUid: 999,
        runAsGid: 988,
        supplementalGroupId: 1234,
        primaryGroupId: 988,
        runDocker: async (args: readonly string[]) => {
          seen = args;
          return { exitCode: 0, timedOut: false };
        },
      } as any,
    );
    assert.ok(seen.some((arg, index) => arg === "--user" && seen[index + 1] === "999:988"));
    assert.ok(!seen.includes("--group-add"));
    assert.ok(seen.includes("/tmp:rw,exec,uid=999,gid=988,size=1024m"));
    assert.ok(seen.includes("/home/expert:rw,uid=999,gid=988,size=64m"));
    const mount = seen[seen.indexOf("--mount") + 1]!;
    assert.match(mount, /dst=\/workspace,readonly$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single-uid-v2 verification rejects root identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-root-"));
  try {
    await assert.rejects(
      runVerificationPolicy(
        root,
        [{ id: "test", type: "command", argv: ["true"], timeoutMs: 2000, evidenceType: "unit_test" }],
        new AbortController().signal,
        {
          image: "expert-worker:test",
          containerNamePrefix: "verify-root",
          runAsUid: 0,
          runAsGid: 988,
          runDocker: async () => ({ exitCode: 0, timedOut: false }),
        } as any,
      ),
      /INVALID_VERIFICATION_IDENTITY/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runner rejects unsafe scratch tmpfs sizes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-scratch-"));
  try {
    const policy = [
      {
        id: "build",
        type: "command" as const,
        argv: ["true"],
        timeoutMs: 2_000,
        evidenceType: "build",
      },
    ];
    for (const tmpfsSizeMb of [0, 63, 4097, 1.5]) {
      await assert.rejects(
        runVerificationPolicy(root, policy, new AbortController().signal, {
          image: "expert-worker:test",
          containerNamePrefix: "verify-scratch",
          tmpfsSizeMb,
          runDocker: async () => ({ exitCode: 0, timedOut: false }),
        }),
        /INVALID_VERIFICATION_TMPFS_SIZE/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runner reports container timeout and propagates cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-timeout-"));
  try {
    const timeout = await runVerificationPolicy(
      root,
      [
        {
          id: "timeout",
          type: "command",
          argv: ["node", "-e", "setTimeout(() => {}, 10_000)"],
          timeoutMs: 100,
          evidenceType: "integration_test",
        },
      ],
      new AbortController().signal,
      {
        image: "expert-worker:test",
        containerNamePrefix: "verify-timeout",
        runDocker: async () => ({ exitCode: null, timedOut: true }),
      },
    );
    assert.equal(timeout[0]!.status, "failed");
    assert.equal(timeout[0]!.errorCode, "VERIFICATION_TIMEOUT");

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runVerificationPolicy(
        root,
        [
          {
            id: "cancel",
            type: "command",
            argv: ["node", "-e", "process.exit(0)"],
            timeoutMs: 2_000,
            evidenceType: "unit_test",
          },
        ],
        controller.signal,
        {
          image: "expert-worker:test",
          containerNamePrefix: "verify-cancel",
          runDocker: async () => ({ exitCode: 0, timedOut: false }),
        },
      ),
      /VERIFICATION_CANCELLED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
