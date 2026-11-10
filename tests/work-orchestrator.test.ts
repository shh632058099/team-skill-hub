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

test("submitWork creates one WorkAttempt and one linked ExpertTask and reuses them idempotently", () => {
  const f = fixture();
  try {
    const first = f.orchestrator.submitWork(submission);
    assert.equal(first.work.status, "running");
    assert.equal(first.attempts.length, 1);
    assert.ok(first.currentTask);
    assert.equal(first.currentTask!.workItemId, first.work.workItemId);
    assert.equal(first.currentTask!.workAttemptId, first.attempts[0]!.workAttemptId);

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

    const completed = f.orchestrator.submitReview(detail.work.workItemId, "alice", "team-a", {
      expectedRevision: waiting.work.stateRevision,
      subjectRevision: "a".repeat(40),
      decision: "accepted",
    });
    assert.equal(completed.work.status, "completed");
    assert.equal(completed.gate.ready, true);
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
