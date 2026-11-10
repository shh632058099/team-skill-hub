import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  experts.putDefinition({
    id: "ota",
    displayName: "OTA Expert",
    capabilities: ["ota"],
    keywords: ["ota", "upgrade"],
    active: true,
  });

  experts.putDeployment({
    id: "ota-default",
    expertId: "ota",
    repositoryIds: ["ota-repo"],
    repositories: [],
    principals: ["alice"],
    runtimeProfile: "codex-readonly",
    active: true,
  });
  const dispatch = new ExpertDispatchService(experts, tasks);
  const orchestrator = new WorkOrchestrator(work, tasks, dispatch);
  return {
    dir,
    experts,
    tasks,
    work,
    orchestrator,
    close() {
      work.close();
      tasks.close();
      experts.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const submission = {
  principalId: "alice",
  scope: "team-a",
  idempotencyKey: "work-1",
  sourceType: "mcp",
  title: "Inspect OTA recovery",
  description: "inspect ota upgrade recovery without modifying files",
  expertId: "ota",
  deploymentId: "ota-default",
  repositoryId: "ota-repo",
} as const;

test("WorkAttempt pins workflow validation policy into ExpertTask and Worker claim", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("code-fix-default").definition;
    const validationV1 = [
      {
        id: "unit-test",
        type: "command",
        argv: ["npm", "test"],
        timeoutMs: 120_000,
        evidenceType: "unit_test",
      },
    ];
    f.work.putWorkflow(
      "verified-readonly",
      1,
      {
        ...base,
        validation: {
          requiredEvidence: ["expert_result", "unit_test"],
          required: validationV1,
        },
      },
      100,
    );

    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-validation-snapshot",
      workflowId: "verified-readonly",
    });
    assert.equal(detail.attempts[0]!.workflowVersion, 1);
    assert.deepEqual(detail.currentTask!.validationSnapshot, validationV1);

    f.work.putWorkflow(
      "verified-readonly",
      2,
      {
        ...base,
        validation: {
          requiredEvidence: ["expert_result", "lint"],
          required: [
            {
              id: "lint",
              type: "command",
              argv: ["npm", "run", "lint"],
              timeoutMs: 60_000,
              evidenceType: "lint",
            },
          ],
        },
      },
      200,
    );
    assert.deepEqual(f.tasks.get(detail.currentTask!.taskId, "alice", "team-a").validationSnapshot, validationV1);

    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    assert.deepEqual(claim.validationSnapshot, validationV1);
  } finally {
    f.close();
  }
});

test("deterministic dispatch rejection becomes durable blocked work instead of retrying forever", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-forbidden-deployment",
      deploymentId: "disabled-or-missing-deployment",
    });

    assert.equal(detail.work.status, "blocked");
    assert.equal(detail.work.blockedReason, "policy_blocked");
    assert.match(detail.work.blockedContext ?? "", /DEPLOYMENT_FORBIDDEN/);
    assert.equal(detail.attempts.length, 0);
    assert.equal(detail.currentTask, null);
    assert.deepEqual(f.orchestrator.reconcileActive(Date.now() + 10_000, 100), []);
  } finally {
    f.close();
  }
});

test("submitWork creates one WorkAttempt and one linked ExpertTask and reuses them idempotently", () => {
  const f = fixture();
  try {
    const first = f.orchestrator.submitWork(submission);
    assert.equal(first.work.status, "running");
    assert.equal(first.attempts.length, 1);
    assert.ok(first.currentTask);
    assert.equal(first.currentTask!.workItemId, first.work.workItemId);
    assert.equal(first.currentTask!.workAttemptId, first.attempts[0]!.workAttemptId);
    const workspace = f.work.getWorkspace(first.attempts[0]!.workspaceId!);
    assert.equal(first.currentTask!.workspaceKey, workspace.workspaceKey);

    const replay = f.orchestrator.submitWork(submission);
    assert.equal(replay.work.workItemId, first.work.workItemId);
    assert.equal(replay.attempts.length, 1);
    assert.equal(replay.currentTask!.taskId, first.currentTask!.taskId);
  } finally {
    f.close();
  }
});

test("reconciliation recovers an attempt created before its deterministic task link without duplicate dispatch", () => {
  const f = fixture();
  try {
    const work = f.work.createOrReuseWork(submission);
    const attempt = f.work.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    assert.equal(attempt.taskId, null);

    const recovered = f.orchestrator.reconcileWork(work.workItemId, "alice", "team-a");
    assert.equal(recovered.attempts.length, 1);
    assert.ok(recovered.currentTask);
    assert.equal(recovered.currentTask!.workAttemptId, attempt.workAttemptId);

    const again = f.orchestrator.reconcileWork(work.workItemId, "alice", "team-a");
    assert.equal(again.currentTask!.taskId, recovered.currentTask!.taskId);
    assert.equal(f.work.listAttempts(work.workItemId).length, 1);
  } finally {
    f.close();
  }
});

