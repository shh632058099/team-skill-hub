import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { StaticRolePermissionProvider } from "../src/security.js";
import type { Principal, RepositoryConfig, Skill } from "../src/types.js";

const worker: Principal = {
  id: "expert-worker-mcp",
  tenantId: "rd",
  roles: ["worker-mcp-readonly"],
};

function repository(
  id: string,
  visibility: string[],
  readRoles: string[],
  syncRoles = ["developer", "admin"],
): RepositoryConfig {
  return {
    id,
    name: id,
    provider: "local",
    path: `/tmp/${id}`,
    gitAuth: { type: "none" },
    webhookAliases: [],
    enabled: true,
    audience: ["developer"],
    visibility,
    pollingIntervalSeconds: 0,
    readRoles,
    syncRoles,
  };
}

function skill(repositoryId: string, visibility: string[]): Skill {
  return {
    key: `${repositoryId}:ota-recovery`,
    schemaVersion: 1,
    name: "ota-recovery",
    description: "OTA recovery guidance",
    repositoryId,
    revision: "test-revision",
    relativePath: "skills/ota-recovery/SKILL.md",
    rootDir: "/tmp/skills/ota-recovery",
    content: "# OTA recovery",
    metadata: {
      audience: ["developer"],
      domain: ["ota"],
      category: ["recovery"],
      keywords: ["ota", "rollback"],
      visibility,
      maturity: "stable",
      owner: "platform",
      priority: 1,
      dependsOn: [],
      compatibility: {},
    },
  };
}

test("worker-mcp-readonly can read only explicitly allowlisted internal repositories and skills", () => {
  const permissions = new StaticRolePermissionProvider();
  const rdSkills = repository("rd-skills", ["internal"], ["developer", "internal", "worker-mcp-readonly"]);
  const rdKnowledge = repository("rd-knowledges", ["internal"], ["developer", "internal", "worker-mcp-readonly"]);
  const customerSkills = repository("customer-skills", ["customer"], ["customer"]);
  const otherInternal = repository("other-internal", ["internal"], ["developer", "internal"]);

  assert.deepEqual(
    permissions
      .allowedRepositories(worker, [rdSkills, rdKnowledge, customerSkills, otherInternal])
      .map((item) => item.id),
    ["rd-skills", "rd-knowledges"],
  );
  assert.equal(permissions.canReadSkill(worker, rdSkills, skill("rd-skills", ["internal"])), true);
  assert.equal(permissions.canReadSkill(worker, customerSkills, skill("customer-skills", ["customer"])), false);
  assert.equal(permissions.canReadSkill(worker, otherInternal, skill("other-internal", ["internal"])), false);
});

test("worker-mcp-readonly cannot synchronize repositories", () => {
  const permissions = new StaticRolePermissionProvider();
  const rdSkills = repository("rd-skills", ["internal"], ["developer", "internal", "worker-mcp-readonly"]);

  assert.equal(permissions.canSyncRepository(worker, rdSkills), false);
});

test("developer and internal read access remains unchanged", () => {
  const permissions = new StaticRolePermissionProvider();
  const rdSkills = repository("rd-skills", ["internal"], ["developer", "internal"]);
  const developer: Principal = { id: "developer", tenantId: "rd", roles: ["developer"] };
  const internal: Principal = { id: "internal", tenantId: "rd", roles: ["internal"] };

  assert.deepEqual(
    permissions.allowedRepositories(developer, [rdSkills]).map((item) => item.id),
    ["rd-skills"],
  );
  assert.deepEqual(
    permissions.allowedRepositories(internal, [rdSkills]).map((item) => item.id),
    ["rd-skills"],
  );
});

test("repository configuration explicitly allowlists Worker reads only for R&D repositories", async () => {
  const config = await loadConfig(path.resolve("config/repositories.yaml"));
  const byId = new Map(config.repositories.map((item) => [item.id, item]));

  for (const repositoryId of ["rd-skills", "rd-knowledges"]) {
    const repository = byId.get(repositoryId);
    assert.ok(repository, `${repositoryId} must be configured`);
    assert.ok(repository.readRoles.includes("worker-mcp-readonly"));
    assert.equal(repository.syncRoles.includes("worker-mcp-readonly"), false);
  }

  const customerSkills = byId.get("customer-skills");
  assert.ok(customerSkills);
  assert.equal(customerSkills.readRoles.includes("worker-mcp-readonly"), false);
  assert.equal(customerSkills.syncRoles.includes("worker-mcp-readonly"), false);
});
