import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { KnowledgeSubmissionSpecStore, defaultKnowledgeSubmissionSpec } from "../src/knowledge-submission-spec.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import { startServer } from "../src/server.js";
import type { AppConfig } from "../src/types.js";

function summary(problem = "Verified problem") {
  return [
    "# Dynamic spec candidate",
    "",
    "## 问题",
    problem,
    "",
    "## 根因",
    "Verified root cause",
    "",
    "## 解决方案",
    "Verified solution",
    "",
    "## 验证结果",
    "Regression tests passed",
    "",
    "## 适用范围",
    "Team Skill Hub",
    "",
    "## 约束/限制",
    "No known extra constraints",
  ].join("\n");
}

async function fixture(prefix: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), prefix));
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
  return { dataDir, search, service, app, url: `http://127.0.0.1:${address.port}/mcp` };
}

async function call(url: string, id: number, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-client": "codex",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return await response.text();
}

test("MCP exposes current knowledge submission spec and accepts 50k contract submissions with metadata", async () => {
  const f = await fixture("skill-hub-knowledge-spec-mcp-");
  try {
    const specText = await call(f.url, 1, "get_knowledge_submission_spec", {});
    assert.match(specText, /"spec_version"\s*:\s*1/);
    assert.match(specText, /"max_chars"\s*:\s*50000/);
    assert.match(specText, /## 问题/);
    assert.match(specText, /content_mode=verbatim/);

    const large = summary("A".repeat(12_000));
    const submitText = await call(f.url, 2, "submit_knowledge_candidate", {
      spec_version: 1,
      title: "ignored",
      content: large,
      submission_mode: null,
    });
    assert.match(submitText, /"candidate"/);
    const candidates = await f.service.listKnowledgeCandidates(10);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.content.length > 10_000, true);
    assert.equal(candidates[0]!.submissionSpecVersion, 1);
    assert.equal(candidates[0]!.submissionSpecSchemaVersion, 1);
    assert.equal(candidates[0]!.submissionMode, "mcp");
    assert.equal(candidates[0]!.bundleSubmissionMode, "merge");
  } finally {
    await f.app.close();
    f.search.close();
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test("MCP verbatim content mode preserves arbitrary original markdown and records the mode", async () => {
  const f = await fixture("skill-hub-knowledge-verbatim-mcp-");
  try {
    const original = [
      "# 原始文档",
      "",
      "无需转换为六段式。",
      "",
      "## 任意二级标题",
      "正文 A",
      "",
      "### 任意三级标题",
      "正文 B",
      "",
      "~~~text",
      "literal content",
      "~~~",
    ].join("\n");

    const submitText = await call(f.url, 20, "submit_knowledge_candidate", {
      spec_version: 1,
      title: "原始文档",
      content: original,
      content_mode: "verbatim",
    });
    assert.match(submitText, /"candidate"/);

    const candidates = await f.service.listKnowledgeCandidates(10);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.title, "原始文档");
    assert.equal(candidates[0]!.content, original);
    assert.equal(candidates[0]!.contentMode, "verbatim");
  } finally {
    await f.app.close();
    f.search.close();
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test("verbatim candidate edits preserve body semantics instead of re-normalizing as structured content", async () => {
  const f = await fixture("skill-hub-knowledge-verbatim-edit-");
  try {
    const original = ["# 原始正文标题", "", "## 自定义章节", "正文 A"].join("\n");
    await call(f.url, 30, "submit_knowledge_candidate", {
      spec_version: 1,
      title: "候选元数据标题",
      content: original,
      content_mode: "verbatim",
    });
    const [created] = await f.service.listKnowledgeCandidates(10);
    assert.ok(created);

    const renamed = await f.service.updateKnowledgeCandidate(created.id, { title: "新的元数据标题" });
    assert.equal(renamed.title, "新的元数据标题");
    assert.equal(renamed.content, original);
    assert.equal(renamed.contentMode, "verbatim");

    const revisedBody = ["# 完全不同的原文标题", "", "### 任意三级标题", "正文 B"].join("\n");
    const revised = await f.service.updateKnowledgeCandidate(created.id, { content: revisedBody });
    assert.equal(revised.content, revisedBody);
    assert.equal(revised.contentMode, "verbatim");
  } finally {
    await f.app.close();
    f.search.close();
    await rm(f.dataDir, { recursive: true, force: true });
  }
});

test("MCP stale incompatible submissions return KNOWLEDGE_SPEC_OUTDATED", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-spec-stale-"));
  try {
    const store = new KnowledgeSubmissionSpecStore(dataDir);
    const base = defaultKnowledgeSubmissionSpec();
    await store.saveNext({ ...base, content: { ...base.content, max_chars: 500 } });
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
    try {
      const address = app.server.address();
      assert.ok(address && typeof address !== "string");
      const text = await call(`http://127.0.0.1:${address.port}/mcp`, 3, "submit_knowledge_candidate", {
        spec_version: 1,
        title: "ignored",
        content: summary("A".repeat(700)),
      });
      assert.match(text, /KNOWLEDGE_SPEC_OUTDATED/);
      assert.match(text, /get_knowledge_submission_spec/);
    } finally {
      await app.close();
      search.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
