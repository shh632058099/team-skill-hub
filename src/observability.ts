import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { KnowledgeLifecycleMetadata, Principal } from "./types.js";
import { governanceRuleForObservabilityFile } from "./data-governance.js";

export type FeedbackRating = "positive" | "negative";
export type CandidateStatus = "pending" | "approved" | "rejected" | "publishing" | "published" | "publish_failed";
export type CandidateKnowledgeRelationType = "new" | "duplicate_of" | "updates" | "supersedes" | "conflicts_with" | "related_to";
export type CandidateReviewReason =
  | "useful"
  | "needs_edit"
  | "false_positive"
  | "duplicate"
  | "low_reuse_value"
  | "outdated";
export type ClientHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "Stop"
  | "SessionEnd";

export interface ClientEventRecord {
  id: string;
  ts: string;
  schemaVersion: number;
  client: "codex" | string;
  event: ClientHookEventName | string;
  sessionId: string;
  turnId?: string;
  actorId: string;
  tenantId: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  metadata: Record<string, unknown>;
}


export interface CandidateDetectionRecord {
  id: string;
  ts: string;
  detector?: string;
  actorId: string;
  tenantId: string;
  sessionId: string;
  turnId?: string;
  outcome: "created" | "skipped";
  reason: string;
  evidenceCount: number;
  candidateId?: string;
}

export interface McpCallRecord {
  id: string;
  ts: string;
  traceId: string;
  sessionId?: string;
  transportSessionId?: string;
  actorId: string;
  tenantId: string;
  client?: string;
  tool: string;
  args?: Record<string, unknown>;
  latencyMs: number;
  success: boolean;
  error?: string;
}

function isMcpCallRecord(value: unknown): value is McpCallRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<McpCallRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.ts === "string" &&
    typeof record.traceId === "string" &&
    typeof record.actorId === "string" &&
    typeof record.tenantId === "string" &&
    typeof record.tool === "string" &&
    typeof record.latencyMs === "number" &&
    Number.isFinite(record.latencyMs) &&
    typeof record.success === "boolean"
  );
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
  reviewReason?: CandidateReviewReason;
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
    mergeRequestState?: "opened" | "merged" | "closed" | "locked";
    lastCheckedAt?: string;
    mergedAt?: string;
    closedAt?: string;
    mergeCommitSha?: string;
    pipelineStatus?: string;
    hasConflicts?: boolean;
    detailedMergeStatus?: string;
    sourceBranchExists?: boolean;
  };
  publishError?: string;
  fingerprint?: string;
  duplicateOf?: string;
  possibleDuplicateOf?: string;
  duplicateSimilarity?: number;
  knowledgeRelation?: {
    type: CandidateKnowledgeRelationType;
    target?: {
      key: string;
      repositoryId: string;
      path: string;
      title: string;
    };
  };
  relationHint?: {
    type: "updates" | "supersedes" | "conflicts_with" | "related_to";
    target: {
      key: string;
      repositoryId: string;
      path: string;
      title: string;
    };
    reason: string;
    confidence: "medium" | "high";
  };
  sourceSessionId?: string;
  sourceTurnId?: string;
  automation?: {
    detector: string;
    classification: "root-cause" | "verified-fix" | "workaround" | "reusable-constraint";
    generationReason: string;
    reasons: string[];
    evidenceCount: number;
    evidence: Array<{
      type: string;
      sourceTool: string;
      success?: boolean;
      exitCode?: number;
      counts?: {
        run?: number;
        passed?: number;
        failed?: number;
      };
      durationMs?: number;
      status?: string;
    }>;
  };
  relatedKnowledge?: Array<{
    key: string;
    repositoryId: string;
    path: string;
    title: string;
    score: number;
    metadata?: KnowledgeLifecycleMetadata;
  }>;
}

export interface KnowledgeGap {
  key: string;
  query: string;
  occurrences: number;
  lastSeenAt: string;
  source: "unmatched-query" | "negative-feedback";
  members?: string[];
  clusterKey?: string;
}

