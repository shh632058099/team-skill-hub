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
        syncRoles: ["admin"]
      }
    ]
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
    new LoggingEventSink()
  );
  await service.initialize();
  const app = await startServer(config, service);

  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

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
      compatibility: { legacyRoutes: true }
    });

    const versionedLive = await fetch(base + "/api/v1/health/live");
    assert.equal(versionedLive.status, 200);
    assert.equal(versionedLive.headers.get("x-skill-hub-api-version"), "1");

    const versionedKpisDenied = await fetch(base + "/api/v1/admin/kpis");
    assert.equal(versionedKpisDenied.status, 403);
    const versionedKpis = await fetch(base + "/api/v1/admin/kpis", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(versionedKpis.status, 200);
    assert.equal(versionedKpis.headers.get("x-skill-hub-api-version"), "1");

    const governance = await fetch(base + "/admin/api/repository-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(versionedGovernance.status, 200);
    assert.equal(versionedGovernance.headers.get("x-skill-hub-api-version"), "1");

    const artifactGovernance = await fetch(base + "/admin/api/artifact-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
      unresolvedAgentTools: 0
    });
    assert.deepEqual(artifactGovernanceBody.skills, []);
    assert.deepEqual(artifactGovernanceBody.prompts, []);
    assert.deepEqual(artifactGovernanceBody.agents, []);

    const versionedArtifactGovernance = await fetch(base + "/api/v1/admin/artifact-governance", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(versionedArtifactGovernance.status, 200);
    assert.equal(versionedArtifactGovernance.headers.get("x-skill-hub-api-version"), "1");

    const contentQuality = await fetch(base + "/admin/api/content-quality", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
      negativeFeedback: 0
    });
    assert.deepEqual(contentQualityBody.skills, []);
    assert.deepEqual(contentQualityBody.knowledge, []);
    assert.equal(contentQualityBody.semantics.automaticDeletion, false);

    const versionedContentQuality = await fetch(base + "/api/v1/admin/content-quality", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(versionedContentQuality.status, 200);
    assert.equal(versionedContentQuality.headers.get("x-skill-hub-api-version"), "1");

    const trendsResponse = await fetch(base + "/admin/api/dashboard-trends?days=7", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
    for (const key of ["calls","errors","noHits","candidates","approvals","gapSignals","activeUsers","avgLatencyMs"] as const) {
      assert.equal(typeof trends.rows.at(-1)?.[key], "number");
    }
    assert.match(trends.semantics.approvals ?? "", /updatedAt/);

    const versionedTrends = await fetch(base + "/api/v1/admin/dashboard-trends?days=7", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(versionedTrends.status, 200);
    assert.equal(versionedTrends.headers.get("x-skill-hub-api-version"), "1");

    const curatorStatusResponse = await fetch(base + "/admin/api/knowledge-curator", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
          "SessionEnd"
        ],
        metadataPolicy: "allowlisted-sanitized",
        evidenceField: "metadata.evidence"
      }
    });

    const unsupportedSchema = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: 2,
        client: "codex",
        event: "SessionStart",
        session_id: "unsupported-schema"
      })
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
        metadata: { source: "startup", apiKey: "skh_never_persist_me", runtime_version: "0.9.0", hook_schema_version: 1 }
      })
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
        metadata: { source: "legacy" }
      })
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
        duration_ms: 1200
      })
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
            tests_failed: 0
          },
          token: "should-redact"
        }
      })
    });
    assert.equal(genericAgentPosted.status, 202);

    const listed = await fetch(base + "/admin/api/client-events", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
      duration_ms: 1200
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
      tests_failed: 0
    });
    assert.equal(genericAgentEvent?.metadata.token, "[redacted]");
    assert.deepEqual(sessionStartEvent?.metadata.project_context, {
      repositoryId: "rd-skills",
      repositoryName: "R&D Skills",
      source: "cwd-basename"
    });

    const firstPageResponse = await fetch(base + "/admin/api/client-events?limit=1", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } }
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = (await secondPageResponse.json()) as {
      events: Array<{ id: string; sessionId: string }>;
      page: { previousCursor?: string };
    };
    assert.equal(secondPage.events.length, 1);
    assert.ok(secondPage.page.previousCursor !== undefined);
    assert.notEqual(secondPage.events[0]?.id, firstPage.events[0]?.id);

    const searchedEventsResponse = await fetch(
      base + "/admin/api/client-events?limit=10&q=legacy-schema-session",
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } }
    );
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
        reason: "clear"
      })
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
        metadata: { reason: "pipeline-complete", adapter: "generic-client-event-v1" }
      })
    });
    assert.equal(genericAgentEnded.status, 202);

    const principal = service.authenticateRequest(new Headers());
    const call = await service.recordMcpCall({
      traceId: service.newMcpTraceId(),
      traceExplicit: false,
      transportSessionId: "mcp-transport-1",
      client: "codex-test",
      tool: "search_knowledge",
      args: { query: "OTA checkpoint", repositories: ["rd-skills"] },
      latencyMs: 4,
      success: true,
      principal
    });
    assert.equal(call.sessionId, "session-e2e");
    assert.match(call.traceId, /^sess_[a-f0-9]{24}$/);
    assert.equal(call.transportSessionId, "mcp-transport-1");

    const sessionsResponse = await fetch(base + "/admin/api/sessions", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(sessionsResponse.status, 200);
    const sessionsBody = (await sessionsResponse.json()) as {
      sessions: Array<{ sessionId: string; callCount: number; eventCount: number; repositoryId?: string; runtimeVersion?: string; hookSchemaVersion?: number; runtimeStatus?: string; expectedRuntimeVersion?: string }>;
    };
    const session = sessionsBody.sessions.find((item) => item.sessionId === "session-e2e");
    assert.equal(session?.callCount, 1);
    assert.equal(session?.eventCount, 1);
    assert.equal(session?.repositoryId, "rd-skills");
    assert.equal(session?.runtimeVersion, "0.9.0");
    assert.equal(session?.hookSchemaVersion, 1);
    assert.equal(session?.runtimeStatus, "outdated");
    assert.equal(session?.expectedRuntimeVersion, "1.1.0");

    const timelineResponse = await fetch(
      base +
        "/admin/api/sessions/session-e2e?actorId=" +
        encodeURIComponent(principal.id) +
        "&tenantId=" +
        encodeURIComponent(principal.tenantId),
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } }
    );
    assert.equal(timelineResponse.status, 200);
    const timelineBody = (await timelineResponse.json()) as {
      timeline: Array<{ kind: string }>;
    };
    assert.deepEqual(timelineBody.timeline.map((item) => item.kind), ["event", "mcp-call"]);

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
          evidence: { tests_passed: 12, tests_failed: 0, exit_code: 0, success: true }
        }
      })
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
      "仍需在目标硬件上验证掉电时序。"
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
        assistant_result_excerpt: assistantResult
      }
    };
    const stopped = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stopPayload)
    });
    assert.equal(stopped.status, 202);
    const stoppedBody = (await stopped.json()) as { accepted: boolean; event_id: string };
    assert.equal(stoppedBody.accepted, true);

    const candidatesResponse = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
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
          evidence: Array<{ type: string; sourceTool: string; success?: boolean; counts?: { passed?: number; failed?: number } }>;
        };
        repository?: string;
      }>;
    };
    const automatic = candidatesBody.candidates.find(
      (item) => item.sourceTurnId === "turn-auto-knowledge"
    );
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

    const eventsAfterEvidence = await fetch(base + "/admin/api/client-events", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    const eventsAfterEvidenceBody = (await eventsAfterEvidence.json()) as {
      events: Array<{ event: string; metadata: Record<string, unknown> }>;
    };
    const normalizedEvidence = eventsAfterEvidenceBody.events.find(
      (item) => item.event === "PostToolUse"
    )?.metadata.engineering_evidence as
      | { schemaVersion: number; type: string; counts?: { passed?: number; failed?: number } }
      | undefined;
    assert.equal(normalizedEvidence?.schemaVersion, 1);
    assert.equal(normalizedEvidence?.type, "test");
    assert.equal(normalizedEvidence?.counts?.passed, 12);
    assert.equal(normalizedEvidence?.counts?.failed, 0);

    const detectionsResponse = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    assert.equal(detectionsResponse.status, 200);
    const detectionsBody = (await detectionsResponse.json()) as {
      detections: Array<{ outcome: string; reason: string; candidateId?: string }>;
    };
    assert.ok(
      detectionsBody.detections.some(
        (item) =>
          item.outcome === "created" &&
          item.reason === "verified-engineering-result" &&
          Boolean(item.candidateId)
      )
    );

    const sessionDetailResponse = await fetch(
      base +
        "/admin/api/sessions/session-e2e?actorId=" +
        encodeURIComponent(principal.id) +
        "&tenantId=" +
        encodeURIComponent(principal.tenantId),
      { headers: { "x-skill-hub-admin-key": "client-events-admin" } }
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
        (item) =>
          item.sourceSessionId === "session-e2e" &&
          item.sourceTurnId === "turn-auto-knowledge"
      )
    );
    assert.ok(
      sessionDetail.detections.some(
        (item) =>
          item.outcome === "created" &&
          item.reason === "verified-engineering-result"
      )
    );

    const repeated = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stopPayload)
    });
    assert.equal(repeated.status, 202);
    const repeatedBody = (await repeated.json()) as { accepted: boolean; event_id: string };
    assert.equal(repeatedBody.event_id, stoppedBody.event_id);
    const afterRepeat = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    const afterRepeatBody = (await afterRepeat.json()) as {
      candidates: Array<{ sourceTurnId?: string }>;
    };
    assert.equal(
      afterRepeatBody.candidates.filter((item) => item.sourceTurnId === "turn-auto-knowledge").length,
      1
    );
    const detectionsAfterRepeatResponse = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    const detectionsAfterRepeat = (await detectionsAfterRepeatResponse.json()) as {
      detections: Array<{ outcome: string; turnId?: string }>;
    };
    assert.equal(
      detectionsAfterRepeat.detections.filter(
        (item) => item.turnId === "turn-auto-knowledge" && item.outcome === "created"
      ).length,
      1
    );

    const duplicateStop = await fetch(base + "/client-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...stopPayload,
        turn_id: "turn-auto-knowledge-duplicate"
      })
    });
    assert.equal(duplicateStop.status, 202);
    const afterDuplicate = await fetch(base + "/admin/api/knowledge-candidates", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    const afterDuplicateBody = (await afterDuplicate.json()) as {
      candidates: Array<{ content: string; sourceType: string }>;
    };
    assert.equal(
      afterDuplicateBody.candidates.filter(
        (item) => item.sourceType === "codex-summary" && item.content === assistantResult
      ).length,
      1
    );
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
            "不应沉淀为团队知识。"
          ].join("\n")
        }
      })
    });
    assert.equal(lowValueStop.status, 202);
    const detectionsAfterLowValue = await fetch(base + "/admin/api/candidate-detections", {
      headers: { "x-skill-hub-admin-key": "client-events-admin" }
    });
    const lowValueBody = (await detectionsAfterLowValue.json()) as {
      detections: Array<{ outcome: string; reason: string; turnId?: string }>;
    };
    assert.ok(
      lowValueBody.detections.some(
        (item) =>
          item.turnId === "turn-format-only" &&
          item.outcome === "skipped" &&
          item.reason === "low-reuse-value-summary"
      )
    );

  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});
