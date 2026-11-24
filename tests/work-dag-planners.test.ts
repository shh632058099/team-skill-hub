import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkDagSeedPlanner, WorkDagJsonPlanner } from "../src/expert-platform/work-dag-planners.js";
import type { WorkDagPlannerContext } from "../src/expert-platform/work-dag-engine.js";

function context(overrides: Partial<WorkDagPlannerContext> = {}): WorkDagPlannerContext {
  const workflow: any = {
    workflowId: "dynamic",
    version: 1,
    definition: {
      lifecycle: {
        attempt: { maxWorkAttempts: 3, maxReworks: 2 },
        continuation: { maxTurnsPerRun: 10 },
        retry: { failure: { enabled: true, maxRunsPerWorkAttempt: 2, initialBackoffMs: 1, maxBackoffMs: 2 } },
        blocked: { timeoutPolicy: "manual" },
      },
      execution: { workspace: { strategy: "isolated", reuseOnContinuation: true, cleanup: "on_terminal" } },
      validation: { requiredEvidence: ["expert_result", "unit_test"], required: [] },
      review: { required: true },
      change: { mode: "code_change", delivery: "merge_request" },
      publication: { required: true, mode: "work_branch", approvalRequired: true },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
          "required_approvals_approved",
          "publication_succeeded",
          "change_request_created",
        ],
        requiredApprovals: [{ scope: "publish_work_branch", subjectType: "publication_artifact" }],
      },
      graph: { mode: "dynamic-dag" },
    },
    createdAt: 1,
  };
  return {
    work: {
      workItemId: "w",
      title: "t",
      description: "fix it",
      status: "running",
      workflowId: "dynamic",
      workflowVersion: 1,
      currentSubjectRevision: null,
      repositoryId: "repo",
      activeWorkAttemptId: null,
    },
    workflow,
    frozen: {
      workRevision: 1,
      dagRevision: 0,
      requirementRevision: 1,
      policyIdentity: "p",
      deploymentIdentity: null,
      subjectRevision: null,
      factsDigest: "f",
      evidenceDigest: "e",
      executionDigest: "x",
    },
    frozenDigest: "d",
    digest: "d",
    currentGraph: null,
    obligations: [
      { id: "expert", condition: { kind: "always" }, satisfaction: { kind: "evidence", type: "expert_result" } },
      { id: "unit", condition: { kind: "always" }, satisfaction: { kind: "evidence", type: "unit_test" } },
      {
        id: "review",
        condition: { kind: "always" },
        satisfaction: { kind: "fact", key: "review.accepted", equals: true },
      },
      {
        id: "approval",
        condition: { kind: "always" },
        satisfaction: { kind: "fact", key: "approval.required_approved", equals: true },
      },
      {
        id: "publish",
        condition: { kind: "always" },
        satisfaction: { kind: "fact", key: "publication.succeeded", equals: true },
      },
      {
        id: "cr",
        condition: { kind: "always" },
        satisfaction: { kind: "fact", key: "change_request.created", equals: true },
      },
    ] as any,
    runtime: { subject: null, facts: {}, evidence: [], artifacts: [], blockers: [], cancelled: false },
    executions: [],
    facts: [],
    evidence: [],
    artifacts: [],
    ...overrides,
  };
}

