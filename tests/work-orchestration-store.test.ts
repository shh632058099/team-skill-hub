import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkPublicationStore } from "../src/expert-platform/work-publication-store.js";

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

test("approval schema migrates legacy databases with attempt binding column", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-approval-migration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    initial.close();
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec(
        [
          "DROP TABLE work_approvals;",
          "CREATE TABLE work_approvals (",
          " approval_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,",
          " approval_scope TEXT NOT NULL, subject_type TEXT NOT NULL, subject_revision TEXT NOT NULL,",
          " decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)), created_at INTEGER NOT NULL",
          ");",
        ].join("\n"),
      );
    } finally {
      legacy.close();
    }

    const reopened = new WorkOrchestrationStore(file);
    const db = new DatabaseSync(file);
    try {
      const columns = db.prepare("PRAGMA table_info(work_approvals)").all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "work_attempt_id"));
    } finally {
      db.close();
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const staleEvents = store
      .listEvents(work.workItemId)
      .events.filter((event) => event.eventType === "evidence.staled");
    assert.equal(staleEvents.length, 1);
    assert.equal(staleEvents[0]!.details?.count, 1);
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
      /INVALID_WORK_APPROVAL/,
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

function createApprovalGatedWork(store: WorkOrchestrationStore, idempotencyKey: string) {
  const base = store.getWorkflow("code-fix-default").definition;
  const workflowId = "approval-gated-" + idempotencyKey;
  store.putWorkflow(workflowId, 1, {
    ...structuredClone(base),
    completion: {
      require: [...base.completion.require, "required_approvals_approved"],
      requiredApprovals: [{ scope: "work_completion", subjectType: "workspace_revision" }],
    },
  });
  const work = store.createOrReuseWork({
    principalId: "alice",
    scope: "team-a",
    idempotencyKey,
    sourceType: "mcp",
    title: "Approval Gate",
    description: "require exact current approval",
    workflowId,
  });
  const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
    reason: "initial",
    expertId: "ota",
    deploymentId: "ota-write",
    deploymentConfigVersion: 1,
  });
  let current = store.getWork(work.workItemId, "alice", "team-a");
  const subject = "workspace:" + "a".repeat(64);
  current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, subject);
  store.recordEvidence(work.workItemId, "alice", "team-a", {
    workAttemptId: attempt.workAttemptId,
    type: "expert_result",
    status: "passed",
    source: "worker_verified",
    subjectRevision: subject,
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
  return { workItemId: work.workItemId, subject, current };
}

test("completion gate requires current work_completion approval after accepted review", () => {
  withStore((store) => {
    const setup = createApprovalGatedWork(store, "approval-gate-review-first");
    store.submitReviewDecision(setup.workItemId, "alice", "team-a", {
      expectedRevision: setup.current.stateRevision,
      subjectRevision: setup.subject,
      decision: "accepted",
    });
    let gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.equal(gate.ready, false);
    assert.deepEqual(gate.missing, ["required_approval:work_completion"]);

    let current = store.getWork(setup.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        store.recordApproval(setup.workItemId, "alice", "team-a", {
          expectedRevision: current.stateRevision,
          actor: "alice",
          role: "developer",
          approvalScope: "merge",
          subjectType: "workspace_revision",
          subjectRevision: setup.subject,
          decision: "approved",
        }),
      /INVALID_WORK_APPROVAL/,
    );
    gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.deepEqual(gate.missing, ["required_approval:work_completion"]);
    current = store.getWork(setup.workItemId, "alice", "team-a");
    store.recordApproval(setup.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: setup.subject,
      decision: "approved",
    });
    gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.equal(gate.ready, true);
    assert.deepEqual(gate.missing, []);
  });
});

test("approval without review is insufficient and becomes stale after subject revision changes", () => {
  withStore((store) => {
    const setup = createApprovalGatedWork(store, "approval-gate-approval-first");
    store.recordApproval(setup.workItemId, "alice", "team-a", {
      expectedRevision: setup.current.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: setup.subject,
      decision: "approved",
    });
    let gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("review_accepted"));
    assert.ok(!gate.missing.includes("required_approval:work_completion"));

    let current = store.getWork(setup.workItemId, "alice", "team-a");
    store.setCurrentSubjectRevision(
      setup.workItemId,
      "alice",
      "team-a",
      current.stateRevision,
      "workspace:" + "b".repeat(64),
    );
    assert.equal(store.listApprovals(setup.workItemId).at(-1)!.stale, true);
    const invalidatedEvents = store
      .listEvents(setup.workItemId)
      .events.filter((event) => event.eventType === "approval.invalidated");
    assert.equal(invalidatedEvents.length, 1);
    assert.equal(invalidatedEvents[0]!.details?.count, 1);
    gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_approval:work_completion"));
    assert.ok(gate.missing.includes("review_accepted"));
  });
});

