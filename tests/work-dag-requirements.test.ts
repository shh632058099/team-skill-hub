import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { workflowOnlyDagPolicyContext } from "../src/expert-platform/work-dag-policy-context.js";
import {
  classifyRequirementUpdateImpact,
  evidenceRequirementSemanticsDigest,
  policyObligations,
} from "../src/expert-platform/work-dag-requirements.js";

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

test("policy context binding revisions requirements before execution and rejects active-attempt drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-policy-binding-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "policy-binding",
      sourceType: "mcp",
      title: "Inspect",
      description: "Inspect",
      workflowId: "investigation",
    });
    const first = store.ensureRequirementSnapshot(work.workItemId, 100) as any;
    const strict = {
      workflowRef: "investigation@1",
      workflowDigest: first.policyDigest,
      organization: {
        ref: "organization:default@1",
        digest: "org",
        allowedNodeKinds: ["agent", "verification", "review", "approval", "publication", "change_request", "wait"],
      },
      repository: {
        repositoryId: "repo",
        policyDigest: "repo",
        verificationCapabilities: [],
        publicationPermissions: [],
      },
      deployment: {
        deploymentId: "dep",
        configVersion: 1,
        expertId: "expert",
        runtimeProfile: "claude-readonly",
        digest: "dep",
      },
      executorCapabilities: {
        agent: ["*"],
        verification: [],
        review: ["review"],
        approval: ["work_completion", "publish_work_branch"],
        publication: [],
        change_request: [],
        wait: ["*"],
      },
      resourcePolicies: {},
      limits: { maxReplans: 12, maxReworks: 2, maxTurnsPerRun: 20 },
      usage: { replansUsed: 0, reworksUsed: 0, continuationTurns: 0 },
      digest: "strict-policy-digest",
    };
    const current = store.getWorkInternal(work.workItemId);
    const bound = store.bindRequirementPolicyContext(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      first.revision,
      strict as any,
      110,
    );
    assert.equal(bound.snapshot.revision, first.revision + 1);
    assert.equal(bound.snapshot.policyContextDigest, strict.digest);

    store.createWorkAttempt(
      work.workItemId,
      "alice",
      "team",
      bound.work.stateRevision,
      {
        reason: "initial",
        expertId: "expert",
        deploymentId: "dep",
        deploymentConfigVersion: 1,
      },
      120,
    );
    const afterAttempt = store.getWorkInternal(work.workItemId);
    assert.throws(
      () =>
        store.bindRequirementPolicyContext(
          work.workItemId,
          "alice",
          "team",
          afterAttempt.stateRevision,
          afterAttempt.currentRequirementRevision,
          { ...strict, digest: "drifted-policy-digest" } as any,
          130,
        ),
      /REQUIREMENT_POLICY_CONTEXT_DRIFT/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy empty PolicyContext cannot bypass active Attempt deployment binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-policy-context-migration-"));
  const file = join(dir, "runtime.db");
  try {
    let store = new WorkOrchestrationStore(file);
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("policy-migration", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    } as typeof base);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "policy-context-migration",
      sourceType: "mcp",
      title: "migrate",
      description: "migrate",
      workflowId: "policy-migration",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
    let current = store.getWorkInternal(work.workItemId);
    store.createWorkAttempt(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      {
        reason: "initial",
        expertId: "expert-a",
        deploymentId: "deployment-a",
        deploymentConfigVersion: 1,
      },
      110,
    );
    store.close();

    const legacy = new DatabaseSync(file);
    legacy
      .prepare(
        "UPDATE work_requirement_snapshots SET policy_context_ref='',policy_context_digest='' WHERE work_item_id=? AND revision=?",
      )
      .run(work.workItemId, snapshot.revision);
    legacy.close();

    store = new WorkOrchestrationStore(file);
    current = store.getWorkInternal(work.workItemId);
    const workflow = store.getWorkflow(current.workflowId, current.workflowVersion);
    const basePolicy = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
    const driftedPolicy = {
      ...basePolicy,
      deployment: {
        deploymentId: "deployment-b",
        configVersion: 1,
        expertId: "expert-b",
        runtimeProfile: "codex-readonly",
        digest: "deployment-b",
      },
      digest: "policy-context-b",
    };
    const input = store.getDagPlannerInput(work.workItemId);
    const proposal = store.submitDagProposal({
      workItemId: work.workItemId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: input.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: input.frozen.requirementRevision,
      attemptId: current.activeWorkAttemptId,
      plannerIdentity: "planner",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "initial",
      graph: {
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
      },
      policyContext: driftedPolicy,
    });
    assert.equal(proposal.status, "rejected");
    assert.ok(proposal.decisionCodes.includes("PLAN_POLICY_CONTEXT_DRIFT"));

    const pinnedPolicy = {
      ...basePolicy,
      deployment: {
        deploymentId: "deployment-a",
        configVersion: 1,
        expertId: "expert-a",
        runtimeProfile: "codex-readonly",
        digest: "deployment-a",
      },
      digest: "policy-context-a",
    };
    const bound = store.bindRequirementPolicyContext(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      current.currentRequirementRevision,
      pinnedPolicy,
      120,
    );
    assert.equal(bound.snapshot.policyContextDigest, "policy-context-a");
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

test("requirement updates classify compatible, semantic, and execution-contract impact durably", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-requirement-impact-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("requirement-impact", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["build"], required: [] },
      completion: { require: ["required_evidence_passed", "no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "requirement-impact",
      sourceType: "mcp",
      title: "impact",
      description: "impact",
      workflowId: "requirement-impact",
    });
    store.ensureRequirementSnapshot(work.workItemId, 10);

    let current = store.getWorkInternal(work.workItemId);
    const compatible = store.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      current.currentRequirementRevision,
      [
        {
          id: "user:build-alias",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "build" },
        },
      ],
      "typed-v1",
      20,
    );
    assert.deepEqual(compatible.impact.kinds, ["compatible_stricter"]);

    current = compatible.work;
    const executionChanged = store.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      current.currentRequirementRevision,
      [
        {
          id: "user:build-alias",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "ctest" },
        },
      ],
      "typed-v1",
      30,
    );
    assert.ok(executionChanged.impact.kinds.includes("semantics_changed"));
    assert.ok(executionChanged.impact.kinds.includes("execution_contract_changed"));
    assert.deepEqual(executionChanged.impact.changedRequirementIds, ["user:build-alias"]);

    const event = store
      .listEvents(work.workItemId, 0, 100)
      .events.filter((item) => item.eventType === "requirement.updated")
      .at(-1)!;
    assert.deepEqual(event.details?.impactKinds, ["semantics_changed", "execution_contract_changed"]);
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
test("evidence becomes stale when the pinned PolicyContext identity changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-policy-context-evidence-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-policy-evidence", 1, {
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
      idempotencyKey: "policy-context-evidence",
      sourceType: "mcp",
      title: "t",
      description: "verify",
      workflowId: "dynamic-policy-evidence",
    });
    const initial = store.ensureRequirementSnapshot(work.workItemId, 1);
    let current = store.getWorkInternal(work.workItemId);
    store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      initial.revision,
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
      2,
    );
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
      3,
    );
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));
    current = store.getWorkInternal(work.workItemId);
    let claim = store.claimDagNode(
      work.workItemId,
      "a",
      "s",
      "verify",
      "worker",
      current.stateRevision,
      current.currentDagRevision,
      4,
      1000,
    );
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 5);
    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "ctest", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      6,
    );
    assert.equal(store.getDagContext(work.workItemId).evidence.find((item) => item.type === "ctest")?.stale, false);

    current = store.getWorkInternal(work.workItemId);
    const workflow = store.getWorkflow(current.workflowId, current.workflowVersion);
    const currentSnapshot = store.getRequirementSnapshot(work.workItemId, current.currentRequirementRevision);
    const basePolicy = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
    const rebound = store.bindRequirementPolicyContext(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      current.currentRequirementRevision,
      {
        ...basePolicy,
        organization: {
          ...basePolicy.organization,
          ref: "organization:test@2",
          digest: "organization-policy-v2",
        },
        digest: "policy-context-v2",
      },
      7,
    );
    assert.deepEqual(rebound.snapshot.requirements, currentSnapshot.requirements);
    assert.equal(rebound.snapshot.policyContextDigest, "policy-context-v2");
    assert.equal(store.getDagContext(work.workItemId).evidence.find((item) => item.type === "ctest")?.stale, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-flight evidence keeps the requirement semantics of its accepted DAG revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-req-inflight-evidence-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-inflight-evidence", 1, {
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
      idempotencyKey: "inflight-semantics",
      sourceType: "mcp",
      title: "t",
      description: "verify",
      workflowId: "dynamic-inflight-evidence",
    });
    const initial = store.ensureRequirementSnapshot(work.workItemId, 1);
    let current = store.getWorkInternal(work.workItemId);
    const rev1 = store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      initial.revision,
      [
        {
          id: "user:unit",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "unit_test" },
        },
      ],
      "typed-v1",
      2,
    ).snapshot;

    current = store.getWorkInternal(work.workItemId);
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
        reasonCode: "initial",
        graph: {
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
          ],
          edges: [],
        },
      },
      3,
    );
    assert.equal(proposal.status, "accepted");

    current = store.getWorkInternal(work.workItemId);
    let claim = store.claimDagNode(
      work.workItemId,
      "a",
      "s",
      "verify",
      "worker",
      current.stateRevision,
      current.currentDagRevision,
      4,
      10_000,
    );
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 5);

    current = store.getWorkInternal(work.workItemId);
    const rev2 = store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      current.currentRequirementRevision,
      [
        {
          id: "user:unit",
          source: "user",
          strength: "required",
          condition: { kind: "fact", key: "mode.v2", equals: true },
          satisfaction: { kind: "evidence", type: "unit_test" },
        },
      ],
      "typed-v1",
      6,
    ).snapshot;

    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "unit_test", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      7,
    );

    const workflow = store.getWorkflow(work.workflowId, work.workflowVersion).definition;
    const expectedRev1 = evidenceRequirementSemanticsDigest(
      workflow,
      rev1.requirements,
      "unit_test",
      rev1.policyObligations,
      rev1.policyContextDigest,
    );
    const expectedRev2 = evidenceRequirementSemanticsDigest(
      workflow,
      rev2.requirements,
      "unit_test",
      rev2.policyObligations,
      rev2.policyContextDigest,
    );
    const evidence = store.listDagEvidence(work.workItemId).at(-1)!;
    assert.equal(evidence.requirementSemanticsDigest, expectedRev1);
    assert.notEqual(evidence.requirementSemanticsDigest, expectedRev2);
    assert.equal(store.getDagContext(work.workItemId).evidence.find((item) => item.type === "unit_test")?.stale, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending execution claimed after a noop requirement update binds evidence to the new requirement revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-req-noop-claim-evidence-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "db.sqlite"));
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("dynamic-noop-claim-evidence", 1, {
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
      idempotencyKey: "noop-claim-semantics",
      sourceType: "mcp",
      title: "t",
      description: "verify",
      workflowId: "dynamic-noop-claim-evidence",
    });
    const initial = store.ensureRequirementSnapshot(work.workItemId, 1);
    let current = store.getWorkInternal(work.workItemId);
    const rev1 = store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      initial.revision,
      [
        {
          id: "user:unit",
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: "unit_test" },
        },
      ],
      "typed-v1",
      2,
    ).snapshot;
    const graph = {
      nodes: [
        {
          id: "verify",
          kind: "verification" as const,
          capability: "unit_test",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    current = store.getWorkInternal(work.workItemId);
    let input = store.getDagPlannerInput(work.workItemId);
    assert.equal(
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
      }).status,
      "accepted",
    );

    current = store.getWorkInternal(work.workItemId);
    const rev2 = store.updateRequirementSnapshot(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      current.currentRequirementRevision,
      [
        {
          id: "user:unit",
          source: "user",
          strength: "required",
          condition: { kind: "fact", key: "mode.v2", equals: true },
          satisfaction: { kind: "evidence", type: "unit_test" },
        },
      ],
      "typed-v1",
      3,
    ).snapshot;

    current = store.getWorkInternal(work.workItemId);
    input = store.getDagPlannerInput(work.workItemId);
    const noop = store.submitDagProposal(
      {
        workItemId: work.workItemId,
        principalId: "a",
        scope: "s",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "user_update",
        graph,
      },
      4,
    );
    assert.equal(noop.status, "noop");
    assert.equal(store.getWorkInternal(work.workItemId).currentDagRevision, 1);

    current = store.getWorkInternal(work.workItemId);
    let claim = store.claimDagNode(
      work.workItemId,
      "a",
      "s",
      "verify",
      "worker",
      current.stateRevision,
      current.currentDagRevision,
      5,
      10_000,
    );
    claim = store.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 6);
    store.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "unit_test", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      7,
    );

    const workflow = store.getWorkflow(work.workflowId, work.workflowVersion).definition;
    const expectedRev1 = evidenceRequirementSemanticsDigest(
      workflow,
      rev1.requirements,
      "unit_test",
      rev1.policyObligations,
      rev1.policyContextDigest,
    );
    const expectedRev2 = evidenceRequirementSemanticsDigest(
      workflow,
      rev2.requirements,
      "unit_test",
      rev2.policyObligations,
      rev2.policyContextDigest,
    );
    const evidence = store.listDagEvidence(work.workItemId).at(-1)!;
    assert.equal(evidence.requirementSemanticsDigest, expectedRev2);
    assert.notEqual(evidence.requirementSemanticsDigest, expectedRev1);
    assert.equal(store.getDagContext(work.workItemId).evidence.find((item) => item.type === "unit_test")?.stale, false);
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

