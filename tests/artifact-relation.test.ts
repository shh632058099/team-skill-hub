import assert from "node:assert/strict";
import test from "node:test";
import { artifactSimilarity, matchArtifact, resolveArtifactTarget } from "../src/artifact-relation.js";

const published = [
  {
    identity: {
      kind: "knowledge" as const,
      key: "r:knowledge/ota.md",
      repositoryId: "r",
      path: "knowledge/ota.md",
      title: "OTA update",
    },
    content: "# OTA update\nFirmware transport and validation steps.",
  },
];

test("same title updates the original Knowledge file", () => {
  const match = matchArtifact(
    { kind: "knowledge", repositoryId: "r", title: "OTA update", content: "Completely rewritten body" },
    published,
  );
  assert.equal(match.relation?.type, "updates");
  assert.equal(resolveArtifactTarget(undefined, match.relation, "knowledge/new.md"), "knowledge/ota.md");
});

test("scope prevents cross repository and artifact type matches", () => {
  for (const changes of [{ repositoryId: "other" }, { kind: "skill" as const }]) {
    const match = matchArtifact(
      { kind: "knowledge", repositoryId: "r", title: "OTA update", content: "Rewritten", ...changes },
      published,
    );
    assert.equal(match.relation, undefined);
  }
});

test("ambiguous published titles require administrator selection", () => {
  const match = matchArtifact({ kind: "knowledge", repositoryId: "r", title: "OTA update", content: "New body" }, [
    ...published,
    { identity: { ...published[0]!.identity, key: "r:other.md", path: "knowledge/other.md" }, content: "different" },
  ]);
  assert.equal(match.relation, undefined);
  assert.equal(match.hint?.confidence, "medium");
});

test("explicit path wins and manual new clears relation targeting", () => {
  const relation = matchArtifact(
    { kind: "knowledge", repositoryId: "r", title: "OTA update", content: "New" },
    published,
  ).relation;
  assert.equal(resolveArtifactTarget("knowledge/custom.md", relation, "knowledge/default.md"), "knowledge/custom.md");
  assert.equal(resolveArtifactTarget(undefined, { type: "new" }, "knowledge/default.md"), "knowledge/default.md");
});

test("similarity is symmetric, ignores URL/numbers, supports CJK bigrams", () => {
  assert.equal(artifactSimilarity("中文知识", "步骤一", "中文知识", "步骤一"), 1);
  assert.equal(artifactSimilarity("OTA", "http://abc.test/one 123", "OTA", "http://xyz.test/two 456"), 1);
  assert.equal(
    artifactSimilarity("A", "alpha beta gamma", "B", "gamma beta alpha"),
    artifactSimilarity("B", "gamma beta alpha", "A", "alpha beta gamma"),
  );
});

test("skill matching never associates with Knowledge", () => {
  const match = matchArtifact({ kind: "skill", repositoryId: "r", title: "OTA update", content: "x" }, published);
  assert.equal(match.relation, undefined);
});
