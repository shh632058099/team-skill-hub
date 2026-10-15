import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import {
  RequiredFieldsRule,
  RepositoryVisibilityRule,
  UniqueNameRule,
  scanSkills,
  validateSkills
} from "../src/skills.js";
import { LocalRepositoryProvider } from "../src/repository.js";
import {
  ApiKeyAuthenticationProvider,
  DevelopmentAuthenticationProvider,
  StaticRolePermissionProvider
} from "../src/security.js";
import { LoggingEventSink } from "../src/events.js";
import { SkillHubApplicationService } from "../src/application.js";
import type { RepositoryConfig } from "../src/types.js";

const repo: RepositoryConfig = {
  id: "rd-skills",
  name: "R&D Skills",
  provider: "local",
  gitAuth: { type: "none" },
  webhookAliases: [],
  path: ".",
  enabled: true,
  audience: ["developer"],
  visibility: ["internal"],
  pollingIntervalSeconds: 300,
  readRoles: ["developer", "internal"],
  syncRoles: ["developer", "admin"]
};

async function makeSkillRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-"));
  const skillDir = path.join(root, "ota", "review");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
schema_version: 1
name: ota-code-review
version: 1.0.0
description: Review OTA APIs and call chains.
metadata:
  audience: [developer]
  domain: [ota]
  category: [code-review]
  keywords: [ota, api, call-chain, 接口, 调用链]
  visibility: [internal]
  maturity: stable
  owner: ota-team
  priority: 90
  depends_on: []
  compatibility:
    codex: true
    customer_agent: false
---
# OTA review
`
  );
  await writeFile(path.join(skillDir, "references", "checklist.md"), "API necessity\n");
  return root;
}

async function makeCustomerSkillRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "customer-skill-hub-"));
  const skillDir = path.join(root, "ota", "deployment");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
schema_version: 1
name: ota-customer-troubleshooting
version: 1.0.0
description: Customer OTA troubleshooting.
metadata:
  audience: [customer]
  domain: [ota]
  category: [troubleshooting]
  keywords: [ota, troubleshooting]
  visibility: [customer]
  maturity: stable
  owner: customer-success
  priority: 80
  depends_on: []
  compatibility:
    codex: true
    customer_agent: true
---
# Customer troubleshooting
`
  );
  return root;
}

async function makeKnowledgeOnlyRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-only-skill-hub-"));
  const docsDir = path.join(root, "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    path.join(docsDir, "knowledge.md"),
    "# Knowledge only\n\nRepository contains Knowledge but no Skill manifests.\n"
  );
  return root;
}

async function addPromptAndAgent(root: string) {
  const promptDir = path.join(root, "ota", "review");
  await writeFile(
    path.join(promptDir, "PROMPT.md"),
    `---
schema_version: 1
name: ota-code-review-prompt
version: 1.0.0
description: Reusable OTA code review prompt.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [ota, review, api]
  category: [code-review]
  owner: ota-team
  compatibility:
    codex: true
---
# Prompt
Review OTA APIs and call chains.
`
  );
  await writeFile(
    path.join(root, "ota", "AGENT.yaml"),
    `schema_version: 1
name: ota-expert
version: 1.0.0
description: Internal OTA expert.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [ota, review, debugging]
  owner: ota-team
  compatibility:
    codex: true
skills:
  - ota-code-review
prompts:
  - ota-code-review-prompt
tools:
  - git
`
  );
  await writeFile(
    path.join(root, "ota", "TOOL.yaml"),
    `schema_version: 1
name: git
version: 1.0.0
description: Git source control operations for repository workflows.
type: cli
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [git, source-control, repository]
  owner: platform-team
  compatibility:
    codex: true
environments: [development, ci]
capabilities: [status, diff, commit]
authentication:
  type: environment
  reference: GIT_CREDENTIAL_HELPER
`
  );
}

