import assert from "node:assert/strict";
import { test } from "node:test";
import { routeExpert, type ExpertDeployment } from "../src/expert-platform/router.js";

const deployments: ExpertDeployment[] = [
  {
    id: "ota",
    capabilities: ["ota", "upgrade"],
    keywords: ["OTA", "upgrade"],
    repositories: ["ota-source"],
    principals: ["alice"],
    active: true,
  },
  {
    id: "yocto",
    capabilities: ["yocto"],
    keywords: ["Yocto", "recipe"],
    repositories: ["yocto-source"],
    principals: ["alice"],
    active: true,
  },
  {
    id: "code-review",
    capabilities: ["review"],
    keywords: ["code review", "review", "代码审查"],
    repositories: ["ota-source"],
    principals: ["alice"],
    active: true,
  },
];

test("auto selection finds an authorized eligible expert", () => {
  assert.deepEqual(
    routeExpert(deployments, { principal: "alice", problem: "OTA upgrade failed", repositoryId: "ota-source" }),
    { expertId: "ota", selectionMode: "auto" },
  );
});
test("explicit selection never silently falls back", () => {
  assert.deepEqual(
    routeExpert(deployments, {
      principal: "alice",
      problem: "OTA failed",
      expertId: "ota",
      repositoryId: "ota-source",
    }),
    { expertId: "ota", selectionMode: "explicit" },
  );
  assert.throws(
    () =>
      routeExpert(deployments, {
        principal: "alice",
        problem: "OTA failed",
        expertId: "yocto",
        repositoryId: "ota-source",
      }),
    /REPOSITORY_FORBIDDEN/,
  );
});
test("unauthorized and ambiguous selections fail closed", () => {
  assert.throws(() => routeExpert(deployments, { principal: "bob", problem: "OTA failed" }), /EXPERT_UNAVAILABLE/);
  assert.throws(
    () =>
      routeExpert([...deployments, { ...deployments[0]!, id: "ota2" }], { principal: "alice", problem: "OTA failed" }),
    /AMBIGUOUS_EXPERT/,
  );
});

test("explicit auto mode is accepted without a magic expert identifier", () => {
  assert.deepEqual(
    routeExpert(deployments, {
      principal: "alice",
      problem: "OTA upgrade failed",
      selectionMode: "auto",
      repositoryId: "ota-source",
    }),
    { expertId: "ota", selectionMode: "auto" },
  );
});

test("selection mode rejects contradictory or incomplete expert selection", () => {
  assert.throws(
    () => routeExpert(deployments, { principal: "alice", problem: "OTA", selectionMode: "explicit" }),
    /EXPERT_ID_REQUIRED/,
  );
  assert.throws(
    () => routeExpert(deployments, { principal: "alice", problem: "OTA", selectionMode: "auto", expertId: "__AUTO__" }),
    /EXPERT_ID_NOT_ALLOWED_FOR_AUTO/,
  );
});

test("automatic routing selects code-review for review requests and refuses unmatched problems", () => {
  assert.deepEqual(
    routeExpert(deployments, {
      principal: "alice",
      problem: "Please perform a code review for correctness and test reliability",
      repositoryId: "ota-source",
      selectionMode: "auto",
    }),
    { expertId: "code-review", selectionMode: "auto" },
  );
  assert.throws(
    () =>
      routeExpert(deployments, {
        principal: "alice",
        problem: "explain a poem",
        repositoryId: "ota-source",
        selectionMode: "auto",
      }),
    /EXPERT_UNAVAILABLE/,
  );
});