test("cancelWork cancels the linked task and closes the active WorkAttempt", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const cancelled = f.orchestrator.cancelWork(detail.work.workItemId, "alice", "team-a", 2_000);
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(cancelled.work.activeWorkAttemptId, null);
    assert.equal(cancelled.attempts[0]!.status, "cancelled");
    assert.equal(cancelled.currentTask!.status, "cancelled");
  } finally {
    f.close();
  }
});
test("active reconciliation advances completed tasks without a client read", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-active-reconcile" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "background result", 2_000, { commitSha: "c".repeat(40) });

    const processed = f.orchestrator.reconcileActive(3_000, 100);

    assert.deepEqual(processed, [detail.work.workItemId]);
    const persisted = f.work.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(persisted.status, "waiting_review");
  } finally {
    f.close();
  }
});

test("startup reconciliation recovers durable work after stores reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-restart-"));
  const db = path.join(dir, "runtime.sqlite");
  let experts = new ExpertStore(db);
  let tasks = new ExpertTaskStore(db);
  let work = new WorkOrchestrationStore(db);
  try {
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota", "upgrade"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    let orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const detail = orchestrator.submitWork({ ...submission, idempotencyKey: "work-restart-reconcile" });
    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    tasks.complete(claim, "completed while hub is restarting", 2_000, { commitSha: "d".repeat(40) });

    work.close();
    tasks.close();
    experts.close();

    experts = new ExpertStore(db);
    tasks = new ExpertTaskStore(db);
    work = new WorkOrchestrationStore(db);
    orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));

    const processed = orchestrator.reconcileStartup(3_000, 100);

    assert.ok(processed.includes(detail.work.workItemId));
    assert.equal(work.getWork(detail.work.workItemId, "alice", "team-a").status, "waiting_review");
  } finally {
    work.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful task becomes revision-bound evidence then accepted review completes work", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "read-only OTA result", 2_000, {
      repositoryUrl: "https://example.test/ota.git",
      repositoryBranch: "main",
      commitSha: "a".repeat(40),
    });

    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.status, "waiting_review");
    assert.equal(waiting.attempts[0]!.status, "succeeded");
    assert.equal(waiting.evidence.length, 1);
    assert.equal(waiting.evidence[0]!.type, "expert_result");
    assert.equal(waiting.evidence[0]!.subjectRevision, "a".repeat(40));
    assert.equal(waiting.gate.ready, false);
    const workspace = f.work.getWorkspace(waiting.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      3_100,
      "a".repeat(40),
    );

    const completed = f.orchestrator.submitReview(detail.work.workItemId, "alice", "team-a", {
      expectedRevision: waiting.work.stateRevision,
      subjectRevision: "a".repeat(40),
      decision: "accepted",
    });
    assert.equal(completed.work.status, "completed");
    assert.equal(completed.gate.ready, true);
    assert.equal(f.work.getWorkspace(workspace.workspaceId).state, "cleaning");
    const cleanup = f.work.claimWorkspaceCleanup("worker-a", 4_000, 30_000)!;
    f.work.completeWorkspaceCleanup(cleanup.workspaceId, "worker-a", cleanup.fencing, false, "DELETE_FAILED", 4_100);
    assert.equal(f.work.getWorkspace(workspace.workspaceId).state, "failed");
    assert.equal(f.work.getWork(detail.work.workItemId, "alice", "team-a").status, "completed");
  } finally {
    f.close();
  }
});

test("rework feedback replay creates exactly one new WorkAttempt", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const taskId = detail.currentTask!.taskId;
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "result", 2_000, { commitSha: "b".repeat(40) });
    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.status, "waiting_review");

    const feedback = { disposition: "partially_adopted" as const, reason: "补验证", needsRework: true };
    const reworked = f.orchestrator.handleTaskFeedback(taskId, "alice", "team-a", feedback, 4_000)!;
    assert.equal(reworked.attempts.length, 2);
    assert.equal(reworked.attempts[1]!.reason, "human_rework");
    assert.equal(reworked.work.status, "running");

    const replay = f.orchestrator.handleTaskFeedback(taskId, "alice", "team-a", feedback, 5_000)!;
    assert.equal(replay.attempts.length, 2);
    assert.equal(replay.currentTask!.taskId, reworked.currentTask!.taskId);
  } finally {
    f.close();
  }
});

