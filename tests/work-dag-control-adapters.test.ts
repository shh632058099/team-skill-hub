import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkDagScheduler } from "../src/expert-platform/work-dag-engine.js";
import { createControlDagAdapters } from "../src/expert-platform/work-dag-control-adapters.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

function fixture(kind: "approval" | "wait") {
  const dir = mkdtempSync(join(tmpdir(), "dag-control-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("dynamic-control", 1, {
    ...structuredClone(base),
    validation: { requiredEvidence: [], required: [] },
    completion: { require: ["no_unresolved_blocker"] },
    graph: { mode: "dynamic-dag" },
  });
  const work = store.createOrReuseWork({
    principalId: "a",
    scope: "s",
    idempotencyKey: kind,
    sourceType: "mcp",
    title: "t",
    description: "d",
    workflowId: "dynamic-control",
  });
  store.ensureRequirementSnapshot(work.workItemId);
  let current = store.getWorkInternal(work.workItemId);
  store.setCurrentSubjectRevision(work.workItemId, "a", "s", current.stateRevision, "subject-1", 10);
  if (kind === "approval") {
    current = store.getWorkInternal(work.workItemId);
    const attempt = store.createWorkAttempt(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      {
        reason: "initial",
        expertId: "test",
        deploymentId: "dep",
        deploymentConfigVersion: 1,
      },
      11,
    );
    current = store.getWorkInternal(work.workItemId);
    store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "a",
      "s",
      current.stateRevision,
      "succeeded",
      "running",
      12,
    );
  }
  const graph: DagGraph = {
    nodes: [
      {
        id: kind,
        kind,
        capability: kind === "approval" ? "work_completion" : "external_ready",
        subject: "subject-1",
        resource: null,
        mutates: false,
        requirements: [],
      },
    ],
    edges: [],
  };
  const input = store.getDagPlannerInput(work.workItemId);
  store.submitDagProposal(
    {
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
    },
    20,
  );
  return { dir, store, workId: work.workItemId };
}

