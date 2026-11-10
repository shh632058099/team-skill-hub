import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runVerificationPolicy } from "../src/expert-platform/verification-runner.js";

test("verification runner returns structured pass/fail results without a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-runner-"));
  try {
    const results = await runVerificationPolicy(
      root,
      [
        {
          id: "pass",
          type: "command",
          argv: [process.execPath, "-e", "process.exit(0)"],
          timeoutMs: 2_000,
          evidenceType: "unit_test",
        },
        {
          id: "fail",
          type: "command",
          argv: [process.execPath, "-e", "process.exit(7)"],
          timeoutMs: 2_000,
          evidenceType: "lint",
        },
      ],
      new AbortController().signal,
    );

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
    assert.ok(results.every((result) => result.durationMs >= 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification runner reports timeout and propagates cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-timeout-"));
  try {
    const timeout = await runVerificationPolicy(
      root,
      [
        {
          id: "timeout",
          type: "command",
          argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
          timeoutMs: 100,
          evidenceType: "integration_test",
        },
      ],
      new AbortController().signal,
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
            argv: [process.execPath, "-e", "process.exit(0)"],
            timeoutMs: 2_000,
            evidenceType: "unit_test",
          },
        ],
        controller.signal,
      ),
      /VERIFICATION_CANCELLED/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
