import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Codex submission hook denies when config decoding fails", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-hook-"));
  const config = path.join(temp, "bad.conf");
  try {
    await writeFile(config, Buffer.from([0xff, 0xfe]));
    const child = spawn("python3", ["scripts/codex/expert-session-hook.py"], {
      env: { ...process.env, TEAM_SKILL_HUB_HOOK_CONFIG: config, TEST_CODEX_HOOK_KEY: "secret" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "01a18fc5-3678-7ac2-920f-de4a707e5a1b",
          tool_name: "mcp__teamSkillHub__submit_expert_task_auto",
          tool_input: { problem: "test", idempotencyKey: "test-key" },
        }),
      );
    });
    assert.equal(code, 0);
    const result = JSON.parse(output).hookSpecificOutput;
    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /could not safely attach/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex setup hook merge has no unconditional Node-only merge step", async () => {
  const source = await readFile("scripts/setup-codex-mcp.sh", "utf8");
  assert.match(
    source,
    /if command -v node[\s\S]*?const matcher =[\s\S]*?NODE\n[ ]*elif command -v python3[\s\S]*?PYHOOK/,
  );
});
