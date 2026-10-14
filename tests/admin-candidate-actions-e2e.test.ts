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
import type { AppConfig, Principal } from "../src/types.js";

test("admin candidate actions support approve then publish over HTTP", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-candidate-actions-"));
  const search = new SqliteFtsSearchBackend();
  process.env.ADMIN_API_KEY = "candidate-actions-admin";
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: []
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
  const principal: Principal = { id: "candidate-author", tenantId: "rd", roles: ["developer", "internal"] };
  const candidate = await (service as any).observability.createCandidate(principal, {
    title: "Admin action chain",
    content: "Verified admin action chain.",
    sourceType: "review",
    suggestedType: "knowledge"
  });
  let publishCalled = false;
  const originalPublish = service.publishKnowledgeCandidate.bind(service);
  (service as any).publishKnowledgeCandidate = async (id: string) => {
    const current = (await service.listKnowledgeCandidates(10, { id }))[0];
    assert.equal(current?.status, "approved", "publish endpoint must observe the approved state");
    publishCalled = true;
    return { ...current!, status: "publishing" as const };
  };
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "x-skill-hub-admin-key": "candidate-actions-admin", "content-type": "application/json" };

    const review = await fetch(base + "/admin/api/knowledge-candidates/" + encodeURIComponent(candidate.id) + "/review", {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "approved", reviewReason: "useful" })
    });
    assert.equal(review.status, 200);
    assert.equal(((await review.json()) as { candidate: { status: string } }).candidate.status, "approved");

    const detail = await fetch(base + "/admin/api/knowledge-candidates/" + encodeURIComponent(candidate.id), { headers });
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { candidate: { status: string } }).candidate.status, "approved");

    const publish = await fetch(base + "/admin/api/knowledge-candidates/" + encodeURIComponent(candidate.id) + "/publish", {
      method: "POST",
      headers,
      body: "{}"
    });
    assert.equal(publish.status, 200);
    assert.equal(((await publish.json()) as { candidate: { status: string } }).candidate.status, "publishing");
    assert.equal(publishCalled, true);
  } finally {
    (service as any).publishKnowledgeCandidate = originalPublish;
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});

test("admin candidate actions support reject, reapprove, and delete over HTTP", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-candidate-manage-"));
  const search = new SqliteFtsSearchBackend();
  process.env.ADMIN_API_KEY = "candidate-manage-admin";
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: []
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
  const principal: Principal = { id: "candidate-manager", tenantId: "rd", roles: ["developer", "internal"] };
  const candidate = await (service as any).observability.createCandidate(principal, {
    title: "Admin manage chain",
    content: "Verified candidate management chain.",
    sourceType: "review",
    suggestedType: "skill"
  });
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "x-skill-hub-admin-key": "candidate-manage-admin", "content-type": "application/json" };
    const candidateUrl = base + "/admin/api/knowledge-candidates/" + encodeURIComponent(candidate.id);

    const rejected = await fetch(candidateUrl + "/review", {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "rejected", reviewReason: "false_positive" })
    });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { candidate: { status: string } }).candidate.status, "rejected");

    const reapproved = await fetch(candidateUrl + "/review", {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "approved", reviewReason: "useful" })
    });
    assert.equal(reapproved.status, 200);
    assert.equal(((await reapproved.json()) as { candidate: { status: string } }).candidate.status, "approved");

    const deleted = await fetch(candidateUrl, {
      method: "DELETE",
      headers: { "x-skill-hub-admin-key": "candidate-manage-admin" }
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });

    const missing = await fetch(candidateUrl, { headers });
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});
