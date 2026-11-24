import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowDefinition } from "../src/expert-platform/work-orchestration-store.js";
import { type DagGraph, type DagNode } from "../src/expert-platform/work-dag.js";
import {
  validateDagProposal,
  plannerInputDigest,
  classifyReplanBoundary,
  detectPlanDeadlock,
} from "../src/expert-platform/work-dag-policy.js";

function workflow(mode: "readonly" | "code_change", requiredEvidence: string[] = []): WorkflowDefinition {
  return {
    lifecycle: {
      attempt: { maxWorkAttempts: 3, maxReworks: 2 },
      continuation: { maxTurnsPerRun: 10 },
      retry: { failure: { enabled: true, maxRunsPerWorkAttempt: 2, initialBackoffMs: 1, maxBackoffMs: 10 } },
      blocked: { timeoutPolicy: "manual" },
    },
    execution: { workspace: { strategy: "isolated", reuseOnContinuation: true, cleanup: "on_terminal" } },
    validation: { requiredEvidence, required: [] },
    review: { required: mode === "code_change" },
    change: { mode, ...(mode === "code_change" ? { delivery: "merge_request" as const } : {}) },
    ...(mode === "code_change"
      ? { publication: { required: true, mode: "work_branch" as const, approvalRequired: false } }
      : {}),
    completion: {
      require:
        mode === "code_change"
          ? [
              "latest_work_attempt_succeeded",
              "required_evidence_passed",
              "no_unresolved_blocker",
              "review_accepted",
              "publication_succeeded",
              "change_request_created",
            ]
          : ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
    },
    graph: { mode: "dynamic-dag" },
  };
}
const node = (id: string, kind: DagNode["kind"], mutates = false): DagNode => ({
  id,
  kind,
  capability: kind,
  subject: "s",
  resource: "w",
  mutates,
  requirements: [],
});

test("policy validator rejects writable plans under readonly policy", () => {
  const graph: DagGraph = { nodes: [node("modify", "agent", true)], edges: [] };
  assert.deepEqual(validateDagProposal(graph, workflow("readonly"), []).codes, ["PLAN_WORKSPACE_WRITE_NOT_ALLOWED"]);
});

test("code-change agents cannot understate their real writable workspace", () => {
  const wf = workflow("code_change");
  const readonlyAgent: DagGraph = {
    nodes: [{ ...node("agent", "agent", false), resource: "workspace" }],
    edges: [],
  };
  assert.ok(validateDagProposal(readonlyAgent, wf, []).codes.includes("PLAN_WORKSPACE_WRITE_NOT_ALLOWED"));

  const fakeResource: DagGraph = {
    nodes: [{ ...node("agent", "agent", true), resource: "planner-fake-workspace" }],
    edges: [],
  };
  assert.ok(validateDagProposal(fakeResource, wf, []).codes.includes("PLAN_WORKSPACE_WRITE_NOT_ALLOWED"));
});

test("policy validator proves mandatory evidence and review/publication path exists", () => {
  const wf = workflow("code_change", ["build", "unit_test"]);
  const graph: DagGraph = {
    nodes: [
      { ...node("agent", "agent", true), resource: "workspace" },
      { ...node("build", "verification"), capability: "build" },
      { ...node("unit", "verification"), capability: "unit_test" },
      node("review", "review"),
      { ...node("prepare", "publication"), capability: "prepare" },
      { ...node("push", "publication"), capability: "push" },
      { ...node("cr", "change_request"), capability: "create" },
    ],
    edges: [
      { from: "agent", to: "build" },
      { from: "build", to: "unit" },
      { from: "unit", to: "review" },
      { from: "review", to: "prepare" },
      { from: "prepare", to: "push" },
      { from: "push", to: "cr" },
    ],
  };
  assert.deepEqual(validateDagProposal(graph, wf, []).codes, []);
  assert.ok(
    validateDagProposal(
      {
        nodes: graph.nodes.filter((n) => n.id !== "unit"),
        edges: graph.edges.filter((e) => e.from !== "unit" && e.to !== "unit"),
      },
      wf,
      [],
    ).codes.includes("PLAN_MISSING_REQUIRED_EVIDENCE_PATH"),
  );
  assert.ok(
    validateDagProposal(
      {
        nodes: graph.nodes.filter((n) => n.id !== "review"),
        edges: graph.edges.filter((e) => e.from !== "review" && e.to !== "review"),
      },
      wf,
      [],
    ).codes.includes("PLAN_PUBLICATION_WITHOUT_REVIEW"),
  );

  const wrongCr: DagGraph = {
    nodes: [
      node("review", "review"),
      { ...node("prepare", "publication"), capability: "prepare" },
      { ...node("cr", "change_request"), capability: "create" },
    ],
    edges: [
      { from: "review", to: "prepare" },
      { from: "prepare", to: "cr" },
    ],
  };
  assert.ok(validateDagProposal(wrongCr, wf, []).codes.includes("PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION"));
});
test("publication approval policy requires prepare -> approval -> push ordering", () => {
  const wf: WorkflowDefinition = {
    ...workflow("code_change"),
    publication: { required: true, mode: "work_branch", approvalRequired: true },
    completion: {
      require: [
        "latest_work_attempt_succeeded",
        "no_unresolved_blocker",
        "review_accepted",
        "required_approvals_approved",
        "publication_succeeded",
        "change_request_created",
      ],
      requiredApprovals: [{ scope: "publish_work_branch", subjectType: "publication_artifact" }],
    },
  };
  const good: DagGraph = {
    nodes: [
      node("review", "review"),
      { ...node("prepare", "publication"), capability: "prepare" },
      { ...node("approval", "approval"), capability: "publish_work_branch" },
      { ...node("push", "publication"), capability: "push" },
      { ...node("cr", "change_request"), capability: "create" },
    ],
    edges: [
      { from: "review", to: "prepare" },
      { from: "prepare", to: "approval" },
      { from: "approval", to: "push" },
      { from: "push", to: "cr" },
    ],
  };
  assert.deepEqual(validateDagProposal(good, wf, []).codes, []);
  const noApproval = {
    nodes: good.nodes.filter((n) => n.id !== "approval"),
    edges: [
      { from: "review", to: "prepare" },
      { from: "prepare", to: "push" },
      { from: "push", to: "cr" },
    ],
  };
  assert.ok(validateDagProposal(noApproval, wf, []).codes.includes("PLAN_PUBLICATION_WITHOUT_APPROVAL"));
  const approvalBeforePrepare = {
    nodes: good.nodes,
    edges: [
      { from: "review", to: "approval" },
      { from: "approval", to: "prepare" },
      { from: "prepare", to: "push" },
      { from: "push", to: "cr" },
    ],
  };
  assert.ok(
    validateDagProposal(approvalBeforePrepare, wf, []).codes.includes("PLAN_APPROVAL_WITHOUT_PREPARED_PUBLICATION"),
  );
});

