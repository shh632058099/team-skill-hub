import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Codex shell hook posts structured unittest evidence", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-hook-"));
  const config = path.join(temp, "team-skill-hub.conf");
  let received: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await writeFile(
      config,
      [
        `event_url=http://127.0.0.1:${address.port}/client-events`,
        "server_name=teamSkillHub",
        "api_key_env=TEST_HOOK_MARKER",
        "capture_stop_message=true",
        "runtime_version=1.2.0",
        "hook_schema_version=1",
        "",
      ].join("\n"),
      "utf8",
    );
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "sess-hook-test",
      turn_id: "turn-hook-test",
      cwd: temp,
      tool_name: "Bash",
      tool_use_id: "tool-hook-test",
      tool_response: {
        aggregated_output: "test_one ... ok\ntest_two ... ok\ntest_three ... ok\n\nRan 3 tests in 0.001s\n\nOK\n",
        exit_code: 0,
      },
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["scripts/team-skill-hub-hook.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEAM_SKILL_HUB_HOOK_CONFIG: config,
          TEST_HOOK_MARKER: "test-marker",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`hook exited ${code}: ${stderr}`));
      });
      child.stdin.end(payload);
    });

    assert.ok(received);
    const metadata = received.metadata as Record<string, unknown>;
    assert.equal(received.event, "PostToolUse");
    assert.equal(received.session_id, "sess-hook-test");
    assert.deepEqual(metadata.evidence, {
      exit_code: 0,
      tests_run: 3,
      tests_passed: 3,
      tests_failed: 0,
      success: true,
      status: "passed",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex shell hook classifies Bash command without persisting raw command text", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-hook-category-"));
  const config = path.join(temp, "team-skill-hub.conf");
  let received: Record<string, any> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await writeFile(
      config,
      [
        `event_url=http://127.0.0.1:${address.port}/client-events`,
        "server_name=teamSkillHub",
        "api_key_env=TEST_HOOK_MARKER",
        "capture_stop_message=true",
        "runtime_version=1.4.0",
        "hook_schema_version=1",
        "",
      ].join("\n"),
      "utf8",
    );
    const secretCommand = "npm test -- --token super-secret-value";
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "sess-hook-category",
      turn_id: "turn-hook-category",
      cwd: temp,
      tool_name: "Bash",
      tool_use_id: "tool-hook-category",
      tool_input: { command: secretCommand },
      tool_response: { aggregated_output: "tests completed successfully", exit_code: 0 },
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["scripts/team-skill-hub-hook.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEAM_SKILL_HUB_HOOK_CONFIG: config,
          TEST_HOOK_MARKER: "test-marker",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))));
      child.stdin.end(payload);
    });
    assert.ok(received);
    assert.equal(received.metadata.evidence.command_category, "test");
    assert.equal(received.metadata.evidence.exit_code, 0);
    assert.equal(received.metadata.evidence.success, true);
    assert.equal(JSON.stringify(received).includes("super-secret-value"), false);
    assert.equal(received.metadata.tool_input, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex hook extracts Node test runner pass/fail summary", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-hook-node-test-"));
  const config = path.join(temp, "team-skill-hub.conf");
  let received: Record<string, any> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await writeFile(
      config,
      [
        `event_url=http://127.0.0.1:${address.port}/client-events`,
        "server_name=teamSkillHub",
        "api_key_env=TEST_HOOK_MARKER",
        "capture_stop_message=true",
        "runtime_version=1.5.0",
        "hook_schema_version=1",
        "",
      ].join("\n"),
      "utf8",
    );
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "sess-node-test",
      turn_id: "turn-node-test",
      cwd: temp,
      tool_name: "Bash",
      tool_use_id: "tool-node-test",
      tool_input: { command: "npm test" },
      tool_response: "\n✔ add returns the sum (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ duration_ms 82\n",
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["scripts/team-skill-hub-hook.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEAM_SKILL_HUB_HOOK_CONFIG: config,
          TEST_HOOK_MARKER: "test-marker",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))));
      child.stdin.end(payload);
    });
    assert.ok(received);
    assert.deepEqual(received.metadata.evidence, {
      command_category: "test",
      tests_passed: 1,
      tests_failed: 0,
      tests_run: 1,
      success: true,
      status: "passed",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
