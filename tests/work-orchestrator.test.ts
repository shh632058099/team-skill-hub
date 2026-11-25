import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkPublicationStore } from "../src/expert-platform/work-publication-store.js";
import { WorkChangeRequestStore } from "../src/expert-platform/work-change-request-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";

function markPreCutoverLegacy(dbPath: string, workItemId: string) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE work_items SET orchestration_engine='legacy-single-node' WHERE work_item_id=?").run(workItemId);
  } finally {
    db.close();
  }
}

function submitPreCutoverLegacy(
  orchestrator: WorkOrchestrator,
  dbPath: string,
  input: Parameters<WorkOrchestrator["stageWork"]>[0],
  now = Date.now(),
) {
  const staged = orchestrator.stageWork(input, now);
  markPreCutoverLegacy(dbPath, staged.work.workItemId);
  return orchestrator.reconcileWork(staged.work.workItemId, input.principalId, input.scope, now);
}

function legacyFacade(orchestrator: WorkOrchestrator, dbPath: string): WorkOrchestrator {
  return new Proxy(orchestrator, {
    get(target, property) {
      if (property === "submitWork") {
        return (input: Parameters<WorkOrchestrator["stageWork"]>[0], now?: number) =>
          submitPreCutoverLegacy(target, dbPath, input, now);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WorkOrchestrator;
}

function fixture(workerAvailable?: (workerId: string, now: number) => boolean, enableChangeRequests = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  const publications = new WorkPublicationStore(db);
  const changeRequests = enableChangeRequests ? new WorkChangeRequestStore(db) : undefined;
  experts.putDefinition({
    id: "ota",
    displayName: "OTA Expert",
    capabilities: ["ota"],
    keywords: ["ota", "upgrade"],
    active: true,
  });

  experts.putDeployment({
    id: "ota-default",
    expertId: "ota",
    repositoryIds: ["ota-repo"],
    repositories: [],
    principals: ["alice"],
    runtimeProfile: "codex-readonly",
    active: true,
  });
  const dispatch = new ExpertDispatchService(experts, tasks);
  const dynamicOrchestrator = new WorkOrchestrator(
    work,
    tasks,
    dispatch,
    workerAvailable,
    publications,
    changeRequests,
  );
  const orchestrator = legacyFacade(dynamicOrchestrator, db);
  return {
    dir,
    db,
    experts,
    tasks,
    work,
    publications,
    changeRequests,
    orchestrator,
    dynamicOrchestrator,
    close() {
      publications.close();
      changeRequests?.close();
      work.close();
      tasks.close();
      experts.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const submission = {
  principalId: "alice",
  scope: "team-a",
  idempotencyKey: "work-1",
  sourceType: "mcp",
  title: "Inspect OTA recovery",
  description: "inspect ota upgrade recovery without modifying files",
  expertId: "ota",
  deploymentId: "ota-default",
  repositoryId: "ota-repo",
} as const;

test("orchestrator maintains a read-only shadow DAG projection without changing legacy execution", () => {
  const f = fixture();
  try {
    const staged = f.orchestrator.stageWork(
      {
        ...submission,
        idempotencyKey: "shadow-stage",
        workflowId: "investigation",
      },
      100,
    );
    assert.equal(staged.work.currentRequirementRevision, 1);
    markPreCutoverLegacy(f.db, staged.work.workItemId);
    const initial = f.work.getShadowDag(staged.work.workItemId);
    assert.ok(initial);
    assert.equal(initial!.graph.nodes.length, 0);

    const running = f.orchestrator.reconcileWork(staged.work.workItemId, "alice", "team-a", 110);
    assert.equal(running.work.status, "running");
    const projected = f.work.getShadowDag(staged.work.workItemId);
    assert.ok(projected);
    assert.ok(projected!.graph.nodes.some((node) => node.kind === "agent"));
    assert.equal(
      f.work.getWorkInternal(staged.work.workItemId).stateRevision,
      running.work.stateRevision,
      "shadow projection must not advance authoritative Work state",
    );
  } finally {
    f.close();
  }
});

test("dynamic-dag workflow is staged for DAG runtime and legacy reconciler does not dispatch an attempt", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    f.work.putWorkflow("dynamic-investigation", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const detail = f.dynamicOrchestrator.submitWork(
      {
        ...submission,
        idempotencyKey: "dynamic-owned",
        workflowId: "dynamic-investigation",
      },
      100,
    );
    assert.equal(detail.work.status, "queued");
    assert.equal(detail.attempts.length, 0);
    assert.deepEqual(detail.dag?.lateResults, []);
    assert.deepEqual(detail.dag?.replanRequests, []);
    const reconciled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 110);
    assert.equal(reconciled.work.status, "queued");
    assert.equal(reconciled.attempts.length, 0);
  } finally {
    f.close();
  }
});

test("every post-cutover Work is owned by DAG runtime even when Workflow graph mode is legacy single-node", () => {
  const f = fixture();
  try {
    assert.equal(f.work.getWorkflow("investigation").definition.graph.mode, "single-node");
    const detail = f.dynamicOrchestrator.submitWork(
      {
        ...submission,
        idempotencyKey: "cutover-investigation",
        workflowId: "investigation",
      },
      100,
    );
    assert.equal(detail.work.orchestrationEngine, "dynamic-dag");
    assert.equal(detail.work.status, "queued");
    assert.equal(detail.attempts.length, 0);

    const reconciled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 110);
    assert.equal(reconciled.work.status, "queued");
    assert.equal(reconciled.attempts.length, 0);
  } finally {
    f.close();
  }
});

test("dynamic get_work exposes one authoritative completion gate from DAG evidence", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    f.work.putWorkflow("dynamic-gate", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["unit_test"], required: [] },
      review: { required: false },
      completion: { require: ["required_evidence_passed", "no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const detail = f.dynamicOrchestrator.submitWork(
      {
        ...submission,
        idempotencyKey: "dynamic-gate",
        workflowId: "dynamic-gate",
      },
      100,
    );
    const input = f.work.getDagPlannerInput(detail.work.workItemId);
    f.work.submitDagProposal(
      {
        workItemId: detail.work.workItemId,
        principalId: "alice",
        scope: "team-a",
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
      101,
    );
    let work = f.work.getWorkInternal(detail.work.workItemId);
    let claim = f.work.claimDagNode(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verify",
      "worker",
      work.stateRevision,
      1,
      102,
      1000,
    );
    claim = f.work.startDagNodeExecution(claim.nodeExecutionId, "worker", claim.fence, 103);
    f.work.reconcileDagNodeResult(
      claim.nodeExecutionId,
      "worker",
      claim.fence,
      {
        status: "succeeded",
        evidence: [{ type: "unit_test", passed: true, subjectRevision: null, verifierIdentity: "worker" }],
      },
      104,
    );
    const current = f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(current.dag?.completion.ready, true);
    assert.equal(current.gate.ready, true);
    assert.deepEqual(current.gate.missing, current.dag?.completion.missing);
  } finally {
    f.close();
  }
});

test("dynamic-dag cancel fences DAG execution and cancels correlated verification task", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    f.work.putWorkflow("dynamic-cancel", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const detail = f.dynamicOrchestrator.submitWork(
      {
        ...submission,
        idempotencyKey: "dynamic-cancel",
        workflowId: "dynamic-cancel",
      },
      100,
    );
    const input = f.work.getDagPlannerInput(detail.work.workItemId);
    f.work.submitDagProposal(
      {
        workItemId: detail.work.workItemId,
        principalId: "alice",
        scope: "team-a",
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
      110,
    );
    let work = f.work.getWorkInternal(detail.work.workItemId);
    let execution = f.work.claimDagNode(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verify",
      "hub",
      work.stateRevision,
      1,
      111,
      1000,
    );
    execution = f.work.startDagNodeExecution(execution.nodeExecutionId, "hub", execution.fence, 112);
    f.work.setDagExecutionExternalRef(
      execution.nodeExecutionId,
      "hub",
      execution.fence,
      "expert-task-key:dag:" + execution.idempotencyKey,
      113,
    );
    const task = f.tasks.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "dag:" + execution.idempotencyKey,
      problem: "verify",
      executionKind: "verification",
    });
    assert.equal(task.status, "queued");

    const cancelled = f.orchestrator.cancelWork(detail.work.workItemId, "alice", "team-a", 120);
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(f.tasks.get(task.taskId, "alice", "team-a").status, "cancelled");
    assert.equal(f.work.listDagExecutions(detail.work.workItemId)[0]?.state, "cancelled");
  } finally {
    f.close();
  }
});

test("dynamic-dag cancel preserves an in-flight publication push as external outcome unknown", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    f.work.putWorkflow("dynamic-push-cancel", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const detail = f.dynamicOrchestrator.submitWork(
      {
        ...submission,
        idempotencyKey: "dynamic-push-cancel",
        workflowId: "dynamic-push-cancel",
      },
      100,
    );
    let work = f.work.getWorkInternal(detail.work.workItemId);
    const subject = "workspace:" + "a".repeat(64);
    f.work.setCurrentSubjectRevision(detail.work.workItemId, "alice", "team-a", work.stateRevision, subject, 101);
    const input = f.work.getDagPlannerInput(detail.work.workItemId);
    f.work.submitDagProposal(
      {
        workItemId: detail.work.workItemId,
        principalId: "alice",
        scope: "team-a",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: 0,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "delivery",
        graph: {
          nodes: [
            {
              id: "prepare",
              kind: "publication",
              capability: "prepare",
              subject,
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
            {
              id: "push",
              kind: "publication",
              capability: "push",
              subject,
              resource: "workspace",
              mutates: false,
              requirements: [],
            },
          ],
          edges: [{ from: "prepare", to: "push" }],
        },
      },
      102,
    );
    work = f.work.getWorkInternal(detail.work.workItemId);
    let prepare = f.work.claimDagNode(
      detail.work.workItemId,
      "alice",
      "team-a",
      "prepare",
      "hub",
      work.stateRevision,
      1,
      103,
      1000,
    );
    prepare = f.work.startDagNodeExecution(prepare.nodeExecutionId, "hub", prepare.fence, 104);
    f.work.reconcileDagNodeResult(prepare.nodeExecutionId, "hub", prepare.fence, { status: "succeeded" }, 105);
    work = f.work.getWorkInternal(detail.work.workItemId);
    let push = f.work.claimDagNode(
      detail.work.workItemId,
      "alice",
      "team-a",
      "push",
      "hub",
      work.stateRevision,
      1,
      106,
      1000,
    );
    push = f.work.startDagNodeExecution(push.nodeExecutionId, "hub", push.fence, 107);
    f.work.setDagExecutionExternalRef(
      push.nodeExecutionId,
      "hub",
      push.fence,
      "publication-key:" + detail.work.workItemId + ":push:" + subject,
      108,
    );

    const publication = f.publications.createOrReusePublication(
      {
        workItemId: detail.work.workItemId,
        workAttemptId: "attempt-delivery",
        workspaceId: "workspace-delivery",
        sourceSubjectRevision: subject,
        baseCommit: "b".repeat(40),
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 1,
        branchName: "skillhub/work/cancel-push",
        pushRemoteName: "origin",
        ownerWorkerId: "worker-1",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "cancel push test",
        executionSnapshot: {
          workspacePath: "/tmp/workspace-delivery",
          repositoryUrl: "https://example.test/ota.git",
          defaultBranch: "main",
          branchPrefix: "skillhub/work/",
          protectedBranches: ["main"],
          allowedPushRemote: "origin",
          expectedContentRevision: "a".repeat(64),
          approvedChangeSummary: {
            baseCommit: "b".repeat(40),
            changedFiles: [],
            addedFiles: [],
            deletedFiles: [],
            diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
            contentRevision: "a".repeat(64),
          },
        },
      },
      109,
    );
    f.publications.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      110,
    );
    f.publications.transitionPublication(publication.publicationId, "approved", {}, 111);
    const publicationClaim = f.publications.claimPublicationOperation("worker-1", 112, 1000)!;
    assert.equal(publicationClaim.operation, "push");

    const cancelled = f.orchestrator.cancelWork(detail.work.workItemId, "alice", "team-a", 113);
    assert.equal(cancelled.work.status, "cancelled");
    const publicationAfter = f.publications.getPublication(publication.publicationId);
    assert.equal(publicationAfter.state, "failed");
    assert.equal(publicationAfter.lastErrorCode, "WORK_CANCELLED_OUTCOME_UNKNOWN");
    const pushAfter = f.work.listDagExecutions(detail.work.workItemId).find((item) => item.nodeId === "push")!;
    assert.equal(pushAfter.state, "external_outcome_unknown");
    assert.equal(pushAfter.result?.externalRef, "publication:" + publication.publicationId);
    assert.throws(
      () => f.publications.completePublicationOperation(publicationClaim, { success: true }, 114),
      /STALE_PUBLICATION_OPERATION/,
    );
  } finally {
    f.close();
  }
});

test("dynamic-dag resume only clears blocked state and leaves execution to DAG runtime", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    f.work.putWorkflow("dynamic-resume", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const detail = f.dynamicOrchestrator.submitWork(
      {
        ...submission,
        idempotencyKey: "dynamic-resume",
        workflowId: "dynamic-resume",
      },
      100,
    );
    let work = f.work.getWorkInternal(detail.work.workItemId);
    work = f.work.blockWork(
      detail.work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "DAG_EXECUTOR_UNAVAILABLE",
      null,
      110,
      { resumeCondition: "manual", blockedByType: "dag_executor" },
    );
    const resumed = f.orchestrator.resumeWork(detail.work.workItemId, "alice", "team-a", work.stateRevision, 120);
    assert.equal(resumed.work.status, "queued");
    assert.equal(resumed.attempts.length, 0);
  } finally {
    f.close();
  }
});

