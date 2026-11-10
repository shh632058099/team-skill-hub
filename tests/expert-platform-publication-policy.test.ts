import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPublicationCommitMetadata,
  buildWorkBranchName,
  validatePublicationBranch,
} from "../src/expert-platform/publication-policy.js";

test("work branch is deterministic, prefix-scoped and safe", () => {
  const first = buildWorkBranchName("skillhub/work/", "b74d243f-e1f5-4bf5-8bf3-4db7adf199d8", 2);
  const again = buildWorkBranchName("skillhub/work/", "b74d243f-e1f5-4bf5-8bf3-4db7adf199d8", 2);
  assert.equal(first, "skillhub/work/b74d243f-a2");
  assert.equal(again, first);
  assert.equal(
    validatePublicationBranch({
      branchName: first,
      branchPrefix: "skillhub/work/",
      defaultBranch: "main",
      protectedBranches: ["main", "release"],
    }),
    first,
  );
  for (const branchName of ["main", "release", "other/branch", "skillhub/work/../main", "skillhub/work/bad name"]) {
    assert.throws(
      () =>
        validatePublicationBranch({
          branchName,
          branchPrefix: "skillhub/work/",
          defaultBranch: "main",
          protectedBranches: ["main", "release"],
        }),
      /PUBLICATION_BRANCH_INVALID/,
    );
  }
  assert.throws(() => buildWorkBranchName("../", "work", 1), /PUBLICATION_BRANCH_INVALID/);
  assert.throws(() => buildWorkBranchName("skillhub/work/", "work", 0), /PUBLICATION_BRANCH_INVALID/);
});

test("publication commit metadata is deterministic and sanitizes control characters", () => {
  const input = {
    title: "Fix OTA\nwith hidden\tcontrol",
    workItemId: "work-123",
    workAttemptId: "attempt-7",
    sourceSubjectRevision: "workspace:" + "a".repeat(64),
    timestamp: 1_800_000_000_000,
  };
  const first = buildPublicationCommitMetadata(input);
  const again = buildPublicationCommitMetadata(input);
  assert.deepEqual(again, first);
  assert.equal(first.authorName, "Team Skill Hub");
  assert.equal(first.authorEmail, "team-skill-hub@local.invalid");
  assert.equal(first.timestamp, input.timestamp);
  assert.match(first.message, /^Fix OTA with hidden control\n\n/);
  assert.match(first.message, /Work-Item: work-123/);
  assert.match(first.message, /Work-Attempt: attempt-7/);
  assert.match(first.message, new RegExp("Workspace-Revision: workspace:" + "a".repeat(64)));
  assert.ok(!first.message.includes("\t"));
  assert.ok(!first.message.slice(0, first.message.indexOf("\n\n")).includes("\n"));
});
