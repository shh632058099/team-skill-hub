import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";

function withStore(run: (store: WorkOrchestrationStore, file: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const store = new WorkOrchestrationStore(file);
    run(store, file);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("work submission is idempotent and conflicting reuse fails closed", () => {
  withStore((store) => {
    const first = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "work-k1",
      sourceType: "mcp",
      title: "Fix OTA recovery",
      description: "Investigate and fix interrupted upgrade recovery",
    });
    const again = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "work-k1",
      sourceType: "mcp",
      title: "Fix OTA recovery",
      description: "Investigate and fix interrupted upgrade recovery",
    });

    assert.equal(again.workItemId, first.workItemId);
    assert.equal(first.reusedExistingWork, false);
    assert.equal(again.reusedExistingWork, true);
    assert.equal(again.deduplicationReason, "idempotency_key");
    assert.throws(
      () =>
        store.createOrReuseWork({
          principalId: "alice",
          scope: "team-a",
          idempotencyKey: "work-k1",
          sourceType: "mcp",
          title: "Different work",
          description: "Different payload",
        }),
      /WORK_IDEMPOTENCY_CONFLICT/,
    );
  });
});

test("workspace identity is deterministic and records owner affinity", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-1",
      sourceType: "mcp",
      title: "Workspace",
      description: "keep one workspace per attempt",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    const first = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "abc123",
    });
    const again = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "abc123",
    });
    assert.equal(again.workspaceId, first.workspaceId);
    assert.equal(again.workspaceKey, first.workspaceKey);
    assert.match(first.workspaceKey, /^work-[a-f0-9-]+-a1$/);

    const assigned = store.assignWorkspaceOwner(first.workspaceId, "worker-a", "/srv/work/a");
    assert.equal(assigned.ownerWorkerId, "worker-a");
    assert.equal(assigned.path, "/srv/work/a");
    assert.equal(store.getWorkAttempt(attempt.workAttemptId).workspaceId, first.workspaceId);
  });
});

test("evidence is revision-bound and becomes stale after the work subject changes", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "evidence-1",
      sourceType: "mcp",
      title: "Evidence",
      description: "bind proof to a revision",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "abc123");
    const evidence = store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "expert_result",
      status: "passed",
      source: "worker_verified",
      subjectRevision: "abc123",
      environmentIdentity: "worker-a/runtime-v1",
      verifierIdentity: "team-skill-hub@1",
      summary: "expert result captured",
    });
    assert.equal(evidence.stale, false);
    assert.equal(evidence.subjectRevision, "abc123");

    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "def456");
    const stale = store.listEvidence(work.workItemId);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.stale, true);
    assert.equal(current.currentSubjectRevision, "def456");
  });
});

test("review and approval reject stale subject revisions", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "review-1",
      sourceType: "mcp",
      title: "Review",
      description: "review current revision only",
    });
    let current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, "abc123");
    const review = store.submitReviewDecision(work.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      subjectRevision: "abc123",
      decision: "accepted",
      reason: "looks good",
    });
    assert.equal(review.decision, "accepted");
    current = store.getWork(work.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        store.recordApproval(work.workItemId, "alice", "team-a", {
          expectedRevision: current.stateRevision,
          actor: "owner",
          role: "maintainer",
          approvalScope: "merge",
          subjectType: "source_revision",
          subjectRevision: "old-revision",
          decision: "approved",
        }),
      /STALE_WORK_SUBJECT/,
    );
  });
});

test("completion gate requires current evidence and accepted review", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "gate-1",
      sourceType: "mcp",
      title: "Gate",
      description: "complete only with proof and review",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "abc123");
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "expert_result",
      status: "passed",
      source: "worker_verified",
      subjectRevision: "abc123",
      environmentIdentity: "worker-a/runtime-v1",
      verifierIdentity: "team-skill-hub@1",
    });
    current = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );
    const beforeReview = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(beforeReview.ready, false);
    assert.ok(beforeReview.missing.includes("review_accepted"));

    store.submitReviewDecision(work.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      subjectRevision: "abc123",
      decision: "accepted",
    });
    const afterReview = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(afterReview.ready, true);
    assert.deepEqual(afterReview.missing, []);
  });
});

test("stable source identity reuses one work item across delivery retries", () => {
  withStore((store) => {
    const first = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "delivery-1",
      sourceType: "github",
      sourceScope: "openai/symphony",
      sourceRef: "issue-123",
      title: "Tracker issue",
      description: "Implement the requested change",
    });
    const again = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "delivery-2",
      sourceType: "github",
      sourceScope: "openai/symphony",
      sourceRef: "issue-123",
      title: "Tracker issue",
      description: "Implement the requested change",
    });

    assert.equal(again.workItemId, first.workItemId);
    assert.equal(again.deduplicationReason, "source_identity");
  });
});

test("work transitions use revision CAS and reject stale writers", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "cas-1",
      sourceType: "admin",
      title: "CAS",
      description: "verify state revision",
    });
    assert.equal(work.stateRevision, 1);
    const running = store.transitionWork(work.workItemId, "alice", "team-a", work.stateRevision, "running");
    assert.equal(running.status, "running");
    assert.equal(running.stateRevision, 2);
    assert.throws(
      () => store.transitionWork(work.workItemId, "alice", "team-a", work.stateRevision, "blocked"),
      /STALE_WORK_REVISION/,
    );
  });
});

test("only one active work attempt is allowed and it pins workflow version", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "attempt-1",
      sourceType: "mcp",
      title: "Attempt",
      description: "create one attempt",
      workflowId: "code-fix-default",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 7,
    });
    assert.equal(attempt.sequence, 1);
    assert.equal(attempt.workflowId, "code-fix-default");
    assert.equal(attempt.workflowVersion, 1);
    const current = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(current.activeWorkAttemptId, attempt.workAttemptId);
    assert.throws(
      () =>
        store.createWorkAttempt(work.workItemId, "alice", "team-a", current.stateRevision, {
          reason: "human_rework",
          expertId: "ota",
          deploymentId: "ota-codex",
          deploymentConfigVersion: 7,
        }),
      /ACTIVE_WORK_ATTEMPT_EXISTS/,
    );
  });
});

test("default workflow policy is immutable and available after reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-reopen-"));
  const file = path.join(dir, "runtime.db");
  try {
    let store = new WorkOrchestrationStore(file);
    const workflow = store.getWorkflow("code-fix-default", 1);
    assert.equal(workflow.version, 1);
    assert.equal(workflow.definition.lifecycle.attempt.maxWorkAttempts, 5);
    assert.equal(workflow.definition.lifecycle.attempt.maxReworks, 3);
    assert.equal(workflow.definition.lifecycle.retry.failure.maxRunsPerWorkAttempt, 3);
    assert.equal(workflow.definition.lifecycle.continuation.maxTurnsPerRun, 20);
    assert.deepEqual(workflow.definition.validation.requiredEvidence, ["expert_result"]);

    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "reopen-1",
      sourceType: "mcp",
      title: "Persist",
      description: "survive reopen",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 3,
    });
    store.close();

    store = new WorkOrchestrationStore(file);
    const reopened = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(reopened.activeWorkAttemptId, attempt.workAttemptId);
    assert.equal(store.getWorkAttempt(attempt.workAttemptId).deploymentConfigVersion, 3);
    assert.equal(store.getWorkflow("code-fix-default", 1).version, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
