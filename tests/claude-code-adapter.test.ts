import assert from "node:assert/strict";
import test from "node:test";
import { translateClaudeCodeHook } from "../src/claude-code-adapter.js";

test("Claude Code SessionStart maps to shared ClientEvent without transcript content", () => {
  const event = translateClaudeCodeHook({
    session_id: "claude-session",
    transcript_path: "/tmp/private-transcript.jsonl",
    cwd: "/workspace/ota",
    permission_mode: "default",
    hook_event_name: "SessionStart",
    source: "startup",
    model: "claude-sonnet"
  });
  assert.equal(event.client, "claude_code");
  assert.equal(event.event, "SessionStart");
  assert.equal(event.sessionId, "claude-session");
  assert.equal(event.cwd, "/workspace/ota");
  assert.equal(event.model, "claude-sonnet");
  assert.equal(event.metadata.source, "startup");
  assert.equal(event.metadata.transcript_path, undefined);
});

test("Claude Code prompt stores only bounded metadata, not raw prompt", () => {
  const event = translateClaudeCodeHook({
    session_id: "claude-session",
    prompt_id: "prompt-7",
    cwd: "/workspace/ota",
    hook_event_name: "UserPromptSubmit",
    prompt: "customer secret source code request"
  });
  assert.equal(event.turnId, "prompt-7");
  assert.equal(event.metadata.prompt_length, 35);
  assert.equal(event.metadata.prompt, undefined);
});

test("Claude Code PostToolUse extracts test evidence without persisting tool payloads", () => {
  const event = translateClaudeCodeHook({
    session_id: "claude-session",
    prompt_id: "prompt-8",
    cwd: "/workspace/ota",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-8",
    tool_input: { command: "npm test -- --token super-secret" },
    tool_response: "ℹ tests 12\nℹ suites 0\nℹ pass 12\nℹ fail 0\n",
    duration_ms: 840
  });
  assert.equal(event.metadata.tool_name, "Bash");
  assert.equal(event.metadata.tool_use_id, "tool-8");
  assert.deepEqual(event.metadata.evidence, {
    success: true,
    exit_code: 0,
    tests_run: 12,
    tests_passed: 12,
    tests_failed: 0,
    duration_ms: 840
  });
  assert.equal(event.metadata.tool_input, undefined);
  assert.equal(event.metadata.tool_response, undefined);
});

test("Claude Code Stop maps final assistant message for existing Candidate detector", () => {
  const event = translateClaudeCodeHook({
    session_id: "claude-session",
    prompt_id: "prompt-9",
    cwd: "/workspace/ota",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Verified OTA recovery result."
  });
  assert.equal(event.event, "Stop");
  assert.equal(event.metadata.stop_hook_active, false);
  assert.equal(event.metadata.assistant_result_excerpt, "Verified OTA recovery result.");
});

test("Claude Code adapter rejects unsupported lifecycle events", () => {
  assert.throws(
    () =>
      translateClaudeCodeHook({
        session_id: "claude-session",
        hook_event_name: "Notification"
      }),
    /Unsupported Claude Code hook event/
  );
});