test("initial RequirementSnapshot durably resolves explicit hard verification intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-resolve-"));
  const file = join(dir, "runtime.db");
  try {
    let store = new WorkOrchestrationStore(file);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-ctest",
      sourceType: "mcp",
      title: "Review and verify",
      description: "Review it. Even if no code changes, run ctest before completion.",
      workflowId: "code-review",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100) as any;
    assert.equal(snapshot.originalRequest, "Review it. Even if no code changes, run ctest before completion.");
    assert.equal(snapshot.resolverIdentity, "builtin-intent-resolver");
    assert.ok(
      snapshot.requirements.some(
        (item: any) =>
          item.source === "user" &&
          item.strength === "required" &&
          item.condition.kind === "always" &&
          item.satisfaction.kind === "evidence" &&
          item.satisfaction.type === "ctest",
      ),
    );
    const revision = snapshot.revision;
    store.close();

    store = new WorkOrchestrationStore(file);
    const reopened = store.getRequirementSnapshot(work.workItemId, revision) as any;
    assert.equal(reopened.originalRequest, snapshot.originalRequest);
    assert.deepEqual(reopened.requirements, snapshot.requirements);
    assert.equal(reopened.effectiveDigest, snapshot.effectiveDigest);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negated hard execution intent is preserved unresolved instead of inverted into a positive evidence obligation", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-negated-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-negated-ctest",
      sourceType: "mcp",
      title: "Do not run ctest",
      description: "You must not run ctest before completion.",
      workflowId: "investigation",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(
      snapshot.requirements.some((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "ctest"),
      false,
    );
    assert.equal(snapshot.unresolved.length, 1);
    assert.equal(snapshot.unresolved[0]?.reason, "UNSUPPORTED_NEGATED_REQUIREMENT");
    assert.match(snapshot.unresolved[0]?.text ?? "", /must not run ctest/i);
    assert.ok(store.evaluateDagCompletion(work.workItemId).missing.includes(snapshot.unresolved[0]!.id));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unresolved requirement add and removal participate in update impact classification", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-unresolved-impact-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const workflow = store.getWorkflow("investigation").definition;
    const unresolved = [
      {
        id: "user:unresolved:custom",
        source: "user" as const,
        strength: "required" as const,
        text: "must satisfy custom gate",
        reason: "UNSUPPORTED_TYPED_REQUIREMENT",
      },
    ];

    const added = classifyRequirementUpdateImpact(workflow, [], [], [], unresolved);
    assert.deepEqual(added.changedRequirementIds, ["user:unresolved:custom"]);
    assert.deepEqual(added.addedRequiredObligationIds, ["user:unresolved:custom"]);
    assert.ok(added.kinds.includes("execution_contract_changed"));

    const removed = classifyRequirementUpdateImpact(workflow, [], [], unresolved, []);
    assert.deepEqual(removed.changedRequirementIds, ["user:unresolved:custom"]);
    assert.deepEqual(removed.removedRequiredObligationIds, ["user:unresolved:custom"]);
    assert.ok(removed.kinds.includes("semantics_changed"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unnormalizable hard execution obligation is durable and prevents silent completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-unresolved-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-unresolved",
      sourceType: "mcp",
      title: "Custom validation",
      description: "You must run frobnicate validation before completion.",
      workflowId: "investigation",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100) as any;
    assert.equal(snapshot.unresolved.length, 1);
    assert.match(snapshot.unresolved[0].text, /frobnicate validation/i);
    const obligations = store.getEffectiveDagObligations(work.workItemId);
    assert.ok(obligations.some((item) => item.id === snapshot.unresolved[0].id));
    const completion = store.evaluateDagCompletion(work.workItemId);
    assert.ok(completion.missing.includes(snapshot.unresolved[0].id));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not-required hard execution language also fails closed instead of creating positive evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-not-required-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-not-required-ctest",
      sourceType: "mcp",
      title: "ctest optional",
      description: "ctest is not required before completion.",
      workflowId: "investigation",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(
      snapshot.requirements.some((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "ctest"),
      false,
    );
    assert.equal(snapshot.unresolved.length, 1);
    assert.equal(snapshot.unresolved[0]?.reason, "UNSUPPORTED_NEGATED_REQUIREMENT");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-code-change condition words do not negate an explicit ctest requirement", () => {
  for (const [index, description] of [
    "Even if no code changes, run ctest before completion.",
    "You must run ctest without changing code.",
  ].entries()) {
    const dir = mkdtempSync(join(tmpdir(), "work-intent-conditional-ctest-"));
    try {
      const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
      const work = store.createOrReuseWork({
        principalId: "alice",
        scope: "team",
        idempotencyKey: "intent-conditional-ctest-" + index,
        sourceType: "mcp",
        title: "ctest required",
        description,
        workflowId: "investigation",
      });
      const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
      assert.ok(
        snapshot.requirements.some(
          (item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "ctest",
        ),
      );
      assert.deepEqual(snapshot.unresolved, []);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("no-form hard execution negation fails closed instead of becoming a positive evidence obligation", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-no-form-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-no-form-ctest",
      sourceType: "mcp",
      title: "No ctest",
      description: "You must run no ctest before completion.",
      workflowId: "investigation",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(
      snapshot.requirements.some((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === "ctest"),
      false,
    );
    assert.equal(snapshot.unresolved.length, 1);
    assert.equal(snapshot.unresolved[0]?.reason, "UNSUPPORTED_NEGATED_REQUIREMENT");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated identical unresolved hard clauses are deduplicated durably", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-unresolved-dedup-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-unresolved-dedup",
      sourceType: "mcp",
      title: "Repeated custom validation",
      description:
        "You must run frobnicate validation before completion. You must run frobnicate validation before completion.",
      workflowId: "investigation",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(snapshot.unresolved.length, 1);
    assert.match(snapshot.unresolved[0]!.text, /frobnicate validation/i);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable requirement update can explicitly resolve an unresolved hard requirement with a typed replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-unresolved-resolution-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "resolve-unresolved-requirement",
      sourceType: "mcp",
      title: "custom gate",
      description: "You must satisfy the custom release gate.",
      workflowId: "investigation",
    });
    const initial = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(initial.unresolved.length, 1);
    const current = store.getWorkInternal(work.workItemId);
    const typedReplacement = [
      {
        id: "user:custom-release-gate",
        source: "user" as const,
        strength: "required" as const,
        condition: { kind: "always" as const },
        satisfaction: { kind: "evidence" as const, type: "custom_release_gate" },
      },
    ];
    const updated = store.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      initial.revision,
      typedReplacement,
      "typed-v3",
      110,
      [],
    );
    assert.deepEqual(updated.snapshot.unresolved, []);
    assert.deepEqual(updated.snapshot.requirements, typedReplacement);
    assert.ok(updated.impact.removedRequiredObligationIds.includes(initial.unresolved[0]!.id));
    assert.ok(updated.impact.addedRequiredObligationIds.includes("user:custom-release-gate"));
    assert.ok(store.getEffectiveDagObligations(work.workItemId).some((item) => item.id === "user:custom-release-gate"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every explicit hard intent is durable even when it is not an execution command", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-intent-hard-unresolved-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "intent-hard-unresolved",
      sourceType: "mcp",
      title: "Do not publish",
      description: "You must not publish the result before a human approves it.",
      workflowId: "investigation",
    });
    const snapshot = store.ensureRequirementSnapshot(work.workItemId, 100);
    assert.equal(snapshot.unresolved.length, 1);
    assert.match(snapshot.unresolved[0]!.text, /must not publish/i);
    assert.ok(store.evaluateDagCompletion(work.workItemId).missing.includes(snapshot.unresolved[0]!.id));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
