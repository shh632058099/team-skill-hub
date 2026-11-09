import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { startServer } from "../src/server.js";
import { ADMIN_EXPERTS_HTML } from "../src/expert-admin-ui.js";

test("Admin expert configuration UI manages definitions and execution configurations in the runtime database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-expert-admin-"));
  const dataDir = path.join(root, "data");
  const runtimeDb = path.join(root, "runtime", "expert-runtime.sqlite3");
  const search = new SqliteFtsSearchBackend();
  const envKeys = [
    "AUTH_MODE",
    "ADMIN_LOGIN_REQUIRED",
    "ADMIN_API_KEY",
    "EXPERT_RUNTIME_DB",
    "EXPERT_WORKER_REGISTRY_DB",
  ] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.AUTH_MODE = "development";
  process.env.ADMIN_LOGIN_REQUIRED = "false";
  delete process.env.ADMIN_API_KEY;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;
  process.env.EXPERT_WORKER_REGISTRY_DB = path.join(root, "runtime", "expert-workers.sqlite");
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development" as const, apiKeys: {} },
    repositories: [],
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
    const base = "http://127.0.0.1:" + address.port;
    const page = await fetch(base + "/admin/experts");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /专家配置/);
    assert.match(html, /执行配置/);
    assert.match(html, /Worker 管理/);
    assert.match(html, /任务运行记录/);
    assert.match(html, /注册 Worker/);
    assert.match(html, /仅本次显示/);
    assert.match(html, /Git 仓库地址/);
    assert.match(html, /Git 代理地址/);
    assert.match(html, /Executor \/ Model/);
    assert.match(html, /MCP Credential Ref/);
    assert.doesNotMatch(html, /源码仓库 ID（每行一项）/);
    const scriptStart = html.indexOf("<script>");
    const scriptEnd = html.indexOf("</script>", scriptStart + 8);
    assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "expert admin page must include its controller script");
    const inlineScript = html.slice(scriptStart + 8, scriptEnd);
    assert.ok(inlineScript, "expert admin page must include its controller script");
    assert.doesNotThrow(
      () => new Script(inlineScript),
      "expert admin inline JavaScript must parse before browser execution",
    );

    const createdDefinition = await fetch(base + "/admin/api/expert-config/definitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ota",
        displayName: "OTA 专家",
        capabilities: ["ota-analysis"],
        keywords: ["OTA", "升级失败"],
        active: true,
        modelConfig: {
          providerId: "bst",
          model: "gpt-5.6-luna",
          baseUrl: "https://route.briancs.shop/v1",
          wireApi: "responses",
          credentialRef: "ai-router-default",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      }),
    });
    assert.equal(createdDefinition.status, 201);
    const definitionsBody = (await createdDefinition.json()) as {
      definition: { id: string; modelConfig?: { providerId: string; baseUrl: string; credentialRef?: string } };
    };
    assert.equal(definitionsBody.definition.id, "ota");
    assert.equal(definitionsBody.definition.modelConfig?.providerId, "bst");
    assert.equal(definitionsBody.definition.modelConfig?.baseUrl, "https://route.briancs.shop/v1");
    assert.equal(definitionsBody.definition.modelConfig?.credentialRef, "ai-router-default");
    assert.doesNotMatch(JSON.stringify(definitionsBody), /api[_-]?key\s*[=:]\s*[^,}]+/i);

    const rejectedUnsafeModelConfig = await fetch(base + "/admin/api/expert-config/definitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "unsafe-model-config",
        displayName: "Unsafe Model Config",
        capabilities: ["test"],
        keywords: [],
        active: true,
        modelConfig: {
          providerId: "p",
          model: "m",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["CODEX_HOME"],
        },
      }),
    });
    assert.equal(rejectedUnsafeModelConfig.status, 400);

    const createdDeployment = await fetch(base + "/admin/api/expert-config/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ota-product-a",
        expertId: "ota",
        repositoryIds: ["product-a-ota"],
        principals: ["team-a"],
        runtimeProfile: "linux-ota",
        active: true,
      }),
    });
    assert.equal(createdDeployment.status, 201);

    const createdUrlDeployment = await fetch(base + "/admin/api/expert-config/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ota-from-url",
        expertId: "ota",
        repositories: [{ url: "https://github.com/example/ota-firmware.git", branch: "main" }],
        principals: ["team-a"],
        runtimeProfile: "linux-ota",
        active: true,
      }),
    });
    assert.equal(createdUrlDeployment.status, 201);
    const urlDeploymentBody = (await createdUrlDeployment.json()) as {
      deployment: { repositoryIds: string[]; repositories: Array<{ id: string; url: string; branch: string }> };
    };
    assert.match(urlDeploymentBody.deployment.repositoryIds[0] ?? "", /^repo-[a-f0-9]{20}$/);
    assert.equal(urlDeploymentBody.deployment.repositories[0]?.url, "https://github.com/example/ota-firmware.git");
    assert.equal(urlDeploymentBody.deployment.repositories[0]?.branch, "main");
    const rejectedLocalUrl = await fetch(base + "/admin/api/expert-config/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "bad-repository",
        expertId: "ota",
        repositories: [{ url: "https://127.0.0.1/private.git", branch: "main" }],
        principals: ["team-a"],
        runtimeProfile: "linux-ota",
        active: true,
      }),
    });
    assert.equal(rejectedLocalUrl.status, 400);

    const disabled = await fetch(base + "/admin/api/expert-config/deployments/ota-product-a", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ota-product-a",
        expertId: "ota",
        repositoryIds: ["product-a-ota"],
        principals: ["team-a"],
        runtimeProfile: "linux-ota",
        active: false,
      }),
    });
    assert.equal(disabled.status, 200);

    const principalsOnly = await fetch(base + "/admin/api/expert-config/deployments/ota-product-a/principals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principals: [] }),
    });
    assert.equal(principalsOnly.status, 200);
    const principalsOnlyBody = (await principalsOnly.json()) as {
      deployment: { principals: string[]; runtimeProfile: string; active: boolean };
    };
    assert.deepEqual(principalsOnlyBody.deployment.principals, []);
    assert.equal(principalsOnlyBody.deployment.runtimeProfile, "linux-ota");
    assert.equal(principalsOnlyBody.deployment.active, false);

    const enrolledWorker = await fetch(base + "/admin/api/expert-workers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "yocto-worker-01", capabilities: ["yocto", "build"] }),
    });
    assert.equal(enrolledWorker.status, 201);
    assert.deepEqual((await enrolledWorker.json()).worker, {
      id: "yocto-worker-01",
      capabilities: ["yocto", "build"],
      status: "pending",
    });

    const pendingWorkers = await fetch(base + "/admin/api/expert-workers");
    assert.equal(pendingWorkers.status, 200);
    assert.deepEqual((await pendingWorkers.json()).workers, [
      {
        id: "yocto-worker-01",
        capabilities: ["yocto", "build"],
        status: "pending",
        connectionStatus: "not_connected",
        lastSeenAt: null,
      },
    ]);

    const rejectedCredential = await fetch(base + "/admin/api/expert-workers/yocto-worker-01/issue-credential", {
      method: "POST",
    });
    assert.equal(rejectedCredential.status, 400);
    assert.equal((await rejectedCredential.json()).error, "WORKER_NOT_ACTIVE");

    const approvedWorker = await fetch(base + "/admin/api/expert-workers/yocto-worker-01/approve", {
      method: "POST",
    });
    assert.equal(approvedWorker.status, 200);
    assert.equal((await approvedWorker.json()).worker.status, "active");

    const rejectedActiveDelete = await fetch(base + "/admin/api/expert-workers/yocto-worker-01", {
      method: "DELETE",
    });
    assert.equal(rejectedActiveDelete.status, 409);
    assert.equal((await rejectedActiveDelete.json()).error, "WORKER_ACTIVE");

    const issuedCredentialResponse = await fetch(base + "/admin/api/expert-workers/yocto-worker-01/issue-credential", {
      method: "POST",
    });
    assert.equal(issuedCredentialResponse.status, 200);
    assert.match(issuedCredentialResponse.headers.get("cache-control") ?? "", /no-store/);
    const issuedCredential = (await issuedCredentialResponse.json()) as { credential: string };
    assert.match(issuedCredential.credential, /^ewc_/);
    const listedAfterIssue = await fetch(base + "/admin/api/expert-workers");
    const safeWorkerList = JSON.stringify(await listedAfterIssue.json());
    assert.doesNotMatch(safeWorkerList, /ewc_/);
    assert.doesNotMatch(safeWorkerList, /credential_hash|credential/);

    const revokedWorker = await fetch(base + "/admin/api/expert-workers/yocto-worker-01/revoke", {
      method: "POST",
    });
    assert.equal(revokedWorker.status, 200);
    assert.equal((await revokedWorker.json()).worker.status, "revoked");

    const deletedWorker = await fetch(base + "/admin/api/expert-workers/yocto-worker-01", {
      method: "DELETE",
    });
    assert.equal(deletedWorker.status, 200);
    assert.equal((await deletedWorker.json()).deleted, true);

    const workersAfterDelete = await fetch(base + "/admin/api/expert-workers");
    assert.deepEqual((await workersAfterDelete.json()).workers, []);

    const reEnrolledWorker = await fetch(base + "/admin/api/expert-workers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "yocto-worker-01", capabilities: ["yocto"] }),
    });
    assert.equal(reEnrolledWorker.status, 201);
    assert.equal((await reEnrolledWorker.json()).worker.status, "pending");

    assert.match(html, /永久删除 Worker/);
    assert.match(html, /method:'DELETE'/);

    const taskStore = new ExpertTaskStore(runtimeDb);
    const task = taskStore.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "admin-log-e2e",
      problem: "analyse ota safely",
      expertId: "ota",
    });
    const run = taskStore.claim("worker-01", Date.now(), 30000, "ota")!;
    taskStore.recordStage(run, "repository.started");
    taskStore.recordStage(run, "repository.completed");
    taskStore.complete(run, "Read-only findings");
    taskStore.close();
    const list = await fetch(base + "/admin/api/expert-tasks?status=succeeded&expertId=ota");
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.equal(listed.total, 1);
    assert.equal(listed.tasks[0].task_id, task.taskId);
    assert.ok(Number.isSafeInteger(listed.tasks[0].created_at) && listed.tasks[0].created_at > 0);
    assert.equal(listed.tasks[0].result, undefined, "list must not expose full report");
    const detail = await fetch(base + "/admin/api/expert-tasks/" + task.taskId);
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.task.result, "Read-only findings");
    assert.equal(body.runs.length, 1);
    assert.ok(body.events.some((x: any) => x.event_type === "repository.started"));
    assert.equal(body.eventsPage.limit, 50);
    assert.equal(body.eventsPage.offset, 0);
    assert.equal(body.eventsPage.hasNewer, false);
    const newestPageResponse = await fetch(base + "/admin/api/expert-tasks/" + task.taskId + "?limit=1&offset=0");
    assert.equal(newestPageResponse.status, 200);
    const newestPage = await newestPageResponse.json();
    assert.equal(newestPage.events.length, 1);
    assert.equal(newestPage.eventsPage.hasOlder, true);
    const olderPageResponse = await fetch(base + "/admin/api/expert-tasks/" + task.taskId + "?limit=1&offset=1");
    const olderPage = await olderPageResponse.json();
    assert.equal(olderPage.eventsPage.hasNewer, true);
    assert.ok(Number(newestPage.events[0].event_id) > Number(olderPage.events[0].event_id));
    const metricsStore = new ExpertTaskStore(runtimeDb);
    const makeDeploymentTask = (idempotencyKey: string, version: number) => {
      const created = metricsStore.submit({
        principalId: "alice",
        scope: "org",
        idempotencyKey,
        problem: `deployment v${version} feedback`,
        expertId: "ota",
        repositoryId: "repo-a",
        deploymentSnapshot: {
          deploymentId: "ota-prod",
          configVersion: version,
          runtimeProfile: "linux-ota",
          repository: { id: "repo-a", url: "https://example.com/ota.git", branch: "main" },
          executor: {
            backend: "claude",
            modelConfig: {
              providerId: "test",
              model: "test-model",
              baseUrl: "http://localhost",
              wireApi: "anthropic-messages",
              allowedEnvNames: [],
            },
          },
        },
      });
      const claimed = metricsStore.claim("metrics-worker", Date.now(), 30000, "ota", {
        backend: "claude",
        runtimeProfiles: ["linux-ota"],
      })!;
      assert.equal(claimed.taskId, created.taskId);
      metricsStore.complete(claimed, `result-v${version}`);
      return created;
    };
    const version1 = makeDeploymentTask("feedback-version-1", 1);
    metricsStore.submitFeedback(version1.taskId, "alice", "org", { disposition: "adopted" });
    const version2Rejected = makeDeploymentTask("feedback-version-2-rejected", 2);
    metricsStore.submitFeedback(version2Rejected.taskId, "alice", "org", {
      disposition: "not_adopted",
      reason: "结果不适用",
      needsRework: true,
    });
    makeDeploymentTask("feedback-version-2-unreviewed", 2);
    metricsStore.close();

    const metricsResponse = await fetch(base + "/admin/api/expert-tasks?status=succeeded&expertId=ota");
    const metricsBody = await metricsResponse.json();
    const metrics = metricsBody.feedbackMetrics as any[];
    const legacyGroup = metrics.find((x) => x.expertId === "ota" && x.deploymentId === "unknown");
    assert.equal(legacyGroup.successful, 1);
    assert.equal(legacyGroup.reviewed, 0);
    assert.equal(legacyGroup.unreviewed, 1);
    assert.equal(legacyGroup.adoptionRate, null);
    const version1Group = metrics.find((x) => x.deploymentId === "ota-prod" && x.deploymentConfigVersion === 1);
    assert.deepEqual(
      { successful: version1Group.successful, reviewed: version1Group.reviewed, adopted: version1Group.adopted },
      { successful: 1, reviewed: 1, adopted: 1 },
    );
    assert.equal(version1Group.adoptionRate, 1);
    const version2Group = metrics.find((x) => x.deploymentId === "ota-prod" && x.deploymentConfigVersion === 2);
    assert.deepEqual(
      {
        successful: version2Group.successful,
        reviewed: version2Group.reviewed,
        unreviewed: version2Group.unreviewed,
        notAdopted: version2Group.notAdopted,
        rework: version2Group.rework,
      },
      { successful: 2, reviewed: 1, unreviewed: 1, notAdopted: 1, rework: 1 },
    );
    assert.equal(version2Group.adoptionRate, 0);
    const rejectedDetailResponse = await fetch(base + "/admin/api/expert-tasks/" + version2Rejected.taskId);
    const rejectedDetail = await rejectedDetailResponse.json();
    assert.deepEqual(rejectedDetail.feedback, {
      taskId: version2Rejected.taskId,
      disposition: "not_adopted",
      reason: "结果不适用",
      needsRework: true,
      updatedAt: rejectedDetail.feedback.updatedAt,
    });
    assert.equal(typeof rejectedDetail.feedback.updatedAt, "number");
    assert.match(html, /taskFeedbackSummary/);
    assert.match(html, /taskFeedbackMetrics/);
    assert.match(html, /用户反馈统计明细/);
    assert.match(html, /friendlyMetricValue/);
    assert.match(html, /用户采纳反馈/);
    assert.equal((await fetch(base + "/admin/api/expert-tasks/not-a-uuid")).status, 400);
    assert.match(html, /id="taskPage"/);
    assert.match(html, /<th>时间<\/th>/);
    assert.match(html, /item\.created_at/);
    assert.match(html, /id="taskStop"/);
    assert.match(html, /id="taskDelete"/);
    assert.match(html, /id="taskEventsNewer"/);
    assert.match(html, /id="taskEventsOlder"/);
    assert.match(html, /taskEventOffset=0/);
    assert.match(html, /hashchange/);
    // Deletion is transactional and includes events + runs; active tasks cannot be removed.
    const deleted = await fetch(base + "/admin/api/expert-tasks/" + task.taskId, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    assert.equal((await fetch(base + "/admin/api/expert-tasks/" + task.taskId)).status, 404);
    assert.equal((await fetch(base + "/admin/api/expert-tasks/" + task.taskId, { method: "DELETE" })).status, 404);
    const controlStore = new ExpertTaskStore(runtimeDb);
    const queued = controlStore.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "admin-stop-queued",
      problem: "wait for stop",
      expertId: "ota",
    });
    const running = controlStore.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "admin-stop-running",
      problem: "run then stop",
      expertId: "ota",
    });
    const activeClaim = controlStore.claim("worker-02", Date.now(), 30000, "ota")!;
    assert.equal(activeClaim.taskId, queued.taskId);
    controlStore.close();
    assert.equal((await fetch(base + "/admin/api/expert-tasks/" + queued.taskId, { method: "DELETE" })).status, 409);
    const stopRunning = await fetch(base + "/admin/api/expert-tasks/" + queued.taskId + "/stop", { method: "POST" });
    assert.equal(stopRunning.status, 200);
    assert.equal((await stopRunning.json()).outcome, "cancellation_requested");
    const storeAfterStop = new ExpertTaskStore(runtimeDb);
    assert.equal(storeAfterStop.cancellationRequested(activeClaim), true);
    storeAfterStop.fail(activeClaim, "TASK_CANCELLED");
    storeAfterStop.close();
    assert.equal((await fetch(base + "/admin/api/expert-tasks/" + queued.taskId, { method: "DELETE" })).status, 200);
    const queuedStop = await fetch(base + "/admin/api/expert-tasks/" + running.taskId + "/stop", { method: "POST" });
    assert.equal(queuedStop.status, 200);
    assert.equal((await queuedStop.json()).outcome, "cancelled");
    assert.equal((await fetch(base + "/admin/api/expert-tasks/" + running.taskId, { method: "DELETE" })).status, 200);
    assert.equal(
      (await fetch(base + "/admin/api/expert-tasks/" + running.taskId + "/stop", { method: "POST" })).status,
      404,
    );
    assert.equal((await fetch(base + "/admin/api/expert-tasks/not-a-uuid/stop", { method: "POST" })).status, 400);

    const store = new ExpertStore(runtimeDb);
    try {
      assert.deepEqual(
        store.listDefinitions().map((item) => item.id),
        ["ota"],
      );
      assert.equal(store.getDefinition("ota").modelConfig?.providerId, "bst");
      assert.equal(store.getDeployment("ota-product-a").active, false);
      assert.equal(store.getDeployment("ota-from-url").repositories?.[0]?.branch, "main");
    } finally {
      store.close();
    }

    const blockedDefinitionDelete = await fetch(base + "/admin/api/expert-config/definitions/ota", {
      method: "DELETE",
    });
    assert.equal(blockedDefinitionDelete.status, 409);
    assert.equal((await blockedDefinitionDelete.json()).error, "EXPERT_IN_USE");

    const deletedLegacyDeployment = await fetch(base + "/admin/api/expert-config/deployments/ota-product-a", {
      method: "DELETE",
    });
    assert.equal(deletedLegacyDeployment.status, 200);
    assert.equal((await deletedLegacyDeployment.json()).deleted, true);
    assert.equal(
      (await fetch(base + "/admin/api/expert-config/deployments/ota-product-a", { method: "DELETE" })).status,
      404,
    );

    const deletedUrlDeployment = await fetch(base + "/admin/api/expert-config/deployments/ota-from-url", {
      method: "DELETE",
    });
    assert.equal(deletedUrlDeployment.status, 200);
    const deletedDefinition = await fetch(base + "/admin/api/expert-config/definitions/ota", { method: "DELETE" });
    assert.equal(deletedDefinition.status, 200);
    assert.equal((await deletedDefinition.json()).deleted, true);
    assert.equal((await fetch(base + "/admin/api/expert-config/definitions/ota", { method: "DELETE" })).status, 404);
  } finally {
    await app.close();
    search.close();
    await rm(root, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Task detail must expose the persisted client/session identity to operators.
test("expert task detail UI displays persisted source session and client", () => {
  assert.match(ADMIN_EXPERTS_HTML, /source_session_id/);
  assert.match(ADMIN_EXPERTS_HTML, /source_client/);
});
