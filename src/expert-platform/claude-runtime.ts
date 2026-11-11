/** Claude Code worker uses a constrained tool allowlist. Bash, NotebookEdit and agent tools are never available. */
export type ClaudeRuntimeSessionOptions = { persist: boolean; resumeId?: string };

function validateRuntimeSessionId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) throw new Error("INVALID_RUNTIME_SESSION_ID");
  return normalized;
}

export function buildClaudeArgs(
  problem: string,
  model: string,
  stream = false,
  maxTurns = 12,
  permissions: "read-only" | "workspace-write" = "read-only",
  session?: ClaudeRuntimeSessionOptions,
): string[] {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("INVALID_CLAUDE_MAX_TURNS");
  if (
    !problem.trim() ||
    problem.length > 10000 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(model) ||
    model.length > 200
  )
    throw new Error("INVALID_CLAUDE_REQUEST");
  const resumeId = session?.resumeId ? validateRuntimeSessionId(session.resumeId) : undefined;
  if (resumeId && session?.persist !== true) throw new Error("INVALID_RUNTIME_SESSION");
  const tools = permissions === "workspace-write" ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep";
  return [
    "-p",
    ...(session?.persist ? [] : ["--no-session-persistence"]),
    ...(resumeId ? ["--resume", resumeId] : []),
    "--output-format",
    stream ? "stream-json" : "json",
    ...(stream ? ["--verbose"] : []),
    "--max-turns",
    String(maxTurns),
    "--model",
    model,
    "--permission-mode",
    "dontAsk",
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--",
    problem,
  ];
}

export function buildClaudeReadOnlyArgs(problem: string, model: string, stream = false, maxTurns = 12): string[] {
  return buildClaudeArgs(problem, model, stream, maxTurns, "read-only");
} /** Only completed, successful Claude -p --output-format=json results are accepted. */
export function parseClaudeResult(output: string): string {
  if (output.length > 4 * 1024 * 1024) throw new Error("CLAUDE_OUTPUT_LIMIT");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error("CLAUDE_INVALID_RESULT");
  }
  if (
    parsed.type !== "result" ||
    parsed.is_error !== false ||
    parsed.subtype !== "success" ||
    typeof parsed.result !== "string" ||
    !parsed.result.trim() ||
    parsed.result.length > 64000
  )
    throw new Error("CLAUDE_EXECUTION_FAILED");
  return parsed.result;
}
