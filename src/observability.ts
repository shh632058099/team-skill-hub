import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Principal } from "./types.js";

export type FeedbackRating = "positive" | "negative";
export type CandidateStatus = "pending" | "approved" | "rejected" | "publishing" | "published" | "publish_failed";

export interface McpCallRecord {
  id: string;
  ts: string;
  traceId: string;
  sessionId?: string;
  actorId: string;
  tenantId: string;
  client?: string;
  tool: string;
  args?: Record<string, unknown>;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface FeedbackRecord {
  id: string;
  ts: string;
  traceId?: string;
  callId?: string;
  actorId: string;
  tenantId: string;
  targetType: "skill" | "knowledge" | "prompt" | "agent" | "mcp-call";
  target?: string;
  rating: FeedbackRating;
  reason?: string;
}

export interface KnowledgeCandidate {
  id: string;
  ts: string;
  updatedAt: string;
  actorId: string;
  tenantId: string;
  traceId?: string;
  title: string;
  content: string;
  sourceType: "mcp-session" | "manual" | "codex-summary" | "troubleshooting" | "review";
  suggestedType: "knowledge" | "skill";
  repository?: string;
  suggestedPath?: string;
  status: CandidateStatus;
  reviewer?: string;
  reviewNote?: string;
  publication?: {
    provider: "gitlab";
    projectPath: string;
    branch: string;
    targetBranch: string;
    filePath: string;
    action: "create" | "update";
    mergeRequestIid: number;
    mergeRequestUrl: string;
    publishedAt: string;
  };
  publishError?: string;
}

export interface KnowledgeGap {
  key: string;
  query: string;
  occurrences: number;
  lastSeenAt: string;
  source: "unmatched-query" | "negative-feedback";
}

function redactText(value: string, max = 500): string {
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}/g, "[redacted-token]")
    .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, max);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/password|secret|token|api.?key|authorization/i.test(key)) out[key] = "[redacted]";
      else out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

export class McpObservabilityStore {
  constructor(private readonly dataDir: string, private readonly maxEntries = 10000) {}

  private file(name: string): string {
    return path.join(this.dataDir, "observability", name);
  }

  private async append(name: string, value: unknown): Promise<void> {
    const file = this.file(name);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
    await this.compact(file);
  }

  private async compact(file: string): Promise<void> {
    try {
      const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean);
      if (rows.length <= this.maxEntries) return;
      await writeFile(file, rows.slice(-this.maxEntries).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    } catch {
      // Observability must never break MCP handling.
    }
  }

  private async read<T>(name: string, limit = 200): Promise<T[]> {
    try {
      const rows = (await readFile(this.file(name), "utf8")).split("\n").filter(Boolean);
      return rows.slice(-Math.max(1, Math.min(limit, 2000))).reverse().map((line) => JSON.parse(line) as T);
    } catch {
      return [];
    }
  }

  newTraceId(): string {
    return "tr_" + randomUUID().replaceAll("-", "");
  }

  async recordCall(input: Omit<McpCallRecord, "id" | "ts" | "args"> & { args?: unknown }): Promise<McpCallRecord> {
    const record: McpCallRecord = {
      ...input,
      id: "call_" + randomUUID().replaceAll("-", ""),
      ts: new Date().toISOString(),
      client: input.client ? redactText(input.client, 300) : undefined,
      error: input.error ? redactText(input.error, 1000) : undefined,
      args: sanitizeValue(input.args) as Record<string, unknown> | undefined
    };
    await this.append("mcp-calls.jsonl", record);
    return record;
  }

  listCalls(limit = 200): Promise<McpCallRecord[]> {
    return this.read<McpCallRecord>("mcp-calls.jsonl", limit);
  }

  async summary(): Promise<{ total: number; failed: number; avgLatencyMs: number; byTool: Record<string, number> }> {
    const rows = await this.read<McpCallRecord>("mcp-calls.jsonl", this.maxEntries);
    const byTool: Record<string, number> = {};
    let latency = 0;
    let failed = 0;
    for (const row of rows) {
      byTool[row.tool] = (byTool[row.tool] ?? 0) + 1;
      latency += row.latencyMs;
      if (!row.success) failed += 1;
    }
    return {
      total: rows.length,
      failed,
      avgLatencyMs: rows.length ? latency / rows.length : 0,
      byTool
    };
  }