test("WorkAttempt pins workflow validation policy into ExpertTask and Worker claim", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("code-fix-default").definition;
    const validationV1 = [
      {
        id: "unit-test",
        type: "command",
        argv: ["npm", "test"],
        timeoutMs: 120_000,
        evidenceType: "unit_test",
      },
    ];
    f.work.putWorkflow(
      "verified-readonly",
      1,
      {
        ...base,
        validation: {
          requiredEvidence: ["expert_result", "unit_test"],
          required: validationV1,
        },
      },
      100,
    );

    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-validation-snapshot",
      workflowId: "verified-readonly",
    });
    assert.equal(detail.attempts[0]!.workflowVersion, 1);
    assert.deepEqual(detail.currentTask!.validationSnapshot, validationV1);

    f.work.putWorkflow(
      "verified-readonly",
      2,
      {
        ...base,
        validation: {
          requiredEvidence: ["expert_result", "lint"],
          required: [
            {
              id: "lint",
              type: "command",
              argv: ["npm", "run", "lint"],
              timeoutMs: 60_000,
              evidenceType: "lint",
            },
          ],
        },
      },
      200,
    );
    assert.deepEqual(f.tasks.get(detail.currentTask!.taskId, "alice", "team-a").validationSnapshot, validationV1);

    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    assert.deepEqual(claim.validationSnapshot, validationV1);
  } finally {
    f.close();
  }
});

test("deterministic dispatch rejection becomes durable blocked work instead of retrying forever", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-forbidden-deployment",
      deploymentId: "disabled-or-missing-deployment",
    });

    assert.equal(detail.work.status, "blocked");
    assert.equal(detail.work.blockedReason, "policy_blocked");
    assert.match(detail.work.blockedContext ?? "", /DEPLOYMENT_FORBIDDEN/);
    assert.equal(detail.attempts.length, 0);
    assert.equal(detail.currentTask, null);
    assert.deepEqual(f.orchestrator.reconcileActive(Date.now() + 10_000, 100), []);
  } finally {
    f.close();
  }
});

