import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Claude Stop Hook posts a redacted minimal Stop event", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-claude-stop-"));
  let received: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      assert.equal(request.headers.authorization, "Bearer test-marker");
      received = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const config = path.join(temp, "team-skill-hub.conf");
    await writeFile(
      config,
      [
        `event_url=http://127.0.0.1:${address.port}/client-events/claude-code`,
        "api_key_env=TEST_CLAUDE_HOOK_MARKER",
        "capture_stop_message=true",
        "",
      ].join("\n"),
      "utf8",
    );

    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "claude-stop-session",
      prompt_id: "prompt-17",
      cwd: "/workspace/ota",
      permission_mode: "default",
      stop_hook_active: false,
      transcript_path: "/private/transcript.jsonl",
      prompt: "customer secret prompt",
      last_assistant_message: "Verified OTA result. email=biao@example.com token=skh_secret_value",
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", ["scripts/team-skill-hub-claude-stop.sh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEAM_SKILL_HUB_HOOK_CONFIG: config,
          TEST_CLAUDE_HOOK_MARKER: "test-marker",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Claude Stop Hook exited ${code}: ${stderr}`));
      });
      child.stdin.end(payload);
    });

    assert.ok(received);
    assert.equal(received.hook_event_name, "Stop");
    assert.equal(received.session_id, "claude-stop-session");
    assert.equal(received.prompt_id, "prompt-17");
    assert.equal(received.last_assistant_message, "Verified OTA result. email=[redacted-email] token=[redacted]");
    assert.equal(received.transcript_path, undefined);
    assert.equal(received.prompt, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
