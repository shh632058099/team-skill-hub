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
          tool_name: "mcp__teamSkillHub__submit_work",
          tool_input: { title: "test", description: "test", idempotencyKey: "test-key" },
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

test("Codex deprecated ExpertTask submission tools are not intercepted", async () => {
  const session = "01a18fc5-3678-7ac2-920f-de4a707e5a1b";
  for (const tool_name of ["mcp__teamSkillHub__submit_expert_task", "mcp__teamSkillHub__submit_expert_task_auto"]) {
    const child = spawn("python3", ["scripts/codex/expert-session-hook.py"], {
      env: { ...process.env, TEAM_SKILL_HUB_API_KEY: "test-secret" },
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
          session_id: session,
          tool_name,
          tool_input: { problem: "legacy", idempotencyKey: "legacy-key" },
        }),
      );
    });
    assert.equal(code, 0);
    assert.equal(output, "");
  }
});

test("Codex UserPromptSubmit no longer maintains legacy ExpertTask request state", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-request-state-disabled-"));
  const session = "01a18fc5-3678-7ac2-920f-de4a707e5a1b";
  try {
    const child = spawn("python3", ["scripts/codex/expert-session-hook.py"], {
      env: { ...process.env, TEAM_SKILL_HUB_REQUEST_STATE_DIR: temp, TEAM_SKILL_HUB_API_KEY: "test-secret" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: "turn-1" }));
    });
    assert.equal(code, 0);
    assert.equal(output, "");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("Codex hook signs submit_work and update_work_source with the native session", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "codex-work-hook-"));
  const session = "01a18fc5-3678-7ac2-920f-de4a707e5a1b";
  const env = { ...process.env, TEAM_SKILL_HUB_REQUEST_STATE_DIR: temp, TEAM_SKILL_HUB_API_KEY: "test-secret" };
  const runHook = async (tool_name: string, tool_input: object) => {
    const child = spawn("python3", ["scripts/codex/expert-session-hook.py"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, tool_name, tool_input }));
    });
    assert.equal(code, 0);
    return JSON.parse(output).hookSpecificOutput;
  };
  try {
    for (const [tool, input] of [
      ["mcp__teamSkillHub__submit_work", { title: "x", description: "y", idempotencyKey: "work-key" }],
      [
        "mcp__teamSkillHub__update_work_source",
        { workItemId: "11111111-1111-4111-8111-111111111111", state: "terminal" },
      ],
    ] as const) {
      const result = await runHook(tool, input);
      assert.equal(result.permissionDecision, "allow");
      assert.equal(result.updatedInput.clientSessionId, session);
      assert.match(result.updatedInput.clientSessionProof, /^\d{13}\.[a-f0-9]{64}$/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