test("code-change work auto-routes Claude submission to the Claude write deployment", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-auto-deployment-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  const publications = new WorkPublicationStore(db);
  try {
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota", "upgrade"],
      active: true,
    });
    const verificationPolicy = {
      version: 1,
      required: [
        {
          id: "build",
          type: "command",
          argv: ["cmake", "--build", "/tmp/build"],
          timeoutMs: 120_000,
          evidenceType: "build",
        },
        {
          id: "unit",
          type: "command",
          argv: ["ctest", "--test-dir", "/tmp/build"],
          timeoutMs: 120_000,
          evidenceType: "unit_test",
        },
      ],
    };
    const common = {
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.test/ota.git",
          branch: "main",
          verificationPolicy,
        } as any,
      ],
      principals: ["alice"],
      active: true,
    };
    experts.putDeployment({ ...common, id: "ota-claude-ro", runtimeProfile: "claude-readonly" });
    experts.putDeployment({
      ...common,
      id: "ota-claude-rw",
      runtimeProfile: "claude-workspace-write",
      executor: {
        backend: "claude",
        modelConfig: {
          providerId: "router",
          model: "model",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages",
          allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
        },
      },
    });
    experts.putDeployment({ ...common, id: "ota-codex-ro", runtimeProfile: "codex-readonly" });
    experts.putDeployment({
      ...common,
      id: "ota-codex-rw",
      runtimeProfile: "codex-workspace-write",
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "model",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    const orchestrator = new WorkOrchestrator(
      work,
      tasks,
      new ExpertDispatchService(experts, tasks),
      undefined,
      publications,
    );

    const detail = submitPreCutoverLegacy(orchestrator, db, {
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "claude-auto-code-change",
      sourceType: "mcp",
      sourceScope: "claude-code_2.1.319 (cli)/38a7f4f7-ad57-4a4b-9f86-f793e0839622",
      sourceRef: "claude-auto-code-change",
      title: "Fix OTA bug",
      description: "fix one low-risk OTA boundary bug",
      workflowId: "bug-fix",
      expertId: "ota",
    });

    assert.equal(detail.work.status, "running");
    assert.equal(
      detail.work.repositoryId,
      null,
      "repository remains an intake hint; resolved repository is pinned on attempt",
    );
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.attempts[0]!.deploymentId, "ota-claude-rw");
    assert.equal(detail.currentTask!.deploymentId, "ota-claude-rw");
    assert.equal(detail.currentTask!.repositoryId, "ota-repo");
    assert.equal(
      (detail.attempts[0]!.dispatchBinding as { runtimeProfile?: string }).runtimeProfile,
      "claude-workspace-write",
    );
    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota", {
      backend: "claude",
      runtimeProfiles: ["claude-workspace-write"],
    })!;
    assert.match(claim.problem, /existing Team Skill Hub WorkAttempt/);
    assert.match(claim.problem, /Do NOT call submit_work, submit_expert_task, submit_expert_task_auto/);
    assert.match(claim.problem, /orchestration step has already happened/);
    assert.match(claim.problem, /Original work:\nfix one low-risk OTA boundary bug/);
  } finally {
    publications.close();
    work.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code-change blocks before ExpertTask dispatch when concrete build and unit verification are missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-verification-missing-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  const publications = new WorkPublicationStore(db);
  try {
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
    experts.putDeployment({
      id: "ota-write",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [{ id: "ota-repo", url: "https://example.test/ota.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "claude-workspace-write",
      active: true,
      executor: {
        backend: "claude",
        modelConfig: {
          providerId: "router",
          model: "model",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages",
          allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
        },
      },
    });
    const orchestrator = new WorkOrchestrator(
      work,
      tasks,
      new ExpertDispatchService(experts, tasks),
      undefined,
      publications,
    );
    const detail = submitPreCutoverLegacy(orchestrator, db, {
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "verification-policy-missing",
      sourceType: "mcp",
      sourceScope: "claude-code/verification-policy-missing",
      sourceRef: "verification-policy-missing",
      title: "Fix OTA bug",
      description: "fix an OTA bug",
      workflowId: "bug-fix",
      expertId: "ota",
    });

    assert.equal(detail.work.status, "blocked");
    assert.equal(detail.work.blockedReason, "policy_blocked");
    assert.match(detail.work.blockedContext ?? "", /VERIFICATION_POLICY_MISSING/);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.currentTask, null);
  } finally {
    publications.close();
    work.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository verification policy is pinned into code-change task and makes integration evidence mandatory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-repository-verification-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  const publications = new WorkPublicationStore(db);
  try {
    const steps = [
      {
        id: "build",
        type: "command",
        argv: ["sh", "-lc", "cmake -S /workspace -B /tmp/build && cmake --build /tmp/build"],
        timeoutMs: 120_000,
        evidenceType: "build",
      },
      {
        id: "unit",
        type: "command",
        argv: ["sh", "-lc", "ctest --test-dir /tmp/build -R '^unit_'"],
        timeoutMs: 120_000,
        evidenceType: "unit_test",
      },
      {
        id: "integration",
        type: "command",
        argv: ["sh", "-lc", "ctest --test-dir /tmp/build -R '^integration_tests$'"],
        timeoutMs: 120_000,
        evidenceType: "integration_test",
      },
    ];
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
    experts.putDeployment({
      id: "ota-write",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.test/ota.git",
          branch: "main",
          verificationPolicy: { version: 1, required: steps },
        } as any,
      ],
      principals: ["alice"],
      runtimeProfile: "claude-workspace-write",
      active: true,
      executor: {
        backend: "claude",
        modelConfig: {
          providerId: "router",
          model: "model",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages",
          allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
        },
      },
    });
    experts.putDeployment({
      id: "ota-read",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.test/ota.git",
          branch: "main",
          verificationPolicy: { version: 1, required: steps },
        } as any,
      ],
      principals: ["alice"],
      runtimeProfile: "claude-readonly",
      active: true,
      executor: {
        backend: "claude",
        modelConfig: {
          providerId: "router",
          model: "model",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages",
          allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
        },
      },
    });
    const orchestrator = new WorkOrchestrator(
      work,
      tasks,
      new ExpertDispatchService(experts, tasks),
      undefined,
      publications,
    );
    const detail = submitPreCutoverLegacy(orchestrator, db, {
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "repository-verification-policy",
      sourceType: "mcp",
      sourceScope: "claude-code/repository-verification-policy",
      sourceRef: "repository-verification-policy",
      title: "Fix OTA bug",
      description: "fix an OTA bug",
      workflowId: "bug-fix",
      expertId: "ota",
    });

    assert.equal(detail.work.status, "running");
    assert.deepEqual(detail.currentTask?.validationSnapshot, steps);
    assert.ok(detail.gate.missing.includes("required_evidence:integration_test"));

    experts.putDeployment({
      ...experts.getDeployment("ota-write"),
      repositories: [
        {
          ...experts.getDeployment("ota-write").repositories![0]!,
          verificationPolicy: { version: 2, required: steps.slice(0, 2) },
        } as any,
      ],
    });
    assert.deepEqual(tasks.get(detail.currentTask!.taskId, "alice", "team-a").validationSnapshot, steps);

    const readonlyStep = {
      id: "metadata-check",
      type: "command",
      argv: ["sh", "-lc", "test -f CMakeLists.txt"],
      timeoutMs: 30_000,
      evidenceType: "metadata_check",
    };
    const investigation = work.getWorkflow("investigation").definition;
    work.putWorkflow(
      "readonly-with-local-check",
      1,
      {
        ...investigation,
        validation: {
          requiredEvidence: ["expert_result", "metadata_check"],
          required: [readonlyStep],
        },
      },
      500,
    );
    const readonly = submitPreCutoverLegacy(orchestrator, db, {
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "readonly-repository-verification-policy",
      sourceType: "mcp",
      sourceScope: "claude-code/readonly-repository-verification-policy",
      sourceRef: "readonly-repository-verification-policy",
      title: "Count source lines",
      description: "count source lines without modifying files",
      workflowId: "readonly-with-local-check",
      expertId: "ota",
    });
    assert.equal(readonly.currentTask?.deploymentId, "ota-read");
    assert.deepEqual(readonly.currentTask?.validationSnapshot, [readonlyStep]);
  } finally {
    publications.close();
    work.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification command-not-found blocks as environment failure instead of continuing the agent", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    const buildStep = {
      id: "build",
      type: "command",
      argv: ["sh", "-lc", "missing-build-command"],
      timeoutMs: 30_000,
      evidenceType: "build",
    };
    f.work.putWorkflow(
      "readonly-verified",
      1,
      {
        ...base,
        validation: { requiredEvidence: ["expert_result", "build"], required: [buildStep] },
      },
      100,
    );
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "verification-exit-127",
      workflowId: "readonly-verified",
    });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    const subjectRevision = "f".repeat(40);
    f.tasks.complete(claim, "counted source lines", 2_000, { commitSha: subjectRevision }, [
      {
        stepId: "build",
        type: "command",
        evidenceType: "build",
        status: "failed",
        exitCode: 127,
        durationMs: 10,
        errorCode: "VERIFICATION_EXIT_NONZERO",
        subjectRevision,
        environmentIdentity: "worker:worker-a",
        verifierIdentity: "team-skill-hub-worker@1",
      },
    ]);

    const reconciled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(reconciled.work.status, "blocked");
    assert.equal(reconciled.work.blockedReason, "verification_environment");
    assert.equal(reconciled.work.blockedContext, "build:VERIFICATION_EXIT_127");
    assert.equal(reconciled.work.nextActionType, null);
    assert.equal(reconciled.currentTask?.continuationCount, 0);
  } finally {
    f.close();
  }
});

test("verification process failure blocks as environment failure instead of continuing the agent", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    const buildStep = {
      id: "build",
      type: "command",
      argv: ["sh", "-lc", "cmake --build /tmp/build"],
      timeoutMs: 30_000,
      evidenceType: "build",
    };
    f.work.putWorkflow(
      "readonly-process-verified",
      1,
      {
        ...base,
        validation: { requiredEvidence: ["expert_result", "build"], required: [buildStep] },
      },
      100,
    );
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "verification-process-failed",
      workflowId: "readonly-process-verified",
    });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    const subjectRevision = "e".repeat(40);
    f.tasks.complete(claim, "counted source lines", 2_000, { commitSha: subjectRevision }, [
      {
        stepId: "build",
        type: "command",
        evidenceType: "build",
        status: "failed",
        exitCode: null,
        durationMs: 10,
        errorCode: "VERIFICATION_PROCESS_FAILED",
        subjectRevision,
        environmentIdentity: "worker:worker-a",
        verifierIdentity: "team-skill-hub-worker@1",
      },
    ]);

    const reconciled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(reconciled.work.status, "blocked");
    assert.equal(reconciled.work.blockedReason, "verification_environment");
    assert.equal(reconciled.work.blockedContext, "build:VERIFICATION_PROCESS_FAILED");
    assert.equal(reconciled.work.nextActionType, null);
    assert.equal(reconciled.currentTask?.continuationCount, 0);
  } finally {
    f.close();
  }
});

test("submitWork creates one WorkAttempt and one linked ExpertTask and reuses them idempotently", () => {
  const f = fixture();
  try {
    const first = f.orchestrator.submitWork(submission);
    assert.equal(first.work.status, "running");
    assert.equal(first.attempts.length, 1);
    assert.ok(first.currentTask);
    assert.equal(first.currentTask!.workItemId, first.work.workItemId);
    assert.equal(first.currentTask!.workAttemptId, first.attempts[0]!.workAttemptId);
    const workspace = f.work.getWorkspace(first.attempts[0]!.workspaceId!);
    assert.equal(first.currentTask!.workspaceKey, workspace.workspaceKey);

    const replay = f.orchestrator.submitWork(submission);
    assert.equal(replay.work.workItemId, first.work.workItemId);
    assert.equal(replay.attempts.length, 1);
    assert.equal(replay.currentTask!.taskId, first.currentTask!.taskId);
  } finally {
    f.close();
  }
});

