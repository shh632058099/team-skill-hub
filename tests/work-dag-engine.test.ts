import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import {
  DagExternalOutcomeUnknownError,
  WorkDagPlannerCoordinator,
  WorkDagScheduler,
  type WorkDagExecutorAdapter,
  type WorkDagPlanner,
} from "../src/expert-platform/work-dag-engine.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "work-dag-engine-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("dynamic-engine", 1, {
    ...structuredClone(base),
    validation: { requiredEvidence: [], required: [] },
    completion: { require: ["no_unresolved_blocker"] },
    graph: { mode: "dynamic-dag" },
  });
  const work = store.createOrReuseWork({
    principalId: "a",
    scope: "s",
    idempotencyKey: "k",
    sourceType: "mcp",
    title: "t",
    description: "inspect",
    workflowId: "dynamic-engine",
  });
  store.ensureRequirementSnapshot(work.workItemId);
  return { dir, store, workId: work.workItemId };
}

test("planner timeout is audited and leaves the accepted DAG unchanged", async () => {
  const { dir, store, workId } = setup();
  try {
    let observedSignal: AbortSignal | undefined;
    const hanging: WorkDagPlanner = {
      identity: "hanging",
      version: "1",
      async propose(...args: any[]) {
        observedSignal = args[2] as AbortSignal | undefined;
        return await new Promise<DagGraph>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(new Error("PLANNER_ABORTED")), { once: true });
        });
      },
    };
    const coordinator = new WorkDagPlannerCoordinator(store, hanging, 10);
    const before = store.getWorkInternal(workId).currentDagRevision;
    const result = await coordinator.replan(workId, "a", "s", "initial", 100);
    assert.equal(result, null);
    assert.equal(store.getWorkInternal(workId).currentDagRevision, before);
    const failure = store.listDagDecisions(workId).find((item) => item.action === "planner.failed");
    assert.equal(failure?.reasonCode, "PLANNER_TIMEOUT");
    assert.equal(observedSignal?.aborted, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const single = (id = "agent"): DagGraph => ({
  nodes: [
    {
      id,
      kind: "agent",
      capability: "analysis",
      subject: null,
      resource: "workspace",
      mutates: false,
      requirements: [],
    },
  ],
  edges: [],
});

test("planner coordinator freezes input, installs proposal and audits planner failure without mutating DAG", async () => {
  const { dir, store, workId } = setup();
  try {
    const planner: WorkDagPlanner = {
      identity: "test-planner",
      version: "1",
      async propose(input) {
        assert.equal(input.digest, input.frozenDigest);
        assert.equal(input.work.description, "inspect");
        return single();
      },
    };
    const coordinator = new WorkDagPlannerCoordinator(store, planner);
    const accepted = await coordinator.replan(workId, "a", "s", "initial", 100);
    assert.ok(accepted);
    assert.equal(accepted.status, "accepted");
    assert.equal(store.getWorkInternal(workId).currentDagRevision, 1);

    const failing: WorkDagPlanner = {
      identity: "broken",
      version: "1",
      async propose() {
        throw new Error("model unavailable");
      },
    };
    const failedCoordinator = new WorkDagPlannerCoordinator(store, failing);
    const before = store.getWorkInternal(workId).currentDagRevision;
    const result = await failedCoordinator.replan(workId, "a", "s", "manual", 110);
    assert.equal(result, null);
    assert.equal(store.getWorkInternal(workId).currentDagRevision, before);
    assert.ok(store.listDagDecisions(workId).some((item) => item.action === "planner.failed"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler persists running claim before adapter side effect and does not duplicate execution", async () => {
  const { dir, store, workId } = setup();
  try {
    const input = store.getDagPlannerInput(workId);
    store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: single(),
      },
      100,
    );
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      async execute(ctx) {
        calls++;
        const durable = store
          .listDagExecutions(workId)
          .find((item) => item.nodeExecutionId === ctx.execution.nodeExecutionId);
        assert.equal(durable?.state, "running");
        return { status: "succeeded", facts: [{ key: "analysis.done", value: true }] };
      },
    };
    const scheduler = new WorkDagScheduler(store, [adapter]);
    assert.equal(await scheduler.runOne(workId, "a", "s", "worker", 110), true);
    assert.equal(calls, 1);
    assert.equal(await scheduler.runOne(workId, "a", "s", "worker", 120), false);
    assert.equal(calls, 1);
    assert.equal(store.listDagExecutions(workId)[0]?.state, "succeeded");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deferred adapter persists external correlation and reconciles after restart without redispatch", async () => {
  const { dir, store, workId } = setup();
  try {
    const input = store.getDagPlannerInput(workId);
    store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: single(),
      },
      100,
    );
    let starts = 0;
    let polls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      async execute() {
        starts++;
        return { kind: "deferred", externalRef: "expert-task:t1" };
      },
      async reconcile(ctx) {
        polls++;
        assert.equal(ctx.execution.externalRef, "expert-task:t1");
        return polls === 1 ? null : { status: "succeeded", facts: [{ key: "agent.done", value: true }] };
      },
    };
    let scheduler = new WorkDagScheduler(store, [adapter]);
    assert.equal(await scheduler.runOne(workId, "a", "s", "worker", 110), true);
    assert.equal(starts, 1);
    let execution = store.listDagExecutions(workId)[0]!;
    assert.equal(execution.state, "running");
    assert.equal(execution.externalRef, "expert-task:t1");

    scheduler = new WorkDagScheduler(store, [adapter]);
    assert.equal(await scheduler.reconcileOne(workId, "a", "s", "worker", 120), false);
    assert.equal(starts, 1);
    assert.equal(await scheduler.reconcileOne(workId, "a", "s", "worker", 130), true);
    execution = store.listDagExecutions(workId)[0]!;
    assert.equal(execution.state, "succeeded");
    assert.equal(starts, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler persists deterministic correlation before side effect and expired owner can be reclaimed", async () => {
  const { dir, store, workId } = setup();
  try {
    const input = store.getDagPlannerInput(workId);
    store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: single(),
      },
      100,
    );
    let starts = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      correlationRef(ctx) {
        return "expert-task-key:" + ctx.execution.idempotencyKey;
      },
      async execute(ctx) {
        starts++;
        const durable = store.listDagExecutions(workId)[0]!;
        assert.equal(durable.externalRef, "expert-task-key:" + ctx.execution.idempotencyKey);
        return { kind: "deferred", externalRef: durable.externalRef! };
      },
      async reconcile() {
        return { status: "succeeded" };
      },
    };
    let scheduler = new WorkDagScheduler(store, [adapter], 10);
    assert.equal(await scheduler.runOne(workId, "a", "s", "owner-1", 110), true);
    const before = store.listDagExecutions(workId)[0]!;
    assert.equal(before.claimOwner, "owner-1");
    assert.equal(starts, 1);

    scheduler = new WorkDagScheduler(store, [adapter], 10);
    assert.equal(await scheduler.reconcileOne(workId, "a", "s", "owner-2", 119), false);
    assert.equal(await scheduler.reconcileOne(workId, "a", "s", "owner-2", 121), true);
    const after = store.listDagExecutions(workId)[0]!;
    assert.equal(after.state, "succeeded");
    assert.equal(after.claimOwner, "owner-2");
    assert.ok(after.fence > before.fence);
    assert.equal(starts, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation scans past an unfinished running node to a completed sibling", async () => {
  const { dir, store, workId } = setup();
  try {
    const node = (id: string) => ({
      id,
      kind: "agent" as const,
      capability: "analysis",
      subject: null,
      resource: "workspace",
      mutates: false,
      requirements: [],
    });
    let input = store.getDagPlannerInput(workId);
    assert.equal(
      store.submitDagProposal({
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: { nodes: [node("slow")], edges: [] },
      }).status,
      "accepted",
    );
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      async execute(ctx) {
        return { kind: "deferred", externalRef: "external:" + ctx.node.id };
      },
      async reconcile(ctx) {
        return ctx.node.id === "slow" ? null : { status: "succeeded", summary: "fast done" };
      },
    };
    const scheduler = new WorkDagScheduler(store, [adapter]);
    assert.equal(await scheduler.runOne(workId, "a", "s", "worker", 110), true);

    input = store.getDagPlannerInput(workId);
    assert.equal(
      store.submitDagProposal({
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "new_information",
        graph: { nodes: [node("slow"), node("fast")], edges: [] },
      }).status,
      "accepted",
    );
    assert.equal(await scheduler.runOne(workId, "a", "s", "worker", 111), true);
    assert.equal(await scheduler.reconcileOne(workId, "a", "s", "worker", 120), true);
    const states = new Map(store.listDagExecutions(workId).map((item) => [item.nodeId, item.state]));
    assert.equal(states.get("slow"), "running");
    assert.equal(states.get("fast"), "succeeded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimed intent is recovered after lease expiry without creating a new execution generation", async () => {
  const { dir, store, workId } = setup();
  try {
    const input = store.getDagPlannerInput(workId);
    store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: single(),
      },
      100,
    );
    const work = store.getWorkInternal(workId);
    const claimed = store.claimDagNode(workId, "a", "s", "agent", "owner-1", work.stateRevision, 1, 110, 10);
    assert.equal(claimed.state, "claimed");
    let calls = 0;
    const adapter: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      async execute() {
        calls++;
        return { status: "succeeded" };
      },
    };
    const scheduler = new WorkDagScheduler(store, [adapter], 10);
    assert.equal(await scheduler.recoverOne(workId, "a", "s", "owner-2", 119), false);
    assert.equal(await scheduler.recoverOne(workId, "a", "s", "owner-2", 121), true);
    const executions = store.listDagExecutions(workId);
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.generation, 1);
    assert.equal(executions[0]?.state, "succeeded");
    assert.equal(executions[0]?.claimOwner, "owner-2");
    assert.ok((executions[0]?.fence ?? 0) > claimed.fence);
    assert.equal(calls, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler records normal adapter failure and external outcome unknown distinctly", async () => {
  const { dir, store, workId } = setup();
  try {
    let input = store.getDagPlannerInput(workId);
    store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: single("normal"),
      },
      100,
    );
    const failing: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      async execute() {
        throw new Error("bad");
      },
    };
    assert.equal(await new WorkDagScheduler(store, [failing]).runOne(workId, "a", "s", "w", 101), true);
    assert.equal(store.listDagExecutions(workId).find((e) => e.nodeId === "normal")?.state, "failed");

    input = store.getDagPlannerInput(workId);
    const replacement: DagGraph = {
      nodes: [
        {
          id: "unknown",
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
    const proposal = store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 1,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "recovery",
        graph: replacement,
      },
      102,
    );
    assert.equal(proposal.status, "accepted");
    const unknown: WorkDagExecutorAdapter = {
      kind: "agent",
      capability: "analysis",
      async execute() {
        throw new DagExternalOutcomeUnknownError("op-123");
      },
    };
    assert.equal(await new WorkDagScheduler(store, [unknown]).runOne(workId, "a", "s", "w", 103), true);
    const execution = store.listDagExecutions(workId).find((e) => e.nodeId === "unknown");
    assert.equal(execution?.state, "external_outcome_unknown");
    assert.equal(execution?.result?.externalRef, "op-123");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