test("scan, validate and search an OTA skill", async () => {
  const root = await makeSkillRoot();
  const skills = await scanSkills(root, "rd-skills", "test-revision");
  assert.equal(skills.length, 1);
  const issues = validateSkills(skills, repo, [
    new RequiredFieldsRule(),
    new UniqueNameRule(),
    new RepositoryVisibilityRule()
  ]);
  assert.deepEqual(issues, []);

  const search = new SqliteFtsSearchBackend();
  search.rebuild(skills);
  const results = search.search("OTA API 调用链", { repositories: ["rd-skills"] }, 5);
  assert.equal(results[0]?.skill.name, "ota-code-review");
  const incompatible = search.search(
    "OTA API 调用链",
    { repositories: ["rd-skills"], client: "customer_agent" },
    5
  );
  assert.equal(incompatible.length, 0);
  search.close();
});

test("skill FTS candidate query filters repositories before applying its limit", async () => {
  const root = await makeSkillRoot();
  const [template] = await scanSkills(root, "rd-skills", "test-revision");
  assert.ok(template);
  const denied = Array.from({ length: 80 }, (_, index) => ({
    ...template,
    key: `private:checkpoint-${index}`,
    repositoryId: "private",
    name: `checkpoint-${index}`,
    description: "checkpoint checkpoint checkpoint checkpoint",
    metadata: {
      ...template.metadata,
      keywords: ["checkpoint", "checkpoint", "checkpoint"],
      priority: 100
    }
  }));
  const allowed = {
    ...template,
    key: "rd-skills:allowed-checkpoint",
    repositoryId: "rd-skills",
    name: "allowed-checkpoint",
    description: "checkpoint",
    metadata: {
      ...template.metadata,
      keywords: [],
      priority: 1
    }
  };

  const search = new SqliteFtsSearchBackend();
  try {
    search.rebuild([...denied, allowed]);
    const results = search.search("checkpoint", { repositories: ["rd-skills"] }, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.skill.key, allowed.key);
    assert.ok((results[0]?.score ?? 0) > 5, "allowed result should include candidate-stage FTS score");
    assert.deepEqual(search.search("checkpoint", { repositories: [] }, 5), []);
  } finally {
    search.close();
  }
});


test("registry replaces one repository atomically", async () => {
  const root = await makeSkillRoot();
  const skills = await scanSkills(root, "rd-skills", "r1");
  const registry = new MemoryRegistryStore();
  registry.replaceRepository("rd-skills", skills);
  assert.equal(registry.get("rd-skills", "ota-code-review")?.revision, "r1");
  registry.replaceRepository("rd-skills", [{ ...skills[0]!, revision: "r2" }]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("rd-skills", "ota-code-review")?.revision, "r2");
});

test("knowledge-only repository becomes ready after successful startup sync", async () => {
  const root = await makeKnowledgeOnlyRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-ready-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  const state = service.listRepositoryStates()[0];
  assert.equal(state?.status, "healthy");
  assert.equal(state?.skillCount, 0);
  assert.equal(state?.knowledgeDocumentCount, 1);
  assert.equal(service.isReady(), true);
  search.close();
});

test("invalid repository update preserves last known good skill", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-data-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const registry = new MemoryRegistryStore();
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    registry,
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  const before = service.getSkill("rd-skills", "ota-code-review");

  await writeFile(
    path.join(root, "ota", "review", "SKILL.md"),
    "---\nschema_version: 1\nname: broken\n---\n# broken\n"
  );

  await assert.rejects(() => service.syncRepository("rd-skills"), /Validation failed/);
  const after = service.getSkill("rd-skills", "ota-code-review");
  assert.equal(after.revision, before.revision);
  assert.equal(after.content, before.content);
  search.close();
});

test("repository access policy separates read and sync roles", () => {
  const permissions = new StaticRolePermissionProvider();
  const customer = { id: "customer", roles: ["customer"], tenantId: "default" };
  const developer = { id: "developer", roles: ["developer"], tenantId: "default" };
  const customerRepo: RepositoryConfig = {
    ...repo,
    id: "customer-skills",
    visibility: ["customer"],
    readRoles: ["customer"],
    syncRoles: ["admin"]
  };

  assert.equal(permissions.allowedRepositories(customer, [customerRepo]).length, 1);
  assert.equal(permissions.allowedRepositories(developer, [customerRepo]).length, 0);
  assert.equal(permissions.canSyncRepository(customer, customerRepo), false);
});

