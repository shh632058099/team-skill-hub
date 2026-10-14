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

const principal: Principal = { id: "routing-user", tenantId: "rd", roles: ["developer", "internal"] };

function repository(id: string, webhookAliases: string[] = []): RepositoryConfig {
  return {
    id,
    name: id,
    provider: "git",
    gitUrl: `git@github.com:acme/${id}.git`,
    branch: "main",
    gitAuth: { type: "none" },
    webhookAliases,
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 0,
    readRoles: ["developer", "internal"],
    syncRoles: ["admin"]
  };
}

async function createService(dataDir: string) {
  const routing = repository("routing-policy", ["acme/routing-policy"]);
  routing.knowledgePublishing = {
    enabled: true,
    provider: "github",
    baseUrl: "https://github.com",
    projectPath: "acme/knowledge-destination",
    tokenEnv: "TEST_GITHUB_TOKEN",
    targetBranch: "main",
    branchPrefix: "knowledge-candidate"
  };
  routing.skillPublishing = {
    enabled: true,
    provider: "github",
    baseUrl: "https://github.com",
    projectPath: "acme/skill-destination",
    tokenEnv: "TEST_GITHUB_TOKEN",
    targetBranch: "main",
    branchPrefix: "skill-candidate"
  };
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: [
      routing,
      repository("knowledge-destination", ["acme/knowledge-destination"]),
      repository("skill-destination", ["acme/skill-destination"])
    ]
  };
  const search = new SqliteFtsSearchBackend();
  return new SkillHubApplicationService(
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
}

async function createGitLabService(dataDir: string) {
  const routing = repository("gitlab-routing", ["acme/gitlab-routing"]);
  routing.knowledgePublishing = {
    enabled: true,
    provider: "gitlab",
    baseUrl: "https://gitlab.example.com",
    projectPath: "acme/knowledge-destination",
    tokenEnv: "TEST_GITLAB_WRITE_TOKEN",
    targetBranch: "main",
    branchPrefix: "knowledge-candidate"
  };
  const target = repository("knowledge-destination", ["acme/knowledge-destination"]);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: [routing, target]
  };
  const search = new SqliteFtsSearchBackend();
  return new SkillHubApplicationService(
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
}