test("orchestrator respects durable foreign claim and only dispatches after the lease expires", () => {
  const f = fixture();
  try {
    const work = f.work.createOrReuseWork({ ...submission, idempotencyKey: "work-foreign-claim" }, 100);
    markPreCutoverLegacy(f.db, work.workItemId);
    f.work.claimWorkForOrchestration(work.workItemId, "other-orchestrator", 200, 1_000);

    assert.throws(
      () => f.orchestrator.reconcileWork(work.workItemId, "alice", "team-a", 300),
      /WORK_ORCHESTRATION_CLAIMED/,
    );
    assert.equal(f.work.listAttempts(work.workItemId).length, 0);

    const recovered = f.orchestrator.reconcileWork(work.workItemId, "alice", "team-a", 1_201);
    assert.equal(recovered.attempts.length, 1);
    assert.ok(recovered.currentTask);
    assert.equal(f.work.getWork(work.workItemId, "alice", "team-a").orchestrationOwnerId, null);
  } finally {
    f.close();
  }
});

test("reconciliation recovers an attempt created before its deterministic task link without duplicate dispatch", () => {
  const f = fixture();
  try {
    const work = f.work.createOrReuseWork(submission);
    markPreCutoverLegacy(f.db, work.workItemId);
    const attempt = f.work.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    assert.equal(attempt.taskId, null);

    const recovered = f.orchestrator.reconcileWork(work.workItemId, "alice", "team-a");
    assert.equal(recovered.attempts.length, 1);
    assert.ok(recovered.currentTask);
    assert.equal(recovered.currentTask!.workAttemptId, attempt.workAttemptId);

    const again = f.orchestrator.reconcileWork(work.workItemId, "alice", "team-a");
    assert.equal(again.currentTask!.taskId, recovered.currentTask!.taskId);
    assert.equal(f.work.listAttempts(work.workItemId).length, 1);
  } finally {
    f.close();
  }
});

test("cancelWork cancels the linked task and closes the active WorkAttempt", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const cancelled = f.orchestrator.cancelWork(detail.work.workItemId, "alice", "team-a", 2_000);
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(cancelled.work.activeWorkAttemptId, null);
    assert.equal(cancelled.attempts[0]!.status, "cancelled");
    assert.equal(cancelled.currentTask!.status, "cancelled");
  } finally {
    f.close();
  }
});
test("active reconciliation advances completed tasks without a client read", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-active-reconcile" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "background result", 2_000, { commitSha: "c".repeat(40) });

    const processed = f.orchestrator.reconcileActive(3_000, 100);

    assert.deepEqual(processed, [detail.work.workItemId]);
    const persisted = f.work.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(persisted.status, "waiting_review");
  } finally {
    f.close();
  }
});

test("startup reconciliation recovers durable work after stores reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestrator-restart-"));
  const db = path.join(dir, "runtime.sqlite");
  let experts = new ExpertStore(db);
  let tasks = new ExpertTaskStore(db);
  let work = new WorkOrchestrationStore(db);
  try {
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota", "upgrade"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    let orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const detail = submitPreCutoverLegacy(orchestrator, db, {
      ...submission,
      idempotencyKey: "work-restart-reconcile",
    });
    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    tasks.complete(claim, "completed while hub is restarting", 2_000, { commitSha: "d".repeat(40) });

    work.close();
    tasks.close();
    experts.close();

    experts = new ExpertStore(db);
    tasks = new ExpertTaskStore(db);
    work = new WorkOrchestrationStore(db);
    orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));

    const processed = orchestrator.reconcileStartup(3_000, 100);

    assert.ok(processed.includes(detail.work.workItemId));
    assert.equal(work.getWork(detail.work.workItemId, "alice", "team-a").status, "waiting_review");
  } finally {
    work.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup reconciliation recovers a durable rework request created before its WorkAttempt", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-rework-restart-"));
  const db = path.join(dir, "runtime.sqlite");
  let experts = new ExpertStore(db);
  let tasks = new ExpertTaskStore(db);
  let work = new WorkOrchestrationStore(db);
  try {
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota", "upgrade"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    let orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const detail = submitPreCutoverLegacy(orchestrator, db, { ...submission, idempotencyKey: "work-rework-restart" });
    const taskClaim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    tasks.complete(taskClaim, "initial result", 2_000, { commitSha: "e".repeat(40) });
    const waiting = orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.status, "waiting_review");

    const pending = work.requestRework(
      waiting.work.workItemId,
      "alice",
      "team-a",
      waiting.work.stateRevision,
      {
        reason: "human_rework",
        originWorkAttemptId: waiting.attempts[0]!.workAttemptId,
        reviewContext: JSON.stringify({ disposition: "partially_adopted", needsRework: true }),
        whatShouldChange: "补断电恢复验证",
        createdBy: "alice",
      },
      4_000,
    );
    assert.equal(pending.status, "rework");
    assert.equal(pending.nextActionType, "rework");

    work.close();
    tasks.close();
    experts.close();
    experts = new ExpertStore(db);
    tasks = new ExpertTaskStore(db);
    work = new WorkOrchestrationStore(db);
    orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));

    const processed = orchestrator.reconcileStartup(5_000, 100);
    assert.ok(processed.includes(detail.work.workItemId));
    const recovered = orchestrator.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(recovered.work.status, "running");
    assert.equal(recovered.work.nextActionType, null);
    assert.equal(recovered.attempts.length, 2);
    assert.equal(recovered.attempts[1]!.reason, "human_rework");
    assert.equal(recovered.attempts[1]!.originWorkAttemptId, waiting.attempts[0]!.workAttemptId);
    assert.equal(recovered.attempts[1]!.whatShouldChange, "补断电恢复验证");
    assert.equal(recovered.attempts[1]!.createdBy, "alice");
  } finally {
    work.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked rework preserves its durable action and resumes as rework instead of initial", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-rework-block-resume" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "initial result", 2_000, { commitSha: "9".repeat(40) });
    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);

    const pending = f.work.requestRework(
      waiting.work.workItemId,
      "alice",
      "team-a",
      waiting.work.stateRevision,
      {
        reason: "human_rework",
        originWorkAttemptId: waiting.attempts[0]!.workAttemptId,
        reviewContext: JSON.stringify({ disposition: "partially_adopted", needsRework: true }),
        whatShouldChange: "补电源异常路径",
        createdBy: "alice",
      },
      4_000,
    );
    assert.equal(pending.nextActionType, "rework");

    f.experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: false,
    });
    const blocked = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 4_100);
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.nextActionType, "rework");
    assert.equal(blocked.work.nextActionAt, null);
    assert.match(blocked.work.nextActionContext ?? "", /human_rework/);

    f.experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const resumed = f.orchestrator.resumeWork(
      detail.work.workItemId,
      "alice",
      "team-a",
      blocked.work.stateRevision,
      5_000,
    );
    assert.equal(resumed.work.status, "running");
    assert.equal(resumed.work.nextActionType, null);
    assert.equal(resumed.attempts.length, 2);
    assert.equal(resumed.attempts[1]!.reason, "human_rework");
    assert.equal(resumed.attempts[1]!.whatShouldChange, "补电源异常路径");
  } finally {
    f.close();
  }
});

test("successful task becomes revision-bound evidence then accepted review completes work", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "read-only OTA result", 2_000, {
      repositoryUrl: "https://example.test/ota.git",
      repositoryBranch: "main",
      commitSha: "a".repeat(40),
    });

    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.status, "waiting_review");
    assert.equal(waiting.attempts[0]!.status, "succeeded");
    assert.equal(waiting.evidence.length, 1);
    assert.equal(waiting.evidence[0]!.type, "expert_result");
    assert.equal(waiting.evidence[0]!.subjectRevision, "a".repeat(40));
    assert.equal(waiting.gate.ready, false);
    assert.equal(
      f.work.listEvents(detail.work.workItemId).events.filter((event) => event.eventType === "review.requested").length,
      1,
    );
    const workspace = f.work.getWorkspace(waiting.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      3_100,
      "a".repeat(40),
    );

    const completed = f.orchestrator.submitReview(detail.work.workItemId, "alice", "team-a", {
      expectedRevision: waiting.work.stateRevision,
      subjectRevision: "a".repeat(40),
      decision: "accepted",
    });
    assert.equal(completed.work.status, "completed");
    assert.equal(completed.gate.ready, true);
    assert.equal(f.work.getWorkspace(workspace.workspaceId).state, "cleaning");
    const cleanup = f.work.claimWorkspaceCleanup("worker-a", 4_000, 30_000)!;
    f.work.completeWorkspaceCleanup(cleanup.workspaceId, "worker-a", cleanup.fencing, false, "DELETE_FAILED", 4_100);
    assert.equal(f.work.getWorkspace(workspace.workspaceId).state, "failed");
    assert.equal(f.work.getWork(detail.work.workItemId, "alice", "team-a").status, "completed");
  } finally {
    f.close();
  }
});

