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

test("Codex UserPromptSubmit identity is reused by PreToolUse and signed with v2", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-request-state-"));
  const session = "01a18fc5-3678-7ac2-920f-de4a707e5a1b";
  const env = { ...process.env, TEAM_SKILL_HUB_REQUEST_STATE_DIR: temp, TEAM_SKILL_HUB_API_KEY: "test-secret" };
  const runHook = async (payload: object) => {
    const child = spawn("python3", ["scripts/codex/expert-session-hook.py"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(JSON.stringify(payload));
    });
    assert.equal(code, 0);
    return output ? JSON.parse(output).hookSpecificOutput : undefined;
  };
  try {
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: "turn-native-1" });
    const result = await runHook({
      hook_event_name: "PreToolUse",
      session_id: session,
      tool_name: "mcp__teamSkillHub__submit_expert_task_auto",
      tool_input: { problem: "rephrased", idempotencyKey: "different-key" },
    });
    assert.match(result.updatedInput.sourceRequestId, /^srq_[a-f0-9]{64}$/);
    assert.match(result.updatedInput.clientSessionProof, /^\d{13}\.[a-f0-9]{64}$/);
    assert.equal(result.permissionDecision, "allow");
    const replay = await runHook({
      hook_event_name: "PreToolUse",
      session_id: session,
      tool_name: "mcp__teamSkillHub__submit_expert_task_auto",
      tool_input: { problem: "changed words", idempotencyKey: "another-key" },
    });
    assert.equal(replay.updatedInput.sourceRequestId, result.updatedInput.sourceRequestId);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex prompt without turn_id clears prior request state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-request-state-reset-"));
  const session = "01a18fc5-3678-7ac2-920f-de4a707e5a1b";
  const env = { ...process.env, TEAM_SKILL_HUB_REQUEST_STATE_DIR: temp, TEAM_SKILL_HUB_API_KEY: "test-secret" };
  const runHook = async (payload: object) => {
    const child = spawn("python3", ["scripts/codex/expert-session-hook.py"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(JSON.stringify(payload));
    });
    assert.equal(code, 0);
    return output ? JSON.parse(output).hookSpecificOutput : undefined;
  };
  try {
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: "turn-old" });
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: session });
    const result = await runHook({
      hook_event_name: "PreToolUse",
      session_id: session,
      tool_name: "mcp__teamSkillHub__submit_expert_task_auto",
      tool_input: { problem: "new", idempotencyKey: "new" },
    });
    assert.equal(result.updatedInput.sourceRequestId, undefined);
    assert.match(result.updatedInput.clientSessionProof, /^\d{13}\.[a-f0-9]{64}$/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
