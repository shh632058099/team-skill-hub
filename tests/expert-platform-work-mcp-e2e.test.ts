import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { ApiKeyAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import type { AppConfig } from "../src/types.js";
import type { startServer as StartServer } from "../src/server.js";

interface McpResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; description?: string }>;
  };
  error?: { message?: string };
}

async function callMcp(
  url: string,
  apiKey: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
      "x-skill-hub-client": "claude-code-test",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  if (rpc.error) throw new Error(rpc.error.message ?? "MCP_REQUEST_FAILED");
  const text = rpc.result?.content?.find((item) => item.type === "text")?.text;
  if (!text || rpc.result?.isError) throw new Error(text ?? "MCP_TOOL_FAILED");
  return JSON.parse(text) as Record<string, any>;
}

async function listMcpTools(url: string, apiKey: string): Promise<Array<{ name: string; description?: string }>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  assert.ok(rpc.result?.tools);
  return rpc.result!.tools!;
}

test("MCP Work API drives durable work through review, rework, authorization and cancellation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "work-mcp-e2e-"));
  const runtimeDb = path.join(root, "runtime.sqlite");
  const dataDir = path.join(root, "app-data");
  const oldRuntimeDb = process.env.EXPERT_RUNTIME_DB;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;

  let app: Awaited<ReturnType<typeof StartServer>> | undefined;
  let tasks: ExpertTaskStore | undefined;
  try {
    const { startServer } = await import("../src/server.js");
    const apiKey = "work-api-key";
    const otherKey = "other-work-api-key";
    const auth = new ApiKeyAuthenticationProvider({
      [apiKey]: { id: "alice", roles: ["developer", "internal"], tenantId: "team-a" },
      [otherKey]: { id: "bob", roles: ["developer", "internal"], tenantId: "team-a" },
    });
    const search = new SqliteFtsSearchBackend();
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: [],
      authentication: { mode: "api-key", apiKeys: {} },
      repositories: [],
    };
    const service = new SkillHubApplicationService(
      config,
      [],
      new MemoryRegistryStore(),
      search,
      new SearchRoutingStrategy(search),
      auth,
      new StaticRolePermissionProvider(),
      [],
      new LoggingEventSink(),
    );
    await service.initialize();
    app = await startServer(config, service);
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

    const experts = new ExpertStore(runtimeDb);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota", "upgrade", "rollback"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    experts.close();
    tasks = new ExpertTaskStore(runtimeDb);

    const tools = await listMcpTools(mcpUrl, apiKey);
    for (const name of ["submit_work", "get_work", "wait_work", "review_work", "record_work_evidence", "cancel_work"]) {
      assert.ok(
        tools.some((tool) => tool.name === name),
        `missing MCP tool ${name}`,
      );
    }

    const submitted = await callMcp(mcpUrl, apiKey, 1, "submit_work", {
      title: "Inspect OTA rollback",
      description: "Inspect OTA rollback handling after power loss",
      idempotencyKey: "mcp-work-1",
      expertId: "ota",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const workId = String(submitted.work.workItemId);
    const taskId = String(submitted.currentTask.taskId);
    assert.match(workId, /^[0-9a-f-]{36}$/i);
    assert.equal(submitted.work.status, "running");
    assert.equal(submitted.attempts.length, 1);

    const replay = await callMcp(mcpUrl, apiKey, 2, "submit_work", {
      title: "Inspect OTA rollback",
      description: "Inspect OTA rollback handling after power loss",
      idempotencyKey: "mcp-work-1",
      expertId: "ota",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    assert.equal(replay.work.workItemId, workId);
    assert.equal(replay.currentTask.taskId, taskId);

    await assert.rejects(
      () =>
        callMcp(mcpUrl, apiKey, 3, "submit_work", {
          title: "Conflicting work",
          description: "Different payload",
          idempotencyKey: "mcp-work-1",
          expertId: "ota",
          repositoryId: "ota-repo",
          deploymentId: "ota-default",
        }),
      /WORK_IDEMPOTENCY_CONFLICT/,
    );
    await assert.rejects(() => callMcp(mcpUrl, otherKey, 4, "get_work", { workItemId: workId }), /FORBIDDEN|NOT_FOUND/);

    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    assert.equal(claim.taskId, taskId);
    tasks.complete(claim, "OTA analysis complete", 2_000, { commitSha: "a".repeat(40) });

    const waiting = await callMcp(mcpUrl, apiKey, 5, "wait_work", {
      workItemId: workId,
      afterEventId: 0,
      timeoutMs: 500,
    });
    assert.equal(waiting.work.status, "waiting_review");
    assert.equal(waiting.evidence[0].subjectRevision, "a".repeat(40));
    assert.ok(Array.isArray(waiting.events));
    assert.ok(Number(waiting.nextEventId) > 0);

    const completed = await callMcp(mcpUrl, apiKey, 6, "review_work", {
      workItemId: workId,
      expectedRevision: waiting.work.stateRevision,
      subjectRevision: "a".repeat(40),
      decision: "accepted",
      reason: "verified",
    });
    assert.equal(completed.work.status, "completed");
    assert.equal(completed.gate.ready, true);

    const omittedRouteIds = await callMcp(mcpUrl, apiKey, 60, "submit_work", {
      title: "Auto route omitted identifiers",
      description: "Verify Claude optional routing placeholders are treated as omitted",
      idempotencyKey: "mcp-work-omit-route-ids",
      expertId: "ota",
      repositoryId: ":omit:",
      deploymentId: ":omit:",
    });
    assert.equal(omittedRouteIds.work.status, "running");
    assert.equal(omittedRouteIds.work.repositoryId, null);
    assert.equal(omittedRouteIds.work.requestedDeploymentId, null);
    assert.equal(omittedRouteIds.currentTask.deploymentId, "ota-default");
    await callMcp(mcpUrl, apiKey, 61, "cancel_work", {
      workItemId: omittedRouteIds.work.workItemId,
    });

    const unspecifiedRouteIds = await callMcp(mcpUrl, apiKey, 62, "submit_work", {
      title: "Auto route unspecified identifiers",
      description: "Verify Claude unspecified routing placeholders are treated as omitted",
      idempotencyKey: "mcp-work-unspecified-route-ids",
      expertId: "ota",
      repositoryId: "__UNSPECIFIED__",
      deploymentId: "__UNSPECIFIED__",
    });
    assert.equal(unspecifiedRouteIds.work.status, "running");
    assert.equal(unspecifiedRouteIds.work.repositoryId, null);
    assert.equal(unspecifiedRouteIds.work.requestedDeploymentId, null);
    assert.equal(unspecifiedRouteIds.currentTask.deploymentId, "ota-default");
    await callMcp(mcpUrl, apiKey, 63, "cancel_work", {
      workItemId: unspecifiedRouteIds.work.workItemId,
    });

    const reworkSubmission = await callMcp(mcpUrl, apiKey, 7, "submit_work", {
      title: "Inspect OTA retry",
      description: "Inspect OTA retry path",
      idempotencyKey: "mcp-work-rework",
      expertId: "ota",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const reworkTaskId = String(reworkSubmission.currentTask.taskId);
    const reworkClaim = tasks.claim("worker-a", 3_000, 30_000, "ota")!;
    assert.equal(reworkClaim.taskId, reworkTaskId);
    tasks.complete(reworkClaim, "needs more validation", 4_000, { commitSha: "b".repeat(40) });
    const reworkWaiting = await callMcp(mcpUrl, apiKey, 8, "get_work", {
      workItemId: reworkSubmission.work.workItemId,
    });
    assert.equal(reworkWaiting.work.status, "waiting_review");

    const feedback = await callMcp(mcpUrl, apiKey, 9, "submit_expert_task_feedback", {
      taskId: reworkTaskId,
      disposition: "partially_adopted",
      reason: "补验证",
      needsRework: true,
    });
    assert.equal(feedback.feedback.disposition, "partially_adopted");
    assert.equal(feedback.work.attempts.length, 2);
    assert.equal(feedback.work.work.status, "running");

    const cancellable = await callMcp(mcpUrl, apiKey, 10, "submit_work", {
      title: "Cancel OTA work",
      description: "Cancel this OTA work before execution",
      idempotencyKey: "mcp-work-cancel",
      expertId: "ota",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const cancelled = await callMcp(mcpUrl, apiKey, 11, "cancel_work", {
      workItemId: cancellable.work.workItemId,
    });
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(cancelled.attempts[0].status, "cancelled");
  } finally {
    tasks?.close();
    if (app) await app.close();
    if (oldRuntimeDb === undefined) delete process.env.EXPERT_RUNTIME_DB;
    else process.env.EXPERT_RUNTIME_DB = oldRuntimeDb;
    rmSync(root, { recursive: true, force: true });
  }
});

test("server startup reconciliation advances durable completed work without a client read", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "work-reconcile-server-"));
  const runtimeDb = path.join(root, "runtime.sqlite");
  const dataDir = path.join(root, "app-data");
  const oldRuntimeDb = process.env.EXPERT_RUNTIME_DB;
  const oldInterval = process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;
  process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS = "20";

  let app: Awaited<ReturnType<typeof StartServer>> | undefined;
  let observer: WorkOrchestrationStore | undefined;
  try {
    const experts = new ExpertStore(runtimeDb);
    const tasks = new ExpertTaskStore(runtimeDb);
    const work = new WorkOrchestrationStore(runtimeDb);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const detail = orchestrator.submitWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "server-reconcile-1",
      sourceType: "mcp",
      title: "Recover completed work",
      description: "observe task completion after server restart",
      expertId: "ota",
      deploymentId: "ota-default",
      repositoryId: "ota-repo",
    });
    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    tasks.complete(claim, "done before restart", 2_000, { commitSha: "e".repeat(40) });
    work.close();
    tasks.close();
    experts.close();

    const auth = new ApiKeyAuthenticationProvider({
      "work-reconcile-key": { id: "alice", roles: ["developer", "internal"], tenantId: "team-a" },
    });
    const search = new SqliteFtsSearchBackend();
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: [],
      authentication: { mode: "api-key", apiKeys: {} },
      repositories: [],
    };
    const service = new SkillHubApplicationService(
      config,
      [],
      new MemoryRegistryStore(),
      search,
      new SearchRoutingStrategy(search),
      auth,
      new StaticRolePermissionProvider(),
      [],
      new LoggingEventSink(),
    );
    await service.initialize();
    const { startServer } = await import("../src/server.js");
    app = await startServer(config, service);

    observer = new WorkOrchestrationStore(runtimeDb);
    const deadline = Date.now() + 1_500;
    let status = observer.getWork(detail.work.workItemId, "alice", "team-a").status;
    while (status !== "waiting_review" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = observer.getWork(detail.work.workItemId, "alice", "team-a").status;
    }
    assert.equal(status, "waiting_review");
  } finally {
    observer?.close();
    if (app) await app.close();
    if (oldRuntimeDb === undefined) delete process.env.EXPERT_RUNTIME_DB;
    else process.env.EXPERT_RUNTIME_DB = oldRuntimeDb;
    if (oldInterval === undefined) delete process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS;
    else process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS = oldInterval;
    rmSync(root, { recursive: true, force: true });
  }
});