test("configured reviewer expert runs an independent owner-affine review task and records accepted review", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow("agent-reviewed", 1, {
      ...structuredClone(base),
      review: { required: true, reviewerExpertId: "ota" },
    });
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "agent-reviewed-work",
      workflowId: "agent-reviewed",
    });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      1_100,
      "a".repeat(40),
    );
    const implementation = f.tasks.claim("worker-a", 1_200, 30_000, "ota")!;
    f.tasks.complete(implementation, "implementation result", 2_000, { commitSha: "a".repeat(40) });

    const reviewing = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(reviewing.work.status, "running");
    assert.equal(reviewing.attempts[0]!.status, "active");
    assert.ok(reviewing.reviewTask);
    assert.equal(reviewing.reviewTask!.expertId, "ota");
    assert.equal(reviewing.reviewTask!.requiredWorkerId, "worker-a");
    assert.notEqual(reviewing.reviewTask!.taskId, reviewing.currentTask!.taskId);

    const reviewClaim = f.tasks.claim("worker-a", 3_100, 30_000, "ota")!;
    assert.equal(reviewClaim.taskId, reviewing.reviewTask!.taskId);
    f.tasks.complete(reviewClaim, JSON.stringify({ decision: "accepted", reason: "looks good" }), 3_200, {
      commitSha: "a".repeat(40),
    });

    const completed = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 4_000);
    assert.equal(completed.work.status, "completed");
    assert.equal(completed.attempts[0]!.status, "succeeded");
    assert.equal(completed.reviews.at(-1)?.decision, "accepted");
    assert.equal(completed.reviews.at(-1)?.actorPrincipalId, "agent:ota");
    assert.equal(completed.gate.ready, true);
  } finally {
    f.close();
  }
});

test("required build and unit evidence block before review is dispatched", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow("quality-before-review", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["expert_result", "build", "unit_test"], required: [] },
      review: { required: true, reviewerExpertId: "ota" },
    });
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "quality-before-review",
      workflowId: "quality-before-review",
    });
    const implementation = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(implementation, "implementation result", 2_000, { commitSha: "a".repeat(40) });

    const blocked = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedReason, "verification_required");
    assert.match(blocked.work.blockedContext ?? "", /required_evidence:build/);
    assert.match(blocked.work.blockedContext ?? "", /required_evidence:unit_test/);
    assert.equal(blocked.reviewTask, null);
  } finally {
    f.close();
  }
});

test("worker verification results become revision-bound evidence before review", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow(
      "verified",
      1,
      {
        ...base,
        validation: {
          requiredEvidence: ["expert_result", "unit_test"],
          required: [
            {
              id: "unit",
              type: "command",
              argv: ["npm", "test"],
              timeoutMs: 60_000,
              evidenceType: "unit_test",
            },
          ],
        },
      },
      100,
    );
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-verified-evidence",
      workflowId: "verified",
    });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    const revision = "e".repeat(40);
    f.tasks.complete(claim, "verified result", 2_000, { commitSha: revision }, [
      {
        stepId: "unit",
        type: "command",
        evidenceType: "unit_test",
        status: "passed",
        exitCode: 0,
        durationMs: 10,
        errorCode: null,
        subjectRevision: revision,
        environmentIdentity: "worker:worker-a",
        verifierIdentity: "team-skill-hub-worker",
      },
    ]);

    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.status, "waiting_review");
    assert.deepEqual(
      waiting.evidence
        .map((item) => [item.type, item.status, item.source, item.subjectRevision])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        ["expert_result", "passed", "worker_verified", revision],
        ["unit_test", "passed", "worker_verified", revision],
      ],
    );
    assert.deepEqual(waiting.gate.missing, ["review_accepted"]);
  } finally {
    f.close();
  }
});

test("failed required verification schedules continuation on the same WorkAttempt", () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow(
      "verified-continuation",
      1,
      {
        ...base,
        lifecycle: {
          ...base.lifecycle,
          continuation: { maxTurnsPerRun: 2 },
        },
        validation: {
          requiredEvidence: ["expert_result", "unit_test"],
          required: [
            {
              id: "unit",
              type: "command",
              argv: ["npm", "test"],
              timeoutMs: 60_000,
              evidenceType: "unit_test",
            },
          ],
        },
      },
      100,
    );
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-verification-continuation",
      workflowId: "verified-continuation",
    });
    const attempt = detail.attempts[0]!;
    const workspace = f.work.getWorkspace(attempt.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      1_100,
      "f".repeat(40),
    );
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    const revision = "f".repeat(40);
    f.tasks.complete(claim, "needs another turn", 2_000, { commitSha: revision }, [
      {
        stepId: "unit",
        type: "command",
        evidenceType: "unit_test",
        status: "failed",
        exitCode: 1,
        durationMs: 10,
        errorCode: "VERIFICATION_EXIT_NONZERO",
        subjectRevision: revision,
        environmentIdentity: "worker:worker-a",
        verifierIdentity: "team-skill-hub-worker",
      },
    ]);

    const scheduled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(scheduled.work.status, "running");
    assert.equal(scheduled.work.nextActionType, "continuation");
    assert.equal(scheduled.attempts.length, 1);
    assert.equal(scheduled.currentTask!.taskId, detail.currentTask!.taskId);
    assert.equal(scheduled.evidence.find((item) => item.type === "unit_test")?.status, "failed");

    const continued = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_001);
    assert.equal(continued.currentTask!.status, "queued");
    assert.equal(continued.currentTask!.continuationCount, 1);
    assert.equal(continued.attempts.length, 1);
  } finally {
    f.close();
  }
});

test("rework feedback replay creates exactly one new WorkAttempt", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const taskId = detail.currentTask!.taskId;
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "result", 2_000, { commitSha: "b".repeat(40) });
    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.status, "waiting_review");

    const feedback = { disposition: "partially_adopted" as const, reason: "补验证", needsRework: true };
    const reworked = f.orchestrator.handleTaskFeedback(taskId, "alice", "team-a", feedback, 4_000)!;
    assert.equal(reworked.attempts.length, 2);
    assert.equal(reworked.attempts[1]!.reason, "human_rework");
    assert.equal(reworked.attempts[1]!.originWorkAttemptId, reworked.attempts[0]!.workAttemptId);
    assert.match(reworked.attempts[1]!.reviewContext ?? "", /partially_adopted/);
    assert.equal(reworked.attempts[1]!.whatShouldChange, "补验证");
    assert.equal(reworked.attempts[1]!.createdBy, "alice");
    assert.equal(reworked.work.status, "running");

    const replay = f.orchestrator.handleTaskFeedback(taskId, "alice", "team-a", feedback, 5_000)!;
    assert.equal(replay.attempts.length, 2);
    assert.equal(replay.currentTask!.taskId, reworked.currentTask!.taskId);
    assert.equal(
      f.work.listEvents(detail.work.workItemId).events.filter((event) => event.eventType === "rework.started").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("review rework persists the review audit context on the new WorkAttempt", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "review-rework-audit" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "result", 2_000, { commitSha: "c".repeat(40) });
    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    const reworked = f.orchestrator.submitReview(
      detail.work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: waiting.work.stateRevision,
        subjectRevision: "c".repeat(40),
        decision: "rework",
        reason: "补充断电恢复测试",
      },
      4_000,
    );
    assert.equal(reworked.attempts.length, 2);
    const audit = reworked.attempts[1]!;
    assert.equal(audit.reason, "review_rework");
    assert.equal(audit.originWorkAttemptId, reworked.attempts[0]!.workAttemptId);
    assert.match(audit.reviewContext ?? "", /rework/);
    assert.equal(audit.whatShouldChange, "补充断电恢复测试");
    assert.equal(audit.createdBy, "alice");
  } finally {
    f.close();
  }
});

test("continuation fails closed when the workspace owner is unavailable", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation-no-owner" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "first result", 2_000, { commitSha: "f".repeat(40) });

    const blocked = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verification_failed",
      3_000,
    );
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedReason, "workspace_unavailable");
    assert.equal(blocked.work.nextActionType, null);
    assert.equal(blocked.currentTask!.status, "succeeded");
  } finally {
    f.close();
  }
});

test("continuation blocks when the workspace owner Worker heartbeat is unavailable", () => {
  const f = fixture(() => false);
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation-offline-owner" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "first result", 2_000, { commitSha: "f".repeat(40) });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      2_100,
      "f".repeat(40),
    );

    const blocked = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verification_failed",
      3_000,
    );
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedReason, "workspace_unavailable");
    assert.equal(blocked.work.blockedContext, "WORKSPACE_OWNER_OFFLINE");
    assert.equal(blocked.work.nextActionType, null);
  } finally {
    f.close();
  }
});

test("explicit resume refuses an offline workspace owner and succeeds after owner recovery", () => {
  let ownerOnline = false;
  const f = fixture(() => ownerOnline);
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-explicit-resume-owner" });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "first result", 2_000, { commitSha: "f".repeat(40) });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      2_100,
      "f".repeat(40),
    );
    const blocked = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verification_failed",
      3_000,
    );
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedAt, 3_000);
    assert.equal(blocked.work.resumeCondition, "manual");
    assert.equal(blocked.work.blockedByType, "workspace");
    assert.equal(blocked.work.blockedByRef, "worker-a");

    assert.throws(
      () => f.orchestrator.resumeWork(detail.work.workItemId, "alice", "team-a", blocked.work.stateRevision, 3_100),
      /WORKSPACE_OWNER_OFFLINE/,
    );
    assert.equal(f.work.getWork(detail.work.workItemId, "alice", "team-a").status, "blocked");

    ownerOnline = true;
    const resumed = f.orchestrator.resumeWork(
      detail.work.workItemId,
      "alice",
      "team-a",
      blocked.work.stateRevision,
      3_200,
    );
    assert.equal(resumed.work.status, "running");
    assert.equal(resumed.work.blockedReason, null);
    assert.equal(resumed.work.nextActionType, "continuation");
  } finally {
    f.close();
  }
});

