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
        "runtime_version=1.1.0",
        "hook_schema_version=1",
        ""
      ].join("\n"),
      "utf8"
    );
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "sess-hook-test",
      turn_id: "turn-hook-test",
      cwd: temp,
      tool_name: "Bash",
      tool_use_id: "tool-hook-test",
      tool_response: {
        aggregated_output:
          "test_one ... ok\ntest_two ... ok\ntest_three ... ok\n\nRan 3 tests in 0.001s\n\nOK\n",
        exit_code: 0
      }
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["scripts/team-skill-hub-hook.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEAM_SKILL_HUB_HOOK_CONFIG: config,
          TEST_HOOK_MARKER: "test-marker"
        },
        stdio: ["pipe", "pipe", "pipe"]
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
      status: "passed"
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
