/** Claude Code worker uses a read-only bind mount plus an explicit read-only tool allowlist.
 * Bash, Write, Edit, NotebookEdit and agent tools are never available. Deployment-approved read-only MCP tools may be appended.
 */
export function buildClaudeReadOnlyArgs(problem: string, model: string, stream = false, maxTurns = 12): string[] {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) throw new Error("INVALID_CLAUDE_MAX_TURNS");
  if (
    !problem.trim() ||
    problem.length > 10000 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(model) ||
    model.length > 200
  )
    throw new Error("INVALID_CLAUDE_REQUEST");
  return [
    "-p",
    "--no-session-persistence",
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
    "Read,Glob,Grep",
    "--allowedTools",
    "Read,Glob,Grep",
    "--",
    problem,
  ];
}

/** Only completed, successful Claude -p --output-format=json results are accepted. */
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
