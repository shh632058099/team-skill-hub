import assert from "node:assert/strict";
import test from "node:test";
import { buildArtifactPreview } from "../src/artifact-preview.js";

test("Artifact Preview contract classifies a new asset", () => {
  const preview = buildArtifactPreview({
    artifactType: "knowledge",
    targetPath: "knowledge/new.md",
    targetExists: false,
    changed: true,
    changedFiles: { added: ["knowledge/new.md"], modified: [], deleted: [] },
  });
  assert.equal(preview.operation, "create");
  assert.equal(preview.targetPath, "knowledge/new.md");
});

test("Artifact Preview contract classifies a changed existing asset as update", () => {
  const preview = buildArtifactPreview({
    artifactType: "skill",
    targetPath: "skills/ota/design",
    targetExists: true,
    changed: true,
    changedFiles: { added: [], modified: ["SKILL.md"], deleted: [] },
    relationConfidence: "high",
  });
  assert.equal(preview.operation, "update");
  assert.equal(preview.relationConfidence, "high");
});

test("Artifact Preview contract distinguishes no changes from missing target review", () => {
  const noChanges = buildArtifactPreview({
    artifactType: "skill",
    targetPath: "skills/ota/design",
    targetExists: true,
    changed: false,
    changedFiles: { added: [], modified: [], deleted: [] },
  });
  assert.equal(noChanges.operation, "no_changes");

  const missingTarget = buildArtifactPreview({
    artifactType: "knowledge",
    targetPath: "knowledge/moved.md",
    targetExists: false,
    changed: true,
    changedFiles: { added: [], modified: [], deleted: [] },
    needsReviewReason: "matched target no longer exists",
  });
  assert.equal(missingTarget.operation, "needs_review");
  assert.equal(missingTarget.reviewReason, "matched target no longer exists");
});
