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
import type { DagGraph } from "../src/expert-platform/work-dag.js";
import { WorkDagRuntime } from "../src/expert-platform/work-dag-runtime-service.js";
import { workflowOnlyDagPolicyContext } from "../src/expert-platform/work-dag-policy-context.js";

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

test("DAG runtime processes every post-cutover Work even when its Workflow snapshot says single-node", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-runtime-cutover-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  try {
    assert.equal(store.getWorkflow("investigation").definition.graph.mode, "single-node");
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "dag-cutover-single-node-workflow",
      sourceType: "mcp",
      title: "inspect",
      description: "inspect the repository",
      workflowId: "investigation",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    const runtime = new WorkDagRuntime(
      store,
      new WorkDagPlannerCoordinator(store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(store, []),
    );

    assert.equal(await runtime.reconcileWork(work.workItemId, "a", "s", 100), true);
    assert.equal(store.getWorkInternal(work.workItemId).currentDagRevision, 1);
    assert.equal(store.listDagRevisions(work.workItemId).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("accepted failure-conditioned branch runs before generic failure replanning", async () => {
  const f = fixture(["unit_test"], 5, ["manual"]);
  try {
    const input = f.store.getDagPlannerInput(f.workId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "verify",
          kind: "verification",
          capability: "unit_test",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
        {
          id: "repair",
          kind: "agent",
          capability: "repair",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [
        {
          from: "verify",
          to: "repair",
          predicate: { kind: "node_result", nodeId: "verify", state: "failed" },
        },
      ],
    };
    const proposal = f.store.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph,
      },
      100,
    );
    assert.equal(proposal.status, "accepted");

    let repairCalls = 0;
    const verification: WorkDagExecutorAdapter = {
      kind: "verification",
      capability: "unit_test",
      async execute() {
        return {
          status: "failed",
          summary: "test failed",
          evidence: [{ type: "unit_test", passed: false, subjectRevision: null, verifierIdentity: "fake" }],
        };
      },
    };
    const repair: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "repair",
      async execute() {
        repairCalls++;
        return { status: "succeeded", summary: "repair ran" };
      },
    };
    const planner = {
      identity: "unexpected",
      version: "1",
      async propose() {
        throw new Error("SHOULD_NOT_REPLAN");
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, planner),
      new WorkDagScheduler(f.store, [verification, repair]),
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
    assert.deepEqual(f.store.evaluateDagCompletion(f.workId).readyNodeIds, ["repair"]);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 102), true);
    assert.equal(repairCalls, 1);
    assert.notEqual(f.store.getWorkInternal(f.workId).blockedReason, "DAG_REPLAN_NOT_ALLOWED");
    assert.equal(
      f.store.listDagExecutions(f.workId).find((execution) => execution.nodeId === "repair")?.state,
      "succeeded",
    );
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("failure-conditioned successor is preferred over an unrelated ready node", async () => {
  const f = fixture(["unit_test"], 5, ["manual"]);
  try {
    const input = f.store.getDagPlannerInput(f.workId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "verify",
          kind: "verification",
          capability: "unit_test",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
        {
          id: "unrelated",
          kind: "agent",
          capability: "unrelated",
          subject: null,
          resource: "other",
          mutates: false,
          requirements: [],
        },
        {
          id: "repair",
          kind: "agent",
          capability: "repair",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [
        {
          from: "verify",
          to: "repair",
          predicate: { kind: "node_result", nodeId: "verify", state: "failed" },
        },
      ],
    };
    assert.equal(
      f.store.submitDagProposal({
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph,
      }).status,
      "accepted",
    );

    let repairCalls = 0;
    let unrelatedCalls = 0;
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, {
        identity: "unexpected",
        version: "1",
        async propose() {
          throw new Error("SHOULD_NOT_REPLAN");
        },
      }),
      new WorkDagScheduler(f.store, [
        {
          kind: "verification",
          capability: "unit_test",
          async execute() {
            return {
              status: "failed",
              summary: "test failed",
              evidence: [{ type: "unit_test", passed: false, subjectRevision: null, verifierIdentity: "fake" }],
            };
          },
        },
        {
          kind: "agent",
          capability: "unrelated",
          async execute() {
            unrelatedCalls++;
            return { status: "succeeded" };
          },
        },
        {
          kind: "agent",
          capability: "repair",
          async execute() {
            repairCalls++;
            return { status: "succeeded" };
          },
        },
      ]),
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
    assert.deepEqual(f.store.evaluateDagCompletion(f.workId).readyNodeIds, ["unrelated", "repair"]);
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 102), true);
    assert.equal(repairCalls, 1);
    assert.equal(unrelatedCalls, 0);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("executor failure is handled before an unrelated ready node", async () => {
  const f = fixture(["expert_result"]);
  try {
    const input = f.store.getDagPlannerInput(f.workId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "crash",
          kind: "agent",
          capability: "crash",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
        {
          id: "unrelated",
          kind: "agent",
          capability: "unrelated",
          subject: null,
          resource: "other",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    assert.equal(
      f.store.submitDagProposal({
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph,
      }).status,
      "accepted",
    );

    let unrelatedCalls = 0;
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(f.store, [
        {
          kind: "agent",
          capability: "crash",
          async execute() {
            return { status: "failed", summary: "EXECUTOR_CRASH" };
          },
        },
        {
          kind: "agent",
          capability: "unrelated",
          async execute() {
            unrelatedCalls++;
            return { status: "succeeded" };
          },
        },
      ]),
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
    assert.equal(
      f.store.listDagExecutions(f.workId).find((execution) => execution.nodeId === "crash")?.state,
      "failed",
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 102), true);
    assert.equal(unrelatedCalls, 0);
    assert.ok(
      f.store
        .listDagExecutions(f.workId)
        .some(
          (execution) => execution.nodeId === "crash" && execution.generation === 2 && execution.state === "pending",
        ),
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

test("transient model failure uses durable backoff before retrying the same agent node", async () => {
  const f = fixture(["expert_result"]);
  try {
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        calls++;
        return calls === 1
          ? { status: "failed", summary: "MODEL_REQUEST_FAILED" }
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
    const failed = f.store.listDagExecutions(f.workId).at(-1)!;
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", failed.finishedAt! + 4_999), false);
    assert.equal(f.store.listDagExecutions(f.workId).length, 1);

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", failed.finishedAt! + 5_000), true);
    let executions = f.store.listDagExecutions(f.workId);
    assert.deepEqual(
      executions.map((item) => [item.generation, item.state]),
      [
        [1, "failed"],
        [2, "pending"],
      ],
    );
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", failed.finishedAt! + 5_001), true);
    executions = f.store.listDagExecutions(f.workId);
    assert.equal(executions.at(-1)?.state, "succeeded");
    assert.equal(calls, 2);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("executor hard timeout blocks immediately instead of blindly retrying the agent node", async () => {
  const f = fixture(["expert_result"]);
  try {
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        calls++;
        return { status: "failed", summary: "EXECUTOR_TIMEOUT" };
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
    assert.equal(work.blockedReason, "DAG_EXECUTOR_TIMEOUT");
    assert.match(work.blockedContext ?? "", /EXECUTOR_TIMEOUT/);
    assert.equal(calls, 1);
    assert.equal(f.store.listDagExecutions(f.workId).length, 1);
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

test("semantic agent blocker blocks immediately instead of retrying a completed refusal", async () => {
  const f = fixture(["expert_result"]);
  try {
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        calls++;
        return {
          status: "failed",
          summary: "AGENT_BLOCKED:REMOTE_ACCESS\nRemote repository access is unavailable.",
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
    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 102), true);

    const work = f.store.getWorkInternal(f.workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.blockedReason, "DAG_AGENT_BLOCKED");
    assert.match(work.blockedContext ?? "", /REMOTE_ACCESS/);
    assert.equal(calls, 1);
    assert.equal(f.store.listDagExecutions(f.workId).length, 1);
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

test("requirement-update noop replan is consumed instead of repeating on every reconcile", async () => {
  const f = fixture(["expert_result"], 10, ["on_user_update"]);
  try {
    const input = f.store.getDagPlannerInput(f.workId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "agent",
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

    const agent: WorkDagExecutorAdapter = {
      kind: "agent",
      async execute() {
        return {
          status: "succeeded",
          evidence: [{ type: "expert_result", passed: true, subjectRevision: null, verifierIdentity: "fake" }],
        };
      },
    };
    const reasons: string[] = [];
    const planner = {
      identity: "test",
      version: "1",
      async propose(_input: unknown, reason: string) {
        reasons.push(reason);
        return graph;
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, planner),
      new WorkDagScheduler(f.store, [agent]),
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 101), true);
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
          id: "user:preference",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "preference.noted", equals: true },
        },
      ],
      "test",
      110,
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 120), true);
    assert.deepEqual(reasons, ["user_update"]);
    assert.equal(f.store.listDagProposals(f.workId).at(-1)?.status, "noop");

    work = f.store.getWorkInternal(f.workId);
    const secondSnapshot = f.store.getRequirementSnapshot(f.workId, work.currentRequirementRevision);
    f.store.updateRequirementSnapshot(
      f.workId,
      "a",
      "s",
      work.stateRevision,
      secondSnapshot.revision,
      [
        ...secondSnapshot.requirements,
        {
          id: "user:second-preference",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "second.preference.noted", equals: true },
        },
      ],
      "test",
      122,
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 123), true);
    assert.deepEqual(reasons, ["user_update", "user_update"]);
    assert.equal(f.store.listDagProposals(f.workId).at(-1)?.status, "noop");
    assert.equal(f.store.getWorkInternal(f.workId).currentDagRevision, 1);

    await runtime.reconcileWork(f.workId, "a", "s", 124);
    assert.deepEqual(reasons, ["user_update", "user_update"]);
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("execution-contract drift retires the active Attempt and accepts the same graph under a new policy revision", async () => {
  const f = fixture(["expert_result"], 10, ["on_user_update"]);
  try {
    const graph: DagGraph = {
      nodes: [
        {
          id: "agent",
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
    const initial = f.store.getDagPlannerInput(f.workId);
    const accepted = f.store.submitDagProposal(
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
    assert.equal(accepted.status, "accepted");

    let work = f.store.getWorkInternal(f.workId);
    const oldAttempt = f.store.createWorkAttempt(
      f.workId,
      "a",
      "s",
      work.stateRevision,
      {
        reason: "initial",
        expertId: "legacy-expert",
        deploymentId: "legacy-deployment",
        deploymentConfigVersion: 1,
      },
      101,
    );
    work = f.store.getWorkInternal(f.workId);
    const snapshot = f.store.getRequirementSnapshot(f.workId, work.currentRequirementRevision);
    f.store.updateRequirementSnapshot(
      f.workId,
      "a",
      "s",
      work.stateRevision,
      snapshot.revision,
      [
        ...snapshot.requirements,
        {
          id: "user:new-contract",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "new.contract", equals: true },
        },
      ],
      "test",
      102,
    );

    const planner = {
      identity: "test",
      version: "1",
      async propose() {
        return graph;
      },
    };
    const policyProvider = {
      resolve(currentWork: ReturnType<WorkOrchestrationStore["getWorkInternal"]>) {
        const workflow = f.store.getWorkflow(currentWork.workflowId, currentWork.workflowVersion);
        return {
          ...workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition),
          deployment: {
            deploymentId: "new-deployment",
            configVersion: 2,
            expertId: "new-expert",
            runtimeProfile: "codex-readonly",
            digest: "new-deployment@2",
          },
          digest: "new-policy-context",
        };
      },
    };
    const runtime = new WorkDagRuntime(
      f.store,
      new WorkDagPlannerCoordinator(f.store, planner, 30_000, policyProvider),
      new WorkDagScheduler(f.store, []),
    );

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 110), true);
    work = f.store.getWorkInternal(f.workId);
    assert.equal(work.status, "queued");
    assert.equal(work.activeWorkAttemptId, null);
    assert.equal(f.store.getWorkAttempt(oldAttempt.workAttemptId).status, "cancelled");
    assert.ok(f.store.listDagProposals(f.workId).at(-1)?.decisionCodes.includes("PLAN_POLICY_CONTEXT_DRIFT"));

    assert.equal(await runtime.reconcileWork(f.workId, "a", "s", 120), true);
    work = f.store.getWorkInternal(f.workId);
    assert.equal(work.currentDagRevision, 2);
    assert.match(f.store.getDagRevision(f.workId, 2).policyRevision, /new-policy-context/);
    assert.equal(f.store.listDagProposals(f.workId).at(-1)?.status, "accepted");
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

test("runtime lets a safe independent branch progress before blocking on an unresolved external outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-runtime-scoped-unknown-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  try {
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-scoped-unknown", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "scoped-unknown-runtime",
      sourceType: "mcp",
      title: "scoped unknown",
      description: "run independent safe work",
      workflowId: "dynamic-scoped-unknown",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "unknown",
          kind: "agent",
          capability: "unknown",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
        {
          id: "safe-read",
          kind: "agent",
          capability: "safe-read",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const input = store.getDagPlannerInput(work.workItemId);
    assert.equal(
      store.submitDagProposal({
        workItemId: work.workItemId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph,
      }).status,
      "accepted",
    );
    let safeRuns = 0;
    const runtime = new WorkDagRuntime(
      store,
      new WorkDagPlannerCoordinator(store, new WorkDagSeedPlanner()),
      new WorkDagScheduler(store, [
        {
          kind: "agent",
          capability: "unknown",
          async execute() {
            return { status: "external_outcome_unknown", externalRef: "op-unknown" };
          },
        },
        {
          kind: "agent",
          capability: "safe-read",
          async execute() {
            safeRuns++;
            return { status: "succeeded", summary: "safe branch done" };
          },
        },
      ]),
    );

    assert.equal(await runtime.reconcileWork(work.workItemId, "a", "s", 100), true);
    assert.equal(
      store.listDagExecutions(work.workItemId).find((item) => item.nodeId === "unknown")?.state,
      "external_outcome_unknown",
    );

    assert.equal(await runtime.reconcileWork(work.workItemId, "a", "s", 101), true);
    assert.equal(safeRuns, 1);
    assert.notEqual(store.getWorkInternal(work.workItemId).status, "blocked");

    assert.equal(await runtime.reconcileWork(work.workItemId, "a", "s", 102), true);
    const blocked = store.getWorkInternal(work.workItemId);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedReason, "DAG_EXTERNAL_OUTCOME_UNKNOWN");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
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
