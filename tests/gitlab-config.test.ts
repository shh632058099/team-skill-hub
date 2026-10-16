import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("GitLab deployment example configures Skill publishing with the GitLab write token", async () => {
  const config = await loadConfig(path.resolve("config/repositories.gitlab.example.yaml"));
  const repository = config.repositories.find((item) => item.id === "rd-skills");
  assert.ok(repository, "rd-skills repository should exist");
  assert.equal(repository.skillPublishing?.enabled, true);
  assert.equal(repository.skillPublishing?.provider, "gitlab");
  assert.equal(repository.skillPublishing?.tokenEnv, "GITLAB_WRITE_TOKEN");
  assert.equal(repository.skillPublishing?.targetBranch, "master");
});

test("YAML config normalizes a stale provider-default token env but preserves custom names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-gitlab-config-"));
  try {
    const file = path.join(dir, "repositories.yaml");
    await writeFile(file, `
repositories:
  - id: rd-skills
    name: RD Skills
    provider: git
    git_url: git@gitlab.example.invalid:ai/rd-skills.git
    branch: master
    skill_publishing:
      enabled: true
      provider: gitlab
      base_url: https://gitlab.example.invalid
      project_path: ai/rd-skills
      token_env: GITHUB_TOKEN
      target_branch: master
      branch_prefix: skill-hub-skill
  - id: custom-skills
    name: Custom Skills
    provider: git
    git_url: git@gitlab.example.invalid:ai/custom-skills.git
    branch: master
    skill_publishing:
      enabled: true
      provider: gitlab
      base_url: https://gitlab.example.invalid
      project_path: ai/custom-skills
      token_env: CORP_GITLAB_TOKEN
      target_branch: master
      branch_prefix: skill-hub-skill
`, "utf8");
    const config = await loadConfig(file);
    assert.equal(config.repositories[0]?.skillPublishing?.tokenEnv, "GITLAB_WRITE_TOKEN");
    assert.equal(config.repositories[1]?.skillPublishing?.tokenEnv, "CORP_GITLAB_TOKEN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
