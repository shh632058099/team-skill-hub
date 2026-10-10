import { appendFile, mkdir, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentArtifact,
  AppConfig,
  ArtifactSearchResult,
  AuditEvent,
  AuthenticationProvider,
  EventSink,
  EvaluationRunResult,
  EvaluationSuite,
  KnowledgeApplicabilityContext,
  KnowledgeDocument,
  KnowledgeSearchResult,
  PermissionProvider,
  Principal,
  PromptArtifact,
  RepositoryConfig,
  RepositoryRevision,
  RepositoryView,
  RepositorySyncTrigger,
  RepositoryState,
  SearchFilters,
  SearchResult,
  Skill,
  SkillRepositoryProvider,
  SkillRoutingStrategy,
  SkillSearchBackend,
  ToolArtifact,
  ValidationRule,
  RegistryStore
} from "./types.js";
import { createValidatedSnapshot } from "./repository.js";
import { scanSkills, validateSkills } from "./skills.js";
import { MetricsRegistry } from "./metrics.js";
import {
  canReadArtifact,
  resolveAgentToolBindings,
  scanAgents,
  scanPrompts,
  scanTools,
  searchArtifacts,
  validateArtifactPolicies
} from "./artifacts.js";
import { UsageAnalyticsStore } from "./analytics.js";
import { HttpKnowledgeCurator } from "./knowledge-curation.js";
import {
  EvaluationRunStore,
  loadEvaluationSnapshot,
  runEvaluationSuite,
  scanEvaluationSuites
} from "./evaluation.js";
import { auditKnowledgeLifecycle, chunksForDocuments, KnowledgeIndex, normalizeKnowledgeConfig, scanKnowledge } from "./knowledge.js";
import { McpObservabilityStore, type CandidateReviewReason, type ClientEventRecord, type FeedbackRecord, type KnowledgeCandidate } from "./observability.js";
import { createKnowledgePublisher } from "./knowledge-publishing.js";
import {
  ClientEventPipeline,
  CURRENT_HOOK_RUNTIME_VERSION,
  CURRENT_HOOK_SCHEMA_VERSION,
  normalizeEngineeringEvidence,
  resolveClientEventSchemaVersion
} from "./client-events.js";
import { resolveProjectContext } from "./project-context.js";
import { listDataGovernanceRules } from "./data-governance.js";import { parseKnowledgeSummary } from "./knowledge-summary.js";

export class SkillHubApplicationService {
  private readonly states = new Map<string, RepositoryState>();
  private readonly providers = new Map<string, SkillRepositoryProvider>();
  private ready = false;
  private readonly syncInFlight = new Map<string, Promise<RepositoryState>>();
  private readonly metrics = new MetricsRegistry();
  private readonly webhookSeen = new Map<string, number>();
  private readonly prompts = new Map<string, PromptArtifact>();
  private readonly agents = new Map<string, AgentArtifact>();
  private readonly tools = new Map<string, ToolArtifact>();
  private readonly knowledgeDocuments = new Map<string, KnowledgeDocument>();
  private readonly knowledgeIndex = new KnowledgeIndex();
  private readonly analytics: UsageAnalyticsStore;
  private readonly evaluations: EvaluationRunStore;
  private readonly observability: McpObservabilityStore;
  private readonly clientEventPipeline = new ClientEventPipeline();

  constructor(
    private readonly config: AppConfig,
    providers: SkillRepositoryProvider[],
    private readonly registry: RegistryStore,
    private readonly search: SkillSearchBackend,
    private readonly router: SkillRoutingStrategy,
    private readonly auth: AuthenticationProvider,
    private readonly permissions: PermissionProvider,
    private readonly rules: ValidationRule[],
    private readonly events: EventSink
  ) {
    this.analytics = new UsageAnalyticsStore(config.dataDir);
    this.evaluations = new EvaluationRunStore(config.dataDir);
    this.observability = new McpObservabilityStore(config.dataDir);
    this.clientEventPipeline.register({
      id: "stop-knowledge-candidate-detector-v2",
      events: ["Stop"],
      run: async ({ event }) => {
        await this.detectStopKnowledgeCandidate(event);
      }
    });
    for (const provider of providers) this.providers.set(provider.type, provider);
    for (const repo of config.repositories) {
      this.states.set(repo.id, {
        id: repo.id,
        status: repo.enabled ? "syncing" : "disabled",
        skillCount: 0,
        failureCount: 0
      });
    }
  }

