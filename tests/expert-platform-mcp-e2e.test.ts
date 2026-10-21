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
      principals: ["ota-test-client"],
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

    const submitted = await callMcp(mcpUrl, apiKey, 1, "submit_expert_task", {
      problem: "Investigate OTA firmware upgrade rollback failure after power loss",
      idempotencyKey: "ota-power-loss-e2e",
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
