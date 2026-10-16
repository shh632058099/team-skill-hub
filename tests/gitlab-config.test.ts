import assert from "node:assert/strict";
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