test("GitLab webhook references resolve configured repositories", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-webhook-"));
  const repository: RepositoryConfig = {
    ...repo,
    path: root,
    gitUrl: "git@gitlab.company.example:ai/rd-skills.git",
    webhookAliases: ["engineering/ota-skills"]
  };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  assert.equal(service.resolveRepositoryWebhookReference(["ai/rd-skills"]), "rd-skills");
  assert.equal(service.resolveRepositoryWebhookReference(["engineering/ota-skills"]), "rd-skills");
  assert.equal(service.resolveRepositoryWebhookReference(["rd-skills"]), "rd-skills");
  assert.equal(service.resolveRepositoryWebhookReference(["unknown/repo"]), undefined);
  search.close();
});

test("sync writes audit history", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-audit-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const registry = new MemoryRegistryStore();
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    registry,
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  const audit = await service.listAuditEvents(10, "rd-skills");
  assert.equal(audit[0]?.action, "repository.sync.completed");
  assert.equal(audit[0]?.trigger, "startup");
  assert.equal(audit.some((event) => event.action === "repository.sync.started"), true);
  search.close();
});

test("repository view hides source and policy configuration", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-view-"));
  const repository = {
    ...repo,
    path: root,
    gitUrl: "https://example.invalid/private.git",
    pollingIntervalSeconds: 0
  };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  const view = service.listRepositories()[0] as unknown as Record<string, unknown>;
  assert.equal(view.id, "rd-skills");
  assert.equal("path" in view, false);
  assert.equal("gitUrl" in view, false);
  assert.equal("readRoles" in view, false);
  assert.equal("syncRoles" in view, false);
  search.close();
});

test("concurrent sync requests share one in-flight repository sync", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-lock-"));
  await mkdir(path.join(dataDir, "state"), { recursive: true });
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  let materializeCalls = 0;
  const provider = {
    type: "local" as const,
    async materialize() {
      materializeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { config: repository, sourceRoot: root, revision: "shared-revision" };
    }
  };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [provider],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await Promise.all([
    service.syncRepository("rd-skills", "manual"),
    service.syncRepository("rd-skills", "webhook"),
    service.syncRepository("rd-skills", "poll")
  ]);
  assert.equal(materializeCalls, 1);
  const audit = await service.listAuditEvents(10, "rd-skills");
  assert.equal(audit.filter((event) => event.action === "repository.sync.started").length, 1);
  assert.equal(audit.filter((event) => event.action === "repository.sync.completed").length, 1);
  search.close();
});

test("api-key principals isolate developer and customer repositories", async () => {
  const rdRoot = await makeSkillRoot();
  const customerRoot = await makeCustomerSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-auth-"));
  const rdRepo = { ...repo, path: rdRoot, pollingIntervalSeconds: 0 };
  const customerRepo: RepositoryConfig = {
    ...repo,
    id: "customer-skills",
    name: "Customer Skills",
    path: customerRoot,
    audience: ["customer"],
    visibility: ["customer"],
    readRoles: ["customer"],
    syncRoles: ["admin"],
    pollingIntervalSeconds: 0
  };
  const auth = new ApiKeyAuthenticationProvider({
    devkey: { id: "dev-a", roles: ["developer", "internal"], tenantId: "rd" },
    customerkey: { id: "customer-a", roles: ["customer"], tenantId: "customer-a" }
  });
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: [],
      authentication: { mode: "api-key", apiKeys: {} },
      repositories: [rdRepo, customerRepo]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    auth,
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );
  await service.initialize();

  const dev = service.authenticateRequest(new Headers({ "x-skill-hub-api-key": "devkey" }));
  const customer = service.authenticateRequest(new Headers({ "x-skill-hub-api-key": "customerkey" }));
  const bearerDev = service.authenticateRequest(new Headers({ authorization: "Bearer devkey" }));
  assert.equal(bearerDev.id, "dev-a");
  assert.deepEqual(service.listRepositories(dev).map((item) => item.id), ["rd-skills"]);
  assert.deepEqual(service.listRepositories(customer).map((item) => item.id), ["customer-skills"]);
  assert.throws(() => service.getSkill("customer-skills", "ota-customer-troubleshooting", dev), /Skill not found/);
  assert.equal(service.getSkill("customer-skills", "ota-customer-troubleshooting", customer).name, "ota-customer-troubleshooting");
  assert.throws(() => service.authenticateRequest(new Headers({ "x-skill-hub-api-key": "bad" })), /Invalid API key/);
  search.close();
});

