import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkDagScheduler } from "../src/expert-platform/work-dag-engine.js";
import { createExpertTaskDagAdapters } from "../src/expert-platform/work-dag-expert-adapters.js";
import type { DagGraph } from "../src/expert-platform/work-dag.js";

test("agent and verification DAG nodes bridge to durable ExpertTasks with one shared Attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-expert-adapter-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });

    experts.putDeployment({
      id: "ota-ro",
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [
        {
          id: "repo",
          url: "https://example.test/repo.git",
          branch: "main",
          verificationPolicy: {
            version: 1,
            required: [{ id: "unit", type: "command", argv: ["ctest"], timeoutMs: 1000, evidenceType: "unit_test" }],
          },
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
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
    const base = workStore.getWorkflow("investigation").definition;
    workStore.putWorkflow("dynamic-test", 1, {
      ...structuredClone(base),
      validation: {
        requiredEvidence: ["unit_test"],
        required: [{ id: "unit", type: "command", argv: ["ctest"], timeoutMs: 1000, evidenceType: "unit_test" }],
      },
      completion: { require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "w",
      sourceType: "mcp",
      title: "t",
      description: "analyze ota",
      workflowId: "dynamic-test",
      expertId: "ota",
      deploymentId: "ota-ro",
      repositoryId: "repo",
    });
    workStore.ensureRequirementSnapshot(work.workItemId);
    const graph: DagGraph = {
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
      edges: [{ from: "agent", to: "verify" }],
    };
    const input = workStore.getDagPlannerInput(work.workItemId);
    const proposal = workStore.submitDagProposal(
      {
        workItemId: work.workItemId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph,
      },
      100,
    );
    assert.equal(proposal.status, "accepted");

    const dispatch = new ExpertDispatchService(experts, tasks);
    const scheduler = new WorkDagScheduler(workStore, createExpertTaskDagAdapters(workStore, tasks, dispatch));
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 110), true);
    let execution = workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "agent")!;
    let queued = tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    assert.ok(queued);
    assert.equal(queued.executionKind, "agent");
    assert.deepEqual(queued.validationSnapshot, []);
    const attempt = workStore.getActiveAttempt(work.workItemId)!;
    assert.equal(attempt.taskId, queued.taskId);
    const agentClaim = tasks.claim("worker", 120, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(
      agentClaim.problem,
      /Do not query, wait on, submit, cancel, update, or otherwise control this WorkItem/i,
    );
    assert.match(agentClaim.problem, /Skill\/Knowledge lookup/i);
    tasks.complete(
      agentClaim,
      "analysis complete",
      121,
      { repositoryUrl: "https://example.test/repo.git", repositoryBranch: "main", commitSha: "a".repeat(40) },
      [],
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 122), true);
    assert.equal(workStore.getWorkInternal(work.workItemId).currentSubjectRevision, "a".repeat(40));

    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 130), true);
    execution = workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "verify")!;
    const verification = tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    assert.ok(verification);
    assert.equal(verification.executionKind, "verification");
    assert.deepEqual(
      verification.validationSnapshot.map((step) => step.evidenceType),
      ["unit_test"],
    );
    assert.equal(verification.workAttemptId, attempt.workAttemptId);
    assert.equal(workStore.getAttemptByTask(verification.taskId)?.workAttemptId, attempt.workAttemptId);
    const verifyClaim = tasks.claim("worker", 140, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.equal(verifyClaim.executionKind, "verification");
    tasks.complete(
      verifyClaim,
      "Verification completed",
      141,
      { repositoryUrl: "https://example.test/repo.git", repositoryBranch: "main", commitSha: "a".repeat(40) },
      [
        {
          stepId: "unit",
          type: "command",
          evidenceType: "unit_test",
          status: "passed",
          exitCode: 0,
          durationMs: 1,
          errorCode: null,
          subjectRevision: "a".repeat(40),
          environmentIdentity: "env",
          verifierIdentity: "worker",
        },
      ],
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 142), true);
    assert.ok(workStore.listDagEvidence(work.workItemId).some((item) => item.type === "unit_test" && item.passed));
    assert.equal(workStore.listAttempts(work.workItemId).length, 1);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel read-only agent nodes keep distinct ExpertTask execution identities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-agent-identity-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
    experts.putDeployment({
      id: "ota-ro",
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
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
    const base = workStore.getWorkflow("investigation").definition;
    workStore.putWorkflow("dynamic-parallel-agents", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["expert_result"], required: [] },
      completion: { require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "parallel-agents",
      sourceType: "mcp",
      title: "parallel",
      description: "analyze two independent aspects",
      workflowId: "dynamic-parallel-agents",
      expertId: "ota",
      deploymentId: "ota-ro",
      repositoryId: "repo",
    });
    workStore.ensureRequirementSnapshot(work.workItemId);
    const graph: DagGraph = {
      nodes: ["left", "right"].map((id) => ({
        id,
        kind: "agent" as const,
        capability: "analysis",
        subject: null,
        resource: "workspace",
        mutates: false,
        requirements: [],
      })),
      edges: [],
    };
    const input = workStore.getDagPlannerInput(work.workItemId);
    assert.equal(
      workStore.submitDagProposal({
        workItemId: work.workItemId,
        principalId: "alice",
        scope: "team",
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

    const scheduler = new WorkDagScheduler(
      workStore,
      createExpertTaskDagAdapters(workStore, tasks, new ExpertDispatchService(experts, tasks)),
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 10), true);
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 11), true);

    const executions = workStore.listDagExecutions(work.workItemId);
    const left = executions.find((item) => item.nodeId === "left")!;
    const right = executions.find((item) => item.nodeId === "right")!;
    const leftTask = tasks.getByIdempotency("alice", "team", "dag:" + left.idempotencyKey);
    const rightTask = tasks.getByIdempotency("alice", "team", "dag:" + right.idempotencyKey);
    assert.ok(leftTask);
    assert.ok(rightTask);
    assert.notEqual(leftTask.taskId, rightTask.taskId);
    assert.equal(workStore.getActiveAttempt(work.workItemId)?.taskId, leftTask.taskId);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification failure context reaches the repair continuation Worker prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-verification-repair-context-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
    experts.putDeployment({
      id: "ota-ro",
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [
        {
          id: "repo",
          url: "https://example.test/repo.git",
          branch: "main",
          verificationPolicy: {
            version: 1,
            required: [{ id: "unit", type: "command", argv: ["ctest"], timeoutMs: 1000, evidenceType: "unit_test" }],
          },
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
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
    const base = workStore.getWorkflow("investigation").definition;
    workStore.putWorkflow("dynamic-repair-context", 1, {
      ...structuredClone(base),
      validation: {
        requiredEvidence: ["unit_test"],
        required: [{ id: "unit", type: "command", argv: ["ctest"], timeoutMs: 1000, evidenceType: "unit_test" }],
      },
      completion: { require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"] },
      planning: { maxReplans: 10, replanPolicy: ["always_after_agent_turn", "on_failure"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "repair-context",
      sourceType: "mcp",
      title: "repair",
      description: "fix the implementation",
      workflowId: "dynamic-repair-context",
      expertId: "ota",
      deploymentId: "ota-ro",
      repositoryId: "repo",
    });
    workStore.ensureRequirementSnapshot(work.workItemId);
    const dispatch = new ExpertDispatchService(experts, tasks);
    const scheduler = new WorkDagScheduler(workStore, createExpertTaskDagAdapters(workStore, tasks, dispatch));
    const install = (graph: DagGraph, reasonCode: string, now: number) => {
      const input = workStore.getDagPlannerInput(work.workItemId);
      const proposal = workStore.submitDagProposal(
        {
          workItemId: work.workItemId,
          principalId: "alice",
          scope: "team",
          expectedWorkRevision: input.frozen.workRevision,
          expectedDagRevision: input.frozen.dagRevision,
          expectedRequirementRevision: input.frozen.requirementRevision,
          plannerIdentity: "p",
          plannerVersion: "1",
          plannerInputDigest: input.digest,
          reasonCode,
          graph,
        },
        now,
      );
      assert.equal(proposal.status, "accepted");
    };

    install(
      {
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
      "initial",
      10,
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 11), true);
    const firstClaim = tasks.claim("worker", 12, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    tasks.complete(
      firstClaim,
      "implementation complete",
      13,
      { repositoryUrl: "https://example.test/repo.git", repositoryBranch: "main", commitSha: "a".repeat(40) },
      [],
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 14), true);

    install(
      {
        nodes: [
          {
            id: "verify",
            kind: "verification",
            capability: "unit_test",
            subject: "a".repeat(40),
            resource: "workspace",
            mutates: false,
            requirements: [],
          },
        ],
        edges: [],
      },
      "agent_result",
      20,
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 21), true);
    const verifyClaim = tasks.claim("worker", 22, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    tasks.complete(
      verifyClaim,
      "verification task completed",
      23,
      { repositoryUrl: "https://example.test/repo.git", repositoryBranch: "main", commitSha: "a".repeat(40) },
      [
        {
          stepId: "unit",
          type: "command",
          evidenceType: "unit_test",
          status: "failed",
          exitCode: 1,
          durationMs: 1,
          errorCode: "TEST_FAILED",
          subjectRevision: "a".repeat(40),
          environmentIdentity: "env",
          verifierIdentity: "worker",
        },
      ],
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 24), true);
    const failed = workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "verify")!;
    assert.equal(failed.state, "failed");

    install(
      {
        nodes: [
          {
            id: "repair",
            kind: "agent",
            capability: "repair",
            subject: null,
            resource: "workspace",
            mutates: false,
            requirements: [],
          },
        ],
        edges: [],
      },
      "verification_failure",
      30,
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 31), true);
    const repairClaim = tasks.claim("worker", 32, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(repairClaim.problem, /verify/);
    assert.match(repairClaim.problem, /verification task completed|unit_test|TEST_FAILED/);
    tasks.complete(
      repairClaim,
      "repair complete",
      33,
      { repositoryUrl: "https://example.test/repo.git", repositoryBranch: "main", commitSha: "a".repeat(40) },
      [],
      {
        baseCommit: "a".repeat(40),
        changedFiles: ["src/fix.ts"],
        addedFiles: [],
        deletedFiles: [],
        diffStat: { filesChanged: 1, insertions: 2, deletions: 1 },
        contentRevision: "b".repeat(64),
      },
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 34), true);
    assert.equal(workStore.getDagContext(work.workItemId).facts["workspace.changed"], true);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
