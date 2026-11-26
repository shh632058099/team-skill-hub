import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import {
  WorkDagPlannerCoordinator,
  WorkDagScheduler,
  type WorkDagExecutorAdapter,
} from "../src/expert-platform/work-dag-engine.js";
import { WorkDagRuntime } from "../src/expert-platform/work-dag-runtime-service.js";
import {
  WorkDagPolicyContextResolver,
  workflowOnlyDagPolicyContext,
} from "../src/expert-platform/work-dag-policy-context.js";
import { createExpertTaskDagAdapters } from "../src/expert-platform/work-dag-expert-adapters.js";
import { validateDagProposal } from "../src/expert-platform/work-dag-policy.js";
import { evaluatePredicate, type DagGraph } from "../src/expert-platform/work-dag.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkPublicationStore } from "../src/expert-platform/work-publication-store.js";
import { WorkChangeRequestStore } from "../src/expert-platform/work-change-request-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";

function permissiveResourcePolicyContext(
  store: WorkOrchestrationStore,
  workItemId: string,
  resourceKeys: readonly string[],
) {
  const work = store.getWorkInternal(workItemId);
  const workflow = store.getWorkflow(work.workflowId, work.workflowVersion);
  const base = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
  const wildcardCapabilities = {
    agent: ["*"],
    verification: ["*"],
    review: ["*"],
    approval: ["*"],
    publication: ["*"],
    change_request: ["*"],
    wait: ["*"],
    external_action: ["*"],
  };
  return {
    ...base,
    resourcePolicies: Object.fromEntries(
      resourceKeys.map((resourceKey) => {
        const repositoryId = resourceKey.slice("repo:".length);
        return [
          resourceKey,
          {
            repository: {
              repositoryId,
              policyDigest: "test-repository-policy:" + repositoryId,
              verificationCapabilities: ["*"],
              publicationPermissions: ["prepare-commit", "push-work-branch", "create-change-request"],
            },
            deployment: {
              deploymentId: "test-deployment:" + repositoryId,
              configVersion: 1,
              expertId: "test",
              runtimeProfile: "codex-workspace-write",
              digest: "test-deployment-policy:" + repositoryId,
            },
            executorCapabilities: wildcardCapabilities,
          },
        ];
      }),
    ),
  };
}

function writableWorkflow(store: WorkOrchestrationStore) {
  const base = store.getWorkflow("investigation").definition;
  const definition = {
    ...structuredClone(base),
    change: { mode: "conditional_code_change" as const },
    validation: { requiredEvidence: ["expert_result", "build", "unit_test"], required: [] },
    review: { required: true },
    publication: { required: false, mode: "work_branch" as const, approvalRequired: false },
    completion: {
      require: [
        "latest_work_attempt_succeeded",
        "required_evidence_passed",
        "no_unresolved_blocker",
        "review_accepted",
      ] as const,
    },
    planning: {
      maxReplans: 12,
      replanPolicy: ["always_after_agent_turn", "on_failure", "manual"] as const,
    },
    graph: { mode: "dynamic-dag" as const },
  };
  store.putWorkflow("multi-repo-write", 1, definition as any);
  return store.getWorkflow("multi-repo-write").definition;
}

function multiResourceVerificationWorkflow(store: WorkOrchestrationStore) {
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("multi-resource-verify", 1, {
    ...structuredClone(base),
    change: { mode: "readonly" },
    validation: { requiredEvidence: ["build"], required: [] },
    review: { required: false },
    publication: { required: false, mode: "work_branch", approvalRequired: false },
    completion: { require: ["required_evidence_passed", "no_unresolved_blocker"] },
    graph: { mode: "dynamic-dag" },
  } as typeof base);
  return store.getWorkflow("multi-resource-verify").definition;
}

