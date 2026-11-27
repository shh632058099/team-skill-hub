import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowDefinition } from "../src/expert-platform/work-orchestration-store.js";
import { workflowOnlyDagPolicyContext } from "../src/expert-platform/work-dag-policy-context.js";
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

test("dynamic validator uses explicit PolicyContext mutation constraint instead of inferring deny from missing obligations", () => {
  const wf = workflow("readonly");
  const mutating: DagGraph = {
    nodes: [{ ...node("change", "agent", true), capability: "repair", resource: "workspace" }],
    edges: [],
  };
  const baseContext = workflowOnlyDagPolicyContext("wf", 1, wf);
  assert.equal(
    validateDagProposal(mutating, wf, [], {
      outstandingOnly: true,
      policyContext: {
        ...baseContext,
        executionConstraints: { workspaceMutation: "unspecified" },
      },
      reasonCode: "initial",
    }).codes.includes("PLAN_WORKSPACE_WRITE_NOT_ALLOWED"),
    false,
  );
  assert.equal(
    validateDagProposal(mutating, wf, [], {
      outstandingOnly: true,
      policyContext: {
        ...baseContext,
        executionConstraints: { workspaceMutation: "forbidden" },
      },
      reasonCode: "initial",
    }).codes.includes("PLAN_WORKSPACE_WRITE_NOT_ALLOWED"),
    true,
  );
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
  const wf = {
    ...workflow("code_change", ["build", "unit_test"]),
    planning: { maxReplans: 5, replanPolicy: ["manual" as const] },
  };
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

test("validator fails closed when an outstanding required fact or artifact has no known producer", () => {
  const wf = workflow("readonly");
  const agentGraph: DagGraph = {
    nodes: [{ ...node("agent", "agent"), capability: "analysis", subject: null }],
    edges: [],
  };
  const unknownFact = [
    {
      id: "user:custom-fact",
      condition: { kind: "always" as const },
      satisfaction: { kind: "fact" as const, key: "custom.ready", equals: true },
    },
  ];
  assert.ok(
    validateDagProposal(agentGraph, wf, unknownFact, { outstandingOnly: true }).codes.includes(
      "PLAN_MISSING_REQUIRED_OBLIGATION_PATH",
    ),
  );

  const unknownArtifact = [
    {
      id: "user:custom-artifact",
      condition: { kind: "always" as const },
      satisfaction: { kind: "artifact" as const, type: "custom_bundle" },
    },
  ];
  assert.ok(
    validateDagProposal(agentGraph, wf, unknownArtifact, { outstandingOnly: true }).codes.includes(
      "PLAN_MISSING_REQUIRED_OBLIGATION_PATH",
    ),
  );
});

test("validator recognizes deterministic producers for platform facts and artifacts", () => {
  const wf = workflow("readonly");
  const graph: DagGraph = {
    nodes: [
      { ...node("agent", "agent"), capability: "analysis", subject: null },
      node("review", "review"),
      { ...node("prepare", "publication"), capability: "prepare" },
      { ...node("push", "publication"), capability: "push" },
      { ...node("cr", "change_request"), capability: "create" },
    ],
    edges: [
      { from: "agent", to: "review" },
      { from: "review", to: "prepare" },
      { from: "prepare", to: "push" },
      { from: "push", to: "cr" },
    ],
  };
  const obligations = [
    {
      id: "agent",
      condition: { kind: "always" as const },
      satisfaction: { kind: "fact" as const, key: "agent.completed", equals: true },
    },
    {
      id: "commit",
      condition: { kind: "always" as const },
      satisfaction: { kind: "artifact" as const, type: "git_commit" },
    },
    {
      id: "cr-artifact",
      condition: { kind: "always" as const },
      satisfaction: { kind: "artifact" as const, type: "change_request" },
    },
  ];
  assert.equal(
    validateDagProposal(graph, wf, obligations, { outstandingOnly: true }).codes.includes(
      "PLAN_MISSING_REQUIRED_OBLIGATION_PATH",
    ),
    false,
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
  const strict = {
    ...workflow("readonly", ["unit_test"]),
    planning: { maxReplans: 5, replanPolicy: ["manual" as const] },
  };
  assert.ok(validateDagProposal(graph, strict, obligations).codes.includes("PLAN_MISSING_REQUIRED_EVIDENCE_PATH"));
  const dynamic = { ...strict, planning: { maxReplans: 5, replanPolicy: ["always_after_agent_turn" as const] } };
  assert.deepEqual(validateDagProposal(graph, dynamic, obligations).codes, []);
});

test("initial conditional review may stage unconditional obligations for the guaranteed deadlock replan", () => {
  const wf: WorkflowDefinition = {
    ...workflow("code_change", ["build", "unit_test"]),
    change: { mode: "conditional_code_change", delivery: "merge_request" },
    planning: { maxReplans: 5, replanPolicy: ["on_failure", "on_review_rework"] },
  };
  const graph: DagGraph = {
    nodes: [{ ...node("review", "review"), capability: "review", subject: null, resource: "workspace" }],
    edges: [],
  };
  const obligations = [
    {
      id: "review",
      condition: { kind: "always" as const },
      satisfaction: { kind: "fact" as const, key: "review.accepted", equals: true },
    },
    {
      id: "ctest-even-without-changes",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "ctest" },
    },
    {
      id: "build-if-changed",
      condition: { kind: "fact" as const, key: "workspace.changed", equals: true },
      satisfaction: { kind: "evidence" as const, type: "build" },
    },
  ];

  assert.deepEqual(
    validateDagProposal(graph, wf, obligations, { outstandingOnly: true, reasonCode: "initial" }).codes,
    [],
  );
});

test("evidence consumers never count as producers for required evidence", () => {
  const wf = {
    ...workflow("readonly", ["ctest"]),
    planning: { maxReplans: 5, replanPolicy: ["manual" as const] },
  };
  const graph: DagGraph = {
    nodes: [
      {
        ...node("wait-for-ctest", "wait"),
        capability: "after_ctest",
        requirements: [{ kind: "evidence", type: "ctest" }],
      },
    ],
    edges: [],
  };
  const result = validateDagProposal(graph, wf, []);
  assert.equal(result.accepted, false);
  assert.ok(result.codes.includes("PLAN_MISSING_REQUIRED_EVIDENCE_PATH"));
});

test("policy validator rejects executor and repository capabilities unavailable in pinned policy context", () => {
  const wf = workflow("code_change", ["build"]);
  const policyContext = {
    workflowRef: "wf@1",
    workflowDigest: "wf-digest",
    organization: {
      ref: "organization:default@1",
      digest: "org-digest",
      allowedNodeKinds: ["agent", "verification", "review", "approval", "publication", "change_request", "wait"],
    },
    repository: {
      repositoryId: "repo",
      policyDigest: "repo-digest",
      verificationCapabilities: ["build"],
      publicationPermissions: ["prepare-commit"],
    },
    deployment: {
      deploymentId: "dep",
      configVersion: 1,
      expertId: "expert",
      runtimeProfile: "claude-workspace-write",
      digest: "dep-digest",
    },
    executorCapabilities: {
      agent: ["analysis", "repair"],
      verification: ["build"],
      review: ["review"],
      approval: ["work_completion", "publish_work_branch"],
      publication: ["prepare"],
      change_request: [],
      wait: ["*"],
    },
    limits: { maxReplans: 5, maxReworks: 2, maxTurnsPerRun: 10 },
    usage: { replansUsed: 0, reworksUsed: 0, continuationTurns: 0 },
    digest: "context-digest",
  };
  const unavailableVerification: DagGraph = {
    nodes: [{ ...node("ctest", "verification"), capability: "ctest" }],
    edges: [],
  };
  assert.ok(
    validateDagProposal(unavailableVerification, wf, [], { policyContext } as any).codes.includes(
      "PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE" as any,
    ),
  );

  const forbiddenPush: DagGraph = {
    nodes: [
      node("review", "review"),
      { ...node("prepare", "publication"), capability: "prepare" },
      { ...node("push", "publication"), capability: "push" },
    ],
    edges: [
      { from: "review", to: "prepare" },
      { from: "prepare", to: "push" },
    ],
  };
  assert.ok(
    validateDagProposal(forbiddenPush, wf, [], { policyContext } as any).codes.includes(
      "PLAN_REPOSITORY_CAPABILITY_UNAVAILABLE" as any,
    ),
  );
});

test("policy validator applies repository capabilities per repo resource instead of borrowing the primary repository", () => {
  const wf = workflow("code_change", ["build"]);
  const context: any = {
    workflowRef: "wf@1",
    workflowDigest: "wf",
    organization: {
      ref: "organization:default@1",
      digest: "org",
      allowedNodeKinds: [
        "agent",
        "verification",
        "review",
        "approval",
        "publication",
        "change_request",
        "wait",
        "external_action",
      ],
    },
    repository: {
      repositoryId: "repo-a",
      policyDigest: "repo-a",
      verificationCapabilities: ["build"],
      publicationPermissions: [],
    },
    deployment: {
      deploymentId: "dep",
      configVersion: 1,
      expertId: "expert",
      runtimeProfile: "codex-workspace-write",
      digest: "dep",
    },
    executorCapabilities: {
      agent: ["*"],
      verification: ["build"],
      review: ["review"],
      approval: ["*"],
      publication: [],
      change_request: [],
      wait: ["*"],
      external_action: [],
    },
    resourcePolicies: {
      "repo:repo-a": {
        repository: {
          repositoryId: "repo-a",
          policyDigest: "repo-a",
          verificationCapabilities: ["build"],
          publicationPermissions: [],
        },
        deployment: {
          deploymentId: "dep",
          configVersion: 1,
          expertId: "expert",
          runtimeProfile: "codex-workspace-write",
          digest: "dep-a",
        },
        executorCapabilities: {
          agent: ["*"],
          verification: ["build"],
          review: ["review"],
          approval: ["*"],
          publication: [],
          change_request: [],
          wait: ["*"],
          external_action: [],
        },
      },
      "repo:repo-b": {
        repository: {
          repositoryId: "repo-b",
          policyDigest: "repo-b",
          verificationCapabilities: [],
          publicationPermissions: [],
        },
        deployment: {
          deploymentId: "dep",
          configVersion: 1,
          expertId: "expert",
          runtimeProfile: "codex-workspace-write",
          digest: "dep-b",
        },
        executorCapabilities: {
          agent: ["*"],
          verification: [],
          review: ["review"],
          approval: ["*"],
          publication: [],
          change_request: [],
          wait: ["*"],
          external_action: [],
        },
      },
    },
    limits: { maxReplans: 5, maxReworks: 2, maxTurnsPerRun: 10 },
    usage: { replansUsed: 0, reworksUsed: 0, continuationTurns: 0 },
    digest: "context",
  };
  const graph: DagGraph = {
    nodes: [
      { ...node("build-a", "verification"), capability: "build", resource: "repo:repo-a" },
      { ...node("build-b", "verification"), capability: "build", resource: "repo:repo-b" },
    ],
    edges: [],
  };
  const result = validateDagProposal(graph, wf, [], { policyContext: context });
  assert.equal(result.accepted, false);
  assert.ok(result.codes.includes("PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE" as any));
  assert.ok(result.codes.includes("PLAN_REPOSITORY_CAPABILITY_UNAVAILABLE" as any));
});

test("policy validator enforces pinned planning rework and continuation budgets", () => {
  const wf = workflow("code_change");
  const baseContext = {
    workflowRef: "wf@1",
    workflowDigest: "wf",
    organization: {
      ref: "organization:default@1",
      digest: "org",
      allowedNodeKinds: ["agent", "verification", "review", "approval", "publication", "change_request", "wait"],
    },
    repository: null,
    deployment: null,
    executorCapabilities: {
      agent: ["*"],
      verification: ["*"],
      review: ["review"],
      approval: ["*"],
      publication: ["*"],
      change_request: ["*"],
      wait: ["*"],
    },
    limits: { maxReplans: 3, maxReworks: 2, maxTurnsPerRun: 4 },
    usage: { replansUsed: 3, reworksUsed: 2, continuationTurns: 4 },
    digest: "limits",
  };
  const graph: DagGraph = {
    nodes: [{ ...node("agent", "agent", true), capability: "repair", resource: "workspace", subject: null }],
    edges: [],
  };
  const replanCodes = validateDagProposal(graph, wf, [], {
    policyContext: baseContext,
    reasonCode: "manual",
  } as any).codes;
  assert.ok(replanCodes.includes("PLAN_REPLAN_LIMIT_REACHED" as any));

  const reworkCodes = validateDagProposal(graph, wf, [], {
    policyContext: { ...baseContext, usage: { ...baseContext.usage, replansUsed: 0 } },
    reasonCode: "review_rework",
  } as any).codes;
  assert.ok(reworkCodes.includes("PLAN_REWORK_LIMIT_REACHED" as any));

  const continuationCodes = validateDagProposal(graph, wf, [], {
    policyContext: {
      ...baseContext,
      usage: { ...baseContext.usage, replansUsed: 0, reworksUsed: 0 },
    },
    reasonCode: "verification_failure",
  } as any).codes;
  assert.ok(continuationCodes.includes("PLAN_CONTINUATION_LIMIT_REACHED" as any));
});

test("multi-repository delivery requires a producer for every mutated repository resource", () => {
  const wf = workflow("code_change");
  const obligations = [
    {
      id: "publish@repo:a",
      resource: "repo:a",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "publication" },
    },
    {
      id: "publish@repo:b",
      resource: "repo:b",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "publication" },
    },
    {
      id: "cr@repo:a",
      resource: "repo:a",
      condition: { kind: "always" as const },
      satisfaction: { kind: "artifact" as const, type: "change_request" },
    },
    {
      id: "cr@repo:b",
      resource: "repo:b",
      condition: { kind: "always" as const },
      satisfaction: { kind: "artifact" as const, type: "change_request" },
    },
  ];
  const onlyA: DagGraph = {
    nodes: [
      { ...node("prepare-a", "publication"), capability: "prepare", resource: "repo:a" },
      { ...node("push-a", "publication"), capability: "push", resource: "repo:a" },
      { ...node("cr-a", "change_request"), capability: "create", resource: "repo:a" },
    ],
    edges: [
      { from: "prepare-a", to: "push-a" },
      { from: "push-a", to: "cr-a" },
    ],
  };
  const rejected = validateDagProposal(onlyA, wf, obligations, { outstandingOnly: true });
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.codes.includes("PLAN_MISSING_REQUIRED_EVIDENCE_PATH"));
  assert.ok(rejected.codes.includes("PLAN_MISSING_REQUIRED_OBLIGATION_PATH"));

  const both: DagGraph = {
    nodes: [
      ...onlyA.nodes,
      { ...node("prepare-b", "publication"), capability: "prepare", resource: "repo:b" },
      { ...node("push-b", "publication"), capability: "push", resource: "repo:b" },
      { ...node("cr-b", "change_request"), capability: "create", resource: "repo:b" },
    ],
    edges: [...onlyA.edges, { from: "prepare-b", to: "push-b" }, { from: "push-b", to: "cr-b" }],
  };
  const accepted = validateDagProposal(both, wf, obligations, { outstandingOnly: true });
  assert.equal(accepted.codes.includes("PLAN_MISSING_REQUIRED_EVIDENCE_PATH"), false);
  assert.equal(accepted.codes.includes("PLAN_MISSING_REQUIRED_OBLIGATION_PATH"), false);
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
