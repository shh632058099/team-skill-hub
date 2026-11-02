import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("process runner classifies sandbox failures without logging raw stderr", async () => {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await assert.rejects(
      () =>
        runCodexProcess({
          executable: process.execPath,
          args: [
            "-e",
            "process.stderr.write('bwrap: No permissions to create a new namespace; private detail'); process.exit(2)",
          ],
          timeoutMs: 5000,
        }),
      /CODEX_PROCESS_FAILED/,
    );
  } finally {
    console.error = originalError;
  }
  assert.ok(logs.some((line) => line.includes('"errorCode":"SANDBOX_INIT_FAILED"')));
  assert.ok(logs.every((line) => !line.includes("private detail")));
});

test("process runner distinguishes Docker host config permission without logging path details", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await assert.rejects(
      () =>
        runCodexProcess({
          executable: process.execPath,
          args: [
            "-e",
            "process.stderr.write('WARNING: Error loading config file: open /root/.docker/config.json: permission denied'); process.exit(1)",
          ],
          timeoutMs: 5000,
        }),
      /CODEX_PROCESS_FAILED/,
    );
  } finally {
    console.error = original;
  }
  assert.ok(logs.some((line) => line.includes('"errorCode":"DOCKER_CONFIG_PERMISSION"')));
  assert.ok(logs.every((line) => !line.includes("/root/.docker/config.json")));
});

test("process runner reports only a fixed access target category", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await assert.rejects(
      () =>
        runCodexProcess({
          executable: process.execPath,
          args: ["-e", "process.stderr.write('EACCES: permission denied, open /run/expert-mcp.json'); process.exit(1)"],
          timeoutMs: 5000,
        }),
      /CODEX_PROCESS_FAILED/,
    );
  } finally {
    console.error = original;
  }
  assert.ok(logs.some((line) => line.includes('"accessTarget":"MCP_CONFIG"')));
  assert.ok(logs.every((line) => !line.includes("/run/expert-mcp.json")));
});

test("Codex JSONL model errors receive a fixed code without exposing response text", async () => {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await assert.rejects(
      () =>
        runCodexProcess({
          executable: process.execPath,
          args: [
            "-e",
            "console.log(JSON.stringify({type:'turn.failed',error:{message:'HTTP 429 quota exceeded secret-example'}})); process.exit(1)",
          ],
          timeoutMs: 5000,
          streamingBackend: "codex",
        }),
      /CODEX_PROCESS_FAILED/,
    );
  } finally {
    console.error = original;
  }
  assert.ok(logs.some((line) => line.includes('"errorCode":"MODEL_RATE_LIMITED"')));
  assert.ok(logs.every((line) => !line.includes("secret-example")));
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

test("process runner abort kills the subprocess process group, including child processes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-abort-tree-"));
  const pidFile = path.join(dir, "child.pid");
  const controller = new AbortController();
  try {
    const running = runCodexProcess({
      executable: process.execPath,
      args: [
        "-e",
        `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`,
      ],
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(pidFile), "child process should have started");
    const childPid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    await assert.rejects(() => running, /CODEX_CANCELLED/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "child process should be terminated with the process group");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process runner awaits container cleanup hook before reporting cancellation", async () => {
  const controller = new AbortController();
  let cleanupCalled = false;
  const running = runCodexProcess({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    timeoutMs: 5000,
    signal: controller.signal,
    onAbort: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      cleanupCalled = true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  await assert.rejects(() => running, /CODEX_CANCELLED/);
  assert.equal(cleanupCalled, true);
});