test("conditional code-change seed plan reviews first, repairs only after rework, then verifies changed work", async () => {
  const planner = new WorkDagSeedPlanner();
  const base = context();
  const workflow: any = {
    ...base.workflow,
    definition: {
      ...structuredClone(base.workflow.definition),
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
      planning: { maxReplans: 10, replanPolicy: ["on_failure", "on_review_rework", "always_after_agent_turn"] },
    },
  };
  const obligations: any = [
    {
      id: "attempt",
      condition: { kind: "always" },
      satisfaction: { kind: "fact", key: "attempt.latest_succeeded", equals: true },
    },
    {
      id: "review",
      condition: { kind: "always" },
      satisfaction: { kind: "fact", key: "review.accepted", equals: true },
    },
    {
      id: "build",
      condition: { kind: "fact", key: "workspace.changed", equals: true },
      satisfaction: { kind: "evidence", type: "build" },
    },
    {
      id: "unit",
      condition: { kind: "fact", key: "workspace.changed", equals: true },
      satisfaction: { kind: "evidence", type: "unit_test" },
    },
    {
      id: "publish",
      condition: { kind: "fact", key: "workspace.changed", equals: true },
      satisfaction: { kind: "fact", key: "publication.succeeded", equals: true },
    },
    {
      id: "cr",
      condition: { kind: "fact", key: "workspace.changed", equals: true },
      satisfaction: { kind: "fact", key: "change_request.created", equals: true },
    },
  ];
  const initial = await planner.propose(context({ workflow, obligations }), "initial");
  assert.deepEqual(
    initial.nodes.map((node) => [node.kind, node.capability, node.mutates]),
    [["review", "review", false]],
  );

  const repair = await planner.propose(
    context({
      workflow,
      obligations,
      work: { ...base.work, status: "rework", currentSubjectRevision: "a".repeat(40) },
      runtime: {
        subject: "a".repeat(40),
        facts: { "review.rework": true, "workspace.changed": false },
        evidence: [],
        artifacts: [],
        blockers: [],
        cancelled: false,
      },
    }),
    "review_rework",
  );
  assert.deepEqual(
    repair.nodes.map((node) => [node.kind, node.capability, node.mutates]),
    [["agent", "repair", true]],
  );

  const changed = await planner.propose(
    context({
      workflow,
      obligations,
      work: { ...base.work, status: "running", currentSubjectRevision: "workspace:s2", activeWorkAttemptId: "a2" },
      runtime: {
        subject: "workspace:s2",
        facts: { "workspace.changed": true, "review.accepted": false, "attempt.latest_succeeded": false },
        evidence: [],
        artifacts: [],
        blockers: [],
        cancelled: false,
      },
    }),
    "agent_result",
  );
  assert.deepEqual(
    changed.nodes.map((node) => [node.kind, node.capability]),
    [
      ["verification", "build"],
      ["verification", "unit_test"],
      ["review", "review"],
      ["publication", "prepare"],
      ["publication", "push"],
      ["change_request", "create"],
    ],
  );
});

test("seed planner replans after agent subject discovery before binding downstream nodes", async () => {
  const planner = new WorkDagSeedPlanner();
  const initial = await planner.propose(context(), "initial");
  assert.deepEqual(
    initial.nodes.map((n) => n.kind),
    ["agent"],
  );
  const afterAgent = context({
    work: { ...context().work, currentSubjectRevision: "workspace:s1", activeWorkAttemptId: "a1" },
    frozen: { ...context().frozen, dagRevision: 1, subjectRevision: "workspace:s1" },
    runtime: {
      subject: "workspace:s1",
      facts: { "agent.completed": true },
      evidence: [{ type: "expert_result", subject: "workspace:s1", passed: true, stale: false }],
      artifacts: [],
      blockers: [],
      cancelled: false,
    },
  });
  const downstream = await planner.propose(afterAgent, "agent_result");
  assert.deepEqual(
    downstream.nodes.map((n) => [n.kind, n.capability]),
    [
      ["verification", "unit_test"],
      ["review", "review"],
      ["publication", "prepare"],
      ["approval", "publish_work_branch"],
      ["publication", "push"],
      ["change_request", "create"],
    ],
  );
  assert.ok(
    downstream.edges.every(
      (edge, index) => edge.from === downstream.nodes[index]!.id && edge.to === downstream.nodes[index + 1]!.id,
    ),
  );
});

