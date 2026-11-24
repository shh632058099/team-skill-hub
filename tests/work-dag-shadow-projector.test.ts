import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkDagShadowProjector } from "../src/expert-platform/work-dag-shadow-projector.js";

test("shadow projector derives agent turns, verification, review, publication and change request from authoritative stores", () => {
  const work = {
    workItemId: "w",
    principalId: "p",
    scope: "s",
    stateRevision: 9,
    currentSubjectRevision: "workspace:abc",
    status: "waiting_review",
    workflowId: "bug-fix",
    workflowVersion: 3,
  };
  const attempts = [
    {
      workAttemptId: "a1",
      workItemId: "w",
      sequence: 1,
      parentWorkAttemptId: null,
      status: "succeeded",
      deploymentId: "dep",
      deploymentConfigVersion: 2,
      workspaceId: "ws",
      taskId: "t1",
      reviewTaskId: null,
    },
  ];
  const task = {
    taskId: "t1",
    status: "succeeded",
    verificationResults: [
      {
        stepId: "build",
        type: "build",
        evidenceType: "build",
        status: "passed",
        exitCode: 0,
        durationMs: 1,
        errorCode: null,
        subjectRevision: "workspace:abc",
        environmentIdentity: "env",
        verifierIdentity: "worker",
      },
    ],
  };
  const turns = [
    {
      taskId: "t1",
      runId: "r1",
      turnIndex: 0,
      status: "failed",
      startSequence: null,
      finishSequence: null,
      startedAt: 1,
      finishedAt: 2,
    },
    {
      taskId: "t1",
      runId: "r2",
      turnIndex: 1,
      status: "succeeded",
      startSequence: null,
      finishSequence: null,
      startedAt: 3,
      finishedAt: 4,
    },
  ];
  const reviews = [
    {
      reviewDecisionId: "rev1",
      workItemId: "w",
      subjectRevision: "workspace:abc",
      decision: "accepted",
      reason: null,
      actorPrincipalId: "p",
      createdAt: 5,
    },
  ];
  const publications = [
    {
      publicationId: "pub1",
      workItemId: "w",
      workAttemptId: "a1",
      state: "pushed",
      sourceSubjectRevision: "workspace:abc",
    },
  ];
  const cr = { changeRequestId: "cr1", workItemId: "w", workAttemptId: "a1", publicationId: "pub1", state: "created" };

  const projector = new WorkDagShadowProjector(
    {
      getWorkInternal: () => work,
      listAttempts: () => attempts,
      listReviewDecisions: () => reviews,
      saveShadowDag: () => true,
      getShadowDag: () => null,
    } as never,
    {
      get: () => task,
      listRunTurns: () => turns,
    } as never,
    { listPublications: () => publications } as never,
    { getByPublication: () => cr } as never,
  );
  const source = projector.readSource("w");
  assert.equal(source.stateRevision, 9);
  assert.deepEqual(
    source.observations.map((item) => [item.kind, item.state]),
    [
      ["agent", "failed"],
      ["agent", "succeeded"],
      ["verification", "succeeded"],
      ["review", "succeeded"],
      ["publication", "succeeded"],
      ["change_request", "succeeded"],
    ],
  );
  assert.deepEqual(source.observations[1]?.predecessorIds, [source.observations[0]!.id]);
  assert.deepEqual(source.observations[2]?.predecessorIds, [source.observations[1]!.id]);
  assert.deepEqual(source.observations.at(-1)?.predecessorIds, [source.observations.at(-2)!.id]);
});

test("shadow projector keeps semantic identities stable when only Work revision changes", () => {
  let revision = 1;
  const work = () => ({
    workItemId: "w",
    principalId: "p",
    scope: "s",
    stateRevision: revision,
    currentSubjectRevision: null,
    status: "queued",
    workflowId: "investigation",
    workflowVersion: 4,
  });
  const saved: unknown[] = [];
  const projector = new WorkDagShadowProjector(
    {
      getWorkInternal: () => work(),
      listAttempts: () => [],
      listReviewDecisions: () => [],
      saveShadowDag: (value: unknown) => {
        saved.push(value);
        return true;
      },
      getShadowDag: () => null,
    } as never,
    {
      get: () => {
        throw new Error("unused");
      },
      listRunTurns: () => [],
    } as never,
  );
  const first = projector.project("w");
  revision = 2;
  const second = projector.project("w");
  assert.notEqual(first.sourceDigest, second.sourceDigest);
  assert.equal(first.semanticDigest, second.semanticDigest);
});
