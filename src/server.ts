import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { AppConfig } from "./types.js";
import type { SkillHubApplicationService } from "./application.js";
import { createSkillHubMcpHandler } from "./mcp.js";

export async function startServer(config: AppConfig, service: SkillHubApplicationService) {
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