test("seed planner never treats a free-form Work intent as an empty plan, while typed verification-only stays agent-free", async () => {
  const planner = new WorkDagSeedPlanner();
  const base = context();
  const minimalWorkflow: any = {
    ...base.workflow,
    definition: {
      ...structuredClone(base.workflow.definition),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      change: { mode: "readonly" },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      planning: { maxReplans: 5, replanPolicy: ["always_after_agent_turn", "on_failure", "on_user_update"] },
    },
  };
  const freeForm = await planner.propose(
    context({
      workflow: minimalWorkflow,
      obligations: [
        { id: "policy:no_unresolved_blocker", condition: { kind: "always" }, satisfaction: { kind: "no_blocker" } },
      ] as any,
    }),
    "initial",
  );
  assert.deepEqual(
    freeForm.nodes.map((n) => n.kind),
    ["agent"],
  );

  const verificationOnly = await planner.propose(
    context({
      workflow: {
        ...minimalWorkflow,
        definition: { ...minimalWorkflow.definition, validation: { requiredEvidence: ["unit_test"], required: [] } },
      },
      obligations: [
        { id: "policy:no_unresolved_blocker", condition: { kind: "always" }, satisfaction: { kind: "no_blocker" } },
        { id: "unit", condition: { kind: "always" }, satisfaction: { kind: "evidence", type: "unit_test" } },
      ] as any,
    }),
    "initial",
  );
  assert.deepEqual(
    verificationOnly.nodes.map((n) => [n.kind, n.capability]),
    [["verification", "unit_test"]],
  );
});

test("verification failure and review rework force a fresh agent repair node", async () => {
  const planner = new WorkDagSeedPlanner();
  for (const reason of ["verification_failure", "review_rework"]) {
    const graph = await planner.propose(
      context({
        work: {
          ...context().work,
          currentSubjectRevision: "workspace:s1",
          status: reason === "review_rework" ? "rework" : "running",
        },
        runtime: { subject: "workspace:s1", facts: {}, evidence: [], artifacts: [], blockers: [], cancelled: false },
      }),
      reason,
    );
    assert.deepEqual(
      graph.nodes.map((n) => n.kind),
      ["agent"],
    );
  }
});

test("seed planner does not repeat already satisfied review and delivery gates on requirement re-plan", async () => {
  const planner = new WorkDagSeedPlanner();
  const base = context();
  const satisfied = context({
    work: { ...base.work, currentSubjectRevision: "workspace:s1", activeWorkAttemptId: null },
    frozen: { ...base.frozen, dagRevision: 7, subjectRevision: "workspace:s1" },
    runtime: {
      subject: "workspace:s1",
      facts: {
        "attempt.latest_succeeded": true,
        "review.accepted": true,
        "approval.required_approved": true,
        "publication.succeeded": true,
        "change_request.created": true,
      },
      evidence: [
        { type: "expert_result", subject: "workspace:s1", passed: true, stale: false },
        { type: "unit_test", subject: "workspace:s1", passed: true, stale: false },
      ],
      artifacts: [],
      blockers: [],
      cancelled: false,
    },
  });
  const graph = await planner.propose(satisfied, "user_update");
  assert.deepEqual(graph, { nodes: [], edges: [] });
});

test("json planner forwards cancellation signal to its model", async () => {
  let observed: AbortSignal | undefined;
  const planner = new WorkDagJsonPlanner(
    {
      async complete(...args: any[]) {
        observed = args[1] as AbortSignal | undefined;
        return JSON.stringify({ nodes: [], edges: [] });
      },
    } as any,
    "model",
    "1",
  );
  const controller = new AbortController();
  await planner.propose(context(), "manual", controller.signal);
  assert.equal(observed, controller.signal);
});

test("json planner parses strict graph output and rejects non-graph model output", async () => {
  const good = new WorkDagJsonPlanner(
    {
      complete: async () =>
        JSON.stringify({
          nodes: [
            {
              id: "a",
              kind: "agent",
              capability: "analysis",
              subject: null,
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
          ],
          edges: [],
        }),
    },
    "model",
    "1",
  );
  assert.equal((await good.propose(context(), "manual")).nodes[0]?.id, "a");
  const bad = new WorkDagJsonPlanner(
    { complete: async () => '{"nodes":[],"edges":[],"shell":"rm -rf /"}' },
    "model",
    "1",
  );
  await assert.rejects(() => bad.propose(context(), "manual"), /PLANNER_OUTPUT_INVALID/);
});