function redactText(value: string, max = 500): string {
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}/g, "[redacted-token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\b((?:https?|ssh|git):\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, "[redacted-connection-string]")
    .replace(/(?:password|token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, max);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (/password|secret|token|api.?key|authorization/i.test(key)) out[key] = "[redacted]";
      else out[key] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

function candidateFingerprint(title: string, content: string): string {
  const normalized = (title + "\n" + content)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function candidateSimilarityTokens(title: string, content: string): Set<string> {
  const normalized = (title + " " + content)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[0-9a-f]{8,}\b/g, " ")
    .replace(/\d+/g, " ");
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) tokens.add(token);
  for (const chunk of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < chunk.length - 1; index += 1) tokens.add(chunk.slice(index, index + 2));
  }
  return tokens;
}

function candidateSimilarity(
  leftTitle: string,
  leftContent: string,
  rightTitle: string,
  rightContent: string
): number {
  const left = candidateSimilarityTokens(leftTitle, leftContent);
  const right = candidateSimilarityTokens(rightTitle, rightContent);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

export class McpObservabilityStore {
  private readonly retentionDaysOverride?: number;
  private readonly maxFileBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly maxEntries = 10000,
    options?: { retentionDays?: number; maxFileBytes?: number }
  ) {
    this.retentionDaysOverride =
      options?.retentionDays === undefined ? undefined : Math.max(1, Math.floor(options.retentionDays));
    this.maxFileBytes = Math.max(1024, Math.floor(options?.maxFileBytes ?? 5 * 1024 * 1024));
  }

  private retentionDaysFor(file: string): number {
    if (this.retentionDaysOverride !== undefined) return this.retentionDaysOverride;
    return Math.max(1, governanceRuleForObservabilityFile(path.basename(file)).retentionDays);
  }

  private file(name: string): string {
    return path.join(this.dataDir, "observability", name);
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const temporary = `${file}.tmp.${process.pid}.${randomUUID().replaceAll("-", "")}`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async append(name: string, value: unknown): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const file = this.file(name);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
      await this.compact(file);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private parseValidRows(text: string): Array<{ raw: string; value: Record<string, unknown> }> {
    const rows: Array<{ raw: string; value: Record<string, unknown> }> = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        if (value && typeof value === "object") rows.push({ raw, value });
      } catch {
        // Ignore corrupted/truncated lines. A later compact rewrites only valid rows.
      }
    }
    return rows;
  }

  private rowTimestamp(value: Record<string, unknown>): number | undefined {
    const raw =
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : typeof value.ts === "string"
          ? value.ts
          : undefined;
    if (!raw) return undefined;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private async cleanupArchives(file: string): Promise<void> {
    const dir = path.dirname(file);
    const prefix = path.basename(file) + ".archive.";
    const cutoff = Date.now() - this.retentionDaysFor(file) * 24 * 60 * 60 * 1000;
    try {
      for (const name of await readdir(dir)) {
        if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue;
        const archive = path.join(dir, name);
        const info = await stat(archive);
        if (info.mtimeMs < cutoff) await unlink(archive);
      }
    } catch {
      // Retention cleanup is best effort.
    }
  }

  private async compact(file: string): Promise<void> {
    try {
      const text = await readFile(file, "utf8");
      const valid = this.parseValidRows(text);
      const cutoff = Date.now() - this.retentionDaysFor(file) * 24 * 60 * 60 * 1000;
      let rows = valid.filter((row) => {
        const timestamp = this.rowTimestamp(row.value);
        return timestamp === undefined || timestamp >= cutoff;
      });
      if (rows.length > this.maxEntries) rows = rows.slice(-this.maxEntries);

      const serialized = rows.map((row) => row.raw).join("\n") + (rows.length ? "\n" : "");
      const currentBytes = Buffer.byteLength(serialized, "utf8");
      if (currentBytes > this.maxFileBytes && rows.length > 1) {
        const keepCount = Math.max(1, Math.floor(rows.length / 2));
        const archivedRows = rows.slice(0, -keepCount);
        rows = rows.slice(-keepCount);
        if (archivedRows.length) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const archive = file + ".archive." + stamp + ".jsonl";
          await this.atomicWrite(archive, archivedRows.map((row) => row.raw).join("\n") + "\n");
        }
      }
      await this.atomicWrite(file, rows.map((row) => row.raw).join("\n") + (rows.length ? "\n" : ""));
      await this.cleanupArchives(file);
    } catch {
      // Observability must never break MCP handling.
    }
  }

  private async read<T>(name: string, limit = 200): Promise<T[]> {
    try {
      const rows = this.parseValidRows(await readFile(this.file(name), "utf8"));
      return rows
        .slice(-Math.max(1, Math.min(limit, 2000)))
        .reverse()
        .map((row) => row.value as T);
    } catch {
      return [];
    }
  }

  private async readMcpCalls(limit = 200): Promise<McpCallRecord[]> {
    const rows = await this.read<unknown>("mcp-calls.jsonl", limit);
    return rows.filter(isMcpCallRecord);
  }

  newTraceId(): string {
    return "tr_" + randomUUID().replaceAll("-", "");
  }

  traceIdForSession(principal: Principal, sessionId: string): string {
    const digest = createHash("sha256")
      .update(principal.tenantId + "\0" + principal.id + "\0" + sessionId)
      .digest("hex")
      .slice(0, 24);
    return "sess_" + digest;
  }

  async resolveUniqueActiveClientSession(
    principal: Principal,
    maxAgeMs = 12 * 60 * 60 * 1000
  ): Promise<string | undefined> {
    const events = await this.read<ClientEventRecord>("client-events.jsonl", this.maxEntries);
    const cutoff = Date.now() - maxAgeMs;
    const latest = new Map<string, ClientEventRecord>();
    for (const event of events) {
      if (event.actorId !== principal.id || event.tenantId !== principal.tenantId) continue;
      if (Date.parse(event.ts) < cutoff) continue;
      if (!latest.has(event.sessionId)) latest.set(event.sessionId, event);
    }
    const active = [...latest.values()].filter((event) => event.event !== "SessionEnd");
    return active.length === 1 ? active[0]!.sessionId : undefined;
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
    return this.readMcpCalls(limit);
  }

  async summary(): Promise<{
    total: number;
    failed: number;
    errorRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    byTool: Record<string, number>;
  }> {
    const rows = await this.readMcpCalls(this.maxEntries);
    const byTool: Record<string, number> = {};
    let latency = 0;
    let failed = 0;
    const latencies: number[] = [];
    for (const row of rows) {
      byTool[row.tool] = (byTool[row.tool] ?? 0) + 1;
      latency += row.latencyMs;
      latencies.push(row.latencyMs);
      if (!row.success) failed += 1;
    }
    latencies.sort((a, b) => a - b);
    const p95Index = latencies.length ? Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1) : 0;
    return {
      total: rows.length,
      failed,
      errorRate: rows.length ? failed / rows.length : 0,
      avgLatencyMs: rows.length ? latency / rows.length : 0,
      p95LatencyMs: latencies.length ? latencies[p95Index]! : 0,
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
    const calls = await this.readMcpCalls(this.maxEntries);
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
    return (await this.readMcpCalls(this.maxEntries))
      .filter((item) => item.traceId === traceId)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async findDuplicateClientEvent(
    principal: Principal,
    input: {
      event: string;
      sessionId: string;
      turnId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ClientEventRecord | undefined> {
    const toolUseId =
      input.event === "PostToolUse" && typeof input.metadata?.tool_use_id === "string"
        ? input.metadata.tool_use_id
        : undefined;
    const turnScoped =
      Boolean(input.turnId) &&
      (input.event === "UserPromptSubmit" || input.event === "Stop");
    const sessionScoped = input.event === "SessionStart" || input.event === "SessionEnd";
    if (!toolUseId && !turnScoped && !sessionScoped) return undefined;

    const rows = await this.read<ClientEventRecord>("client-events.jsonl", this.maxEntries);
    return [...rows].reverse().find((item) => {
      if (
        item.actorId !== principal.id ||
        item.tenantId !== principal.tenantId ||
        item.sessionId !== input.sessionId ||
        item.event !== input.event
      ) return false;
      if (toolUseId) return item.metadata?.tool_use_id === toolUseId;
      if (turnScoped) return item.turnId === input.turnId;
      return true;
    });
  }

  async recordClientEvent(
    principal: Principal,
    input: {
      schemaVersion?: number;
      client?: string;
      event: string;
      sessionId: string;
      turnId?: string;
      cwd?: string;
      model?: string;
      permissionMode?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<ClientEventRecord> {
    const metadata = (sanitizeValue(input.metadata ?? {}) ?? {}) as Record<string, unknown>;
    if (typeof input.metadata?.assistant_result_excerpt === "string") {
      metadata.assistant_result_excerpt = redactText(input.metadata.assistant_result_excerpt, 4000);
    }
    const record: ClientEventRecord = {
      id: "evt_" + randomUUID().replaceAll("-", ""),
      ts: new Date().toISOString(),
      schemaVersion: input.schemaVersion ?? 1,
      client: input.client ? redactText(input.client, 100) : "codex",
      event: redactText(input.event, 80),
      sessionId: redactText(input.sessionId, 200),
      turnId: input.turnId ? redactText(input.turnId, 200) : undefined,
      actorId: principal.id,
      tenantId: principal.tenantId,
      cwd: input.cwd ? redactText(input.cwd, 500) : undefined,
      model: input.model ? redactText(input.model, 120) : undefined,
      permissionMode: input.permissionMode ? redactText(input.permissionMode, 80) : undefined,
      metadata
    };
    await this.append("client-events.jsonl", record);
    return record;
  }

  listClientEvents(limit = 500): Promise<ClientEventRecord[]> {
    return this.read<ClientEventRecord>("client-events.jsonl", limit);
  }

  async listClientSessions(limit = 100): Promise<Array<{
    sessionId: string;
    actorId: string;
    tenantId: string;
    client: string;
    startedAt: string;
    endedAt: string;
    eventCount: number;
    callCount: number;
    evidenceCount: number;
    tools: string[];
    events: string[];
    repositoryId?: string;
    runtimeVersion?: string;
    hookSchemaVersion?: number;
    ended: boolean;
  }>> {
    const events = await this.read<ClientEventRecord>("client-events.jsonl", this.maxEntries);
    const calls = await this.readMcpCalls(this.maxEntries);
    const groups = new Map<string, { events: ClientEventRecord[]; calls: McpCallRecord[] }>();
    for (const event of events) {
      const key = event.actorId + "\0" + event.tenantId + "\0" + event.sessionId;
      const group = groups.get(key) ?? { events: [], calls: [] };
      group.events.push(event);
      groups.set(key, group);
    }
    for (const call of calls) {
      if (!call.sessionId) continue;
      const key = call.actorId + "\0" + call.tenantId + "\0" + call.sessionId;
      const group = groups.get(key) ?? { events: [], calls: [] };
      group.calls.push(call);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => {
        const timeline = [
          ...group.events.map((item) => item.ts),
          ...group.calls.map((item) => item.ts)
        ].sort();
        const firstEvent = [...group.events].sort((a, b) => a.ts.localeCompare(b.ts))[0];
        const latestEvent = [...group.events].sort((a, b) => b.ts.localeCompare(a.ts))[0];
        const projectContext = group.events
          .map((item) => item.metadata?.project_context)
          .find((item) => item && typeof item === "object") as
          | { repositoryId?: string }
          | undefined;
        const runtimeMetadata = [...group.events]
          .sort((a, b) => b.ts.localeCompare(a.ts))
          .map((item) => item.metadata)
          .find((metadata) =>
            typeof metadata?.runtime_version === "string" ||
            typeof metadata?.hook_schema_version === "number"
          );
        const runtimeVersion =
          typeof runtimeMetadata?.runtime_version === "string"
            ? runtimeMetadata.runtime_version
            : undefined;
        const hookSchemaVersion =
          typeof runtimeMetadata?.hook_schema_version === "number"
            ? runtimeMetadata.hook_schema_version
            : undefined;
        return {
          sessionId: firstEvent?.sessionId ?? group.calls[0]!.sessionId!,
          actorId: firstEvent?.actorId ?? group.calls[0]!.actorId,
          tenantId: firstEvent?.tenantId ?? group.calls[0]!.tenantId,
          client: firstEvent?.client ?? group.calls[0]!.client ?? "unknown",
          startedAt: timeline[0]!,
          endedAt: timeline[timeline.length - 1]!,
          eventCount: group.events.length,
          callCount: group.calls.length,
          evidenceCount: group.events.filter((item) => {
            const evidence = item.metadata?.evidence;
            return evidence && typeof evidence === "object" && Object.keys(evidence as object).length > 0;
          }).length,
          tools: [...new Set(group.calls.map((item) => item.tool))],
          events: [...new Set(group.events.map((item) => item.event))],
          repositoryId: projectContext?.repositoryId,
          runtimeVersion,
          hookSchemaVersion,
          ended: latestEvent?.event === "SessionEnd"
        };
      })
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async getClientSessionTimeline(
    principalId: string,
    tenantId: string,
    sessionId: string
  ): Promise<Array<
    | { kind: "event"; ts: string; event: ClientEventRecord }
    | { kind: "mcp-call"; ts: string; call: McpCallRecord }
  >> {
    const events = (await this.read<ClientEventRecord>("client-events.jsonl", this.maxEntries))
      .filter((item) => item.actorId === principalId && item.tenantId === tenantId && item.sessionId === sessionId)
      .map((event) => ({ kind: "event" as const, ts: event.ts, event }));
    const calls = (await this.readMcpCalls(this.maxEntries))
      .filter((item) => item.actorId === principalId && item.tenantId === tenantId && item.sessionId === sessionId)
      .map((call) => ({ kind: "mcp-call" as const, ts: call.ts, call }));
    return [...events, ...calls].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async recordCandidateDetection(
    input: Omit<CandidateDetectionRecord, "id" | "ts">
  ): Promise<CandidateDetectionRecord> {
    const record: CandidateDetectionRecord = {
      ...input,
      id: "det_" + randomUUID().replaceAll("-", ""),
      ts: new Date().toISOString(),
      reason: redactText(input.reason, 500)
    };
    await this.append("candidate-detections.jsonl", record);
    return record;
  }

  listCandidateDetections(limit = 500): Promise<CandidateDetectionRecord[]> {
    return this.read<CandidateDetectionRecord>("candidate-detections.jsonl", limit);
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

  async findExactCandidateDuplicate(
    title: string,
    content: string
  ): Promise<KnowledgeCandidate | undefined> {
    const fingerprint = candidateFingerprint(redactText(title, 200), redactText(content, 10000));
    return (await this.listCandidates(this.maxEntries)).find(
      (item) =>
        (item.fingerprint ?? candidateFingerprint(item.title, item.content)) === fingerprint &&
        item.status !== "rejected"
    );
  }

  async findNearCandidateDuplicate(
    title: string,
    content: string,
    repository?: string,
    threshold = 0.78,
    excludeId?: string
  ): Promise<{ candidate: KnowledgeCandidate; score: number } | undefined> {
    let best: { candidate: KnowledgeCandidate; score: number } | undefined;
    for (const item of await this.listCandidates(this.maxEntries)) {
      if (item.id === excludeId || item.status === "rejected") continue;
      if (repository && item.repository !== repository) continue;
      const score = candidateSimilarity(title, content, item.title, item.content);
      if (score < threshold || (best && best.score >= score)) continue;
      best = { candidate: item, score };
    }
    return best;
  }

  async createCandidate(
    principal: Principal,
    input: Pick<KnowledgeCandidate, "title" | "content" | "sourceType" | "suggestedType" | "repository" | "suggestedPath" | "traceId"> &
      Partial<Pick<KnowledgeCandidate, "sourceSessionId" | "sourceTurnId" | "automation" | "relatedKnowledge" | "relationHint">>
  ): Promise<KnowledgeCandidate> {
    const ts = new Date().toISOString();
    const title = redactText(input.title, 200);
    const content = redactText(input.content, 10000);
    const fingerprint = candidateFingerprint(title, content);
    const duplicate = (await this.listCandidates(this.maxEntries)).find(
      (item) =>
        (item.fingerprint ?? candidateFingerprint(item.title, item.content)) === fingerprint &&
        item.status !== "rejected"
    );
    const nearDuplicate = duplicate
      ? undefined
      : await this.findNearCandidateDuplicate(title, content, input.repository, 0.78);
    const record: KnowledgeCandidate = {
      ...input,
      id: "kc_" + randomUUID().replaceAll("-", ""),
      ts,
      updatedAt: ts,
      actorId: principal.id,
      tenantId: principal.tenantId,
      title,
      content,
      status: "pending",
      fingerprint,
      duplicateOf: duplicate?.id,
      possibleDuplicateOf: nearDuplicate?.candidate.id,
      duplicateSimilarity: nearDuplicate ? Number(nearDuplicate.score.toFixed(3)) : undefined
    };
    await this.append("knowledge-candidates.jsonl", record);
    return record;
  }

  async listCandidates(limit = 500): Promise<KnowledgeCandidate[]> {
    const rows = await this.read<KnowledgeCandidate>("knowledge-candidates.jsonl", this.maxEntries);
    const latest = new Map<string, KnowledgeCandidate>();
    for (const row of [...rows].reverse()) latest.set(row.id, row);
    return [...latest.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  async getCandidateHistory(id: string, limit = 200): Promise<KnowledgeCandidate[]> {
    const rows = await this.read<KnowledgeCandidate>("knowledge-candidates.jsonl", this.maxEntries);
    return rows
      .filter((item) => item.id === id)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-Math.max(1, Math.min(limit, 1000)));
  }

  async updateCandidate(
    id: string,
    input: Partial<Pick<KnowledgeCandidate, "title" | "content" | "suggestedType" | "repository" | "suggestedPath" | "knowledgeRelation">>
  ): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    if (!["pending", "approved", "publish_failed"].includes(current.status)) {
      throw new Error("Knowledge candidate cannot be edited in its current state");
    }
    const nextTitle = input.title !== undefined ? redactText(input.title, 200) : current.title;
    const nextContent = input.content !== undefined ? redactText(input.content, 10000) : current.content;
    const fingerprint = candidateFingerprint(nextTitle, nextContent);
    const duplicate = (await this.listCandidates(this.maxEntries)).find(
      (item) =>
        item.id !== id &&
        (item.fingerprint ?? candidateFingerprint(item.title, item.content)) === fingerprint &&
        item.status !== "rejected"
    );
    const nearDuplicate = duplicate
      ? undefined
      : await this.findNearCandidateDuplicate(
          nextTitle,
          nextContent,
          input.repository ?? current.repository,
          0.78,
          id
        );
    const next: KnowledgeCandidate = {
      ...current,
      title: nextTitle,
      content: nextContent,
      fingerprint,
      duplicateOf: duplicate?.id,
      possibleDuplicateOf: nearDuplicate?.candidate.id,
      duplicateSimilarity: nearDuplicate ? Number(nearDuplicate.score.toFixed(3)) : undefined,
      ...(input.knowledgeRelation !== undefined ? { knowledgeRelation: input.knowledgeRelation } : {}),
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

  async updateCandidatePublication(
    id: string,
    publication: NonNullable<KnowledgeCandidate["publication"]>
  ): Promise<KnowledgeCandidate> {
    const current = (await this.listCandidates(this.maxEntries)).find((item) => item.id === id);
    if (!current) throw new Error("Knowledge candidate not found");
    if (!current.publication) throw new Error("Knowledge candidate has no publication to reconcile");
    const next: KnowledgeCandidate = {
      ...current,
      publication,
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
    reviewNote?: string,
    reviewReason?: CandidateReviewReason
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
      reviewReason,
      updatedAt: new Date().toISOString()
    };
    await this.append("knowledge-candidates.jsonl", next);
    return next;
  }

  private normalizeKnowledgeGapQuery(value: string): { normalized: string; tokens: Set<string> } {
    const normalized = redactText(value, 500)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/6\s*个月|six\s*month|180\s*day/gi, "six-month")
      .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const stopWords = new Set(["the","a","an","is","are","of","to","for","and","or","how","what","policy","rule","document","文档","规则","策略"]);
    const tokens = new Set<string>();
    for (const token of normalized.split(" ")) {
      if (token.length >= 2 && !stopWords.has(token)) tokens.add(token);
    }
    for (const chunk of normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      for (let index = 0; index < chunk.length - 1; index += 1) tokens.add(chunk.slice(index, index + 2));
    }
    return { normalized, tokens };
  }

  private knowledgeGapSimilarity(left: Set<string>, right: Set<string>): number {
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    return intersection / Math.min(left.size, right.size);
  }

  async knowledgeGaps(unmatchedQueries: Array<{ query: string; count: number }>): Promise<KnowledgeGap[]> {
    const inputs: Array<{ query: string; occurrences: number; lastSeenAt: string; source: "unmatched-query" | "negative-feedback" }> = [];
    const now = new Date().toISOString();
    for (const item of unmatchedQueries) {
      inputs.push({
        query: redactText(item.query, 500),
        occurrences: item.count,
        lastSeenAt: now,
        source: "unmatched-query"
      });
    }
    for (const feedback of await this.listFeedback(this.maxEntries)) {
      if (feedback.rating !== "negative" || !feedback.reason) continue;
      inputs.push({
        query: redactText(feedback.reason, 500),
        occurrences: 1,
        lastSeenAt: feedback.ts,
        source: "negative-feedback"
      });
    }

    const clusters: Array<{
      normalized: string;
      tokens: Set<string>;
      gap: KnowledgeGap;
    }> = [];
    for (const input of inputs) {
      const normalized = this.normalizeKnowledgeGapQuery(input.query);
      let bestIndex = -1;
      let bestScore = 0;
      for (let index = 0; index < clusters.length; index += 1) {
        const score = this.knowledgeGapSimilarity(normalized.tokens, clusters[index]!.tokens);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0 && bestScore >= 0.6) {
        const cluster = clusters[bestIndex]!;
        cluster.gap.occurrences += input.occurrences;
        cluster.gap.lastSeenAt =
          cluster.gap.lastSeenAt > input.lastSeenAt ? cluster.gap.lastSeenAt : input.lastSeenAt;
        cluster.gap.members = [...new Set([...(cluster.gap.members ?? [cluster.gap.query]), input.query])];
        if (cluster.gap.source !== input.source) cluster.gap.source = "unmatched-query";
        for (const token of normalized.tokens) cluster.tokens.add(token);
      } else {
        const clusterKey = normalized.normalized || input.query.toLowerCase();
        clusters.push({
          normalized: clusterKey,
          tokens: normalized.tokens,
          gap: {
            key: "g:" + createHash("sha256").update(clusterKey).digest("hex").slice(0, 16),
            clusterKey,
            query: input.query,
            occurrences: input.occurrences,
            lastSeenAt: input.lastSeenAt,
            source: input.source,
            members: [input.query]
          }
        });
      }
    }
    return clusters.map((item) => item.gap).sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
}
