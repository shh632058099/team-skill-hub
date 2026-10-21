import assert from "node:assert/strict";
import { test } from "node:test";
import { runCodexProcess } from "../src/expert-platform/codex-process.js";

test("process runner collects bounded JSONL and parses successful result", async () => {
  const event = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");
  const result = await runCodexProcess({
    executable: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(event)})`],
    timeoutMs: 5000,
  });
  assert.equal(result, "done");
});

test("process runner rejects nonzero exit and limited output", async () => {
  await assert.rejects(
    () =>
      runCodexProcess({
        executable: process.execPath,
        args: ["-e", "process.exit(2)"],
        timeoutMs: 5000,
      }),
    /CODEX_PROCESS_FAILED/,
  );
  await assert.rejects(
    () =>
      runCodexProcess({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(10000))"],
        timeoutMs: 5000,
        maxOutputBytes: 100,
      }),
    /CODEX_OUTPUT_LIMIT/,
  );
});

test("process runner enforces deadline and abort", async () => {
  await assert.rejects(
    () =>
      runCodexProcess({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 100,
      }),
    /CODEX_TIMEOUT/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runCodexProcess({
        executable: process.execPath,
        args: ["--version"],
        timeoutMs: 5000,
        signal: controller.signal,
      }),
    /CODEX_CANCELLED/,
  );
});
