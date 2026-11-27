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
import { workflowOnlyDagPolicyContext } from "../src/expert-platform/work-dag-policy-context.js";
import { createExpertTaskDagAdapters } from "../src/expert-platform/work-dag-expert-adapters.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

function fixture(
  reviewerExpertId?: string,
  reviewerRuntimeProfile: "codex-readonly" | "codex-workspace-write" = "codex-readonly",
) {
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
    repositoryIds: ["repo", "repo-b"],
    repositories: [
      { id: "repo", url: "https://example.test/repo.git", branch: "main" },
      { id: "repo-b", url: "https://example.test/repo-b.git", branch: "main" },
    ],
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
      repositoryIds: ["repo", "repo-b"],
      repositories: [
        { id: "repo", url: "https://example.test/repo.git", branch: "main" },
        { id: "repo-b", url: "https://example.test/repo-b.git", branch: "main" },
      ],
      principals: ["alice"],
      runtimeProfile: reviewerRuntimeProfile,
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

function installReview(
  works: WorkOrchestrationStore,
  workId: string,
  subject = "subject-v1",
  resource = "workspace",
  nodeId = "review",
) {
  const graph: DagGraph = {
    nodes: [
      {
        id: nodeId,
        kind: "review",
        capability: "review",
        subject,
        resource,
        mutates: false,
        requirements: [],
      },
    ],
    edges: [],
  };
  const input = works.getDagPlannerInput(workId);
  const work = works.getWorkInternal(workId);
  const workflow = works.getWorkflow(work.workflowId, work.workflowVersion);
  const basePolicyContext = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
  const policyContext = resource.startsWith("repo:")
    ? {
        ...basePolicyContext,
        resourcePolicies: {
          [resource]: {
            repository: {
              repositoryId: resource.slice("repo:".length),
              policyDigest: "test-review-repository",
              verificationCapabilities: ["*"],
              publicationPermissions: [],
            },
            deployment: {
              deploymentId: "test-review-deployment",
              configVersion: 1,
              expertId: "reviewer",
              runtimeProfile: "codex-readonly",
              digest: "test-review-deployment",
            },
            executorCapabilities: {
              agent: ["*"],
              verification: ["*"],
              review: ["review"],
              approval: ["*"],
              publication: ["*"],
              change_request: ["*"],
              wait: ["*"],
              external_action: ["*"],
            },
          },
        },
      }
    : basePolicyContext;
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
      policyContext,
      graph,
    },
    20,
  );
  assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));
}

