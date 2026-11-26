/** Safe bounded activity metadata; visible assistant text may be previewed, never thinking blocks or tool arguments. */
export type ActivityTool = "Read" | "Glob" | "Grep" | "other";
export type ActivityKind =
  "model.started" | "model.active" | "model.output" | "model.completed" | "model.failed" | "tool.activity";
export interface ExecutionActivity {
  kind: ActivityKind;
  tool?: ActivityTool;
  count?: number;
  details?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function safeTool(raw: unknown): ActivityTool {
  return raw === "Read" || raw === "Glob" || raw === "Grep" ? raw : "other";
}

export function sanitizeModelOutputPreview(raw: string, maxChars = 1600): string {
  const printable = Array.from(raw.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return character === "\n" || character === "\t" || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
  const cleaned = printable
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, name: string) => name + "=[REDACTED]",
    )
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, Math.max(0, maxChars - 13)) + "…[truncated]";
}

export function classifyModelFailureEvent(raw: unknown): string | null {
  const event = object(raw);
  if (!event) return null;
  if (event.type !== "error" && event.type !== "turn.failed" && !(event.type === "result" && event.is_error === true))
    return null;
  const failure = object(event.error);
  const code = failure?.code;
  if (code === "insufficient_quota") return "MODEL_QUOTA_EXCEEDED";
  const message =
    typeof failure?.message === "string"
      ? failure.message
      : typeof event.message === "string"
        ? event.message
        : typeof event.result === "string"
          ? event.result
          : "";
  if (!message) return "MODEL_REQUEST_FAILED";
  if (/401|unauthorized|invalid.api.key|authentication/i.test(message)) return "AUTHENTICATION_FAILED";
  if (/403|access.denied|forbidden/i.test(message)) return "MODEL_ACCESS_DENIED";
  if (/429|rate.limit|quota/i.test(message)) return "MODEL_RATE_LIMITED";
  if (/model.*(not.found|unsupported)|404/i.test(message)) return "MODEL_NOT_FOUND";
  if (/proxy|ECONNREFUSED|ENOTFOUND|TLS|certificate|connection|timeout/i.test(message)) return "MODEL_NETWORK_FAILED";
  return "MODEL_REQUEST_FAILED";
}

/** CLI-version tolerant event adapter. Unsupported events never reach the Hub. */
export function mapExecutionActivity(backend: "claude" | "codex", raw: unknown): ExecutionActivity[] {
  const event = object(raw);
  if (!event) return [];
  if (backend === "claude") {
    if (event.type === "system" && event.subtype === "init") return [{ kind: "model.started" }];
    if (event.type === "result") {
      if (event.is_error === false && event.subtype === "success") return [{ kind: "model.completed" }];
      return [{ kind: "model.failed", details: classifyModelFailureEvent(event) ?? "MODEL_REQUEST_FAILED" }];
    }
    if (event.type !== "assistant") return [];
    const message = object(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const activities: ExecutionActivity[] = [];
    for (const rawBlock of content) {
      const block = object(rawBlock);
      if (!block) continue;
      if (block.type === "tool_use") {
        activities.push({ kind: "tool.activity", tool: safeTool(block.name), count: 1 });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        const details = sanitizeModelOutputPreview(block.text);
        if (details) activities.push({ kind: "model.output", details });
      }
    }
    return activities.length ? activities : [{ kind: "model.active" }];
  }
  if (event.type === "thread.started" || event.type === "turn.started") return [{ kind: "model.started" }];
  if (event.type === "turn.completed") return [{ kind: "model.completed" }];
  if (event.type === "turn.failed" || event.type === "error")
    return [{ kind: "model.failed", details: classifyModelFailureEvent(event) ?? "MODEL_REQUEST_FAILED" }];
  if (event.type !== "item.started" && event.type !== "item.completed") return [];
  const item = object(event.item);
  if (!item) return [];
  if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
    const details = sanitizeModelOutputPreview(item.text);
    return details ? [{ kind: "model.output", details }] : [];
  }
  if (
    event.type === "item.started" &&
    (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call")
  ) {
    return [{ kind: "tool.activity", tool: "other", count: 1 }];
  }
  return [];
}

/** Only successful, complete CLI results may be used as the final report. */
export class StreamResultCollector {
  private lastReport: string | undefined;
  private completed = false;
  private failed = false;
  private results = 0;
  private runtimeSessionId: string | undefined;
  constructor(private readonly backend: "claude" | "codex") {}

  accept(raw: unknown): void {
    const event = object(raw);
    if (!event) throw new Error("EXPERT_INVALID_STREAM_EVENT");
    const candidate =
      this.backend === "claude"
        ? typeof event.session_id === "string"
          ? event.session_id
          : undefined
        : event.type === "thread.started" && typeof event.thread_id === "string"
          ? event.thread_id
          : undefined;
    if (candidate !== undefined) {
      const normalized = candidate.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) throw new Error("INVALID_RUNTIME_SESSION_ID");
      if (this.runtimeSessionId && this.runtimeSessionId !== normalized) throw new Error("RUNTIME_SESSION_MISMATCH");
      this.runtimeSessionId = normalized;
    }
    if (this.backend === "claude") {
      if (event.type !== "result") return;
      this.results++;
      if (this.results !== 1) throw new Error("CLAUDE_INVALID_RESULT");
      if (
        event.is_error !== false ||
        event.subtype !== "success" ||
        typeof event.result !== "string" ||
        !event.result.trim() ||
        Buffer.byteLength(event.result) > 64_000
      ) {
        this.failed = true;
        return;
      }
      this.completed = true;
      this.lastReport = event.result;
      return;
    }
    if (event.type === "turn.failed" || event.type === "error") this.failed = true;
    if (event.type === "turn.completed") this.completed = true;
    if (event.type === "item.completed") {
      const item = object(event.item);
      if (
        item?.type === "agent_message" &&
        typeof item.text === "string" &&
        item.text.trim() &&
        Buffer.byteLength(item.text) <= 64_000
      )
        this.lastReport = item.text;
    }
  }

  sessionId(): string | null {
    return this.runtimeSessionId ?? null;
  }

  result(): string {
    if (this.backend === "claude") {
      if (!this.completed || this.failed || !this.lastReport) throw new Error("CLAUDE_EXECUTION_FAILED");
    } else {
      if (this.failed) throw new Error("CODEX_TURN_FAILED");
      if (!this.completed || !this.lastReport) throw new Error("CODEX_RESULT_MISSING");
    }
    return this.lastReport;
  }
}
