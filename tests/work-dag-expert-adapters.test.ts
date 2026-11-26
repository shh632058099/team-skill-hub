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
    assert.match(agentClaim.problem, /Team Skill Hub checkout of the routed remote repository/i);
    assert.match(agentClaim.problem, /TEAM_SKILL_HUB_AGENT_OUTCOME_PROTOCOL=v1/);
    assert.match(agentClaim.problem, /Only judge success or blockage for this DAG node/i);
    assert.match(agentClaim.problem, /Downstream build, verification, review, publication, and change-request steps/i);
    assert.match(agentClaim.problem, /Node capability:\s*analysis/i);
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
    const cleanWorkspaceRevision = "c".repeat(64);
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
          subjectRevision: "workspace:" + cleanWorkspaceRevision,
          environmentIdentity: "env",
          verifierIdentity: "worker",
        },
      ],
      {
        baseCommit: "a".repeat(40),
        changedFiles: [],
        addedFiles: [],
        deletedFiles: [],
        diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
        contentRevision: cleanWorkspaceRevision,
      },
    );
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 142), true);
    const unitEvidence = workStore.listDagEvidence(work.workItemId).find((item) => item.type === "unit_test");
    assert.equal(unitEvidence?.passed, true);
    assert.equal(unitEvidence?.subjectRevision, "a".repeat(40));
    assert.equal(workStore.getWorkInternal(work.workItemId).currentSubjectRevision, "a".repeat(40));
    assert.equal(workStore.listAttempts(work.workItemId).length, 1);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expert task dispatch recovers when crash happens after DAG correlation but before execute", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-expert-dispatch-recovery-"));
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
    workStore.putWorkflow("dynamic-dispatch-recovery", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "dispatch-recovery",
      sourceType: "mcp",
      title: "recover dispatch",
      description: "analyze ota",
      workflowId: "dynamic-dispatch-recovery",
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
      ],
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

    const adapters = createExpertTaskDagAdapters(workStore, tasks, new ExpertDispatchService(experts, tasks));
    const agent = adapters.find((adapter) => adapter.kind === "agent")!;
    const current = workStore.getWorkInternal(work.workItemId);
    let claimed = workStore.claimDagNode(
      work.workItemId,
      "alice",
      "team",
      "agent",
      "hub-1",
      current.stateRevision,
      current.currentDagRevision,
      100,
      10,
    );
    const claimedContext = {
      work: workStore.getWork(work.workItemId, "alice", "team"),
      node: graph.nodes[0]!,
      execution: claimed,
      dagRevision: current.currentDagRevision,
      signal: new AbortController().signal,
    };
    const ref = agent.correlationRef!(claimedContext);
    assert.ok(ref);
    assert.match(ref, /^expert-task-key:/);
    claimed = workStore.setDagExecutionExternalRef(claimed.nodeExecutionId, "hub-1", claimed.fence, ref, 101);
    workStore.startDagNodeExecution(claimed.nodeExecutionId, "hub-1", claimed.fence, 102);

    const execution = workStore.listDagExecutions(work.workItemId)[0]!;
    assert.equal(tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey), null);
    assert.equal(execution.boundRequirementRevision, 1);

    const afterStart = workStore.getWorkInternal(work.workItemId);
    const snapshot = workStore.getRequirementSnapshot(work.workItemId, afterStart.currentRequirementRevision);
    workStore.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      afterStart.stateRevision,
      snapshot.revision,
      [
        ...snapshot.requirements,
        {
          id: "user:recovery-new-context",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "recovery.new.context", equals: true },
        },
      ],
      "test",
      110,
    );
    assert.equal(workStore.getWorkInternal(work.workItemId).currentRequirementRevision, 2);

    const restarted = new WorkDagScheduler(workStore, adapters, 10);
    assert.equal(await restarted.reconcileOne(work.workItemId, "alice", "team", "hub-2", 120), false);
    const recoveredTask = tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey);
    assert.ok(recoveredTask);
    assert.equal(recoveredTask.status, "queued");

    const workerClaim = tasks.claim("worker", 121, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(workerClaim.problem, /RequirementSnapshot revision: 1/);
    assert.doesNotMatch(workerClaim.problem, /recovery-new-context/);
    tasks.complete(workerClaim, "recovered", 122);
    assert.equal(await restarted.reconcileOne(work.workItemId, "alice", "team", "hub-2", 123), true);
    assert.equal(workStore.listDagExecutions(work.workItemId)[0]?.state, "succeeded");
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("current RequirementSnapshot drives automatic expert routing and agent task context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-requirement-routing-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "legacy",
      displayName: "Legacy",
      capabilities: ["legacy"],
      keywords: ["legacy"],
      active: true,
    });
    experts.putDefinition({
      id: "snapshot",
      displayName: "Snapshot",
      capabilities: ["snapshot-specialist"],
      keywords: ["snapshot-specialist"],
      active: true,
    });
    for (const expertId of ["legacy", "snapshot"]) {
      experts.putDeployment({
        id: expertId + "-ro",
        expertId,
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
    }
    const base = workStore.getWorkflow("investigation").definition;
    workStore.putWorkflow("dynamic-requirement-routing", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      planning: { maxReplans: 10, replanPolicy: ["always_after_agent_turn", "on_user_update"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "requirement-routing",
      sourceType: "mcp",
      title: "route from current requirements",
      description: "legacy diagnosis",
      workflowId: "dynamic-requirement-routing",
      repositoryId: "repo",
    });
    const initial = workStore.ensureRequirementSnapshot(work.workItemId);
    let current = workStore.getWorkInternal(work.workItemId);
    const updated = workStore.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      initial.revision,
      [
        {
          id: "user:snapshot-specialist",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "snapshot-specialist", equals: true },
        },
      ],
      "test",
      20,
    );
    assert.equal(updated.snapshot.revision, 2);

    const input = workStore.getDagPlannerInput(work.workItemId);
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
      ],
      edges: [],
    };
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
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 30), true);
    const attempt = workStore.getActiveAttempt(work.workItemId)!;
    assert.equal(attempt.expertId, "snapshot");

    const execution = workStore.listDagExecutions(work.workItemId)[0]!;
    const task = tasks.getByIdempotency("alice", "team", "dag:" + execution.idempotencyKey)!;
    assert.equal(task.expertId, "snapshot");
    const claim = tasks.claim("worker", 31, 1000, "snapshot", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    assert.match(claim.problem, /RequirementSnapshot revision: 2/);
    assert.match(claim.problem, /snapshot-specialist/);
    assert.match(claim.problem, /Original request:\s*legacy diagnosis/);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RequirementSnapshot routing preserves original domain intent beside typed constraints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-domain-routing-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
    experts.putDefinition({
      id: "other",
      displayName: "Other",
      capabilities: ["other"],
      keywords: ["other"],
      active: true,
    });
    for (const expertId of ["ota", "other"]) {
      experts.putDeployment({
        id: expertId + "-ro",
        expertId,
        repositoryIds: ["repo"],
        repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
        principals: ["alice"],
        runtimeProfile: "codex-readonly",
        active: true,
      });
    }

    const base = workStore.getWorkflow("investigation").definition;
    workStore.putWorkflow("dynamic-domain-routing", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "domain-routing",
      sourceType: "mcp",
      title: "domain routing",
      description: "analyze ota behavior",
      workflowId: "dynamic-domain-routing",
      repositoryId: "repo",
    });
    const initial = workStore.ensureRequirementSnapshot(work.workItemId);
    const current = workStore.getWorkInternal(work.workItemId);
    workStore.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      initial.revision,
      [
        {
          id: "user:generic-constraint",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "generic-constraint", equals: true },
        },
      ],
      "test",
      20,
    );

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
      }).status,
      "accepted",
    );

    const scheduler = new WorkDagScheduler(
      workStore,
      createExpertTaskDagAdapters(workStore, tasks, new ExpertDispatchService(experts, tasks)),
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 30), true);
    assert.equal(workStore.getActiveAttempt(work.workItemId)?.expertId, "ota");
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

