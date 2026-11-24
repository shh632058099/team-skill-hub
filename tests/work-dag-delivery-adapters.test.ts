import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkDagScheduler } from "../src/expert-platform/work-dag-engine.js";
import { createDeliveryDagAdapters } from "../src/expert-platform/work-dag-delivery-adapters.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

function baseFixture(node: { kind: "publication" | "change_request"; capability: string }) {
  const dir = mkdtempSync(join(tmpdir(), "dag-delivery-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("dynamic-delivery", 1, {
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
    idempotencyKey: node.capability,
    sourceType: "mcp",
    title: "t",
    description: "d",
    workflowId: "dynamic-delivery",
  });
  store.ensureRequirementSnapshot(work.workItemId);
  let current = store.getWorkInternal(work.workItemId);
  store.setCurrentSubjectRevision(work.workItemId, "a", "s", current.stateRevision, "workspace:" + "a".repeat(64), 10);
  const deliveryNode: DagGraph["nodes"][number] = {
    id: "delivery",
    kind: node.kind,
    capability: node.capability,
    subject: "workspace:" + "a".repeat(64),
    resource: "workspace",
    mutates: false,
    requirements: [],
  };
  const graph: DagGraph =
    node.kind === "publication" && node.capability === "push"
      ? {
          nodes: [
            {
              id: "prepare-history",
              kind: "publication",
              capability: "prepare",
              subject: "workspace:" + "a".repeat(64),
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
            deliveryNode,
          ],
          edges: [{ from: "prepare-history", to: "delivery" }],
        }
      : { nodes: [deliveryNode], edges: [] };
  const input = store.getDagPlannerInput(work.workItemId);
  const proposal = store.submitDagProposal(
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
      reasonCode: "delivery",
      graph,
    },
    20,
  );
  assert.equal(proposal.status, "accepted");
  if (node.kind === "publication" && node.capability === "push") {
    current = store.getWorkInternal(work.workItemId);
    let prepared = store.claimDagNode(
      work.workItemId,
      "a",
      "s",
      "prepare-history",
      "history",
      current.stateRevision,
      1,
      21,
      1000,
    );
    prepared = store.startDagNodeExecution(prepared.nodeExecutionId, "history", prepared.fence, 22);
    store.reconcileDagNodeResult(prepared.nodeExecutionId, "history", prepared.fence, { status: "succeeded" }, 23);
  }
  return { dir, store, workId: work.workItemId };
}