  private async detectStopKnowledgeCandidate(event: ClientEventRecord): Promise<void> {
    const detector = "stop-evidence-v2";
    const decision = async (
      outcome: "created" | "skipped",
      reason: string,
      evidenceCount = 0,
      candidateId?: string
    ) => {
      await this.observability.recordCandidateDetection({
        detector,
        actorId: event.actorId,
        tenantId: event.tenantId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        outcome,
        reason,
        evidenceCount,
        candidateId
      });
    };

    const rawExcerpt = event.metadata.assistant_result_excerpt;
    if (event.metadata.stop_hook_active === true) {
      await decision("skipped", "stop-hook-recursion");
      return;
    }
    const parsedSummary = parseKnowledgeSummary(rawExcerpt);
    if (!parsedSummary.ok) {
      await decision("skipped", `summary-format-${parsedSummary.reason}`);
      return;
    }
    const excerpt = parsedSummary.summary.markdown;
    const normalizedExcerpt = excerpt.normalize("NFKC").toLowerCase().replace(/\b[0-9a-f]{8,}\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

    const summarySignalText = [
      parsedSummary.summary.title,
      parsedSummary.summary.problem,
      parsedSummary.summary.rootCause,
      parsedSummary.summary.solution,
      parsedSummary.summary.verification,
      parsedSummary.summary.applicability,
      parsedSummary.summary.constraints
    ].join("\n");
    const reusableSignals = /root cause|原因是|verified fix|修复|解决|resolved|fixed|workaround|临时方案|绕过|constraint|必须|不得|兼容|恢复|故障|安全|性能|可靠性/i;
    const lowValueSignals = /format(?:ting)?|prettier|lint only|typo|spelling|rename only|pure refactor|格式化|排版|拼写|仅重命名|纯重构|简单编译修复/i;
    if (lowValueSignals.test(summarySignalText) && !reusableSignals.test(summarySignalText)) {
      await decision("skipped", "low-reuse-value-summary");
      return;
    }

    const existing = await this.observability.listCandidates(2000);
    const sessionCandidates = existing.filter(
      (item) => item.sourceType === "codex-summary" && item.sourceSessionId === event.sessionId
    );
    const actorRecentCandidates = existing.filter((item) => {
      if (item.sourceType !== "codex-summary" || item.actorId !== event.actorId) return false;
      const ts = Date.parse(item.ts);
      return Number.isFinite(ts) && Date.now() - ts < 24 * 60 * 60 * 1000;
    });
    if (actorRecentCandidates.length >= 20) {
      await decision("skipped", "user-daily-candidate-limit");
      return;
    }
    if (
      existing.some(
        (item) =>
          item.sourceType === "codex-summary" &&
          item.content.normalize("NFKC").toLowerCase().replace(/\b[0-9a-f]{8,}\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim() === normalizedExcerpt
      )
    ) {
      await decision("skipped", "template-summary-duplicate");
      return;
    }
    if (sessionCandidates.length >= 3) {
      await decision("skipped", "session-candidate-limit");
      return;
    }
    if (
      existing.some(
        (item) =>
          item.sourceType === "codex-summary" &&
          item.sourceSessionId === event.sessionId &&
          item.sourceTurnId === event.turnId
      )
    ) {
      await decision("skipped", "candidate-already-generated");
      return;
    }

    const timeline = await this.observability.getClientSessionTimeline(
      event.actorId,
      event.tenantId,
      event.sessionId
    );
    const postToolEvents = timeline
      .filter((item) => item.kind === "event" && item.event.event === "PostToolUse")
      .map((item) => (item.kind === "event" ? item.event : undefined))
      .filter((item): item is ClientEventRecord => Boolean(item));
    const mcpCalls = timeline
      .filter((item) => item.kind === "mcp-call" && item.call.success)
      .map((item) => (item.kind === "mcp-call" ? item.call : undefined))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const repositoryCounts = new Map<string, number>();
    for (const item of timeline) {
      if (item.kind !== "event") continue;
      const projectContext = item.event.metadata.project_context;
      if (!projectContext || typeof projectContext !== "object") continue;
      const repositoryId = (projectContext as Record<string, unknown>).repositoryId;
      if (
        typeof repositoryId !== "string" ||
        !this.config.repositories.some((repository) => repository.id === repositoryId)
      ) continue;
      const weight = item.event.event === "SessionStart" ? 3 : 1;
      repositoryCounts.set(repositoryId, (repositoryCounts.get(repositoryId) ?? 0) + weight);
    }
    for (const call of mcpCalls) {
      const args = call.args ?? {};
      const direct = typeof args.repository === "string" ? args.repository : undefined;
      const repositories = Array.isArray(args.repositories)
        ? args.repositories.filter((item): item is string => typeof item === "string")
        : [];
      const inferred = direct ?? (repositories.length === 1 ? repositories[0] : undefined);
      if (!inferred || !this.config.repositories.some((repository) => repository.id === inferred)) continue;
      repositoryCounts.set(inferred, (repositoryCounts.get(inferred) ?? 0) + 1);
    }
    const inferredRepository = [...repositoryCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

    const reasons: string[] = [];
    const evidenceDetails: NonNullable<KnowledgeCandidate["automation"]>["evidence"] = [];
    let evidenceCount = 0;
    let hasStrongEvidence = false;
    let hasEngineeringAction = false;

    for (const toolEvent of postToolEvents) {
      const toolName = String(toolEvent.metadata.tool_name ?? "");
      if (toolName === "Bash" || toolName === "apply_patch" || toolName === "Edit" || toolName === "Write") {
        hasEngineeringAction = true;
      }
      const evidence =
        toolEvent.metadata.engineering_evidence ??
        normalizeEngineeringEvidence(toolName, toolEvent.metadata.evidence);
      if (!evidence || typeof evidence !== "object") continue;
      evidenceCount += 1;
      const record = evidence as ReturnType<typeof normalizeEngineeringEvidence>;
      if (!record) continue;
      evidenceDetails.push({
        type: record.type,
        sourceTool: record.sourceTool,
        ...(record.success !== undefined ? { success: record.success } : {}),
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        ...(record.counts ? { counts: record.counts } : {}),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record.status !== undefined ? { status: record.status } : {})
      });
      const testsPassed = Number(record.counts?.passed ?? 0);
      const testsFailed = Number(record.counts?.failed ?? 0);
      if (record.type === "test" && testsPassed > 0 && testsFailed === 0 && record.success !== false) {
        hasStrongEvidence = true;
        reasons.push(`tests passed: ${testsPassed}`);
      } else if (record.success === true) {
        reasons.push(`${record.type}: ${record.sourceTool} succeeded`);
      }
    }

    if (!hasEngineeringAction) {
      await decision("skipped", "no-engineering-action", evidenceCount);
      return;
    }
    if (!hasStrongEvidence) {
      await decision("skipped", "no-strong-test-evidence", evidenceCount);
      return;
    }

    const title = parsedSummary.summary.title;

    if (await this.observability.findExactCandidateDuplicate(title, excerpt.trim())) {
      await decision("skipped", "exact-candidate-duplicate", evidenceCount);
      return;
    }

    const nearDuplicate = await this.observability.findNearCandidateDuplicate(
      title,
      excerpt.trim(),
      inferredRepository,
      0.84
    );
    if (nearDuplicate) {
      await decision(
        "skipped",
        `near-candidate-duplicate:${nearDuplicate.candidate.id}:${nearDuplicate.score.toFixed(3)}`,
        evidenceCount
      );
      return;
    }

    const relatedKnowledge = inferredRepository
      ? this.knowledgeIndex
          .search(
            title + " " + excerpt.slice(0, 1200),
            [inferredRepository],
            3,
            [inferredRepository]
          )
          .map((result) => ({
            key: result.chunk.documentKey,
            repositoryId: result.chunk.repositoryId,
            path: result.chunk.relativePath,
            title: result.chunk.title,
            score: Number(result.score.toFixed(3)),
            metadata: result.chunk.metadata
          }))
      : [];
    if (inferredRepository) reasons.push(`repository inferred: ${inferredRepository}`);

    const classification =
      /workaround|临时方案|绕过/i.test(excerpt)
        ? "workaround"
        : hasStrongEvidence
          ? "verified-fix"
          : /root cause|根因|原因是|由于/i.test(excerpt)
            ? "root-cause"
            : /constraint|约束|必须|不得/i.test(excerpt)
              ? "reusable-constraint"
              : "verified-fix";
    const topRelated = relatedKnowledge[0];
    const conflictSignal = /conflict|contradict|inconsistent|冲突|矛盾|不一致|与现有.*相反/i.test(excerpt);
    const supersedeSignal = /supersede|replace(?:s|d)?|no longer|instead of|替代|取代|不再|改为/i.test(excerpt);
    const relationHint = topRelated
      ? conflictSignal
        ? {
            type: "conflicts_with" as const,
            target: {
              key: topRelated.key,
              repositoryId: topRelated.repositoryId,
              path: topRelated.path,
              title: topRelated.title
            },
            reason: "explicit conflict/contradiction signal with retrieved Knowledge",
            confidence: topRelated.score >= 8 ? "high" as const : "medium" as const
          }
        : supersedeSignal
          ? {
              type: "supersedes" as const,
              target: {
                key: topRelated.key,
                repositoryId: topRelated.repositoryId,
                path: topRelated.path,
                title: topRelated.title
              },
              reason: "explicit replacement/supersede signal with retrieved Knowledge",
              confidence: topRelated.score >= 8 ? "high" as const : "medium" as const
            }
          : (classification === "root-cause" || classification === "verified-fix") && topRelated.score >= 8
            ? {
                type: "updates" as const,
                target: {
                  key: topRelated.key,
                  repositoryId: topRelated.repositoryId,
                  path: topRelated.path,
                  title: topRelated.title
                },
                reason: "verified engineering result strongly matches existing Knowledge",
                confidence: topRelated.score >= 14 ? "high" as const : "medium" as const
              }
            : topRelated.score >= 12
              ? {
                  type: "related_to" as const,
                  target: {
                    key: topRelated.key,
                    repositoryId: topRelated.repositoryId,
                    path: topRelated.path,
                    title: topRelated.title
                  },
                  reason: "strong retrieval match without update/conflict evidence",
                  confidence: "medium" as const
                }
              : undefined
      : undefined;
    reasons.unshift(`classification: ${classification}`);
    if (relationHint) reasons.push(`relation hint: ${relationHint.type} -> ${relationHint.target.path}`);
    const candidate = await this.observability.createCandidate(
      { id: event.actorId, tenantId: event.tenantId, roles: [] },
      {
        title,
        content: excerpt.trim(),
        sourceType: "codex-summary",
        suggestedType: "knowledge",
        repository: inferredRepository,
        traceId: this.observability.traceIdForSession(
          { id: event.actorId, tenantId: event.tenantId, roles: [] },
          event.sessionId
        ),
        sourceSessionId: event.sessionId,
        sourceTurnId: event.turnId,
        automation: {
          detector,
          classification,
          generationReason: "engineering action + passing test evidence + reusable result",
          reasons: [...new Set(reasons)].slice(0, 10),
          evidenceCount,
          evidence: evidenceDetails.slice(0, 10)
        }
,
        relatedKnowledge,
        relationHint
      }
    );
    await decision("created", "verified-engineering-result", evidenceCount, candidate.id);
  }

  private statePath(): string {
    return path.join(this.config.dataDir, "state", "registry.json");
  }

  private artifactStatePath(): string {
    return path.join(this.config.dataDir, "state", "artifacts.json");
  }

  private async persistArtifactState(): Promise<void> {
    await writeFile(
      this.artifactStatePath(),
      JSON.stringify(
        {
          prompts: [...this.prompts.values()],
          agents: [...this.agents.values()],
          tools: [...this.tools.values()],
          knowledgeDocuments: [...this.knowledgeDocuments.values()]
        },
        null,
        2
      ),
      "utf8"
    );
  }

  private revisionRoot(repositoryId: string): string {
    return path.join(this.config.dataDir, "revisions", repositoryId);
  }

  private webhookDedupPath(): string {
    return path.join(this.config.dataDir, "webhooks", "seen.json");
  }

  private revisionRetentionMax(): number {
    return this.config.revisionRetentionMax ?? 20;
  }

  private webhookDedupMaxEntries(): number {
    return this.config.webhookDedupMaxEntries ?? 1000;
  }

  private webhookDedupTtlSeconds(): number {
    return this.config.webhookDedupTtlSeconds ?? 604800;
  }

  renderMetrics(): string {
    return this.metrics.render();
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.statePath()), { recursive: true });
    await this.loadWebhookDedup();
    try {
      this.registry.hydrate(JSON.parse(await readFile(this.statePath(), "utf8")));
      this.search.rebuild(this.registry.list());
      try {
        const artifactState = JSON.parse(await readFile(this.artifactStatePath(), "utf8")) as {
          prompts?: PromptArtifact[];
          agents?: AgentArtifact[];
          tools?: ToolArtifact[];
          knowledgeDocuments?: KnowledgeDocument[];
        };
        for (const prompt of artifactState.prompts ?? []) this.prompts.set(prompt.key, prompt);
        for (const agent of artifactState.agents ?? []) this.agents.set(agent.key, agent);
        for (const tool of artifactState.tools ?? []) this.tools.set(tool.key, tool);
        for (const document of artifactState.knowledgeDocuments ?? []) {
          this.knowledgeDocuments.set(document.key, document);
        }
        this.knowledgeIndex.rebuild(chunksForDocuments([...this.knowledgeDocuments.values()]));
      } catch {
        // First startup or pre-artifact state.
      }
    } catch {
      // First startup is expected to have no persisted registry.
    }

    for (const repository of this.config.repositories) {
      if (!repository.enabled) continue;
      try {
        await this.syncRepository(repository.id, "startup");
      } catch (error) {
        this.events.emit("repository.sync.failed", {
          repository: repository.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.recomputeReadyState();
  }

  private async loadWebhookDedup(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.webhookDedupPath(), "utf8")) as Record<string, number>;
      const cutoff = Date.now() - this.webhookDedupTtlSeconds() * 1000;
      for (const [id, ts] of Object.entries(parsed)) {
        if (Number.isFinite(ts) && ts >= cutoff) this.webhookSeen.set(id, ts);
      }
    } catch {
      // No persisted webhook history on first startup.
    }
  }

  private async persistWebhookDedup(): Promise<void> {
    const cutoff = Date.now() - this.webhookDedupTtlSeconds() * 1000;
    for (const [id, ts] of this.webhookSeen) {
      if (ts < cutoff) this.webhookSeen.delete(id);
    }
    const ordered = [...this.webhookSeen.entries()].sort((a, b) => b[1] - a[1]);
    this.webhookSeen.clear();
    for (const [id, ts] of ordered.slice(0, this.webhookDedupMaxEntries())) {
      this.webhookSeen.set(id, ts);
    }
    await mkdir(path.dirname(this.webhookDedupPath()), { recursive: true });
    await writeFile(
      this.webhookDedupPath(),
      JSON.stringify(Object.fromEntries(this.webhookSeen), null, 2),
      "utf8"
    );
  }

  async claimWebhookEvent(eventId?: string): Promise<boolean> {
    if (!eventId) return true;
    const normalized = eventId.trim();
    if (!normalized) return true;
    if (this.webhookSeen.has(normalized)) {
      this.metrics.increment("webhook_duplicate_total");
      return false;
    }
    this.webhookSeen.set(normalized, Date.now());
    await this.persistWebhookDedup();
    return true;
  }

  private recomputeReadyState(): void {
    const enabledRepositories = this.config.repositories.filter((repository) => repository.enabled);
    this.ready =
      enabledRepositories.length === 0 ||
      enabledRepositories.every((repository) => this.states.get(repository.id)?.status === "healthy");
  }

  isReady(): boolean {
    return this.ready;
  }

  listRepositoryStates(): RepositoryState[] {
    return [...this.states.values()];
  }

  applyRuntimeConfig(next: AppConfig): void {
    const previousIds = new Set(this.config.repositories.map((repository) => repository.id));
    this.config.defaultRoles = [...next.defaultRoles];
    this.config.revisionRetentionMax = next.revisionRetentionMax;
    this.config.webhookDedupMaxEntries = next.webhookDedupMaxEntries;
    this.config.webhookDedupTtlSeconds = next.webhookDedupTtlSeconds;
    this.config.projects = (next.projects ?? []).map((project) => ({
      ...project,
      repositoryPatterns: [...project.repositoryPatterns],
      owners: [...project.owners],
      preferredSkillRepositories: [...project.preferredSkillRepositories],
      preferredKnowledgeRepositories: [...project.preferredKnowledgeRepositories],
      tools: [...project.tools],
      environments: [...project.environments],
      aliases: [...project.aliases]
    }));
    this.config.repositories = next.repositories.map((repository) => ({
      ...repository,
      gitAuth: { ...repository.gitAuth },
      webhookAliases: [...repository.webhookAliases],
      audience: [...repository.audience],
      visibility: [...repository.visibility],
      readRoles: [...repository.readRoles],
      syncRoles: [...repository.syncRoles],
      knowledge: normalizeKnowledgeConfig(repository.knowledge),
      knowledgePublishing: repository.knowledgePublishing ? { ...repository.knowledgePublishing } : undefined
    }));
    const nextIds = new Set(this.config.repositories.map((repository) => repository.id));
    for (const repository of this.config.repositories) {
      const state = this.states.get(repository.id);
      if (!state) {
        this.states.set(repository.id, {
          id: repository.id,
          status: repository.enabled ? "syncing" : "disabled",
          skillCount: 0,
          failureCount: 0
        });
      } else if (!repository.enabled) {
        state.status = "disabled";
      } else if (state.status === "disabled") {
        state.status = "syncing";
      }
    }
    for (const id of previousIds) {
      if (!nextIds.has(id)) this.states.delete(id);
    }
    this.recomputeReadyState();
  }

  repositoryIds(): string[] {
    return this.config.repositories.filter((repo) => repo.enabled).map((repo) => repo.id);
  }

  resolveRepositoryWebhookReference(references: string[]): string | undefined {
    const normalizedRefs = new Set(
      references
        .map((value) => value.trim().replace(/\.git$/i, ""))
        .filter(Boolean)
    );
    for (const repository of this.config.repositories) {
      if (!repository.enabled) continue;
      const candidates = new Set<string>([
        repository.id,
        repository.name,
        ...repository.webhookAliases
      ]);
      if (repository.gitUrl) {
        const normalizedUrl = repository.gitUrl.replace(/\.git$/i, "");
        candidates.add(normalizedUrl);
        const tail = normalizedUrl.split(/[/:]/).filter(Boolean).slice(-2).join("/");
        const basename = normalizedUrl.split(/[/:]/).filter(Boolean).at(-1);
        if (tail) candidates.add(tail);
        if (basename) candidates.add(basename);
      }
      if ([...candidates].some((candidate) => normalizedRefs.has(candidate.replace(/\.git$/i, "")))) {
        return repository.id;
      }
    }
    return undefined;
  }

  pollingIntervalSeconds(repositoryId: string): number {
    return this.getRepository(repositoryId).pollingIntervalSeconds;
  }

  authenticateRequest(headers?: Headers): Principal {
    return this.auth.authenticate(headers);
  }

  private principal(principal?: Principal): Principal {
    return principal ?? this.auth.authenticate();
  }

  private auditPath(): string {
    return path.join(this.config.dataDir, "audit", "events.jsonl");
  }

  private async appendAudit(event: AuditEvent): Promise<void> {
    await mkdir(path.dirname(this.auditPath()), { recursive: true });
    await appendFile(this.auditPath(), `${JSON.stringify(event)}\n`, "utf8");
  }

  async listAuditEvents(
    limit = 100,
    repositoryId?: string,
    principal?: Principal
  ): Promise<AuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const allowed = new Set(
      this.allowedRepositories(principal).map((repository) => repository.id)
    );
    try {
      const lines = (await readFile(this.auditPath(), "utf8"))
        .split("\n")
        .filter(Boolean);
      const events = lines
        .map((line) => JSON.parse(line) as AuditEvent)
        .filter((event) => allowed.has(event.repositoryId))
        .filter((event) => !repositoryId || event.repositoryId === repositoryId);
      return events.slice(-safeLimit).reverse();
    } catch {
      return [];
    }
  }