test("one WorkAttempt owns independent durable workspaces for multiple repository resources", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-multi-workspace-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "multi-workspace",
      sourceType: "mcp",
      title: "multi",
      description: "change two repositories",
      workflowId: "investigation",
      repositoryId: "repo-a",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team", work.stateRevision, {
      reason: "initial",
      expertId: "multi",
      deploymentId: "multi-write",
      deploymentConfigVersion: 1,
    });
    const a = store.ensureWorkspace(
      work.workItemId,
      attempt.workAttemptId,
      {
        resourceKey: "repo:repo-a",
        repositoryId: "repo-a",
        repositoryUrl: "https://example.test/a.git",
        branch: "main",
      } as any,
      10,
    );
    const b = store.ensureWorkspace(
      work.workItemId,
      attempt.workAttemptId,
      {
        resourceKey: "repo:repo-b",
        repositoryId: "repo-b",
        repositoryUrl: "https://example.test/b.git",
        branch: "main",
      } as any,
      11,
    );

    assert.notEqual(a.workspaceId, b.workspaceId);
    assert.notEqual(a.workspaceKey, b.workspaceKey);
    assert.equal((a as any).resourceKey, "repo:repo-a");
    assert.equal((b as any).resourceKey, "repo:repo-b");
    assert.equal((a as any).repositoryId, "repo-a");
    assert.equal((b as any).repositoryId, "repo-b");
    assert.equal(store.listWorkspaces(work.workItemId).length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validator permits unordered writes to distinct repository resources but still rejects same-resource writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-multi-resource-policy-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const workflow = writableWorkflow(store);
    const left = {
      id: "left",
      kind: "agent" as const,
      capability: "repair",
      subject: null,
      resource: "repo:repo-a",
      mutates: true,
      requirements: [],
    };
    const right = { ...left, id: "right", resource: "repo:repo-b" };
    assert.equal(
      validateDagProposal({ nodes: [left, right], edges: [] }, workflow, []).codes.includes(
        "PLAN_WORKSPACE_WRITE_NOT_ALLOWED",
      ),
      false,
    );
    const same = { ...right, resource: "repo:repo-a" };
    assert.ok(
      validateDagProposal({ nodes: [left, same], edges: [] }, workflow, []).codes.includes(
        "PLAN_PARALLEL_WRITE_CONFLICT",
      ),
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration join waits for both repository branches", async () => {
  const { readyNodes } = await import("../src/expert-platform/work-dag.js");
  const graph: DagGraph = {
    nodes: [
      {
        id: "repo-a",
        kind: "agent",
        capability: "repair",
        subject: null,
        resource: "repo:repo-a",
        mutates: true,
        requirements: [],
      },
      {
        id: "repo-b",
        kind: "agent",
        capability: "repair",
        subject: null,
        resource: "repo:repo-b",
        mutates: true,
        requirements: [],
      },
      {
        id: "integration",
        kind: "verification",
        capability: "integration_test",
        subject: null,
        resource: null,
        mutates: false,
        requirements: [],
      },
    ],
    edges: [
      { from: "repo-a", to: "integration" },
      { from: "repo-b", to: "integration" },
    ],
  };
  const context = { subject: null, facts: {}, evidence: [], artifacts: [], blockers: [], cancelled: false };
  assert.deepEqual(
    readyNodes(
      graph,
      [
        { nodeId: "repo-a", generation: 1, state: "succeeded", fence: 1, key: "a" },
        { nodeId: "repo-b", generation: 1, state: "running", fence: 1, key: "b" },
        { nodeId: "integration", generation: 1, state: "pending", fence: 0, key: "i" },
      ],
      context,
    ).map((node) => node.id),
    [],
  );
  assert.deepEqual(
    readyNodes(
      graph,
      [
        { nodeId: "repo-a", generation: 1, state: "succeeded", fence: 1, key: "a" },
        { nodeId: "repo-b", generation: 1, state: "succeeded", fence: 1, key: "b" },
        { nodeId: "integration", generation: 1, state: "pending", fence: 0, key: "i" },
      ],
      context,
    ).map((node) => node.id),
    ["integration"],
  );
});