test("parallel mutation of the same writable resource is rejected unless ordered", () => {
  const wf = workflow("code_change");
  const left = { ...node("left", "agent", true), resource: "workspace" };
  const right = { ...node("right", "agent", true), resource: "workspace" };
  const parallel: DagGraph = { nodes: [left, right], edges: [] };
  assert.ok(validateDagProposal(parallel, wf, []).codes.includes("PLAN_PARALLEL_WRITE_CONFLICT"));
  const serial: DagGraph = { nodes: [left, right], edges: [{ from: "left", to: "right" }] };
  assert.equal(validateDagProposal(serial, wf, []).codes.includes("PLAN_PARALLEL_WRITE_CONFLICT"), false);
});

test("outstanding-only validation does not require already satisfied policy paths", () => {
  const wf = workflow("code_change", ["build", "unit_test"]);
  assert.deepEqual(validateDagProposal({ nodes: [], edges: [] }, wf, [], { outstandingOnly: true }).codes, []);
  const outstanding = [
    {
      id: "policy:publication_succeeded",
      condition: { kind: "always" as const },
      satisfaction: { kind: "fact" as const, key: "publication.succeeded", equals: true },
    },
  ];
  assert.ok(
    validateDagProposal({ nodes: [], edges: [] }, wf, outstanding, { outstandingOnly: true }).codes.includes(
      "PLAN_PUBLICATION_PATH_MISSING",
    ),
  );
});

test("user obligations can only strengthen a plan and must have a production path", () => {
  const graph: DagGraph = { nodes: [{ ...node("ctest", "verification"), capability: "ctest" }], edges: [] };
  const obligations = [
    {
      id: "user:ctest",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "ctest" },
    },
  ];
  assert.deepEqual(validateDagProposal(graph, workflow("readonly"), obligations).codes, []);
  assert.ok(
    validateDagProposal({ nodes: [], edges: [] }, workflow("readonly"), obligations).codes.includes(
      "PLAN_MISSING_REQUIRED_EVIDENCE_PATH",
    ),
  );
});

test("agent-only partial revision is legal only with mandatory after-agent replanning", () => {
  const graph: DagGraph = { nodes: [{ ...node("agent", "agent"), capability: "analysis", subject: null }], edges: [] };
  const obligations = [
    {
      id: "unit",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "unit_test" },
    },
  ];
  const strict = workflow("readonly", ["unit_test"]);
  assert.ok(validateDagProposal(graph, strict, obligations).codes.includes("PLAN_MISSING_REQUIRED_EVIDENCE_PATH"));
  const dynamic = { ...strict, planning: { maxReplans: 5, replanPolicy: ["always_after_agent_turn" as const] } };
  assert.deepEqual(validateDagProposal(graph, dynamic, obligations).codes, []);
});

test("planner frozen input digest covers every CAS identity", () => {
  const base = {
    workRevision: 2,
    dagRevision: 1,
    requirementRevision: 3,
    policyIdentity: "wf@1:abc",
    deploymentIdentity: "dep@2",
    subjectRevision: "s",
    factsDigest: "f",
    evidenceDigest: "e",
    executionDigest: "x",
  };
  const digest = plannerInputDigest(base);
  for (const [key, value] of Object.entries(base)) {
    const changed = { ...base, [key]: typeof value === "number" ? value + 1 : value + "x" };
    assert.notEqual(plannerInputDigest(changed), digest, key);
  }
});

test("re-plan and WorkAttempt boundary stays explicit", () => {
  assert.equal(classifyReplanBoundary("verification_failure"), "same_attempt");
  assert.equal(classifyReplanBoundary("new_information"), "same_attempt");
  assert.equal(classifyReplanBoundary("review_rework"), "new_attempt");
  assert.equal(classifyReplanBoundary("policy_incompatible"), "new_attempt");
});

test("outstanding obligations with no runnable execution are deadlocked", () => {
  assert.equal(detectPlanDeadlock({ outstandingObligations: ["build"], ready: [], running: [], waiting: [] }), true);
  assert.equal(
    detectPlanDeadlock({ outstandingObligations: ["build"], ready: ["n"], running: [], waiting: [] }),
    false,
  );
  assert.equal(detectPlanDeadlock({ outstandingObligations: [], ready: [], running: [], waiting: [] }), false);
});
