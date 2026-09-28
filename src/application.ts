import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  ValidationRule,
  RegistryStore
} from "./types.js";
import { createValidatedSnapshot } from "./repository.js";
import { scanSkills, validateSkills } from "./skills.js";
import { MetricsRegistry } from "./metrics.js";
import {
  canReadArtifact,
  scanAgents,
  scanPrompts,
  searchArtifacts,
  validateArtifactPolicies
} from "./artifacts.js";
import { UsageAnalyticsStore } from "./analytics.js";
import {
  EvaluationRunStore,
  loadEvaluationSnapshot,
  runEvaluationSuite,
  scanEvaluationSuites
} from "./evaluation.js";

export class SkillHubApplicationService {
  private readonly states = new Map<string, RepositoryState>();
  private readonly providers = new Map<string, SkillRepositoryProvider>();
  private ready = false;
  private readonly syncInFlight = new Map<string, Promise<RepositoryState>>();
  private readonly metrics = new MetricsRegistry();
  private readonly webhookSeen = new Map<string, number>();
  private readonly prompts = new Map<string, PromptArtifact>();
  private readonly agents = new Map<string, AgentArtifact>();
  private readonly analytics: UsageAnalyticsStore;
  private readonly evaluations: EvaluationRunStore;

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
          agents: [...this.agents.values()]
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
        };
        for (const prompt of artifactState.prompts ?? []) this.prompts.set(prompt.key, prompt);
        for (const agent of artifactState.agents ?? []) this.agents.set(agent.key, agent);
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
    this.ready = this.registry.list().length > 0 || this.config.repositories.length === 0;
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

  isReady(): boolean {
    return this.ready;
  }

  listRepositoryStates(): RepositoryState[] {
    return [...this.states.values()];
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
      await scanEvaluationSuites(target, repositoryId);
      const artifactIssues = validateArtifactPolicies(
        repository,
        prompts,
        agents,
        skills.map((skill) => skill.name)
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
      this.search.rebuild(this.registry.list());
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
      await scanEvaluationSuites(materialized.sourceRoot, repository.id);
      const artifactIssues = validateArtifactPolicies(
        repository,
        scannedPrompts,
        scannedAgents,
        scannedSkills.map((skill) => skill.name)
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
      this.registry.replaceRepository(repository.id, skills);
      for (const [key, prompt] of this.prompts) {
        if (prompt.repositoryId === repository.id) this.prompts.delete(key);
      }
      for (const prompt of prompts) this.prompts.set(prompt.key, prompt);
      for (const [key, agent] of this.agents) {
        if (agent.repositoryId === repository.id) this.agents.delete(key);
      }
      for (const agent of agents) this.agents.set(agent.key, agent);
      this.search.rebuild(this.registry.list());
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
      state.failureCount = 0;
      this.ready = true;
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

  private getRepository(id: string): RepositoryConfig {
    const repository = this.config.repositories.find((repo) => repo.id === id);
    if (!repository) throw new Error(`Unknown repository: ${id}`);
    return repository;
  }
}