  async listRepositoryRevisions(
    repositoryId: string,
    principal?: Principal
  ): Promise<RepositoryRevision[]> {
    const allowed = this.allowedRepositories(principal).some((repo) => repo.id === repositoryId);
    if (!allowed) throw new Error("Repository not found");
    const state = this.states.get(repositoryId);
    try {
      const entries = await readdir(this.revisionRoot(repositoryId), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          revision: entry.name,
          active: state?.revision === entry.name,
          lastGood: state?.lastGoodRevision === entry.name
        }))
        .sort((a, b) => b.revision.localeCompare(a.revision));
    } catch {
      return [];
    }
  }

  private async enforceRevisionRetention(repositoryId: string): Promise<void> {
    const root = this.revisionRoot(repositoryId);
    let entries;
    try {
      entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    } catch {
      return;
    }
    const state = this.states.get(repositoryId);
    const protectedRevisions = new Set(
      [state?.revision, state?.lastGoodRevision].filter((value): value is string => Boolean(value))
    );
    const withTime = await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        mtimeMs: (await stat(path.join(root, entry.name))).mtimeMs
      }))
    );
    withTime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set<string>(protectedRevisions);
    for (const entry of withTime) {
      if (keep.size >= this.revisionRetentionMax()) break;
      keep.add(entry.name);
    }
    for (const entry of withTime) {
      if (keep.has(entry.name)) continue;
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      this.metrics.increment("repository_revision_pruned_total", { repository: repositoryId });
    }
  }

  async rollbackRepositoryRevision(
    repositoryId: string,
    revision: string,
    principal?: Principal
  ): Promise<RepositoryState> {
    const repository = this.getRepository(repositoryId);
    const resolvedPrincipal = this.principal(principal);
    if (!this.permissions.canSyncRepository(resolvedPrincipal, repository)) {
      throw new Error("Repository rollback not permitted");
    }
    const root = path.resolve(this.revisionRoot(repositoryId));
    const target = path.resolve(root, revision);
    const relative = path.relative(root, target);
    if (!revision || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Invalid revision");
    }
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("Revision not found");

    try {
      const skills = await scanSkills(target, repositoryId, revision);
      const prompts = await scanPrompts(target, repositoryId, revision);
      const agents = await scanAgents(target, repositoryId, revision);
      const tools = await scanTools(target, repositoryId, revision);
      const knowledgeDocuments = await scanKnowledge(target, repositoryId, revision, repository.knowledge);
      await scanEvaluationSuites(target, repositoryId);
      const artifactIssues = validateArtifactPolicies(
        repository,
        prompts,
        agents,
        skills.map((skill) => skill.name),
        tools
      );
      if (artifactIssues.length > 0) {
        throw new Error(`Stored revision artifacts invalid: ${artifactIssues.join("; ")}`);
      }
      const issues = validateSkills(skills, repository, this.rules);
      if (issues.length > 0) throw new Error("Stored revision failed validation");
      this.registry.replaceRepository(repositoryId, skills);
      for (const [key, prompt] of this.prompts) if (prompt.repositoryId === repositoryId) this.prompts.delete(key);
      for (const prompt of prompts) this.prompts.set(prompt.key, prompt);
      for (const [key, agent] of this.agents) if (agent.repositoryId === repositoryId) this.agents.delete(key);
      for (const agent of agents) this.agents.set(agent.key, agent);
      for (const [key, tool] of this.tools) if (tool.repositoryId === repositoryId) this.tools.delete(key);
      for (const tool of tools) this.tools.set(tool.key, tool);
      for (const [key, document] of this.knowledgeDocuments) {
        if (document.repositoryId === repositoryId) this.knowledgeDocuments.delete(key);
      }
      for (const document of knowledgeDocuments) this.knowledgeDocuments.set(document.key, document);
      this.search.rebuild(this.registry.list());
      this.knowledgeIndex.rebuild(chunksForDocuments([...this.knowledgeDocuments.values()]));
      await writeFile(this.statePath(), JSON.stringify(this.registry.serialize(), null, 2), "utf8");
      await this.persistArtifactState();
      const state = this.states.get(repositoryId)!;
      state.status = "healthy";
      state.revision = revision;
      state.lastGoodRevision = revision;
      state.lastSuccessAt = new Date().toISOString();
      state.skillCount = skills.length;
      state.promptCount = prompts.length;
      state.agentCount = agents.length;
      state.toolCount = tools.length;
      state.knowledgeDocumentCount = knowledgeDocuments.length;
      state.knowledgeChunkCount = knowledgeDocuments.reduce((sum, item) => sum + item.chunkCount, 0);
      state.error = undefined;
      await this.appendAudit({
        ts: new Date().toISOString(),
        action: "repository.rollback.completed",
        repositoryId,
        actorId: resolvedPrincipal.id,
        trigger: "manual",
        revision,
        skillCount: skills.length
      });
      this.metrics.increment("repository_rollback_total", { repository: repositoryId, result: "success" });
      await this.enforceRevisionRetention(repositoryId);
      return { ...state };
    } catch (error) {
      await this.appendAudit({
        ts: new Date().toISOString(),
        action: "repository.rollback.failed",
        repositoryId,
        actorId: resolvedPrincipal.id,
        trigger: "manual",
        revision,
        error: error instanceof Error ? error.message : String(error)
      });
      this.metrics.increment("repository_rollback_total", { repository: repositoryId, result: "failed" });
      throw error;
    }
  }

  async syncRepository(
    repositoryId: string,
    trigger: RepositorySyncTrigger = "manual",
    principal?: Principal
  ): Promise<RepositoryState> {
    const existing = this.syncInFlight.get(repositoryId);
    if (existing) return existing;
    const work = this.performSync(repositoryId, trigger, principal).finally(() => {
      this.syncInFlight.delete(repositoryId);
    });
    this.syncInFlight.set(repositoryId, work);
    return work;
  }

  private async performSync(
    repositoryId: string,
    trigger: RepositorySyncTrigger,
    requestPrincipal?: Principal
  ): Promise<RepositoryState> {
    const syncStarted = performance.now();
    const repository = this.getRepository(repositoryId);
    const principal =
      requestPrincipal ??
      (trigger === "manual"
        ? this.auth.authenticate()
        : { id: "system", roles: ["admin", "developer", "internal", "customer"], tenantId: "default" });
    if (trigger === "manual" && !this.permissions.canSyncRepository(principal, repository)) {
      const denied: AuditEvent = {
        ts: new Date().toISOString(),
        action: "repository.sync.denied",
        repositoryId,
        actorId: principal.id,
        trigger
      };
      await this.appendAudit(denied);
      throw new Error("Repository sync not permitted");
    }
    const state = this.states.get(repositoryId)!;
    state.status = "syncing";
    state.error = undefined;
    this.events.emit("repository.sync.started", { repository: repositoryId });
    await this.appendAudit({
      ts: new Date().toISOString(),
      action: "repository.sync.started",
      repositoryId,
      actorId: trigger === "manual" ? principal.id : "system",
      trigger
    });

    try {
      const provider = this.providers.get(repository.provider);
      if (!provider) throw new Error(`No provider registered for ${repository.provider}`);
      const materialized = await provider.materialize(repository, this.config.dataDir);
      const scannedSkills = await scanSkills(
        materialized.sourceRoot,
        repository.id,
        materialized.revision
      );
      const issues = validateSkills(scannedSkills, repository, this.rules);
      if (issues.length > 0) {
        throw new Error(
          `Validation failed: ${issues.map((issue) => `${issue.skillPath ?? "repo"}: ${issue.message}`).join("; ")}`
        );
      }
      const scannedPrompts = await scanPrompts(
        materialized.sourceRoot,
        repository.id,
        materialized.revision
      );
      const scannedAgents = await scanAgents(
        materialized.sourceRoot,
        repository.id,
        materialized.revision
      );
      const scannedTools = await scanTools(
        materialized.sourceRoot,
        repository.id,
        materialized.revision
      );
      await scanEvaluationSuites(materialized.sourceRoot, repository.id);
      const artifactIssues = validateArtifactPolicies(
        repository,
        scannedPrompts,
        scannedAgents,
        scannedSkills.map((skill) => skill.name),
        scannedTools
      );
      if (artifactIssues.length > 0) {
        throw new Error(`Artifact validation failed: ${artifactIssues.join("; ")}`);
      }

      const snapshotRoot = await createValidatedSnapshot(
        materialized.sourceRoot,
        this.config.dataDir,
        repository.id,
        materialized.revision
      );
      const skills = await scanSkills(snapshotRoot, repository.id, materialized.revision);
      const prompts = await scanPrompts(snapshotRoot, repository.id, materialized.revision);
      const agents = await scanAgents(snapshotRoot, repository.id, materialized.revision);
      const tools = await scanTools(snapshotRoot, repository.id, materialized.revision);
      const knowledgeDocuments = await scanKnowledge(snapshotRoot, repository.id, materialized.revision, repository.knowledge);
      this.registry.replaceRepository(repository.id, skills);
      for (const [key, prompt] of this.prompts) {
        if (prompt.repositoryId === repository.id) this.prompts.delete(key);
      }
      for (const prompt of prompts) this.prompts.set(prompt.key, prompt);
      for (const [key, agent] of this.agents) {
        if (agent.repositoryId === repository.id) this.agents.delete(key);
      }
      for (const agent of agents) this.agents.set(agent.key, agent);
      for (const [key, tool] of this.tools) {
        if (tool.repositoryId === repository.id) this.tools.delete(key);
      }
      for (const tool of tools) this.tools.set(tool.key, tool);
      for (const [key, document] of this.knowledgeDocuments) {
        if (document.repositoryId === repository.id) this.knowledgeDocuments.delete(key);
      }
      for (const document of knowledgeDocuments) this.knowledgeDocuments.set(document.key, document);
      this.search.rebuild(this.registry.list());
      this.knowledgeIndex.rebuild(chunksForDocuments([...this.knowledgeDocuments.values()]));
      await writeFile(this.statePath(), JSON.stringify(this.registry.serialize(), null, 2), "utf8");
      await this.persistArtifactState();

      state.status = "healthy";
      state.revision = materialized.revision;
      state.lastGoodRevision = materialized.revision;
      state.lastSyncAt = new Date().toISOString();
      state.lastSuccessAt = state.lastSyncAt;
      state.skillCount = skills.length;
      state.promptCount = prompts.length;
      state.agentCount = agents.length;
      state.toolCount = tools.length;
      state.knowledgeDocumentCount = knowledgeDocuments.length;
      state.knowledgeChunkCount = knowledgeDocuments.reduce((sum, item) => sum + item.chunkCount, 0);
      state.failureCount = 0;
      this.recomputeReadyState();
      this.events.emit("repository.sync.completed", {
        repository: repository.id,
        revision: materialized.revision,
        skillCount: skills.length
      });
      await this.appendAudit({
        ts: new Date().toISOString(),
        action: "repository.sync.completed",
        repositoryId,
        actorId: trigger === "manual" ? principal.id : "system",
        trigger,
        revision: materialized.revision,
        skillCount: skills.length
      });
      this.metrics.increment("repository_sync_total", { repository: repositoryId, result: "success", trigger });
      this.metrics.observe("repository_sync_duration_seconds", (performance.now() - syncStarted) / 1000, { repository: repositoryId });
      await this.enforceRevisionRetention(repositoryId);
      return { ...state };
    } catch (error) {
      state.status = "error";
      state.error = error instanceof Error ? error.message : String(error);
      state.lastSyncAt = new Date().toISOString();
      state.failureCount += 1;
      this.recomputeReadyState();
      await this.appendAudit({
        ts: new Date().toISOString(),
        action: "repository.sync.failed",
        repositoryId,
        actorId: trigger === "manual" ? principal.id : "system",
        trigger,
        error: state.error
      });
      this.metrics.increment("repository_sync_total", { repository: repositoryId, result: "failed", trigger });
      this.metrics.observe("repository_sync_duration_seconds", (performance.now() - syncStarted) / 1000, { repository: repositoryId });
      throw error;
    }
  }

  private allowedRepositories(principal?: Principal): RepositoryConfig[] {
    return this.permissions.allowedRepositories(this.principal(principal), this.config.repositories);
  }

  listRepositories(principal?: Principal): RepositoryView[] {
    return this.allowedRepositories(principal).map((repository) => ({
      id: repository.id,
      name: repository.name,
      provider: repository.provider,
      audience: repository.audience,
      visibility: repository.visibility,
      state: this.states.get(repository.id)
    }));
  }

  listSkills(filters: SearchFilters = {}, principal?: Principal): Skill[] {
    const resolvedPrincipal = this.principal(principal);
    const allowed = new Map(
      this.allowedRepositories(resolvedPrincipal).map((repo) => [repo.id, repo])
    );
    return this.registry.list().filter((skill) => {
      const repo = allowed.get(skill.repositoryId);
      if (!repo || !this.permissions.canReadSkill(resolvedPrincipal, repo, skill)) return false;
      if (filters.repositories?.length && !filters.repositories.includes(skill.repositoryId)) return false;
      if (filters.domain && !skill.metadata.domain.includes(filters.domain)) return false;
      if (filters.category && !skill.metadata.category.includes(filters.category)) return false;
      if (filters.audience && !skill.metadata.audience.includes(filters.audience)) return false;
      if (filters.maturity && skill.metadata.maturity !== filters.maturity) return false;
      if (filters.client && skill.metadata.compatibility[filters.client] === false) return false;
      return true;
    });
  }

  searchSkills(
    query: string,
    filters: SearchFilters = {},
    limit = 5,
    principal?: Principal
  ): SearchResult[] {
    this.metrics.increment("skill_search_total");
    const resolvedPrincipal = this.principal(principal);
    const allowedIds = this.allowedRepositories(resolvedPrincipal).map((repo) => repo.id);
    const repositories = filters.repositories
      ? filters.repositories.filter((id) => allowedIds.includes(id))
      : allowedIds;
    const permitted = new Set(
      this.listSkills({ ...filters, repositories }, resolvedPrincipal).map((skill) => skill.key)
    );
    const results = this.search
      .search(query, { ...filters, repositories }, limit * 2)
      .filter((result) => permitted.has(result.skill.key))
      .slice(0, limit);
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "skill",
      action: "search",
      query,
      selected: results[0]?.skill.key,
      matched: results.length > 0
    });
    return results;
  }

  resolveSkill(
    query: string,
    filters: SearchFilters = {},
    limit = 3,
    principal?: Principal
  ): SearchResult[] {
    this.metrics.increment("skill_resolve_total");
    const resolvedPrincipal = this.principal(principal);
    const allowedIds = this.allowedRepositories(resolvedPrincipal).map((repo) => repo.id);
    const repositories = filters.repositories
      ? filters.repositories.filter((id) => allowedIds.includes(id))
      : allowedIds;
    const permitted = new Set(
      this.listSkills({ ...filters, repositories }, resolvedPrincipal).map((skill) => skill.key)
    );
    const results = this.router
      .resolve(query, { ...filters, repositories }, limit * 2)
      .filter((result) => permitted.has(result.skill.key))
      .slice(0, limit);
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "skill",
      action: "resolve",
      query,
      selected: results[0]?.skill.key,
      matched: results.length > 0
    });
    return results;
  }

  getSkill(repositoryId: string, name: string, principal?: Principal): Skill {
    this.metrics.increment("skill_load_total", { repository: repositoryId });
    const resolvedPrincipal = this.principal(principal);
    const repo = this.getRepository(repositoryId);
    const skill = this.registry.get(repositoryId, name);
    if (!skill || !this.permissions.canReadSkill(resolvedPrincipal, repo, skill)) {
      throw new Error("Skill not found");
    }
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "skill",
      action: "load",
      selected: skill.key,
      matched: true
    });
    return skill;
  }

  async getSkillResource(
    repositoryId: string,
    name: string,
    resource: string,
    principal?: Principal
  ): Promise<string> {
    const skill = this.getSkill(repositoryId, name, principal);
    const root = path.resolve(skill.rootDir);
    const target = path.resolve(root, resource);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Resource path escapes skill directory");
    }
    return await readFile(target, "utf8");
  }

  listKnowledgeDocuments(principal?: Principal, repositories?: string[]): KnowledgeDocument[] {
    const allowed = new Set(this.allowedRepositories(principal).map((repository) => repository.id));
    const requested = repositories?.length ? new Set(repositories) : undefined;
    return [...this.knowledgeDocuments.values()].filter(
      (document) =>
        allowed.has(document.repositoryId) &&
        (!requested || requested.has(document.repositoryId))
    );
  }

  getKnowledgeLifecycleAudit(principal?: Principal, repositories?: string[]) {
    const documents = this.listKnowledgeDocuments(principal, repositories);
    const issues = auditKnowledgeLifecycle(documents);
    const byKind: Record<string, number> = {};
    for (const issue of issues) byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;
    return {
      documents: documents.length,
      issues,
      byKind
    };
  }

  async createKnowledgeReviewCandidateFromLifecycleIssue(
    repositoryId: string,
    relativePath: string,
    kind: string,
    principal: Principal
  ) {
    const allowed = this.allowedRepositories(principal).some((repo) => repo.id === repositoryId);
    if (!allowed) throw new Error("Repository not found");
    const document = this.knowledgeDocuments.get(`${repositoryId}:${relativePath}`);
    if (!document) throw new Error("Knowledge document not found");
    const issue = auditKnowledgeLifecycle([document]).find((item) => item.kind === kind);
    if (!issue) throw new Error("Knowledge lifecycle issue not found");

    const metadata = document.metadata;
    const frontmatter = [
      "---",
      metadata?.owner ? `owner: ${metadata.owner}` : "owner: TODO",
      `status: ${metadata?.status ?? "active"}`,
      metadata?.tags?.length ? `tags: [${metadata.tags.join(", ")}]` : undefined,
      metadata?.createdAt ? `created_at: ${metadata.createdAt}` : undefined,
      `updated_at: ${new Date().toISOString().slice(0, 10)}`,
      metadata?.validFrom ? `valid_from: ${metadata.validFrom}` : undefined,
      metadata?.validUntil ? `valid_until: ${metadata.validUntil}` : undefined,
      metadata?.source ? `source: ${metadata.source}` : undefined,
      metadata?.supersedes ? `supersedes: ${metadata.supersedes}` : undefined,
      metadata?.reviewCycleDays ? `review_cycle: ${metadata.reviewCycleDays}d` : undefined,
      "---",
      ""
    ].filter((item): item is string => Boolean(item));

    return await this.observability.createCandidate(principal, {
      title: `Lifecycle review: ${document.title}`,
      content: [
        ...frontmatter,
        document.content,
        "",
        "<!--",
        `Lifecycle issue: ${issue.kind}`,
        issue.message,
        "Reviewer: verify the knowledge content and lifecycle metadata before approval.",
        "-->"
      ].join("\n"),
      sourceType: "review",
      suggestedType: "knowledge",
      repository: repositoryId,
      suggestedPath: relativePath,
      relatedKnowledge: [{
        key: document.key,
        repositoryId: document.repositoryId,
        path: document.relativePath,
        title: document.title,
        score: 100,
        metadata: document.metadata
      }],
      relationHint: {
        type: "updates",
        target: {
          key: document.key,
          repositoryId: document.repositoryId,
          path: document.relativePath,
          title: document.title
        },
        reason: `lifecycle issue: ${issue.kind}`,
        confidence: "high"
      }
    });
  }

  searchKnowledge(
    query: string,
    limit = 5,
    repositories?: string[],
    principal?: Principal,
    applicability?: KnowledgeApplicabilityContext
  ): KnowledgeSearchResult[] {
    const resolvedPrincipal = this.principal(principal);
    const allowedIds = this.allowedRepositories(resolvedPrincipal).map((repository) => repository.id);
    const results = this.knowledgeIndex.search(query, allowedIds, limit, repositories, applicability);
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "knowledge",
      action: "search",
      query,
      selected: results[0]?.chunk.key,
      matched: results.length > 0
    });
    this.metrics.increment("knowledge_search_total", { matched: String(results.length > 0) });
    return results;
  }

  getKnowledge(
    repositoryId: string,
    relativePath: string,
    chunkIndex?: number,
    principal?: Principal
  ) {
    const resolvedPrincipal = this.principal(principal);
    const allowed = this.allowedRepositories(resolvedPrincipal).some(
      (repository) => repository.id === repositoryId
    );
    const document = this.knowledgeDocuments.get(`${repositoryId}:${relativePath}`);
    if (!allowed || !document) throw new Error("Knowledge document not found");
    const chunk =
      chunkIndex === undefined
        ? undefined
        : chunksForDocuments([document]).find((item) => item.chunkIndex === chunkIndex);
    if (chunkIndex !== undefined && !chunk) throw new Error("Knowledge chunk not found");
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "knowledge",
      action: "load",
      selected: chunk?.key ?? document.key,
      matched: true
    });
    this.metrics.increment("knowledge_load_total", { repository: repositoryId });
    return { document, ...(chunk ? { chunk } : {}) };
  }

  listPrompts(client?: string, principal?: Principal): PromptArtifact[] {
    const resolvedPrincipal = this.principal(principal);
    const allowed = new Map(this.allowedRepositories(resolvedPrincipal).map((repo) => [repo.id, repo]));
    return [...this.prompts.values()].filter((prompt) => {
      const repository = allowed.get(prompt.repositoryId);
      if (!repository || !canReadArtifact(repository, prompt.visibility, resolvedPrincipal.roles)) return false;
      if (client && prompt.compatibility[client] === false) return false;
      return true;
    });
  }

  searchPrompts(
    query: string,
    limit = 5,
    client?: string,
    principal?: Principal
  ): ArtifactSearchResult<PromptArtifact>[] {
    const resolvedPrincipal = this.principal(principal);
    const results = searchArtifacts(query, this.listPrompts(client, resolvedPrincipal), limit);
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "prompt",
      action: "search",
      query,
      selected: results[0]?.artifact.key,
      matched: results.length > 0
    });
    this.metrics.increment("prompt_search_total", { matched: String(results.length > 0) });
    return results;
  }

  getPrompt(repositoryId: string, name: string, principal?: Principal): PromptArtifact {
    const resolvedPrincipal = this.principal(principal);
    const prompt = this.prompts.get(`${repositoryId}:${name}`);
    const repository = this.getRepository(repositoryId);
    if (!prompt || !canReadArtifact(repository, prompt.visibility, resolvedPrincipal.roles)) {
      throw new Error("Prompt not found");
    }
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "prompt",
      action: "load",
      selected: prompt.key,
      matched: true
    });
    this.metrics.increment("prompt_load_total", { repository: repositoryId });
    return prompt;
  }

  listAgents(client?: string, principal?: Principal): AgentArtifact[] {
    const resolvedPrincipal = this.principal(principal);
    const allowed = new Map(this.allowedRepositories(resolvedPrincipal).map((repo) => [repo.id, repo]));
    return [...this.agents.values()].filter((agent) => {
      const repository = allowed.get(agent.repositoryId);
      if (!repository || !canReadArtifact(repository, agent.visibility, resolvedPrincipal.roles)) return false;
      if (client && agent.compatibility[client] === false) return false;
      return true;
    });
  }

  searchAgents(
    query: string,
    limit = 5,
    client?: string,
    principal?: Principal
  ): ArtifactSearchResult<AgentArtifact>[] {
    const resolvedPrincipal = this.principal(principal);
    const results = searchArtifacts(query, this.listAgents(client, resolvedPrincipal), limit);
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "agent",
      action: "search",
      query,
      selected: results[0]?.artifact.key,
      matched: results.length > 0
    });
    this.metrics.increment("agent_search_total", { matched: String(results.length > 0) });
    return results;
  }

  listTools(client?: string, principal?: Principal): ToolArtifact[] {
    const resolvedPrincipal = this.principal(principal);
    const allowed = new Map(this.allowedRepositories(resolvedPrincipal).map((repo) => [repo.id, repo]));
    return [...this.tools.values()].filter((tool) => {
      const repository = allowed.get(tool.repositoryId);
      if (!repository || !canReadArtifact(repository, tool.visibility, resolvedPrincipal.roles)) return false;
      if (tool.permissions?.length && !tool.permissions.some((role) => resolvedPrincipal.roles.includes(role))) {
        return false;
      }
      if (client && tool.compatibility[client] === false) return false;
      return true;
    });
  }

  searchTools(
    query: string,
    limit = 5,
    client?: string,
    principal?: Principal
  ): ArtifactSearchResult<ToolArtifact>[] {
    const results = searchArtifacts(query, this.listTools(client, principal), limit);
    this.metrics.increment("tool_search_total", { matched: String(results.length > 0) });
    return results;
  }

  getTool(repositoryId: string, name: string, principal?: Principal): ToolArtifact {
    const resolvedPrincipal = this.principal(principal);
    const tool = this.tools.get(`${repositoryId}:${name}`);
    const repository = this.getRepository(repositoryId);
    if (
      !tool ||
      !canReadArtifact(repository, tool.visibility, resolvedPrincipal.roles) ||
      (tool.permissions?.length && !tool.permissions.some((role) => resolvedPrincipal.roles.includes(role)))
    ) {
      throw new Error("Tool not found");
    }
    this.metrics.increment("tool_load_total", { repository: repositoryId });
    return tool;
  }

  discover(
    query: string,
    options: {
      topK?: number;
      repositories?: string[];
      client?: string;
    } = {},
    principal?: Principal
  ) {
    const resolvedPrincipal = this.principal(principal);
    const topK = Math.max(1, Math.min(options.topK ?? 5, 20));
    const allowedIds = this.allowedRepositories(resolvedPrincipal).map((repository) => repository.id);
    const repositories = options.repositories?.length
      ? options.repositories.filter((id) => allowedIds.includes(id))
      : allowedIds;
    if (repositories.length === 0) {
      return { skills: [], knowledge: [], prompts: [], agents: [], tools: [] };
    }

    const skills = this.searchSkills(
      query,
      { repositories, client: options.client },
      topK,
      resolvedPrincipal
    );
    const knowledge = this.searchKnowledge(query, topK, repositories, resolvedPrincipal);
    const repositorySet = new Set(repositories);
    const prompts = searchArtifacts(
      query,
      this.listPrompts(options.client, resolvedPrincipal).filter((item) =>
        repositorySet.has(item.repositoryId)
      ),
      topK
    );
    const agents = searchArtifacts(
      query,
      this.listAgents(options.client, resolvedPrincipal).filter((item) =>
        repositorySet.has(item.repositoryId)
      ),
      topK
    );
    const tools = searchArtifacts(
      query,
      this.listTools(options.client, resolvedPrincipal).filter((item) =>
        repositorySet.has(item.repositoryId)
      ),
      topK
    );
    this.metrics.increment("discover_total", {
      matched: String(skills.length + knowledge.length + prompts.length + agents.length + tools.length > 0)
    });
    return { skills, knowledge, prompts, agents, tools };
  }

  recommendProjectContext(
    input: {
      cwd?: string;
      gitRemote?: string;
      gitRoot?: string;
      gitBranch?: string;
      task?: string;
      client?: string;
      topK?: number;
    },
    principal?: Principal
  ) {
    const resolvedPrincipal = this.principal(principal);
    const visibleRepositories = this.allowedRepositories(resolvedPrincipal);
    const project = resolveProjectContext(input.cwd, visibleRepositories, {
      remote: input.gitRemote,
      root: input.gitRoot,
      branch: input.gitBranch
    });
    if (!project) {
      return {
        project: undefined,
        query: input.task?.trim() || "",
        reason: "project could not be identified unambiguously",
        recommendations: { skills: [], knowledge: [], prompts: [], agents: [], tools: [] }
      };
    }
    const normalizeProjectToken = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const wildcardMatch = (pattern: string, value: string) => {
      const normalizedPattern = pattern
        .toLowerCase()
        .split("*")
        .map((part) => normalizeProjectToken(part).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp("^" + normalizedPattern + "$", "i").test(normalizeProjectToken(value));
    };
    const profiles = (this.config.projects ?? []).filter((profile) => {
      const aliases = [profile.id, profile.name, ...profile.aliases];
      return profile.repositoryPatterns.some(
        (pattern) =>
          wildcardMatch(pattern, project.repositoryId) ||
          aliases.some((alias) => wildcardMatch(pattern, alias))
      );
    });
    const profile = profiles.length === 1 ? profiles[0] : undefined;
    const allowedIds = new Set(visibleRepositories.map((item) => item.id));
    const preferredRepositories = profile
      ? [
          project.repositoryId,
          ...profile.preferredSkillRepositories,
          ...profile.preferredKnowledgeRepositories
        ].filter((id, index, values) => allowedIds.has(id) && values.indexOf(id) === index)
      : [project.repositoryId];
    const query =
      input.task?.trim() ||
      [
        profile?.product,
        profile?.name,
        project.repositoryName,
        project.gitBranch,
        "project context"
      ].filter(Boolean).join(" ");
    const recommendations = this.discover(
      query,
      {
        topK: Math.max(1, Math.min(input.topK ?? 3, 5)),
        repositories: preferredRepositories,
        client: input.client
      },
      resolvedPrincipal
    );
    const projectTools = profile?.tools.length
      ? recommendations.tools.filter((item) =>
          profile.tools.some((name) => item.artifact.name === name || item.artifact.key === name)
        )
      : recommendations.tools;
    return {
      project,
      profile,
      query,
      reason: profile
        ? `recommendations use project profile ${profile.id} within caller-visible repositories`
        : `recommendations restricted to identified project repository ${project.repositoryId}`,
      recommendations: { ...recommendations, tools: projectTools }
    };
  }

  resolveAgent(
    query: string,
    limit = 3,
    client?: string,
    principal?: Principal
  ): ArtifactSearchResult<AgentArtifact>[] {
    const resolvedPrincipal = this.principal(principal);
    const results = searchArtifacts(query, this.listAgents(client, resolvedPrincipal), limit);
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "agent",
      action: "resolve",
      query,
      selected: results[0]?.artifact.key,
      matched: results.length > 0
    });
    this.metrics.increment("agent_resolve_total", { matched: String(results.length > 0) });
    return results;
  }

  getAgent(repositoryId: string, name: string, principal?: Principal): AgentArtifact {
    const resolvedPrincipal = this.principal(principal);
    const agent = this.agents.get(`${repositoryId}:${name}`);
    const repository = this.getRepository(repositoryId);
    if (!agent || !canReadArtifact(repository, agent.visibility, resolvedPrincipal.roles)) {
      throw new Error("Agent not found");
    }
    void this.analytics.record({
      ts: new Date().toISOString(),
      actorId: resolvedPrincipal.id,
      tenantId: resolvedPrincipal.tenantId,
      kind: "agent",
      action: "load",
      selected: agent.key,
      matched: true
    });
    this.metrics.increment("agent_load_total", { repository: repositoryId });
    return agent;
  }

  resolveAgentTools(
    repositoryId: string,
    name: string,
    options: { client?: string; environment?: string } = {},
    principal?: Principal
  ) {
    const resolvedPrincipal = this.principal(principal);
    const agent = this.getAgent(repositoryId, name, resolvedPrincipal);
    if (options.client && agent.compatibility[options.client] === false) {
      throw new Error(`Agent ${name} is not compatible with client ${options.client}`);
    }
    const bindings = resolveAgentToolBindings(
      agent,
      this.listTools(options.client, resolvedPrincipal),
      options.environment
    );
    return {
      agent: {
        key: agent.key,
        repositoryId: agent.repositoryId,
        name: agent.name,
        version: agent.version
      },
      client: options.client,
      environment: options.environment,
      ready: bindings.every((item) => item.status === "resolved"),
      bindings
    };
  }

  private evaluationRevisionPath(repositoryId: string, revision?: string): { revision: string; root: string } {
    const state = this.states.get(repositoryId);
    const resolvedRevision = revision ?? state?.revision;
    if (!resolvedRevision) throw new Error("Repository has no active revision");
    const root = path.resolve(this.revisionRoot(repositoryId));
    const target = path.resolve(root, resolvedRevision);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid revision");
    return { revision: resolvedRevision, root: target };
  }

  async listEvaluationSuites(
    repositoryId: string,
    revision?: string,
    principal?: Principal
  ): Promise<EvaluationSuite[]> {
    const allowed = this.allowedRepositories(principal).some((repo) => repo.id === repositoryId);
    if (!allowed) throw new Error("Repository not found");
    const resolved = this.evaluationRevisionPath(repositoryId, revision);
    await stat(resolved.root);
    return await scanEvaluationSuites(resolved.root, repositoryId);
  }

  async runEvaluation(
    repositoryId: string,
    suiteId: string,
    revision?: string,
    baselineRevision?: string,
    principal?: Principal
  ): Promise<EvaluationRunResult> {
    const allowed = this.allowedRepositories(principal).some((repo) => repo.id === repositoryId);
    if (!allowed) throw new Error("Repository not found");
    const candidateRef = this.evaluationRevisionPath(repositoryId, revision);
    const candidate = await loadEvaluationSnapshot(
      candidateRef.root,
      repositoryId,
      candidateRef.revision
    );
    const suite = candidate.suites.find((item) => item.id === suiteId);
    if (!suite) throw new Error(`Evaluation suite not found: ${suiteId}`);

    let baseline: EvaluationRunResult | undefined;
    if (baselineRevision) {
      const baselineRef = this.evaluationRevisionPath(repositoryId, baselineRevision);
      const baselineSnapshot = await loadEvaluationSnapshot(
        baselineRef.root,
        repositoryId,
        baselineRef.revision
      );
      const baselineSuite = baselineSnapshot.suites.find((item) => item.id === suiteId);
      if (baselineSuite) baseline = runEvaluationSuite(baselineSnapshot, baselineSuite);
    }
    const result = runEvaluationSuite(candidate, suite, baseline);
    await this.evaluations.append(result);
    this.metrics.increment("evaluation_run_total", {
      repository: repositoryId,
      result: result.failed === 0 && !result.regression ? "pass" : "fail"
    });
    return result;
  }

  async listEvaluationRuns(
    limit = 100,
    repositoryId?: string,
    suiteId?: string,
    principal?: Principal
  ): Promise<EvaluationRunResult[]> {
    const allowed = new Set(this.allowedRepositories(principal).map((repo) => repo.id));
    const runs = await this.evaluations.list(limit, repositoryId, suiteId);
    return runs.filter((run) => allowed.has(run.repositoryId));
  }

  async getEvaluationRun(runId: string, principal?: Principal): Promise<EvaluationRunResult> {
    const run = await this.evaluations.get(runId);
    if (!run) throw new Error("Evaluation run not found");
    const allowed = this.allowedRepositories(principal).some((repo) => repo.id === run.repositoryId);
    if (!allowed) throw new Error("Evaluation run not found");
    return run;
  }

  async listUsageAnalytics(limit = 200, unmatchedOnly = false) {
    return await this.analytics.list(limit, unmatchedOnly);
  }

  async getUsageSummary(limit = 10) {
    return await this.analytics.summary(limit);
  }

  newMcpTraceId(): string {
    return this.observability.newTraceId();
  }

  async recordMcpCall(input: {
    traceId: string;
    traceExplicit?: boolean;
    sessionId?: string;
    transportSessionId?: string;
    client?: string;
    tool: string;
    args?: unknown;
    latencyMs: number;
    success: boolean;
    error?: string;
    principal: Principal;
  }) {
    const resolvedSessionId =
      input.sessionId ??
      (await this.observability.resolveUniqueActiveClientSession(input.principal));
    const resolvedTraceId =
      !input.traceExplicit && resolvedSessionId
        ? this.observability.traceIdForSession(input.principal, resolvedSessionId)
        : input.traceId;
    return await this.observability.recordCall({
      traceId: resolvedTraceId,
      sessionId: resolvedSessionId,
      transportSessionId: input.transportSessionId,
      client: input.client,
      tool: input.tool,
      args: input.args,
      latencyMs: input.latencyMs,
      success: input.success,
      error: input.error,
      actorId: input.principal.id,
      tenantId: input.principal.tenantId
    });
  }

  async getMcpObservabilitySummary() {
    return await this.observability.summary();
  }

  async listMcpCalls(limit = 200) {
    return await this.observability.listCalls(limit);
  }

  async listMcpTraces(limit = 100) {
    return await this.observability.listTraces(limit);
  }

  async getMcpTrace(traceId: string) {
    return await this.observability.getTrace(traceId);
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
  ) {
    const metadata = { ...(input.metadata ?? {}) };
    const schema = resolveClientEventSchemaVersion(input.schemaVersion);
    metadata.client_event_schema_compatibility = schema.compatibility;
    if (input.event === "SessionStart") {
      const projectContext = resolveProjectContext(input.cwd, this.config.repositories, {
        remote: typeof metadata.git_remote === "string" ? metadata.git_remote : undefined,
        root: typeof metadata.git_root === "string" ? metadata.git_root : undefined,
        branch: typeof metadata.git_branch === "string" ? metadata.git_branch : undefined
      });
      if (projectContext) metadata.project_context = projectContext;
    }
    if (input.event === "PostToolUse") {
      const toolName = typeof metadata.tool_name === "string" ? metadata.tool_name : "";
      const normalized = normalizeEngineeringEvidence(toolName, metadata.evidence);
      if (normalized) metadata.engineering_evidence = normalized;
    }
    const duplicate = await this.observability.findDuplicateClientEvent(principal, {
      event: input.event,
      sessionId: input.sessionId,
      turnId: input.turnId,
      metadata
    });
    if (duplicate) return duplicate;

    const event = await this.observability.recordClientEvent(principal, {
      ...input,
      schemaVersion: schema.version,
      metadata
    });
    await this.clientEventPipeline.process(event);
    return event;
  }

  listClientEventActions() {
    return this.clientEventPipeline.listActions();
  }

  async listClientEvents(limit = 500) {
    return await this.observability.listClientEvents(limit);
  }

  async listCandidateDetections(limit = 500) {
    return await this.observability.listCandidateDetections(limit);
  }

  async getDashboardTrends(days = 14) {
    const windowDays = Math.max(7, Math.min(Math.floor(days) || 14, 90));
    const [calls, usage, candidates] = await Promise.all([
      this.observability.listCalls(5000),
      this.analytics.list(5000, false),
      this.observability.listCandidates(5000)
    ]);
    const today = new Date();
    const dates = Array.from({ length: windowDays }, (_, index) => {
      const date = new Date(Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() - (windowDays - 1 - index)
      ));
      return date.toISOString().slice(0, 10);
    });
    const rows = dates.map((date) => {
      const dailyCalls = calls.filter((item) => item.ts.slice(0, 10) === date);
      const dailyUsage = usage.filter((item) => item.ts.slice(0, 10) === date);
      const dailyCandidates = candidates.filter((item) => item.ts.slice(0, 10) === date);
      const approvalChanges = candidates.filter(
        (item) =>
          item.updatedAt.slice(0, 10) === date &&
          (item.status === "approved" || item.status === "publishing" || item.status === "published")
      );
      const unmatched = dailyUsage.filter((item) => item.action === "search" && !item.matched);
      const activeUsers = new Set([
        ...dailyCalls.map((item) => item.actorId),
        ...dailyUsage.map((item) => item.actorId)
      ]).size;
      const latencyMs = dailyCalls.length
        ? dailyCalls.reduce((sum, item) => sum + item.latencyMs, 0) / dailyCalls.length
        : 0;
      return {
        date,
        calls: dailyCalls.length,
        errors: dailyCalls.filter((item) => !item.success).length,
        noHits: unmatched.length,
        candidates: dailyCandidates.length,
        approvals: approvalChanges.length,
        gapSignals: new Set(unmatched.map((item) => item.query).filter(Boolean)).size,
        activeUsers,
        avgLatencyMs: Math.round(latencyMs)
      };
    });
    return {
      days: windowDays,
      rows,
      semantics: {
        noHits: "unmatched search usage events",
        gapSignals: "distinct unmatched search queries per day",
        approvals: "approved/publishing/published candidates grouped by latest updatedAt",
        latency: "average MCP call latency per day"
      }
    };
  }

  async getContentQualityMetrics(principal?: Principal) {
    const resolvedPrincipal = this.principal(principal);
    const [usage, feedback, candidates] = await Promise.all([
      this.analytics.list(5000, false),
      this.observability.listFeedback(5000),
      this.observability.listCandidates(5000)
    ]);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const ageDays = (value?: string) => {
      const parsed = value ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / dayMs)) : undefined;
    };
    const feedbackFor = (type: "skill" | "knowledge", matches: (target: string) => boolean) => {
      const rows = feedback.filter(
        (item) => item.targetType === type && typeof item.target === "string" && matches(item.target)
      );
      return {
        positive: rows.filter((item) => item.rating === "positive").length,
        negative: rows.filter((item) => item.rating === "negative").length
      };
    };
    const usageFor = (kind: "skill" | "knowledge", matches: (selected: string) => boolean) => {
      const rows = usage.filter(
        (item) => item.kind === kind && typeof item.selected === "string" && matches(item.selected)
      );
      const searchTop1 = rows.filter((item) => item.action === "search").length;
      const resolve = rows.filter((item) => item.action === "resolve").length;
      const load = rows.filter((item) => item.action === "load").length;
      const lastUsedAt = rows
        .map((item) => item.ts)
        .sort((a, b) => b.localeCompare(a))[0];
      return {
        total: rows.length,
        searchTop1,
        resolve,
        load,
        reuse: resolve + load,
        reuseRate: searchTop1 ? (resolve + load) / searchTop1 : resolve + load > 0 ? 1 : 0,
        lastUsedAt,
        daysSinceLastUse: ageDays(lastUsedAt)
      };
    };

    const skills = this.listSkills({}, resolvedPrincipal).map((skill) => {
      const activity = usageFor("skill", (selected) => selected === skill.key);
      return {
        kind: "skill" as const,
        key: skill.key,
        repositoryId: skill.repositoryId,
        name: skill.name,
        owner: skill.metadata.owner,
        status: skill.metadata.maturity,
        usage: activity,
        feedback: feedbackFor("skill", (target) => target === skill.key),
        staleByUsage: activity.daysSinceLastUse === undefined || activity.daysSinceLastUse > 90,
        reviewFreshness: undefined,
        candidateUpdateCount: candidates.filter(
          (item) =>
            item.suggestedType === "skill" &&
            item.repository === skill.repositoryId &&
            item.title.toLowerCase().includes(skill.name.toLowerCase())
        ).length
      };
    });
    const knowledge = this.listKnowledgeDocuments(resolvedPrincipal).map((document) => {
      const activity = usageFor(
        "knowledge",
        (selected) => selected === document.key || selected.startsWith(document.key + "#")
      );
      const reviewedAt = document.metadata?.updatedAt ?? document.metadata?.createdAt;
      const reviewAgeDays = ageDays(reviewedAt);
      const reviewCycleDays = document.metadata?.reviewCycleDays;
      return {
        kind: "knowledge" as const,
        key: document.key,
        repositoryId: document.repositoryId,
        path: document.relativePath,
        title: document.title,
        owner: document.metadata?.owner,
        status: document.metadata?.status ?? "active",
        usage: activity,
        feedback: feedbackFor(
          "knowledge",
          (target) => target === document.key || target.startsWith(document.key + "#")
        ),
        staleByUsage: activity.daysSinceLastUse === undefined || activity.daysSinceLastUse > 90,
        reviewFreshness: {
          reviewedAt,
          reviewAgeDays,
          reviewCycleDays,
          overdue:
            reviewAgeDays !== undefined &&
            reviewCycleDays !== undefined &&
            reviewAgeDays > reviewCycleDays
        },
        candidateUpdateCount: candidates.filter(
          (item) =>
            item.knowledgeRelation?.target?.key === document.key ||
            item.relationHint?.target.key === document.key
        ).length
      };
    });
    return {
      skills,
      knowledge,
      summary: {
        skills: skills.length,
        knowledge: knowledge.length,
        staleSkills: skills.filter((item) => item.staleByUsage).length,
        staleKnowledge: knowledge.filter((item) => item.staleByUsage).length,
        reviewOverdue: knowledge.filter((item) => item.reviewFreshness.overdue).length,
        positiveFeedback:
          skills.reduce((sum, item) => sum + item.feedback.positive, 0) +
          knowledge.reduce((sum, item) => sum + item.feedback.positive, 0),
        negativeFeedback:
          skills.reduce((sum, item) => sum + item.feedback.negative, 0) +
          knowledge.reduce((sum, item) => sum + item.feedback.negative, 0)
      },
      semantics: {
        searchRank: "searchTop1 counts selections recorded as the first search result",
        reuseRate: "(resolve + load) / searchTop1; capped only by observed event history, not a quality score",
        staleByUsage: "no recorded usage or more than 90 days since last recorded usage",
        automaticDeletion: false
      }
    };
  }

  async getArtifactGovernance(principal?: Principal) {
    const resolvedPrincipal = this.principal(principal);
    const [usage, feedback] = await Promise.all([
      this.analytics.list(5000, false),
      this.observability.listFeedback(5000)
    ]);
    const skills = this.listSkills({}, resolvedPrincipal);
    const prompts = this.listPrompts(undefined, resolvedPrincipal);
    const agents = this.listAgents(undefined, resolvedPrincipal);
    const evaluationCases: EvaluationSuite["cases"] = [];
    for (const repository of this.allowedRepositories(resolvedPrincipal)) {
      try {
        const suites = await this.listEvaluationSuites(repository.id, undefined, resolvedPrincipal);
        for (const suite of suites) evaluationCases.push(...suite.cases);
      } catch {
        // Governance is best-effort: repositories without an active revision/evaluation suite remain visible.
      }
    }

    const usageCount = (key: string) =>
      usage.filter((item) => item.selected === key).length;
    const feedbackCounts = (type: "skill" | "prompt" | "agent", key: string) => {
      const rows = feedback.filter((item) => item.targetType === type && item.target === key);
      return {
        positive: rows.filter((item) => item.rating === "positive").length,
        negative: rows.filter((item) => item.rating === "negative").length
      };
    };
    const evaluationCount = (
      target: "skill" | "prompt" | "agent",
      key: string,
      name: string
    ) =>
      evaluationCases.filter(
        (item) =>
          item.target === target &&
          (
            item.name === name ||
            item.expect.selected === key ||
            item.expect.selected === name ||
            item.expect.skills?.includes(name) ||
            item.expect.prompts?.includes(name)
          )
      ).length;
    const duplicateNames = <T extends { name: string }>(items: T[]) => {
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
      return counts;
    };
    const skillNames = duplicateNames(skills);
    const promptNames = duplicateNames(prompts);
    const agentNames = duplicateNames(agents);

    const skillRows = skills.map((skill) => {
      const issues: string[] = [];
      if (skill.metadata.maturity === "deprecated") issues.push("deprecated");
      if (!skill.version) issues.push("missing-version");
      if ((skillNames.get(skill.name) ?? 0) > 1) issues.push("duplicate-name");
      const uses = usageCount(skill.key);
      const reviews = feedbackCounts("skill", skill.key);
      const evaluations = evaluationCount("skill", skill.key, skill.name);
      return {
        kind: "skill" as const,
        key: skill.key,
        repositoryId: skill.repositoryId,
        name: skill.name,
        owner: skill.metadata.owner,
        version: skill.version,
        status: skill.metadata.maturity,
        compatibility: skill.metadata.compatibility,
        usage: uses,
        feedback: reviews,
        evaluationCases: evaluations,
        dependencies: skill.metadata.dependsOn,
        issues
      };
    });
    const promptRows = prompts.map((prompt) => {
      const issues: string[] = [];
      if (!prompt.version) issues.push("missing-version");
      if ((promptNames.get(prompt.name) ?? 0) > 1) issues.push("duplicate-name");
      const uses = usageCount(prompt.key);
      const reviews = feedbackCounts("prompt", prompt.key);
      const evaluations = evaluationCount("prompt", prompt.key, prompt.name);
      return {
        kind: "prompt" as const,
        key: prompt.key,
        repositoryId: prompt.repositoryId,
        name: prompt.name,
        owner: prompt.owner,
        version: prompt.version,
        status: "active",
        compatibility: prompt.compatibility,
        usage: uses,
        feedback: reviews,
        evaluationCases: evaluations,
        issues
      };
    });
    const visibleTools = this.listTools(undefined, resolvedPrincipal);
    const agentRows = agents.map((agent) => {
      const issues: string[] = [];
      if (!agent.version) issues.push("missing-version");
      if ((agentNames.get(agent.name) ?? 0) > 1) issues.push("duplicate-name");
      const bindings = resolveAgentToolBindings(agent, visibleTools);
      if (bindings.some((item) => item.status !== "resolved")) issues.push("unresolved-tool-binding");
      const uses = usageCount(agent.key);
      const reviews = feedbackCounts("agent", agent.key);
      const evaluations = evaluationCount("agent", agent.key, agent.name);
      return {
        kind: "agent" as const,
        key: agent.key,
        repositoryId: agent.repositoryId,
        name: agent.name,
        owner: agent.owner,
        version: agent.version,
        status: "active",
        compatibility: agent.compatibility,
        usage: uses,
        feedback: reviews,
        evaluationCases: evaluations,
        capabilities: {
          skills: agent.skills,
          prompts: agent.prompts,
          tools: agent.tools
        },
        toolBindingsReady: bindings.every((item) => item.status === "resolved"),
        issues
      };
    });
    const all = [...skillRows, ...promptRows, ...agentRows];
    return {
      skills: skillRows,
      prompts: promptRows,
      agents: agentRows,
      summary: {
        skills: skillRows.length,
        prompts: promptRows.length,
        agents: agentRows.length,
        issues: all.reduce((sum, item) => sum + item.issues.length, 0),
        deprecatedSkills: skillRows.filter((item) => item.status === "deprecated").length,
        missingVersion: all.filter((item) => item.issues.includes("missing-version")).length,
        duplicateNames: all.filter((item) => item.issues.includes("duplicate-name")).length,
        unresolvedAgentTools: agentRows.filter((item) => !item.toolBindingsReady).length
      }
    };
  }

  async getRepositoryGovernance(principal?: Principal) {
    const resolvedPrincipal = this.principal(principal);
    const repositories = resolvedPrincipal.roles.includes("admin")
      ? this.config.repositories
      : this.allowedRepositories(resolvedPrincipal);
    const audits = await this.listAuditEvents(1000, undefined, resolvedPrincipal);
    const now = Date.now();
    const webhookSecretConfigured = Boolean(
      process.env.GITLAB_WEBHOOK_TOKEN ?? process.env.WEBHOOK_SECRET
    );
    const rows = repositories.map((repository) => {
      const state = this.states.get(repository.id);
      const lastSuccessMs = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : NaN;
      const syncLagSeconds = Number.isFinite(lastSuccessMs)
        ? Math.max(0, Math.floor((now - lastSuccessMs) / 1000))
        : undefined;
      const expectedMaxLagSeconds =
        repository.pollingIntervalSeconds > 0
          ? Math.max(15 * 60, repository.pollingIntervalSeconds * 3)
          : undefined;
      const stale =
        Boolean(repository.enabled) &&
        expectedMaxLagSeconds !== undefined &&
        (syncLagSeconds === undefined || syncLagSeconds > expectedMaxLagSeconds);
      const webhookEvents = audits.filter(
        (event) =>
          event.repositoryId === repository.id &&
          event.trigger === "webhook" &&
          (event.action === "repository.sync.completed" || event.action === "repository.sync.failed")
      );
      const lastWebhook = webhookEvents[0];
      const webhookStatus:
        | "not-applicable"
        | "not-configured"
        | "misconfigured"
        | "configured-no-events"
        | "healthy"
        | "error" =
        repository.provider !== "git"
          ? "not-applicable"
          : repository.webhookAliases.length === 0
            ? "not-configured"
            : !webhookSecretConfigured
              ? "misconfigured"
              : !lastWebhook
                ? "configured-no-events"
                : lastWebhook.action === "repository.sync.failed"
                  ? "error"
                  : "healthy";
      const owners = repository.owners ?? [];
      const issues: string[] = [];
      if (!owners.length) issues.push("missing-owner");
      if (stale) issues.push("sync-lag");
      if (webhookStatus === "misconfigured" || webhookStatus === "error") {
        issues.push("webhook-" + webhookStatus);
      }
      return {
        id: repository.id,
        name: repository.name,
        provider: repository.provider,
        owners,
        enabled: repository.enabled,
        status: state?.status ?? "disabled",
        revision: state?.revision,
        lastGoodRevision: state?.lastGoodRevision,
        lastSyncAt: state?.lastSyncAt,
        lastSuccessAt: state?.lastSuccessAt,
        syncLagSeconds,
        expectedMaxLagSeconds,
        stale,
        failureCount: state?.failureCount ?? 0,
        webhook: {
          aliases: [...repository.webhookAliases],
          secretConfigured: webhookSecretConfigured,
          status: webhookStatus,
          lastEventAt: lastWebhook?.ts,
          lastResult:
            lastWebhook?.action === "repository.sync.failed"
              ? "failed"
              : lastWebhook?.action === "repository.sync.completed"
                ? "success"
                : undefined
        },
        issues
      };
    });
    return {
      repositories: rows,
      summary: {
        total: rows.length,
        missingOwner: rows.filter((item) => item.issues.includes("missing-owner")).length,
        stale: rows.filter((item) => item.stale).length,
        webhookErrors: rows.filter(
          (item) => item.webhook.status === "misconfigured" || item.webhook.status === "error"
        ).length
      }
    };
  }

  async getOperationalHealth(principal?: Principal) {
    const states = this.listRepositoryStates();
    const now = Date.now();
    const staleRepositories = states.filter((state) => {
      const repository = this.config.repositories.find((item) => item.id === state.id);
      const pollingSeconds = repository?.pollingIntervalSeconds ?? 0;
      if (pollingSeconds <= 0 || !state.lastSuccessAt) return false;
      const lastSuccess = Date.parse(state.lastSuccessAt);
      if (!Number.isFinite(lastSuccess)) return true;
      const thresholdMs = Math.max(15 * 60 * 1000, pollingSeconds * 3 * 1000);
      return now - lastSuccess > thresholdMs;
    });
    const candidates = await this.observability.listCandidates(5000);
    const lifecycle = this.getKnowledgeLifecycleAudit(principal);
    let disk:
      | { totalBytes: number; freeBytes: number; usedBytes: number; usedRatio: number }
      | undefined;
    try {
      await mkdir(this.config.dataDir, { recursive: true });
      const fs = await statfs(this.config.dataDir);
      const totalBytes = Number(fs.blocks) * Number(fs.bsize);
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      disk = {
        totalBytes,
        freeBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes),
        usedRatio: totalBytes > 0 ? Math.max(0, Math.min(1, (totalBytes - freeBytes) / totalBytes)) : 0
      };
    } catch {
      disk = undefined;
    }
    return {
      ready: this.isReady(),
      repositories: {
        total: states.length,
        healthy: states.filter((state) => state.status === "healthy").length,
        error: states.filter((state) => state.status === "error").length,
        syncing: states.filter((state) => state.status === "syncing").length,
        stale: staleRepositories.map((state) => ({
          id: state.id,
          lastSuccessAt: state.lastSuccessAt,
          failureCount: state.failureCount
        })),
        repeatedFailures: states
          .filter((state) => state.failureCount >= 3)
          .map((state) => ({ id: state.id, failureCount: state.failureCount, error: state.error }))
      },
      candidates: {
        pending: candidates.filter((item) => item.status === "pending").length,
        approved: candidates.filter((item) => item.status === "approved").length,
        publishFailed: candidates.filter((item) => item.status === "publish_failed").length,
        publishing: candidates.filter((item) => item.status === "publishing").length
      },
      knowledge: {
        documents: lifecycle.documents,
        lifecycleIssues: lifecycle.issues.length,
        reviewOverdue: lifecycle.byKind["review-overdue"] ?? 0,
        expired: lifecycle.byKind.expired ?? 0,
        missingOwner: lifecycle.byKind["missing-owner"] ?? 0
      },
      storage: disk
    };
  }

  async getSessionAnalytics(limit = 500) {
    const [sessions, calls, candidates] = await Promise.all([
      this.observability.listClientSessions(Math.max(1, Math.min(limit, 1000))),
      this.observability.listCalls(5000),
      this.observability.listCandidates(5000)
    ]);
    const searchTools = new Set([
      "discover",
      "search_skills",
      "search_knowledge",
      "search_prompts",
      "search_agents",
      "search_tools"
    ]);
    const knowledgeTools = new Set(["search_knowledge", "get_knowledge"]);
    const searchKey = (call: { tool: string; args?: Record<string, unknown> }) => {
      const args = call.args ?? {};
      const query =
        typeof args.query === "string" ? args.query :
        typeof args.task === "string" ? args.task :
        typeof args.name === "string" ? args.name :
        typeof args.path === "string" ? args.path :
        "";
      return call.tool + "\0" + query.trim().toLowerCase();
    };
    const rows = sessions.map((session) => {
      const sessionCalls = calls.filter(
        (call) =>
          call.sessionId === session.sessionId &&
          call.actorId === session.actorId &&
          call.tenantId === session.tenantId
      );
      const seenSearches = new Set<string>();
      let repeatedSearches = 0;
      for (const call of sessionCalls) {
        if (!searchTools.has(call.tool)) continue;
        const key = searchKey(call);
        if (seenSearches.has(key)) repeatedSearches += 1;
        else seenSearches.add(key);
      }
      const durationMs = Math.max(
        0,
        Date.parse(session.endedAt) - Date.parse(session.startedAt)
      );
      const candidateCount = candidates.filter(
        (candidate) =>
          candidate.sourceSessionId === session.sessionId &&
          candidate.actorId === session.actorId &&
          candidate.tenantId === session.tenantId
      ).length;
      const knowledgeCalls = sessionCalls.filter((call) => knowledgeTools.has(call.tool)).length;
      const successfulKnowledgeReuse = sessionCalls.filter(
        (call) => call.tool === "get_knowledge" && call.success
      ).length;
      const failedCalls = sessionCalls.filter((call) => !call.success).length;
      return {
        sessionId: session.sessionId,
        actorId: session.actorId,
        tenantId: session.tenantId,
        repositoryId: session.repositoryId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        ended: session.ended,
        durationMs,
        toolsUsed: session.tools.length,
        toolNames: session.tools,
        knowledgeCalls,
        repeatedSearches,
        successfulKnowledgeReuse,
        candidateCount,
        failedCalls,
        evidenceCount: session.evidenceCount,
        callCount: session.callCount
      };
    });
    const average = (select: (row: typeof rows[number]) => number) =>
      rows.length ? rows.reduce((sum, row) => sum + select(row), 0) / rows.length : 0;
    return {
      sessions: rows,
      summary: {
        sessionCount: rows.length,
        averageDurationMs: Math.round(average((row) => row.durationMs)),
        averageToolsUsedPerSession: average((row) => row.toolsUsed),
        averageKnowledgeCallsPerSession: average((row) => row.knowledgeCalls),
        repeatedSearches: rows.reduce((sum, row) => sum + row.repeatedSearches, 0),
        successfulKnowledgeReuse: rows.reduce((sum, row) => sum + row.successfulKnowledgeReuse, 0),
        averageCandidatesPerSession: average((row) => row.candidateCount),
        averageFailedCallsPerSession: average((row) => row.failedCalls),
        averageEvidencePerSession: average((row) => row.evidenceCount),
        sessionsWithFailures: rows.filter((row) => row.failedCalls > 0).length,
        sessionsWithKnowledgeReuse: rows.filter((row) => row.successfulKnowledgeReuse > 0).length
      },
      semantics: {
        duration: "first-to-last observed Session event/MCP call timestamp; active sessions are not wall-clock task completion",
        repeatedSearches: "repeated identical search tool + observable query within one session",
        successfulKnowledgeReuse: "successful get_knowledge MCP calls",
        failedTasks: "failed MCP calls are used as the observable failure proxy"
      }
    };
  }

  async getPlatformKpis(principal?: Principal) {
    const [sessions, candidates, detections, usage, feedback, callSummary] = await Promise.all([
      this.observability.listClientSessions(1000),
      this.observability.listCandidates(5000),
      this.observability.listCandidateDetections(5000),
      this.analytics.summary(20),
      this.observability.listFeedback(5000),
      this.observability.summary()
    ]);
    const reviewed = candidates.filter((item) =>
      ["approved", "rejected", "publishing", "published", "publish_failed"].includes(item.status)
    );
    const approved = reviewed.filter((item) =>
      ["approved", "publishing", "published", "publish_failed"].includes(item.status)
    ).length;
    const autoReviewed = reviewed.filter((item) => Boolean(item.automation));
    const autoAccepted = autoReviewed.filter((item) =>
      ["approved", "publishing", "published", "publish_failed"].includes(item.status)
    ).length;
    const autoRejected = autoReviewed.filter((item) => item.status === "rejected").length;
    const labeledAutoReviewed = autoReviewed.filter((item) => Boolean(item.reviewReason));
    const usefulAutoReviewed = labeledAutoReviewed.filter((item) => item.reviewReason === "useful").length;
    const falsePositiveAutoReviewed = labeledAutoReviewed.filter((item) => item.reviewReason === "false_positive").length;
    const duplicateFiltered = detections.filter(
      (item) =>
        item.outcome === "skipped" &&
        (
          item.reason === "exact-candidate-duplicate" ||
          item.reason.startsWith("near-candidate-duplicate:") ||
          item.reason === "template-summary-duplicate" ||
          item.reason === "candidate-already-generated"
        )
    ).length;
    const lowValueFiltered = detections.filter(
      (item) =>
        item.outcome === "skipped" &&
        (
          item.reason === "low-reuse-value-summary" ||
          item.reason === "assistant-summary-too-short" ||
          item.reason === "no-engineering-action" ||
          item.reason === "no-strong-test-evidence"
        )
    ).length;
    const publishedWithMr = candidates.filter((item) => Boolean(item.publication));
    const mergedMrs = publishedWithMr.filter((item) => item.publication?.mergeRequestState === "merged").length;
    const negativeFeedback = feedback.filter((item) => item.rating === "negative").length;
    const lifecycle = this.getKnowledgeLifecycleAudit(principal);
    const sessionCallCount = sessions.reduce((sum, item) => sum + item.callCount, 0);
    const sessionEvidenceCount = sessions.reduce((sum, item) => sum + item.evidenceCount, 0);
    const autoCandidateCount = candidates.filter((item) => Boolean(item.automation)).length;
    return {
      activeUsers: new Set(sessions.map((item) => item.actorId)).size,
      sessions: sessions.length,
      avgCallsPerSession: sessions.length ? sessionCallCount / sessions.length : 0,
      avgEvidencePerSession: sessions.length ? sessionEvidenceCount / sessions.length : 0,
      autoCandidatesPerSession: sessions.length ? autoCandidateCount / sessions.length : 0,
      mcpErrorRate: callSummary.errorRate,
      p95LatencyMs: callSummary.p95LatencyMs,
      negativeFeedbackRate: feedback.length ? negativeFeedback / feedback.length : 0,
      noHitRate: usage.total ? usage.unmatched / usage.total : 0,
      autoCandidates: candidates.filter((item) => Boolean(item.automation)).length,
      pendingCandidates: candidates.filter((item) => item.status === "pending").length,
      approvalRate: reviewed.length ? approved / reviewed.length : 0,
      publishedCandidates: candidates.filter((item) => item.status === "published").length,
      mergeRequestCount: publishedWithMr.length,
      mergeRequestMergeRate: publishedWithMr.length ? mergedMrs / publishedWithMr.length : 0,
      staleKnowledgeCount:
        (lifecycle.byKind["review-overdue"] ?? 0) +
        (lifecycle.byKind.expired ?? 0) +
        (lifecycle.byKind.deprecated ?? 0) +
        (lifecycle.byKind.superseded ?? 0),
      detectorCreated: detections.filter((item) => item.outcome === "created").length,
      detectorSkipped: detections.filter((item) => item.outcome === "skipped").length,
      autoReviewed: autoReviewed.length,
      autoAcceptanceRate: autoReviewed.length ? autoAccepted / autoReviewed.length : 0,
      autoRejectionRate: autoReviewed.length ? autoRejected / autoReviewed.length : 0,
      autoQualityLabelCoverage: autoReviewed.length ? labeledAutoReviewed.length / autoReviewed.length : 0,
      autoUsefulRate: labeledAutoReviewed.length ? usefulAutoReviewed / labeledAutoReviewed.length : 0,
      autoFalsePositiveRate: labeledAutoReviewed.length ? falsePositiveAutoReviewed / labeledAutoReviewed.length : 0,
      duplicateFiltered,
      lowValueFiltered
    };
  }

  getDataGovernancePolicy() {
    return {
      version: 1,
      rules: listDataGovernanceRules(),
      invariants: [
        "raw sensitive payload classes are not persisted by default",
        "observability files use classification-specific retention when no explicit test override is supplied",
        "policy changes must not expand local collection ceilings"
      ]
    };
  }

  async getActiveAlerts(principal?: Principal) {
    const [health, kpis, evaluationRuns] = await Promise.all([
      this.getOperationalHealth(principal),
      this.getPlatformKpis(principal),
      this.listEvaluationRuns(20, undefined, undefined, principal)
    ]);
    type AlertSeverity = "warning" | "critical";
    const alerts: Array<{
      id: string;
      severity: AlertSeverity;
      category: string;
      title: string;
      detail: string;
    }> = [];
    const add = (
      id: string,
      severity: AlertSeverity,
      category: string,
      title: string,
      detail: string
    ) => alerts.push({ id, severity, category, title, detail });

    for (const repository of health.repositories.repeatedFailures) {
      add(
        "repo-failures:" + repository.id,
        repository.failureCount >= 5 ? "critical" : "warning",
        "repository",
        "Repository sync repeatedly failing: " + repository.id,
        repository.failureCount + " consecutive failures" + (repository.error ? " · " + repository.error : "")
      );
    }
    for (const repository of health.repositories.stale) {
      add(
        "repo-stale:" + repository.id,
        "warning",
        "repository",
        "Repository is stale: " + repository.id,
        "Last successful sync: " + (repository.lastSuccessAt ?? "unknown")
      );
    }
    if (health.candidates.publishFailed >= 3) {
      add(
        "publish-failures",
        health.candidates.publishFailed >= 10 ? "critical" : "warning",
        "publishing",
        "Knowledge publishing failures are accumulating",
        health.candidates.publishFailed + " candidates are in publish_failed"
      );
    }
    if (health.candidates.pending >= 50) {
      add(
        "candidate-backlog",
        health.candidates.pending >= 150 ? "critical" : "warning",
        "review",
        "Review Inbox backlog is high",
        health.candidates.pending + " pending candidates"
      );
    }
    if (kpis.mcpErrorRate >= 0.05) {
      add(
        "mcp-error-rate",
        kpis.mcpErrorRate >= 0.1 ? "critical" : "warning",
        "mcp",
        "MCP error rate is elevated",
        (kpis.mcpErrorRate * 100).toFixed(1) + "% error rate"
      );
    }
    if (kpis.noHitRate >= 0.3) {
      add(
        "no-hit-rate",
        kpis.noHitRate >= 0.5 ? "critical" : "warning",
        "retrieval",
        "Knowledge retrieval no-hit rate is high",
        (kpis.noHitRate * 100).toFixed(1) + "% no-hit rate"
      );
    }
    if (kpis.negativeFeedbackRate >= 0.25) {
      add(
        "negative-feedback",
        kpis.negativeFeedbackRate >= 0.5 ? "critical" : "warning",
        "quality",
        "Negative feedback rate is high",
        (kpis.negativeFeedbackRate * 100).toFixed(1) + "% negative feedback"
      );
    }
    if (health.storage && health.storage.usedRatio >= 0.85) {
      add(
        "disk-usage",
        health.storage.usedRatio >= 0.95 ? "critical" : "warning",
        "storage",
        "DATA_DIR disk usage is high",
        (health.storage.usedRatio * 100).toFixed(1) + "% used"
      );
    }
    const latestRunBySuite = new Map<string, EvaluationRunResult>();
    for (const run of evaluationRuns) {
      const key = run.repositoryId + "\0" + run.suiteId;
      if (!latestRunBySuite.has(key)) latestRunBySuite.set(key, run);
    }
    for (const run of latestRunBySuite.values()) {
      if (!run.regression && run.failed === 0) continue;
      add(
        "evaluation:" + run.repositoryId + ":" + run.suiteId,
        "critical",
        "evaluation",
        "Evaluation regression: " + run.repositoryId + " / " + run.suiteId,
        run.failed + "/" + run.total + " cases failed" + (run.regression ? " · baseline regression detected" : "")
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      counts: {
        critical: alerts.filter((item) => item.severity === "critical").length,
        warning: alerts.filter((item) => item.severity === "warning").length
      },
      alerts
    };
  }

  async getAutoCandidateQualityReport(windowDays = 7) {
    const days = Math.max(1, Math.min(Math.floor(windowDays) || 7, 90));
    const [candidates, detections] = await Promise.all([
      this.observability.listCandidates(10000),
      this.observability.listCandidateDetections(10000)
    ]);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const currentStart = now - days * dayMs;
    const baselineStart = currentStart - days * dayMs;
    const automatic = candidates.filter((item) => Boolean(item.automation));
    const timestamp = (value: string | undefined) => {
      const parsed = value ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const duplicateReason = (reason: string) =>
      reason === "exact-candidate-duplicate" ||
      reason.startsWith("near-candidate-duplicate:") ||
      reason === "template-summary-duplicate" ||
      reason === "candidate-already-generated";
    const lowValueReason = (reason: string) =>
      reason === "low-reuse-value-summary" ||
      reason === "assistant-summary-too-short" ||
      reason === "no-engineering-action" ||
      reason === "no-strong-test-evidence";
    const summarize = (from: number, to: number, detector?: string) => {
      const scopedCandidates = automatic.filter((item) => {
        const ts = timestamp(item.updatedAt || item.ts);
        return ts >= from && ts < to && (!detector || item.automation?.detector === detector);
      });
      const scopedDetections = detections.filter((item) => {
        const ts = timestamp(item.ts);
        const itemDetector = item.detector ?? "legacy";
        return ts >= from && ts < to && (!detector || itemDetector === detector);
      });
      const reviewed = scopedCandidates.filter((item) =>
        ["approved", "rejected", "publishing", "published", "publish_failed"].includes(item.status)
      );
      const labeled = reviewed.filter((item) => Boolean(item.reviewReason));
      const useful = labeled.filter((item) => item.reviewReason === "useful").length;
      const falsePositive = labeled.filter((item) => item.reviewReason === "false_positive").length;
      return {
        candidates: scopedCandidates.length,
        created: scopedDetections.filter((item) => item.outcome === "created").length,
        skipped: scopedDetections.filter((item) => item.outcome === "skipped").length,
        reviewed: reviewed.length,
        labeled: labeled.length,
        labelCoverage: reviewed.length ? labeled.length / reviewed.length : 0,
        usefulRate: labeled.length ? useful / labeled.length : 0,
        falsePositiveRate: labeled.length ? falsePositive / labeled.length : 0,
        duplicateFiltered: scopedDetections.filter(
          (item) => item.outcome === "skipped" && duplicateReason(item.reason)
        ).length,
        lowValueFiltered: scopedDetections.filter(
          (item) => item.outcome === "skipped" && lowValueReason(item.reason)
        ).length
      };
    };
    const current = summarize(currentStart, now);
    const baseline = summarize(baselineStart, currentStart);
    const detectors = new Set<string>([
      ...automatic.map((item) => item.automation?.detector).filter((value): value is string => Boolean(value)),
      ...detections.map((item) => item.detector ?? "legacy")
    ]);
    const byDetector = [...detectors].sort().map((detectorName) => ({
      detector: detectorName,
      current: summarize(currentStart, now, detectorName),
      baseline: summarize(baselineStart, currentStart, detectorName)
    }));
    const timeSeries = Array.from({ length: days * 2 }, (_, index) => {
      const from = baselineStart + index * dayMs;
      const to = from + dayMs;
      return {
        date: new Date(from).toISOString().slice(0, 10),
        ...summarize(from, to)
      };
    });
    return {
      windowDays: days,
      current,
      baseline,
      delta: {
        usefulRate: current.usefulRate - baseline.usefulRate,
        falsePositiveRate: current.falsePositiveRate - baseline.falsePositiveRate,
        labelCoverage: current.labelCoverage - baseline.labelCoverage,
        created: current.created - baseline.created,
        skipped: current.skipped - baseline.skipped
      },
      byDetector,
      timeSeries
    };
  }

  async listClientSessions(
    limit = 100,
    filters?: {
      actorId?: string;
      repositoryId?: string;
      event?: string;
      runtimeStatus?: "current" | "outdated" | "unknown";
      from?: string;
      to?: string;
    }
  ) {
    const sessions = await this.observability.listClientSessions(1000);
    return sessions
      .map((session) => ({
        ...session,
        runtimeStatus:
          !session.runtimeVersion || !session.hookSchemaVersion
            ? ("unknown" as const)
            : session.runtimeVersion === CURRENT_HOOK_RUNTIME_VERSION &&
                session.hookSchemaVersion === CURRENT_HOOK_SCHEMA_VERSION
              ? ("current" as const)
              : ("outdated" as const),
        expectedRuntimeVersion: CURRENT_HOOK_RUNTIME_VERSION,
        expectedHookSchemaVersion: CURRENT_HOOK_SCHEMA_VERSION
      }))
      .filter((session) => !filters?.actorId || session.actorId === filters.actorId)
      .filter(
        (session) =>
          !filters?.repositoryId || session.repositoryId === filters.repositoryId
      )
      .filter((session) => !filters?.event || session.events.includes(filters.event))
      .filter(
        (session) =>
          !filters?.runtimeStatus || session.runtimeStatus === filters.runtimeStatus
      )
      .filter((session) => !filters?.from || session.endedAt >= filters.from)
      .filter((session) => !filters?.to || session.startedAt <= filters.to)
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  getClientRuntimeInfo() {
    return {
      runtimeVersion: CURRENT_HOOK_RUNTIME_VERSION,
      hookSchemaVersion: CURRENT_HOOK_SCHEMA_VERSION
    };
  }

  async getClientSessionTimeline(actorId: string, tenantId: string, sessionId: string) {
    return await this.observability.getClientSessionTimeline(actorId, tenantId, sessionId);
  }

  async getClientSessionDetail(actorId: string, tenantId: string, sessionId: string) {
    const [timeline, candidates, detections] = await Promise.all([
      this.observability.getClientSessionTimeline(actorId, tenantId, sessionId),
      this.observability.listCandidates(1000),
      this.observability.listCandidateDetections(5000)
    ]);
    const evidence = timeline
      .filter((item): item is Extract<typeof timeline[number], { kind: "event" }> => item.kind === "event")
      .map((item) => ({
        ts: item.ts,
        event: item.event.event,
        tool:
          typeof item.event.metadata.tool_name === "string"
            ? item.event.metadata.tool_name
            : undefined,
        evidence: item.event.metadata.engineering_evidence
      }))
      .filter((item) => item.evidence && typeof item.evidence === "object");
    const calls = timeline.filter(
      (item): item is Extract<typeof timeline[number], { kind: "mcp-call" }> => item.kind === "mcp-call"
    );
    const assetTools = new Set([
      "discover",
      "search_skills",
      "resolve_skill",
      "get_skill",
      "search_knowledge",
      "get_knowledge",
      "search_prompts",
      "get_prompt",
      "search_agents",
      "resolve_agent",
      "get_agent",
      "search_tools",
      "get_tool"
    ]);
    const assetUsage = calls
      .filter((item) => assetTools.has(item.call.tool))
      .map((item) => ({
        ts: item.ts,
        tool: item.call.tool,
        success: item.call.success,
        args: item.call.args
      }));
    return {
      sessionId,
      actorId,
      tenantId,
      timeline,
      evidence,
      assetUsage,
      candidates: candidates.filter(
        (item) =>
          item.actorId === actorId &&
          item.tenantId === tenantId &&
          item.sourceSessionId === sessionId
      ),
      detections: detections.filter(
        (item) =>
          item.actorId === actorId &&
          item.tenantId === tenantId &&
          item.sessionId === sessionId
      )
    };
  }

  async submitFeedback(
    principal: Principal,
    input: Omit<FeedbackRecord, "id" | "ts" | "actorId" | "tenantId">
  ) {
    return await this.observability.submitFeedback(principal, input);
  }

  async listFeedback(limit = 200) {
    return await this.observability.listFeedback(limit);
  }

  async submitKnowledgeCandidate(
    principal: Principal,
    input: Pick<
      KnowledgeCandidate,
      "title" | "content" | "sourceType" | "suggestedType" | "repository" | "suggestedPath" | "traceId"
    >
  ) {
    if (input.repository) {
      const allowed = this.allowedRepositories(principal).some((repo) => repo.id === input.repository);
      if (!allowed) throw new Error("Repository not found");
    }
    return await this.observability.createCandidate(principal, input);
  }

  async listKnowledgeCandidates(
    limit = 500,
    filters?: {
      id?: string;
      status?: string;
      repository?: string;
      sourceType?: string;
      reviewer?: string;
      automatic?: boolean;
    }
  ) {
    const candidates = await this.observability.listCandidates(Math.max(limit * 4, limit));
    return candidates
      .filter((item) => !filters?.id || item.id === filters.id)
      .filter((item) => !filters?.status || item.status === filters.status)
      .filter((item) => !filters?.repository || item.repository === filters.repository)
      .filter((item) => !filters?.sourceType || item.sourceType === filters.sourceType)
      .filter((item) => !filters?.reviewer || item.reviewer === filters.reviewer)
      .filter((item) =>
        filters?.automatic === undefined ? true : filters.automatic ? Boolean(item.automation) : !item.automation
      )
      .slice(0, limit);
  }

  async bulkReviewKnowledgeCandidates(
    ids: string[],
    status: "approved" | "rejected",
    reviewer: string,
    reviewReason: CandidateReviewReason,
    reviewNote?: string
  ) {
    const uniqueIds = [...new Set(ids.map((item) => item.trim()).filter(Boolean))].slice(0, 100);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of uniqueIds) {
      try {
        await this.reviewKnowledgeCandidate(id, status, reviewer, reviewNote, reviewReason);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async getKnowledgeCandidateHistory(id: string, limit = 200) {
    return await this.observability.getCandidateHistory(id, limit);
  }

  async getKnowledgeCandidatePreview(id: string) {
    const candidate = (await this.observability.listCandidates(2000)).find((item) => item.id === id);
    if (!candidate) throw new Error("Knowledge candidate not found");
    const target = candidate.knowledgeRelation?.target ?? candidate.relationHint?.target;
    const document = target ? this.knowledgeDocuments.get(target.key) : undefined;
    const currentLines = document?.content.split(/\r?\n/) ?? [];
    const candidateLines = candidate.content.split(/\r?\n/);
    let prefix = 0;
    while (
      prefix < currentLines.length &&
      prefix < candidateLines.length &&
      currentLines[prefix] === candidateLines[prefix]
    ) prefix += 1;
    let suffix = 0;
    while (
      suffix < currentLines.length - prefix &&
      suffix < candidateLines.length - prefix &&
      currentLines[currentLines.length - 1 - suffix] === candidateLines[candidateLines.length - 1 - suffix]
    ) suffix += 1;
    return {
      candidate: {
        id: candidate.id,
        title: candidate.title,
        content: candidate.content,
        relation: candidate.knowledgeRelation ?? candidate.relationHint
      },
      target: document
        ? {
            key: document.key,
            repositoryId: document.repositoryId,
            path: document.relativePath,
            title: document.title,
            content: document.content,
            revision: document.revision
          }
        : undefined,
      changeSummary: {
        unchangedPrefixLines: prefix,
        unchangedSuffixLines: suffix,
        removedLines: Math.max(0, currentLines.length - prefix - suffix),
        addedLines: Math.max(0, candidateLines.length - prefix - suffix)
      }
    };
  }

  async updateKnowledgeCandidate(
    id: string,
    input: Partial<Pick<KnowledgeCandidate, "title" | "content" | "suggestedType" | "repository" | "suggestedPath" | "knowledgeRelation">>
  ) {
    if (input.repository !== undefined && input.repository) {
      const repository = this.config.repositories.find((repo) => repo.id === input.repository);
      if (!repository) throw new Error("Repository not found");
    }
    if (input.knowledgeRelation) {
      const relation = input.knowledgeRelation;
      if (relation.type === "new") {
        input.knowledgeRelation = { type: "new" };
      } else {
        if (!relation.target?.key) throw new Error("Knowledge relation target is required");
        const target = this.knowledgeDocuments.get(relation.target.key);
        if (!target) throw new Error("Knowledge relation target not found");
        input.knowledgeRelation = {
          type: relation.type,
          target: {
            key: target.key,
            repositoryId: target.repositoryId,
            path: target.relativePath,
            title: target.title
          }
        };
      }
    }
    return await this.observability.updateCandidate(id, input);
  }

  async reviewKnowledgeCandidate(
    id: string,
    status: "approved" | "rejected",
    reviewer: string,
    reviewNote?: string,
    reviewReason?: CandidateReviewReason
  ) {
    return await this.observability.reviewCandidate(id, status, reviewer, reviewNote, reviewReason);
  }

  async publishKnowledgeCandidate(id: string) {
    const candidate = (await this.observability.listCandidates(2000)).find((item) => item.id === id);
    if (!candidate) throw new Error("Knowledge candidate not found");
    if (!candidate.repository) throw new Error("Knowledge candidate repository is required before publishing");
    if (candidate.knowledgeRelation?.type === "conflicts_with") {
      throw new Error("Conflicting Knowledge candidate must be resolved before publishing");
    }
    if (candidate.knowledgeRelation?.type === "duplicate_of") {
      throw new Error("Duplicate Knowledge candidate should not be published");
    }
    const relationTarget =
      candidate.knowledgeRelation?.type === "updates" || candidate.knowledgeRelation?.type === "supersedes"
        ? candidate.knowledgeRelation.target
        : undefined;
    if (relationTarget && relationTarget.repositoryId !== candidate.repository) {
      throw new Error("Knowledge update target must be in the candidate repository");
    }
    const publishPath = candidate.suggestedPath || relationTarget?.path;
    if (!publishPath) throw new Error("Knowledge candidate path is required before publishing");

    const repository = this.getRepository(candidate.repository);
    if (repository.provider !== "git") throw new Error("Automatic publishing requires a git repository");
    await this.observability.markCandidatePublishing(id);
    try {
      const publisher = createKnowledgePublisher(repository);
      const publication = await publisher.publish({ ...candidate, suggestedPath: publishPath, status: "approved" }, repository);
      return await this.observability.markCandidatePublished(id, publication);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.observability.markCandidatePublishFailed(id, message);
      throw error;
    }
  }

  async reconcileKnowledgeCandidatePublication(id: string) {
    const candidate = (await this.observability.listCandidates(2000)).find((item) => item.id === id);
    if (!candidate) throw new Error("Knowledge candidate not found");
    if (!candidate.repository) throw new Error("Knowledge candidate repository is required");
    if (!candidate.publication) throw new Error("Knowledge candidate has not been published");
    const repository = this.getRepository(candidate.repository);
    if (repository.provider !== "git") throw new Error("Publication reconcile requires a git repository");
    const publisher = createKnowledgePublisher(repository);
    const status = await publisher.reconcile(candidate.publication, repository);
    return await this.observability.updateCandidatePublication(id, {
      ...candidate.publication,
      ...status
    });
  }

  getKnowledgeCuratorStatus() {
    return new HttpKnowledgeCurator().status();
  }

  async curateKnowledgeCandidate(id: string) {
    const candidate = (await this.listKnowledgeCandidates(1, { id }))[0];
    if (!candidate) throw new Error("Knowledge candidate not found");
    const proposal = await new HttpKnowledgeCurator().curateCandidate(candidate);
    return {
      candidateId: candidate.id,
      candidateStatus: candidate.status,
      proposal,
      guard: {
        deterministicValidation: true,
        humanReviewRequired: true,
        appliedAutomatically: false,
        directKnowledgeWrite: false
      }
    };
  }

  async curateKnowledgeGaps() {
    const gaps = await this.listKnowledgeGaps();
    const clusters = await new HttpKnowledgeCurator().clusterGaps(
      gaps.map((gap) => ({
        key: gap.key,
        query: gap.query,
        occurrences: gap.occurrences,
        source: gap.source,
        members: gap.members
      }))
    );
    return {
      clusters,
      gapCount: gaps.length,
      guard: {
        deterministicValidation: true,
        humanReviewRequired: true,
        appliedAutomatically: false
      }
    };
  }

  async listKnowledgeGaps() {
    const summary = await this.analytics.summary(50);
    return await this.observability.knowledgeGaps(summary.topUnmatchedQueries);
  }

  async createKnowledgeCandidateFromGap(
    gapKey: string,
    principal: Principal,
    input?: { repository?: string; suggestedPath?: string }
  ) {
    const gaps = await this.listKnowledgeGaps();
    const gap = gaps.find((item) => item.key === gapKey);
    if (!gap) throw new Error("Knowledge gap not found");
    if (input?.repository) {
      const allowed = this.allowedRepositories(principal).some((repo) => repo.id === input.repository);
      if (!allowed) throw new Error("Repository not found");
    }
    const members = gap.members?.length ? gap.members : [gap.query];
    const content = [
      "## Knowledge gap",
      "",
      gap.query,
      "",
      "## Evidence",
      "",
      "- Occurrences: " + gap.occurrences,
      "- Source: " + gap.source,
      "- Last seen: " + gap.lastSeenAt,
      "",
      "## Related queries",
      "",
      ...members.map((item) => "- " + item),
      "",
      "## Proposed knowledge",
      "",
      "TODO: Reviewer/owner should replace this section with the verified reusable engineering knowledge before approval."
    ].join("\n");
    return await this.observability.createCandidate(principal, {
      title: "Knowledge gap: " + gap.query.slice(0, 120),
      content,
      sourceType: "review",
      suggestedType: "knowledge",
      repository: input?.repository,
      suggestedPath: input?.suggestedPath
    });
  }

  private getRepository(id: string): RepositoryConfig {
    const repository = this.config.repositories.find((repo) => repo.id === id);
    if (!repository) throw new Error(`Unknown repository: ${id}`);
    return repository;
  }
}
