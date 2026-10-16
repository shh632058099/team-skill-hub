import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AdminConfigStore,
  applyAdminConfig,
  editableConfigFromApp,
  validateAdminConfig
} from "../src/admin-config.js";
import type { AppConfig } from "../src/types.js";

function baseConfig(dataDir: string): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8080,
    dataDir,
    defaultRoles: ["developer"],
    authentication: { mode: "development", apiKeys: {} },
    revisionRetentionMax: 20,
    webhookDedupMaxEntries: 1000,
    webhookDedupTtlSeconds: 604800,
    repositories: [],
    projects: []
  };
}

test("admin config persists and overlays runtime configuration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-"));
  try {
    const config = baseConfig(dir);
    const store = new AdminConfigStore(dir);
    const saved = await store.save({
      defaultRoles: ["developer", "internal"],
      revisionRetentionMax: 8,
      webhookDedupMaxEntries: 500,
      webhookDedupTtlSeconds: 7200,
      repositories: [
        {
          id: "rd-skills",
          name: "RD Skills",
          provider: "git",
          gitUrl: "git@example.invalid:ai/rd-skills.git",
          branch: "master",
          gitAuth: { type: "none" },
          webhookAliases: ["rd-skills"],
          enabled: true,
          audience: ["developer"],
          visibility: ["internal"],
          pollingIntervalSeconds: 120,
          readRoles: ["developer"],
          syncRoles: ["admin"]
,
          knowledgePublishing: {
            enabled: true,
            provider: "gitlab",
            baseUrl: "https://gitlab.example.invalid",
            projectPath: "ai/rd-skills",
            tokenEnv: "GITLAB_WRITE_TOKEN",
            targetBranch: "master",
            branchPrefix: "skill-hub-knowledge"
          }
        }
      ],
      projects: [
        {
          id: "ota-platform",
          name: "OTA Platform",
          repositoryPatterns: ["rd-skills"],
          owners: ["ota-team"],
          preferredSkillRepositories: ["rd-skills"],
          preferredKnowledgeRepositories: ["rd-skills"],
          tools: ["gitlab"],
          environments: ["dev", "prod"],
          product: "ota",
          aliases: ["ota-runtime"]
        }
      ]
    });
    applyAdminConfig(config, saved);

    const restarted = baseConfig(dir);
    assert.equal(await store.load(restarted), true);
    assert.deepEqual(editableConfigFromApp(restarted), editableConfigFromApp(config));

    const persisted = JSON.parse(
      await readFile(path.join(dir, "config", "admin-config.json"), "utf8")
    );
    assert.equal(persisted.repositories[0].id, "rd-skills");
    assert.equal(saved.repositories[0]?.knowledge?.enabled, true);
    assert.deepEqual(saved.repositories[0]?.knowledge?.include, ["**/*.md", "**/*.txt", "**/*.pdf", "**/*.docx"]);
    assert.equal(saved.repositories[0]?.knowledgePublishing?.tokenEnv, "GITLAB_WRITE_TOKEN");
    assert.equal(restarted.repositories[0]?.knowledgePublishing?.enabled, true);
    assert.equal(saved.projects[0]?.id, "ota-platform");
    assert.deepEqual(restarted.projects?.[0]?.owners, ["ota-team"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("admin config rejects unknown project preferred repositories", () => {
  assert.throws(
    () =>
      validateAdminConfig({
        defaultRoles: [],
        revisionRetentionMax: 20,
        webhookDedupMaxEntries: 1000,
        webhookDedupTtlSeconds: 604800,
        repositories: [],
        projects: [
          {
            id: "ota",
            name: "OTA",
            repositoryPatterns: ["ota-*"],
            owners: [],
            preferredSkillRepositories: ["missing-skills"],
            preferredKnowledgeRepositories: [],
            tools: [],
            environments: [],
            aliases: []
          }
        ]
      }),
    /unknown preferred repository/
  );
});

test("admin config rejects duplicate repository ids", () => {
  const repository = {
    id: "same",
    name: "Same",
    provider: "git" as const,
    gitUrl: "git@example.invalid:ai/same.git",
    gitAuth: { type: "none" as const },
    webhookAliases: [],
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 60,
    readRoles: ["developer"],
    syncRoles: ["admin"]
  };
  assert.throws(
    () =>
      validateAdminConfig({
        defaultRoles: [],
        revisionRetentionMax: 20,
        webhookDedupMaxEntries: 1000,
        webhookDedupTtlSeconds: 604800,
        repositories: [repository, { ...repository }],
        projects: []
      }),
    /Duplicate repository id/
  );
});
