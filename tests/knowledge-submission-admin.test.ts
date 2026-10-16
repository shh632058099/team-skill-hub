import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-spec-admin-"));
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

test("application startup fails closed on malformed persisted Knowledge submission spec", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-spec-startup-"));
  const specDir = path.join(dataDir, "config", "knowledge-submission-spec");
  await mkdir(specDir, { recursive: true });
  await writeFile(
    path.join(specDir, "current.json"),
    JSON.stringify({ schema_version: 1, spec_version: 9, sections: [] }),
    "utf8",
  );
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
  try {
    await assert.rejects(service.initialize(), /Invalid knowledge submission spec/);
  } finally {
    search.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("admin manages versioned Knowledge submission spec and hot-applies changes", async () => {
  process.env.ADMIN_API_KEY = "knowledge-spec-admin";
  const f = await fixture();
  const headers = { "x-skill-hub-admin-key": "knowledge-spec-admin", "content-type": "application/json" };
  try {
    const denied = await fetch(f.base + "/admin/api/knowledge-submission-spec");
    assert.equal(denied.status, 403);

    const currentResponse = await fetch(f.base + "/admin/api/knowledge-submission-spec", { headers });
    assert.equal(currentResponse.status, 200);
    const current = (await currentResponse.json()) as any;
    assert.equal(current.spec.spec_version, 1);
    assert.equal(current.spec.content.max_chars, 50_000);
    assert.match(current.template, /## 问题/);

    const invalid = structuredClone(current.spec);
    invalid.title.max_chars = 0;
    const invalidResponse = await fetch(f.base + "/admin/api/knowledge-submission-spec", {
      method: "PUT",
      headers,
      body: JSON.stringify(invalid),
    });
    assert.equal(invalidResponse.status, 400);
    assert.match(((await invalidResponse.json()) as any).error, /Invalid knowledge submission spec/);

    const changed = structuredClone(current.spec);
    changed.title.max_chars = 120;
    changed.title.recommended_max_chars = 80;
    const savedResponse = await fetch(f.base + "/admin/api/knowledge-submission-spec", {
      method: "PUT",
      headers,
      body: JSON.stringify(changed),
    });
    assert.equal(savedResponse.status, 200);
    const saved = (await savedResponse.json()) as any;
    assert.equal(saved.spec.spec_version, 2);
    assert.equal(saved.spec.title.max_chars, 120);
    assert.equal((await f.service.getKnowledgeSubmissionSpec()).spec_version, 2);

    const historyResponse = await fetch(f.base + "/admin/api/knowledge-submission-spec/history", { headers });
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()) as any;
    assert.deepEqual(
      history.specs.map((item: any) => item.spec_version),
      [2, 1],
    );

    const rollbackResponse = await fetch(f.base + "/admin/api/knowledge-submission-spec/rollback", {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollbackResponse.status, 200);
    const rolled = (await rollbackResponse.json()) as any;
    assert.equal(rolled.spec.spec_version, 3);
    assert.equal(rolled.spec.title.max_chars, 160);
    assert.equal((await f.service.getKnowledgeSubmissionSpec()).spec_version, 3);

    const candidateContent = [
      "# Admin edit validation",
      "",
      "## 问题",
      "Admin edits must preserve the current Knowledge contract.",
      "",
      "## 根因",
      "Unvalidated edits could bypass the server specification.",
      "",
      "## 解决方案",
      "Validate Knowledge content on every Admin save.",
      "",
      "## 验证结果",
      "This API test exercises the edit path.",
      "",
      "## 适用范围",
      "Admin Candidate editing.",
      "",
      "## 约束/限制",
      "Skill Candidates remain on their separate compatibility path.",
    ].join("\n");
    const createdResponse = await fetch(f.base + "/admin/api/knowledge-candidates", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Admin edit validation", content: candidateContent, suggestedType: "knowledge" }),
    });
    assert.equal(createdResponse.status, 201);
    const rejectedSkillResponse = await fetch(f.base + "/admin/api/knowledge-candidates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Legacy skill candidate",
        content: "---\nschema_version: 1\nname: legacy-skill\nmetadata:\n---\n",
        suggestedType: "skill",
      }),
    });
    assert.equal(rejectedSkillResponse.status, 400);
    assert.match(((await rejectedSkillResponse.json()) as any).error, /Skills must use Skill Bundle/);
    const created = (await createdResponse.json()) as any;
    const invalidEdit = await fetch(
      f.base + "/admin/api/knowledge-candidates/" + encodeURIComponent(created.candidate.id),
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ title: "Curated OTA recovery", content: "Concise verified recovery guidance." }),
      },
    );
    assert.equal(invalidEdit.status, 400);
    assert.match(((await invalidEdit.json()) as any).error, /current submission spec/);
    const unchangedResponse = await fetch(
      f.base + "/admin/api/knowledge-candidates/" + encodeURIComponent(created.candidate.id),
      { headers },
    );
    assert.equal(unchangedResponse.status, 200);
    const unchanged = (await unchangedResponse.json()) as any;
    assert.equal(unchanged.candidate.content, candidateContent);
    assert.equal(unchanged.candidate.title, "Admin edit validation");

    const legacy = await (f.service as any).observability.createCandidate(
      { id: "legacy-user", tenantId: "default", roles: ["developer", "internal"] },
      {
        title: "Legacy candidate",
        content: "legacy unstructured content",
        sourceType: "review",
        suggestedType: "knowledge",
      },
    );
    const legacyRead = await (f.service as any).observability.getCandidate(legacy.id);
    assert.equal(legacyRead?.content, "legacy unstructured content");
    assert.equal(legacyRead?.submissionSpecVersion, undefined);
    assert.equal(legacyRead?.validationSpecVersion, undefined);
    assert.equal(legacyRead?.submissionMode, undefined);

    const page = await fetch(f.base + "/admin/knowledge-submission-spec", { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Knowledge 回流规范/);
    assert.match(html, /保存为新版本/);
    assert.match(html, /回滚/);
  } finally {
    await f.app.close();
    f.search.close();
    await rm(f.dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});
