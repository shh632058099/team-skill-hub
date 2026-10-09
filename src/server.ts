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
import { evaluatePreToolPolicy, type PreToolPolicyInput } from "./policy.js";
import {
  AGENT_ADAPTER_CONTRACT_VERSION,
  CURRENT_HOOK_SCHEMA_VERSION,
  GENERIC_AGENT_EVENTS,
  MIN_SUPPORTED_HOOK_SCHEMA_VERSION
} from "./client-events.js";
import { translateClaudeCodeHook } from "./claude-code-adapter.js";

export async function startServer(
  config: AppConfig,
  service: SkillHubApplicationService,
  adminConfigStore?: AdminConfigStore,
  apiKeyStore?: ManagedApiKeyStore,
  apiKeyAuth?: ApiKeyAuthenticationProvider
) {
  const restApiVersion = "1";
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

  const paginateAdminRows = <T>(
    rows: T[],
    query: { limit?: string; cursor?: string; q?: string },
    searchableText: (row: T) => string
  ) => {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 50) || 50, 200));
    const q = query.q?.trim().toLowerCase();
    const filtered = q
      ? rows.filter((row) => searchableText(row).toLowerCase().includes(q))
      : rows;
    const offset = Math.max(0, Number(query.cursor ?? 0) || 0);
    const items = filtered.slice(offset, offset + limit);
    return {
      items,
      page: {
        total: filtered.length,
        limit,
        cursor: String(offset),
        nextCursor: offset + limit < filtered.length ? String(offset + limit) : undefined,
        previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined
      }
    };
  };

  const openApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "Team Skill Hub REST API",
      version: "1.0.0",
      description:
        "Versioned REST surface for health and platform administration. Legacy endpoints remain available for compatibility."
    },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: {
        AdminKey: {
          type: "apiKey",
          in: "header",
          name: "x-skill-hub-admin-key"
        }
      }
    },
    paths: {
      "/meta": {
        get: {
          summary: "REST API metadata",
          responses: { "200": { description: "API metadata" } }
        }
      },
      "/health/live": {
        get: {
          summary: "Liveness probe",
          responses: { "200": { description: "Process is live" } }
        }
      },
      "/health/ready": {
        get: {
          summary: "Readiness probe",
          responses: {
            "200": { description: "Service is ready" },
            "503": { description: "Service is not ready" }
          }
        }
      },
      "/client-events/schema": {
        get: {
          summary: "Client event schema compatibility",
          responses: { "200": { description: "Supported client event schema range" } }
        }
      },
      "/client-events/claude-code": {
        post: {
          summary: "Claude Code native HTTP Hook adapter",
          description:
            "Accepts selected Claude Code lifecycle hooks and normalizes them into the shared Client Event pipeline. Successful hook delivery returns HTTP 204 with an empty body.",
          responses: {
            "204": { description: "Hook accepted" },
            "400": { description: "Unsupported or invalid hook payload" },
            "401": { description: "Client authentication failed" }
          }
        }
      },
      "/admin/health": {
        get: {
          summary: "Operational health",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Operational health summary" },
            "403": { description: "Admin access denied" }
          }
        }
      },
      "/admin/alerts": {
        get: {
          summary: "Active alerts",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Active alert set" },
            "403": { description: "Admin access denied" }
          }
        }
      },
      "/admin/kpis": {
        get: {
          summary: "Platform KPIs",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Platform KPI summary" },
            "403": { description: "Admin access denied" }
          }
        }
      },
      "/admin/content-quality": {
        get: {
          summary: "Unified Skill and Knowledge quality metrics",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Content quality metrics" },
            "403": { description: "Admin access denied" }
          }
        }
      },
      "/admin/artifact-governance": {
        get: {
          summary: "Skill, Prompt and Agent governance summary",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Artifact governance status" },
            "403": { description: "Admin access denied" }
          }
        }
      },
      "/admin/repository-governance": {
        get: {
          summary: "Repository governance summary",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Repository governance status" },
            "403": { description: "Admin access denied" }
          }
        }
      },
      "/admin/knowledge-gaps": {
        get: {
          summary: "Clustered knowledge gaps",
          security: [{ AdminKey: [] }],
          responses: {
            "200": { description: "Knowledge gap list" },
            "403": { description: "Admin access denied" }
          }
        }
      }
    }
  } as const;

  app.get("/openapi.json", async (_request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    return openApiDocument;
  });

  app.get("/api/v1/meta", async (_request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    return {
      apiVersion: restApiVersion,
      openapi: "/openapi.json",
      compatibility: {
        legacyRoutes: true
      }
    };
  });

  const clientEventSchemaInfo = () => ({
    current: CURRENT_HOOK_SCHEMA_VERSION,
    minimumSupported: MIN_SUPPORTED_HOOK_SCHEMA_VERSION,
    missingVersionCompatibility: "treated-as-v1",
    unsupportedVersionPolicy: "reject",
    adapterContract: {
      version: AGENT_ADAPTER_CONTRACT_VERSION,
      endpoint: "/client-events",
      authentication: "same-as-mcp",
      clientIdPolicy: "stable-non-secret-string",
      events: GENERIC_AGENT_EVENTS,
      metadataPolicy: "allowlisted-sanitized",
      evidenceField: "metadata.evidence"
    }
  });

  app.get("/client-events/schema", async () => clientEventSchemaInfo());
  app.get("/api/v1/client-events/schema", async (_request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    return clientEventSchemaInfo();
  });

  app.get("/admin", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return ADMIN_HTML;
  });

  app.post<{ Body: PreToolPolicyInput }>("/admin/api/policy/pre-tool/evaluate", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!request.body?.toolName?.trim()) {
      reply.code(400);
      return { error: "toolName is required" };
    }
    return evaluatePreToolPolicy(request.body);
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

  app.get<{ Querystring: { repository?: string } }>(
    "/admin/api/knowledge/lifecycle-audit",
    async (request, reply) => {
      if (!hasAdminAccess(request)) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      const repositories = request.query.repository ? [request.query.repository] : undefined;
      return service.getKnowledgeLifecycleAudit(adminPrincipal, repositories);
    }
  );

  app.post<{
    Body: { repositoryId: string; path: string; kind: string };
  }>("/admin/api/knowledge/lifecycle-review-candidate", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!request.body?.repositoryId || !request.body?.path || !request.body?.kind) {
      reply.code(400);
      return { error: "repositoryId, path and kind are required" };
    }
    try {
      reply.code(201);
      return {
        candidate: await service.createKnowledgeReviewCandidateFromLifecycleIssue(
          request.body.repositoryId,
          request.body.path,
          request.body.kind,
          adminPrincipal
        )
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
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
          metadata: result.chunk.metadata,
          chunkIndex: result.chunk.chunkIndex,
          score: result.score,
          content: result.chunk.content
        }))
      };
    }
  );

  app.get<{
    Querystring: { q?: string; client?: string; limit?: string };
  }>("/admin/api/tools", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100) || 100, 1000));
    const query = request.query.q?.trim();
    const tools = query
      ? service.searchTools(query, limit, request.query.client, adminPrincipal).map((item) => ({
          ...item.artifact,
          score: item.score,
          reason: item.reason
        }))
      : service.listTools(request.query.client, adminPrincipal).slice(0, limit);
    return { tools };
  });

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

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>("/admin/api/client-events", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const rows = await service.listClientEvents(5000);
    const result = paginateAdminRows(rows, request.query, (item) =>
      [item.event, item.actorId, item.sessionId, item.turnId, item.client, JSON.stringify(item.metadata ?? {})]
        .filter(Boolean)
        .join(" ")
    );
    return { events: result.items, page: result.page };
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>("/admin/api/candidate-detections", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const rows = await service.listCandidateDetections(5000);
    const result = paginateAdminRows(rows, request.query, (item) =>
      [item.outcome, item.reason, item.actorId, item.sessionId, item.turnId, item.detector, item.candidateId]
        .filter(Boolean)
        .join(" ")
    );
    return { detections: result.items, page: result.page };
  });

  app.get("/admin/api/kpis", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getPlatformKpis();
  });

  app.get<{ Querystring: { days?: string } }>("/admin/api/dashboard-trends", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getDashboardTrends(Number(request.query.days ?? 14));
  });

  app.get("/admin/api/data-governance", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return service.getDataGovernancePolicy();
  });

  app.get<{ Querystring: { days?: string } }>("/admin/api/auto-candidate-quality", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getAutoCandidateQualityReport(Number(request.query.days ?? 7));
  });

  app.get("/admin/api/client-runtime", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return service.getClientRuntimeInfo();
  });

  app.get<{
    Querystring: {
      limit?: string;
      actorId?: string;
      repositoryId?: string;
      event?: string;
      runtimeStatus?: "current" | "outdated" | "unknown";
      from?: string;
      to?: string;
    };
  }>("/admin/api/sessions", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100) || 100, 1000));
    return {
      sessions: await service.listClientSessions(limit, {
        actorId: request.query.actorId,
        repositoryId: request.query.repositoryId,
        event: request.query.event,
        runtimeStatus: request.query.runtimeStatus,
        from: request.query.from,
        to: request.query.to
      })
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/admin/api/session-analytics", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 500) || 500, 1000));
    return await service.getSessionAnalytics(limit);
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { actorId?: string; tenantId?: string };
  }>("/admin/api/sessions/:sessionId", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!request.query.actorId || !request.query.tenantId) {
      reply.code(400);
      return { error: "actorId and tenantId are required" };
    }
    return await service.getClientSessionDetail(
      request.query.actorId,
      request.query.tenantId,
      request.params.sessionId
    );
  });

  app.get<{ Params: { id: string } }>("/admin/api/traces/:id", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return { traceId: request.params.id, calls: await service.getMcpTrace(request.params.id) };
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>("/admin/api/feedback", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const rows = await service.listFeedback(5000);
    const result = paginateAdminRows(rows, request.query, (item) =>
      [item.actorId, item.rating, item.targetType, item.target, item.reason, item.traceId]
        .filter(Boolean)
        .join(" ")
    );
    return { feedback: result.items, page: result.page };
  });

  app.get<{
    Querystring: {
      limit?: string;
      cursor?: string;
      q?: string;
      id?: string;
      status?: string;
      repository?: string;
      sourceType?: string;
      reviewer?: string;
      automatic?: string;
    };
  }>("/admin/api/knowledge-candidates", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const automatic =
      request.query.automatic === "true"
        ? true
        : request.query.automatic === "false"
          ? false
          : undefined;
    const rows = await service.listKnowledgeCandidates(5000, {
      id: request.query.id,
      status: request.query.status,
      repository: request.query.repository,
      sourceType: request.query.sourceType,
      reviewer: request.query.reviewer,
      automatic
    });
    const result = paginateAdminRows(rows, request.query, (item) =>
      [item.id, item.title, item.content, item.repository, item.status, item.sourceType, item.reviewer, item.reviewReason]
        .filter(Boolean)
        .join(" ")
    );
    return { candidates: result.items, page: result.page };
  });

  app.post<{
    Body: {
      ids: string[];
      status: "approved" | "rejected";
      reviewNote?: string;
      reviewReason: "useful" | "needs_edit" | "false_positive" | "duplicate" | "low_reuse_value" | "outdated";
    };
  }>("/admin/api/knowledge-candidates/bulk-review", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!Array.isArray(request.body?.ids) || !request.body.ids.length || request.body.ids.length > 100) {
      reply.code(400);
      return { error: "ids must contain 1..100 candidate ids" };
    }
    if (!["approved", "rejected"].includes(request.body.status)) {
      reply.code(400);
      return { error: "status must be approved or rejected" };
    }
    const allowedReasons =
      request.body.status === "approved"
        ? ["useful", "needs_edit"]
        : ["false_positive", "duplicate", "low_reuse_value", "outdated"];
    if (!allowedReasons.includes(request.body.reviewReason)) {
      reply.code(400);
      return { error: "reviewReason is not valid for the selected review status" };
    }
    return {
      results: await service.bulkReviewKnowledgeCandidates(
        request.body.ids,
        request.body.status,
        adminPrincipal.id,
        request.body.reviewReason,
        request.body.reviewNote
      )
    };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/admin/api/knowledge-candidates/:id/history",
    async (request, reply) => {
      if (!hasAdminAccess(request)) {
        reply.code(403);
        return { error: "admin API access denied" };
      }
      const limit = Math.max(1, Math.min(Number(request.query.limit ?? 200) || 200, 1000));
      const history = await service.getKnowledgeCandidateHistory(request.params.id, limit);
      if (!history.length) {
        reply.code(404);
        return { error: "knowledge candidate not found" };
      }
      return { candidateId: request.params.id, history };
    }
  );

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

  app.get<{ Params: { id: string } }>("/admin/api/knowledge-candidates/:id/preview", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return await service.getKnowledgeCandidatePreview(request.params.id);
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get("/admin/api/knowledge-curator", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return service.getKnowledgeCuratorStatus();
  });

  app.post<{ Params: { id: string } }>("/admin/api/knowledge-candidates/:id/curate", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return await service.curateKnowledgeCandidate(request.params.id);
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
      knowledgeRelation?: {
        type: "new" | "duplicate_of" | "updates" | "supersedes" | "conflicts_with" | "related_to";
        target?: { key: string; repositoryId: string; path: string; title: string };
      };
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
    Body: {
      status: "approved" | "rejected";
      reviewNote?: string;
      reviewReason?: "useful" | "needs_edit" | "false_positive" | "duplicate" | "low_reuse_value" | "outdated";
    };
  }>("/admin/api/knowledge-candidates/:id/review", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    if (!request.body || !["approved", "rejected"].includes(request.body.status)) {
      reply.code(400);
      return { error: "status must be approved or rejected" };
    }
    const allowedReasons =
      request.body.status === "approved"
        ? ["useful", "needs_edit"]
        : ["false_positive", "duplicate", "low_reuse_value", "outdated"];
    if (request.body.reviewReason && !allowedReasons.includes(request.body.reviewReason)) {
      reply.code(400);
      return { error: "reviewReason is not valid for the selected review status" };
    }
    try {
      return {
        candidate: await service.reviewKnowledgeCandidate(
          request.params.id,
          request.body.status,
          adminPrincipal.id,
          request.body.reviewNote,
          request.body.reviewReason
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

  app.post<{ Params: { id: string } }>("/admin/api/knowledge-candidates/:id/reconcile", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return { candidate: await service.reconcileKnowledgeCandidatePublication(request.params.id) };
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

  app.post("/admin/api/knowledge-gaps/curate", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      return await service.curateKnowledgeGaps();
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{
    Params: { key: string };
    Body: { repository?: string; suggestedPath?: string };
  }>("/admin/api/knowledge-gaps/:key/candidate", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    try {
      reply.code(201);
      return {
        candidate: await service.createKnowledgeCandidateFromGap(
          request.params.key,
          adminPrincipal,
          request.body ?? {}
        )
      };
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
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
    try {
      const deleted = await apiKeyStore.delete(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: "API key not found" };
      }
      refreshManagedApiKeys();
      return { deleted: true };
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post<{
    Body: {
      schema_version?: number;
      client?: string;
      event: string;
      session_id: string;
      turn_id?: string;
      cwd?: string;
      model?: string;
      permission_mode?: string;
      metadata?: Record<string, unknown>;
    };
  }>("/client-events", async (request, reply) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, String(value));
    }
    let principal;
    try {
      principal = service.authenticateRequest(headers);
    } catch (error) {
      reply.code(401);
      return { error: error instanceof Error ? error.message : "Authentication failed" };
    }
    const body = request.body;
    if (!body?.event || !body?.session_id) {
      reply.code(400);
      return { error: "event and session_id are required" };
    }
    try {
      const record = await service.recordClientEvent(principal, {
        schemaVersion: body.schema_version,
        client: body.client ?? "codex",
        event: body.event,
        sessionId: body.session_id,
        turnId: body.turn_id,
        cwd: body.cwd,
        model: body.model,
        permissionMode: body.permission_mode,
        metadata: body.metadata
      });
      reply
        .header("x-skill-hub-hook-schema-version", String(CURRENT_HOOK_SCHEMA_VERSION))
        .code(202);
      return { accepted: true, event_id: record.id };
    } catch (error) {
      reply
        .header("x-skill-hub-hook-schema-version", String(CURRENT_HOOK_SCHEMA_VERSION))
        .code(400);
      return {
        error: error instanceof Error ? error.message : String(error),
        supported_schema: {
          min: MIN_SUPPORTED_HOOK_SCHEMA_VERSION,
          max: CURRENT_HOOK_SCHEMA_VERSION
        }
      };
    }
  });

  app.post<{ Body: Record<string, unknown> }>(
    "/client-events/claude-code",
    async (request, reply) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, String(value));
      }
      let principal;
      try {
        principal = service.authenticateRequest(headers);
      } catch (error) {
        reply.code(401);
        return { error: error instanceof Error ? error.message : "Authentication failed" };
      }
      try {
        const translated = translateClaudeCodeHook(request.body);
        const record = await service.recordClientEvent(principal, translated);
        reply
          .header("x-skill-hub-event-id", record.id)
          .header("x-skill-hub-hook-schema-version", String(CURRENT_HOOK_SCHEMA_VERSION))
          .code(204);
        return reply.send();
      } catch (error) {
        reply.code(400);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

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

  app.get("/admin/api/health", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getOperationalHealth();
  });

  app.get("/admin/api/content-quality", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getContentQualityMetrics(adminPrincipal);
  });

  app.get("/admin/api/artifact-governance", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getArtifactGovernance(adminPrincipal);
  });

  app.get("/admin/api/repository-governance", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getRepositoryGovernance(adminPrincipal);
  });

  app.get("/admin/api/alerts", async (request, reply) => {
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getActiveAlerts(adminPrincipal);
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

  app.get("/api/v1/health/live", async (_request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    return { status: "live" };
  });

  app.get("/api/v1/health/ready", async (_request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
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

  app.get("/api/v1/admin/health", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getOperationalHealth();
  });

  app.get("/api/v1/admin/content-quality", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getContentQualityMetrics(adminPrincipal);
  });

  app.get("/api/v1/admin/artifact-governance", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getArtifactGovernance(adminPrincipal);
  });

  app.get("/api/v1/admin/repository-governance", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getRepositoryGovernance(adminPrincipal);
  });

  app.get("/api/v1/admin/alerts", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getActiveAlerts(adminPrincipal);
  });

  app.get("/api/v1/admin/kpis", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getPlatformKpis();
  });

  app.get<{ Querystring: { days?: string } }>("/api/v1/admin/dashboard-trends", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return await service.getDashboardTrends(Number(request.query.days ?? 14));
  });

  app.get<{ Querystring: { limit?: string } }>("/api/v1/admin/session-analytics", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 500) || 500, 1000));
    return await service.getSessionAnalytics(limit);
  });

  app.get("/api/v1/admin/knowledge-gaps", async (request, reply) => {
    reply.header("x-skill-hub-api-version", restApiVersion);
    if (!hasAdminAccess(request)) {
      reply.code(403);
      return { error: "admin API access denied" };
    }
    return { gaps: await service.listKnowledgeGaps() };
  });

  await app.listen({ host: config.host, port: config.port });
  return app;
}
