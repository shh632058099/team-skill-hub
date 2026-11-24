import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "work-dag-scheduler-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("dynamic-verify", 1, {
    ...structuredClone(base),
    validation: { requiredEvidence: ["ctest"], required: [] },
    completion: { require: ["required_evidence_passed", "no_unresolved_blocker"] },
    graph: { mode: "dynamic-dag" },
  });
  const work = store.createOrReuseWork({
    principalId: "a",
    scope: "s",
    idempotencyKey: "k",
    sourceType: "mcp",
    title: "t",
    description: "d",
    workflowId: "dynamic-verify",
  });
  store.ensureRequirementSnapshot(work.workItemId);
  const graph: DagGraph = {
    nodes: [
      {
        id: "verify",
        kind: "verification",
        capability: "ctest",
        subject: null,
        resource: "workspace",
        mutates: false,
        requirements: [],
      },
    ],
    edges: [],
  };
  const input = store.getDagPlannerInput(work.workItemId);
  store.submitDagProposal({
    workItemId: work.workItemId,
    principalId: "a",
    scope: "s",
    expectedWorkRevision: input.frozen.workRevision,
    expectedDagRevision: 0,
    expectedRequirementRevision: input.frozen.requirementRevision,
    plannerIdentity: "p",
    plannerVersion: "1",
    plannerInputDigest: input.digest,
    reasonCode: "initial",
    graph,
  });
  return { dir, store, workId: work.workItemId };
}

test("completion is requirement-driven and CAS-bound to plan/requirements/subject", () => {
  const { dir, store, workId } = setup();
  try {
    let work = store.getWorkInternal(workId);
    let claim = store.claimDagNode(workId, "a", "s", "verify", "worker", work.stateRevision, 1, 100, 1000);
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 101);
    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "ctest", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      102,
    );
    const evaluation = store.evaluateDagCompletion(workId);
    assert.equal(evaluation.ready, true);
    assert.equal(evaluation.deadlocked, false);
    work = store.getWorkInternal(workId);
    const completed = store.completeDagWork(
      workId,
      "a",
      "s",
      work.stateRevision,
      1,
      work.currentRequirementRevision,
      work.currentSubjectRevision,
      103,
    );
    assert.equal(completed.status, "completed");
    assert.throws(
      () => store.claimDagNode(workId, "a", "s", "verify", "worker", completed.stateRevision, 1, 104, 1000),
      /DAG_NODE_NOT_READY|WORK_ALREADY_TERMINAL/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed execution blocks completion; retry creates a new generation without a DAG revision", () => {
  const { dir, store, workId } = setup();
  try {
    let work = store.getWorkInternal(workId);
    let claim = store.claimDagNode(workId, "a", "s", "verify", "worker", work.stateRevision, 1, 100, 1000);
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 101);
    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      { status: "failed", summary: "ctest failed" },
      102,
    );
    let evaluation = store.evaluateDagCompletion(workId);
    assert.equal(evaluation.ready, false);
    assert.equal(evaluation.deadlocked, true);
    assert.ok(evaluation.missing.some((item) => item.includes("NODE_FAILED")));
    const retry = store.retryDagNode(workId, "verify", "verification_failure", 103);
    assert.equal(retry.generation, 2);
    assert.notEqual(retry.idempotencyKey, claim.idempotencyKey);
    assert.equal(store.getWorkInternal(workId).currentDagRevision, 1);

    work = store.getWorkInternal(workId);
    let retryClaim = store.claimDagNode(workId, "a", "s", "verify", "worker", work.stateRevision, 1, 104, 1000);
    retryClaim = store.startDagNodeExecution(retryClaim.nodeExecutionId, "worker", retryClaim.fence, 105);
    store.reconcileDagNodeResult(
      retryClaim.nodeExecutionId,
      "worker",
      retryClaim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "ctest", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      106,
    );
    evaluation = store.evaluateDagCompletion(workId);
    assert.equal(evaluation.ready, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running execution cannot be superseded by re-plan", () => {
  const { dir, store, workId } = setup();
  try {
    let work = store.getWorkInternal(workId);
    let claim = store.claimDagNode(workId, "a", "s", "verify", "worker", work.stateRevision, 1, 100, 1000);
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 101);
    const input = store.getDagPlannerInput(workId);
    const replacement: DagGraph = {
      nodes: [
        {
          id: "replacement",
          kind: "verification",
          capability: "ctest",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const result = store.submitDagProposal(
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
        reasonCode: "new_information",
        graph: replacement,
      },
      102,
    );
    assert.equal(result.status, "rejected");
    assert.ok(result.decisionCodes.includes("PLAN_RUNNING_NODE_SUPERSESSION"));
    assert.equal(store.getWorkInternal(workId).currentDagRevision, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work cancellation fences all uncompleted DAG executions", () => {
  const { dir, store, workId } = setup();
  try {
    let work = store.getWorkInternal(workId);
    work = store.transitionWork(workId, "a", "s", work.stateRevision, "cancelled", 100);
    store.cancelDagExecutions(workId, 101);
    assert.deepEqual(
      store.listDagExecutions(workId).map((e) => e.state),
      ["cancelled"],
    );
    const evaluation = store.evaluateDagCompletion(workId);
    assert.equal(evaluation.ready, false);
    assert.ok(evaluation.missing.includes("WORK_CANCELLED"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
