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
import type { AppConfig } from "../src/types.js";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-auto-candidate-admin-"));
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: [],
  };
  const search = new SqliteFtsSearchBackend();
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
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  return { dataDir, search, service, app, base: `http://127.0.0.1:${address.port}` };
}

test("admin manages versioned auto candidate shadow policy", async () => {
  process.env.ADMIN_API_KEY = "auto-candidate-admin";
  const f = await fixture();
  const headers = { "x-skill-hub-admin-key": "auto-candidate-admin", "content-type": "application/json" };
  try {
    assert.equal((await fetch(f.base + "/admin/api/auto-candidate-policy")).status, 403);

    const currentResponse = await fetch(f.base + "/admin/api/auto-candidate-policy", { headers });
    assert.equal(currentResponse.status, 200);
    const current = (await currentResponse.json()) as any;
    assert.equal(current.policy.policyVersion, 1);
    assert.equal(current.policy.mode, "shadow");
    assert.equal(current.policy.thresholds.createScore, 80);
    assert.equal(current.policy.limits.globalPerHour, 10);
    assert.equal(current.policy.limits.globalPerDay, 50);

    const invalid = structuredClone(current.policy);
    invalid.thresholds.shadowScore = 90;
    invalid.thresholds.createScore = 80;
    const invalidResponse = await fetch(f.base + "/admin/api/auto-candidate-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify(invalid),
    });
    assert.equal(invalidResponse.status, 400);

    const active = structuredClone(current.policy);
    active.mode = "active";
    const activeResponse = await fetch(f.base + "/admin/api/auto-candidate-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify(active),
    });
    assert.equal(activeResponse.status, 400);
    assert.match(((await activeResponse.json()) as any).error, /shadow/i);

    const changed = structuredClone(current.policy);
    changed.thresholds.createScore = 85;
    const savedResponse = await fetch(f.base + "/admin/api/auto-candidate-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify(changed),
    });
    assert.equal(savedResponse.status, 200);
    const saved = (await savedResponse.json()) as any;
    assert.equal(saved.policy.policyVersion, 2);
    assert.equal(saved.policy.thresholds.createScore, 85);

    const historyResponse = await fetch(f.base + "/admin/api/auto-candidate-policy/history", { headers });
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()) as any;
    assert.deepEqual(
      history.policies.map((item: any) => item.policyVersion),
      [2, 1],
    );

    const rollbackResponse = await fetch(f.base + "/admin/api/auto-candidate-policy/rollback", {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollbackResponse.status, 200);
    const rolled = (await rollbackResponse.json()) as any;
    assert.equal(rolled.policy.policyVersion, 3);
    assert.equal(rolled.policy.thresholds.createScore, 80);

    const page = await fetch(f.base + "/admin/auto-candidate-policy", { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const marker of [
      "Auto Candidate v3",
      "Shadow 阈值",
      "创建阈值",
      "每用户/小时",
      "每仓库/天",
      "全局/天",
      "保存为新版本",
      "版本历史",
      "/admin/api/auto-candidate-policy",
    ]) {
      assert.match(html, new RegExp(marker.replace(/[.*+?^$()|[\]\\]/g, "\\$&")));
    }
  } finally {
    await f.app.close();
    f.search.close();
    await rm(f.dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});

test("auto candidate quality report exposes v3 shadow score and policy projections", async () => {
  process.env.ADMIN_API_KEY = "auto-candidate-quality-admin";
  const f = await fixture();
  const headers = { "x-skill-hub-admin-key": "auto-candidate-quality-admin" };
  try {
    await (f.service as any).observability.recordCandidateDetection({
      detector: "stop-evidence-v3",
      actorId: "user-a",
      tenantId: "default",
      sessionId: "session-a",
      turnId: "turn-a",
      outcome: "shadow",
      reason: "shadow-create",
      evidenceCount: 2,
      policyVersion: 1,
      mode: "shadow",
      score: 85,
      thresholds: { shadowScore: 60, createScore: 80 },
      hardGates: { assistantResult: true, meaningfulActivity: true, verification: true, lowValue: true },
      scoreSignals: [{ id: "verified-fix", delta: 25, reason: "verified fix" }],
      admission: { allowed: true, reason: "admitted" },
      projectedAction: "create",
      repositoryId: "repo-a",
    });
    const response = await fetch(f.base + "/admin/api/auto-candidate-quality?days=7", { headers });
    assert.equal(response.status, 200);
    const report = (await response.json()) as any;
    assert.equal(report.current.shadow, 1);
    assert.equal(report.current.projectedCreates, 1);
    assert.equal(report.current.scoreBuckets.gteCreate, 1);
    assert.equal(report.current.scoreBuckets.betweenShadowAndCreate, 0);
    assert.equal(report.byPolicyVersion[0].policyVersion, 1);
    assert.equal(report.byPolicyVersion[0].projectedCreates, 1);
    assert.match(report.projectionSemantics, /upper bound/i);
  } finally {
    await f.app.close();
    f.search.close();
    await rm(f.dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});
