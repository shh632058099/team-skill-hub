import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore, type WorkflowDefinition } from "../src/expert-platform/work-orchestration-store.js";
import {
  WorkDagPlannerCoordinator,
  WorkDagScheduler,
  type WorkDagExecutorAdapter,
} from "../src/expert-platform/work-dag-engine.js";
import { WorkDagSeedPlanner } from "../src/expert-platform/work-dag-planners.js";
import { WorkDagRuntime } from "../src/expert-platform/work-dag-runtime-service.js";

function fixture(
  requiredEvidence: string[],
  maxReplans = 10,
  replanPolicy: NonNullable<WorkflowDefinition["planning"]>["replanPolicy"] = [
    "always_after_agent_turn",
    "on_failure",
    "on_review_rework",
    "on_user_update",
    "on_blocker_resolution",
    "manual",
  ],
) {
  const dir = mkdtempSync(join(tmpdir(), "dag-runtime-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("dynamic-runtime", 1, {
    ...structuredClone(base),
    validation: { requiredEvidence, required: [] },
    review: { required: false },
    publication: { required: false, mode: "work_branch", approvalRequired: false },
    completion: { require: ["required_evidence_passed", "no_unresolved_blocker"] },
    planning: {
      maxReplans,
      replanPolicy,
    },
    graph: { mode: "dynamic-dag" },
  });
  const work = store.createOrReuseWork({
    principalId: "a",
    scope: "s",
    idempotencyKey: requiredEvidence.join(","),
    sourceType: "mcp",
    title: "t",
    description: "do work",
    workflowId: "dynamic-runtime",
  });
  store.ensureRequirementSnapshot(work.workItemId);
  return { dir, store, workId: work.workItemId };
}

async function drive(runtime: WorkDagRuntime, workId: string, max = 20) {
  for (let i = 0; i < max; i++) {
    const changed = await runtime.reconcileWork(workId, "a", "s", 100 + i);
    if (!changed) break;
  }
}

