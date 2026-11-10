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
      assert.ok(args.includes("--cap-drop"));
      assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
      assert.ok(args.includes("no-new-privileges"));
      const mount = args[args.indexOf("--mount") + 1]!;
      assert.match(mount, /dst=\/workspace,readonly$/);
      assert.equal(args[args.indexOf("--entrypoint") + 1], "node");
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
