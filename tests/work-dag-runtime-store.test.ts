import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { evaluatePredicate, type DagGraph } from "../src/expert-platform/work-dag.js";
import { WORK_DAG_POLICY_VALIDATOR_VERSION } from "../src/expert-platform/work-dag-policy.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "work-dag-runtime-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("dynamic-test", 1, {
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
    description: "d",
    workflowId: "dynamic-test",
  });
  store.ensureRequirementSnapshot(work.workItemId);
  return { dir, store, workId: work.workItemId };
}
const graph = (ids: string[]): DagGraph => ({
  nodes: ids.map((id) => ({
    id,
    kind: "agent",
    capability: "agent",
    subject: null,
    resource: "workspace",
    mutates: false,
    requirements: [],
  })),
  edges: ids.slice(1).map((id, index) => ({ from: ids[index]!, to: id })),
});

test("accepted proposal installs immutable revision and creates executions once", () => {
  const { dir, store, workId } = setup();
  try {
    const input = store.getDagPlannerInput(workId);
    const first = store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "planner",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: graph(["a", "b"]),
      },
      100,
    );
    assert.equal(first.status, "accepted");
    assert.equal(first.acceptedRevision, 1);
    assert.equal(first.validatorVersion, WORK_DAG_POLICY_VALIDATOR_VERSION);
    assert.equal(store.getDagRevision(workId, 1).validatorVersion, WORK_DAG_POLICY_VALIDATOR_VERSION);
    assert.equal(store.listDagRevisions(workId).length, 1);
    assert.deepEqual(
      store.listDagExecutions(workId).map((e) => [e.nodeId, e.generation, e.state]),
      [
        ["a", 1, "pending"],
        ["b", 1, "pending"],
      ],
    );

    const nextInput = store.getDagPlannerInput(workId);
    const second = store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: nextInput.frozen.workRevision,
        expectedDagRevision: 1,
        expectedRequirementRevision: nextInput.frozen.requirementRevision,
        plannerIdentity: "planner",
        plannerVersion: "1",
        plannerInputDigest: nextInput.digest,
        reasonCode: "new_information",
        graph: graph(["a", "b", "c"]),
      },
      110,
    );
    assert.equal(second.status, "accepted");
    assert.equal(second.acceptedRevision, 2);
    assert.deepEqual(
      store.listDagExecutions(workId).map((e) => [e.nodeId, e.generation]),
      [
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ],
    );
    assert.equal(store.getDagRevision(workId, 1).graph.nodes.length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale planner inputs and policy-invalid proposals never advance current DAG", () => {
  const { dir, store, workId } = setup();
  try {
    const input = store.getDagPlannerInput(workId);
    const stale = store.submitDagProposal({
      workItemId: workId,
      principalId: "a",
      scope: "s",
      expectedWorkRevision: input.frozen.workRevision + 1,
      expectedDagRevision: 0,
      expectedRequirementRevision: input.frozen.requirementRevision,
      plannerIdentity: "planner",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "initial",
      graph: graph(["a"]),
    });
    assert.equal(stale.status, "stale");
    assert.equal(store.getWorkInternal(workId).currentDagRevision, 0);

    const current = store.getDagPlannerInput(workId);
    const invalidGraph: DagGraph = {
      nodes: [
        {
          id: "write",
          kind: "agent",
          capability: "agent",
          subject: null,
          resource: "workspace",
          mutates: true,
          requirements: [],
        },
      ],
      edges: [],
    };
    const rejected = store.submitDagProposal({
      workItemId: workId,
      principalId: "a",
      scope: "s",
      expectedWorkRevision: current.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: current.frozen.requirementRevision,
      plannerIdentity: "planner",
      plannerVersion: "1",
      plannerInputDigest: current.digest,
      reasonCode: "initial",
      graph: invalidGraph,
    });
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.decisionCodes.includes("PLAN_WORKSPACE_WRITE_NOT_ALLOWED"));
    assert.equal(store.getWorkInternal(workId).currentDagRevision, 0);
    assert.equal(store.listDagProposals(workId).length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposal subject-bound nodes must match the current Work subject", () => {
  const { dir, store, workId } = setup();
  try {
    let work = store.getWorkInternal(workId);
    store.setCurrentSubjectRevision(workId, "a", "s", work.stateRevision, "subject-current", 10);
    const input = store.getDagPlannerInput(workId);
    const bad: DagGraph = {
      nodes: [
        {
          id: "verify",
          kind: "verification",
          capability: "unit_test",
          subject: "subject-old",
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const rejected = store.submitDagProposal(
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
        reasonCode: "manual",
        graph: bad,
      },
      20,
    );
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.decisionCodes.includes("PLAN_INVALID_SUBJECT_BINDING"));
    assert.equal(store.getWorkInternal(workId).currentDagRevision, 0);

    const fresh = store.getDagPlannerInput(workId);
    const agent: DagGraph = {
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
    const accepted = store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: fresh.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: fresh.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: fresh.digest,
        reasonCode: "manual",
        graph: agent,
      },
      21,
    );
    assert.equal(accepted.status, "accepted");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim rejects a RequirementSnapshot revision that the accepted DAG has not revalidated", () => {
  const { dir, store, workId } = setup();
  try {
    const initial = store.getDagPlannerInput(workId);
    store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: initial.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: initial.frozen.requirementRevision,
        plannerIdentity: "planner",
        plannerVersion: "1",
        plannerInputDigest: initial.digest,
        reasonCode: "initial",
        graph: graph(["a"]),
      },
      100,
    );

    let work = store.getWorkInternal(workId);
    const snapshot = store.getRequirementSnapshot(workId, work.currentRequirementRevision);
    store.updateRequirementSnapshot(
      workId,
      "a",
      "s",
      work.stateRevision,
      snapshot.revision,
      [
        ...snapshot.requirements,
        {
          id: "user:new-preference",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "preference.noted", equals: true },
        },
      ],
      "test",
      101,
    );

    work = store.getWorkInternal(workId);
    assert.throws(
      () => store.claimDagNode(workId, "a", "s", "a", "worker", work.stateRevision, 1, 102, 1000),
      /STALE_DAG_CLAIM/,
    );

    const revalidated = store.getDagPlannerInput(workId);
    const noop = store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: revalidated.frozen.workRevision,
        expectedDagRevision: 1,
        expectedRequirementRevision: revalidated.frozen.requirementRevision,
        plannerIdentity: "planner",
        plannerVersion: "1",
        plannerInputDigest: revalidated.digest,
        reasonCode: "user_update",
        graph: graph(["a"]),
      },
      103,
    );
    assert.equal(noop.status, "noop");

    work = store.getWorkInternal(workId);
    const claimed = store.claimDagNode(workId, "a", "s", "a", "worker", work.stateRevision, 1, 104, 1000);
    assert.equal(claimed.boundRequirementRevision, work.currentRequirementRevision);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim is fenced and result reconciliation is exactly-once with durable outputs", () => {
  const { dir, store, workId } = setup();
  try {
    let input = store.getDagPlannerInput(workId);
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
      graph: graph(["a", "b"]),
    });
    let work = store.getWorkInternal(workId);
    const claim = store.claimDagNode(workId, "a", "s", "a", "worker", work.stateRevision, 1, 100, 1000);
    assert.equal(claim.state, "claimed");
    assert.ok(claim.idempotencyKey);
    assert.throws(
      () => store.claimDagNode(workId, "a", "s", "a", "other", work.stateRevision, 1, 101, 1000),
      /DAG_NODE_NOT_PENDING/,
    );
    const running = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 110);
    assert.equal(running.state, "running");
    const result = {
      status: "succeeded" as const,
      facts: [{ key: "analysis.done", value: true }],
      artifacts: [{ artifactId: "report-1", type: "report", ref: "artifact://report", subjectRevision: null }],
    };
    const completed = store.reconcileDagNodeResult(claim.nodeExecutionId, "worker", running.fence, result, 120);
    assert.equal(completed.state, "succeeded");
    assert.deepEqual(
      store.listDagFacts(workId).map((f) => [f.key, f.value]),
      [["analysis.done", true]],
    );
    assert.equal(store.listDagArtifacts(workId)[0]?.artifactId, "report-1");
    assert.deepEqual(
      store.reconcileDagNodeResult(claim.nodeExecutionId, "worker", running.fence, result, 130),
      completed,
    );
    assert.throws(
      () => store.reconcileDagNodeResult(claim.nodeExecutionId, "worker", running.fence, { status: "failed" }, 130),
      /DAG_RESULT_CONFLICT/,
    );
    work = store.getWorkInternal(workId);
    const b = store.claimDagNode(workId, "a", "s", "b", "worker", work.stateRevision, 1, 140, 1000);
    assert.equal(b.state, "claimed");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subject-bound DAG facts become stale after subject changes while control facts remain global", () => {
  const { dir, store, workId } = setup();
  try {
    let work = store.getWorkInternal(workId);
    store.setCurrentSubjectRevision(workId, "a", "s", work.stateRevision, "subject-v1", 90);
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
        graph: {
          nodes: [
            {
              id: "verify",
              kind: "verification",
              capability: "build",
              subject: "subject-v1",
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
          ],
          edges: [],
        },
      },
      100,
    );
    work = store.getWorkInternal(workId);
    const claimed = store.claimDagNode(workId, "a", "s", "verify", "worker", work.stateRevision, 1, 110, 1000);
    const running = store.startDagNodeExecution(claimed.nodeExecutionId, "worker", claimed.fence, 111);
    store.reconcileDagNodeResult(
      running.nodeExecutionId,
      "worker",
      running.fence,
      { status: "succeeded", facts: [{ key: "custom.ready", value: true }] },
      112,
    );
    let context = store.getDagContext(workId);
    assert.equal(evaluatePredicate({ kind: "fact", key: "custom.ready", equals: true }, context), true);

    work = store.getWorkInternal(workId);
    store.setCurrentSubjectRevision(workId, "a", "s", work.stateRevision, "subject-v2", 120);
    context = store.getDagContext(workId);
    assert.equal(evaluatePredicate({ kind: "fact", key: "custom.ready", equals: true }, context), "unknown");
    assert.equal(Object.hasOwn(context.facts, "custom.ready"), false);

    store.recordDagPlannerFailure(workId, "planner", "1", "manual", "digest", "PLANNER_FAILED", 121);
    work = store.getWorkInternal(workId);
    store.setCurrentSubjectRevision(workId, "a", "s", work.stateRevision, "subject-v3", 122);
    context = store.getDagContext(workId);
    assert.equal(Object.hasOwn(context.facts, "planner.failure"), true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planner proposal frozen before a node claim becomes stale even when Work revision is unchanged", () => {
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
        graph: graph(["a"]),
      },
      100,
    );
    const frozen = store.getDagPlannerInput(workId);
    const before = store.getWorkInternal(workId);
    store.claimDagNode(workId, "a", "s", "a", "worker", before.stateRevision, 1, 110, 1000);
    assert.equal(store.getWorkInternal(workId).stateRevision, before.stateRevision);
    const stale = store.submitDagProposal(
      {
        workItemId: workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: frozen.frozen.workRevision,
        expectedDagRevision: 1,
        expectedRequirementRevision: frozen.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: frozen.digest,
        reasonCode: "concurrent",
        graph: graph(["a"]),
      },
      120,
    );
    assert.equal(stale.status, "stale");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("platform cancellation can fence a running external side effect as outcome unknown", () => {
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
        graph: graph(["a"]),
      },
      100,
    );
    let work = store.getWorkInternal(workId);
    let claim = store.claimDagNode(workId, "a", "s", "a", "owner", work.stateRevision, 1, 110, 1000);
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "owner", claim.fence, 111);
    const unknown = store.markDagExecutionOutcomeUnknown(
      claim.nodeExecutionId,
      "publication:pub-1",
      "Work cancelled while remote push was in flight",
      112,
    );
    assert.equal(unknown.state, "external_outcome_unknown");
    assert.equal(unknown.result?.externalRef, "publication:pub-1");
    assert.ok(unknown.fence > claim.fence);
    assert.equal(unknown.claimOwner, null);
    assert.throws(
      () => store.reconcileDagNodeResult(claim.nodeExecutionId, "owner", claim.fence, { status: "succeeded" }, 113),
      /DAG_RESULT_CONFLICT|STALE_DAG_EXECUTION_CLAIM/,
    );
    const late = store.listDagLateResults(workId);
    assert.equal(late.length, 1);
    assert.equal(late[0]?.nodeExecutionId, claim.nodeExecutionId);
    assert.equal(late[0]?.ownerId, "owner");
    assert.equal(late[0]?.fence, claim.fence);
    assert.equal(late[0]?.disposition, "rejected_terminal_conflict");
    assert.match(late[0]?.resultDigest ?? "", /^[a-f0-9]{64}$/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external outcome unknown blocks dependent claims and running nodes cannot be superseded", () => {
  const { dir, store, workId } = setup();
  try {
    let input = store.getDagPlannerInput(workId);
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
      graph: graph(["a", "b"]),
    });
    let work = store.getWorkInternal(workId);
    const claim = store.claimDagNode(workId, "a", "s", "a", "worker", work.stateRevision, 1, 100, 1000);
    const running = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 101);
    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      running.fence,
      { status: "external_outcome_unknown", externalRef: "x" },
      102,
    );
    work = store.getWorkInternal(workId);
    assert.throws(
      () => store.claimDagNode(workId, "a", "s", "b", "worker", work.stateRevision, 1, 103, 1000),
      /DAG_NODE_NOT_READY/,
    );

    store.resolveUnknownDagExecution(claim.nodeExecutionId, "failed", "operator evidence", 104);
    input = store.getDagPlannerInput(workId);
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
        reasonCode: "failure",
        graph: graph(["recovery"]),
      },
      105,
    );
    assert.equal(proposal.status, "accepted");
    assert.equal(store.listDagExecutions(workId).find((e) => e.nodeId === "b")?.state, "superseded");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
