import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AppConfig, KnowledgePublishingConfig, KnowledgeSourceConfig } from "./types.js";
import type { SkillHubApplicationService } from "./application.js";
import { createSkillHubMcpHandler } from "./mcp.js";
import { ADMIN_HTML } from "./admin-ui.js";
import { applyAdminConfig, editableConfigFromApp, type AdminConfigStore, type AdminEditableConfig } from "./admin-config.js";
import { type ManagedApiKeyStore, type ManagedApiKeyCreateInput, type ManagedApiKeyUpdateInput } from "./api-keys.js";
import { ApiKeyAuthenticationProvider } from "./security.js";
import { normalizeKnowledgeConfig } from "./knowledge.js";

export async function startServer(
  config: AppConfig,
  service: SkillHubApplicationService,
  adminConfigStore?: AdminConfigStore,
  apiKeyStore?: ManagedApiKeyStore,
  apiKeyAuth?: ApiKeyAuthenticationProvider
) {
  const adminPrincipal = {
    id: "admin-http",
    roles: ["admin", "developer", "internal", "customer"],
    tenantId: "default"
  };
  const allowedHosts =
    config.host === "0.0.0.0" ? ["localhost", "127.0.0.1", "[::1]"] : undefined;
  const app = createMcpFastifyApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {})
  });
  const mcpHandler = createSkillHubMcpHandler(service);
  const nodeHandler = toNodeHandler(mcpHandler);

  const hasAdminAccess = (request: { headers: Record<string, unknown> }) => {
    const adminKey = process.env.ADMIN_API_KEY;
    return Boolean(adminKey && request.headers["x-skill-hub-admin-key"] === adminKey);
  };

  app.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return ADMIN_HTML;
  });

  app.get("/admin/api/config", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return {
      config: editableConfigFromApp(config),
      bootstrap: {
        adminKeyConfigured: Boolean(process.env.ADMIN_API_KEY),
        webhookSecretConfigured: Boolean(process.env.GITLAB_WEBHOOK_TOKEN ?? process.env.WEBHOOK_SECRET),
        gitlabTokenConfigured: Boolean(process.env.GITLAB_TOKEN)
      }
    };
  });

  app.put<{ Body: AdminEditableConfig }>("/admin/api/config", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!adminConfigStore) {
      reply.code(503);
      return { error: "dynamic admin configuration is unavailable" };
    }
    try {
      const normalized = await adminConfigStore.save(request.body);
      const next: AppConfig = {
        ...config,
        defaultRoles: [...config.defaultRoles],
        authentication: config.authentication,
        repositories: config.repositories
      };
      applyAdminConfig(next, normalized);
      service.applyRuntimeConfig(next);
      const syncResults = await Promise.all(
        service.repositoryIds().map(async (repositoryId) => {
          try {
            const state = await service.syncRepository(repositoryId, "manual", adminPrincipal);
            return { repository: repositoryId, ok: true, state };
          } catch (error) {
            return {
              repository: repositoryId,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );
      return { saved: true, config: editableConfigFromApp(config), syncResults };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/admin/api/knowledge", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const documents = service.listKnowledgeDocuments(adminPrincipal);
    const grouped = new Map<
      string,
      { repository: string; documents: number; chunks: number; revision?: string; paths: string[] }
    >();
    for (const document of documents) {
      const current = grouped.get(document.repositoryId) ?? {
        repository: document.repositoryId,
        documents: 0,
        chunks: 0,
        paths: []
      };
      current.documents += 1;
      current.chunks += document.chunkCount;
      current.revision = document.revision;
      current.paths.push(document.relativePath);
      grouped.set(document.repositoryId, current);
    }
    return {
      sources: config.repositories.map((repository) => {
        const indexed = grouped.get(repository.id);
        return {
          repository: repository.id,
          documents: indexed?.documents ?? 0,
          chunks: indexed?.chunks ?? 0,
          revision: indexed?.revision,
          paths: indexed?.paths ?? [],
          config: normalizeKnowledgeConfig(repository.knowledge),
          publishing: repository.knowledgePublishing
            ? {
                config: repository.knowledgePublishing,
                tokenConfigured: Boolean(process.env[repository.knowledgePublishing.tokenEnv])
              }
            : undefined
        };
      })
    };
  });

  app.put<{ Params: { repository: string }; Body: Partial<KnowledgeSourceConfig> }>(
    "/admin/api/knowledge/:repository/config",
    async (request, reply) => {
      if (!hasAdminAccess(request)) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      if (!adminConfigStore) {
        reply.code(503);
        return { error: "dynamic admin configuration is unavailable" };
      }
      const editable = editableConfigFromApp(config);
      const repository = editable.repositories.find((item) => item.id === request.params.repository);
      if (!repository) {
        reply.code(404);
        return { error: "repository not found" };
      }
      try {
        repository.knowledge = normalizeKnowledgeConfig({
          ...repository.knowledge,
          ...request.body
        });
        const normalized = await adminConfigStore.save(editable);
        const next: AppConfig = {
          ...config,
          defaultRoles: [...config.defaultRoles],
          authentication: config.authentication,
          repositories: config.repositories
        };
        applyAdminConfig(next, normalized);
        service.applyRuntimeConfig(next);
        const state = await service.syncRepository(request.params.repository, "manual", adminPrincipal);
        return {
          saved: true,
          repository: request.params.repository,
          config: normalizeKnowledgeConfig(
            config.repositories.find((item) => item.id === request.params.repository)?.knowledge
          ),
          state
        };
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  app.put<{ Params: { repository: string }; Body: Partial<KnowledgePublishingConfig> }>(
    "/admin/api/knowledge/:repository/publishing",
    async (request, reply) => {
      if (!hasAdminAccess(request)) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      if (!adminConfigStore) {
        reply.code(503);
        return { error: "dynamic admin configuration is unavailable" };
      }
      const editable = editableConfigFromApp(config);
      const repository = editable.repositories.find((item) => item.id === request.params.repository);
      if (!repository) {
        reply.code(404);
        return { error: "repository not found" };
      }
      try {
        const current = repository.knowledgePublishing ?? {
          enabled: false,
          provider: "gitlab" as const,
          tokenEnv: "GITLAB_WRITE_TOKEN",
          targetBranch: repository.branch ?? "main",
          branchPrefix: "skill-hub-knowledge"
        };
        repository.knowledgePublishing = {
          enabled: request.body.enabled ?? current.enabled,
          provider: "gitlab",
          baseUrl:
            request.body.baseUrl !== undefined
              ? request.body.baseUrl.trim() || undefined
              : current.baseUrl,
          projectPath:
            request.body.projectPath !== undefined
              ? request.body.projectPath.trim() || undefined
              : current.projectPath,
          tokenEnv: request.body.tokenEnv?.trim() || current.tokenEnv,
          targetBranch: request.body.targetBranch?.trim() || current.targetBranch,
          branchPrefix: request.body.branchPrefix?.trim() || current.branchPrefix
        };
        const normalized = await adminConfigStore.save(editable);
        const next: AppConfig = {
          ...config,
          defaultRoles: [...config.defaultRoles],
          authentication: config.authentication,
          repositories: config.repositories
        };
        applyAdminConfig(next, normalized);
        service.applyRuntimeConfig(next);
        const publishing = config.repositories.find(
          (item) => item.id === request.params.repository
        )?.knowledgePublishing;
        return {
          saved: true,
          repository: request.params.repository,
          publishing: publishing
            ? {
                config: publishing,
                tokenConfigured: Boolean(process.env[publishing.tokenEnv])
              }
            : undefined
        };
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  app.get<{ Querystring: { q?: string; repository?: string; limit?: string } }>(
    "/admin/api/knowledge/search",
    async (request, reply) => {
      if (!hasAdminAccess(request)) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      const query = request.query.q?.trim();
      if (!query) {
        reply.code(400);
        return { error: "q is required" };
      }
      const limit = Math.max(1, Math.min(Number(request.query.limit ?? 5) || 5, 20));
      const repositories = request.query.repository ? [request.query.repository] : undefined;
      return {
        results: service.searchKnowledge(query, limit, repositories, adminPrincipal).map((result) => ({
          repository: result.chunk.repositoryId,
          revision: result.chunk.revision,
          path: result.chunk.relativePath,
          title: result.chunk.title,
          chunkIndex: result.chunk.chunkIndex,
          score: result.score,
          content: result.chunk.content
        }))
      };
    }
  );

  app.get<{ Querystring: { limit?: string } }>("/admin/api/observability", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100) || 100, 1000));
    return {
      summary: await service.getMcpObservabilitySummary(),
      calls: await service.listMcpCalls(limit)
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/admin/api/traces", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100) || 100, 1000));
    return { traces: await service.listMcpTraces(limit) };
  });

  app.get<{ Params: { id: string } }>("/admin/api/traces/:id", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return { traceId: request.params.id, calls: await service.getMcpTrace(request.params.id) };
  });

  app.get<{ Querystring: { limit?: string } }>("/admin/api/feedback", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 200) || 200, 1000));
    return { feedback: await service.listFeedback(limit) };
  });

  app.get<{ Querystring: { limit?: string } }>("/admin/api/knowledge-candidates", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 500) || 500, 1000));
    return { candidates: await service.listKnowledgeCandidates(limit) };
  });

  app.post<{
    Body: {
      title: string;
      content: string;
      suggestedType?: "knowledge" | "skill";
      repository?: string;
      suggestedPath?: string;
      traceId?: string;
    };
  }>("/admin/api/knowledge-candidates", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      reply.code(201);
      return {
        candidate: await service.submitKnowledgeCandidate(adminPrincipal, {
          title: request.body.title,
          content: request.body.content,
          sourceType: "manual",
          suggestedType: request.body.suggestedType ?? "knowledge",
          repository: request.body.repository,
          suggestedPath: request.body.suggestedPath,
          traceId: request.body.traceId
        })
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      title?: string;
      content?: string;
      suggestedType?: "knowledge" | "skill";
      repository?: string;
      suggestedPath?: string;
    };
  }>("/admin/api/knowledge-candidates/:id", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return { candidate: await service.updateKnowledgeCandidate(request.params.id, request.body ?? {}) };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{
    Params: { id: string };
    Body: { status: "approved" | "rejected"; reviewNote?: string };
  }>("/admin/api/knowledge-candidates/:id/review", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!request.body || !["approved", "rejected"].includes(request.body.status)) {
      reply.code(400);
      return { error: "status must be approved or rejected" };
    }
    try {
      return {
        candidate: await service.reviewKnowledgeCandidate(
          request.params.id,
          request.body.status,
          adminPrincipal.id,
          request.body.reviewNote
        )
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{ Params: { id: string } }>("/admin/api/knowledge-candidates/:id/publish", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return { candidate: await service.publishKnowledgeCandidate(request.params.id) };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/admin/api/knowledge-gaps", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return { gaps: await service.listKnowledgeGaps() };
  });

  const refreshManagedApiKeys = () => {
    if (apiKeyStore && apiKeyAuth instanceof ApiKeyAuthenticationProvider) {
      apiKeyAuth.replaceManagedKeys(apiKeyStore.snapshot());
    }
  };

  app.get("/admin/api/api-keys", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!apiKeyStore || !(apiKeyAuth instanceof ApiKeyAuthenticationProvider)) {
      reply.code(503);
      return { error: "API key management is unavailable unless AUTH_MODE=api-key" };
    }
    return { keys: apiKeyStore.list() };
  });

  app.post<{ Body: ManagedApiKeyCreateInput }>("/admin/api/api-keys", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!apiKeyStore || !(apiKeyAuth instanceof ApiKeyAuthenticationProvider)) {
      reply.code(503);
      return { error: "API key management is unavailable unless AUTH_MODE=api-key" };
    }
    try {
      const created = await apiKeyStore.create(request.body);
      refreshManagedApiKeys();
      reply.code(201);
      return {
        key: created.record,
        apiKey: created.apiKey,
        warning: "This API key is shown only once. Copy it now."
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.put<{ Params: { id: string }; Body: ManagedApiKeyUpdateInput }>(
    "/admin/api/api-keys/:id",
    async (request, reply) => {
      if (!hasAdminAccess(request)) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      if (!apiKeyStore || !(apiKeyAuth instanceof ApiKeyAuthenticationProvider)) {
        reply.code(503);
        return { error: "API key management is unavailable unless AUTH_MODE=api-key" };
      }
      try {
        const key = await apiKeyStore.update(request.params.id, request.body);
        refreshManagedApiKeys();
        return { key };
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/admin/api/api-keys/:id", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!apiKeyStore || !(apiKeyAuth instanceof ApiKeyAuthenticationProvider)) {
      reply.code(503);
      return { error: "API key management is unavailable unless AUTH_MODE=api-key" };
    }
    const deleted = await apiKeyStore.delete(request.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: "API key not found" };
    }
    refreshManagedApiKeys();
    return { deleted: true };
  });

  app.all("/mcp", async (request, reply) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, String(value));
    }
    try {
      service.authenticateRequest(headers);
    } catch (error) {
      reply.code(401);
      return { error: error instanceof Error ? error.message : "Authentication failed" };
    }
    reply.hijack();
    await nodeHandler(request.raw, reply.raw, request.body);
  });

  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = service.isReady();
    if (!ready) reply.code(503);
    const states = service.listRepositoryStates();
    return {
      status: ready ? "ready" : "not-ready",
      repositories: {
        total: states.length,
        healthy: states.filter((state) => state.status === "healthy").length,
        error: states.filter((state) => state.status === "error").length,
        syncing: states.filter((state) => state.status === "syncing").length,
        disabled: states.filter((state) => state.status === "disabled").length
      }
    };
  });

  app.post<{ Params: { id: string } }>("/repositories/:id/sync", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return await service.syncRepository(request.params.id, "manual", adminPrincipal);
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{ Body: Record<string, unknown> }>("/webhooks/git", async (request, reply) => {
    const expectedSecret = process.env.GITLAB_WEBHOOK_TOKEN ?? process.env.WEBHOOK_SECRET;
    const providedSecret =
      request.headers["x-gitlab-token"] ?? request.headers["x-skill-hub-secret"];
    if (!expectedSecret) {
      reply.code(503);
      return { error: "git webhook is disabled; configure GITLAB_WEBHOOK_TOKEN or WEBHOOK_SECRET" };
    }
    if (providedSecret !== expectedSecret) {
      reply.code(401);
      return { error: "invalid webhook secret" };
    }

    const body = request.body ?? {};
    const repositoryHeader = request.headers["x-skill-hub-repository"];
    const repository =
      typeof body.repository === "object" && body.repository !== null
        ? (body.repository as Record<string, unknown>)
        : undefined;
    const project =
      typeof body.project === "object" && body.project !== null
        ? (body.project as Record<string, unknown>)
        : undefined;
    const references = [
      typeof repositoryHeader === "string" ? repositoryHeader : "",
      typeof body.repository_id === "string" ? body.repository_id : "",
      typeof repository?.name === "string" ? repository.name : "",
      typeof project?.name === "string" ? project.name : "",
      typeof project?.path_with_namespace === "string" ? project.path_with_namespace : "",
      typeof project?.web_url === "string" ? project.web_url : ""
    ];
    const repositoryId = service.resolveRepositoryWebhookReference(references);
    const eventId =
      (typeof request.headers["x-gitlab-event-uuid"] === "string"
        ? request.headers["x-gitlab-event-uuid"]
        : undefined) ??
      (typeof request.headers["x-gitlab-webhook-uuid"] === "string"
        ? request.headers["x-gitlab-webhook-uuid"]
        : undefined);

    if (!repositoryId || !service.repositoryIds().includes(repositoryId)) {
      reply.code(400);
      return {
        error: "unknown repository",
        hint: "Set x-skill-hub-repository to a configured repository id."
      };
    }

    const isNewEvent = await service.claimWebhookEvent(eventId);
    if (!isNewEvent) {
      return { accepted: true, duplicate: true, repository: repositoryId, event_id: eventId };
    }

    try {
      const state = await service.syncRepository(repositoryId, "webhook");
      return { accepted: true, repository: repositoryId, state };
    } catch (error) {
      reply.code(500);
      return {
        accepted: false,
        repository: repositoryId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  app.get<{ Querystring: { repository?: string; limit?: string } }>(
    "/audit",
    async (request, reply) => {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      return {
        events: await service.listAuditEvents(
          Number(request.query.limit ?? 100),
          request.query.repository,
          adminPrincipal
        )
      };
    }
  );

  app.get<{ Querystring: { limit?: string; unmatched?: string } }>(
    "/analytics/usage",
    async (request, reply) => {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      return {
        events: await service.listUsageAnalytics(
          Number(request.query.limit ?? 200),
          request.query.unmatched === "true"
        )
      };
    }
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/analytics/summary",
    async (request, reply) => {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      return await service.getUsageSummary(Number(request.query.limit ?? 10));
    }
  );

  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>(
    "/repositories/:id/evaluations/suites",
    async (request, reply) => {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      try {
        return {
          repository: request.params.id,
          suites: await service.listEvaluationSuites(
            request.params.id,
            request.query.revision,
            adminPrincipal
          )
        };
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  app.post<{
    Params: { id: string };
    Body: { suite?: string; revision?: string; baseline_revision?: string };
  }>("/repositories/:id/evaluations/run", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!request.body?.suite) {
      reply.code(400);
      return { error: "suite is required" };
    }
    try {
      return await service.runEvaluation(
        request.params.id,
        request.body.suite,
        request.body.revision,
        request.body.baseline_revision,
        adminPrincipal
      );
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get<{
    Querystring: { repository?: string; suite?: string; limit?: string };
  }>("/evaluations/runs", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return {
      runs: await service.listEvaluationRuns(
        Number(request.query.limit ?? 100),
        request.query.repository,
        request.query.suite,
        adminPrincipal
      )
    };
  });

  app.get<{ Params: { runId: string } }>("/evaluations/runs/:runId", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return await service.getEvaluationRun(request.params.runId, adminPrincipal);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return service.renderMetrics();
  });

  app.get<{ Params: { id: string } }>("/repositories/:id/revisions", async (request, reply) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return {
        repository: request.params.id,
        revisions: await service.listRepositoryRevisions(request.params.id, adminPrincipal)
      };
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{ Params: { id: string }; Body: { revision?: string } }>(
    "/repositories/:id/rollback",
    async (request, reply) => {
      const adminKey = process.env.ADMIN_API_KEY;
      if (!adminKey || request.headers["x-skill-hub-admin-key"] !== adminKey) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      if (!request.body?.revision) {
        reply.code(400);
        return { error: "revision is required" };
      }
      try {
        return await service.rollbackRepositoryRevision(
          request.params.id,
          request.body.revision,
          adminPrincipal
        );
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  await app.listen({ host: config.host, port: config.port });
  return app;
}
