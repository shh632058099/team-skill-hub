import {
  CURRENT_HOOK_RUNTIME_VERSION,
  CURRENT_HOOK_SCHEMA_VERSION
} from "./client-events.js";

export const CLAUDE_CODE_ADAPTER_VERSION = "1.0.0";

export interface ClaudeCodeClientEvent {
  schemaVersion: number;
  client: "claude_code";
  event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd";
  sessionId: string;
  turnId?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  metadata: Record<string, unknown>;
}

const SUPPORTED_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd"
]);

function boundedText(value: unknown, max = 32_000): string {
  if (typeof value === "string") return value.slice(0, max);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return "";
  }
}

function testCounts(text: string): { run?: number; passed?: number; failed?: number } {
  const tokens = text
    .toLowerCase()
    .replaceAll(",", " ")
    .replaceAll(":", " ")
    .replaceAll("%", " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);

  const after = (...labels: string[]): number | undefined => {
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (!labels.includes(tokens[index]!)) continue;
      const value = Number(tokens[index + 1]);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const before = (...labels: string[]): number | undefined => {
    for (let index = 1; index < tokens.length; index += 1) {
      if (!labels.includes(tokens[index]!)) continue;
      const value = Number(tokens[index - 1]);
      if (Number.isFinite(value)) return value;
    }
    return undefined;
  };

  const run = after("tests", "test") ?? before("total");
  const passed = after("pass") ?? before("passed");
  const failed = after("fail") ?? before("failed");
  if (run !== undefined || passed !== undefined || failed !== undefined) {
    return {
      ...(run !== undefined ? { run } : {}),
      ...(passed !== undefined ? { passed } : {}),
      ...(failed !== undefined ? { failed } : {})
    };
  }
  return {};
}

function postToolEvidence(input: Record<string, unknown>): Record<string, unknown> {
  const counts = testCounts(boundedText(input.tool_response));
  return {
    success: true,
    exit_code: 0,
    ...(counts.run !== undefined ? { tests_run: counts.run } : {}),
    ...(counts.passed !== undefined ? { tests_passed: counts.passed } : {}),
    ...(counts.failed !== undefined ? { tests_failed: counts.failed } : {}),
    ...(typeof input.duration_ms === "number" ? { duration_ms: input.duration_ms } : {})
  };
}

export function translateClaudeCodeHook(raw: unknown): ClaudeCodeClientEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Claude Code hook payload must be an object");
  }
  const input = raw as Record<string, unknown>;
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!SUPPORTED_EVENTS.has(event)) throw new Error("Unsupported Claude Code hook event: " + event);
  if (!sessionId) throw new Error("Claude Code hook session_id is required");

  const metadata: Record<string, unknown> = {
    runtime_version: CURRENT_HOOK_RUNTIME_VERSION,
    hook_schema_version: CURRENT_HOOK_SCHEMA_VERSION,
    adapter: "claude-code-http",
    adapter_version: CLAUDE_CODE_ADAPTER_VERSION,
    claude_hook_event: event
  };
  for (const key of ["source", "reason", "agent_id", "agent_type"]) {
    const value = input[key];
    if (typeof value === "string" && value) metadata[key] = value.slice(0, 300);
  }
  if (typeof input.prompt_id === "string") metadata.prompt_id = input.prompt_id.slice(0, 200);
  if (event === "UserPromptSubmit" && typeof input.prompt === "string") metadata.prompt_length = input.prompt.length;
  if (event === "PostToolUse") {
    if (typeof input.tool_name === "string") metadata.tool_name = input.tool_name.slice(0, 160);
    if (typeof input.tool_use_id === "string") metadata.tool_use_id = input.tool_use_id.slice(0, 240);
    metadata.evidence = postToolEvidence(input);
  }
  if (event === "Stop") {
    if (typeof input.stop_hook_active === "boolean") metadata.stop_hook_active = input.stop_hook_active;
    if (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim()) {
      metadata.assistant_result_excerpt = input.last_assistant_message.trim().slice(0, 4000);
    }
  }

  return {
    schemaVersion: CURRENT_HOOK_SCHEMA_VERSION,
    client: "claude_code",
    event: event as ClaudeCodeClientEvent["event"],
    sessionId,
    ...(typeof input.prompt_id === "string" && input.prompt_id ? { turnId: input.prompt_id } : {}),
    ...(typeof input.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
    ...(event === "SessionStart" && typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof input.permission_mode === "string" ? { permissionMode: input.permission_mode } : {}),
    metadata
  };
}
