import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("terminal workspace cleanup is durable, owner-scoped and fenced", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-cleanup",
      sourceType: "mcp",
      title: "cleanup",
      description: "cleanup",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      cleanupPolicy: "on_terminal",
    });
    store.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      100,
      "a".repeat(40),
    );

    store.requestTerminalWorkspaceCleanup(work.workItemId, 200);
    assert.equal(store.getWorkspace(workspace.workspaceId).state, "cleaning");
    assert.equal(store.claimWorkspaceCleanup("worker-b", 300, 30_000), null);
    const cleanup = store.claimWorkspaceCleanup("worker-a", 300, 30_000)!;
    assert.equal(cleanup.workspaceId, workspace.workspaceId);
    assert.equal(cleanup.workspaceKey, workspace.workspaceKey);
    assert.equal(cleanup.fencing, 1);

    store.completeWorkspaceCleanup(cleanup.workspaceId, "worker-a", cleanup.fencing, true, null, 400);
    assert.equal(store.getWorkspace(workspace.workspaceId).state, "removed");
    assert.throws(
      () => store.completeWorkspaceCleanup(cleanup.workspaceId, "worker-a", cleanup.fencing, true, null, 500),
      /STALE_WORKSPACE_CLEANUP/,
    );
  });
});

test("retain workspace policy does not enqueue deletion", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-retain",
      sourceType: "mcp",
      title: "retain",
      description: "retain",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      cleanupPolicy: "retain",
    });
    store.requestTerminalWorkspaceCleanup(work.workItemId, 200);
    assert.equal(store.getWorkspace(workspace.workspaceId).state, "retained");
    assert.equal(store.claimWorkspaceCleanup("worker-a", 300, 30_000), null);
  });
});

test("workspace schema migrates old cleanup constraints without resetting the database", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-workspace-migration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    initial.close();

    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("DROP TABLE IF EXISTS work_workspace_cleanup_requests");
    db.exec("DROP TABLE work_workspaces");
    db.exec(
      [
        "CREATE TABLE work_workspaces (",
        " workspace_id TEXT PRIMARY KEY,",
        " workspace_key TEXT NOT NULL UNIQUE,",
        " work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        " work_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        " owner_worker_id TEXT, path TEXT, repository_url TEXT, branch TEXT, base_commit TEXT,",
        " state TEXT NOT NULL CHECK(state IN ('ready','in_use','retained','removed','failed')),",
        " cleanup_policy TEXT NOT NULL CHECK(cleanup_policy='on_terminal'),",
        " created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL",
        ");",
      ].join("\n"),
    );
    db.close();

    const migrated = new WorkOrchestrationStore(file);
    const work = migrated.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-migration",
      sourceType: "mcp",
      title: "migration",
      description: "migration",
    });
    const attempt = migrated.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = migrated.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      cleanupPolicy: "retain",
    });
    migrated.requestTerminalWorkspaceCleanup(work.workItemId, 100);
    assert.equal(migrated.getWorkspace(workspace.workspaceId).state, "retained");
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("completion gate rejects failed and stale required verification evidence", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("verified-gate", 1, {
      ...base,
      validation: {
        requiredEvidence: ["unit_test"],
        required: [
          {
            id: "unit",
            type: "command",
            argv: ["npm", "test"],
            timeoutMs: 60_000,
            evidenceType: "unit_test",
          },
        ],
      },
      review: { humanReview: false },
      completion: {
        require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
      },
    });

    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "gate-verification",
      sourceType: "mcp",
      title: "Verified gate",
      description: "only current passing verification may satisfy the gate",
      workflowId: "verified-gate",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 1,
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "rev-a");
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "unit_test",
      status: "failed",
      source: "worker_verified",
      subjectRevision: "rev-a",
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
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("required_evidence:unit_test"),
    );

    store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "rev-b");
    const evidence = store.listEvidence(work.workItemId);
    assert.equal(evidence[0]!.stale, true);
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("required_evidence:unit_test"),
    );
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

test("workflow validation policy is append-only, version-pinned and rejects malformed definitions", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    const definition = {
      ...base,
      validation: {
        requiredEvidence: ["expert_result", "unit_test"],
        required: [
          {
            id: "unit-test",
            type: "command",
            argv: ["npm", "test"],
            timeoutMs: 120_000,
            evidenceType: "unit_test",
          },
        ],
      },
    };
    const registered = store.putWorkflow("verified-code-fix", 1, definition, 100);
    assert.deepEqual(registered.definition.validation.required, definition.validation.required);
    assert.equal(store.putWorkflow("verified-code-fix", 1, definition, 101).version, 1);
    assert.throws(
      () => store.putWorkflow("verified-code-fix", 1, { ...definition, review: { humanReview: false } }, 102),
      /WORKFLOW_VERSION_CONFLICT/,
    );
    assert.throws(
      () =>
        store.putWorkflow(
          "bad-validation",
          1,
          {
            ...base,
            validation: {
              requiredEvidence: ["unit_test"],
              required: [{ id: "bad", type: "command", argv: [], timeoutMs: 1_000, evidenceType: "unit_test" }],
            },
          },
          103,
        ),
      /INVALID_VERIFICATION_POLICY/,
    );

    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workflow-pin",
      sourceType: "mcp",
      title: "workflow pin",
      description: "workflow pin",
      workflowId: "verified-code-fix",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    assert.equal(attempt.workflowId, "verified-code-fix");
    assert.equal(attempt.workflowVersion, 1);
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

test("workflow accepts platform write profile and structured approval requirements", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    const record = store.putWorkflow("write-flow", 1, {
      ...structuredClone(base),
      execution: {
        ...structuredClone(base.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
      completion: {
        require: [...base.completion.require, "required_approvals_approved"],
        requiredApprovals: [{ scope: "work_completion", subjectType: "workspace_revision" }],
      },
    });
    assert.equal(record.definition.execution.requiredRuntimeProfile, "codex-workspace-write");
    assert.deepEqual(record.definition.completion.requiredApprovals, [
      { scope: "work_completion", subjectType: "workspace_revision" },
    ]);
  });
});

test("workflow rejects unknown write profiles and malformed approval requirements", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    assert.throws(
      () =>
        store.putWorkflow("bad-profile", 1, {
          ...structuredClone(base),
          execution: {
            ...structuredClone(base.execution),
            requiredRuntimeProfile: "custom-workspace-write" as any,
          },
        }),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("missing-approval", 1, {
          ...structuredClone(base),
          completion: {
            require: [...base.completion.require, "required_approvals_approved"] as any,
          },
        }),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("bad-approval", 1, {
          ...structuredClone(base),
          completion: {
            require: [...base.completion.require, "required_approvals_approved"] as any,
            requiredApprovals: [{ scope: "merge", subjectType: "source_revision" }] as any,
          },
        }),
      /INVALID_WORKFLOW/,
    );
  });
});

test("legacy workflow without runtime or approval requirements remains normalized unchanged", () => {
  withStore((store) => {
    const base = structuredClone(store.getWorkflow("code-fix-default").definition);
    const record = store.putWorkflow("legacy-compatible", 1, base);
    assert.equal(record.definition.execution.requiredRuntimeProfile, undefined);
    assert.equal(record.definition.completion.requiredApprovals, undefined);
    assert.deepEqual(record.definition.completion.require, base.completion.require);
  });
});
