import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import { startServer } from "../src/server.js";

test("client-events endpoint authenticates and persists lifecycle metadata", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-client-events-e2e-"));
  const search = new SqliteFtsSearchBackend();
  process.env.ADMIN_API_KEY = "client-events-admin";
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development" as const, apiKeys: {} },
    repositories: [
      {
        id: "rd-skills",
        name: "R&D Skills",
        provider: "local" as const,
        path: dataDir,
        gitAuth: { type: "none" as const },
        webhookAliases: [],
        enabled: false,
        audience: ["developer"],
        visibility: ["internal"],
        pollingIntervalSeconds: 0,
        readRoles: ["developer", "internal"],
        syncRoles: ["admin"],
      },
    ],
  };
  const service = new SkillHubApplicationService(
    config,
    [],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [],
    new LoggingEventSink(),
  );
  await service.initialize();
  const app = await startServer(config, service);

  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    for (const route of [
      "/admin/observability",
      "/admin/observability/sessions",
      "/admin/observability/hooks",
      "/admin/observability/candidate-detections",
      "/admin/observability/mcp-calls",
      "/admin/observability/reuse",
      "/admin/observability/failures",
      "/admin/observability/mcp-calls/not-found",
    ]) {
      const page = await fetch(base + route);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("cache-control") ?? "", /no-store/);
      const html = await page.text();
      assert.match(html, /sessionStorage/);
      if (route === "/admin/observability") {
        assert.match(html, /data-admin-module-index/);
        for (const href of [
          "/admin/observability/sessions",
          "/admin/observability/hooks",
          "/admin/observability/candidate-detections",
          "/admin/observability/mcp-calls",
          "/admin/observability/reuse",
          "/admin/observability/failures",
        ])
          assert.match(html, new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(
          html,
          /sessionsTable|candidateDetectionsTable|callsTable|operationalHealth|sessionAnalytics/,
        );
      } else if (route === "/admin/observability/sessions") {
        for (const marker of [
          "关键字",
          "用户 / Actor ID",
          "仓库",
          "会话状态",
          "运行时状态",
          "包含 MCP 调用",
          "包含证据",
          "发生知识复用",
          "每页数量",
          "筛选",
          "清除",
          "上一页",
          "下一页",
        ])
          assert.match(html, new RegExp(marker));
        assert.match(html, /\['hasMcp','包含 MCP 调用'[^\n]*'boolean'\]/);
        assert.match(html, /type==='boolean'/);
        assert.match(html, /<option value='true'/);
        assert.match(html, /<option value='false'/);
        assert.match(html, /requestJson/);
        assert.match(html, /readResponse/);
        assert.match(html, /\[redacted\]/);
      } else if (route === "/admin/observability/reuse" || route === "/admin/observability/failures") {
        assert.match(html, /用户 \/ Actor ID/);
        assert.match(html, /会话 ID/);
        assert.match(html, /requestJson/);
      }
    }
    for (const [route, requiredLinks] of [
      ["/admin/review", ["/admin/review/items?status=pending", "/admin/review/items?status=published"]],
      ["/admin/gaps", ["/admin/gaps/items?status=active", "/admin/gaps/items?status=resolved"]],
    ] as const) {
      const page = await fetch(base + route);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("cache-control") ?? "", /no-store/);
      const html = await page.text();
      assert.match(html, /module-index/);
      for (const link of requiredLinks) assert.match(html, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(html, /<pre[^>]*class="raw"/);
    }
    const governancePage = await fetch(base + "/admin/governance");
    assert.equal(governancePage.status, 200);
    assert.match(governancePage.headers.get("cache-control") ?? "", /no-store/);
    const governanceHtml = await governancePage.text();
    for (const marker of ["仓库治理", "同步全部仓库", "/admin/api/repository-governance", "立即同步"])
      assert.match(governanceHtml, new RegExp(marker));
    assert.doesNotMatch(governanceHtml, /<div class="module-index"/);
    const legacyGovernance = await fetch(base + "/admin/governance/repositories", { redirect: "manual" });
    assert.equal(legacyGovernance.status, 302);
    assert.equal(legacyGovernance.headers.get("location"), "/admin/governance");
    for (const [route, markers] of [
      [
        "/admin/review/items?status=pending&limit=50",
        [
          "关键字",
          "状态",
          "Item Kind",
          "内容类型",
          "仓库",
          "来源类型",
          "审核人",
          "提交人",
          "每页数量",
          "筛选",
          "上一页",
          "下一页",
          "requestJson",
        ],
      ],
      [
        "/admin/gaps/items?status=active&limit=20",
        ["关键字", "状态", "每页数量", "筛选", "上一页", "下一页", "最近出现"],
      ],
    ] as const) {
      const page = await fetch(base + route);
      assert.equal(page.status, 200);
      const html = await page.text();
      for (const marker of markers) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(html, /<pre[^>]*class="raw"[^>]*>加载中/);
    }

    const adminHeaders = { "x-skill-hub-admin-key": "client-events-admin" };
    for (const endpoint of [
      "/admin/api/sessions",
      "/admin/api/hooks",
      "/admin/api/candidate-detections",
      "/admin/api/mcp-calls",
      "/admin/api/reuse",
      "/admin/api/failures",
      "/admin/api/knowledge-candidates",
      "/admin/api/knowledge-gaps",
      "/admin/api/repository-governance",
    ]) {
      const defaultPage = await fetch(base + endpoint, { headers: adminHeaders });
      assert.equal(defaultPage.status, 200, endpoint);
      const defaultBody = (await defaultPage.json()) as { page?: { limit?: number; cursor?: string } };
      assert.equal(defaultBody.page?.limit, 20, `${endpoint} should default to 20 rows`);
      assert.equal(defaultBody.page?.cursor, "0", `${endpoint} should start at cursor 0`);

      const cappedPage = await fetch(base + endpoint + "?limit=999&q=__admin_smoke_no_match__", {
        headers: adminHeaders,
      });
      assert.equal(cappedPage.status, 200, endpoint);
      const cappedBody = (await cappedPage.json()) as { page?: { limit?: number; total?: number } };
      assert.equal(cappedBody.page?.limit, 100, `${endpoint} should cap page size at 100`);
      assert.equal(cappedBody.page?.total, 0, `${endpoint} should apply q filtering`);
    }

    for (const detailRoute of [
      "/admin/api/sessions/not-found",
      "/admin/api/hooks/not-found",
      "/admin/api/candidate-detections/not-found",
      "/admin/api/mcp-calls/not-found",
      "/admin/api/reuse/not-found",
      "/admin/api/failures/not-found",
      "/admin/api/knowledge-candidates/not-found",
      "/admin/api/knowledge-gaps/not-found",
      "/admin/api/repository-governance/not-found",
    ])
      assert.equal((await fetch(base + detailRoute, { headers: adminHeaders })).status, 404, detailRoute);
    for (const route of [
      "/admin/api/hooks?from=not-a-date",
      "/admin/api/client-events?until=not-a-date",
      "/admin/api/candidate-detections?from=not-a-date",
      "/admin/api/sessions?to=not-a-date",
      "/admin/api/mcp-calls?from=not-a-date",
      "/admin/api/reuse?to=not-a-date",
      "/admin/api/failures?from=not-a-date",
    ]) {
      const response = await fetch(base + route, { headers: adminHeaders });
      assert.equal(response.status, 400, route);
    }
    const protectedAdminRequests: Array<{ path: string; method?: string; body?: string }> = [
      ...[
        "/admin/api/sessions",
        "/admin/api/hooks",
        "/admin/api/candidate-detections",
        "/admin/api/mcp-calls",
        "/admin/api/reuse",
        "/admin/api/failures",
        "/admin/api/knowledge-candidates",
        "/admin/api/knowledge-gaps",
        "/admin/api/repository-governance",
        "/admin/api/sessions/not-found",
        "/admin/api/hooks/not-found",
        "/admin/api/candidate-detections/not-found",
        "/admin/api/mcp-calls/not-found",
        "/admin/api/reuse/not-found",
        "/admin/api/failures/not-found",
        "/admin/api/knowledge-candidates/not-found",
        "/admin/api/knowledge-gaps/not-found",
        "/admin/api/repository-governance/not-found",
      ].map((path) => ({ path })),
      { path: "/admin/api/knowledge-gaps/not-found", method: "PATCH", body: "{}" },
      { path: "/admin/api/knowledge-gaps/not-found/candidate", method: "POST", body: "{}" },
      {
        path: "/admin/api/knowledge-candidates/not-found/review",
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      },
      { path: "/admin/api/knowledge-candidates/not-found/publish", method: "POST", body: "{}" },
      { path: "/admin/api/knowledge-candidates/not-found/reconcile", method: "POST", body: "{}" },
    ];
    for (const request of protectedAdminRequests) {
      const init = request.method
        ? { method: request.method, headers: { "content-type": "application/json" }, body: request.body }
        : undefined;
      assert.equal(
        (await fetch(base + request.path, init)).status,
        403,
        `missing admin key: ${request.method ?? "GET"} ${request.path}`,
      );
      assert.equal(
        (
          await fetch(base + request.path, {
            ...init,
            headers: { ...(init?.headers ?? {}), "x-skill-hub-admin-key": "wrong" },
          })
        ).status,
        403,
        `wrong admin key: ${request.method ?? "GET"} ${request.path}`,
      );
    }

    const openApi = await fetch(base + "/openapi.json");
    assert.equal(openApi.status, 200);
    assert.equal(openApi.headers.get("x-skill-hub-api-version"), "1");
    const openApiBody = (await openApi.json()) as {
      openapi: string;
      info: { version: string };
      paths: Record<string, unknown>;
    };
    assert.equal(openApiBody.openapi, "3.1.0");
    assert.equal(openApiBody.info.version, "1.0.0");
    assert.ok(openApiBody.paths["/admin/kpis"]);

    const apiMeta = await fetch(base + "/api/v1/meta");
    assert.equal(apiMeta.status, 200);
    assert.equal(apiMeta.headers.get("x-skill-hub-api-version"), "1");
    assert.deepEqual(await apiMeta.json(), {
      apiVersion: "1",
      openapi: "/openapi.json",
      compatibility: { legacyRoutes: true },
    });

    const versionedLive = await fetch(base + "/api/v1/health/live");
    assert.equal(versionedLive.status, 200);
    assert.equal(versionedLive.headers.get("x-skill-hub-api-version"), "1");

    const versionedKpisDenied = await fetch(base + "/api/v1/admin/kpis");
    assert.equal(versionedKpisDenied.status, 403);
    const versionedKpis = await fetch(base + "/api/v1/admin/kpis", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(versionedKpis.status, 200);
    assert.equal(versionedKpis.headers.get("x-skill-hub-api-version"), "1");

    const governance = await fetch(base + "/admin/api/repository-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(governance.status, 200);
    const governanceBody = (await governance.json()) as {
      summary: { total: number; missingOwner: number; stale: number; webhookErrors: number };
      repositories: Array<{
        id: string;
        owners: string[];
        webhook: { status: string };
        issues: string[];
      }>;
    };
    assert.equal(governanceBody.summary.total, 1);
    assert.equal(governanceBody.summary.missingOwner, 1);
    assert.deepEqual(governanceBody.repositories[0]?.owners, []);
    assert.equal(governanceBody.repositories[0]?.webhook.status, "not-applicable");
    assert.ok(governanceBody.repositories[0]?.issues.includes("missing-owner"));

    const versionedGovernance = await fetch(base + "/api/v1/admin/repository-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(versionedGovernance.status, 200);
    assert.equal(versionedGovernance.headers.get("x-skill-hub-api-version"), "1");

    const artifactGovernance = await fetch(base + "/admin/api/artifact-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(artifactGovernance.status, 200);
    const artifactGovernanceBody = (await artifactGovernance.json()) as {
      summary: { skills: number; prompts: number; agents: number; issues: number };
      skills: unknown[];
      prompts: unknown[];
      agents: unknown[];
    };
    assert.deepEqual(artifactGovernanceBody.summary, {
      skills: 0,
      prompts: 0,
      agents: 0,
      issues: 0,
      deprecatedSkills: 0,
      missingVersion: 0,
      duplicateNames: 0,
      unresolvedAgentTools: 0,
    });
    assert.deepEqual(artifactGovernanceBody.skills, []);
    assert.deepEqual(artifactGovernanceBody.prompts, []);
    assert.deepEqual(artifactGovernanceBody.agents, []);

    const versionedArtifactGovernance = await fetch(base + "/api/v1/admin/artifact-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(versionedArtifactGovernance.status, 200);
    assert.equal(versionedArtifactGovernance.headers.get("x-skill-hub-api-version"), "1");

    const contentQuality = await fetch(base + "/admin/api/content-quality", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(contentQuality.status, 200);
    const contentQualityBody = (await contentQuality.json()) as {
      summary: {
        skills: number;
        knowledge: number;
        staleSkills: number;
        staleKnowledge: number;
        reviewOverdue: number;
        positiveFeedback: number;
        negativeFeedback: number;
      };
      skills: unknown[];
      knowledge: unknown[];
      semantics: { automaticDeletion: boolean };
    };
    assert.deepEqual(contentQualityBody.summary, {
      skills: 0,
      knowledge: 0,
      staleSkills: 0,
      staleKnowledge: 0,
      reviewOverdue: 0,
      positiveFeedback: 0,
      negativeFeedback: 0,
    });
    assert.deepEqual(contentQualityBody.skills, []);
    assert.deepEqual(contentQualityBody.knowledge, []);
    assert.equal(contentQualityBody.semantics.automaticDeletion, false);

    const versionedContentQuality = await fetch(base + "/api/v1/admin/content-quality", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(versionedContentQuality.status, 200);
    assert.equal(versionedContentQuality.headers.get("x-skill-hub-api-version"), "1");

    const trendsResponse = await fetch(base + "/admin/api/dashboard-trends?days=7", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(trendsResponse.status, 200);
    const trends = (await trendsResponse.json()) as {
      days: number;
      rows: Array<{
        date: string;
        calls: number;
        errors: number;
        noHits: number;
        candidates: number;
        approvals: number;
        gapSignals: number;
        activeUsers: number;
        avgLatencyMs: number;
      }>;
      semantics: Record<string, string>;
    };
    assert.equal(trends.days, 7);
    assert.equal(trends.rows.length, 7);
    assert.match(trends.rows[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
    for (const key of [
      "calls",
      "errors",
      "noHits",
      "candidates",
      "approvals",
      "gapSignals",
      "activeUsers",
      "avgLatencyMs",
    ] as const) {
      assert.equal(typeof trends.rows.at(-1)?.[key], "number");
    }
    assert.match(trends.semantics.approvals ?? "", /updatedAt/);

    const versionedTrends = await fetch(base + "/api/v1/admin/dashboard-trends?days=7", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(versionedTrends.status, 200);
    assert.equal(versionedTrends.headers.get("x-skill-hub-api-version"), "1");

    const curatorStatusResponse = await fetch(base + "/admin/api/knowledge-curator", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(curatorStatusResponse.status, 200);
    const curatorStatus = (await curatorStatusResponse.json()) as {
      configured: boolean;
      provider: string;
      humanReviewRequired: boolean;
      directKnowledgeWrite: boolean;
    };
    assert.equal(typeof curatorStatus.configured, "boolean");
    assert.equal(curatorStatus.provider, "http-json");
    assert.equal(curatorStatus.humanReviewRequired, true);
    assert.equal(curatorStatus.directKnowledgeWrite, false);

    const schemaInfo = await fetch(base + "/api/v1/client-events/schema");
    assert.equal(schemaInfo.status, 200);
    assert.equal(schemaInfo.headers.get("x-skill-hub-api-version"), "1");
    assert.deepEqual(await schemaInfo.json(), {
      current: 1,
      minimumSupported: 1,
      missingVersionCompatibility: "treated-as-v1",
      unsupportedVersionPolicy: "reject",
      adapterContract: {
        version: 1,
        endpoint: "/client-events",
        authentication: "same-as-mcp",
        clientIdPolicy: "stable-non-secret-string",
        events: [
          "SessionStart",
          "UserPromptSubmit",
          "PreToolUse",
          "PostToolUse",
          "PreCompact",
          "PostCompact",
          "Stop",
          "SessionEnd",
        ],
        metadataPolicy: "allowlisted-sanitized",
        evidenceField: "metadata.evidence",
      },
    });

    const unsupportedSchema = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 2,
        client: "codex",
        event: "SessionStart",
        session_id: "unsupported-schema",
      }),
    });
    assert.equal(unsupportedSchema.status, 400);
    assert.equal(unsupportedSchema.headers.get("x-skill-hub-hook-schema-version"), "1");
    const unsupportedBody = (await unsupportedSchema.json()) as {
      error: string;
      supported_schema: { min: number; max: number };
    };
    assert.match(unsupportedBody.error, /Unsupported client event schema_version 2/);
    assert.deepEqual(unsupportedBody.supported_schema, { min: 1, max: 1 });

    const posted = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client: "codex",
        event: "SessionStart",
        session_id: "session-e2e",
        turn_id: "turn-e2e",
        cwd: "/work/rd-skills",
        model: "gpt-test",
        permission_mode: "default",
        metadata: {
          source: "startup",
          apiKey: "skh_never_persist_me",
          runtime_version: "0.9.0",
          hook_schema_version: 1,
        },
      }),
    });
    assert.equal(posted.status, 202);
    assert.equal(posted.headers.get("x-skill-hub-hook-schema-version"), "1");

    const legacyPosted = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "legacy-codex",
        event: "SessionEnd",
        session_id: "legacy-schema-session",
        metadata: { source: "legacy" },
      }),
    });
    assert.equal(legacyPosted.status, 202);

    const claudePosted = await fetch(base + "/client-events/claude-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "claude-session-e2e",
        prompt_id: "claude-prompt-1",
        cwd: "/work/rd-skills",
        permission_mode: "default",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "claude-tool-1",
        tool_input: { command: "npm test -- --token should-not-persist" },
        tool_response: "ℹ tests 7\nℹ pass 7\nℹ fail 0\nsecret=never-persist",
        duration_ms: 1200,
      }),
    });
    assert.equal(claudePosted.status, 204);
    assert.equal(await claudePosted.text(), "");
    assert.ok(claudePosted.headers.get("x-skill-hub-event-id"));
    assert.equal(claudePosted.headers.get("x-skill-hub-hook-schema-version"), "1");

    const genericAgentPosted = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client: "ci_agent",
        event: "PostToolUse",
        session_id: "ci-agent-e2e",
        turn_id: "pipeline-42",
        cwd: "/work/rd-skills",
        metadata: {
          tool_name: "ctest",
          adapter: "generic-client-event-v1",
          evidence: {
            success: true,
            exit_code: 0,
            tests_run: 18,
            tests_passed: 18,
            tests_failed: 0,
          },
          token: "should-redact",
        },
      }),
    });
    assert.equal(genericAgentPosted.status, 202);

    const listed = await fetch(base + "/admin/api/client-events", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as {
      events: Array<{
        event: string;
        sessionId: string;
        schemaVersion: number;
        metadata: Record<string, unknown>;
      }>;
    };
    const sessionStartEvent = body.events.find((item) => item.sessionId === "session-e2e");
    assert.equal(sessionStartEvent?.event, "SessionStart");
    assert.equal(sessionStartEvent?.metadata.apiKey, "[redacted]");
    assert.equal(sessionStartEvent?.schemaVersion, 1);
    assert.equal(sessionStartEvent?.metadata.client_event_schema_compatibility, "explicit-current");
    const legacyEvent = body.events.find((item) => item.sessionId === "legacy-schema-session");
    assert.equal(legacyEvent?.schemaVersion, 1);
    assert.equal(legacyEvent?.metadata.client_event_schema_compatibility, "implicit-v1");
    const claudeEvent = body.events.find((item) => item.sessionId === "claude-session-e2e");
    assert.equal(claudeEvent?.event, "PostToolUse");
    assert.equal(claudeEvent?.schemaVersion, 1);
    assert.equal(claudeEvent?.metadata.adapter, "claude-code-http");
    assert.equal(claudeEvent?.metadata.tool_name, "Bash");
    assert.deepEqual(claudeEvent?.metadata.evidence, {
      success: true,
      exit_code: 0,
      tests_run: 7,
      tests_passed: 7,
      tests_failed: 0,
      duration_ms: 1200,
    });
    assert.equal(claudeEvent?.metadata.tool_input, undefined);
    assert.equal(claudeEvent?.metadata.tool_response, undefined);
    const genericAgentEvent = body.events.find((item) => item.sessionId === "ci-agent-e2e");
    assert.equal(genericAgentEvent?.event, "PostToolUse");
    assert.equal(genericAgentEvent?.schemaVersion, 1);
    assert.equal(genericAgentEvent?.metadata.adapter, "generic-client-event-v1");
    assert.equal(genericAgentEvent?.metadata.tool_name, "ctest");
    assert.deepEqual(genericAgentEvent?.metadata.evidence, {
      success: true,
      exit_code: 0,
      tests_run: 18,
      tests_passed: 18,
      tests_failed: 0,
    });
    assert.equal(genericAgentEvent?.metadata.token, "[redacted]");
    assert.deepEqual(sessionStartEvent?.metadata.project_context, {
      repositoryId: "rd-skills",
      repositoryName: "R&D Skills",
      source: "cwd-basename",
    });

    const hookList = await fetch(base + "/admin/api/hooks?limit=20&q=session-e2e&event=SessionStart", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(hookList.status, 200);
    const hookPage = (await hookList.json()) as {
      events: Array<{ id: string; sessionId: string }>;
      page: { limit: number };
    };
    assert.equal(hookPage.page.limit, 20);
    assert.ok(hookPage.events.some((item) => item.sessionId === "session-e2e"));
    const hookId = hookPage.events[0]!.id;
    assert.equal(
      (
        await fetch(base + "/admin/api/hooks/" + encodeURIComponent(hookId), {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/admin/api/hooks/missing-hook", {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      404,
    );

    const firstPageResponse = await fetch(base + "/admin/api/client-events?limit=1", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(firstPageResponse.status, 200);
    const firstPage = (await firstPageResponse.json()) as {
      events: Array<{ id: string; sessionId: string }>;
      page: {
        total: number;
        limit: number;
        cursor: string;
        nextCursor?: string;
        previousCursor?: string;
      };
    };
    assert.equal(firstPage.events.length, 1);
    assert.equal(firstPage.page.limit, 1);
    assert.equal(firstPage.page.cursor, "0");
    assert.ok(firstPage.page.total >= 2);
    assert.ok(firstPage.page.nextCursor);

    const secondPageResponse = await fetch(
      base + "/admin/api/client-events?limit=1&cursor=" + encodeURIComponent(firstPage.page.nextCursor!),
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } },
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = (await secondPageResponse.json()) as {
      events: Array<{ id: string; sessionId: string }>;
      page: { previousCursor?: string };
    };
    assert.equal(secondPage.events.length, 1);
    assert.ok(secondPage.page.previousCursor !== undefined);
    assert.notEqual(secondPage.events[0]?.id, firstPage.events[0]?.id);

    const searchedEventsResponse = await fetch(base + "/admin/api/client-events?limit=10&q=legacy-schema-session", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(searchedEventsResponse.status, 200);
    const searchedEvents = (await searchedEventsResponse.json()) as {
      events: Array<{ sessionId: string }>;
      page: { total: number };
    };
    assert.ok(searchedEvents.page.total >= 1);
    assert.ok(searchedEvents.events.every((item) => item.sessionId === "legacy-schema-session"));

    const claudeEnded = await fetch(base + "/client-events/claude-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "claude-session-e2e",
        cwd: "/work/rd-skills",
        hook_event_name: "SessionEnd",
        reason: "clear",
      }),
    });
    assert.equal(claudeEnded.status, 204);

    const genericAgentEnded = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client: "ci_agent",
        event: "SessionEnd",
        session_id: "ci-agent-e2e",
        cwd: "/work/rd-skills",
        metadata: { reason: "pipeline-complete", adapter: "generic-client-event-v1" },
      }),
    });
    assert.equal(genericAgentEnded.status, 202);

    const principal = service.authenticateRequest(new Headers());
    const ambiguousA = { ...principal, id: "ambiguous-a", tenantId: "tenant-a" };
    const ambiguousB = { ...principal, id: "ambiguous-b", tenantId: "tenant-b" };
    await service.recordClientEvent(ambiguousA, {
      event: "SessionStart",
      sessionId: "ambiguous-session",
      client: "codex",
      metadata: {},
    });
    await service.recordClientEvent(ambiguousB, {
      event: "SessionStart",
      sessionId: "ambiguous-session",
      client: "codex",
      metadata: {},
    });
    assert.equal((await fetch(base + "/admin/api/sessions/ambiguous-session", { headers: adminHeaders })).status, 409);
    assert.equal(
      (await fetch(base + "/admin/api/sessions/ambiguous-session?actorId=ambiguous-a", { headers: adminHeaders }))
        .status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/admin/api/sessions/ambiguous-session?actorId=ambiguous-a&tenantId=tenant-a", {
          headers: adminHeaders,
        })
      ).status,
      200,
    );
    const call = await service.recordMcpCall({
      traceId: service.newMcpTraceId(),
      traceExplicit: false,
      transportSessionId: "mcp-transport-1",
      client: "codex-test",
      tool: "search_knowledge",
      args: { query: "OTA checkpoint", repositories: ["rd-skills"] },
      latencyMs: 4,
      success: true,
      principal,
    });
    assert.equal(call.sessionId, "session-e2e");
    assert.match(call.traceId, /^sess_[a-f0-9]{24}$/);
    assert.equal(call.transportSessionId, "mcp-transport-1");

    const callList = await fetch(base + "/admin/api/mcp-calls?limit=20&q=search_knowledge&success=true", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(callList.status, 200);
    const callPage = (await callList.json()) as { calls: Array<{ id: string; tool: string }>; page: { limit: number } };
    assert.equal(callPage.page.limit, 20);
    assert.ok(callPage.calls.some((item) => item.tool === "search_knowledge"));
    const callId = callPage.calls[0]!.id;
    assert.equal(
      (
        await fetch(base + "/admin/api/mcp-calls/" + encodeURIComponent(callId), {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/admin/api/mcp-calls/missing-call", {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      404,
    );

    const sessionsResponse = await fetch(base + "/admin/api/sessions", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(sessionsResponse.status, 200);
    const sessionsBody = (await sessionsResponse.json()) as {
      sessions: Array<{
        sessionId: string;
        callCount: number;
        eventCount: number;
        repositoryId?: string;
        runtimeVersion?: string;
        hookSchemaVersion?: number;
        runtimeStatus?: string;
        expectedRuntimeVersion?: string;
      }>;
    };
    const session = sessionsBody.sessions.find((item) => item.sessionId === "session-e2e");
    assert.equal(session?.callCount, 1);
    assert.equal(session?.eventCount, 1);
    assert.equal(session?.repositoryId, "rd-skills");
    assert.equal(session?.runtimeVersion, "0.9.0");
    assert.equal(session?.hookSchemaVersion, 1);
    assert.equal(session?.runtimeStatus, "outdated");
    assert.equal(session?.expectedRuntimeVersion, "1.3.0");

    const filteredSessions = await fetch(
      base + "/admin/api/sessions?q=session-e2e&status=active&hasMcp=true&runtimeStatus=outdated",
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } },
    );
    assert.equal(filteredSessions.status, 200);
    const filteredSessionBody = (await filteredSessions.json()) as { sessions: Array<{ sessionId: string }> };
    assert.ok(filteredSessionBody.sessions.some((item) => item.sessionId === "session-e2e"));
    assert.equal(
      (
        await fetch(base + "/admin/api/sessions/not-found", {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      404,
    );

    const timelineResponse = await fetch(
      base +
        "/admin/api/sessions/session-e2e?actorId=" +
        encodeURIComponent(principal.id) +
        "&tenantId=" +
        encodeURIComponent(principal.tenantId),
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } },
    );
    assert.equal(timelineResponse.status, 200);
    const timelineBody = (await timelineResponse.json()) as {
      timeline: Array<{ kind: string }>;
    };
    assert.deepEqual(
      timelineBody.timeline.map((item) => item.kind),
      ["event", "mcp-call"],
    );

    const postTool = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 1,
        client: "codex",
        event: "PostToolUse",
        session_id: "session-e2e",
        turn_id: "turn-auto-knowledge",
        cwd: "/work/project",
        model: "gpt-test",
        permission_mode: "default",
        metadata: {
          tool_name: "Bash",
          tool_use_id: "tool-tests",
          evidence: { tests_passed: 12, tests_failed: 0, exit_code: 0, success: true },
        },
      }),
    });
    assert.equal(postTool.status, 202);

    const assistantResult = [
      "# OTA 断电恢复修复",
      "",
      "## 问题",
      "设备升级过程中断电后可能无法恢复。",
      "",
      "## 根因",
      "恢复路径没有重新校验安全检查点和镜像完整性。",
      "",
      "## 解决方案",
      "从最后一个安全检查点恢复，并在启动前校验镜像版本与完整性。",
      "",
      "## 验证结果",
      "新增回归测试覆盖断电恢复、镜像校验失败和正常升级路径，当前十二项相关测试全部通过。",
      "",
      "## 适用范围",
      "适用于后续 OTA 项目的故障排查和恢复设计。",
      "",
      "## 约束/限制",
      "仍需在目标硬件上验证掉电时序。",
    ].join("\n");

    const stopPayload = {
      schema_version: 1,
      client: "codex",
      event: "Stop",
      session_id: "session-e2e",
      turn_id: "turn-auto-knowledge",
      cwd: "/work/project",
      model: "gpt-test",
      permission_mode: "default",
      metadata: {
        stop_hook_active: false,
        assistant_result_excerpt: assistantResult,
      },
    };
    const stopped = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stopPayload),
    });
    assert.equal(stopped.status, 202);
    const stoppedBody = (await stopped.json()) as { accepted: boolean; event_id: string };
    assert.equal(stoppedBody.accepted, true);

    const candidatesResponse = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(candidatesResponse.status, 200);
    const candidatesBody = (await candidatesResponse.json()) as {
      candidates: Array<{
        sourceType: string;
        sourceSessionId?: string;
        sourceTurnId?: string;
        automation?: {
          detector: string;
          classification: string;
          generationReason: string;
          evidenceCount: number;
          evidence: Array<{
            type: string;
            sourceTool: string;
            success?: boolean;
            counts?: { passed?: number; failed?: number };
          }>;
        };
        repository?: string;
        submissionSpecVersion?: number;
        validationSpecVersion?: number;
        submissionSpecSchemaVersion?: number;
        submissionMode?: string;
      }>;
    };
    const automatic = candidatesBody.candidates.find((item) => item.sourceTurnId === "turn-auto-knowledge");
    assert.equal(automatic?.sourceType, "codex-summary");
    assert.equal(automatic?.sourceSessionId, "session-e2e");
    assert.equal(automatic?.repository, "rd-skills");
    assert.equal(automatic?.automation?.detector, "stop-evidence-v2");
    assert.equal(automatic?.automation?.evidenceCount, 1);
    assert.equal(automatic?.automation?.classification, "verified-fix");
    assert.match(automatic?.automation?.generationReason ?? "", /passing test evidence/);
    assert.equal(automatic?.automation?.evidence[0]?.type, "test");
    assert.equal(automatic?.automation?.evidence[0]?.sourceTool, "Bash");
    assert.equal(automatic?.automation?.evidence[0]?.counts?.passed, 12);
    assert.equal(automatic?.automation?.evidence[0]?.counts?.failed, 0);
    assert.equal(automatic?.submissionMode, "automatic");
    assert.equal(automatic?.submissionSpecVersion, 1);
    assert.equal(automatic?.validationSpecVersion, 1);
    assert.equal(automatic?.submissionSpecSchemaVersion, 1);

    const eventsAfterEvidence = await fetch(base + "/admin/api/client-events", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    const eventsAfterEvidenceBody = (await eventsAfterEvidence.json()) as {
      events: Array<{ event: string; metadata: Record<string, unknown> }>;
    };
    const normalizedEvidence = eventsAfterEvidenceBody.events.find((item) => item.event === "PostToolUse")?.metadata
      .engineering_evidence as
      { schemaVersion: number; type: string; counts?: { passed?: number; failed?: number } } | undefined;
    assert.equal(normalizedEvidence?.schemaVersion, 1);
    assert.equal(normalizedEvidence?.type, "test");
    assert.equal(normalizedEvidence?.counts?.passed, 12);
    assert.equal(normalizedEvidence?.counts?.failed, 0);

    const detectionsResponse = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(detectionsResponse.status, 200);
    const detectionsBody = (await detectionsResponse.json()) as {
      detections: Array<{ id: string; outcome: string; reason: string; candidateId?: string }>;
    };
    assert.ok(
      detectionsBody.detections.some(
        (item) =>
          item.outcome === "created" && item.reason === "verified-engineering-result" && Boolean(item.candidateId),
      ),
    );
    const detection = detectionsBody.detections.find((item) => item.outcome === "created")!;
    assert.equal(
      (
        await fetch(base + "/admin/api/candidate-detections/" + encodeURIComponent(detection.id), {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      200,
    );
    const filteredDetections = await fetch(
      base + "/admin/api/candidate-detections?q=verified&outcome=created&from=2000-01-01T00:00:00.000Z",
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } },
    );
    assert.equal(filteredDetections.status, 200);
    assert.ok(((await filteredDetections.json()) as { detections: unknown[] }).detections.length >= 1);
    assert.equal(
      (
        await fetch(base + "/admin/api/candidate-detections/missing-detection", {
          headers: { "x-skill-hub-admin-key": "client-events-admin" },
        })
      ).status,
      404,
    );

    const missingRequiredStop = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...stopPayload,
        turn_id: "turn-auto-missing-required",
        metadata: {
          stop_hook_active: false,
          assistant_result_excerpt: assistantResult.replace(/\n\n## 约束\/限制[\s\S]*$/, ""),
        },
      }),
    });
    assert.equal(missingRequiredStop.status, 202);
    const detectionsAfterMissing = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    const detectionsAfterMissingBody = (await detectionsAfterMissing.json()) as {
      detections: Array<{ turnId?: string; outcome: string; reason: string }>;
    };
    assert.ok(
      detectionsAfterMissingBody.detections.some(
        (item) =>
          item.turnId === "turn-auto-missing-required" &&
          item.outcome === "skipped" &&
          item.reason === "missing-required-knowledge-field",
      ),
    );
    const candidatesAfterMissing = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    assert.equal(
      ((await candidatesAfterMissing.json()) as { candidates: Array<{ sourceTurnId?: string }> }).candidates.some(
        (item) => item.sourceTurnId === "turn-auto-missing-required",
      ),
      false,
    );

    const sessionDetailResponse = await fetch(
      base +
        "/admin/api/sessions/session-e2e?actorId=" +
        encodeURIComponent(principal.id) +
        "&tenantId=" +
        encodeURIComponent(principal.tenantId),
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } },
    );
    assert.equal(sessionDetailResponse.status, 200);
    const sessionDetail = (await sessionDetailResponse.json()) as {
      evidence: Array<{ evidence: { type?: string; counts?: { passed?: number } } }>;
      assetUsage: Array<{ tool: string }>;
      candidates: Array<{ sourceSessionId?: string; sourceTurnId?: string }>;
      detections: Array<{ outcome: string; reason: string }>;
      timeline: Array<{ kind: string }>;
    };
    assert.ok(sessionDetail.evidence.some((item) => item.evidence.type === "test"));
    assert.ok(sessionDetail.evidence.some((item) => item.evidence.counts?.passed === 12));
    assert.ok(sessionDetail.assetUsage.some((item) => item.tool === "search_knowledge"));
    assert.ok(
      sessionDetail.candidates.some(
        (item) => item.sourceSessionId === "session-e2e" && item.sourceTurnId === "turn-auto-knowledge",
      ),
    );
    assert.ok(
      sessionDetail.detections.some(
        (item) => item.outcome === "created" && item.reason === "verified-engineering-result",
      ),
    );

    const repeated = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stopPayload),
    });
    assert.equal(repeated.status, 202);
    const repeatedBody = (await repeated.json()) as { accepted: boolean; event_id: string };
    assert.equal(repeatedBody.event_id, stoppedBody.event_id);
    const afterRepeat = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    const afterRepeatBody = (await afterRepeat.json()) as {
      candidates: Array<{ sourceTurnId?: string }>;
    };
    assert.equal(afterRepeatBody.candidates.filter((item) => item.sourceTurnId === "turn-auto-knowledge").length, 1);
    const detectionsAfterRepeatResponse = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    const detectionsAfterRepeat = (await detectionsAfterRepeatResponse.json()) as {
      detections: Array<{ outcome: string; turnId?: string }>;
    };
    assert.equal(
      detectionsAfterRepeat.detections.filter(
        (item) => item.turnId === "turn-auto-knowledge" && item.outcome === "created",
      ).length,
      1,
    );

    const duplicateStop = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...stopPayload,
        turn_id: "turn-auto-knowledge-duplicate",
      }),
    });
    assert.equal(duplicateStop.status, 202);
    const afterDuplicate = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    const afterDuplicateBody = (await afterDuplicate.json()) as {
      candidates: Array<{ id: string; sourceType: string }>;
    };
    const summaryCandidates = afterDuplicateBody.candidates.filter((item) => item.sourceType === "codex-summary");
    assert.equal(summaryCandidates.length, 1);
    const duplicateDetailResponse = await fetch(
      base + "/admin/api/knowledge-candidates/" + encodeURIComponent(summaryCandidates[0]!.id),
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } },
    );
    assert.equal(duplicateDetailResponse.status, 200);
    const duplicateDetail = (await duplicateDetailResponse.json()) as { candidate: { content: string } };
    assert.equal(duplicateDetail.candidate.content, assistantResult);
    const lowValueStop = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...stopPayload,
        turn_id: "turn-format-only",
        metadata: {
          stop_hook_active: false,
          assistant_result_excerpt: [
            "# 仅格式化代码",
            "",
            "## 问题",
            "代码排版不一致。",
            "",
            "## 根因",
            "格式化规则未统一。",
            "",
            "## 解决方案",
            "统一缩进、空格、换行和 import 顺序。",
            "",
            "## 验证结果",
            "十二项测试通过，但没有行为变化或可复用的工程结论。",
            "",
            "## 适用范围",
            "本次代码格式化。",
            "",
            "## 约束/限制",
            "不应沉淀为团队知识。",
          ].join("\n"),
        },
      }),
    });
    assert.equal(lowValueStop.status, 202);
    const detectionsAfterLowValue = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" },
    });
    const lowValueBody = (await detectionsAfterLowValue.json()) as {
      detections: Array<{ outcome: string; reason: string; turnId?: string }>;
    };
    assert.ok(
      lowValueBody.detections.some(
        (item) =>
          item.turnId === "turn-format-only" && item.outcome === "skipped" && item.reason === "low-reuse-value-summary",
      ),
    );
  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});