test("durable continuation reuses the same WorkAttempt and ExpertTask but creates a new Run", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation" });
    const attemptId = detail.attempts[0]!.workAttemptId;
    const taskId = detail.currentTask!.taskId;
    const firstClaim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(firstClaim, "first result", 2_000, { commitSha: "f".repeat(40) });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      2_100,
      "f".repeat(40),
    );

    const scheduled = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "verification_failed",
      3_000,
    );
    assert.equal(scheduled.work.status, "running");
    assert.equal(scheduled.work.nextActionType, "continuation");
    assert.equal(scheduled.work.nextActionContext, "verification_failed");
    assert.equal(scheduled.attempts.length, 1);
    assert.equal(scheduled.attempts[0]!.workAttemptId, attemptId);
    assert.equal(scheduled.currentTask!.taskId, taskId);
    assert.equal(scheduled.currentTask!.status, "succeeded");

    f.orchestrator.reconcileDue(3_000);
    const requeued = f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(requeued.work.nextActionType, null);
    assert.equal(requeued.work.nextActionContext, null);
    assert.equal(requeued.attempts.length, 1);
    assert.equal(requeued.attempts[0]!.workAttemptId, attemptId);
    assert.equal(requeued.currentTask!.taskId, taskId);
    assert.equal(requeued.currentTask!.status, "queued");
    assert.equal(requeued.currentTask!.continuationCount, 1);
    assert.equal(
      f.work.listEvents(detail.work.workItemId).events.filter((event) => event.eventType === "run.continued").length,
      1,
    );

    const secondClaim = f.tasks.claim("worker-a", 3_001, 30_000, "ota")!;
    assert.equal(secondClaim.taskId, taskId);
    assert.notEqual(secondClaim.runId, firstClaim.runId);
    assert.ok(secondClaim.fencing > firstClaim.fencing);
  } finally {
    f.close();
  }
});

test("continuation respects the workflow agent-turn budget", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork({ ...submission, idempotencyKey: "work-continuation-limit" });
    let claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.complete(claim, "turn-1", 2_000, { commitSha: "e".repeat(40) });
    const workspace = f.work.getWorkspace(detail.attempts[0]!.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      2_100,
      "e".repeat(40),
    );

    for (let continuation = 1; continuation <= 19; continuation++) {
      const now = 3_000 + continuation * 10;
      f.orchestrator.requestContinuation(detail.work.workItemId, "alice", "team-a", "continue-" + continuation, now);
      f.orchestrator.reconcileDue(now);
      claim = f.tasks.claim("worker-a", now + 1, 30_000, "ota")!;
      f.tasks.complete(claim, "turn-" + (continuation + 1), now + 2, { commitSha: "e".repeat(40) });
    }

    assert.equal(f.tasks.get(detail.currentTask!.taskId, "alice", "team-a").continuationCount, 19);
    const limited = f.orchestrator.requestContinuation(
      detail.work.workItemId,
      "alice",
      "team-a",
      "one-too-many",
      10_000,
    );
    assert.equal(limited.work.status, "blocked");
    assert.equal(limited.work.blockedReason, "continuation_limit");
    assert.equal(limited.work.blockedContext, "WORK_CONTINUATION_LIMIT_REACHED");
    assert.equal(limited.work.nextActionType, null);
  } finally {
    f.close();
  }
});

test("transient task failure schedules durable retry and reuses the same ExpertTask with a new Run", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const taskId = detail.currentTask!.taskId;
    const firstClaim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.fail(firstClaim, "TEMPORARY_NETWORK_ERROR", 2_000);

    const scheduled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(scheduled.work.status, "running");
    assert.equal(scheduled.work.nextActionType, "failure_retry");
    assert.ok((scheduled.work.nextActionAt ?? 0) > 3_000);
    assert.equal(
      f.work.listEvents(detail.work.workItemId).events.filter((event) => event.eventType === "run.retry_scheduled")
        .length,
      1,
    );
    f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_001);
    assert.equal(
      f.work.listEvents(detail.work.workItemId).events.filter((event) => event.eventType === "run.retry_scheduled")
        .length,
      1,
    );

    f.orchestrator.reconcileDue((scheduled.work.nextActionAt ?? 0) + 1);
    assert.equal(f.tasks.get(taskId, "alice", "team-a").status, "queued");
    const secondClaim = f.tasks.claim("worker-a", (scheduled.work.nextActionAt ?? 0) + 2, 30_000, "ota")!;
    assert.equal(secondClaim.taskId, taskId);
    assert.notEqual(secondClaim.runId, firstClaim.runId);
    assert.ok(secondClaim.fencing > firstClaim.fencing);
  } finally {
    f.close();
  }
});

test("permission blocker is durable and does not retry", () => {
  const f = fixture();
  try {
    const detail = f.orchestrator.submitWork(submission);
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    f.tasks.fail(claim, "MISSING_PERMISSION", 2_000);
    const blocked = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(blocked.work.status, "blocked");
    assert.equal(blocked.work.blockedReason, "missing_permission");
    assert.equal(blocked.work.nextActionAt, null);
  } finally {
    f.close();
  }
});
test("deterministic workspace owner and shared-group violations block without retry", () => {
  for (const code of [
    "WORKER_CHECKOUT_OWNER_NOT_ALLOWED",
    "WORKER_GIT_METADATA_OWNERSHIP_INVALID",
    "WORKER_CHECKOUT_GROUP_NOT_CONFIGURED",
    "WORKER_CHECKOUT_PERMISSION_NOT_SHARED",
    "WORKER_RUNTIME_STATE_OWNER_INVALID",
    "WORKER_RUNTIME_STATE_GROUP_NOT_CONFIGURED",
    "WORKSPACE_PREPARATION_INCOMPLETE",
    "WORKSPACE_PREPARATION_REVISION_MISMATCH",
  ]) {
    const f = fixture();
    try {
      const detail = f.orchestrator.submitWork(submission);
      const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
      f.tasks.fail(claim, code, 2_000);
      const blocked = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
      assert.equal(blocked.work.status, "blocked", code);
      assert.equal(blocked.work.blockedReason, "policy_blocked", code);
      assert.equal(blocked.work.blockedContext, code);
      assert.equal(blocked.work.nextActionAt, null);
      assert.equal(f.tasks.runCount(claim.taskId), 1);
      assert.equal(
        f.work.listEvents(detail.work.workItemId).events.filter((event) => event.eventType === "run.retry_scheduled")
          .length,
        0,
      );
    } finally {
      f.close();
    }
  }
});

test("write task uses workspace content revision and invalidates prior revision decisions", () => {
  const f = fixture();
  try {
    f.experts.putDeployment({
      id: "ota-write",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
    });
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow("write-verified", 1, {
      ...structuredClone(base),
      execution: {
        ...structuredClone(base.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
      validation: {
        requiredEvidence: ["expert_result", "unit_test"],
        required: [
          {
            id: "unit",
            type: "command",
            argv: ["npm", "test"],
            timeoutMs: 60_000,
            evidenceType: "unit_test",
          },
        ],
      },
    });
    const detail = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "work-write-subject",
      workflowId: "write-verified",
      deploymentId: "ota-write",
    });
    const claim = f.tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    const summary = {
      baseCommit: "a".repeat(40),
      changedFiles: ["fixture.txt"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
      contentRevision: "c".repeat(64),
    };
    const subject = "workspace:" + summary.contentRevision;
    f.tasks.complete(
      claim,
      "changed",
      2_000,
      { commitSha: summary.baseCommit },
      [
        {
          stepId: "unit",
          type: "command",
          evidenceType: "unit_test",
          status: "passed",
          exitCode: 0,
          durationMs: 10,
          errorCode: null,
          subjectRevision: subject,
          environmentIdentity: "worker:worker-a",
          verifierIdentity: "team-skill-hub-worker",
        },
      ],
      summary,
    );

    const waiting = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(waiting.work.currentSubjectRevision, subject);
    assert.deepEqual(waiting.evidence.map((item) => [item.type, item.subjectRevision, item.stale]).sort(), [
      ["expert_result", subject, false],
      ["unit_test", subject, false],
    ]);

    let work = f.work.getWork(detail.work.workItemId, "alice", "team-a");
    f.work.submitReviewDecision(work.workItemId, "alice", "team-a", {
      expectedRevision: work.stateRevision,
      subjectRevision: subject,
      decision: "accepted",
    });
    work = f.work.getWork(work.workItemId, "alice", "team-a");
    f.work.recordApproval(work.workItemId, "alice", "team-a", {
      expectedRevision: work.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: subject,
      decision: "approved",
    });
    work = f.work.getWork(work.workItemId, "alice", "team-a");
    const nextSubject = "workspace:" + "d".repeat(64);
    f.work.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, nextSubject, 4_000);

    assert.ok(f.work.listEvidence(work.workItemId).every((item) => item.stale));
    assert.ok(f.work.listApprovals(work.workItemId).every((item) => item.stale));
    assert.ok(f.work.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("review_accepted"));
  } finally {
    f.close();
  }
});