test("work completion approval node waits for matching current-subject approval", async () => {
  const f = fixture("approval");
  try {
    const scheduler = new WorkDagScheduler(f.store, createControlDagAdapters(f.store));
    assert.equal(await scheduler.runOne(f.workId, "a", "s", "hub", 30), true);
    assert.equal(await scheduler.reconcileOne(f.workId, "a", "s", "hub", 31), false);
    const work = f.store.getWorkInternal(f.workId);
    f.store.recordApproval(
      f.workId,
      "a",
      "s",
      {
        expectedRevision: work.stateRevision,
        actor: "a",
        role: "developer",
        approvalScope: "work_completion",
        subjectType: "workspace_revision",
        subjectRevision: "subject-1",
        decision: "approved",
      },
      32,
    );
    assert.equal(await scheduler.reconcileOne(f.workId, "a", "s", "hub", 33), true);
    assert.equal(f.store.listDagExecutions(f.workId)[0]?.state, "succeeded");
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("publish approval binds the prepared publication artifact, not the workspace subject", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-publish-approval-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  try {
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-publish-approval", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "publish-approval",
      sourceType: "mcp",
      title: "t",
      description: "d",
      workflowId: "dynamic-publish-approval",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    let current = store.getWorkInternal(work.workItemId);
    store.setCurrentSubjectRevision(work.workItemId, "a", "s", current.stateRevision, "workspace:abc", 10);
    const graph: DagGraph = {
      nodes: [
        {
          id: "approval",
          kind: "approval",
          capability: "publish_work_branch",
          subject: "workspace:abc",
          resource: null,
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const input = store.getDagPlannerInput(work.workItemId);
    store.submitDagProposal(
      {
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
      },
      20,
    );
    const publications: any = {
      listPublications: () => [
        {
          publicationId: "pub1",
          workItemId: work.workItemId,
          workAttemptId: "a1",
          state: "prepared",
          sourceSubjectRevision: "workspace:abc",
          commitSha: "c".repeat(40),
        },
      ],
    };
    const scheduler = new WorkDagScheduler(store, createControlDagAdapters(store, publications));
    assert.equal(await scheduler.runOne(work.workItemId, "a", "s", "hub", 30), true);
    assert.equal(await scheduler.reconcileOne(work.workItemId, "a", "s", "hub", 31), false);
    current = store.getWorkInternal(work.workItemId);
    store.recordApproval(
      work.workItemId,
      "a",
      "s",
      {
        expectedRevision: current.stateRevision,
        actor: "a",
        role: "developer",
        approvalScope: "publish_work_branch",
        subjectType: "publication_artifact",
        subjectRevision: "publication:pub1:" + "c".repeat(40),
        decision: "approved",
      },
      32,
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "a", "s", "hub", 33), true);
    assert.equal(store.listDagExecutions(work.workItemId)[0]?.state, "succeeded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("running wait can be explicitly superseded and late events remain quarantined", async () => {
  const f = fixture("wait");
  try {
    const scheduler = new WorkDagScheduler(f.store, createControlDagAdapters(f.store), 100);
    assert.equal(await scheduler.runOne(f.workId, "a", "s", "hub", 30), true);
    const execution = f.store.listDagExecutions(f.workId)[0]!;
    const wait = f.store.getDagWaitByExecution(execution.nodeExecutionId)!;
    assert.equal(execution.state, "running");
    assert.equal(wait.state, "waiting");

    const input = f.store.getDagPlannerInput(f.workId);
    const proposal = f.store.submitDagProposal(
      {
        workItemId: f.workId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "new_information",
        graph: { nodes: [], edges: [] },
      },
      40,
    );
    assert.equal(proposal.status, "accepted");
    assert.equal(f.store.listDagExecutions(f.workId)[0]?.state, "superseded");
    assert.equal(f.store.getDagWaitByExecution(execution.nodeExecutionId)?.state, "cancelled");
    const late = f.store.signalDagWait(wait.correlationKey, { late: true }, "late-after-supersede", 41);
    assert.equal(late.state, "cancelled");
    assert.notEqual(f.store.getWorkInternal(f.workId).status, "running");
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("wait node persists correlation, deduplicates signals and ignores late signal after cancellation", async () => {
  const f = fixture("wait");
  try {
    const scheduler = new WorkDagScheduler(f.store, createControlDagAdapters(f.store), 100);
    assert.equal(await scheduler.runOne(f.workId, "a", "s", "hub", 30), true);
    const execution = f.store.listDagExecutions(f.workId)[0]!;
    const wait = f.store.getDagWaitByExecution(execution.nodeExecutionId)!;
    assert.equal(wait.state, "waiting");
    const first = f.store.signalDagWait(wait.correlationKey, { ready: true }, "evt-1", 40);
    const replay = f.store.signalDagWait(wait.correlationKey, { ready: true }, "evt-1", 41);
    assert.equal(first.signalDigest, replay.signalDigest);
    assert.equal(await scheduler.reconcileOne(f.workId, "a", "s", "hub", 42), true);
    assert.equal(f.store.listDagExecutions(f.workId)[0]?.state, "succeeded");

    const second = fixture("wait");
    try {
      const secondScheduler = new WorkDagScheduler(second.store, createControlDagAdapters(second.store), 100);
      await secondScheduler.runOne(second.workId, "a", "s", "hub", 50);
      let work = second.store.getWorkInternal(second.workId);
      second.store.transitionWork(second.workId, "a", "s", work.stateRevision, "cancelled", 51);
      second.store.cancelDagExecutions(second.workId, 52);
      second.store.cancelDagWaits(second.workId, 52);
      const secondExecution = second.store.listDagExecutions(second.workId)[0]!;
      const secondWait = second.store.getDagWaitByExecution(secondExecution.nodeExecutionId)!;
      const late = second.store.signalDagWait(secondWait.correlationKey, { late: true }, "evt-late", 53);
      assert.equal(late.state, "cancelled");
      assert.equal(second.store.getWorkInternal(second.workId).status, "cancelled");
    } finally {
      second.store.close();
      rmSync(second.dir, { recursive: true, force: true });
    }
  } finally {
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
