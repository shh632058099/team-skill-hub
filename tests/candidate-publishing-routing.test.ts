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