test("runtime plans, executes and completes from durable requirements", async () => {
  const f = fixture(["expert_result"]);
  try {
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        return {
          status: "succeeded",
          evidence: [{ type: "expert_result", passed: true, subjectRevision: null, verifierIdentity: "fake" }],
        };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [adapter]),
    );
    await drive(runtime, f.workId);
    assert.equal(f.store.getWorkInternal(f.workId).status, "completed");
    assert.equal(f.store.listDagRevisions(f.workId).length, 1);
    assert.equal(f.store.listDagExecutions(f.workId)[0]?.state, "succeeded");
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("verification failure causes agent repair re-plan, then a fresh verification node", async () => {
  const f = fixture(["unit_test"]);
  try {
    let verificationCalls = 0;
    const verification: WorkDagExecutorAdapter = {
      kind: "verification",
      capability: "unit_test",
      async execute() {
        verificationCalls++;
        return verificationCalls === 1
          ? {
              status: "failed",
              summary: "test failed",
              evidence: [{ type: "unit_test", passed: false, subjectRevision: null, verifierIdentity: "fake" }],
            }
          : {
              status: "succeeded",
              evidence: [{ type: "unit_test", passed: true, subjectRevision: null, verifierIdentity: "fake" }],
            };
      },
    };
    const agent: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        return { status: "succeeded", facts: [{ key: "repair.done", value: true }] };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [agent, verification]),
    );
    await drive(runtime, f.workId);
    assert.equal(f.store.getWorkInternal(f.workId).status, "completed");
    assert.equal(verificationCalls, 2);
    assert.ok(f.store.listDagRevisions(f.workId).length >= 3);
    assert.ok(
      f.store
        .listDagDecisions(f.workId)
        .some((item) => item.reasonCode === "verification_failure" && item.action === "plan.accepted"),
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("agent executor failure retries the same logical node generation before replanning", async () => {
  const f = fixture(["expert_result"]);
  try {
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        calls++;
        return calls === 1
          ? { status: "failed", summary: "EXECUTOR_CRASH" }
          : {
              status: "succeeded",
              evidence: [{ type: "expert_result", passed: true, subjectRevision: null, verifierIdentity: "fake" }],
            };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [adapter]),
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 100), true);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
    const revisionAfterFailure = f.store.getWorkInternal(f.workId).currentDagRevision;
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 102), true);
    let executions = f.store.listDagExecutions(f.workId);
    assert.deepEqual(
      executions.map((item) => [item.nodeId, item.generation, item.state]),
      [
        [executions[0]!.nodeId, 1, "failed"],
        [executions[0]!.nodeId, 2, "pending"],
      ],
    );
    assert.equal(f.store.getWorkInternal(f.workId).currentDagRevision, revisionAfterFailure);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 103), true);
    executions = f.store.listDagExecutions(f.workId);
    assert.equal(executions.at(-1)?.state, "succeeded");
    assert.equal(calls, 2);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("review executor failure blocks after retry exhaustion instead of being replanned as review findings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-review-executor-failure-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  try {
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("conditional-review-failure", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["build", "unit_test"], required: [] },
      review: { required: true, reviewerExpertId: "reviewer" },
      change: { mode: "conditional_code_change" },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker", "review_accepted"] },
      planning: { maxReplans: 10, replanPolicy: ["on_failure", "on_review_rework"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "review-executor-failure",
      sourceType: "mcp",
      title: "review first",
      description: "review first; fix only real review findings",
      workflowId: "conditional-review-failure",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    let calls = 0;
    const review: WorkDagExecutorAdapter = {
      kind: "review",
      async execute() {
        calls++;
        return { status: "failed", summary: "EXECUTION_FAILED" };
      },
    };
    const runtime = new WorkDagRuntime(
      store,
      new WorkDagPlannerCoordinator(store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(store, [review]),
    );
    for (let i = 0; i < 8; i++) {
      await runtime.reconcileWork(work.workItemId, "a", "s", 100 + i);
      if (store.getWorkInternal(work.workItemId).status === "blocked") break;
    }
    const current = store.getWorkInternal(work.workItemId);
    assert.equal(calls, 3);
    assert.equal(current.status, "blocked");
    assert.equal(current.blockedReason, "DAG_EXECUTOR_FAILED");
    assert.equal(current.currentDagRevision, 1);
    assert.equal(store.listDagRevisions(work.workItemId).length, 1);
    assert.equal(store.listDagProposals(work.workItemId).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deterministic expert routing failure blocks once instead of burning retry and re-plan budgets", async () => {
  const f = fixture(["expert_result"]);
  try {
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        calls++;
        return { status: "failed", summary: "EXPERT_UNAVAILABLE" };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [adapter]),
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 100), true);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 102), true);

    const work = f.store.getWorkInternal(f.workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.blockedReason, "DAG_EXECUTOR_UNAVAILABLE");
    assert.match(work.blockedContext ?? "", /EXPERT_UNAVAILABLE/);
    assert.equal(calls, 1);
    assert.equal(f.store.listDagExecutions(f.workId).length, 1);
    assert.equal(f.store.listDagRevisions(f.workId).length, 1);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("requirement update waits for an in-flight node instead of attempting to supersede it", async () => {
  const f = fixture(["expert_result"]);
  try {
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      correlationRef(ctx) {
        return "external:" + ctx.execution.idempotencyKey;
      },
      async execute(ctx) {
        return { kind: "deferred", externalRef: "external:" + ctx.execution.idempotencyKey };
      },
      async reconcile() {
        return null;
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [adapter]),
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 100), true);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
    assert.equal(f.store.listDagExecutions(f.workId)[0]?.state, "running");
    let work = f.store.getWorkInternal(f.workId);
    const snapshot = f.store.getRequirementSnapshot(f.workId, work.currentRequirementRevision);
    f.store.updateRequirementSnapshot(
      f.workId,
      "a",
      "s",
      work.stateRevision,
      snapshot.revision,
      [
        {
          id: "user:ctest",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "ctest" },
        },
      ],
      "test",
      102,
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 103), false);
    work = f.store.getWorkInternal(f.workId);
    assert.notEqual(work.status, "blocked");
    assert.equal(work.currentDagRevision, 1);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("blocker resolution triggers one bounded re-plan and a noop proposal consumes the signal", async () => {
  const f = fixture(["expert_result"]);
  try {
    const initial = f.store.getDagPlannerInput(f.workId);
    const graph = {
      nodes: [
        {
          id: "agent",
          kind: "agent" as const,
          capability: "analysis",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    f.store.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: initial.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: initial.frozen.requirementRevision,
        plannerIdentity: "bootstrap",
        plannerVersion: "1",
        plannerInputDigest: initial.digest,
        reasonCode: "initial",
        graph,
      },
      100,
    );
    let work = f.store.getWorkInternal(f.workId);
    f.store.blockWork(f.workId, "a", "s", work.stateRevision, "EXTERNAL_BLOCKER", "waiting", 110, {
      resumeCondition: "manual",
      blockedByType: "external",
    });
    work = f.store.getWorkInternal(f.workId);
    f.store.resumeBlockedWork(f.workId, "a", "s", work.stateRevision, "queued", 120);

    const reasons: string[] = [];
    const planner: any = {
      identity: "test",
      version: "1",
      async propose(_input: any, reason: string) {
        reasons.push(reason);
        return graph;
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, planner),
      new WorkDagScheduler(f.store, []),
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 130), true);
    assert.deepEqual(reasons, ["blocker_resolution"]);
    assert.equal(f.store.listDagProposals(f.workId).at(-1)?.status, "noop");

    await runtime.reconcileWork(f.workId, "a", "s", 140);
    assert.deepEqual(reasons, ["blocker_resolution"]);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("resume continues the accepted plan when blocker-resolution replanning is disabled", async () => {
  const f = fixture(["expert_result"], 10, ["always_after_agent_turn", "on_failure", "on_user_update", "manual"]);
  try {
    const input = f.store.getDagPlannerInput(f.workId);
    const graph = {
      nodes: [
        {
          id: "agent",
          kind: "agent" as const,
          capability: "analysis",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    f.store.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "bootstrap",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph,
      },
      100,
    );
    let work = f.store.getWorkInternal(f.workId);
    f.store.blockWork(f.workId, "a", "s", work.stateRevision, "EXTERNAL_BLOCKER", "waiting", 110, {
      resumeCondition: "manual",
      blockedByType: "external",
    });
    work = f.store.getWorkInternal(f.workId);
    f.store.resumeBlockedWork(f.workId, "a", "s", work.stateRevision, "queued", 120);

    const reasons: string[] = [];
    const planner: any = {
      identity: "test",
      version: "1",
      async propose(_input: unknown, reason: string) {
        reasons.push(reason);
        return graph;
      },
    };
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        calls++;
        return {
          status: "succeeded",
          evidence: [
            {
              type: "expert_result",
              passed: true,
              subjectRevision: null,
              verifierIdentity: "fake",
            },
          ],
        };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, planner),
      new WorkDagScheduler(f.store, [adapter]),
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 130), true);
    assert.equal(calls, 1);
    assert.deepEqual(reasons, []);
    assert.notEqual(f.store.getWorkInternal(f.workId).blockedReason, "DAG_REPLAN_NOT_ALLOWED");
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("manual re-plan request is durable, deduplicated while pending and consumed by runtime", async () => {
  const f = fixture(["expert_result"]);
  try {
    const initial = f.store.getDagPlannerInput(f.workId);
    const graph = {
      nodes: [
        {
          id: "agent",
          kind: "agent" as const,
          capability: "analysis",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    f.store.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: initial.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: initial.frozen.requirementRevision,
        plannerIdentity: "bootstrap",
        plannerVersion: "1",
        plannerInputDigest: initial.digest,
        reasonCode: "initial",
        graph,
      },
      100,
    );
    const work = f.store.getWorkInternal(f.workId);
    const first = f.store.requestDagReplan(f.workId, "a", "s", work.stateRevision, "user requested a fresh plan", 110);
    const replay = f.store.requestDagReplan(f.workId, "a", "s", work.stateRevision, "retry", 111);
    assert.equal(replay.requestId, first.requestId);
    assert.equal(first.state, "pending");

    const reasons: string[] = [];
    let plannerCalls = 0;
    const planner: any = {
      identity: "test",
      version: "1",
      async propose(_input: any, reason: string) {
        reasons.push(reason);
        plannerCalls++;
        if (plannerCalls === 1) throw new Error("TEMPORARY_PLANNER_FAILURE");
        return graph;
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, planner),
      new WorkDagScheduler(f.store, []),
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 120), true);
    assert.deepEqual(reasons, ["manual"]);
    let request = f.store.listDagReplanRequests(f.workId)[0]!;
    assert.equal(request.state, "pending");
    assert.equal(request.proposalId, null);

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 130), true);
    assert.deepEqual(reasons, ["manual", "manual"]);
    request = f.store.listDagReplanRequests(f.workId)[0]!;
    assert.equal(request.state, "consumed");
    assert.ok(request.proposalId);
    assert.equal(f.store.listDagProposals(f.workId).at(-1)?.status, "noop");

    await runtime.reconcileWork(f.workId, "a", "s", 140);
    assert.deepEqual(reasons, ["manual", "manual"]);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("external outcome unknown blocks instead of replaying or completing", async () => {
  const f = fixture(["expert_result"]);
  try {
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        return { status: "external_outcome_unknown", externalRef: "op-1" };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [adapter]),
    );
    await drive(runtime, f.workId);
    const work = f.store.getWorkInternal(f.workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.blockedReason, "DAG_EXTERNAL_OUTCOME_UNKNOWN");
    assert.equal(f.store.listDagExecutions(f.workId).length, 1);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("validator rejection or exhausted replan budget becomes diagnosable blocked state", async () => {
  const f = fixture(["expert_result"], 1);
  try {
    const badPlanner: any = {
      identity: "bad",
      version: "1",
      async propose() {
        return {
          nodes: [
            {
              id: "write",
              kind: "agent",
              capability: "analysis",
              subject: null,
              resource: "workspace",
              mutates: true,
              requirements: [],
            },
          ],
          edges: [],
        };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, badPlanner),
      new WorkDagScheduler(f.store, []),
    );
    await runtime.reconcileWork(f.workId, "a", "s", 100);
    const work = f.store.getWorkInternal(f.workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.blockedReason, "DAG_PLAN_REJECTED");
    assert.match(work.blockedContext ?? "", /PLAN_WORKSPACE_WRITE_NOT_ALLOWED/);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
