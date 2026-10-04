import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectContext } from "../src/project-context.js";
import type { RepositoryConfig } from "../src/types.js";

function repo(id: string, name: string, path?: string): RepositoryConfig {
  return {
    id,
    name,
    provider: path ? "local" : "git",
    ...(path ? { path } : { gitUrl: "git@example.invalid:ai/" + id + ".git" }),
    gitAuth: { type: "none" },
    webhookAliases: [],
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 0,
    readRoles: ["developer", "internal"],
    syncRoles: ["admin"]
  };
}

test("project context resolves unique cwd basename and local path", () => {
  const repositories = [
    repo("rd-skills", "R&D Skills"),
    repo("customer-skills", "Customer Skills", "/srv/customer-skills")
  ];
  assert.deepEqual(resolveProjectContext("/work/rd-skills", repositories), {
    repositoryId: "rd-skills",
    repositoryName: "R&D Skills",
    source: "cwd-basename"
  });
  assert.deepEqual(resolveProjectContext("/srv/customer-skills/docs", repositories), {
    repositoryId: "customer-skills",
    repositoryName: "Customer Skills",
    source: "local-path"
  });
});

test("project context prefers canonical git remote and preserves branch/root", () => {
  const repositories = [
    repo("rd-skills", "R&D Skills"),
    {
      ...repo("ota-runtime", "OTA Runtime"),
      gitUrl: "https://gitlab.example.com/platform/ota-runtime.git"
    }
  ];
  assert.deepEqual(
    resolveProjectContext("/some/unrelated/path", repositories, {
      remote: "git@gitlab.example.com:platform/ota-runtime.git",
      root: "/some/unrelated/path",
      branch: "feature/recovery"
    }),
    {
      repositoryId: "ota-runtime",
      repositoryName: "OTA Runtime",
      source: "git-remote",
      gitRemote: "gitlab.example.com/platform/ota-runtime",
      gitRoot: "/some/unrelated/path",
      gitBranch: "feature/recovery"
    }
  );
});

test("project context refuses ambiguous or unrelated cwd", () => {
  const ambiguous = [
    repo("ota", "OTA"),
    repo("ota-tools", "OTA Tools", "/work/ota")
  ];
  assert.equal(resolveProjectContext("/work/ota", ambiguous), undefined);
  assert.equal(resolveProjectContext("/work/unrelated", ambiguous), undefined);
});