test("publication prepare node waits on existing publication worker and emits commit artifact", async () => {
  const f = baseFixture({ kind: "publication", capability: "prepare" });
  let state = "preparing";
  const publication: any = {
    publicationId: "pub",
    workItemId: f.workId,
    workAttemptId: "a1",
    workspaceId: "ws",
    state,
    sourceSubjectRevision: "workspace:" + "a".repeat(64),
    baseCommit: "b".repeat(40),
    repositoryId: "repo",
    repositoryIdentityRevision: 1,
    publicationPolicyRevision: 1,
    branchName: "work/x",
    commitSha: null,
    treeSha: null,
    artifactRef: null,
    pushRemoteName: "origin",
    pushRefspec: null,
    ownerWorkerId: "worker",
    commitTimestamp: 1,
    commitAuthorName: "TSH",
    commitAuthorEmail: "x@example.invalid",
    commitMessage: "m",
    executionSnapshot: null,
    preparedAt: null,
    approvedAt: null,
    pushedAt: null,
    lastErrorCode: null,
    lastErrorContext: null,
    retryCount: 0,
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const publications: any = {
    listPublications: () => [
      {
        ...publication,
        state,
        commitSha: state === "prepared" ? "c".repeat(40) : null,
        treeSha: state === "prepared" ? "d".repeat(40) : null,
        artifactRef: state === "prepared" ? "artifact-1" : null,
        preparedAt: state === "prepared" ? 30 : null,
      },
    ],
    getPublication: () => publications.listPublications()[0],
    getPublicationArtifact: () =>
      state === "prepared"
        ? {
            artifactId: "artifact-1",
            kind: "git_commit",
            workItemId: f.workId,
            workAttemptId: "a1",
            publicationId: "pub",
            sourceSubjectRevision: publication.sourceSubjectRevision,
            repositoryId: "repo",
            baseCommit: publication.baseCommit,
            branchName: "work/x",
            commitSha: "c".repeat(40),
            treeSha: "d".repeat(40),
            publicationPolicyRevision: 1,
            createdAt: 30,
          }
        : null,
    transitionPublication: () => {
      throw new Error("unexpected");
    },
  };
  let ensureCalls = 0,
    evidenceCalls = 0;
  const gateway: any = {
    ensurePublication: () => {
      ensureCalls++;
      return publications.getPublication();
    },
    recordPreparedPublicationArtifact: () => {
      evidenceCalls++;
    },
    ensureChangeRequest: () => {
      throw new Error("unexpected");
    },
  };
  const scheduler = new WorkDagScheduler(f.store, createDeliveryDagAdapters(f.store, publications, undefined, gateway));
  assert.equal(await scheduler.runOne(f.workId, "a", "s", "hub", 25), true);
  assert.equal(ensureCalls, 0);
  assert.equal(await scheduler.reconcileOne(f.workId, "a", "s", "hub", 26), false);
  state = "prepared";
  assert.equal(await scheduler.reconcileOne(f.workId, "a", "s", "hub", 31), true);
  assert.equal(evidenceCalls, 1);
  assert.equal(f.store.listDagExecutions(f.workId)[0]?.state, "succeeded");
  assert.equal(f.store.listDagArtifacts(f.workId)[0]?.artifactId, "artifact-1");
  f.store.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("publication push and change request nodes consume their existing durable lifecycles", async () => {
  const push = baseFixture({ kind: "publication", capability: "push" });
  try {
    let pubState = "prepared";
    const publications: any = {
      listPublications: () => [
        {
          publicationId: "pub",
          workItemId: push.workId,
          workAttemptId: "a1",
          state: pubState,
          sourceSubjectRevision: "workspace:" + "a".repeat(64),
          commitSha: "c".repeat(40),
          artifactRef: "artifact-1",
          publicationPolicyRevision: 1,
          branchName: "work/x",
          lastErrorCode: null,
        },
      ],
      getPublication: () => publications.listPublications()[0],
      getPublicationArtifact: () => null,
      transitionPublication: (_id: string, next: string) => {
        pubState = next;
        return publications.getPublication();
      },
    };
    const gateway: any = {
      ensurePublication: () => publications.getPublication(),
      recordPreparedPublicationArtifact: () => {},
      ensureChangeRequest: () => {
        throw new Error("unexpected");
      },
    };
    const scheduler = new WorkDagScheduler(
      push.store,
      createDeliveryDagAdapters(push.store, publications, undefined, gateway),
    );
    assert.equal(await scheduler.runOne(push.workId, "a", "s", "hub", 25), true);
    assert.equal(pubState, "approved");
    pubState = "pushed";
    assert.equal(await scheduler.reconcileOne(push.workId, "a", "s", "hub", 30), true);
    assert.equal(push.store.getDagContext(push.workId).facts["publication.succeeded"], true);
  } finally {
    push.store.close();
    rmSync(push.dir, { recursive: true, force: true });
  }

  const cr = baseFixture({ kind: "publication", capability: "prepare" });
  try {
    let crState = "pending";
    const publications: any = {
      listPublications: () => [
        {
          publicationId: "pub",
          state: "pushed",
          sourceSubjectRevision: "workspace:" + "a".repeat(64),
          commitSha: "c".repeat(40),
          artifactRef: "artifact-1",
        },
      ],
    };
    const requests: any = {
      getByPublication: () => ({
        changeRequestId: "cr",
        publicationId: "pub",
        state: crState,
        provider: crState === "created" ? "github" : null,
        externalId: crState === "created" ? "1" : null,
        url: crState === "created" ? "https://example.test/pr/1" : null,
        lastErrorCode: null,
      }),
    };
    const gateway: any = {
      ensurePublication: () => {
        throw new Error("unexpected");
      },
      recordPreparedPublicationArtifact: () => {},
      ensureChangeRequest: () => requests.getByPublication(),
    };
    const adapter = createDeliveryDagAdapters(cr.store, publications, requests, gateway).find(
      (item) => item.kind === "change_request",
    )!;
    const work = cr.store.getWorkInternal(cr.workId);
    const context: any = {
      work,
      node: {
        id: "cr",
        kind: "change_request",
        capability: "create",
        subject: work.currentSubjectRevision,
        resource: "workspace",
        mutates: false,
        requirements: [],
      },
      execution: {
        nodeExecutionId: "exec-cr",
        workItemId: cr.workId,
        nodeId: "cr",
        createdDagRevision: 1,
        generation: 1,
        state: "running",
        fence: 1,
        idempotencyKey: "cr-key",
        subjectRevision: work.currentSubjectRevision,
        resourceIdentity: "workspace",
        claimOwner: "hub",
        claimLeaseUntil: null,
        startedAt: 1,
        finishedAt: null,
        result: null,
        externalRef: "change-request-key:" + cr.workId,
        createdAt: 1,
        updatedAt: 1,
      },
      dagRevision: 1,
      signal: new AbortController().signal,
    };
    const started = await adapter.execute(context);
    assert.equal("kind" in started && started.kind, "deferred");
    crState = "created";
    const result = await adapter.reconcile!(context);
    assert.equal(result?.status, "succeeded");
    assert.equal(result?.facts?.[0]?.key, "change_request.created");
  } finally {
    cr.store.close();
    rmSync(cr.dir, { recursive: true, force: true });
  }
});