test("prepared publication artifact binds current workspace revision and blocks when source becomes stale", () => {
  const f = fixture();
  try {
    let work = f.work.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "publication-artifact",
      sourceType: "mcp",
      title: "Publish accepted change",
      description: "prepare a controlled commit",
    });
    const attempt = f.work.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = f.work.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "b".repeat(40),
    });
    work = f.work.getWork(work.workItemId, "alice", "team-a");
    const subject = "workspace:" + "a".repeat(64);
    work = f.work.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, subject, 100);
    const publication = f.publications.createOrReusePublication(
      {
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workspaceId: workspace.workspaceId,
        sourceSubjectRevision: subject,
        baseCommit: "b".repeat(40),
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 2,
        branchName: "skillhub/work/work-a1",
        pushRemoteName: "origin",
        pushRefspec: "c".repeat(40) + ":refs/heads/skillhub/work/work-a1",
        ownerWorkerId: "worker-a",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "Publish\\n",
      },
      110,
    );
    f.publications.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
      },
      120,
    );

    f.orchestrator.recordPreparedPublicationArtifact(
      work.workItemId,
      "alice",
      "team-a",
      publication.publicationId,
      130,
    );
    const artifact = f.publications.getPublicationArtifact(publication.publicationId);
    assert.equal(artifact?.sourceSubjectRevision, subject);
    assert.equal(artifact?.commitSha, "c".repeat(40));
    assert.equal(artifact?.treeSha, "d".repeat(40));
    const evidence = f.work.listEvidence(work.workItemId).find((item) => item.type === "artifact");
    assert.equal(evidence?.status, "passed");
    assert.equal(evidence?.source, "worker_verified");
    assert.equal(evidence?.artifactRef, "publication:" + publication.publicationId);
    assert.equal(evidence?.subjectRevision, subject);
    assert.equal(evidence?.stale, false);

    work = f.work.getWork(work.workItemId, "alice", "team-a");
    const changedSubject = "workspace:" + "e".repeat(64);
    f.work.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, changedSubject, 140);
    assert.equal(f.work.listEvidence(work.workItemId).find((item) => item.type === "artifact")?.stale, true);
    assert.throws(
      () =>
        f.orchestrator.recordPreparedPublicationArtifact(
          work.workItemId,
          "alice",
          "team-a",
          publication.publicationId,
          150,
        ),
      /PUBLICATION_SOURCE_STALE/,
    );
    assert.equal(f.publications.getPublication(publication.publicationId).state, "blocked");
  } finally {
    f.close();
  }
});

test("publication approval validates the exact prepared artifact and does not act like work_completion", () => {
  const f = fixture();
  try {
    let work = f.work.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "publication-approval",
      sourceType: "mcp",
      title: "Publication approval",
      description: "approve exact publication artifact",
    });
    const attempt = f.work.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = f.work.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "b".repeat(40),
    });
    work = f.work.getWork(work.workItemId, "alice", "team-a");
    const source = "workspace:" + "a".repeat(64);
    work = f.work.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, source, 100);
    const publication = f.publications.createOrReusePublication(
      {
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workspaceId: workspace.workspaceId,
        sourceSubjectRevision: source,
        baseCommit: "b".repeat(40),
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 1,
        branchName: "skillhub/work/work-a1",
        pushRemoteName: "origin",
        pushRefspec: "c".repeat(40) + ":refs/heads/skillhub/work/work-a1",
        ownerWorkerId: "worker-a",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "Publish\n",
      },
      110,
    );
    const prepared = f.publications.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
      },
      120,
    );
    const publicationSubject = "publication:" + prepared.publicationId + ":" + prepared.commitSha;
    work = f.work.getWork(work.workItemId, "alice", "team-a");

    const detail = f.orchestrator.submitApproval(
      work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: work.stateRevision,
        subjectRevision: publicationSubject,
        approvalScope: "publish_work_branch",
        decision: "approved",
      },
      { actor: "alice", role: "developer" },
      130,
    );
    assert.equal(f.publications.getPublication(publication.publicationId).state, "approved");
    assert.equal(detail.work.status, work.status, "publication approval must not complete Work by itself");
    const stored = f.work.listApprovals(work.workItemId).at(-1)!;
    assert.equal(stored.approvalScope, "publish_work_branch");
    assert.equal(stored.subjectType, "publication_artifact");

    const current = f.work.getWork(work.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        f.orchestrator.submitApproval(
          work.workItemId,
          "alice",
          "team-a",
          {
            expectedRevision: current.stateRevision,
            subjectRevision: "publication:" + publication.publicationId + ":" + "e".repeat(40),
            approvalScope: "publish_work_branch",
            decision: "approved",
          },
          { actor: "alice", role: "developer" },
          140,
        ),
      /PUBLICATION_APPROVAL_STALE|INVALID_WORK_APPROVAL/,
    );
  } finally {
    f.close();
  }
});