test("candidate repository defaults come from publishing project_path and reject cross-type targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-routing-"));
  try {
    const service = await createService(root);
    const knowledge = await service.submitKnowledgeCandidate(principal, {
      title: "Knowledge routing",
      content: "Verified reusable routing behavior.",
      sourceType: "review",
      suggestedType: "knowledge"
    });
    assert.equal(knowledge.repository, "knowledge-destination");

    const skill = await service.submitKnowledgeCandidate(principal, {
      title: "Skill routing",
      content: "---\nschema_version: 1\nname: routing-skill\nmetadata:\n  audience: [developer]\n---\n\n# Routing skill\n",
      sourceType: "review",
      suggestedType: "skill"
    });
    assert.equal(skill.repository, "skill-destination");

    await assert.rejects(
      () => service.submitKnowledgeCandidate(principal, {
        title: "Wrong Knowledge target",
        content: "Must not route to a Skill repository.",
        sourceType: "review",
        suggestedType: "knowledge",
        repository: "skill-destination"
      }),
      /not a configured Knowledge publishing target/
    );
    await assert.rejects(
      () => service.submitKnowledgeCandidate(principal, {
        title: "Wrong Skill target",
        content: "---\nschema_version: 1\nname: wrong-skill\nmetadata:\n  audience: [developer]\n---\n\n# Wrong target\n",
        sourceType: "review",
        suggestedType: "skill",
        repository: "knowledge-destination"
      }),
      /not a configured Skill publishing target/
    );
    const bypassed = await (service as any).observability.createCandidate(principal, {
      title: "Persisted wrong route",
      content: "Legacy or internal data must still be checked at publish time.",
      sourceType: "review",
      suggestedType: "knowledge",
      repository: "skill-destination"
    });
    await (service as any).observability.reviewCandidate(bypassed.id, "approved", "reviewer", "verified", "useful");
    await assert.rejects(
      () => service.publishKnowledgeCandidate(bypassed.id),
      /not a configured Knowledge publishing target/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delete published candidate corrects legacy false-published state before creating a deletion PR", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-delete-correction-"));
  const originalFetch = globalThis.fetch;
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (/\/pulls\/41$/.test(url)) {
      return new Response(JSON.stringify({ state: "open", merged_at: null, closed_at: null, mergeable: true, mergeable_state: "clean" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (/\/git\/ref\/heads\//.test(url)) return new Response("{}", { status: 200 });
    throw new Error("unexpected request: " + (init?.method ?? "GET") + " " + url);
  };
  try {
    const service = await createService(root);
    const created = await (service as any).observability.createCandidate(principal, {
      title: "Legacy false published",
      content: "This candidate was incorrectly marked published by the old lifecycle bug.",
      sourceType: "review",
      suggestedType: "knowledge",
      repository: "knowledge-destination",
      suggestedPath: "knowledge/legacy-false-published.md"
    });
    await (service as any).observability.reviewCandidate(created.id, "approved", "reviewer", "verified", "useful");
    await (service as any).observability.markCandidatePublishing(created.id);
    await (service as any).observability.markCandidatePublished(created.id, {
      provider: "github",
      projectPath: "acme/knowledge-destination",
      branch: "knowledge-candidate-legacy",
      targetBranch: "main",
      filePath: "knowledge/legacy-false-published.md",
      action: "create",
      mergeRequestIid: 41,
      mergeRequestUrl: "https://github.com/acme/knowledge-destination/pull/41",
      publishedAt: "2026-10-10T00:00:00.000Z",
      mergeRequestState: "merged",
      lastCheckedAt: "2026-10-10T00:00:00.000Z",
      mergedAt: "2026-10-10T00:00:00.000Z"
    });

    const corrected = await service.deletePublishedKnowledgeCandidate(created.id);
    assert.equal(corrected.status, "publishing");
    assert.equal(corrected.publication?.mergeRequestState, "opened");
    assert.equal((corrected as any).deletionPublication, undefined);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "GET"]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_GITHUB_TOKEN;
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile corrects a legacy published candidate whose remote PR is still open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-reconcile-correction-"));
  const originalFetch = globalThis.fetch;
  process.env.TEST_GITHUB_TOKEN = "github-token";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (/\/pulls\/42$/.test(url)) {
      return new Response(JSON.stringify({ state: "open", merged_at: null, closed_at: null, mergeable: true, mergeable_state: "clean" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (/\/git\/ref\/heads\//.test(url)) return new Response("{}", { status: 200 });
    throw new Error("unexpected request: " + url);
  };
  try {
    const service = await createService(root);
    const created = await (service as any).observability.createCandidate(principal, {
      title: "Legacy published reconcile",
      content: "Old lifecycle data should be repaired by reconcile.",
      sourceType: "review",
      suggestedType: "knowledge",
      repository: "knowledge-destination",
      suggestedPath: "knowledge/legacy-reconcile.md"
    });
    await (service as any).observability.reviewCandidate(created.id, "approved", "reviewer", "verified", "useful");
    await (service as any).observability.markCandidatePublishing(created.id);
    await (service as any).observability.markCandidatePublished(created.id, {
      provider: "github",
      projectPath: "acme/knowledge-destination",
      branch: "knowledge-candidate-reconcile",
      targetBranch: "main",
      filePath: "knowledge/legacy-reconcile.md",
      action: "create",
      mergeRequestIid: 42,
      mergeRequestUrl: "https://github.com/acme/knowledge-destination/pull/42",
      publishedAt: "2026-10-10T00:00:00.000Z",
      mergeRequestState: "merged",
      lastCheckedAt: "2026-10-10T00:00:00.000Z",
      mergedAt: "2026-10-10T00:00:00.000Z"
    });

    const corrected = await service.reconcileKnowledgeCandidatePublication(created.id);
    assert.equal(corrected.status, "publishing");
    assert.equal(corrected.publication?.mergeRequestState, "opened");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_GITHUB_TOKEN;
    await rm(root, { recursive: true, force: true });
  }
});

test("delete_failed published asset can retry deletion after original publication is verified merged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-delete-retry-"));
  const originalFetch = globalThis.fetch;
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const responses = [
    new Response(JSON.stringify({ state: "merged", merged_at: "2026-10-10T00:00:00.000Z", merge_commit_sha: "merge-1" }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response("", { status: 404 }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 200 }),
    new Response(JSON.stringify({ file_path: "knowledge/delete-retry.md" }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ id: "delete-commit" }), { status: 200, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ iid: 52, web_url: "https://gitlab.example.com/acme/knowledge-destination/-/merge_requests/52", state: "opened" }), { status: 201, headers: { "content-type": "application/json" } })
  ];
  globalThis.fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected GitLab request");
    return response;
  };
  try {
    const service = await createGitLabService(root);
    const created = await (service as any).observability.createCandidate(principal, {
      title: "Deletion retry",
      content: "Retry a previously failed deletion.",
      sourceType: "review",
      suggestedType: "knowledge",
      repository: "knowledge-destination",
      suggestedPath: "knowledge/delete-retry.md"
    });
    await (service as any).observability.reviewCandidate(created.id, "approved", "reviewer", "verified", "useful");
    await (service as any).observability.markCandidatePublishing(created.id);
    await (service as any).observability.markCandidatePublished(created.id, {
      provider: "gitlab", projectPath: "acme/knowledge-destination", branch: "knowledge-candidate-original",
      targetBranch: "main", filePath: "knowledge/delete-retry.md", action: "create", mergeRequestIid: 51,
      mergeRequestUrl: "https://gitlab.example.com/acme/knowledge-destination/-/merge_requests/51",
      publishedAt: "2026-10-10T00:00:00.000Z", mergeRequestState: "merged", lastCheckedAt: "2026-10-10T00:00:00.000Z",
      mergedAt: "2026-10-10T00:00:00.000Z"
    });
    await (service as any).observability.markCandidateDeleting(created.id);
    await (service as any).observability.markCandidateDeleteFailed(created.id, "temporary failure");

    const retried = await service.deletePublishedKnowledgeCandidate(created.id);
    assert.equal(retried.status, "deleting");
    assert.equal(retried.deletionPublication?.action, "delete");
    assert.equal(retried.deletionPublication?.mergeRequestIid, 52);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
    await rm(root, { recursive: true, force: true });
  }
});
