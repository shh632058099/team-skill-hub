import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { startExpertHubRuntimeFromEnv } from "../src/expert-platform/hub-runtime.js";
import { ExpertWorkerClient } from "../src/expert-platform/grpc-transport.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { runRemoteWorkerOnce } from "../src/expert-platform/remote-worker.js";
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
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
      "x-skill-hub-client": "codex",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  if (rpc.error) throw new Error(rpc.error.message ?? "MCP_REQUEST_FAILED");
  const content = rpc.result?.content?.find((item) => item.type === "text")?.text;
  if (!content || rpc.result?.isError) throw new Error(content ?? "MCP_TOOL_FAILED");
  return JSON.parse(content) as Record<string, unknown>;
}

async function listMcpTools(url: string, apiKey: string): Promise<Array<{ name: string; description?: string }>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
      "x-skill-hub-client": "codex",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  if (rpc.error) throw new Error(rpc.error.message ?? "MCP_REQUEST_FAILED");
  assert.ok(rpc.result?.tools, "MCP tools/list should return the registered tools");
  return rpc.result.tools;
}

test("MCP routes an OTA task through the persisted Expert, gRPC Worker and result tools", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-mcp-e2e-"));
  const runtimeDb = path.join(root, "expert-runtime.sqlite");
  const workerDb = path.join(root, "expert-workers.sqlite");
  const dataDir = path.join(root, "app-data");
  const previousRuntimeDb = process.env.EXPERT_RUNTIME_DB;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;

  const search = new SqliteFtsSearchBackend();
  let app: Awaited<ReturnType<typeof StartServer>> | undefined;
  let hub: Awaited<ReturnType<typeof startExpertHubRuntimeFromEnv>> = null;
  let workerClient: ExpertWorkerClient | undefined;
  let tasks: ExpertTaskStore | undefined;
  let experts: ExpertStore | undefined;
  let workers: PersistentWorkerRegistry | undefined;

  try {
    // Import only after setting EXPERT_RUNTIME_DB: the MCP module opens its persistent stores at module load.
    const { startServer } = await import("../src/server.js");
    const apiKey = "expert-mcp-e2e-key";
    const auth = new ApiKeyAuthenticationProvider({
      [apiKey]: { id: "ota-test-client", roles: ["developer", "internal"], tenantId: "rd" },
    });
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
    const httpAddress = app.server.address();
    assert.ok(httpAddress && typeof httpAddress !== "string");
    const mcpUrl = `http://127.0.0.1:${httpAddress.port}/mcp`;

    const listedTools = await listMcpTools(mcpUrl, apiKey);
    const catalogDescription = listedTools.find((tool) => tool.name === "list_available_experts")?.description ?? "";
    assert.ok(listedTools.some((tool) => tool.name === "submit_expert_task_auto"));
    const submitDescription = listedTools.find((tool) => tool.name === "submit_expert_task")?.description ?? "";
    assert.match(catalogDescription, /ONLY when the user explicitly names an Expert/i);
    assert.match(catalogDescription, /do NOT call this tool/i);
    assert.match(catalogDescription, /separate from Skill Hub skills and agents/i);
    assert.match(catalogDescription, /returned expertId/i);
    assert.match(submitDescription, /delegate.*specialist analysis/i);
    assert.match(submitDescription, /CRITICAL ROUTING RULE/i);
    assert.match(submitDescription, /selectionMode="auto"/i);
    assert.match(submitDescription, /never use magic expertId strings/i);
    assert.match(
      submitDescription,
      /user did NOT explicitly name an Expert, set selectionMode="auto" and OMIT expertId/i,
    );

    experts = new ExpertStore(runtimeDb);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["upgrade", "rollback", "firmware"],
      active: true,
    });
    experts.putDefinition({
      id: "yocto",
      displayName: "Yocto Expert",
      capabilities: ["yocto"],
      keywords: ["bitbake", "recipe"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["ota-test-client"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    experts.putDeployment({
      id: "yocto-private",
      expertId: "yocto",
      repositoryIds: ["yocto-repo"],
      repositories: [],
      principals: ["another-client"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    experts.close();
    experts = undefined;

    workers = new PersistentWorkerRegistry(workerDb);
    workers.enroll("ota-worker", ["ota"]);
    workers.approve("ota-worker");
    const credential = workers.issueCredential("ota-worker");
    workers.close();
    workers = undefined;

    hub = await startExpertHubRuntimeFromEnv({
      EXPERT_RUNTIME_DB: runtimeDb,
      EXPERT_WORKER_REGISTRY_DB: workerDb,
      EXPERT_GRPC_ADDRESS: "127.0.0.1:0",
    });
    assert.ok(hub);

    tasks = new ExpertTaskStore(runtimeDb);
    const unauthorizedExpertTask = tasks.submit({
      principalId: "ota-test-client",
      scope: "rd",
      idempotencyKey: "wrong-expert",
      problem: "Inspect Yocto recipe build failure",
      expertId: "yocto",
      repositoryId: "yocto-repo",
      selectionMode: "explicit",
      schemaVersion: 1,
    });

    workerClient = new ExpertWorkerClient(hub.address, {
      workerId: "ota-worker",
      credential,
    });
    await assert.rejects(
      () => workerClient!.claimTask("ota-worker", "yocto", "ota"),
      /WORKER_EXPERT_CAPABILITY_MISMATCH/,
    );
    assert.equal(tasks.get(unauthorizedExpertTask.taskId, "ota-test-client", "rd").status, "queued");

    const catalog = await callMcp(mcpUrl, apiKey, 4, "list_available_experts", {});
    const availableExperts = catalog.experts as Array<{
      expertId: string;
      displayName: string;
      repositoryIds: string[];
    }>;
    assert.deepEqual(
      availableExperts.map((expert) => expert.expertId),
      ["ota"],
    );
    assert.equal(availableExperts[0]?.displayName, "OTA Expert");
    assert.deepEqual(availableExperts[0]?.repositoryIds, ["ota-repo"]);

    const submitted = await callMcp(mcpUrl, apiKey, 1, "submit_expert_task", {
      problem: "Investigate OTA firmware upgrade rollback failure after power loss",
      idempotencyKey: "ota-power-loss-e2e",
      selectionMode: "auto",
      repositoryId: "ota-repo",
    });
    assert.equal(submitted.expertId, "ota");
    assert.equal(submitted.selectionMode, "auto");
    assert.equal(submitted.repositoryId, "ota-repo");
    const taskId = String(submitted.taskId);
    assert.match(taskId, /^[0-9a-f-]{36}$/i);

    const claimed = await runRemoteWorkerOnce(
      workerClient,
      "ota-worker",
      "ota",
      async (claim) => {
        assert.equal(claim.taskId, taskId);
        return "Read-only OTA analysis: the task was routed to the OTA expert and completed by the remote worker.";
      },
      { expertId: "ota", heartbeatMs: 1000 },
    );
    assert.equal(claimed, true);

    const status = await callMcp(mcpUrl, apiKey, 2, "get_expert_task_status", { taskId });
    assert.equal(status.status, "succeeded");
    assert.equal(status.expertId, "ota");
    const result = await callMcp(mcpUrl, apiKey, 3, "get_expert_task_result", { taskId });
    assert.match(String(result.result), /Read-only OTA analysis/);

    const explicit = await callMcp(mcpUrl, apiKey, 5, "submit_expert_task", {
      problem: "Review the OTA upgrade state machine after an interrupted firmware write",
      idempotencyKey: "ota-explicit-e2e",
      expertId: "ota",
      repositoryId: "ota-repo",
    });
    assert.equal(explicit.expertId, "ota");
    assert.equal(explicit.selectionMode, "explicit");
    assert.equal(explicit.repositoryId, "ota-repo");
    const explicitTaskId = String(explicit.taskId);
    assert.equal(
      await runRemoteWorkerOnce(
        workerClient,
        "ota-worker",
        "ota",
        async (claim) => {
          assert.equal(claim.taskId, explicitTaskId);
          return "Explicit OTA analysis completed.";
        },
        { expertId: "ota", heartbeatMs: 1000 },
      ),
      true,
    );
    const explicitStatus = await callMcp(mcpUrl, apiKey, 6, "get_expert_task_status", {
      taskId: explicitTaskId,
    });
    assert.equal(explicitStatus.status, "succeeded");
    assert.equal(explicitStatus.selectionMode, "explicit");
    const explicitResult = await callMcp(mcpUrl, apiKey, 7, "get_expert_task_result", {
      taskId: explicitTaskId,
    });
    assert.match(String(explicitResult.result), /Explicit OTA analysis completed/);

    const autoDelegated = await callMcp(mcpUrl, apiKey, 31, "submit_expert_task_auto", {
      problem: "Inspect OTA rollback source code, without any modifications",
      idempotencyKey: "auto-tool-no-expert-id",
    });
    assert.equal(autoDelegated.expertId, "ota");
    assert.equal(autoDelegated.selectionMode, "auto");
    assert.equal(autoDelegated.repositoryId, null); // legacy repository ID requires explicit selection
  } finally {
    workerClient?.close();
    await hub?.close();
    await app?.close();
    tasks?.close();
    experts?.close();
    workers?.close();
    search.close();
    if (previousRuntimeDb === undefined) delete process.env.EXPERT_RUNTIME_DB;
    else process.env.EXPERT_RUNTIME_DB = previousRuntimeDb;
    rmSync(root, { recursive: true, force: true });
  }
});
