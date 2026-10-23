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
    assert.match(html, /注册 Worker/);
    assert.match(html, /仅本次显示/);
    assert.match(html, /Git 仓库地址/);
    assert.match(html, /Git 代理地址/);
    assert.match(html, /模型与 AI Router/);
    assert.match(html, /凭据引用（不填写密钥）/);
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
      { id: "yocto-worker-01", capabilities: ["yocto", "build"], status: "pending" },
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