test("api-key authentication rejects missing and invalid MCP credentials", () => {
  const auth = new ApiKeyAuthenticationProvider({
    valid: { id: "speed-test", roles: ["developer"], tenantId: "rd" }
  });
  assert.throws(() => auth.authenticate(new Headers()), /Authentication required/);
  assert.throws(
    () => auth.authenticate(new Headers({ "x-skill-hub-api-key": "invalid" })),
    /Invalid API key/
  );
  assert.equal(
    auth.authenticate(new Headers({ "x-skill-hub-api-key": "valid" })).id,
    "speed-test"
  );
});

test("validated revision history supports rollback", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-revision-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );
  await service.initialize();
  const first = (await service.listRepositoryRevisions("rd-skills"))[0]!.revision;
  const skillPath = path.join(root, "ota", "review", "SKILL.md");
  const original = service.getSkill("rd-skills", "ota-code-review").content;
  await writeFile(skillPath, original.replace("# OTA review", "# OTA review v2"));
  await service.syncRepository("rd-skills", "manual");
  assert.equal((await service.listRepositoryRevisions("rd-skills")).length, 2);
  await service.rollbackRepositoryRevision("rd-skills", first);
  assert.equal(service.getSkill("rd-skills", "ota-code-review").content, original);
  assert.equal(service.listRepositoryStates()[0]?.revision, first);
  search.close();
});

test("metrics expose sync search resolve and load counters", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-metrics-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );
  await service.initialize();
  service.searchSkills("OTA API");
  service.resolveSkill("OTA review");
  service.getSkill("rd-skills", "ota-code-review");
  const metrics = service.renderMetrics();
  assert.match(metrics, /repository_sync_total/);
  assert.match(metrics, /skill_search_total 1/);
  assert.match(metrics, /skill_resolve_total 1/);
  assert.match(metrics, /skill_load_total\{repository="rd-skills"\} 1/);
  search.close();
});

test("prompt and agent registries load, search and resolve repository artifacts", async () => {
  const root = await makeSkillRoot();
  await addPromptAndAgent(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "ota-review-context.md"), "# OTA Review Context\n\nReview OTA APIs, debugging, and recovery behavior.\n", "utf8");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-artifacts-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  assert.equal(service.listPrompts("codex").map((item) => item.name).includes("ota-code-review-prompt"), true);
  assert.equal(service.searchPrompts("OTA review", 5, "codex")[0]?.artifact.name, "ota-code-review-prompt");
  assert.equal(service.getPrompt("rd-skills", "ota-code-review-prompt").name, "ota-code-review-prompt");
  assert.equal(service.listAgents("codex").map((item) => item.name).includes("ota-expert"), true);
  assert.equal(service.resolveAgent("OTA debugging review", 3, "codex")[0]?.artifact.name, "ota-expert");
  assert.deepEqual(service.getAgent("rd-skills", "ota-expert").skills, ["ota-code-review"]);
  assert.equal(service.listTools("codex")[0]?.name, "git");
  assert.equal(service.searchTools("source control", 5, "codex")[0]?.artifact.name, "git");
  assert.deepEqual(service.getTool("rd-skills", "git").capabilities, ["status", "diff", "commit"]);
  const discovered = service.discover(
    "OTA review debugging recovery git repository",
    { topK: 5, repositories: ["rd-skills"], client: "codex" }
  );
  assert.equal(discovered.skills[0]?.skill.name, "ota-code-review");
  assert.equal(discovered.prompts[0]?.artifact.name, "ota-code-review-prompt");
  assert.equal(discovered.agents[0]?.artifact.name, "ota-expert");
  assert.equal(discovered.knowledge[0]?.chunk.relativePath, "docs/ota-review-context.md");
  assert.equal(discovered.tools[0]?.artifact.name, "git");
  assert.deepEqual(
    service.discover("OTA review", { repositories: ["not-visible"] }).skills,
    []
  );
  search.close();
});