test("new WorkAttempt invalidates prior attempt evidence even when subject revision is unchanged", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("attempt-bound-evidence", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["unit_test"], required: [] },
      review: { humanReview: false },
      completion: {
        require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
      },
    });
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "attempt-bound-evidence",
      sourceType: "mcp",
      title: "Attempt evidence",
      description: "evidence must belong to latest attempt",
      workflowId: "attempt-bound-evidence",
    });
    const first = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-a",
      deploymentConfigVersion: 1,
    });
    work = store.getWork(work.workItemId, "alice", "team-a");
    const subject = "workspace:" + "a".repeat(64);
    work = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, subject);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: first.workAttemptId,
      type: "unit_test",
      status: "passed",
      source: "worker_verified",
      subjectRevision: subject,
      environmentIdentity: "ota-a@1",
      verifierIdentity: "team-skill-hub",
    });
    work = store.finishWorkAttempt(
      work.workItemId,
      first.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
    );
    assert.equal(store.evaluateCompletionGate(work.workItemId, "alice", "team-a").ready, true);

    const second = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "review_rework",
      expertId: "ota",
      deploymentId: "ota-b",
      deploymentConfigVersion: 2,
      parentWorkAttemptId: first.workAttemptId,
    });
    work = store.getWork(work.workItemId, "alice", "team-a");
    work = store.finishWorkAttempt(
      work.workItemId,
      second.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
    );

    const evidence = store.listEvidence(work.workItemId);
    assert.equal(evidence[0]!.stale, true);
    const gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_evidence:unit_test"));
  });
});

test("work completion approval is bound to the latest succeeded WorkAttempt", () => {
  withStore((store) => {
    const setup = createApprovalGatedWork(store, "approval-attempt-binding");
    store.submitReviewDecision(setup.workItemId, "alice", "team-a", {
      expectedRevision: setup.current.stateRevision,
      subjectRevision: setup.subject,
      decision: "accepted",
    });
    let current = store.getWork(setup.workItemId, "alice", "team-a");
    const approval = store.recordApproval(setup.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: setup.subject,
      decision: "approved",
    });
    assert.ok(approval.workAttemptId);
    assert.equal(store.evaluateCompletionGate(setup.workItemId, "alice", "team-a").ready, true);

    current = store.getWork(setup.workItemId, "alice", "team-a");
    const firstAttempt = store.listAttempts(setup.workItemId)[0]!;
    const second = store.createWorkAttempt(setup.workItemId, "alice", "team-a", current.stateRevision, {
      reason: "review_rework",
      expertId: "ota",
      deploymentId: "ota-write-v2",
      deploymentConfigVersion: 2,
      parentWorkAttemptId: firstAttempt.workAttemptId,
    });
    current = store.getWork(setup.workItemId, "alice", "team-a");
    current = store.finishWorkAttempt(
      setup.workItemId,
      second.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );

    assert.equal(store.listApprovals(setup.workItemId).at(-1)!.stale, true);
    const gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_approval:work_completion"));
  });
});

test("approval store accepts only platform-defined subject/scope pairs", () => {
  withStore((store) => {
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "publication-approval-store",
      sourceType: "mcp",
      title: "Publication approval",
      description: "approve exact prepared commit",
    });
    work = store.setCurrentSubjectRevision(
      work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "workspace:" + "a".repeat(64),
    );
    const publicationSubject = "publication:11111111-1111-4111-8111-111111111111:" + "c".repeat(40);
    const approval = store.recordApproval(work.workItemId, "alice", "team-a", {
      expectedRevision: work.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "publish_work_branch",
      subjectType: "publication_artifact",
      subjectRevision: publicationSubject,
      decision: "approved",
    });
    assert.equal(approval.approvalScope, "publish_work_branch");
    assert.equal(approval.subjectType, "publication_artifact");
    assert.equal(approval.subjectRevision, publicationSubject);

    work = store.getWork(work.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        store.recordApproval(work.workItemId, "alice", "team-a", {
          expectedRevision: work.stateRevision,
          actor: "alice",
          role: "developer",
          approvalScope: "work_completion",
          subjectType: "publication_artifact",
          subjectRevision: publicationSubject,
          decision: "approved",
        }),
      /INVALID_WORK_APPROVAL/,
    );
  });
});

