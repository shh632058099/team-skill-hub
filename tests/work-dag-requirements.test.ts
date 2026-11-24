import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { policyObligations } from "../src/expert-platform/work-dag-requirements.js";

test("conditional code-change policy activates build/publication obligations only after a workspace change", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-conditional-policy-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("bug-fix").definition;
    const definition: any = {
      ...structuredClone(base),
      change: { mode: "conditional_code_change", delivery: "merge_request" },
      validation: { requiredEvidence: ["build", "unit_test"], required: [] },
      review: { required: true, reviewerExpertId: "ota" },
      publication: { required: true, mode: "work_branch", approvalRequired: false },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
          "publication_succeeded",
          "change_request_created",
        ],
      },
      graph: { mode: "dynamic-dag" },
    };
    const saved = store.putWorkflow("conditional-fix", 1, definition);
    assert.equal(saved.definition.change?.mode, "conditional_code_change");
    const obligations = policyObligations(saved.definition);
    const build = obligations.find(
      (item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "build",
    )!;
    const publish = obligations.find(
      (item) => item.satisfaction.kind === "fact" && item.satisfaction.key === "publication.succeeded",
    )!;
    const review = obligations.find(
      (item) => item.satisfaction.kind === "fact" && item.satisfaction.key === "review.accepted",
    )!;
    assert.deepEqual(build.condition, { kind: "fact", key: "workspace.changed", equals: true });
    assert.deepEqual(publish.condition, { kind: "fact", key: "workspace.changed", equals: true });
    assert.deepEqual(review.condition, { kind: "always" });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conditional code-change may omit delivery while preserving build, unit-test and review gates", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-conditional-no-delivery-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("bug-fix").definition;
    const saved = store.putWorkflow("conditional-no-delivery", 1, {
      ...structuredClone(base),
      change: { mode: "conditional_code_change" },
      validation: { requiredEvidence: ["build", "unit_test"], required: [] },
      review: { required: true, reviewerExpertId: "ota" },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
        ],
      },
      graph: { mode: "dynamic-dag" },
    } as any);
    assert.deepEqual(saved.definition.change, { mode: "conditional_code_change" });
    const obligations = policyObligations(saved.definition);
    assert.ok(obligations.some((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "build"));
    assert.ok(
      obligations.some((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "unit_test"),
    );
    assert.ok(
      obligations.some((item) => item.satisfaction.kind === "fact" && item.satisfaction.key === "review.accepted"),
    );
    assert.equal(
      obligations.some(
        (item) =>
          item.satisfaction.kind === "fact" &&
          (item.satisfaction.key === "publication.succeeded" || item.satisfaction.key === "change_request.created"),
      ),
      false,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RequirementSnapshot is immutable, versioned, CAS fenced and preserves stronger policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-req-"));
  const file = join(dir, "runtime.db");
  try {
    const store = new WorkOrchestrationStore(file);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "req",
      sourceType: "mcp",
      title: "t",
      description: "d",
      workflowId: "bug-fix",
    });
    const first = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(first.revision, 1);
    assert.equal(first.policyRef, work.workflowId + "@" + work.workflowVersion);
    assert.ok(first.effectiveDigest);
    const initialEffective = store.getEffectiveDagObligations(work.workItemId);
    for (const type of ["expert_result", "build", "unit_test"]) {
      assert.ok(
        initialEffective.some((o) => o.satisfaction.kind === "evidence" && o.satisfaction.type === type),
        type,
      );
    }

    const current = store.getWorkInternal(work.workItemId);
    const updated = store.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      1,
      [
        {
          id: "user:ctest",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "ctest" },
        },
      ],
      "resolver-v2",
      110,
    );
    assert.equal(updated.snapshot.revision, 2);
    assert.equal(updated.work.stateRevision, current.stateRevision + 1);
    assert.deepEqual(store.getRequirementSnapshot(work.workItemId, 1), first);
    assert.equal(store.listRequirementSnapshots(work.workItemId).length, 2);
    const effective = store.getEffectiveDagObligations(work.workItemId);
    assert.ok(effective.some((o) => o.id === "user:ctest"));
    assert.ok(effective.some((o) => o.satisfaction.kind === "evidence" && o.satisfaction.type === "build"));

    assert.throws(
      () =>
        store.updateRequirementSnapshot(work.workItemId, "alice", "team", updated.work.stateRevision, 1, [], "x", 120),
      /STALE_REQUIREMENT_REVISION/,
    );
    assert.throws(
      () =>
        store.updateRequirementSnapshot(
          work.workItemId,
          "alice",
          "team",
          updated.work.stateRevision,
          2,
          [
            {
              id: "bad",
              source: "workflow" as "user",
              strength: "required",
              condition: { kind: "always" },
              satisfaction: { kind: "evidence", type: "x" },
            },
          ],
          "x",
          120,
        ),
      /INVALID_WORK_REQUIREMENT/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence becomes stale when the requirement semantics for its type changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-req-evidence-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-req", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "semantics",
      sourceType: "mcp",
      title: "t",
      description: "d",
      workflowId: "dynamic-req",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    let current = store.getWorkInternal(work.workItemId);
    store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      1,
      [
        {
          id: "user:ctest",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "ctest" },
        },
      ],
      "typed-v1",
      10,
    );
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
        graph: {
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
        },
      },
      20,
    );
    current = store.getWorkInternal(work.workItemId);
    let claim = store.claimDagNode(work.workItemId, "a", "s", "verify", "worker", current.stateRevision, 1, 21, 1000);
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 22);
    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "ctest", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      23,
    );
    assert.equal(store.getDagContext(work.workItemId).evidence.find((item) => item.type === "ctest")?.stale, false);
    assert.ok(store.listDagEvidence(work.workItemId)[0]?.requirementSemanticsDigest);

    current = store.getWorkInternal(work.workItemId);
    store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      2,
      [
        {
          id: "user:ctest",
          source: "user",
          strength: "required",
          condition: { kind: "fact", key: "mode.full", equals: true },
          satisfaction: { kind: "evidence", type: "ctest" },
        },
      ],
      "typed-v1",
      30,
    );
    assert.equal(store.getDagContext(work.workItemId).evidence.find((item) => item.type === "ctest")?.stale, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("terminal Work rejects requirement snapshot mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-req-terminal-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-terminal", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "terminal",
      sourceType: "mcp",
      title: "t",
      description: "d",
      workflowId: "dynamic-terminal",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    let current = store.getWorkInternal(work.workItemId);
    current = store.transitionWork(work.workItemId, "a", "s", current.stateRevision, "cancelled", 10);
    assert.throws(
      () =>
        store.updateRequirementSnapshot(
          work.workItemId,
          "a",
          "s",
          current.stateRevision,
          1,
          [
            {
              id: "user:x",
              source: "user",
              strength: "required",
              condition: { kind: "always" },
              satisfaction: { kind: "evidence", type: "x" },
            },
          ],
          "typed-v1",
          11,
        ),
      /WORK_ALREADY_TERMINAL/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requirement semantics changes produce a different effective identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-req-digest-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "k",
      sourceType: "mcp",
      title: "t",
      description: "d",
      workflowId: "investigation",
    });
    const first = store.ensureRequirementSnapshot(work.workItemId);
    const before = store.getWorkInternal(work.workItemId);
    const second = store.updateRequirementSnapshot(work.workItemId, "a", "s", before.stateRevision, first.revision, [
      {
        id: "user:verify",
        source: "user",
        strength: "required",
        condition: { kind: "always" },
        satisfaction: { kind: "evidence", type: "ctest" },
      },
    ]).snapshot;
    assert.notEqual(first.effectiveDigest, second.effectiveDigest);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
