import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("publication may persist before commit exists and pins refspec when prepared", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-refspec-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const input = { ...fixture(), pushRefspec: undefined };
    const publication = store.createOrReusePublication(input);
    assert.equal(publication.pushRefspec, null);
    const prepared = store.transitionPublication(publication.publicationId, "prepared", {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + publication.publicationId,
      pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
    });
    assert.equal(prepared.pushRefspec, "c".repeat(40) + ":refs/heads/" + publication.branchName);
    assert.throws(
      () =>
        store.transitionPublication(prepared.publicationId, "approved", {
          pushRefspec: "e".repeat(40) + ":refs/heads/" + publication.branchName,
        }),
      /PUBLICATION_IDENTITY_IMMUTABLE/,
    );
    store.close();
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

test("publication operation claim is owner-affine and carries immutable execution snapshot", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-claim-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const publication = store.createOrReusePublication({
      ...fixture(),
      pushRefspec: undefined,
      executionSnapshot: {
        repositoryUrl: "https://example.org/ota.git",
        defaultBranch: "main",
        branchPrefix: "skillhub/work/",
        protectedBranches: ["main"],
        allowedPushRemote: "origin",
        credentialRef: "publish-ref",
        expectedContentRevision: "a".repeat(64),
        approvedChangeSummary: {
          baseCommit: "b".repeat(40),
          changedFiles: ["README.md"],
          addedFiles: [],
          deletedFiles: [],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          contentRevision: "a".repeat(64),
        },
      },
    } as any);
    assert.equal(store.claimPublicationOperation("other-worker", 1000, 30_000), null);
    const prepare = store.claimPublicationOperation("worker-1", 1000, 30_000)!;
    assert.equal(prepare.publicationId, publication.publicationId);
    assert.equal(prepare.operation, "prepare");
    assert.equal(prepare.executionSnapshot?.credentialRef, "publish-ref");
    assert.equal(prepare.fencing, 1);

    store.completePublicationOperation(
      prepare,
      {
        success: true,
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      1100,
    );
    assert.equal(store.getPublication(publication.publicationId).state, "prepared");
    store.transitionPublication(publication.publicationId, "approved", {}, 1200);

    assert.equal(store.claimPublicationOperation("other-worker", 1200, 30_000), null);
    const push = store.claimPublicationOperation("worker-1", 1200, 30_000)!;
    assert.equal(push.operation, "push");
    assert.equal(push.fencing, 2);
    store.completePublicationOperation(push, { success: true }, 1300);
    assert.equal(store.getPublication(publication.publicationId).state, "pushed");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publication cancellation fences active operations and reports unknown push outcome", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-cancel-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const preparing = store.createOrReusePublication(
      {
        ...fixture(),
        workAttemptId: "attempt-prepare",
        executionSnapshot: {
          workspacePath: "/tmp/ws",
          repositoryUrl: "https://example.test/repo.git",
          defaultBranch: "main",
          branchPrefix: "skillhub/work/",
          protectedBranches: ["main"],
          allowedPushRemote: "origin",
          expectedContentRevision: "a".repeat(64),
          approvedChangeSummary: {
            baseCommit: "b".repeat(40),
            changedFiles: [],
            addedFiles: [],
            deletedFiles: [],
            diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
            contentRevision: "a".repeat(64),
          },
        },
      } as any,
      1000,
    );
    const prepareClaim = store.claimPublicationOperation("worker-1", 1100, 1000)!;
    const cancelledPrepare = store.cancelForWork("work-1", 1200);
    assert.ok(cancelledPrepare.cancelledPublicationIds.includes(preparing.publicationId));
    assert.deepEqual(cancelledPrepare.outcomeUnknownPublicationIds, []);
    assert.equal(store.getPublication(preparing.publicationId).state, "cancelled");
    assert.throws(
      () => store.completePublicationOperation(prepareClaim, { success: false, errorCode: "X" }, 1300),
      /STALE_PUBLICATION_OPERATION/,
    );

    const pushing = store.createOrReusePublication(
      {
        ...fixture(),
        workAttemptId: "attempt-push",
        repositoryId: "repo-2",
        executionSnapshot: {
          workspacePath: "/tmp/ws2",
          repositoryUrl: "https://example.test/repo.git",
          defaultBranch: "main",
          branchPrefix: "skillhub/work/",
          protectedBranches: ["main"],
          allowedPushRemote: "origin",
          expectedContentRevision: "a".repeat(64),
          approvedChangeSummary: {
            baseCommit: "b".repeat(40),
            changedFiles: [],
            addedFiles: [],
            deletedFiles: [],
            diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
            contentRevision: "a".repeat(64),
          },
        },
      } as any,
      1400,
    );
    store.transitionPublication(
      pushing.publicationId,
      "prepared",
      { commitSha: "c".repeat(40), treeSha: "d".repeat(40), artifactRef: "pub:" + pushing.publicationId },
      1500,
    );
    store.transitionPublication(pushing.publicationId, "approved", {}, 1600);
    const pushClaim = store.claimPublicationOperation("worker-1", 1700, 1000)!;
    const cancelledPush = store.cancelForWork("work-1", 1800);
    assert.ok(cancelledPush.outcomeUnknownPublicationIds.includes(pushing.publicationId));
    assert.equal(store.getPublication(pushing.publicationId).state, "failed");
    assert.equal(store.getPublication(pushing.publicationId).lastErrorCode, "WORK_CANCELLED_OUTCOME_UNKNOWN");
    assert.throws(
      () => store.completePublicationOperation(pushClaim, { success: true }, 1900),
      /STALE_PUBLICATION_OPERATION/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired pushing lease is reclaimed by the same owner with new fencing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-push-recovery-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const publication = store.createOrReusePublication({
      ...fixture(),
      executionSnapshot: {
        workspacePath: "/srv/workspaces/work1",
        repositoryUrl: "/srv/remotes/ota.git",
        defaultBranch: "main",
        branchPrefix: "skillhub/work/",
        protectedBranches: ["main"],
        allowedPushRemote: "origin",
        expectedContentRevision: "a".repeat(64),
        approvedChangeSummary: {
          baseCommit: "b".repeat(40),
          changedFiles: ["README.md"],
          addedFiles: [],
          deletedFiles: [],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          contentRevision: "a".repeat(64),
        },
      },
    } as any);
    store.transitionPublication(publication.publicationId, "prepared", {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + publication.publicationId,
    });
    store.transitionPublication(publication.publicationId, "approved", {}, 1000);
    const first = store.claimPublicationOperation("worker-1", 2000, 100)!;
    assert.equal(first.operation, "push");
    assert.equal(first.fencing, 1);
    assert.equal(store.claimPublicationOperation("worker-1", 2099, 100), null);

    const recovered = store.claimPublicationOperation("worker-1", 2101, 100)!;
    assert.equal(recovered.operation, "push");
    assert.equal(recovered.fencing, 2);
    assert.throws(
      () => store.completePublicationOperation(first, { success: true }, 2102),
      /STALE_PUBLICATION_OPERATION/,
    );
    store.completePublicationOperation(recovered, { success: true }, 2102);
    assert.equal(store.getPublication(publication.publicationId).state, "pushed");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient push failures use bounded durable backoff before blocking", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-push-retry-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const publication = store.createOrReusePublication({
      ...fixture(),
      executionSnapshot: {
        workspacePath: "/srv/workspaces/work1",
        repositoryUrl: "/srv/remotes/ota.git",
        defaultBranch: "main",
        branchPrefix: "skillhub/work/",
        protectedBranches: ["main"],
        allowedPushRemote: "origin",
        expectedContentRevision: "a".repeat(64),
        approvedChangeSummary: {
          baseCommit: "b".repeat(40),
          changedFiles: ["README.md"],
          addedFiles: [],
          deletedFiles: [],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          contentRevision: "a".repeat(64),
        },
      },
    } as any);
    store.transitionPublication(publication.publicationId, "prepared", {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + publication.publicationId,
    });
    store.transitionPublication(publication.publicationId, "approved", {}, 1000);

    const first = store.claimPublicationOperation("worker-1", 2000, 1000)!;
    const retry1 = store.completePublicationOperation(
      first,
      { success: false, errorCode: "PUBLICATION_PUSH_FAILED" },
      2100,
    );
    assert.equal(retry1.state, "approved");
    assert.equal((retry1 as any).retryCount, 1);
    assert.equal((retry1 as any).nextAttemptAt, 3100);
    assert.equal(store.claimPublicationOperation("worker-1", 3099, 1000), null);

    const second = store.claimPublicationOperation("worker-1", 3100, 1000)!;
    const retry2 = store.completePublicationOperation(
      second,
      { success: false, errorCode: "PUBLICATION_PUSH_FAILED" },
      3200,
    );
    assert.equal((retry2 as any).retryCount, 2);
    assert.equal((retry2 as any).nextAttemptAt, 8200);

    const third = store.claimPublicationOperation("worker-1", 8200, 1000)!;
    const blocked = store.completePublicationOperation(
      third,
      { success: false, errorCode: "PUBLICATION_PUSH_FAILED" },
      8300,
    );
    assert.equal(blocked.state, "blocked");
    assert.equal((blocked as any).retryCount, 3);
    assert.equal((blocked as any).nextAttemptAt, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy publication schema with NOT NULL push_refspec migrates cleanly", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-legacy-migration-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const db = new DatabaseSync(file);
    db.exec(
      [
        "CREATE TABLE work_publications (",
        " publication_id TEXT PRIMARY KEY,",
        " work_item_id TEXT NOT NULL,",
        " work_attempt_id TEXT NOT NULL,",
        " workspace_id TEXT NOT NULL,",
        " state TEXT NOT NULL,",
        " source_subject_revision TEXT NOT NULL,",
        " base_commit TEXT NOT NULL,",
        " repository_id TEXT NOT NULL,",
        " repository_identity_revision INTEGER,",
        " publication_policy_revision INTEGER NOT NULL,",
        " branch_name TEXT NOT NULL,",
        " commit_sha TEXT,",
        " tree_sha TEXT,",
        " artifact_ref TEXT,",
        " push_remote_name TEXT NOT NULL,",
        " push_refspec TEXT NOT NULL,",
        " owner_worker_id TEXT NOT NULL,",
        " commit_timestamp INTEGER NOT NULL,",
        " commit_author_name TEXT NOT NULL,",
        " commit_author_email TEXT NOT NULL,",
        " commit_message TEXT NOT NULL,",
        " execution_snapshot_json TEXT,",
        " prepared_at INTEGER,",
        " approved_at INTEGER,",
        " pushed_at INTEGER,",
        " last_error_code TEXT,",
        " last_error_context TEXT,",
        " operation_fencing INTEGER NOT NULL DEFAULT 0,",
        " operation_lease_until INTEGER,",
        " operation_claimed_worker_id TEXT,",
        " retry_count INTEGER NOT NULL DEFAULT 0,",
        " next_attempt_at INTEGER,",
        " created_at INTEGER NOT NULL,",
        " updated_at INTEGER NOT NULL,",
        " UNIQUE(work_attempt_id, repository_id)",
        ");",
      ].join("\n"),
    );
    db.prepare(
      "INSERT INTO work_publications(publication_id,work_item_id,work_attempt_id,workspace_id,state,source_subject_revision,base_commit,repository_id,repository_identity_revision,publication_policy_revision,branch_name,commit_sha,tree_sha,artifact_ref,push_remote_name,push_refspec,owner_worker_id,commit_timestamp,commit_author_name,commit_author_email,commit_message,execution_snapshot_json,prepared_at,approved_at,pushed_at,last_error_code,last_error_context,operation_fencing,operation_lease_until,operation_claimed_worker_id,retry_count,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "pub-legacy",
      "work-1",
      "attempt-1",
      "workspace-1",
      "prepared",
      "workspace:" + "a".repeat(64),
      "b".repeat(40),
      "repo-1",
      1,
      1,
      "skillhub/work/legacy-a1",
      "c".repeat(40),
      "d".repeat(40),
      "publication:pub-legacy",
      "origin",
      "c".repeat(40) + ":refs/heads/skillhub/work/legacy-a1",
      "worker-1",
      1800000000000,
      "Team Skill Hub",
      "team-skill-hub@local.invalid",
      "Legacy\n",
      null,
      1000,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      0,
      null,
      900,
      1000,
    );
    db.close();

    const migrated = new WorkPublicationStore(file);
    const publication = migrated.getPublication("pub-legacy");
    assert.equal(publication.pushRefspec, "c".repeat(40) + ":refs/heads/skillhub/work/legacy-a1");
    assert.equal(publication.retryCount, 0);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publication completion rejects operation mismatch even with current fencing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-operation-fencing-"));
  try {
    const store = new WorkPublicationStore(path.join(dir, "runtime.sqlite"));
    const publication = store.createOrReusePublication({
      ...fixture(),
      executionSnapshot: {
        workspacePath: "/srv/workspaces/work1",
        repositoryUrl: "/srv/remotes/ota.git",
        defaultBranch: "main",
        branchPrefix: "skillhub/work/",
        protectedBranches: ["main"],
        allowedPushRemote: "origin",
        expectedContentRevision: "a".repeat(64),
        approvedChangeSummary: {
          baseCommit: "b".repeat(40),
          changedFiles: ["README.md"],
          addedFiles: [],
          deletedFiles: [],
          diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
          contentRevision: "a".repeat(64),
        },
      },
    } as any);
    store.transitionPublication(publication.publicationId, "prepared", {
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + publication.publicationId,
    });
    store.transitionPublication(publication.publicationId, "approved");
    const push = store.claimPublicationOperation("worker-1", 2000, 30_000)!;
    assert.equal(push.operation, "push");
    assert.throws(
      () =>
        store.completePublicationOperation(
          { ...push, operation: "prepare" },
          {
            success: true,
            commitSha: "e".repeat(40),
            treeSha: "f".repeat(40),
            artifactRef: "publication:" + publication.publicationId,
            pushRefspec: "e".repeat(40) + ":refs/heads/" + publication.branchName,
          },
          2100,
        ),
      /STALE_PUBLICATION_OPERATION|INVALID_PUBLICATION_OPERATION/,
    );
    assert.equal(store.getPublication(publication.publicationId).state, "pushing");
    assert.equal(store.getPublication(publication.publicationId).commitSha, "c".repeat(40));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
