import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DagExternalOutcomeUnknownError, WorkDagScheduler } from "../src/expert-platform/work-dag-engine.js";
import {
  ExternalActionRegistry,
  createExternalActionDagAdapters,
} from "../src/expert-platform/work-dag-external-adapters.js";
import {
  withExternalActionCapabilities,
  workflowOnlyDagPolicyContext,
} from "../src/expert-platform/work-dag-policy-context.js";
import { validateDagProposal } from "../src/expert-platform/work-dag-policy.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";

function externalWorkflow(store: WorkOrchestrationStore) {
  const base = store.getWorkflow("investigation").definition;
  store.putWorkflow("external-only", 1, {
    ...structuredClone(base),
    validation: { requiredEvidence: [], required: [] },
    review: { required: false },
    completion: { require: ["no_unresolved_blocker"] },
    publication: { required: false, mode: "work_branch", approvalRequired: false },
    graph: { mode: "dynamic-dag" },
  } as typeof base);
  return store.getWorkflow("external-only");
}

test("validator rejects an external action capability that is not registered in pinned policy context", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-external-policy-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const workflow = externalWorkflow(store);
    const policy = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
    const result = validateDagProposal(
      {
        nodes: [
          {
            id: "ticket",
            kind: "external_action",
            capability: "ticket.create",
            subject: null,
            resource: "external:tickets",
            mutates: true,
            requirements: [],
          },
        ],
        edges: [],
      },
      workflow.definition,
      [],
      { policyContext: policy },
    );
    assert.ok(result.codes.includes("PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted external-action mutation metadata cannot be understated by the planner", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-external-mutation-policy-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const workflow = externalWorkflow(store);
    const registry = new ExternalActionRegistry();
    registry.register({
      capability: "deploy.start",
      mutates: true,
      resourcePrefix: "external:prod",
      execute: async () => ({ status: "succeeded" }),
    });
    const basePolicy = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
    const policy = withExternalActionCapabilities(basePolicy, registry.listPolicies());
    const result = validateDagProposal(
      {
        nodes: [
          {
            id: "deploy-a",
            kind: "external_action",
            capability: "deploy.start",
            subject: null,
            resource: "external:prod:a",
            mutates: false,
            requirements: [],
          },
        ],
        edges: [],
      },
      workflow.definition,
      [],
      { policyContext: policy },
    );
    assert.equal(result.accepted, false);
    assert.ok(result.codes.includes("PLAN_EXECUTOR_BEHAVIOR_MISMATCH"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted mutating external actions on the same resource cannot run unordered", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-external-mutation-conflict-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    const workflow = externalWorkflow(store);
    const registry = new ExternalActionRegistry();
    registry.register({
      capability: "deploy.start",
      mutates: true,
      resourcePrefix: "external:prod",
      execute: async () => ({ status: "succeeded" }),
    });
    const basePolicy = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
    const policy = withExternalActionCapabilities(basePolicy, registry.listPolicies());
    const result = validateDagProposal(
      {
        nodes: ["a", "b"].map((id) => ({
          id,
          kind: "external_action" as const,
          capability: "deploy.start",
          subject: null,
          resource: "external:prod",
          mutates: true,
          requirements: [],
        })),
        edges: [],
      },
      workflow.definition,
      [],
      { policyContext: policy },
    );
    assert.equal(result.accepted, false);
    assert.ok(result.codes.includes("PLAN_PARALLEL_WRITE_CONFLICT"));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered external action executes through normal DAG claim and reconciliation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-external-run-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    externalWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "external-action",
      sourceType: "mcp",
      title: "Create ticket",
      description: "create external ticket",
      workflowId: "external-only",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    const registry = new ExternalActionRegistry();
    registry.register({
      capability: "ticket.create",
      mutates: true,
      correlationRef: (context) => "ticket:" + context.execution.idempotencyKey,
      execute: async () => ({
        status: "succeeded",
        summary: "TICKET-1",
        facts: [{ key: "ticket.created", value: true }],
        artifacts: [
          {
            artifactId: "ticket:TICKET-1",
            type: "external_ticket",
            ref: "TICKET-1",
            subjectRevision: null,
          },
        ],
      }),
    });

    const basePolicy = workflowOnlyDagPolicyContext("external-only", 1, store.getWorkflow("external-only").definition);
    const policy = withExternalActionCapabilities(basePolicy, registry.listPolicies());
    const current = store.getWorkInternal(work.workItemId);
    store.bindRequirementPolicyContext(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      current.currentRequirementRevision,
      policy,
      5,
    );
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
      graph: {
        nodes: [
          {
            id: "ticket",
            kind: "external_action",
            capability: "ticket.create",
            subject: null,
            resource: "external:tickets",
            mutates: true,
            requirements: [],
          },
        ],
        edges: [],
      },
      policyContext: policy,
    });
    assert.equal(proposal.status, "accepted");

    const scheduler = new WorkDagScheduler(store, createExternalActionDagAdapters(registry));
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 10), true);
    const execution = store.listDagExecutions(work.workItemId)[0]!;
    assert.equal(execution.state, "succeeded");
    assert.equal(
      store.listDagFacts(work.workItemId).some((item) => item.key === "ticket.created"),
      true,
    );
    assert.equal(
      store.listDagArtifacts(work.workItemId).some((item) => item.type === "external_ticket"),
      true,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("correlated external action without handler reconciliation becomes outcome-unknown after lease expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-external-unreconcilable-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    externalWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "external-unreconcilable",
      sourceType: "mcp",
      title: "Deploy",
      description: "deploy with opaque external result",
      workflowId: "external-only",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    const registry = new ExternalActionRegistry();
    registry.register({
      capability: "deploy.start",
      mutates: true,
      correlationRef: (context) => "deploy:" + context.execution.idempotencyKey,
      execute: async (context) => ({
        kind: "deferred",
        externalRef: "deploy:" + context.execution.idempotencyKey,
      }),
    });
    const basePolicy = workflowOnlyDagPolicyContext("external-only", 1, store.getWorkflow("external-only").definition);
    const policy = withExternalActionCapabilities(basePolicy, registry.listPolicies());
    const current = store.getWorkInternal(work.workItemId);
    store.bindRequirementPolicyContext(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      current.currentRequirementRevision,
      policy,
      90,
    );
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
      graph: {
        nodes: [
          {
            id: "deploy",
            kind: "external_action",
            capability: "deploy.start",
            subject: null,
            resource: "external:prod",
            mutates: true,
            requirements: [],
          },
        ],
        edges: [],
      },
      policyContext: policy,
    });
    assert.equal(proposal.status, "accepted");

    const scheduler = new WorkDagScheduler(store, createExternalActionDagAdapters(registry), 1000);
    const startedAt = Date.now();
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "owner-1", startedAt), true);
    let execution = store.listDagExecutions(work.workItemId)[0]!;
    assert.equal(execution.state, "running");
    assert.equal(execution.externalRef, "deploy:" + execution.idempotencyKey);
    assert.equal(await scheduler.recoverOne(work.workItemId, "alice", "team", "owner-2", startedAt + 999), false);
    assert.equal(await scheduler.recoverOne(work.workItemId, "alice", "team", "owner-2", startedAt + 1001), true);
    execution = store.listDagExecutions(work.workItemId)[0]!;
    assert.equal(execution.state, "external_outcome_unknown");
    assert.equal(execution.externalRef, "deploy:" + execution.idempotencyKey);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown non-idempotent external action outcome blocks dependent mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-external-unknown-"));
  try {
    const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
    externalWorkflow(store);
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "external-unknown",
      sourceType: "mcp",
      title: "Deploy",
      description: "deploy then mutate",
      workflowId: "external-only",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    const registry = new ExternalActionRegistry();
    registry.register({
      capability: "deploy.start",
      mutates: true,
      correlationRef: (context) => "deploy:" + context.execution.idempotencyKey,
      execute: async () => {
        throw new DagExternalOutcomeUnknownError("deploy:unknown");
      },
    });
    const basePolicy = workflowOnlyDagPolicyContext("external-only", 1, store.getWorkflow("external-only").definition);
    const policy = withExternalActionCapabilities(basePolicy, registry.listPolicies());
    const current = store.getWorkInternal(work.workItemId);
    store.bindRequirementPolicyContext(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      current.currentRequirementRevision,
      policy,
      15,
    );
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
      graph: {
        nodes: [
          {
            id: "deploy",
            kind: "external_action",
            capability: "deploy.start",
            subject: null,
            resource: "external:prod",
            mutates: true,
            requirements: [],
          },
          {
            id: "after",
            kind: "wait",
            capability: "after_deploy",
            subject: null,
            resource: null,
            mutates: false,
            requirements: [],
          },
        ],
        edges: [{ from: "deploy", to: "after" }],
      },
      policyContext: policy,
    });
    assert.equal(proposal.status, "accepted");

    const scheduler = new WorkDagScheduler(store, [...createExternalActionDagAdapters(registry)]);
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 20), true);
    const execution = store.listDagExecutions(work.workItemId).find((item) => item.nodeId === "deploy")!;
    assert.equal(execution.state, "external_outcome_unknown");
    assert.deepEqual(store.evaluateDagCompletion(work.workItemId).readyNodeIds, []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