test("publication-required workflow gates completion on exact pushed artifact evidence and approval", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-gate-"));
  const file = path.join(dir, "runtime.db");
  const publications = new WorkPublicationStore(file);
  try {
    const store = new WorkOrchestrationStore(file);
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("publication-gate", 1, {
      ...base,
      publication: { required: true, mode: "work_branch" },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
          "required_approvals_approved",
          "publication_succeeded",
        ],
        requiredApprovals: [{ scope: "publish_work_branch", subjectType: "publication_artifact" }],
      },
    } as any);
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "publication-gate",
      sourceType: "mcp",
      title: "Publish",
      description: "Publish exact branch",
      workflowId: "publication-gate",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-write",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      baseCommit: "b".repeat(40),
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
    });
    const sourceSubject = "workspace:" + "a".repeat(64);
    work = store.getWork(work.workItemId, "alice", "team-a");
    work = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, sourceSubject, 100);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "expert_result",
      status: "passed",
      source: "worker_verified",
      subjectRevision: sourceSubject,
    });
    work = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
      110,
    );
    store.submitReviewDecision(
      work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: work.stateRevision,
        subjectRevision: sourceSubject,
        decision: "accepted",
      },
      120,
    );

    const publication = publications.createOrReusePublication(
      {
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workspaceId: workspace.workspaceId,
        sourceSubjectRevision: sourceSubject,
        baseCommit: "b".repeat(40),
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 1,
        branchName: "skillhub/work/work-a1",
        pushRemoteName: "origin",
        ownerWorkerId: "worker-a",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "Publish\n",
        executionSnapshot: {
          workspacePath: "/srv/workspaces/work-a1",
          repositoryUrl: "https://example.test/ota.git",
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
      } as any,
      130,
    );
    publications.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      140,
    );
    const publicationSubject = "publication:" + publication.publicationId + ":" + "c".repeat(40);

    let gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_approval:publish_work_branch"));
    assert.ok(gate.missing.includes("publication_succeeded"));

    work = store.getWork(work.workItemId, "alice", "team-a");
    store.recordApproval(
      work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: work.stateRevision,
        actor: "alice",
        role: "developer",
        approvalScope: "publish_work_branch",
        subjectType: "publication_artifact",
        subjectRevision: publicationSubject,
        decision: "approved",
      },
      150,
    );
    publications.transitionPublication(publication.publicationId, "approved", {}, 150);
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(!gate.missing.includes("required_approval:publish_work_branch"));
    assert.ok(gate.missing.includes("publication_succeeded"));

    publications.transitionPublication(publication.publicationId, "pushing", {}, 160);
    publications.transitionPublication(publication.publicationId, "pushed", {}, 170);
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("publication_succeeded"), "pushed state alone must not satisfy gate");

    store.recordEvidence(
      work.workItemId,
      "alice",
      "team-a",
      {
        workAttemptId: attempt.workAttemptId,
        type: "publication",
        status: "passed",
        source: "worker_verified",
        artifactRef: "publication:" + publication.publicationId,
        subjectRevision: publicationSubject,
        environmentIdentity: "publication-policy@1",
        verifierIdentity: "team-skill-hub-publication",
      },
      180,
    );
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(gate.ready, true);
    assert.deepEqual(gate.missing, []);

    work = store.getWork(work.workItemId, "alice", "team-a");
    store.setCurrentSubjectRevision(
      work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "workspace:" + "e".repeat(64),
      190,
    );
    assert.equal(store.listEvidence(work.workItemId).find((e) => e.type === "publication")?.stale, true);
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("publication_succeeded"),
    );

    store.close();
  } finally {
    publications.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publication_succeeded token is invalid without publication-required workflow", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    assert.throws(
      () =>
        store.putWorkflow("bad-publication-gate", 1, {
          ...base,
          completion: { require: [...base.completion.require, "publication_succeeded"] },
        } as any),
      /INVALID_WORKFLOW/,
    );
  });
});

