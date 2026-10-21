export function buildCodexReadOnlyArgs(problem: string): string[] {
  if (!problem.trim() || problem.length > 10_000) throw new Error("INVALID_REQUEST");
  return ["exec", "--sandbox", "read-only", "--ephemeral", "--json", "--skip-git-repo-check", problem];
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