  async listTraces(limit = 100): Promise<Array<{
    traceId: string;
    sessionId?: string;
    actorId: string;
    tenantId: string;
    client?: string;
    startedAt: string;
    endedAt: string;
    callCount: number;
    failed: boolean;
    totalLatencyMs: number;
    tools: string[];
  }>> {
    const calls = await this.read<McpCallRecord>("mcp-calls.jsonl", this.maxEntries);
    const grouped = new Map<string, McpCallRecord[]>();
    for (const call of calls) {
      const current = grouped.get(call.traceId) ?? [];
      current.push(call);
      grouped.set(call.traceId, current);
    }
    return [...grouped.entries()]
      .map(([traceId, items]) => {
        const ordered = [...items].sort((a, b) => a.ts.localeCompare(b.ts));
        const first = ordered[0]!;
        const last = ordered[ordered.length - 1]!;
        return {
          traceId,
          sessionId: first.sessionId,
          actorId: first.actorId,
          tenantId: first.tenantId,
          client: first.client,
          startedAt: first.ts,
          endedAt: last.ts,
          callCount: ordered.length,
          failed: ordered.some((item) => !item.success),
          totalLatencyMs: ordered.reduce((sum, item) => sum + item.latencyMs, 0),
          tools: ordered.map((item) => item.tool)
        };
      })
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async getTrace(traceId: string): Promise<McpCallRecord[]> {
    return (await this.read<McpCallRecord>("mcp-calls.jsonl", this.maxEntries))
      .filter((item) => item.traceId === traceId)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async submitFeedback(
    principal: Principal,
    input: Omit<FeedbackRecord, "id" | "ts" | "actorId" | "tenantId">
  ): Promise<FeedbackRecord> {
    const record: FeedbackRecord = {
      ...input,
      id: "fb_" + randomUUID().replaceAll("-", ""),
      ts: new Date().toISOString(),
      actorId: principal.id,
      tenantId: principal.tenantId,
      reason: input.reason ? redactText(input.reason, 1000) : undefined
    };
    await this.append("feedback.jsonl", record);
    return record;
  }

  listFeedback(limit = 200): Promise<FeedbackRecord[]> {
    return this.read<FeedbackRecord>("feedback.jsonl", limit);
  }

  async createCandidate(
    principal: Principal,
    input: Pick<KnowledgeCandidate, "title" | "content" | "sourceType" | "suggestedType" | "repository" | "suggestedPath" | "traceId">
  ): Promise<KnowledgeCandidate> {
    const ts = new Date().toISOString();
    const record: KnowledgeCandidate = {
      ...input,
      id: "kc_" + randomUUID().replaceAll("-", ""),
      ts,
      updatedAt: ts,
      actorId: principal.id,
      tenantId: principal.tenantId,
      title: redactText(input.title, 200),
      content: redactText(input.content, 10000),
      status: "pending"
    };
    await this.append("knowledge-candidates.jsonl", record);
    return record;
  }

  async listCandidates(limit = 500): Promise<KnowledgeCandidate[]> {
    const rows = await this.read<KnowledgeCandidate>("knowledge-candidates.jsonl", limit);
    const latest = new Map<string, KnowledgeCandidate>();
    for (const row of [...rows].reverse()) latest.set(row.id, row);
    return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async updateCandidate(
    id: string,
    input: Partial<Pick<KnowledgeCandidate, "title" | "content" | "suggestedType" | "repository" | "suggestedPath">>
  ): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    if (!["pending", "approved", "publish_failed"].includes(current.status)) {
      throw new Error("Knowledge candidate cannot be edited in its current state");
    }
    const next: KnowledgeCandidate = {
      ...current,
      ...(input.title !== undefined ? { title: redactText(input.title, 200) } : {}),
      ...(input.content !== undefined ? { content: redactText(input.content, 10000) } : {}),
      ...(input.suggestedType !== undefined ? { suggestedType: input.suggestedType } : {}),
      ...(input.repository !== undefined ? { repository: input.repository || undefined } : {}),
      ...(input.suggestedPath !== undefined ? { suggestedPath: input.suggestedPath || undefined } : {}),
      status: current.status === "pending" ? "pending" : "approved",
      publishError: undefined,
      updatedAt: new Date().toISOString()
    };
    await this.append("knowledge-candidates.jsonl", next);
    return next;
  }

  async markCandidatePublishing(id: string): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    if (!["approved", "publish_failed"].includes(current.status)) {
      throw new Error("Knowledge candidate must be approved before publishing");
    }
    const next: KnowledgeCandidate = {
      ...current,
      status: "publishing",
      publishError: undefined,
      updatedAt: new Date().toISOString()
    };
    await this.append("knowledge-candidates.jsonl", next);
    return next;
  }

  async markCandidatePublished(
    id: string,
    publication: NonNullable<KnowledgeCandidate["publication"]>
  ): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    const next: KnowledgeCandidate = {
      ...current,
      status: "published",
      publication,
      publishError: undefined,
      updatedAt: new Date().toISOString()
    };
    await this.append("knowledge-candidates.jsonl", next);
    return next;
  }

  async markCandidatePublishFailed(id: string, error: string): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    const next: KnowledgeCandidate = {
      ...current,
      status: "publish_failed",
      publishError: redactText(error, 2000),
      updatedAt: new Date().toISOString()
    };
    await this.append("knowledge-candidates.jsonl", next);
    return next;
  }

  async reviewCandidate(
    id: string,
    status: "approved" | "rejected",
    reviewer: string,
    reviewNote?: string
  ): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    if (!["pending", "approved", "rejected", "publish_failed"].includes(current.status)) {
      throw new Error("Knowledge candidate cannot be reviewed in its current state");
    }
    const next: KnowledgeCandidate = {
      ...current,
      status,
      reviewer,
      reviewNote: reviewNote ? redactText(reviewNote, 2000) : undefined,
      updatedAt: new Date().toISOString()
    };
    await this.append("knowledge-candidates.jsonl", next);
    return next;
  }

  async knowledgeGaps(unmatchedQueries: Array<{ query: string; count: number }>): Promise<KnowledgeGap[]> {
    const gaps = new Map<string, KnowledgeGap>();
    const now = new Date().toISOString();
    for (const item of unmatchedQueries) {
      const query = redactText(item.query, 500);
      gaps.set("q:" + query.toLowerCase(), {
        key: "q:" + query.toLowerCase(),
        query,
        occurrences: item.count,
        lastSeenAt: now,
        source: "unmatched-query"
      });
    }
    for (const feedback of await this.listFeedback(this.maxEntries)) {
      if (feedback.rating !== "negative" || !feedback.reason) continue;
      const key = "f:" + feedback.reason.toLowerCase();
      const existing = gaps.get(key);
      gaps.set(key, {
        key,
        query: feedback.reason,
        occurrences: (existing?.occurrences ?? 0) + 1,
        lastSeenAt: feedback.ts,
        source: "negative-feedback"
      });
    }
    return [...gaps.values()].sort((a, b) => b.occurrences - a.occurrences);
  }
}