test("ensurePublication creates an owner-affine prepared-work command only after accepted current review", () => {
  const f = fixture();
  try {
    const modelConfig = {
      providerId: "router",
      model: "model",
      baseUrl: "https://router.example/v1",
      wireApi: "responses" as const,
      allowedEnvNames: ["OPENAI_API_KEY"],
    };
    f.experts.putDeployment({
      id: "ota-publish",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.test/ota.git",
          branch: "main",
          credentialRef: "publish-ref",
          publicationPolicy: {
            version: 4,
            permissions: ["prepare-commit", "push-work-branch"],
            branchPrefix: "skillhub/work/",
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
      executor: { backend: "codex", modelConfig },
    });
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow("publish-ready", 1, {
      ...structuredClone(base),
      execution: {
        ...structuredClone(base.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
      completion: {
        require: [...base.completion.require, "required_approvals_approved"],
        requiredApprovals: [{ scope: "work_completion", subjectType: "workspace_revision" }],
      },
    });

    const submitted = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "ensure-publication",
      workflowId: "publish-ready",
      deploymentId: "ota-publish",
    });
    const attempt = submitted.attempts[0]!;
    const workspace = f.work.getWorkspace(attempt.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      1100,
      "b".repeat(40),
    );
    const claim = f.tasks.claim("worker-a", 1000, 30_000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-workspace-write"],
    })!;
    const summary = {
      baseCommit: "b".repeat(40),
      changedFiles: ["README.md"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      contentRevision: "a".repeat(64),
    };
    f.tasks.complete(claim, "changed", 2000, { commitSha: summary.baseCommit }, undefined, summary);
    const waiting = f.orchestrator.reconcileWork(submitted.work.workItemId, "alice", "team-a", 2100);
    assert.equal(waiting.work.status, "waiting_review");
    assert.throws(
      () => f.orchestrator.ensurePublication(waiting.work.workItemId, "alice", "team-a", 2200),
      /PUBLICATION_REVIEW_REQUIRED/,
    );
    const reviewed = f.orchestrator.submitReview(waiting.work.workItemId, "alice", "team-a", {
      expectedRevision: waiting.work.stateRevision,
      subjectRevision: "workspace:" + summary.contentRevision,
      decision: "accepted",
    });
    assert.equal(reviewed.work.status, "waiting_review");

    const publication = f.orchestrator.ensurePublication(reviewed.work.workItemId, "alice", "team-a", 2300);
    assert.equal(publication.state, "preparing");
    assert.equal(publication.ownerWorkerId, "worker-a");
    assert.equal(publication.branchName, "skillhub/work/" + reviewed.work.workItemId.split("-")[0] + "-a1");
    assert.equal(publication.pushRefspec, null);
    assert.equal(publication.executionSnapshot?.repositoryUrl, "https://example.test/ota.git");
    assert.equal(publication.executionSnapshot?.credentialRef, "publish-ref");
    assert.equal(publication.executionSnapshot?.expectedContentRevision, summary.contentRevision);
    assert.deepEqual(publication.executionSnapshot?.approvedChangeSummary, summary);

    f.experts.putDeployment({
      ...f.experts.getDeployment("ota-publish"),
      repositories: [
        {
          ...f.experts.getDeployment("ota-publish").repositories![0]!,
          publicationPolicy: {
            ...f.experts.getDeployment("ota-publish").repositories![0]!.publicationPolicy!,
            version: 99,
            branchPrefix: "changed/",
          },
        },
      ],
    });
    const replay = f.orchestrator.ensurePublication(reviewed.work.workItemId, "alice", "team-a", 2400);
    assert.equal(replay.publicationId, publication.publicationId);
    assert.equal(replay.publicationPolicyRevision, 4);
    assert.equal(replay.branchName, publication.branchName);
  } finally {
    f.close();
  }
});

test("publication-required workflow automatically prepares, pushes evidence, and completes only after exact approval", () => {
  const f = fixture(() => true);
  try {
    const modelConfig = {
      providerId: "router",
      model: "model",
      baseUrl: "https://router.example/v1",
      wireApi: "responses" as const,
      allowedEnvNames: ["OPENAI_API_KEY"],
    };
    f.experts.putDeployment({
      id: "ota-auto-publish",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.test/ota.git",
          branch: "main",
          publicationPolicy: {
            version: 5,
            permissions: ["prepare-commit", "push-work-branch"],
            branchPrefix: "skillhub/work/",
            protectedBranches: ["main"],
            allowedPushRemote: "origin",
            credentialRef: "publish-ref",
            allowForcePush: false,
            allowDeleteRef: false,
          },
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
      executor: { backend: "codex", modelConfig },
    });
    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow("auto-publication", 1, {
      ...structuredClone(base),
      execution: {
        ...structuredClone(base.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
      publication: { required: true, mode: "work_branch" },
      completion: {
        require: [
          ...base.completion.require.filter((item) => item !== "change_request_created"),
          "required_approvals_approved",
          "publication_succeeded",
        ],
        requiredApprovals: [{ scope: "publish_work_branch", subjectType: "publication_artifact" }],
      },
    });

    const submitted = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "auto-publication",
      workflowId: "auto-publication",
      deploymentId: "ota-auto-publish",
    });
    const attempt = submitted.attempts[0]!;
    const workspace = f.work.getWorkspace(attempt.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      1100,
      "b".repeat(40),
    );
    const claim = f.tasks.claim("worker-a", 1000, 30_000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-workspace-write"],
    })!;
    const summary = {
      baseCommit: "b".repeat(40),
      changedFiles: ["README.md"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      contentRevision: "a".repeat(64),
    };
    f.tasks.complete(claim, "changed", 2000, { commitSha: summary.baseCommit }, undefined, summary);
    let detail = f.orchestrator.reconcileWork(submitted.work.workItemId, "alice", "team-a", 2100);
    assert.equal(detail.work.status, "waiting_review");

    detail = f.orchestrator.submitReview(
      detail.work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: detail.work.stateRevision,
        subjectRevision: "workspace:" + summary.contentRevision,
        decision: "accepted",
      },
      2200,
    );
    assert.equal(detail.work.status, "waiting_review");
    let publication = f.publications.listPublications(detail.work.workItemId).at(-1)!;
    assert.equal(publication.state, "preparing");
    assert.equal(publication.executionSnapshot?.workspacePath, "/srv/workspaces/" + workspace.workspaceKey);

    const prepare = f.publications.claimPublicationOperation("worker-a", 2300, 30_000)!;
    f.publications.completePublicationOperation(
      prepare,
      {
        success: true,
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      2400,
    );
    detail = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 2500);
    assert.equal(detail.work.status, "waiting_review");
    assert.equal(
      f.work
        .listEvidence(detail.work.workItemId)
        .some((e) => e.type === "artifact" && e.artifactRef === "publication:" + publication.publicationId && !e.stale),
      true,
    );

    publication = f.publications.getPublication(publication.publicationId);
    const publicationSubject = "publication:" + publication.publicationId + ":" + publication.commitSha;
    detail = f.orchestrator.submitApproval(
      detail.work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: detail.work.stateRevision,
        subjectRevision: publicationSubject,
        approvalScope: "publish_work_branch",
        decision: "approved",
      },
      { actor: "alice", role: "developer" },
      2600,
    );
    assert.equal(f.publications.getPublication(publication.publicationId).state, "approved");
    assert.equal(detail.work.status, "waiting_review");

    const push = f.publications.claimPublicationOperation("worker-a", 2700, 30_000)!;
    assert.equal(push.operation, "push");
    f.publications.completePublicationOperation(push, { success: true }, 2800);

    detail = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 2900);
    assert.equal(detail.work.status, "completed");
    const publicationEvidence = f.work
      .listEvidence(detail.work.workItemId)
      .find((e) => e.type === "publication" && !e.stale);
    assert.equal(publicationEvidence?.status, "passed");
    assert.equal(publicationEvidence?.subjectRevision, publicationSubject);
    assert.equal(publicationEvidence?.artifactRef, "publication:" + publication.publicationId);
    assert.equal(detail.gate.ready, true);
    assert.deepEqual(detail.gate.missing, []);
  } finally {
    f.close();
  }
});
test("pushed publication recovers into a durable change request and completes after verified PR evidence", () => {
  const f = fixture(() => true, true);
  try {
    const modelConfig = {
      providerId: "router",
      model: "model",
      baseUrl: "https://router.example/v1",
      wireApi: "responses" as const,
      allowedEnvNames: ["OPENAI_API_KEY"],
    };
    f.experts.putDeployment({
      id: "ota-change-request",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://github.com/example/project.git",
          branch: "main",
          credentialRef: "publish-token",
          publicationPolicy: {
            version: 7,
            permissions: ["prepare-commit", "push-work-branch", "create-change-request"],
            branchPrefix: "tsh/",
            protectedBranches: ["main"],
            allowedPushRemote: "origin",
            allowForcePush: false,
            allowDeleteRef: false,
          },
          verificationPolicy: {
            version: 1,
            required: [
              {
                id: "build",
                type: "command",
                argv: ["sh", "-lc", "true"],
                timeoutMs: 60_000,
                evidenceType: "build",
              },
              {
                id: "unit-test",
                type: "command",
                argv: ["sh", "-lc", "true"],
                timeoutMs: 60_000,
                evidenceType: "unit_test",
              },
            ],
          },
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
      executor: { backend: "codex", modelConfig },
    });

    const base = f.work.getWorkflow("code-fix-default").definition;
    f.work.putWorkflow("change-request-publication", 1, {
      ...structuredClone(base),
      execution: {
        ...structuredClone(base.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
      change: { mode: "code_change", delivery: "merge_request" },
      validation: {
        requiredEvidence: ["expert_result", "build", "unit_test"],
        required: [],
      },
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
    });
    const submitted = f.orchestrator.submitWork({
      ...submission,
      idempotencyKey: "change-request-publication",
      workflowId: "change-request-publication",
      deploymentId: "ota-change-request",
    });
    const attempt = submitted.attempts[0]!;
    const workspace = f.work.getWorkspace(attempt.workspaceId!);
    f.work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      1100,
      "b".repeat(40),
    );

    const claim = f.tasks.claim("worker-a", 1000, 30_000, "ota", {
      backend: "codex",
      runtimeProfiles: ["codex-workspace-write"],
    })!;
    const summary = {
      baseCommit: "b".repeat(40),
      changedFiles: ["README.md"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      contentRevision: "a".repeat(64),
    };
    const subject = "workspace:" + summary.contentRevision;
    f.tasks.complete(
      claim,
      "changed",
      2000,
      { commitSha: summary.baseCommit },
      [
        {
          stepId: "build",
          type: "command",
          evidenceType: "build",
          status: "passed",
          exitCode: 0,
          durationMs: 10,
          errorCode: null,
          subjectRevision: subject,
          environmentIdentity: "worker:worker-a",
          verifierIdentity: "team-skill-hub-worker",
        },
        {
          stepId: "unit-test",
          type: "command",
          evidenceType: "unit_test",
          status: "passed",
          exitCode: 0,
          durationMs: 10,
          errorCode: null,
          subjectRevision: subject,
          environmentIdentity: "worker:worker-a",
          verifierIdentity: "team-skill-hub-worker",
        },
      ],
      summary,
    );

    let detail = f.orchestrator.reconcileWork(submitted.work.workItemId, "alice", "team-a", 2100);
    assert.equal(detail.work.status, "waiting_review");
    detail = f.orchestrator.submitReview(
      detail.work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: detail.work.stateRevision,
        subjectRevision: subject,
        decision: "accepted",
      },
      2200,
    );

    let publication = f.publications.listPublications(detail.work.workItemId).at(-1)!;
    const prepare = f.publications.claimPublicationOperation("worker-a", 2300, 30_000)!;
    f.publications.completePublicationOperation(
      prepare,
      {
        success: true,
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      2400,
    );
    detail = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 2500);
    publication = f.publications.getPublication(publication.publicationId);
    assert.equal(publication.state, "approved");

    const push = f.publications.claimPublicationOperation("worker-a", 2600, 30_000)!;
    f.publications.completePublicationOperation(push, { success: true }, 2700);

    detail = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 2800);
    assert.equal(detail.work.status, "waiting_review");
    assert.equal(detail.changeRequest?.state, "pending");
    assert.equal(detail.changeRequest?.provider, null);

    const changeClaim = f.changeRequests!.claim("worker-a", 2900, 30_000)!;
    assert.equal(changeClaim.headBranch, publication.branchName);
    assert.equal(changeClaim.headCommit, "c".repeat(40));
    f.changeRequests!.complete(
      changeClaim,
      {
        success: true,
        provider: "github",
        externalId: "17",
        url: "https://github.com/example/project/pull/17",
        headCommit: "c".repeat(40),
        baseBranch: "main",
      },
      3000,
    );

    detail = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3100);
    assert.equal(detail.work.status, "completed");
    assert.equal(detail.changeRequest?.state, "created");
    assert.equal(detail.changeRequest?.url, "https://github.com/example/project/pull/17");
    const prEvidence = detail.evidence.find((e) => e.type === "pull_request" && !e.stale);
    assert.equal(prEvidence?.status, "passed");
    assert.equal(prEvidence?.source, "external_verified");
    assert.equal(prEvidence?.subjectRevision, "publication:" + publication.publicationId + ":" + "c".repeat(40));
    assert.equal(prEvidence?.artifactRef, "change-request:github:17");
    assert.equal(detail.gate.ready, true);
  } finally {
    f.close();
  }
});