test("durable orchestration claim is exclusive, fenced by epoch, and survives reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-claim-"));
  const file = path.join(dir, "runtime.db");
  let store = new WorkOrchestrationStore(file);
  try {
    const work = store.createOrReuseWork(
      {
        principalId: "alice",
        scope: "team-a",
        idempotencyKey: "claim-1",
        sourceType: "mcp",
        title: "Claim",
        description: "claim",
      },
      100,
    );

    const first = store.claimWorkForOrchestration(work.workItemId, "orchestrator-a", 200, 1_000);
    assert.equal(first.ownerId, "orchestrator-a");
    assert.equal(first.epoch, work.orchestrationEpoch + 1);
    assert.equal(store.getWork(work.workItemId, "alice", "team-a").orchestrationOwnerId, "orchestrator-a");
    assert.throws(
      () => store.claimWorkForOrchestration(work.workItemId, "orchestrator-b", 300, 1_000),
      /WORK_ORCHESTRATION_CLAIMED/,
    );

    store.close();
    store = new WorkOrchestrationStore(file);
    const reopened = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(reopened.orchestrationOwnerId, "orchestrator-a");
    assert.equal(reopened.orchestrationLeaseUntil, 1_200);
    store.assertWorkOrchestrationClaim(work.workItemId, "orchestrator-a", first.epoch, 1_199);

    const second = store.claimWorkForOrchestration(work.workItemId, "orchestrator-b", 1_201, 1_000);
    assert.equal(second.ownerId, "orchestrator-b");
    assert.equal(second.epoch, first.epoch + 1);
    const afterTakeover = store.getWork(work.workItemId, "alice", "team-a");
    assert.ok(afterTakeover.stateRevision > reopened.stateRevision);
    assert.throws(
      () =>
        store.transitionWork(work.workItemId, "alice", "team-a", afterTakeover.stateRevision, "running", 1_202, {
          ownerId: "orchestrator-a",
          epoch: first.epoch,
          now: 1_202,
        }),
      /STALE_ORCHESTRATION_CLAIM/,
    );
    assert.throws(
      () => store.assertWorkOrchestrationClaim(work.workItemId, "orchestrator-a", first.epoch, 1_202),
      /STALE_ORCHESTRATION_CLAIM/,
    );
    store.assertWorkOrchestrationClaim(work.workItemId, "orchestrator-b", second.epoch, 1_202);

    store.releaseWorkOrchestrationClaim(work.workItemId, "orchestrator-b", second.epoch, 1_203);
    assert.equal(store.getWork(work.workItemId, "alice", "team-a").orchestrationOwnerId, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked work persists complete resume metadata and can be explicitly resumed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-blocked-resume-"));
  const file = path.join(dir, "runtime.db");
  let store = new WorkOrchestrationStore(file);
  try {
    const work = store.createOrReuseWork(
      {
        principalId: "alice",
        scope: "team-a",
        idempotencyKey: "blocked-metadata",
        sourceType: "mcp",
        title: "Blocked",
        description: "blocked",
      },
      100,
    );
    const blocked = store.blockWork(
      work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "missing_permission",
      "MISSING_PERMISSION",
      200,
      { resumeCondition: "manual", blockedByType: "permission", blockedByRef: "repo:ota" },
    );
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedAt, 200);
    assert.equal(blocked.resumeCondition, "manual");
    assert.equal(blocked.blockedByType, "permission");
    assert.equal(blocked.blockedByRef, "repo:ota");

    store.close();
    store = new WorkOrchestrationStore(file);
    const reopened = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(reopened.blockedAt, 200);
    assert.equal(reopened.resumeCondition, "manual");
    assert.equal(reopened.blockedByType, "permission");
    assert.equal(reopened.blockedByRef, "repo:ota");

    const resumed = store.resumeBlockedWork(work.workItemId, "alice", "team-a", reopened.stateRevision, "queued", 300);
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.blockedReason, null);
    assert.equal(resumed.blockedContext, null);
    assert.equal(resumed.blockedAt, null);
    assert.equal(resumed.resumeCondition, null);
    assert.equal(resumed.blockedByType, null);
    assert.equal(resumed.blockedByRef, null);
    assert.ok(store.listEvents(work.workItemId).events.some((event) => event.eventType === "work.resumed"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