test("review node can use a read-write deployment for a read-only review task", async () => {
  const f = fixture("reviewer", "codex-workspace-write");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const execution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const task = f.tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey);
    assert.ok(task);
    assert.equal(task.deploymentSnapshot?.runtimeProfile, "codex-workspace-write");
    assert.equal(task.executionWorkspaceAccess, "read-only");
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("agent review prompt uses the current RequirementSnapshot authority", async () => {
  const f = fixture("reviewer");
  try {
    const before = f.works.getWorkInternal(f.workId);
    const snapshot = f.works.getRequirementSnapshot(f.workId, before.currentRequirementRevision);
    const updated = f.works.updateRequirementSnapshot(
      f.workId,
      "alice",
      "team",
      before.stateRevision,
      snapshot.revision,
      [
        {
          id: "user:snapshot-specialist",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "snapshot-specialist", equals: true },
        },
      ],
      "test",
      15,
    );
    assert.equal(updated.snapshot.revision, 2);

    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const claim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(claim.problem, /RequirementSnapshot revision: 2/);
    assert.match(claim.problem, /snapshot-specialist/);
    assert.match(claim.problem, /Original request:\s*review me/);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

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
      execution: {
        ...structuredClone(base.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
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

test("agent review result is rejected when the reviewed subject changes before reconciliation", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const execution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    assert.ok(f.tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey));
    const claim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.complete(claim, JSON.stringify({ decision: "accepted", reason: "looks good" }), 32);
    const current = f.works.getWorkInternal(f.workId);
    f.works.setCurrentSubjectRevision(f.workId, "alice", "team", current.stateRevision, "subject-v2", 33);

    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 34), true);
    const reviewed = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    assert.equal(reviewed.state, "failed");
    assert.equal(reviewed.result?.summary, "STALE_REVIEW_SUBJECT");
    assert.equal(f.works.listReviewDecisions(f.workId).length, 0);
    assert.equal(f.works.getWorkInternal(f.workId).currentSubjectRevision, "subject-v2");
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("stale succeeded agent review is rerun before it can authorize a newer subject", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const firstExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const reviewTask = f.tasks.getByIdempotency("alice", "team", "dag:" + firstExecution.idempotencyKey)!;
    const firstClaim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.complete(firstClaim, JSON.stringify({ decision: "accepted", reason: "old subject is fine" }), 32);

    let current = f.works.getWorkInternal(f.workId);
    f.works.setCurrentSubjectRevision(f.workId, "alice", "team", current.stateRevision, "subject-v2", 33);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 34), true);
    assert.equal(
      f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")?.result?.summary,
      "STALE_REVIEW_SUBJECT",
    );
    assert.equal(f.tasks.get(reviewTask.taskId, "alice", "team").status, "succeeded");

    installReview(f.works, f.workId, "subject-v2", "workspace", "review-v2");
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 40), true);

    const rerun = f.tasks.get(reviewTask.taskId, "alice", "team");
    assert.equal(rerun.status, "queued");
    assert.equal(rerun.continuationCount, 1);
    const secondClaim = f.tasks.claim("worker-1", 41, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(secondClaim.problem, /dag:review-v2/);
    f.tasks.complete(secondClaim, JSON.stringify({ decision: "accepted", reason: "new subject is fine" }), 42);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 43), true);
    assert.equal(f.works.getDagContext(f.workId).facts["review.accepted"], true);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("failed review generation reuses the WorkAttempt review task on DAG retry", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const firstExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const firstTask = f.tasks.getByIdempotency("alice", "team", "dag:" + firstExecution.idempotencyKey)!;
    const firstClaim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.fail(firstClaim, "REPOSITORY_PREPARATION_FAILED", 32);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 33), true);
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, firstTask.taskId);

    f.works.retryDagNode(f.workId, "review", "executor_failure:EXECUTION_FAILED", 34);
    const retryExecution = f.works
      .listDagExecutions(f.workId)
      .find((item) => item.nodeId === "review" && item.generation === 2)!;
    assert.equal(retryExecution.state, "pending");
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 36), true);
    const owned = f.tasks.get(firstTask.taskId, "alice", "team");
    assert.equal(owned.status, "queued");
    assert.equal(owned.executionRef, retryExecution.idempotencyKey);
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, firstTask.taskId);
    assert.equal(
      f.tasks.listByWorkAttempt(f.attemptId, "alice", "team").filter((task) => task.executionKind === "agent").length,
      1,
    );
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("agent review task is not reused across repository resources in one WorkAttempt", async () => {
  const f = fixture("reviewer");
  try {
    installReview(f.works, f.workId);
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const firstExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const firstTask = f.tasks.getByIdempotency("alice", "team", "dag:" + firstExecution.idempotencyKey)!;
    const firstClaim = f.tasks.claim("worker-1", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    f.tasks.fail(firstClaim, "review crashed", 32);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 33), true);
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, firstTask.taskId);

    f.works.setDagResourceSubject(f.workId, "repo:repo-b", "subject-b", 34);
    const workspaceB = f.works.ensureWorkspace(
      f.workId,
      f.attemptId,
      {
        resourceKey: "repo:repo-b",
        repositoryId: "repo-b",
        repositoryUrl: "https://example.test/repo-b.git",
        branch: "main",
      },
      35,
    );
    f.works.assignWorkspaceOwner(workspaceB.workspaceId, "worker-2", "/tmp/dag-review-repo-b", 36, "b".repeat(40));
    installReview(f.works, f.workId, "subject-b", "repo:repo-b", "review-b");

    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 40), true);
    const secondExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review-b")!;
    const secondTask = f.tasks.getByIdempotency("alice", "team", "dag:" + secondExecution.idempotencyKey);
    assert.ok(secondTask);
    assert.notEqual(secondTask.taskId, firstTask.taskId);
    assert.equal(secondTask.repositoryId, "repo-b");
    assert.equal(secondTask.workspaceKey, workspaceB.workspaceKey);
    assert.equal(secondTask.requiredWorkerId, "worker-2");
    assert.equal(secondExecution.state, "running");
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, firstTask.taskId);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("repo-scoped agent review stays valid when another repository subject changes", async () => {
  const f = fixture("reviewer");
  try {
    f.works.setDagResourceSubject(f.workId, "repo:repo-b", "subject-b1", 24);
    f.works.setDagResourceSubject(f.workId, "repo:repo", "subject-v1", 25);
    const compositeBeforeReview = f.works.getWorkInternal(f.workId).currentSubjectRevision;
    const resourceWorkspace = f.works.ensureWorkspace(
      f.workId,
      f.attemptId,
      {
        resourceKey: "repo:repo",
        repositoryId: "repo",
        repositoryUrl: "https://example.test/repo.git",
        branch: "main",
      },
      26,
    );
    f.works.assignWorkspaceOwner(
      resourceWorkspace.workspaceId,
      "worker-2",
      "/tmp/dag-review-repo-workspace",
      27,
      "b".repeat(40),
    );
    installReview(f.works, f.workId, "subject-v1", "repo:repo");
    const scheduler = new WorkDagScheduler(f.works, createExpertTaskDagAdapters(f.works, f.tasks, f.dispatch));
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 30), true);
    const execution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    const reviewTask = f.tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    assert.equal(reviewTask.requiredWorkerId, "worker-2");
    assert.equal(reviewTask.repositoryId, "repo");
    const claim = f.tasks.claim("worker-2", 31, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    const result = JSON.stringify({ decision: "accepted", reason: "repo looks good" });
    f.tasks.complete(claim, result, 32);
    f.works.setDagResourceSubject(f.workId, "repo:repo-b", "subject-b2", 33);
    const compositeAfterOtherRepoChange = f.works.getWorkInternal(f.workId).currentSubjectRevision;
    assert.notEqual(compositeAfterOtherRepoChange, compositeBeforeReview);
    assert.equal(await scheduler.reconcileOne(f.workId, "alice", "team", "hub", 34), true);
    const current = f.works.getWorkInternal(f.workId);
    const reviewExecution = f.works.listDagExecutions(f.workId).find((item) => item.nodeId === "review")!;
    assert.equal(reviewExecution.state, "succeeded");
    assert.notEqual(reviewExecution.result?.summary, "STALE_REVIEW_SUBJECT");
    assert.equal(f.works.listDagResourceSubjects(f.workId)["repo:repo"], "subject-v1");
    assert.equal(current.currentSubjectRevision, compositeAfterOtherRepoChange);
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

    const current = f.works.getWorkInternal(f.workId);
    const snapshot = f.works.getRequirementSnapshot(f.workId, current.currentRequirementRevision);
    f.works.updateRequirementSnapshot(
      f.workId,
      "alice",
      "team",
      current.stateRevision,
      snapshot.revision,
      [
        {
          id: "user:review-snapshot-v2",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "review-snapshot-v2", equals: true },
        },
      ],
      "test",
      34,
    );

    const revalidationInput = f.works.getDagPlannerInput(f.workId);
    const currentGraph = f.works.getDagRevision(f.workId, revalidationInput.frozen.dagRevision).graph;
    const revalidation = f.works.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: revalidationInput.frozen.workRevision,
        expectedDagRevision: revalidationInput.frozen.dagRevision,
        expectedRequirementRevision: revalidationInput.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: revalidationInput.digest,
        reasonCode: "user_update",
        graph: currentGraph,
      },
      35,
    );
    assert.equal(revalidation.status, "noop");
    const retry = f.works.retryDagNode(f.workId, "review", "executor_failure", 36);
    assert.equal(retry.generation, 2);
    assert.equal(await scheduler.runOne(f.workId, "alice", "team", "hub", 37), true);
    const continued = f.tasks.get(reviewTask.taskId, "alice", "team");
    assert.equal(continued.status, "queued");
    assert.equal(continued.taskId, reviewTask.taskId);
    assert.equal(f.works.getActiveAttempt(f.workId)?.reviewTaskId, reviewTask.taskId);
    const retryClaim = f.tasks.claim("worker-1", 38, 1000, "reviewer", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(retryClaim.problem, /RequirementSnapshot revision: 2/);
    assert.match(retryClaim.problem, /review-snapshot-v2/);
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
    const parentWorkspace = f.works.getWorkspaceForResource(f.attemptId, "workspace");
    const reworkWorkspace = f.works.getWorkspaceForResource(latest.workAttemptId, "workspace");
    assert.equal(reworkWorkspace?.workspaceId, parentWorkspace?.workspaceId);
    assert.equal(reworkWorkspace?.workspaceKey, parentWorkspace?.workspaceKey);
    const repairClaim = f.tasks.claim("worker", 52, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(repairClaim.problem, /fix review issue/);
    assert.equal(repairClaim.workspaceKey, parentWorkspace?.workspaceKey);
  } finally {
    f.works.close();
    f.tasks.close();
    f.experts.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