test("terminal ExpertTask is not reused before its owning DAG execution is reconciled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-agent-result-ownership-"));
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
    });
    const base = workStore.getWorkflow("investigation").definition;
    workStore.putWorkflow("dynamic-result-ownership", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "result-ownership",
      sourceType: "mcp",
      title: "parallel ownership",
      description: "analyze ota",
      workflowId: "dynamic-result-ownership",
      expertId: "ota",
      deploymentId: "ota-ro",
      repositoryId: "repo",
    });
    workStore.ensureRequirementSnapshot(work.workItemId);
    const graph: DagGraph = {
      nodes: ["a", "b"].map((id) => ({
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

    const adapters = createExpertTaskDagAdapters(workStore, tasks, new ExpertDispatchService(experts, tasks));
    const scheduler = new WorkDagScheduler(workStore, adapters);
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 10), true);
    const aExecution = workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "a")!;
    const aTask = tasks.getByIdempotency("alice", "team", "dag:" + aExecution.idempotencyKey)!;
    const aClaim = tasks.claim("worker", 11, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    tasks.complete(aClaim, "result-a", 12);
    assert.equal(workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "a")?.state, "running");

    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 13), true);
    const bExecution = workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "b")!;
    const bTask = tasks.getByIdempotency("alice", "team", "dag:" + bExecution.idempotencyKey);
    assert.ok(bTask);
    assert.notEqual(bTask.taskId, aTask.taskId);
    assert.equal(tasks.get(aTask.taskId, "alice", "team").result, "result-a");

    const bClaim = tasks.claim("worker", 14, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    tasks.complete(bClaim, "result-b", 15);
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 16), true);
    const secondReconcile = await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 17);
    assert.equal(
      secondReconcile,
      true,
      JSON.stringify({
        executions: workStore.listDagExecutions(work.workItemId).map((item) => ({
          nodeId: item.nodeId,
          state: item.state,
          externalRef: item.externalRef,
          result: item.result,
        })),
        aTask: tasks.get(aTask.taskId, "alice", "team"),
        bTask: tasks.get(bTask.taskId, "alice", "team"),
      }),
    );
    assert.equal(
      workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "a")?.result?.summary,
      "result-a",
    );
    assert.equal(
      workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "b")?.result?.summary,
      "result-b",
    );

    const nextInput = workStore.getDagPlannerInput(work.workItemId);
    const nextGraph: DagGraph = {
      nodes: ["c", "d"].map((id) => ({
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
    assert.equal(
      workStore.submitDagProposal({
        workItemId: work.workItemId,
        principalId: "alice",
        scope: "team",
        expectedWorkRevision: nextInput.frozen.workRevision,
        expectedDagRevision: nextInput.frozen.dagRevision,
        expectedRequirementRevision: nextInput.frozen.requirementRevision,
        plannerIdentity: "p",
        plannerVersion: "1",
        plannerInputDigest: nextInput.digest,
        reasonCode: "agent_result",
        graph: nextGraph,
      }).status,
      "accepted",
    );

    const current = workStore.getWorkInternal(work.workItemId);
    const cClaim = workStore.claimDagNode(
      work.workItemId,
      "alice",
      "team",
      "c",
      "hub-c",
      current.stateRevision,
      current.currentDagRevision,
      20,
      1000,
    );
    const afterCClaim = workStore.getWorkInternal(work.workItemId);
    const dClaim = workStore.claimDagNode(
      work.workItemId,
      "alice",
      "team",
      "d",
      "hub-d",
      afterCClaim.stateRevision,
      afterCClaim.currentDagRevision,
      21,
      1000,
    );
    const agent = adapters.find((adapter) => adapter.kind === "agent")!;
    const currentWork = workStore.getWork(work.workItemId, "alice", "team");
    const cRef = agent.correlationRef!({
      work: currentWork,
      node: nextGraph.nodes[0]!,
      execution: cClaim,
      dagRevision: current.currentDagRevision,
      signal: new AbortController().signal,
    });
    const dRef = agent.correlationRef!({
      work: currentWork,
      node: nextGraph.nodes[1]!,
      execution: dClaim,
      dagRevision: current.currentDagRevision,
      signal: new AbortController().signal,
    });
    assert.ok(cRef);
    assert.ok(dRef);
    assert.notEqual(cRef, dRef);
    assert.equal([cRef, dRef].filter((ref) => ref === "expert-task:" + aTask.taskId).length, 1);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent dispatch after an abandoned Attempt creates a policy_replan Attempt on the requested deployment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-policy-replan-attempt-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "new-expert",
      displayName: "New Expert",
      capabilities: ["analysis"],
      keywords: ["analysis"],
      active: true,
    });
    experts.putDeployment({
      id: "new-deployment",
      expertId: "new-expert",
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
    workStore.putWorkflow("dynamic-policy-replan", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "policy-replan-attempt",
      sourceType: "mcp",
      title: "analysis",
      description: "analysis",
      workflowId: "dynamic-policy-replan",
      expertId: "new-expert",
      deploymentId: "new-deployment",
      repositoryId: "repo",
    });
    workStore.ensureRequirementSnapshot(work.workItemId);
    const input = workStore.getDagPlannerInput(work.workItemId);
    const proposal = workStore.submitDagProposal({
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
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));

    let current = workStore.getWorkInternal(work.workItemId);
    const oldAttempt = workStore.createWorkAttempt(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      {
        reason: "initial",
        expertId: "legacy-expert",
        deploymentId: "legacy-deployment",
        deploymentConfigVersion: 1,
      },
      10,
    );
    current = workStore.getWorkInternal(work.workItemId);
    workStore.finishWorkAttempt(
      work.workItemId,
      oldAttempt.workAttemptId,
      "alice",
      "team",
      current.stateRevision,
      "cancelled",
      "queued",
      11,
    );

    const scheduler = new WorkDagScheduler(
      workStore,
      createExpertTaskDagAdapters(workStore, tasks, new ExpertDispatchService(experts, tasks)),
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 12), true);
    const attempts = workStore.listAttempts(work.workItemId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.reason, "policy_replan");
    assert.equal(attempts[1]?.parentWorkAttemptId, oldAttempt.workAttemptId);
    assert.equal(attempts[1]?.expertId, "new-expert");
    assert.equal(attempts[1]?.deploymentId, "new-deployment");
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent adapter refuses a second DAG agent turn after the WorkAttempt turn budget is exhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-agent-turn-budget-"));
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
    workStore.putWorkflow("dynamic-turn-budget", 1, {
      ...structuredClone(base),
      lifecycle: {
        ...structuredClone(base.lifecycle),
        continuation: { ...structuredClone(base.lifecycle.continuation), maxTurnsPerRun: 1 },
      },
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "turn-budget",
      sourceType: "mcp",
      title: "two turns",
      description: "perform two analysis steps",
      workflowId: "dynamic-turn-budget",
      expertId: "ota",
      deploymentId: "ota-ro",
      repositoryId: "repo",
    });
    workStore.ensureRequirementSnapshot(work.workItemId);
    const graph: DagGraph = {
      nodes: [
        {
          id: "agent-a",
          kind: "agent",
          capability: "analysis",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
        {
          id: "agent-b",
          kind: "agent",
          capability: "analysis",
          subject: null,
          resource: "workspace",
          mutates: false,
          requirements: [],
        },
      ],
      edges: [{ from: "agent-a", to: "agent-b" }],
    };
    const input = workStore.getDagPlannerInput(work.workItemId);
    const proposal = workStore.submitDagProposal({
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
    });
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));
    const scheduler = new WorkDagScheduler(
      workStore,
      createExpertTaskDagAdapters(workStore, tasks, new ExpertDispatchService(experts, tasks)),
    );
    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 10), true);
    const firstTaskClaim = tasks.claim("worker", 11, 1000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-readonly"],
    })!;
    tasks.complete(firstTaskClaim, "first done", 12, { commitSha: "a".repeat(40) });
    assert.equal(await scheduler.reconcileOne(work.workItemId, "alice", "team", "hub", 13), true);

    assert.equal(await scheduler.runOne(work.workItemId, "alice", "team", "hub", 14), true);
    const second = workStore.listDagExecutions(work.workItemId).find((item) => item.nodeId === "agent-b")!;
    assert.equal(second.state, "failed");
    assert.equal(second.result?.summary, "WORK_CONTINUATION_LIMIT_REACHED");
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

    let currentWork = workStore.getWorkInternal(work.workItemId);
    const currentSnapshot = workStore.getRequirementSnapshot(work.workItemId, currentWork.currentRequirementRevision);
    workStore.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      currentWork.stateRevision,
      currentSnapshot.revision,
      [
        {
          id: "user:repair-snapshot-v2",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "repair-snapshot-v2", equals: true },
        },
      ],
      "test",
      25,
    );

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
    assert.match(repairClaim.problem, /RequirementSnapshot revision: 2/);
    assert.match(repairClaim.problem, /repair-snapshot-v2/);
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
