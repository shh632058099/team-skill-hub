/** Safe, fixed-vocabulary activity metadata; never copy model text or tool arguments. */
export type ActivityTool = "Read" | "Glob" | "Grep" | "other";
export type ActivityKind = "model.started" | "model.active" | "model.completed" | "model.failed" | "tool.activity";
export interface ExecutionActivity {
  kind: ActivityKind;
  tool?: ActivityTool;
  count?: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function safeTool(raw: unknown): ActivityTool {
  return raw === "Read" || raw === "Glob" || raw === "Grep" ? raw : "other";
}

/** CLI-version tolerant event adapter. Unsupported events never reach the Hub. */
export function mapExecutionActivity(backend: "claude" | "codex", raw: unknown): ExecutionActivity[] {
  const event = object(raw);
  if (!event) return [];
  if (backend === "claude") {
    if (event.type === "system" && event.subtype === "init") return [{ kind: "model.started" }];
    if (event.type === "result") {
      return [{ kind: event.is_error === false && event.subtype === "success" ? "model.completed" : "model.failed" }];
    }
    if (event.type !== "assistant") return [];
    const message = object(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const tools = content
      .map(object)
      .filter((block): block is Record<string, unknown> => block !== null && block.type === "tool_use")
      .map((block) => ({ kind: "tool.activity", tool: safeTool(block.name), count: 1 }) as const);
    return tools.length ? tools : [{ kind: "model.active" }];
  }
  if (event.type === "thread.started" || event.type === "turn.started") return [{ kind: "model.started" }];
  if (event.type === "turn.completed") return [{ kind: "model.completed" }];
  if (event.type === "turn.failed" || event.type === "error") return [{ kind: "model.failed" }];
  if (event.type !== "item.started" && event.type !== "item.completed") return [];
  const item = object(event.item);
  if (!item || event.type !== "item.started") return [];
  if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call") {
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
  constructor(private readonly backend: "claude" | "codex") {}

  accept(raw: unknown): void {
    const event = object(raw);
    if (!event) throw new Error("EXPERT_INVALID_STREAM_EVENT");
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