test("discover normalizes cross-asset relevance and avoids substring false positives", async () => {
  const root = await makeSkillRoot();
  const clashDir = path.join(root, "networking", "clash-rules");
  await mkdir(clashDir, { recursive: true });
  await writeFile(
    path.join(clashDir, "SKILL.md"),
    `---
schema_version: 1
name: clash-rules
description: 维护和集成 Clash Verge Rev 的广告拦截、代理分流与规则集配置。
metadata:
  audience: [developer]
  domain: [networking, clash]
  category: [configuration, ruleset]
  keywords: [Clash Verge Rev, Clash, rule-providers, rule-set, proxy routing, 分流, 广告拦截]
  visibility: [internal]
  maturity: experimental
  owner: networking
  priority: 50
  depends_on: []
  compatibility:
    codex: true
---
# Clash Rules
`
  );
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "codex-custom-models.md"),
    "# Codex 与 Claude Code 自定义模型配置\n\nCodex model_catalog_json、自定义模型、模型 provider 和 model picker 配置说明。\n",
    "utf8"
  );
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-discover-ranking-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();

  const clash = service.discover("Clash Verge Rev 分流规则 配置 GEOIP GEOSITE 自定义规则", {
    topK: 5,
    repositories: ["rd-skills"],
    client: "codex"
  });
  assert.equal(clash.selected?.type, "skill");
  assert.equal(clash.selected && "name" in clash.selected ? clash.selected.name : undefined, "clash-rules");
  assert.equal(clash.ambiguous, false);
  assert.equal(clash.skills[0]?.skill.name, "clash-rules");
  assert.ok((clash.skills[0]?.confidence ?? 0) > 0.55);
  assert.equal(clash.skills.some((item) => item.skill.name === "ota-code-review"), false);
  assert.equal(clash.knowledge.some((item) => item.chunk.relativePath === "docs/codex-custom-models.md"), false);

  const codex = service.discover("Codex 自定义模型配置 config.toml model provider base_url API key", {
    topK: 5,
    repositories: ["rd-skills"],
    client: "codex"
  });
  assert.equal(codex.selected?.type, "knowledge");
  assert.equal(codex.selected && "path" in codex.selected ? codex.selected.path : undefined, "docs/codex-custom-models.md");
  assert.equal(codex.ambiguous, false);
  assert.equal(codex.knowledge[0]?.chunk.relativePath, "docs/codex-custom-models.md");
  assert.ok((codex.knowledge[0]?.confidence ?? 0) > 0.55);

  search.close();
});