test("resource subjects isolate evidence staleness across repositories", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-resource-subjects-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    multiResourceVerificationWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "resource-subjects",
      sourceType: "mcp",
      title: "multi",
      description: "verify two repositories",
      workflowId: "multi-resource-verify",
      repositoryId: "repo-a",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a1", 10);
    store.setDagResourceSubject(work.workItemId, "repo:repo-b", "workspace:b1", 11);

    const plannerInput = store.getDagPlannerInput(work.workItemId);
    const proposal = store.submitDagProposal({
      workItemId: work.workItemId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: plannerInput.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: plannerInput.frozen.requirementRevision,
      plannerIdentity: "test",
      plannerVersion: "1",
      plannerInputDigest: plannerInput.digest,
      reasonCode: "initial",
      policyContext: permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a", "repo:repo-b"]),
      graph: {
        nodes: [
          {
            id: "build-a",
            kind: "verification",
            capability: "build",
            subject: "workspace:a1",
            resource: "repo:repo-a",
            mutates: false,
            requirements: [],
          },
          {
            id: "build-b",
            kind: "verification",
            capability: "build",
            subject: "workspace:b1",
            resource: "repo:repo-b",
            mutates: false,
            requirements: [],
          },
        ],
        edges: [],
      },
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));

    for (const [nodeId, subject, resource, now] of [
      ["build-a", "workspace:a1", "repo:repo-a", 20],
      ["build-b", "workspace:b1", "repo:repo-b", 30],
    ] as const) {
      const current = store.getWorkInternal(work.workItemId);
      const claimed = store.claimDagNode(
        work.workItemId,
        "alice",
        "team",
        nodeId,
        "hub",
        current.stateRevision,
        current.currentDagRevision,
        now,
      );
      const running = store.startDagNodeExecution(claimed.nodeExecutionId, "hub", claimed.fence, now + 1);
      store.reconcileDagNodeResult(
        running.nodeExecutionId,
        "hub",
        running.fence,
        {
          status: "succeeded",
          evidence: [
            {
              type: "build",
              passed: true,
              subjectRevision: subject,
              resourceIdentity: resource,
              verifierIdentity: "test",
            },
          ],
        },
        now + 2,
      );
    }

    let context = store.getDagContext(work.workItemId);
    assert.equal(context.resourceSubjects?.["repo:repo-a"], "workspace:a1");
    assert.equal(context.resourceSubjects?.["repo:repo-b"], "workspace:b1");
    assert.equal(context.evidence.find((item) => item.resource === "repo:repo-a")?.stale, false);
    assert.equal(context.evidence.find((item) => item.resource === "repo:repo-b")?.stale, false);

    store.setDagResourceSubject(work.workItemId, "repo:repo-b", "workspace:b2", 40);
    context = store.getDagContext(work.workItemId);
    assert.equal(context.evidence.find((item) => item.resource === "repo:repo-a")?.stale, false);
    assert.equal(
      context.evidence.find((item) => item.resource === "repo:repo-b" && item.subject === "workspace:b1")?.stale,
      true,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("resource-scoped DAG facts become stale only for the repository whose subject changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-resource-facts-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    multiResourceVerificationWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "resource-facts",
      sourceType: "mcp",
      title: "facts",
      description: "facts per repo",
      workflowId: "multi-resource-verify",
      repositoryId: "repo-a",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a1", 10);
    store.setDagResourceSubject(work.workItemId, "repo:repo-b", "workspace:b1", 11);
    const input = store.getDagPlannerInput(work.workItemId);
    const proposal = store.submitDagProposal({
      workItemId: work.workItemId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: input.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: input.frozen.requirementRevision,
      plannerIdentity: "test",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "initial",
      policyContext: permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a", "repo:repo-b"]),
      graph: {
        nodes: [
          {
            id: "verify-a",
            kind: "verification",
            capability: "build",
            subject: "workspace:a1",
            resource: "repo:repo-a",
            mutates: false,
            requirements: [],
          },
          {
            id: "verify-b",
            kind: "verification",
            capability: "build",
            subject: "workspace:b1",
            resource: "repo:repo-b",
            mutates: false,
            requirements: [],
          },
        ],
        edges: [],
      },
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));
    for (const [nodeId, now] of [
      ["verify-a", 20],
      ["verify-b", 30],
    ] as const) {
      const current = store.getWorkInternal(work.workItemId);
      const claimed = store.claimDagNode(
        work.workItemId,
        "alice",
        "team",
        nodeId,
        "hub",
        current.stateRevision,
        current.currentDagRevision,
        now,
      );
      const running = store.startDagNodeExecution(claimed.nodeExecutionId, "hub", claimed.fence, now + 1);
      store.reconcileDagNodeResult(
        running.nodeExecutionId,
        "hub",
        running.fence,
        { status: "succeeded", facts: [{ key: "repo.ready", value: true }] },
        now + 2,
      );
    }
    let context = store.getDagContext(work.workItemId);
    assert.equal(
      evaluatePredicate({ kind: "fact", key: "repo.ready", equals: true }, context, [], "repo:repo-a"),
      true,
    );
    assert.equal(
      evaluatePredicate({ kind: "fact", key: "repo.ready", equals: true }, context, [], "repo:repo-b"),
      true,
    );

    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a2", 40);
    context = store.getDagContext(work.workItemId);
    assert.equal(
      evaluatePredicate({ kind: "fact", key: "repo.ready", equals: true }, context, [], "repo:repo-a"),
      "unknown",
    );
    assert.equal(
      evaluatePredicate({ kind: "fact", key: "repo.ready", equals: true }, context, [], "repo:repo-b"),
      true,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node result cannot forge evidence or artifacts for another repository resource", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-result-provenance-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    multiResourceVerificationWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "result-provenance",
      sourceType: "mcp",
      title: "multi",
      description: "verify two repositories",
      workflowId: "multi-resource-verify",
      repositoryId: "repo-a",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a1", 10);
    store.setDagResourceSubject(work.workItemId, "repo:repo-b", "workspace:b1", 11);
    const input = store.getDagPlannerInput(work.workItemId);
    const proposal = store.submitDagProposal({
      workItemId: work.workItemId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: input.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: input.frozen.requirementRevision,
      plannerIdentity: "test",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "initial",
      policyContext: permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a", "repo:repo-b"]),
      graph: {
        nodes: [
          {
            id: "build-a",
            kind: "verification",
            capability: "build",
            subject: "workspace:a1",
            resource: "repo:repo-a",
            mutates: false,
            requirements: [],
          },
          {
            id: "build-b",
            kind: "verification",
            capability: "build",
            subject: "workspace:b1",
            resource: "repo:repo-b",
            mutates: false,
            requirements: [],
          },
        ],
        edges: [],
      },
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));
    const current = store.getWorkInternal(work.workItemId);
    const claimed = store.claimDagNode(
      work.workItemId,
      "alice",
      "team",
      "build-a",
      "hub",
      current.stateRevision,
      current.currentDagRevision,
      20,
    );
    const running = store.startDagNodeExecution(claimed.nodeExecutionId, "hub", claimed.fence, 21);

    assert.throws(
      () =>
        store.reconcileDagNodeResult(
          running.nodeExecutionId,
          "hub",
          running.fence,
          {
            status: "succeeded",
            evidence: [
              {
                type: "build",
                passed: true,
                subjectRevision: "workspace:b1",
                resourceIdentity: "repo:repo-b",
                verifierIdentity: "test",
              },
            ],
          },
          22,
        ),
      /DAG_RESULT_RESOURCE_MISMATCH/,
    );
    assert.throws(
      () =>
        store.reconcileDagNodeResult(
          running.nodeExecutionId,
          "hub",
          running.fence,
          {
            status: "succeeded",
            artifacts: [
              {
                artifactId: "artifact-b",
                type: "report",
                ref: "artifact://repo-b",
                subjectRevision: "workspace:b1",
                resourceIdentity: "repo:repo-b",
              },
            ],
          },
          23,
        ),
      /DAG_RESULT_RESOURCE_MISMATCH/,
    );
    assert.throws(
      () =>
        store.reconcileDagNodeResult(
          running.nodeExecutionId,
          "hub",
          running.fence,
          {
            status: "succeeded",
            evidence: [
              {
                type: "build",
                passed: true,
                subjectRevision: "workspace:b1",
                resourceIdentity: "repo:repo-a",
                verifierIdentity: "test",
              },
            ],
          },
          24,
        ),
      /DAG_RESULT_SUBJECT_MISMATCH/,
    );
    assert.equal(store.listDagEvidence(work.workItemId).length, 0);
    assert.equal(store.listDagArtifacts(work.workItemId).length, 0);
    assert.equal(store.listDagExecutions(work.workItemId).find((item) => item.nodeId === "build-a")?.state, "running");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutating node facts bind to the authoritative post-mutation resource subject", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-mutating-fact-subject-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    writableWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "mutating-fact-subject",
      sourceType: "mcp",
      title: "change",
      description: "change repo a",
      workflowId: "multi-repo-write",
      repositoryId: "repo-a",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a1", 10);
    const input = store.getDagPlannerInput(work.workItemId);
    const proposal = store.submitDagProposal({
      workItemId: work.workItemId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: input.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: input.frozen.requirementRevision,
      plannerIdentity: "test",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "initial",
      policyContext: permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a"]),
      graph: {
        nodes: [
          {
            id: "change-a",
            kind: "agent",
            capability: "repair",
            subject: "workspace:a1",
            resource: "repo:repo-a",
            mutates: true,
            requirements: [],
          },
        ],
        edges: [],
      },
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));
    const current = store.getWorkInternal(work.workItemId);
    const claimed = store.claimDagNode(
      work.workItemId,
      "alice",
      "team",
      "change-a",
      "hub",
      current.stateRevision,
      current.currentDagRevision,
      20,
    );
    const running = store.startDagNodeExecution(claimed.nodeExecutionId, "hub", claimed.fence, 21);
    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a2", 22);
    store.reconcileDagNodeResult(
      running.nodeExecutionId,
      "hub",
      running.fence,
      { status: "succeeded", facts: [{ key: "workspace.changed", value: true }] },
      23,
    );
    const fact = store.listDagFacts(work.workItemId).find((item) => item.key === "workspace.changed");
    assert.equal(fact?.subjectRevision, "workspace:a2");
    assert.equal(fact?.resourceIdentity, "repo:repo-a");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime compares repo-scoped pending nodes against the repository subject instead of the composite Work subject", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-resource-stale-runtime-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    multiResourceVerificationWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "resource-stale-runtime",
      sourceType: "mcp",
      title: "verify",
      description: "verify repo a",
      workflowId: "multi-resource-verify",
      repositoryId: "repo-a",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    store.setDagResourceSubject(work.workItemId, "repo:repo-a", "workspace:a1", 10);
    const graph: DagGraph = {
      nodes: [
        {
          id: "build-a",
          kind: "verification",
          capability: "build",
          subject: "workspace:a1",
          resource: "repo:repo-a",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [],
    };
    const reasons: string[] = [];
    const planner = {
      identity: "test",
      version: "1",
      async propose(_input: unknown, reason: string) {
        reasons.push(reason);
        return graph;
      },
    };
    let executions = 0;
    const verification: WorkDagExecutorAdapter = {
      kind: "verification",
      capability: "build",
      async execute() {
        executions++;
        return {
          status: "succeeded",
          evidence: [
            {
              type: "build",
              passed: true,
              subjectRevision: "workspace:a1",
              resourceIdentity: "repo:repo-a",
              verifierIdentity: "test",
            },
          ],
        };
      },
    };
    const policyProvider = {
      resolve() {
        return permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a"]);
      },
    };
    const runtime = new WorkDagRuntime(
      store,
      new WorkDagPlannerCoordinator(store, planner, 30_000, policyProvider),
      new WorkDagScheduler(store, [verification]),
    );

    assert.equal(await runtime.reconcileWork(work.workItemId, "alice", "team", 20), true);
    assert.equal(await runtime.reconcileWork(work.workItemId, "alice", "team", 21), true);
    assert.deepEqual(reasons, ["initial"]);
    assert.equal(executions, 1);
    assert.equal(
      store.listDagExecutions(work.workItemId).find((item) => item.nodeId === "build-a")?.state,
      "succeeded",
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace alias and primary repository resource conflict for unordered writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-primary-resource-alias-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const workflow = writableWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "primary-resource-alias",
      sourceType: "mcp",
      title: "change",
      description: "change primary repo",
      workflowId: "multi-repo-write",
      repositoryId: "repo-a",
    });
    const basePolicy = permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a"]);
    const primaryPolicy = basePolicy.resourcePolicies?.["repo:repo-a"]!;
    const policyContext = {
      ...basePolicy,
      repository: primaryPolicy.repository,
      deployment: primaryPolicy.deployment,
    };
    const graph: DagGraph = {
      nodes: [
        {
          id: "legacy-primary",
          kind: "agent",
          capability: "repair",
          subject: null,
          resource: "workspace",
          mutates: true,
          requirements: [],
        },
        {
          id: "explicit-primary",
          kind: "agent",
          capability: "repair",
          subject: null,
          resource: "repo:repo-a",
          mutates: true,
          requirements: [],
        },
      ],
      edges: [],
    };
    const validation = validateDagProposal(graph, workflow, [], { policyContext });
    assert.ok(validation.codes.includes("PLAN_PARALLEL_WRITE_CONFLICT"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active workspace write blocks a primary-repository alias write", async () => {
  const { readyNodes } = await import("../src/expert-platform/work-dag.js");
  const graph: DagGraph = {
    nodes: [
      {
        id: "legacy-primary",
        kind: "agent",
        capability: "repair",
        subject: null,
        resource: "workspace",
        mutates: true,
        requirements: [],
      },
      {
        id: "explicit-primary",
        kind: "agent",
        capability: "repair",
        subject: null,
        resource: "repo:repo-a",
        mutates: true,
        requirements: [],
      },
    ],
    edges: [],
  };
  const context = {
    subject: "resources:composite",
    primaryResource: "repo:repo-a",
    resourceSubjects: { "repo:repo-a": "workspace:a1" },
    facts: {},
    evidence: [],
    artifacts: [],
    blockers: [],
    cancelled: false,
  };
  assert.deepEqual(
    readyNodes(
      graph,
      [
        { nodeId: "legacy-primary", generation: 1, state: "running", fence: 1, key: "legacy" },
        { nodeId: "explicit-primary", generation: 1, state: "pending", fence: 0, key: "explicit" },
      ],
      context,
    ).map((node) => node.id),
    [],
  );
});

test("resource-bound node subject is validated against that repository rather than global composite subject", async () => {
  const { readyNodes } = await import("../src/expert-platform/work-dag.js");
  const graph: DagGraph = {
    nodes: [
      {
        id: "verify-a",
        kind: "verification",
        capability: "build",
        subject: "workspace:a1",
        resource: "repo:repo-a",
        mutates: false,
        requirements: [],
      },
    ],
    edges: [],
  };
  const context = {
    subject: "resources:composite",
    resourceSubjects: { "repo:repo-a": "workspace:a1", "repo:repo-b": "workspace:b2" },
    facts: {},
    evidence: [],
    artifacts: [],
    blockers: [],
    cancelled: false,
  };
  assert.deepEqual(
    readyNodes(
      graph,
      [{ nodeId: "verify-a", generation: 1, state: "pending", fence: 0, key: "verify-a" }],
      context,
    ).map((node) => node.id),
    ["verify-a"],
  );
});

test("required verification evidence is required independently for every mutated repository resource", async () => {
  const { completion } = await import("../src/expert-platform/work-dag.js");
  const obligations = [
    {
      id: "policy:evidence:build@repo:repo-a",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "build" },
      resource: "repo:repo-a",
    },
    {
      id: "policy:evidence:build@repo:repo-b",
      condition: { kind: "always" as const },
      satisfaction: { kind: "evidence" as const, type: "build" },
      resource: "repo:repo-b",
    },
  ];
  const context = {
    subject: "resources:composite",
    resourceSubjects: { "repo:repo-a": "workspace:a1", "repo:repo-b": "workspace:b1" },
    facts: {},
    evidence: [
      {
        type: "build",
        subject: "workspace:a1",
        resource: "repo:repo-a",
        passed: true,
        stale: false,
      },
    ],
    artifacts: [],
    blockers: [],
    cancelled: false,
  };
  assert.deepEqual(completion(obligations, [], context).missing, ["policy:evidence:build@repo:repo-b"]);
});

test("mutating DAG agent nodes on different repository resources dispatch to different repository workspaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-multi-repo-dispatch-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const store = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "multi",
      displayName: "Multi Repo",
      capabilities: ["repair"],
      keywords: ["multi"],
      active: true,
    });
    experts.putDeployment({
      id: "multi-write",
      expertId: "multi",
      repositoryIds: ["repo-a", "repo-b"],
      repositories: [
        {
          id: "repo-a",
          url: "https://example.test/a.git",
          branch: "main",
          credentialRef: "repo-a-publish",
          publicationPolicy: {
            version: 1,
            permissions: ["prepare-commit", "push-work-branch", "create-change-request"],
            branchPrefix: "work/a/",
            protectedBranches: ["main"],
            allowedPushRemote: "origin",
            allowForcePush: false,
            allowDeleteRef: false,
          },
        },
        {
          id: "repo-b",
          url: "https://example.test/b.git",
          branch: "main",
          credentialRef: "repo-b-publish",
          publicationPolicy: {
            version: 2,
            permissions: ["prepare-commit", "push-work-branch", "create-change-request"],
            branchPrefix: "work/b/",
            protectedBranches: ["main"],
            allowedPushRemote: "origin",
            allowForcePush: false,
            allowDeleteRef: false,
          },
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "test",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    writableWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "multi-repo-dispatch",
      sourceType: "mcp",
      title: "multi",
      description: "change repo a and repo b",
      workflowId: "multi-repo-write",
      expertId: "multi",
      deploymentId: "multi-write",
      repositoryId: "repo-a",
    });
    store.ensureRequirementSnapshot(work.workItemId);

    const graph: DagGraph = {
      nodes: [
        {
          id: "change-a",
          kind: "agent",
          capability: "repair",
          subject: null,
          resource: "repo:repo-a",
          mutates: true,
          requirements: [],
        },
        {
          id: "change-b",
          kind: "agent",
          capability: "repair",
          subject: null,
          resource: "repo:repo-b",
          mutates: true,
          requirements: [],
        },
      ],
      edges: [],
    };
    const input = store.getDagPlannerInput(work.workItemId);
    const proposal = store.submitDagProposal({
      workItemId: work.workItemId,
      principalId: "alice",
      scope: "team",
      expectedWorkRevision: input.frozen.workRevision,
      expectedDagRevision: 0,
      expectedRequirementRevision: input.frozen.requirementRevision,
      plannerIdentity: "test",
      plannerVersion: "1",
      plannerInputDigest: input.digest,
      reasonCode: "initial",
      policyContext: permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a", "repo:repo-b"]),
      graph,
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));

    const scheduler = new WorkDagScheduler(
      store,
      createExpertTaskDagAdapters(store, tasks, new ExpertDispatchService(experts, tasks)),
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 20), true);
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 21), true);

    const executions = store.listDagExecutions(work.workItemId);
    const aExecution = executions.find((item) => item.nodeId === "change-a")!;
    const bExecution = executions.find((item) => item.nodeId === "change-b")!;
    const aTask = tasks.getByIdempotency("alice", "team", "dag:" + aExecution.idempotencyKey)!;
    const bTask = tasks.getByIdempotency("alice", "team", "dag:" + bExecution.idempotencyKey)!;
    assert.equal(aTask.repositoryId, "repo-a");
    assert.equal(bTask.repositoryId, "repo-b");
    assert.notEqual(aTask.workspaceKey, bTask.workspaceKey);
    assert.equal(aTask.workAttemptId, bTask.workAttemptId);
    const usageContext = new WorkDagPolicyContextResolver(
      store,
      new ExpertDispatchService(experts, tasks),
      experts,
      tasks,
    ).resolve(store.getWorkInternal(work.workItemId), store.getWorkflow(work.workflowId, work.workflowVersion));
    assert.equal(usageContext.usage.continuationTurns, 2);
    const workspaces = store.listWorkspaces(work.workItemId);
    assert.deepEqual(workspaces.map((item: any) => [item.resourceKey, item.repositoryId]).sort(), [
      ["repo:repo-a", "repo-a"],
      ["repo:repo-b", "repo-b"],
    ]);

    const workspaceA = workspaces.find((item: any) => item.resourceKey === "repo:repo-a")!;
    const workspaceB = workspaces.find((item: any) => item.resourceKey === "repo:repo-b")!;
    store.assignWorkspaceOwner(workspaceA.workspaceId, "worker-a", "/work/a", 30, "1".repeat(40));
    store.assignWorkspaceOwner(workspaceB.workspaceId, "worker-b", "/work/b", 31, "2".repeat(40));

    const claimA = tasks.claim("worker-a", 32, 30_000, "multi", {
      backend: "codex",
      runtimeProfiles: ["codex-workspace-write"],
    })!;
    tasks.complete(claimA, "changed a", 33, { commitSha: "1".repeat(40) }, undefined, {
      baseCommit: "1".repeat(40),
      changedFiles: ["a.txt"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      contentRevision: "a".repeat(64),
    });
    const claimB = tasks.claim("worker-b", 34, 30_000, "multi", {
      backend: "codex",
      runtimeProfiles: ["codex-workspace-write"],
    })!;
    tasks.complete(claimB, "changed b", 35, { commitSha: "2".repeat(40) }, undefined, {
      baseCommit: "2".repeat(40),
      changedFiles: ["b.txt"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      contentRevision: "b".repeat(64),
    });
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 36), true);
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 37), true);

    const followInput = store.getDagPlannerInput(work.workItemId);
    const followProposal = store.submitDagProposal(
      {
        workItemId: work.workItemId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: followInput.frozen.workRevision,
        expectedDagRevision: followInput.frozen.dagRevision,
        expectedRequirementRevision: followInput.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: followInput.digest,
        reasonCode: "agent_result",
        policyContext: permissiveResourcePolicyContext(store, work.workItemId, ["repo:repo-a", "repo:repo-b"]),
        graph: {
          nodes: [
            {
              id: "change-b-followup",
              kind: "agent",
              capability: "repair",
              subject: null,
              resource: "repo:repo-b",
              mutates: true,
              requirements: [],
            },
          ],
          edges: [],
        },
      },
      38,
    );
    assert.equal(followProposal.status, "accepted", JSON.stringify(followProposal.decisionCodes));
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 39), true);
    const followExecution = store
      .listDagExecutions(work.workItemId)
      .find((item) => item.nodeId === "change-b-followup")!;
    const followTask = tasks.getByIdempotency("alice", "team", "dag:" + followExecution.idempotencyKey);
    assert.ok(
      followTask,
      JSON.stringify({
        state: followExecution.state,
        result: followExecution.result,
        externalRef: followExecution.externalRef,
      }),
    );
    assert.equal(followTask.repositoryId, "repo-b");
    assert.equal(followTask.workspaceKey, workspaceB.workspaceKey);
    assert.notEqual(followTask.taskId, aTask.taskId);

    const publications = new WorkPublicationStore(file);
    const changeRequests = new WorkChangeRequestStore(file);
    try {
      const orchestrator = new WorkOrchestrator(
        store,
        tasks,
        new ExpertDispatchService(experts, tasks),
        () => true,
        publications,
        changeRequests,
      );
      const publicationA = (orchestrator as any).ensurePublication(work.workItemId, "alice", "team", 40, {
        resourceKey: "repo:repo-a",
        repositoryId: "repo-a",
        subjectRevision: "workspace:" + "a".repeat(64),
      });
      const publicationB = (orchestrator as any).ensurePublication(work.workItemId, "alice", "team", 41, {
        resourceKey: "repo:repo-b",
        repositoryId: "repo-b",
        subjectRevision: "workspace:" + "b".repeat(64),
      });
      assert.notEqual(publicationA.publicationId, publicationB.publicationId);
      assert.equal(publicationA.workspaceId, workspaceA.workspaceId);
      assert.equal(publicationB.workspaceId, workspaceB.workspaceId);
      assert.equal(publicationA.repositoryId, "repo-a");
      assert.equal(publicationB.repositoryId, "repo-b");
      assert.equal(publicationA.executionSnapshot?.repositoryUrl, "https://example.test/a.git");
      assert.equal(publicationB.executionSnapshot?.repositoryUrl, "https://example.test/b.git");
      assert.equal(publicationA.branchName.startsWith("work/a/"), true);
      assert.equal(publicationB.branchName.startsWith("work/b/"), true);

      publications.transitionPublication(
        publicationA.publicationId,
        "prepared",
        {
          commitSha: "3".repeat(40),
          treeSha: "4".repeat(40),
          artifactRef: "artifact-a",
          pushRefspec: "refs/heads/" + publicationA.branchName,
        },
        42,
      );
      assert.doesNotThrow(() =>
        (orchestrator as any).recordPreparedPublicationArtifact(
          work.workItemId,
          "alice",
          "team",
          publicationA.publicationId,
          43,
          {
            resourceKey: "repo:repo-a",
            repositoryId: "repo-a",
            subjectRevision: "workspace:" + "a".repeat(64),
          },
        ),
      );

      publications.transitionPublication(publicationA.publicationId, "approved", {}, 44);
      publications.transitionPublication(publicationA.publicationId, "pushing", {}, 45);
      publications.transitionPublication(publicationA.publicationId, "pushed", {}, 46);
      const requestA = (orchestrator as any).ensureChangeRequest(work.workItemId, "alice", "team", 47, {
        resourceKey: "repo:repo-a",
        repositoryId: "repo-a",
        subjectRevision: "workspace:" + "a".repeat(64),
      });
      assert.equal(requestA.publicationId, publicationA.publicationId);
      assert.equal(requestA.repositoryUrl, "https://example.test/a.git");
    } finally {
      changeRequests.close();
      publications.close();
    }
  } finally {
    store.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
