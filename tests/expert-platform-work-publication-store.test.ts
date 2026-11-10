import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkPublicationStore } from "../src/expert-platform/work-publication-store.js";

function fixture() {
  return {
    workItemId: "work-1",
    workAttemptId: "attempt-1",
    workspaceId: "workspace-1",
    sourceSubjectRevision: "workspace:" + "a".repeat(64),
    baseCommit: "b".repeat(40),
    repositoryId: "repo-1",
    repositoryIdentityRevision: 4,
    publicationPolicyRevision: 7,
    branchName: "skillhub/work/work1-a1",
    pushRemoteName: "origin" as const,
    pushRefspec: "c".repeat(40) + ":refs/heads/skillhub/work/work1-a1",
    ownerWorkerId: "worker-1",
    commitTimestamp: 1_800_000_000_000,
    commitAuthorName: "Team Skill Hub",
    commitAuthorEmail: "team-skill-hub@local.invalid",
    commitMessage: "Fix OTA\n\nWork-Item: work-1\n",
  };
}

test("publication state persists and idempotent create reuses the same identity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const firstStore = new WorkPublicationStore(file);
    const first = firstStore.createOrReusePublication(fixture());
    const again = firstStore.createOrReusePublication(fixture());
    assert.equal(again.publicationId, first.publicationId);
    assert.equal(first.state, "preparing");
    firstStore.transitionPublication(first.publicationId, "prepared", {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + first.publicationId,
    });
    firstStore.close();

    const reopened = new WorkPublicationStore(file);
    const persisted = reopened.getPublication(first.publicationId);
    assert.equal(persisted.state, "prepared");
    assert.equal(persisted.commitSha, "c".repeat(40));
    assert.equal(persisted.treeSha, "d".repeat(40));
    assert.equal(persisted.branchName, "skillhub/work/work1-a1");
    assert.equal(reopened.listPublications("work-1").length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publication rejects revision reuse and invalid state transitions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-invalid-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const first = store.createOrReusePublication(fixture());
    assert.throws(
      () =>
        store.createOrReusePublication({
          ...fixture(),
          sourceSubjectRevision: "workspace:" + "e".repeat(64),
        }),
      /PUBLICATION_SOURCE_REVISION_CONFLICT/,
    );
    assert.throws(() => store.transitionPublication(first.publicationId, "pushed"), /INVALID_PUBLICATION_TRANSITION/);
    store.transitionPublication(first.publicationId, "prepared", {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + first.publicationId,
    });
    assert.throws(
      () =>
        store.transitionPublication(first.publicationId, "approved", {
          branchName: "different",
        } as any),
      /PUBLICATION_IDENTITY_IMMUTABLE/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