test("discover matches Chinese workflow intent from skill metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-multilingual-discover-"));
  const definitions = [
    ["systematic-debugging", "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes", ["superpowers", "systematic-debugging", "debugging", "troubleshooting", "root-cause", "调试", "排查", "根因", "故障", "报错"]],
    ["test-driven-development", "Use when implementing any feature or bugfix, before writing implementation code", ["superpowers", "test-driven-development", "tdd", "testing", "test-first", "测试驱动", "先写测试", "单元测试"]],
    ["brainstorming", "Use before creative work to explore user intent, requirements and design before implementation", ["superpowers", "brainstorming", "requirements", "design", "需求分析", "方案设计", "头脑风暴"]],
    ["writing-plans", "Use when you have a spec or requirements for a multi-step task, before touching code", ["superpowers", "writing-plans", "implementation-plan", "planning", "实现计划", "实施计划"]]
  ] as const;
  for (const [name, description, keywords] of definitions) {
    const skillDir = path.join(root, "skills", "superpowers", name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nschema_version: 1\nname: ${name}\nversion: 1.0.0\ndescription: ${description}\nmetadata:\n  audience: [developer]\n  domain: [software-engineering]\n  category: [workflow]\n  keywords: [${keywords.join(", ")}]\n  visibility: [internal]\n  maturity: stable\n  owner: superpowers\n  priority: 50\n  depends_on: []\n  compatibility:\n    codex: true\n---\n# ${name}\n`,
      "utf8"
    );
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-multilingual-data-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  try {
    const cases = [
      ["这个功能先做需求分析和方案设计", "brainstorming"],
      ["这个报错先别急着修复，先排查根因", "systematic-debugging"],
      ["这个 bug 按测试驱动方式做，先写测试", "test-driven-development"],
      ["需求已经明确，给我写实现计划", "writing-plans"]
    ] as const;
    for (const [query, expected] of cases) {
      const result = service.discover(query, { topK: 5, repositories: ["rd-skills"], client: "codex" });
      assert.equal(result.skills[0]?.skill.name, expected, query);
      assert.ok((result.skills[0]?.coverage ?? 0) >= 0.2, `${query}: expected meaningful metadata coverage`);
    }
  } finally {
    search.close();
  }
});
test("missing local tool binding prevents repository activation", async () => {
  const root = await makeSkillRoot();
  await addPromptAndAgent(root);
  await writeFile(
    path.join(root, "ota", "AGENT.yaml"),
    `schema_version: 1
name: broken-tool-agent
description: Agent with missing local tool.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [tool]
  owner: ota-team
skills: [ota-code-review]
prompts: [ota-code-review-prompt]
tools: [missing-tool]
`
  );
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-tool-binding-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );
  await service.initialize();
  assert.equal(service.listRepositoryStates()[0]?.status, "error");
  assert.match(service.listRepositoryStates()[0]?.error ?? "", /missing tool missing-tool/);
  search.close();
});

test("invalid agent binding prevents repository activation", async () => {
  const root = await makeSkillRoot();
  await addPromptAndAgent(root);
  await writeFile(
    path.join(root, "ota", "AGENT.yaml"),
    `schema_version: 1
name: broken-agent
description: Invalid agent binding.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [broken]
  owner: ota-team
skills: [missing-skill]
prompts: []
tools: []
`
  );
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-agent-binding-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  assert.equal(service.listRepositoryStates()[0]?.status, "error");
  assert.match(service.listRepositoryStates()[0]?.error ?? "", /Artifact validation failed/);
  search.close();
});

test("invalid evaluation suite does not create a validated revision", async () => {
  const root = await makeSkillRoot();
  await writeFile(
    path.join(root, "EVALUATION.yaml"),
    `schema_version: 1
id: broken-eval
description: Broken evaluation.
cases:
  - id: duplicate
    target: skill
    operation: get
    name: ota-code-review
    expect: {}
  - id: duplicate
    target: skill
    operation: get
    name: ota-code-review
    expect: {}
`
  );
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bad-eval-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  await service.initialize();
  assert.equal(service.listRepositoryStates()[0]?.status, "error");
  assert.deepEqual(await service.listRepositoryRevisions("rd-skills"), []);
  search.close();
});

test("usage analytics collect unmatched queries with basic secret redaction", async () => {
  const root = await makeSkillRoot();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-analytics-"));
  const repository = { ...repo, path: root, pollingIntervalSeconds: 0 };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new LocalRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );
  await service.initialize();
  service.searchSkills("no-such-skill user@example.com glpat-abcdefghijklmnop Bearer abc.def.ghi https://user:pass@example.com mysql://db:secret@localhost/app");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const unmatched = await service.listUsageAnalytics(10, true);
  assert.equal(unmatched.length >= 1, true);
  assert.match(unmatched[0]?.query ?? "", /\[redacted-email\]/);
  assert.match(unmatched[0]?.query ?? "", /\[redacted-token\]/);
  assert.doesNotMatch(unmatched[0]?.query ?? "", /abc\.def\.ghi|user:pass|db:secret/);
  const summary = await service.getUsageSummary(5);
  assert.equal(summary.unmatched >= 1, true);
  assert.equal((summary.byKind.skill ?? 0) >= 1, true);
  assert.equal(summary.topUnmatchedQueries.length >= 1, true);
  search.close();
});
