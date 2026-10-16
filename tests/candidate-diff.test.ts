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
import type { AppConfig, Principal, RepositoryConfig } from "../src/types.js";

const principal: Principal = { id: "diff-author", tenantId: "rd", roles: ["developer", "internal"] };

function repository(): RepositoryConfig {
  return {
    id: "rd-knowledges",
    name: "R&D Knowledges",
    provider: "git",
    gitUrl: "https://github.com/acme/rd-knowledges.git",
    branch: "main",
    gitAuth: { type: "none" },
    webhookAliases: [],
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 0,
    readRoles: ["developer", "internal"],
    syncRoles: ["admin"],
    knowledgePublishing: {
      enabled: true,
      provider: "github",
      baseUrl: "https://github.com",
      projectPath: "acme/rd-knowledges",
      tokenEnv: "TEST_CANDIDATE_DIFF_GITHUB_TOKEN",
      targetBranch: "main",
      branchPrefix: "skill-hub-knowledge",
    },
  };
}

async function fixture(fetchImpl: typeof fetch) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-diff-"));
  const search = new SqliteFtsSearchBackend();
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: [repository()],
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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  process.env.TEST_CANDIDATE_DIFF_GITHUB_TOKEN = "github-token";
  return {
    service,
    async close() {
      globalThis.fetch = previousFetch;
      delete process.env.TEST_CANDIDATE_DIFF_GITHUB_TOKEN;
      search.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function createCandidate(service: SkillHubApplicationService, overrides: Record<string, unknown> = {}) {
  return await (service as any).observability.createCandidate(principal, {
    title: "Example note",
    content: "alpha\nbeta\ngamma",
    sourceType: "manual",
    suggestedType: "knowledge",
    repository: "rd-knowledges",
    suggestedPath: "knowledge/example.md",
    ...overrides,
  });
}

test("pending Candidate diff reports create without mutating Candidate state", async () => {
  const ctx = await fixture(async () => new Response(null, { status: 404 }));
  try {
    const candidate = await createCandidate(ctx.service);
    const before = await ctx.service.getKnowledgeCandidate(candidate.id);
    const historyBefore = await ctx.service.getKnowledgeCandidateHistory(candidate.id);

    const result = await ctx.service.getKnowledgeCandidateDiff(candidate.id);

    assert.equal(result.target.operation, "create");
    assert.equal(result.target.repositoryId, "rd-knowledges");
    assert.equal(result.target.targetBranch, "main");
    assert.equal(result.target.path, "knowledge/example.md");
    assert.ok(result.summary.addedLines > 0);
    assert.equal(result.summary.removedLines, 0);
    assert.ok(result.hunks.length > 0);
    assert.equal((await ctx.service.getKnowledgeCandidate(candidate.id))?.updatedAt, before?.updatedAt);
    assert.deepEqual(await ctx.service.getKnowledgeCandidateHistory(candidate.id), historyBefore);
  } finally {
    await ctx.close();
  }
});

test("Candidate diff normalizes CRLF and reports no_change for equal content", async () => {
  const desired = "# Example note\r\n\r\nalpha\r\nbeta\r\ngamma\r\n";
  const ctx = await fixture(
    async () =>
      new Response(
        JSON.stringify({ content: Buffer.from(desired).toString("base64"), encoding: "base64", type: "file" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  try {
    const candidate = await createCandidate(ctx.service);
    const result = await ctx.service.getKnowledgeCandidateDiff(candidate.id);
    assert.equal(result.target.operation, "no_change");
    assert.deepEqual(result.summary, { addedLines: 0, removedLines: 0 });
    assert.deepEqual(result.hunks, []);
  } finally {
    await ctx.close();
  }
});

test("Candidate diff preserves Unicode and multiple separated update hunks", async () => {
  const baseline = [
    "# Example note",
    "",
    "旧内容",
    "same-1",
    "same-2",
    "same-3",
    "same-4",
    "same-5",
    "same-6",
    "same-7",
    "same-8",
    "旧结尾",
    "",
  ].join("\n");
  const ctx = await fixture(
    async () =>
      new Response(
        JSON.stringify({ content: Buffer.from(baseline).toString("base64"), encoding: "base64", type: "file" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );
  try {
    const candidate = await createCandidate(ctx.service, {
      content: [
        "新内容",
        "same-1",
        "same-2",
        "same-3",
        "same-4",
        "same-5",
        "same-6",
        "same-7",
        "same-8",
        "新结尾",
      ].join("\n"),
    });
    const result = await ctx.service.getKnowledgeCandidateDiff(candidate.id);
    assert.equal(result.target.operation, "update");
    assert.ok(result.summary.addedLines >= 2);
    assert.ok(result.summary.removedLines >= 2);
    assert.ok(result.hunks.length >= 2);
    assert.ok(result.hunks.flatMap((hunk) => hunk.lines).some((line) => line.text.includes("新内容")));
  } finally {
    await ctx.close();
  }
});

test("Candidate diff uses updates relation repository and path when explicit target fields are absent", async () => {
  const ctx = await fixture(async () => new Response(null, { status: 404 }));
  try {
    const candidate = await createCandidate(ctx.service, {
      repository: undefined,
      suggestedPath: undefined,
      knowledgeRelation: {
        type: "updates",
        target: {
          key: "knowledge:existing",
          repositoryId: "rd-knowledges",
          path: "knowledge/existing.md",
          title: "Existing",
        },
      },
    });
    const result = await ctx.service.getKnowledgeCandidateDiff(candidate.id);
    assert.equal(result.target.repositoryId, "rd-knowledges");
    assert.equal(result.target.path, "knowledge/existing.md");
  } finally {
    await ctx.close();
  }
});

test("Candidate diff is pending-only", async () => {
  const ctx = await fixture(async () => new Response(null, { status: 404 }));
  try {
    const candidate = await createCandidate(ctx.service);
    await ctx.service.reviewKnowledgeCandidate(candidate.id, "approved", "reviewer", undefined, "useful");
    await assert.rejects(
      () => ctx.service.getKnowledgeCandidateDiff(candidate.id),
      /Knowledge candidate must be pending to preview diff/,
    );
  } finally {
    await ctx.close();
  }
});
