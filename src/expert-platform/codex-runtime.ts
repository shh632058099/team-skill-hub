export type RuntimeSessionOptions = { persist: boolean; resumeId?: string };

function validateRuntimeSessionId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) throw new Error("INVALID_RUNTIME_SESSION_ID");
  return normalized;
}

export function buildCodexArgs(
  problem: string,
  permissions: "read-only" | "workspace-write",
  session?: RuntimeSessionOptions,
): string[] {
  if (!problem.trim() || problem.length > 10_000) throw new Error("INVALID_REQUEST");
  const resumeId = session?.resumeId ? validateRuntimeSessionId(session.resumeId) : undefined;
  if (resumeId && session?.persist !== true) throw new Error("INVALID_RUNTIME_SESSION");
  if (resumeId) {
    return [
      "exec",
      "resume",
      "-c",
      `sandbox_mode="${permissions}"`,
      "--json",
      "--skip-git-repo-check",
      resumeId,
      problem,
    ];
  }
  return [
    "exec",
    "--sandbox",
    permissions,
    ...(session?.persist ? [] : ["--ephemeral"]),
    "--json",
    "--skip-git-repo-check",
    problem,
  ];
}

export function buildCodexReadOnlyArgs(problem: string): string[] {
  return buildCodexArgs(problem, "read-only");
}
export function parseCodexJsonlResult(jsonl: string): string {
  if (jsonl.length > 4 * 1024 * 1024) throw new Error("CODEX_OUTPUT_LIMIT");
  let succeeded = false;
  let failed = false;
  let lastMessage: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error("CODEX_INVALID_EVENT");
    }
    if (event.type === "turn.failed" || event.type === "error") failed = true;
    if (event.type === "turn.completed") succeeded = true;
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string" && item.text.length <= 64_000) {
        lastMessage = item.text;
      }
    }
  }
  if (failed || (!succeeded && jsonl.includes("turn.failed"))) throw new Error("CODEX_TURN_FAILED");
  if (!succeeded || !lastMessage) throw new Error("CODEX_RESULT_MISSING");
  return lastMessage;
}
