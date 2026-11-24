import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExpertStore, type ExpertSourceRepository } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkDagScheduler } from "../src/expert-platform/work-dag-engine.js";
import { createExpertTaskDagAdapters } from "../src/expert-platform/work-dag-expert-adapters.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

function fixture(reviewerExpertId?: string) {
  const dir = mkdtempSync(join(tmpdir(), "dag-review-adapter-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const works = new WorkOrchestrationStore(file);
  experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
  if (reviewerExpertId) {
    experts.putDefinition({
      id: reviewerExpertId,
      displayName: "Reviewer",
      capabilities: ["review"],
      keywords: ["review"],
      active: true,
    });
  }
  experts.putDeployment({
    id: "ota-ro",
    expertId: "ota",
    repositoryIds: ["repo"],
    repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
    principals: ["alice"],
    runtimeProfile: "codex-readonly",
    active: true,
    executor: {
      backend: "codex",
      modelConfig: {
        providerId: "router",
        model: "test",
        baseUrl: "https://router.example/v1",
        wireApi: "responses",
        allowedEnvNames: ["OPENAI_API_KEY"],
      },
    },
  });
  if (reviewerExpertId) {
    experts.putDeployment({
      id: "reviewer-ro",
      expertId: reviewerExpertId,
      repositoryIds: ["repo"],
      repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "review",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
  }
  const base = works.getWorkflow("investigation").definition;
  works.putWorkflow("dynamic-review", 1, {
    ...structuredClone(base),
    validation: { requiredEvidence: [], required: [] },
    review: { required: true, ...(reviewerExpertId ? { reviewerExpertId } : {}) },
    completion: { require: ["latest_work_attempt_succeeded", "no_unresolved_blocker", "review_accepted"] },
    graph: { mode: "dynamic-dag" },
  });
  const work = works.createOrReuseWork({
    principalId: "alice",
    scope: "team",
    idempotencyKey: "w",
    sourceType: "mcp",
    title: "t",
    description: "review me",
    workflowId: "dynamic-review",
    expertId: "ota",
    deploymentId: "ota-ro",
    repositoryId: "repo",
  });
  works.ensureRequirementSnapshot(work.workItemId);
  const dispatch = new ExpertDispatchService(experts, tasks);
  const resolved = dispatch.resolve({
    principalId: "alice",
    scope: "team",
    problem: "review me",
    expertId: "ota",
    selectionMode: "explicit",
    repositoryId: "repo",
    deploymentId: "ota-ro",
    requiredWorkspaceAccess: "read-only",
  });
  let current = works.getWorkInternal(work.workItemId);
  const attempt = works.createWorkAttempt(
    work.workItemId,
    "alice",
    "team",
    current.stateRevision,
    {
      reason: "initial",
      expertId: resolved.expertId,
      deploymentId: resolved.deploymentId,
      deploymentConfigVersion: resolved.deploymentConfigVersion,
      dispatchBinding: resolved as unknown as Record<string, unknown>,
    },
    10,
  );
  works.ensureWorkspace(
    work.workItemId,
    attempt.workAttemptId,
    { repositoryUrl: "https://example.test/repo.git", branch: "main" },
    11,
  );
  if (reviewerExpertId) {
    const workspace = works.getWorkspace(works.getWorkAttempt(attempt.workAttemptId).workspaceId!);
    works.assignWorkspaceOwner(workspace.workspaceId, "worker-1", "/tmp/dag-review-workspace", 11, "a".repeat(40));
  }
  current = works.getWorkInternal(work.workItemId);
  works.setCurrentSubjectRevision(work.workItemId, "alice", "team", current.stateRevision, "subject-v1", 12);
  return { dir, experts, tasks, works, dispatch, workId: work.workItemId, attemptId: attempt.workAttemptId };
}

function installReview(works: WorkOrchestrationStore, workId: string) {
  const graph: DagGraph = {
    nodes: [
      {
        id: "review",
        kind: "review",
        capability: "review",
        subject: "subject-v1",
        resource: "workspace",
        mutates: false,
        requirements: [],
      },
    ],
    edges: [],
  };
  const input = works.getDagPlannerInput(workId);
  const proposal = works.submitDagProposal(
    {
      workItemId: workId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: input.frozen.workRevision,
      expectedDagRevision: input.frozen.dagRevision,
      expectedRequirementRevision: input.frozen.requirementRevision,
      plannerIdentity: "p",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "review",
      graph,
    },
    20,
  );
  assert.equal(proposal.status, "accepted");
}

test("conditional code-change can start with an agent review and complete the no-change branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-initial-review-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const works = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
    experts.putDefinition({
      id: "reviewer",
      displayName: "Reviewer",
      capabilities: ["review"],
      keywords: ["review"],
      active: true,
    });
    const repository: ExpertSourceRepository = {
      id: "repo",
      url: "https://example.test/repo.git",
      branch: "main",
      publicationPolicy: {
        version: 1,
        permissions: ["prepare-commit", "push-work-branch", "create-change-request"],
        branchPrefix: "work/",
        protectedBranches: ["main"],
        allowedPushRemote: "origin" as const,
        allowForcePush: false,
        allowDeleteRef: false,
      },
    };
    experts.putDeployment({
      id: "ota-write",
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [repository],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "write",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    experts.putDeployment({
      id: "reviewer-ro",
      expertId: "reviewer",
      repositoryIds: ["repo"],
      repositories: [repository],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "review",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    const base = works.getWorkflow("bug-fix").definition;
    works.putWorkflow("conditional-review", 1, {
      ...structuredClone(base),
      change: { mode: "conditional_code_change" },
      validation: { requiredEvidence: ["build", "unit_test"], required: [] },
      review: { required: true, reviewerExpertId: "reviewer" },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
        ],
      },
      planning: { maxReplans: 10, replanPolicy: ["on_failure", "on_review_rework", "always_after_agent_turn"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = works.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "conditional-review",
      sourceType: "mcp",
      title: "review first",
      description: "review first, fix only if a blocking issue exists, then verify",
      workflowId: "conditional-review",
      expertId: "ota",
      deploymentId: "ota-write",
      repositoryId: "repo",
    });
    works.ensureRequirementSnapshot(work.workItemId);
    const input = works.getDagPlannerInput(work.workItemId);
    assert.equal(
      works.submitDagProposal({
        workItemId: work.workItemId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "seed",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: {
          nodes: [
            {
              id: "review-initial",
              kind: "review",
              capability: "review",
              subject: null,
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
          ],
          edges: [],
        },
      }).status,
      "accepted",
    );

    const scheduler = new WorkDagScheduler(
      works,
      createExpertTaskDagAdapters(works, tasks, new ExpertDispatchService(experts, tasks)),
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 20), true);
    const attempt = works.getActiveAttempt(work.workItemId)!;
    assert.equal(attempt.deploymentId, "ota-write");
    assert.equal(attempt.taskId, null);
    const execution = works.listDagExecutions(work.workItemId)[0]!;
    const reviewTask = tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    assert.ok(reviewTask);
    assert.equal(reviewTask.expertId, "reviewer");
    assert.equal(reviewTask.requiredWorkerId, null);
    assert.equal(works.getAttemptByTask(reviewTask.taskId)?.workAttemptId, attempt.workAttemptId);

    const claim = tasks.claim("worker-1", 21, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(claim.problem, /Do not query, wait on, submit, cancel, update, or otherwise control this WorkItem/i);
    assert.match(claim.problem, /Skill\/Knowledge lookup/i);
    tasks.complete(claim, JSON.stringify({ decision: "accepted", reason: "no blocking findings" }), 22, {
      repositoryUrl: "https://example.test/repo.git",
      repositoryBranch: "main",
      commitSha: "a".repeat(40),
    });
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 23), true);
    const current = works.getWorkInternal(work.workItemId);
    assert.equal(current.currentSubjectRevision, "a".repeat(40));
    assert.equal(works.getActiveAttempt(work.workItemId), null);
    assert.equal(works.getWorkAttempt(attempt.workAttemptId).status, "succeeded");
    assert.equal(works.getDagContext(work.workItemId).facts["review.accepted"], true);
    assert.equal(works.getDagContext(work.workItemId).facts["workspace.changed"], false);

    experts.putDeployment({
      id: "ota-ro",
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [repository],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "review",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    works.putWorkflow("conditional-auto-review", 1, {
      ...structuredClone(base),
      change: { mode: "conditional_code_change" },
      validation: { requiredEvidence: ["build", "unit_test"], required: [] },
      review: { required: true },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
        ],
      },
      planning: { maxReplans: 10, replanPolicy: ["on_failure", "on_review_rework", "always_after_agent_turn"] },
      graph: { mode: "dynamic-dag" },
    });
    const autoWork = works.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "conditional-auto-review",
      sourceType: "mcp",
      title: "auto review first",
      description: "review first, fix only if needed, then verify",
      workflowId: "conditional-auto-review",
      expertId: "ota",
      deploymentId: "ota-write",
      repositoryId: "repo",
    });
    works.ensureRequirementSnapshot(autoWork.workItemId);
    const autoInput = works.getDagPlannerInput(autoWork.workItemId);
    assert.equal(
      works.submitDagProposal({
        workItemId: autoWork.workItemId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: autoInput.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: autoInput.frozen.requirementRevision,
        plannerIdentity: "seed",
        plannerVersion: "1",
        plannerInputDigest: autoInput.digest,
        reasonCode: "initial",
        graph: {
          nodes: [
            {
              id: "review-auto",
              kind: "review",
              capability: "review",
              subject: null,
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
          ],
          edges: [],
        },
      }).status,
      "accepted",
    );
    assert.equal(await scheduler.runOne(autoWork.workItemId, "alice", "team", "hub", 30), true);
    const autoAttempt = works.getActiveAttempt(autoWork.workItemId)!;
    assert.equal(autoAttempt.expertId, "ota");
    assert.equal(autoAttempt.deploymentId, "ota-write");
    const autoExecution = works.listDagExecutions(autoWork.workItemId)[0]!;
    const autoReviewTask = tasks.getByIdempotency("alice", "team", "dag:" + autoExecution.idempotencyKey)!;
    assert.equal(autoReviewTask.expertId, "ota");
    assert.equal(autoReviewTask.deploymentId, "ota-ro");
  } finally {
    works.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human review node waits durably, accepts decision and finishes candidate Attempt", async () => {
  const f = fixture();
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    let work = f.works.getWorkInternal(f.workId);
    assert.equal(work.status, "waiting_review");
    assert.equal(work.activeWorkAttemptId, null);
    assert.equal(f.works.getWorkAttempt(f.attemptId).status, "succeeded");

    f.works.submitReviewDecision(
      f.workId,
      "alice",
      "team",
      {
        expectedRevision: work.stateRevision,
        subjectRevision: "subject-v1",
        decision: "accepted",
        actorPrincipalId: "alice",
      },
      40,
    );
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 41), true);
    work = f.works.getWorkInternal(f.workId);
    assert.equal(work.status, "running");
    assert.equal(f.works.listDagExecutions(f.workId)[0]?.state, "succeeded");
    assert.equal(f.works.getDagContext(f.workId).facts["review.accepted"], true);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("configured reviewerExpertId dispatches a read-only reviewer task and records its decision", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const execution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const reviewTask = f.tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    assert.ok(reviewTask);
    assert.equal(reviewTask.expertId, "reviewer");
    assert.equal(reviewTask.executionKind, "agent");
    assert.equal(reviewTask.requiredWorkerId, "worker-1");
    assert.deepEqual(reviewTask.validationSnapshot, []);
    assert.equal(f.works.getActiveAttempt(f.workId)?.workAttemptId, f.attemptId);

    const claim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.complete(claim, JSON.stringify({ decision: "accepted", reason: "looks good" }), 32);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 33), true);
    assert.equal(f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")?.state, "succeeded");
    assert.equal(f.works.getWorkAttempt(f.attemptId).status, "succeeded");
    assert.equal(f.works.getActiveAttempt(f.workId), null);
    const decision = f.works.listReviewDecisions(f.workId).at(-1)!;
    assert.equal(decision.decision, "accepted");
    assert.equal(decision.actorPrincipalId, "agent:reviewer");
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("invalid reviewer output retries as continuation of the same review task", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    await scheduler.runOne(f.workId, "alice", "team", "hub", 30);
    const execution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const reviewTask = f.tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    const claim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.complete(claim, "not-json", 32);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 33), true);
    assert.equal(f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")?.state, "failed");

    const retry = f.works.retryDagNode(f.workId, "review", "executor_failure", 34);
    assert.equal(retry.generation, 2);
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 35), true);
    const continued = f.tasks.get(reviewTask.taskId, "alice", "team");
    assert.equal(continued.status, "queued");
    assert.equal(continued.taskId, reviewTask.taskId);
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, reviewTask.taskId);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reviewer task failure is retried on the same WorkAttempt without a second reviewTask link", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    await scheduler.runOne(f.workId, "alice", "team", "hub", 30);
    const firstExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const reviewTask = f.tasks.getByIdempotency("alice", "team", "dag:" + firstExecution.idempotencyKey)!;
    const claim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.fail(claim, "review crashed", 32);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 33), true);
    assert.equal(f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")?.state, "failed");
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, reviewTask.taskId);

    const input = f.works.getDagPlannerInput(f.workId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "review-retry",
          kind: "review",
          capability: "review",
          subject: "subject-v1",
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const proposal = f.works.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "failure",
        graph,
      },
      40,
    );
    assert.equal(proposal.status, "accepted");
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 41), true);
    const retried = f.tasks.get(reviewTask.taskId, "alice", "team");
    assert.equal(retried.status, "queued");
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, reviewTask.taskId);
    const retryExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review-retry")!;
    assert.equal(f.tasks.getByIdempotency("alice", "team", "dag:" + retryExecution.idempotencyKey), null);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("review rework creates a new review_rework WorkAttempt on the next Agent node", async () => {
  const f = fixture();
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    await scheduler.runOne(f.workId, "alice", "team", "hub", 30);
    let work = f.works.getWorkInternal(f.workId);
    f.works.submitReviewDecision(
      f.workId,
      "alice",
      "team",
      {
        expectedRevision: work.stateRevision,
        subjectRevision: "subject-v1",
        decision: "rework",
        reason: "fix review issue",
        actorPrincipalId: "alice",
      },
      40,
    );
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 41), true);
    work = f.works.getWorkInternal(f.workId);
    assert.equal(work.status, "rework");
    assert.equal(f.works.listDagExecutions(f.workId)[0]?.state, "failed");

    const nextInput = f.works.getDagPlannerInput(f.workId);
    const nextGraph: DagGraph = {
      nodes: [
        {
          id: "agent-rework",
          kind: "agent",
          capability: "analysis",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const proposal = f.works.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: nextInput.frozen.workRevision,
        expectedDagRevision: nextInput.frozen.dagRevision,
        expectedRequirementRevision: nextInput.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: nextInput.digest,
        reasonCode: "review_rework",
        graph: nextGraph,
      },
      50,
    );
    assert.equal(proposal.status, "accepted");
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 51), true);
    const latest = f.works.listAttempts(f.workId).at(-1)!;
    assert.equal(latest.reason, "review_rework");
    assert.equal(latest.parentWorkAttemptId, f.attemptId);
    assert.equal(latest.whatShouldChange, "fix review issue");
    const repairClaim = f.tasks.claim("worker", 52, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(repairClaim.problem, /fix review issue/);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