test("continuation fails closed when the workspace owner is unavailable", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation-no-owner" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "first result", 2_000, { commitSha: "f".repeat(40) });

    const blocked = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verification_failed",
      3_000,
    );
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedReason, "workspace_unavailable");
    assert.equal(blocked.work.nextActionType, null);
    assert.equal(blocked.currentTask!.status, "succeeded");
  } finally {
    f.close();
  }
});

test("durable continuation reuses the same WorkAttempt and ExpertTask but creates a new Run", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation" });
    const attemptId = detail.attempts[0]!.workAttemptId;
    const taskId = detail.currentTask!.taskId;
    const firstClaim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(firstClaim, "first result", 2_000, { commitSha: "f".repeat(40) });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      2_100,
      "f".repeat(40),
    );

    const scheduled = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verification_failed",
      3_000,
    );
    assert.equal(scheduled.work.status, "running");
    assert.equal(scheduled.work.nextActionType, "continuation");
    assert.equal(scheduled.work.nextActionContext, "verification_failed");
    assert.equal(scheduled.attempts.length, 1);
    assert.equal(scheduled.attempts[0]!.workAttemptId, attemptId);
    assert.equal(scheduled.currentTask!.taskId, taskId);
    assert.equal(scheduled.currentTask!.status, "succeeded");

    f.orchestrator.reconcileDue(3_000);
    const requeued = f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(requeued.work.nextActionType, null);
    assert.equal(requeued.work.nextActionContext, null);
    assert.equal(requeued.attempts.length, 1);
    assert.equal(requeued.attempts[0]!.workAttemptId, attemptId);
    assert.equal(requeued.currentTask!.taskId, taskId);
    assert.equal(requeued.currentTask!.status, "queued");
    assert.equal(requeued.currentTask!.continuationCount, 1);

    const secondClaim = f.tasks.claim("worker-a", 3_001, 30_000, "ota")!;
    assert.equal(secondClaim.taskId, taskId);
    assert.notEqual(secondClaim.runId, firstClaim.runId);
    assert.ok(secondClaim.fencing > firstClaim.fencing);
  } finally {
    f.close();
  }
});

test("continuation respects the workflow agent-turn budget", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation-limit" });
    let claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "turn-1", 2_000, { commitSha: "e".repeat(40) });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      2_100,
      "e".repeat(40),
    );

    for (let continuation = 1; continuation <= 19; continuation++) {
      const now = 3_000 + continuation * 10;
      f.orchestrator.requestContinuation(detail.work.workItemId, "alice", "team-a", "continue-" + continuation, now);
      f.orchestrator.reconcileDue(now);
      claim = f.tasks.claim("worker-a", now + 1, 30_000, "ota")!;
      f.tasks.complete(claim, "turn-" + (continuation + 1), now + 2, { commitSha: "e".repeat(40) });
    }

    assert.equal(f.tasks.get(detail.currentTask!.taskId, "alice", "team-a").continuationCount, 19);
    assert.throws(
      () => f.orchestrator.requestContinuation(detail.work.workItemId, "alice", "team-a", "one-too-many", 10_000),
      /WORK_CONTINUATION_LIMIT_REACHED/,
    );
  } finally {
    f.close();
  }
});

test("transient task failure schedules durable retry and reuses the same ExpertTask with a new Run", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const taskId = detail.currentTask!.taskId;
    const firstClaim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.fail(firstClaim, "TEMPORARY_NETWORK_ERROR", 2_000);

    const scheduled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(scheduled.work.status, "running");
    assert.equal(scheduled.work.nextActionType, "failure_retry");
    assert.ok((scheduled.work.nextActionAt ?? 0) > 3_000);

    f.orchestrator.reconcileDue((scheduled.work.nextActionAt ?? 0) + 1);
    assert.equal(f.tasks.get(taskId, "alice", "team-a").status, "queued");
    const secondClaim = f.tasks.claim("worker-a", (scheduled.work.nextActionAt ?? 0) + 2, 30_000, "ota")!;
    assert.equal(secondClaim.taskId, taskId);
    assert.notEqual(secondClaim.runId, firstClaim.runId);
    assert.ok(secondClaim.fencing > firstClaim.fencing);
  } finally {
    f.close();
  }
});

test("permission blocker is durable and does not retry", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.fail(claim, "MISSING_PERMISSION", 2_000);
    const blocked = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedReason, "missing_permission");
    assert.equal(blocked.work.nextActionAt, null);
  } finally {
    f.close();
  }
});
