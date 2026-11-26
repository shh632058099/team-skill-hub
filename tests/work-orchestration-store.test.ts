import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkPublicationStore } from "../src/expert-platform/work-publication-store.js";

function withStore(run: (store: WorkOrchestrationStore, file: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const store = new WorkOrchestrationStore(file);
    run(store, file);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("workflow list exposes all versioned definitions in stable order", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("z-workflow", 1, structuredClone(base));
    store.putWorkflow("z-workflow", 2, structuredClone(base));
    const rows = store.listWorkflows().filter((item) => item.workflowId === "z-workflow");
    assert.deepEqual(
      rows.map((item) => item.version),
      [2, 1],
    );
  });
});

test("platform presets preserve history and publish stricter development and readonly workflows", () => {
  withStore((store) => {
    for (const id of [
      "investigation",
      "code-review",
      "bug-fix",
      "feature-change",
      "refactor",
      "test-improvement",
      "build-fix",
      "release-change",
    ]) {
      assert.equal(store.getWorkflow(id, 1).version, 1);
    }

    for (const id of ["bug-fix", "feature-change", "refactor", "test-improvement", "build-fix", "release-change"]) {
      assert.equal(store.getWorkflow(id, 2).version, 2);
      assert.equal(store.getWorkflow(id, 3).version, 3);
      assert.equal(store.getWorkflow(id).version, 4);
      const workflow = store.getWorkflow(id).definition;
      assert.equal(workflow.graph.mode, "dynamic-dag");
      assert.ok(workflow.planning?.replanPolicy.includes("always_after_agent_turn"));
      assert.deepEqual(workflow.change, { mode: "code_change", delivery: "merge_request" });
      assert.ok(workflow.validation.requiredEvidence.includes("build"));
      assert.ok(workflow.validation.requiredEvidence.includes("unit_test"));
      assert.equal(workflow.review.required, true);
      assert.equal(workflow.publication?.required, true);
      assert.equal(workflow.publication?.approvalRequired, false);
      assert.ok(workflow.completion.require.includes("publication_succeeded"));
      assert.ok(workflow.completion.require.includes("change_request_created"));
      assert.equal(workflow.completion.require.includes("required_approvals_approved"), false);
    }

    for (const id of ["investigation", "code-review"]) {
      assert.equal(store.getWorkflow(id, 2).version, 2);
      assert.equal(store.getWorkflow(id, 3).version, 3);
      assert.equal(store.getWorkflow(id).version, 4);
      const workflow = store.getWorkflow(id).definition;
      assert.deepEqual(workflow.change, { mode: "readonly" });
      assert.equal(workflow.review.required, false);
      assert.equal(workflow.completion.require.includes("review_accepted"), false);
    }

    const reviewFixVerify = store.getWorkflow("review-fix-verify");
    assert.equal(reviewFixVerify.version, 1);
    assert.equal(reviewFixVerify.definition.graph.mode, "dynamic-dag");
    assert.deepEqual(reviewFixVerify.definition.change, { mode: "conditional_code_change" });
    assert.equal(reviewFixVerify.definition.review.required, true);
    assert.equal(reviewFixVerify.definition.review.reviewerExpertId, undefined);
    assert.deepEqual(reviewFixVerify.definition.validation.requiredEvidence, ["build", "unit_test"]);
    assert.equal(reviewFixVerify.definition.publication?.required, false);
    assert.match(reviewFixVerify.definition.selection?.summary ?? "", /review.*fix.*verify/i);
  });
});

test("selectable workflow catalog exposes latest semantic metadata and preserves legacy custom workflows", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("custom-legacy", 1, structuredClone(base));
    store.putWorkflow("custom-semantic", 1, {
      ...structuredClone(base),
      selection: {
        summary: "First custom meaning",
        useWhen: ["first version"],
        notWhen: ["second version"],
      },
    } as typeof base);
    store.putWorkflow("custom-semantic", 2, {
      ...structuredClone(base),
      selection: {
        summary: "Optimize latency without changing external behavior",
        useWhen: ["performance optimization is the primary requested outcome"],
        notWhen: ["the user is asking to add a new feature"],
      },
    } as typeof base);

    const catalog = store.listSelectableWorkflows();

    assert.equal(
      catalog.some((item) => item.workflowId === "code-fix-default"),
      false,
    );
    assert.equal(catalog.filter((item) => item.workflowId === "custom-semantic").length, 1);

    const investigation = catalog.find((item) => item.workflowId === "investigation");
    assert.equal(investigation?.version, 4);
    assert.equal(investigation?.changeMode, "readonly");
    assert.equal(investigation?.selectionConfigured, true);
    assert.match(investigation?.summary ?? "", /readonly analysis/i);

    const bugFix = catalog.find((item) => item.workflowId === "bug-fix");
    assert.equal(bugFix?.version, 4);
    assert.equal(bugFix?.changeMode, "code_change");
    assert.equal(bugFix?.selectionConfigured, true);
    assert.match(bugFix?.summary ?? "", /incorrect existing/i);

    const custom = catalog.find((item) => item.workflowId === "custom-semantic");
    assert.equal(custom?.version, 2);
    assert.equal(custom?.summary, "Optimize latency without changing external behavior");
    assert.deepEqual(custom?.useWhen, ["performance optimization is the primary requested outcome"]);

    const legacy = catalog.find((item) => item.workflowId === "custom-legacy");
    assert.equal(legacy?.selectionConfigured, false);
    assert.equal(legacy?.changeMode, base.change?.mode ?? null);
    assert.deepEqual(legacy?.useWhen, []);
    assert.deepEqual(legacy?.notWhen, []);
  });
});

test("every newly created Work binds to dynamic DAG even when the selected Workflow is legacy single-node", () => {
  withStore((store) => {
    const workflow = store.getWorkflow("investigation");
    assert.equal(workflow.definition.graph.mode, "single-node");
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "full-cutover-new-work",
      sourceType: "mcp",
      title: "Investigate",
      description: "inspect the current state",
      workflowId: "investigation",
    });
    assert.equal(work.orchestrationEngine, "dynamic-dag");
  });
});

test("manual DAG replan is available to every post-cutover Work regardless of Workflow graph mode", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "full-cutover-manual-replan",
      sourceType: "mcp",
      title: "Investigate",
      description: "inspect then reconsider the plan",
      workflowId: "investigation",
    });
    store.ensureRequirementSnapshot(work.workItemId);
    const current = store.getWorkInternal(work.workItemId);
    const request = store.requestDagReplan(
      work.workItemId,
      "alice",
      "team-a",
      current.stateRevision,
      "user requested a new plan",
      100,
    );
    assert.equal(request.state, "pending");
  });
});

test("reopen backfills pre-cutover Work as legacy while all post-cutover Work is dynamic", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-engine-cutover-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    const oldWork = initial.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "pre-cutover-work",
      sourceType: "mcp",
      title: "Old work",
      description: "persisted before engine cutover",
      workflowId: "investigation",
    });
    initial.close();

    const legacyDb = new DatabaseSync(file);
    const columns = new Set(
      (legacyDb.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (columns.has("orchestration_engine")) {
      legacyDb.exec("ALTER TABLE work_items DROP COLUMN orchestration_engine");
    }
    legacyDb.close();

    const reopened = new WorkOrchestrationStore(file);
    assert.equal(reopened.getWorkInternal(oldWork.workItemId).orchestrationEngine, "legacy-single-node");
    const newWork = reopened.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "post-cutover-work",
      sourceType: "mcp",
      title: "New work",
      description: "created after engine cutover",
      workflowId: "investigation",
    });
    assert.equal(newWork.orchestrationEngine, "dynamic-dag");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing runtime database backfills new built-in workflow versions on reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-upgrade-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    assert.equal(initial.getWorkflow("investigation").version, 4);
    assert.equal(initial.getWorkflow("bug-fix").version, 4);
    initial.close();

    const legacyDb = new DatabaseSync(file);
    legacyDb.exec(
      [
        "DELETE FROM work_workflows WHERE workflow_id IN ('investigation','code-review') AND version=4;",
        "DELETE FROM work_workflows WHERE workflow_id IN ('bug-fix','feature-change','refactor','test-improvement','build-fix','release-change') AND version=4;",
      ].join("\n"),
    );
    legacyDb.close();

    const reopened = new WorkOrchestrationStore(file);
    assert.equal(reopened.getWorkflow("investigation", 3).version, 3);
    assert.equal(reopened.getWorkflow("investigation").version, 4);
    assert.equal(reopened.getWorkflow("bug-fix", 2).version, 2);
    assert.equal(reopened.getWorkflow("bug-fix", 3).version, 3);
    assert.equal(reopened.getWorkflow("bug-fix").version, 4);
    const catalog = reopened.listSelectableWorkflows();
    assert.equal(catalog.find((item) => item.workflowId === "investigation")?.version, 4);
    assert.equal(catalog.find((item) => item.workflowId === "bug-fix")?.version, 4);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow selection metadata rejects malformed semantic guidance", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    assert.throws(
      () =>
        store.putWorkflow("bad-selection", 1, {
          ...structuredClone(base),
          selection: {
            summary: " ",
            useWhen: ["valid"],
            notWhen: [],
          },
        } as typeof base),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("bad-selection-array", 1, {
          ...structuredClone(base),
          selection: {
            summary: "Valid summary",
            useWhen: [""],
            notWhen: [],
          },
        } as typeof base),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("bad-selection-summary-length", 1, {
          ...structuredClone(base),
          selection: {
            summary: "x".repeat(501),
            useWhen: [],
            notWhen: [],
          },
        } as typeof base),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("bad-selection-count", 1, {
          ...structuredClone(base),
          selection: {
            summary: "Valid summary",
            useWhen: Array.from({ length: 21 }, (_, index) => `condition-${index}`),
            notWhen: [],
          },
        } as typeof base),
      /INVALID_WORKFLOW/,
    );

    const withUnknownField = {
      ...structuredClone(base),
      selection: {
        summary: "Normalized summary",
        useWhen: ["primary outcome matches"],
        notWhen: ["primary outcome does not match"],
        internalNote: "must not leak through the catalog",
      },
    } as unknown as typeof base;
    store.putWorkflow("normalized-selection", 1, withUnknownField);
    const normalizedSelection = store.getWorkflow("normalized-selection").definition.selection;
    assert.ok(normalizedSelection);
    assert.equal("internalNote" in (normalizedSelection as object), false);
  });
});
test("workflow selection prefers explicit then repository default then platform default", () => {
  withStore((store) => {
    store.putRepositoryWorkflowDefault("repo-a", "investigation", 100);
    assert.equal(store.getRepositoryWorkflowDefault("repo-a"), "investigation");
    assert.deepEqual(store.listRepositoryWorkflowDefaults(), [
      { repositoryId: "repo-a", workflowId: "investigation", updatedAt: 100 },
    ]);

    const repositoryDefault = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "repo-default-workflow",
      sourceType: "mcp",
      title: "Investigate",
      description: "use repository default",
      repositoryId: "repo-a",
    });
    assert.equal(repositoryDefault.workflowId, "investigation");

    const explicit = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "explicit-workflow",
      sourceType: "mcp",
      title: "Review",
      description: "explicit overrides repository default",
      repositoryId: "repo-a",
      workflowId: "code-review",
    });
    assert.equal(explicit.workflowId, "code-review");

    const fallback = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "platform-default-workflow",
      sourceType: "mcp",
      title: "Fallback",
      description: "use platform default",
      repositoryId: "repo-b",
    });
    assert.equal(fallback.workflowId, "code-fix-default");

    store.deleteRepositoryWorkflowDefault("repo-a");
    assert.equal(store.getRepositoryWorkflowDefault("repo-a"), null);
  });
});

test("work submission is idempotent and conflicting reuse fails closed", () => {
  withStore((store) => {
    const first = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "work-k1",
      sourceType: "mcp",
      title: "Fix OTA recovery",
      description: "Investigate and fix interrupted upgrade recovery",
    });
    const again = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "work-k1",
      sourceType: "mcp",
      title: "Fix OTA recovery",
      description: "Investigate and fix interrupted upgrade recovery",
    });

    assert.equal(again.workItemId, first.workItemId);
    assert.equal(first.reusedExistingWork, false);
    assert.equal(again.reusedExistingWork, true);
    assert.equal(again.deduplicationReason, "idempotency_key");
    assert.throws(
      () =>
        store.createOrReuseWork({
          principalId: "alice",
          scope: "team-a",
          idempotencyKey: "work-k1",
          sourceType: "mcp",
          title: "Different work",
          description: "Different payload",
        }),
      /WORK_IDEMPOTENCY_CONFLICT/,
    );
  });
});

test("workspace identity is deterministic and records owner affinity", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-1",
      sourceType: "mcp",
      title: "Workspace",
      description: "keep one workspace per attempt",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    const first = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "abc123",
    });
    const again = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "abc123",
    });
    assert.equal(again.workspaceId, first.workspaceId);
    assert.equal(again.workspaceKey, first.workspaceKey);
    assert.match(first.workspaceKey, /^work-[a-f0-9-]+-a1$/);
    assert.equal(first.state, "allocating");

    const assigned = store.assignWorkspaceOwner(first.workspaceId, "worker-a", "/srv/work/a");
    assert.equal(assigned.ownerWorkerId, "worker-a");
    assert.equal(assigned.path, "/srv/work/a");
    assert.equal(assigned.state, "ready");
    assert.equal(store.getWorkAttempt(attempt.workAttemptId).workspaceId, first.workspaceId);
  });
});

test("review rework attempt inherits the parent workspace instead of recloning the remote base", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-rework-inherit",
      sourceType: "mcp",
      title: "Workspace rework",
      description: "preserve edits across review rework",
    });
    const firstAttempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    const firstWorkspace = store.ensureWorkspace(work.workItemId, firstAttempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      baseCommit: "a".repeat(40),
    });
    store.assignWorkspaceOwner(firstWorkspace.workspaceId, "worker-a", "/srv/work/a", 100, "a".repeat(40));
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.finishWorkAttempt(
      work.workItemId,
      firstAttempt.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );
    const secondAttempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", current.stateRevision, {
      reason: "review_rework",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
      parentWorkAttemptId: firstAttempt.workAttemptId,
    });
    assert.equal(secondAttempt.workspaceId, firstWorkspace.workspaceId);
    const inherited = store.getWorkspaceForResource(secondAttempt.workAttemptId, "workspace");
    assert.equal(inherited?.workspaceId, firstWorkspace.workspaceId);
    assert.equal(inherited?.workspaceKey, firstWorkspace.workspaceKey);
    assert.equal(inherited?.path, "/srv/work/a");
  });
});

test("review rework inherits parent resource workspaces while unrelated attempts do not", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-resource-rework-inherit",
      sourceType: "mcp",
      title: "Resource workspace rework",
      description: "preserve multi-resource edits",
      repositoryId: "repo-a",
    });
    const firstAttempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "multi",
      deploymentId: "multi-write",
      deploymentConfigVersion: 1,
    });
    const repoB = store.ensureWorkspace(work.workItemId, firstAttempt.workAttemptId, {
      resourceKey: "repo:repo-b",
      repositoryId: "repo-b",
      repositoryUrl: "https://example.test/repo-b.git",
      branch: "main",
      baseCommit: "b".repeat(40),
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.finishWorkAttempt(
      work.workItemId,
      firstAttempt.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );
    const secondAttempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", current.stateRevision, {
      reason: "review_rework",
      expertId: "multi",
      deploymentId: "multi-write",
      deploymentConfigVersion: 1,
      parentWorkAttemptId: firstAttempt.workAttemptId,
    });
    assert.equal(
      store.getWorkspaceForResource(secondAttempt.workAttemptId, "repo:repo-b")?.workspaceId,
      repoB.workspaceId,
    );

    current = store.finishWorkAttempt(
      work.workItemId,
      secondAttempt.workAttemptId,
      "alice",
      "team-a",
      store.getWorkInternal(work.workItemId).stateRevision,
      "succeeded",
      "running",
    );
    const independent = store.createWorkAttempt(work.workItemId, "alice", "team-a", current.stateRevision, {
      reason: "policy_replan",
      expertId: "multi",
      deploymentId: "multi-write",
      deploymentConfigVersion: 1,
    });
    assert.equal(store.getWorkspaceForResource(independent.workAttemptId, "repo:repo-b"), null);
  });
});

test("terminal workspace cleanup is durable, owner-scoped and fenced", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-cleanup",
      sourceType: "mcp",
      title: "cleanup",
      description: "cleanup",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
      cleanupPolicy: "on_terminal",
    });
    store.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      100,
      "a".repeat(40),
    );

    store.requestTerminalWorkspaceCleanup(work.workItemId, 200);
    assert.equal(store.getWorkspace(workspace.workspaceId).state, "cleaning");
    assert.equal(store.claimWorkspaceCleanup("worker-b", 300, 30_000), null);
    const cleanup = store.claimWorkspaceCleanup("worker-a", 300, 30_000)!;
    assert.equal(cleanup.workspaceId, workspace.workspaceId);
    assert.equal(cleanup.workspaceKey, workspace.workspaceKey);
    assert.equal(cleanup.fencing, 1);

    store.completeWorkspaceCleanup(cleanup.workspaceId, "worker-a", cleanup.fencing, true, null, 400);
    assert.equal(store.getWorkspace(workspace.workspaceId).state, "removed");
    assert.throws(
      () => store.completeWorkspaceCleanup(cleanup.workspaceId, "worker-a", cleanup.fencing, true, null, 500),
      /STALE_WORKSPACE_CLEANUP/,
    );
  });
});

test("retain workspace policy does not enqueue deletion", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-retain",
      sourceType: "mcp",
      title: "retain",
      description: "retain",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      cleanupPolicy: "retain",
    });
    store.requestTerminalWorkspaceCleanup(work.workItemId, 200);
    assert.equal(store.getWorkspace(workspace.workspaceId).state, "retained");
    assert.equal(store.claimWorkspaceCleanup("worker-a", 300, 30_000), null);
  });
});

test("approval schema migrates legacy databases with attempt binding column", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-approval-migration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    initial.close();
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec(
        [
          "DROP TABLE work_approvals;",
          "CREATE TABLE work_approvals (",
          " approval_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL,",
          " approval_scope TEXT NOT NULL, subject_type TEXT NOT NULL, subject_revision TEXT NOT NULL,",
          " decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)), created_at INTEGER NOT NULL",
          ");",
        ].join("\n"),
      );
    } finally {
      legacy.close();
    }

    const reopened = new WorkOrchestrationStore(file);
    const db = new DatabaseSync(file);
    try {
      const columns = db.prepare("PRAGMA table_info(work_approvals)").all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "work_attempt_id"));
    } finally {
      db.close();
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source observation schema is added to existing runtime databases without reset", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "source-observation-schema-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    initial.close();
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec("DROP TABLE work_source_observations;");
    } finally {
      legacy.close();
    }
    const reopened = new WorkOrchestrationStore(file);
    const db = new DatabaseSync(file);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_source_observations'")
        .all();
      assert.equal(tables.length, 1);
      const columns = db.prepare("PRAGMA table_info(work_source_observations)").all() as Array<{ name: string }>;
      for (const name of [
        "observation_id",
        "work_item_id",
        "state",
        "fingerprint",
        "reconciliation_action",
        "reconciled_at",
      ]) {
        assert.ok(
          columns.some((column) => column.name === name),
          `missing source observation column ${name}`,
        );
      }
    } finally {
      db.close();
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source request dedup columns and index migrate after legacy work_items schema", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "source-request-schema-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    initial.close();

    const legacy = new DatabaseSync(file);
    try {
      legacy.exec("DROP INDEX IF EXISTS idx_work_source_request;");
      legacy.exec("ALTER TABLE work_items DROP COLUMN source_request_slot;");
      legacy.exec("ALTER TABLE work_items DROP COLUMN source_request_id;");
    } finally {
      legacy.close();
    }

    const reopened = new WorkOrchestrationStore(file);
    const db = new DatabaseSync(file);
    try {
      const columns = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "source_request_id"));
      assert.ok(columns.some((column) => column.name === "source_request_slot"));
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_work_source_request'")
        .all();
      assert.equal(indexes.length, 1);
    } finally {
      db.close();
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy single source control capability migrates into multi-token storage", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "source-control-migration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    const work = initial.createOrReuseWork(
      {
        principalId: "alice",
        scope: "team-a",
        idempotencyKey: "source-control-migration",
        sourceType: "mcp",
        title: "migration",
        description: "migration",
      },
      1000,
    );
    initial.close();

    const legacy = new DatabaseSync(file);
    try {
      legacy.exec("DROP TABLE IF EXISTS work_source_control_tokens;");
      legacy
        .prepare("INSERT OR REPLACE INTO work_source_controls(work_item_id,token_hash,rotated_at) VALUES(?,?,?)")
        .run(work.workItemId, "a".repeat(64), 2000);
    } finally {
      legacy.close();
    }

    const reopened = new WorkOrchestrationStore(file);
    try {
      assert.equal(reopened.hasSourceControlTokenHash(work.workItemId, "a".repeat(64), 2001), true);
      assert.equal(
        reopened.hasSourceControlTokenHash(work.workItemId, "a".repeat(64), 2000 + 30 * 24 * 60 * 60 * 1000 + 1),
        false,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace schema migrates old cleanup constraints without resetting the database", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-workspace-migration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    initial.close();

    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("DROP TABLE IF EXISTS work_workspace_cleanup_requests");
    db.exec("DROP TABLE work_workspaces");
    db.exec(
      [
        "CREATE TABLE work_workspaces (",
        " workspace_id TEXT PRIMARY KEY,",
        " workspace_key TEXT NOT NULL UNIQUE,",
        " work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        " work_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        " owner_worker_id TEXT, path TEXT, repository_url TEXT, branch TEXT, base_commit TEXT,",
        " state TEXT NOT NULL CHECK(state IN ('ready','in_use','retained','removed','failed')),",
        " cleanup_policy TEXT NOT NULL CHECK(cleanup_policy='on_terminal'),",
        " created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL",
        ");",
      ].join("\n"),
    );
    db.close();

    const migrated = new WorkOrchestrationStore(file);
    const work = migrated.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-migration",
      sourceType: "mcp",
      title: "migration",
      description: "migration",
    });
    const attempt = migrated.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = migrated.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      cleanupPolicy: "retain",
    });
    migrated.requestTerminalWorkspaceCleanup(work.workItemId, 100);
    assert.equal(migrated.getWorkspace(workspace.workspaceId).state, "retained");
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrated default workspace inherits Work repository identity when re-ensured without repository input", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-workspace-repository-migration-"));
  const file = path.join(dir, "runtime.db");
  try {
    const initial = new WorkOrchestrationStore(file);
    const work = initial.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workspace-repository-migration",
      sourceType: "mcp",
      title: "migration",
      description: "migration",
      repositoryId: "repo-primary",
    });
    const attempt = initial.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    initial.close();

    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("DROP TABLE IF EXISTS work_workspace_cleanup_requests");
    db.exec("DROP TABLE work_workspaces");
    db.exec(
      [
        "CREATE TABLE work_workspaces (",
        " workspace_id TEXT PRIMARY KEY,",
        " workspace_key TEXT NOT NULL UNIQUE,",
        " work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        " work_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        " owner_worker_id TEXT, path TEXT, repository_url TEXT, branch TEXT, base_commit TEXT,",
        " state TEXT NOT NULL CHECK(state IN ('ready','in_use','retained','removed','failed')),",
        " cleanup_policy TEXT NOT NULL CHECK(cleanup_policy='on_terminal'),",
        " created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL",
        ");",
      ].join("\n"),
    );
    db.prepare(
      "INSERT INTO work_workspaces(workspace_id,workspace_key,work_item_id,work_attempt_id,state,cleanup_policy,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      "legacy-workspace",
      "work-" + work.workItemId.toLowerCase() + "-a1",
      work.workItemId,
      attempt.workAttemptId,
      "ready",
      "on_terminal",
      10,
      10,
    );
    db.close();

    const migrated = new WorkOrchestrationStore(file);
    const restored = migrated.ensureWorkspace(work.workItemId, attempt.workAttemptId, {});
    assert.equal(restored.workspaceId, "legacy-workspace");
    assert.equal(restored.resourceKey, "workspace");
    assert.equal(restored.repositoryId, "repo-primary");
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence is revision-bound and becomes stale after the work subject changes", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "evidence-1",
      sourceType: "mcp",
      title: "Evidence",
      description: "bind proof to a revision",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "abc123");
    const evidence = store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "expert_result",
      status: "passed",
      source: "worker_verified",
      subjectRevision: "abc123",
      environmentIdentity: "worker-a/runtime-v1",
      verifierIdentity: "team-skill-hub@1",
      summary: "expert result captured",
    });
    assert.equal(evidence.stale, false);
    assert.equal(evidence.subjectRevision, "abc123");

    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "def456");
    const stale = store.listEvidence(work.workItemId);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.stale, true);
    assert.equal(current.currentSubjectRevision, "def456");
    const staleEvents = store
      .listEvents(work.workItemId)
      .events.filter((event) => event.eventType === "evidence.staled");
    assert.equal(staleEvents.length, 1);
    assert.equal(staleEvents[0]!.details?.count, 1);
  });
});

test("review and approval reject stale subject revisions", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "review-1",
      sourceType: "mcp",
      title: "Review",
      description: "review current revision only",
    });
    let current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, "abc123");
    const review = store.submitReviewDecision(work.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      subjectRevision: "abc123",
      decision: "accepted",
      reason: "looks good",
    });
    assert.equal(review.decision, "accepted");
    current = store.getWork(work.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        store.recordApproval(work.workItemId, "alice", "team-a", {
          expectedRevision: current.stateRevision,
          actor: "owner",
          role: "maintainer",
          approvalScope: "merge",
          subjectType: "source_revision",
          subjectRevision: "old-revision",
          decision: "approved",
        }),
      /INVALID_WORK_APPROVAL/,
    );
  });
});

test("completion gate requires current evidence and accepted review", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "gate-1",
      sourceType: "mcp",
      title: "Gate",
      description: "complete only with proof and review",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 2,
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "abc123");
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "expert_result",
      status: "passed",
      source: "worker_verified",
      subjectRevision: "abc123",
      environmentIdentity: "worker-a/runtime-v1",
      verifierIdentity: "team-skill-hub@1",
    });
    current = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );
    const beforeReview = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(beforeReview.ready, false);
    assert.ok(beforeReview.missing.includes("review_accepted"));

    store.submitReviewDecision(work.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      subjectRevision: "abc123",
      decision: "accepted",
    });
    const afterReview = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(afterReview.ready, true);
    assert.deepEqual(afterReview.missing, []);
  });
});

test("completion gate rejects failed and stale required verification evidence", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("verified-gate", 1, {
      ...base,
      validation: {
        requiredEvidence: ["unit_test"],
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
      review: { required: false },
      completion: {
        require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
      },
    });

    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "gate-verification",
      sourceType: "mcp",
      title: "Verified gate",
      description: "only current passing verification may satisfy the gate",
      workflowId: "verified-gate",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 1,
    });
    let current = store.getWork(work.workItemId, "alice", "team-a");
    current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "rev-a");
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "unit_test",
      status: "failed",
      source: "worker_verified",
      subjectRevision: "rev-a",
    });
    current = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("required_evidence:unit_test"),
    );

    store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, "rev-b");
    const evidence = store.listEvidence(work.workItemId);
    assert.equal(evidence[0]!.stale, true);
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("required_evidence:unit_test"),
    );
  });
});

test("new authoritative verification binding stales older evidence for the same subject", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default", 1).definition;
    store.putWorkflow("binding-stale", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["unit_test"], required: [] },
      review: { required: false },
      completion: {
        require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
      },
    });

    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "binding-stale",
      sourceType: "mcp",
      title: "Verification binding",
      description: "latest authoritative verification context wins",
      workflowId: "binding-stale",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 1,
    });
    work = store.getWork(work.workItemId, "alice", "team-a");
    const subject = "workspace:" + "a".repeat(64);
    work = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, subject);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      runId: "run-a",
      type: "unit_test",
      status: "passed",
      source: "worker_verified",
      subjectRevision: subject,
      environmentIdentity: "worker:one|toolchain:v1",
      verifierIdentity: "team-skill-hub-verifier@1",
    });
    work = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
    );
    assert.equal(store.evaluateCompletionGate(work.workItemId, "alice", "team-a").ready, true);

    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      runId: "run-b",
      type: "unit_test",
      status: "failed",
      source: "worker_verified",
      subjectRevision: subject,
      environmentIdentity: "worker:two|toolchain:v2",
      verifierIdentity: "team-skill-hub-verifier@2",
    });

    const evidence = store.listEvidence(work.workItemId);
    assert.equal(evidence.length, 2);
    assert.equal(evidence[0]!.status, "passed");
    assert.equal(evidence[0]!.stale, true);
    assert.equal(evidence[1]!.status, "failed");
    assert.equal(evidence[1]!.stale, false);
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("required_evidence:unit_test"),
    );
    const staleEvents = store
      .listEvents(work.workItemId)
      .events.filter((event) => event.eventType === "evidence.staled");
    assert.equal(staleEvents.at(-1)?.details?.reason, "verification_binding_superseded");
  });
});

test("stable source identity reuses one work item across delivery retries", () => {
  withStore((store) => {
    const first = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "delivery-1",
      sourceType: "github",
      sourceScope: "openai/symphony",
      sourceRef: "issue-123",
      title: "Tracker issue",
      description: "Implement the requested change",
    });
    const again = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "delivery-2",
      sourceType: "github",
      sourceScope: "openai/symphony",
      sourceRef: "issue-123",
      title: "Tracker issue",
      description: "Implement the requested change",
    });

    assert.equal(again.workItemId, first.workItemId);
    assert.equal(again.deduplicationReason, "source_identity");
  });
});

test("native source request reuses an active Work across regenerated idempotency keys", () => {
  withStore((store) => {
    const common = {
      principalId: "alice",
      scope: "team-a",
      sourceType: "mcp",
      sourceScope: "claude-code/session-1",
      sourceRequestId: "srq_" + "a".repeat(64),
      sourceRequestSlot: JSON.stringify(["explicit", "ota", "repo-a", "deployment-a", "feature-change"]),
      workflowId: "code-fix-default",
      expertId: "ota",
      repositoryId: "repo-a",
      deploymentId: "deployment-a",
    };
    const first = store.createOrReuseWork({
      ...common,
      idempotencyKey: "work-first",
      sourceRef: "work-first",
      title: "Fix OTA rollback",
      description: "First phrasing of the request",
    });
    const replay = store.createOrReuseWork({
      ...common,
      idempotencyKey: "work-second",
      sourceRef: "work-second",
      title: "Repair rollback path",
      description: "Same native user turn, rephrased by the model",
    });

    assert.equal(replay.workItemId, first.workItemId);
    assert.equal(replay.reusedExistingWork, true);
    assert.equal(replay.deduplicationReason, "same_source_request");
    assert.equal(replay.sourceRequestId, common.sourceRequestId);
    assert.equal(replay.sourceRequestSlot, common.sourceRequestSlot);

    const otherSlot = store.createOrReuseWork({
      ...common,
      idempotencyKey: "work-other-slot",
      sourceRef: "work-other-slot",
      sourceRequestSlot: JSON.stringify(["explicit", "ota", "repo-a", "deployment-b", "feature-change"]),
      deploymentId: "deployment-b",
      title: "A distinct explicit delegation",
      description: "Same turn but another deployment slot",
    });
    assert.notEqual(otherSlot.workItemId, first.workItemId);

    const nextTurn = store.createOrReuseWork({
      ...common,
      idempotencyKey: "work-next-turn",
      sourceRef: "work-next-turn",
      sourceRequestId: "srq_" + "b".repeat(64),
      title: "A later user request",
      description: "Same slot in a different native user turn",
    });
    assert.notEqual(nextTurn.workItemId, first.workItemId);
  });
});

test("work transitions use revision CAS and reject stale writers", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "cas-1",
      sourceType: "admin",
      title: "CAS",
      description: "verify state revision",
    });
    assert.equal(work.stateRevision, 1);
    const running = store.transitionWork(work.workItemId, "alice", "team-a", work.stateRevision, "running");
    assert.equal(running.status, "running");
    assert.equal(running.stateRevision, 2);
    assert.throws(
      () => store.transitionWork(work.workItemId, "alice", "team-a", work.stateRevision, "blocked"),
      /STALE_WORK_REVISION/,
    );
  });
});

test("only one active work attempt is allowed and it pins workflow version", () => {
  withStore((store) => {
    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "attempt-1",
      sourceType: "mcp",
      title: "Attempt",
      description: "create one attempt",
      workflowId: "code-fix-default",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 7,
    });
    assert.equal(attempt.sequence, 1);
    assert.equal(attempt.workflowId, "code-fix-default");
    assert.equal(attempt.workflowVersion, 1);
    const current = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(current.activeWorkAttemptId, attempt.workAttemptId);
    assert.throws(
      () =>
        store.createWorkAttempt(work.workItemId, "alice", "team-a", current.stateRevision, {
          reason: "human_rework",
          expertId: "ota",
          deploymentId: "ota-codex",
          deploymentConfigVersion: 7,
        }),
      /ACTIVE_WORK_ATTEMPT_EXISTS/,
    );
  });
});

test("workflow validation policy is append-only, version-pinned and rejects malformed definitions", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    const definition = {
      ...base,
      validation: {
        requiredEvidence: ["expert_result", "unit_test"],
        required: [
          {
            id: "unit-test",
            type: "command",
            argv: ["npm", "test"],
            timeoutMs: 120_000,
            evidenceType: "unit_test",
          },
        ],
      },
    };
    const registered = store.putWorkflow("verified-code-fix", 1, definition, 100);
    assert.deepEqual(registered.definition.validation.required, definition.validation.required);
    assert.equal(store.putWorkflow("verified-code-fix", 1, definition, 101).version, 1);
    assert.throws(
      () =>
        store.putWorkflow(
          "verified-code-fix",
          1,
          { ...definition, review: { required: true, reviewerExpertId: "reviewer" } },
          102,
        ),
      /WORKFLOW_VERSION_CONFLICT/,
    );
    assert.throws(
      () =>
        store.putWorkflow(
          "bad-validation",
          1,
          {
            ...base,
            validation: {
              requiredEvidence: ["unit_test"],
              required: [{ id: "bad", type: "command", argv: [], timeoutMs: 1_000, evidenceType: "unit_test" }],
            },
          },
          103,
        ),
      /INVALID_VERIFICATION_POLICY/,
    );

    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "workflow-pin",
      sourceType: "mcp",
      title: "workflow pin",
      description: "workflow pin",
      workflowId: "verified-code-fix",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    assert.equal(attempt.workflowId, "verified-code-fix");
    assert.equal(attempt.workflowVersion, 1);
  });
});

test("code-change workflow fails closed without mandatory quality and delivery gates", () => {
  withStore((store) => {
    const base = structuredClone(store.getWorkflow("bug-fix").definition);
    const withoutBuild = structuredClone(base);
    withoutBuild.validation.requiredEvidence = withoutBuild.validation.requiredEvidence.filter(
      (item) => item !== "build",
    );
    assert.throws(() => store.putWorkflow("bad-code-change-build", 1, withoutBuild), /INVALID_WORKFLOW/);

    const withoutUnit = structuredClone(base);
    withoutUnit.validation.requiredEvidence = withoutUnit.validation.requiredEvidence.filter(
      (item) => item !== "unit_test",
    );
    assert.throws(() => store.putWorkflow("bad-code-change-unit", 1, withoutUnit), /INVALID_WORKFLOW/);

    const withoutReview = structuredClone(base);
    withoutReview.review = { required: false };
    withoutReview.completion.require = withoutReview.completion.require.filter((item) => item !== "review_accepted");
    assert.throws(() => store.putWorkflow("bad-code-change-review", 1, withoutReview), /INVALID_WORKFLOW/);

    const withoutMr = structuredClone(base);
    withoutMr.completion.require = withoutMr.completion.require.filter((item) => item !== "change_request_created");
    assert.throws(() => store.putWorkflow("bad-code-change-mr", 1, withoutMr), /INVALID_WORKFLOW/);
  });
});

test("configured integration test becomes mandatory evidence automatically", () => {
  withStore((store) => {
    const base = structuredClone(store.getWorkflow("bug-fix").definition);
    base.validation.required.push({
      id: "integration",
      type: "command",
      argv: ["./scripts/integration-test.sh"],
      timeoutMs: 600_000,
      evidenceType: "integration_test",
    });
    const registered = store.putWorkflow("integration-code-change", 1, base);
    assert.ok(registered.definition.validation.requiredEvidence.includes("integration_test"));
  });
});

test("default workflow policy is immutable and available after reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-reopen-"));
  const file = path.join(dir, "runtime.db");
  try {
    let store = new WorkOrchestrationStore(file);
    const workflow = store.getWorkflow("code-fix-default", 1);
    assert.equal(workflow.version, 1);
    assert.equal(workflow.definition.lifecycle.attempt.maxWorkAttempts, 5);
    assert.equal(workflow.definition.lifecycle.attempt.maxReworks, 3);
    assert.equal(workflow.definition.lifecycle.retry.failure.maxRunsPerWorkAttempt, 3);
    assert.equal(workflow.definition.lifecycle.continuation.maxTurnsPerRun, 20);
    assert.deepEqual(workflow.definition.validation.requiredEvidence, ["expert_result"]);

    const work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "reopen-1",
      sourceType: "mcp",
      title: "Persist",
      description: "survive reopen",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-codex",
      deploymentConfigVersion: 3,
    });
    store.close();

    store = new WorkOrchestrationStore(file);
    const reopened = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(reopened.activeWorkAttemptId, attempt.workAttemptId);
    assert.equal(store.getWorkAttempt(attempt.workAttemptId).deploymentConfigVersion, 3);
    assert.equal(store.getWorkflow("code-fix-default", 1).version, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow accepts platform write profile and structured approval requirements", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    const record = store.putWorkflow("write-flow", 1, {
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
    assert.equal(record.definition.execution.requiredRuntimeProfile, "codex-workspace-write");
    assert.deepEqual(record.definition.completion.requiredApprovals, [
      { scope: "work_completion", subjectType: "workspace_revision" },
    ]);
  });
});

test("workflow rejects unknown write profiles and malformed approval requirements", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    assert.throws(
      () =>
        store.putWorkflow("bad-profile", 1, {
          ...structuredClone(base),
          execution: {
            ...structuredClone(base.execution),
            requiredRuntimeProfile: "custom-workspace-write" as any,
          },
        }),
      /INVALID_WORKFLOW/,
    );
    const codeChange = structuredClone(store.getWorkflow("bug-fix").definition);
    assert.throws(
      () =>
        store.putWorkflow("bad-code-change-runtime", 1, {
          ...codeChange,
          execution: {
            ...structuredClone(codeChange.execution),
            requiredRuntimeProfile: "claude-readonly",
          },
        }),
      /INVALID_WORKFLOW/,
    );
    const readonly = structuredClone(store.getWorkflow("investigation").definition);
    assert.throws(
      () =>
        store.putWorkflow("bad-readonly-runtime", 1, {
          ...readonly,
          execution: {
            ...structuredClone(readonly.execution),
            requiredRuntimeProfile: "claude-workspace-write",
          },
        }),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("missing-approval", 1, {
          ...structuredClone(base),
          completion: {
            require: [...base.completion.require, "required_approvals_approved"] as any,
          },
        }),
      /INVALID_WORKFLOW/,
    );
    assert.throws(
      () =>
        store.putWorkflow("bad-approval", 1, {
          ...structuredClone(base),
          completion: {
            require: [...base.completion.require, "required_approvals_approved"] as any,
            requiredApprovals: [{ scope: "merge", subjectType: "source_revision" }] as any,
          },
        }),
      /INVALID_WORKFLOW/,
    );
  });
});

test("legacy workflow without runtime or approval requirements remains normalized unchanged", () => {
  withStore((store) => {
    const base = structuredClone(store.getWorkflow("code-fix-default").definition);
    const record = store.putWorkflow("legacy-compatible", 1, base);
    assert.equal(record.definition.execution.requiredRuntimeProfile, undefined);
    assert.equal(record.definition.completion.requiredApprovals, undefined);
    assert.deepEqual(record.definition.completion.require, base.completion.require);
  });
});

test("legacy humanReview workflow shape normalizes to required review", () => {
  withStore((store) => {
    const base = structuredClone(store.getWorkflow("code-fix-default").definition) as any;
    base.review = { humanReview: true };
    const record = store.putWorkflow("legacy-human-review", 1, base);
    assert.deepEqual(record.definition.review, { required: true });
  });
});

function createApprovalGatedWork(store: WorkOrchestrationStore, idempotencyKey: string) {
  const base = store.getWorkflow("code-fix-default").definition;
  const workflowId = "approval-gated-" + idempotencyKey;
  store.putWorkflow(workflowId, 1, {
    ...structuredClone(base),
    completion: {
      require: [...base.completion.require, "required_approvals_approved"],
      requiredApprovals: [{ scope: "work_completion", subjectType: "workspace_revision" }],
    },
  });
  const work = store.createOrReuseWork({
    principalId: "alice",
    scope: "team-a",
    idempotencyKey,
    sourceType: "mcp",
    title: "Approval Gate",
    description: "require exact current approval",
    workflowId,
  });
  const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
    reason: "initial",
    expertId: "ota",
    deploymentId: "ota-write",
    deploymentConfigVersion: 1,
  });
  let current = store.getWork(work.workItemId, "alice", "team-a");
  const subject = "workspace:" + "a".repeat(64);
  current = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", current.stateRevision, subject);
  store.recordEvidence(work.workItemId, "alice", "team-a", {
    workAttemptId: attempt.workAttemptId,
    type: "expert_result",
    status: "passed",
    source: "worker_verified",
    subjectRevision: subject,
  });
  current = store.finishWorkAttempt(
    work.workItemId,
    attempt.workAttemptId,
    "alice",
    "team-a",
    current.stateRevision,
    "succeeded",
    "waiting_review",
  );
  return { workItemId: work.workItemId, subject, current };
}

test("completion gate requires current work_completion approval after accepted review", () => {
  withStore((store) => {
    const setup = createApprovalGatedWork(store, "approval-gate-review-first");
    store.submitReviewDecision(setup.workItemId, "alice", "team-a", {
      expectedRevision: setup.current.stateRevision,
      subjectRevision: setup.subject,
      decision: "accepted",
    });
    let gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.equal(gate.ready, false);
    assert.deepEqual(gate.missing, ["required_approval:work_completion"]);

    let current = store.getWork(setup.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        store.recordApproval(setup.workItemId, "alice", "team-a", {
          expectedRevision: current.stateRevision,
          actor: "alice",
          role: "developer",
          approvalScope: "merge",
          subjectType: "workspace_revision",
          subjectRevision: setup.subject,
          decision: "approved",
        }),
      /INVALID_WORK_APPROVAL/,
    );
    gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.deepEqual(gate.missing, ["required_approval:work_completion"]);
    current = store.getWork(setup.workItemId, "alice", "team-a");
    store.recordApproval(setup.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: setup.subject,
      decision: "approved",
    });
    gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.equal(gate.ready, true);
    assert.deepEqual(gate.missing, []);
  });
});

test("approval without review is insufficient and becomes stale after subject revision changes", () => {
  withStore((store) => {
    const setup = createApprovalGatedWork(store, "approval-gate-approval-first");
    store.recordApproval(setup.workItemId, "alice", "team-a", {
      expectedRevision: setup.current.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: setup.subject,
      decision: "approved",
    });
    let gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("review_accepted"));
    assert.ok(!gate.missing.includes("required_approval:work_completion"));

    let current = store.getWork(setup.workItemId, "alice", "team-a");
    store.setCurrentSubjectRevision(
      setup.workItemId,
      "alice",
      "team-a",
      current.stateRevision,
      "workspace:" + "b".repeat(64),
    );
    assert.equal(store.listApprovals(setup.workItemId).at(-1)!.stale, true);
    const invalidatedEvents = store
      .listEvents(setup.workItemId)
      .events.filter((event) => event.eventType === "approval.invalidated");
    assert.equal(invalidatedEvents.length, 1);
    assert.equal(invalidatedEvents[0]!.details?.count, 1);
    gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_approval:work_completion"));
    assert.ok(gate.missing.includes("review_accepted"));
  });
});

test("new WorkAttempt invalidates prior attempt evidence even when subject revision is unchanged", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("attempt-bound-evidence", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: ["unit_test"], required: [] },
      review: { required: false },
      completion: {
        require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
      },
    });
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "attempt-bound-evidence",
      sourceType: "mcp",
      title: "Attempt evidence",
      description: "evidence belongs to latest attempt",
      workflowId: "attempt-bound-evidence",
    });
    const first = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-a",
      deploymentConfigVersion: 1,
    });
    work = store.getWork(work.workItemId, "alice", "team-a");
    const subject = "workspace:" + "a".repeat(64);
    work = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, subject);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: first.workAttemptId,
      type: "unit_test",
      status: "passed",
      source: "worker_verified",
      subjectRevision: subject,
      environmentIdentity: "ota-a@1",
      verifierIdentity: "team-skill-hub",
    });
    work = store.finishWorkAttempt(
      work.workItemId,
      first.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
    );
    assert.equal(store.evaluateCompletionGate(work.workItemId, "alice", "team-a").ready, true);

    const second = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "review_rework",
      expertId: "ota",
      deploymentId: "ota-b",
      deploymentConfigVersion: 2,
      parentWorkAttemptId: first.workAttemptId,
    });
    work = store.getWork(work.workItemId, "alice", "team-a");
    work = store.finishWorkAttempt(
      work.workItemId,
      second.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
    );

    const evidence = store.listEvidence(work.workItemId);
    assert.equal(evidence[0]!.stale, true);
    const gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_evidence:unit_test"));
  });
});

test("work completion approval is bound to the latest succeeded WorkAttempt", () => {
  withStore((store) => {
    const setup = createApprovalGatedWork(store, "approval-attempt-binding");
    store.submitReviewDecision(setup.workItemId, "alice", "team-a", {
      expectedRevision: setup.current.stateRevision,
      subjectRevision: setup.subject,
      decision: "accepted",
    });
    let current = store.getWork(setup.workItemId, "alice", "team-a");
    const approval = store.recordApproval(setup.workItemId, "alice", "team-a", {
      expectedRevision: current.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "work_completion",
      subjectType: "workspace_revision",
      subjectRevision: setup.subject,
      decision: "approved",
    });
    assert.ok(approval.workAttemptId);
    assert.equal(store.evaluateCompletionGate(setup.workItemId, "alice", "team-a").ready, true);

    current = store.getWork(setup.workItemId, "alice", "team-a");
    const firstAttempt = store.listAttempts(setup.workItemId)[0]!;
    const second = store.createWorkAttempt(setup.workItemId, "alice", "team-a", current.stateRevision, {
      reason: "review_rework",
      expertId: "ota",
      deploymentId: "ota-write-v2",
      deploymentConfigVersion: 2,
      parentWorkAttemptId: firstAttempt.workAttemptId,
    });
    current = store.getWork(setup.workItemId, "alice", "team-a");
    current = store.finishWorkAttempt(
      setup.workItemId,
      second.workAttemptId,
      "alice",
      "team-a",
      current.stateRevision,
      "succeeded",
      "waiting_review",
    );

    assert.equal(store.listApprovals(setup.workItemId).at(-1)!.stale, true);
    const gate = store.evaluateCompletionGate(setup.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_approval:work_completion"));
  });
});

test("approval store accepts only platform-defined subject/scope pairs", () => {
  withStore((store) => {
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "publication-approval-store",
      sourceType: "mcp",
      title: "Publication approval",
      description: "approve exact prepared commit",
    });
    work = store.setCurrentSubjectRevision(
      work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "workspace:" + "a".repeat(64),
    );
    const publicationSubject = "publication:11111111-1111-4111-8111-111111111111:" + "c".repeat(40);
    const approval = store.recordApproval(work.workItemId, "alice", "team-a", {
      expectedRevision: work.stateRevision,
      actor: "alice",
      role: "developer",
      approvalScope: "publish_work_branch",
      subjectType: "publication_artifact",
      subjectRevision: publicationSubject,
      decision: "approved",
    });
    assert.equal(approval.approvalScope, "publish_work_branch");
    assert.equal(approval.subjectType, "publication_artifact");
    assert.equal(approval.subjectRevision, publicationSubject);

    work = store.getWork(work.workItemId, "alice", "team-a");
    assert.throws(
      () =>
        store.recordApproval(work.workItemId, "alice", "team-a", {
          expectedRevision: work.stateRevision,
          actor: "alice",
          role: "developer",
          approvalScope: "work_completion",
          subjectType: "publication_artifact",
          subjectRevision: publicationSubject,
          decision: "approved",
        }),
      /INVALID_WORK_APPROVAL/,
    );
  });
});

test("publication-required workflow gates completion on exact pushed artifact evidence and approval", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-publication-gate-"));
  const file = path.join(dir, "runtime.db");
  const publications = new WorkPublicationStore(file);
  try {
    const store = new WorkOrchestrationStore(file);
    const base = store.getWorkflow("code-fix-default").definition;
    store.putWorkflow("publication-gate", 1, {
      ...base,
      publication: { required: true, mode: "work_branch" },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
          "required_approvals_approved",
          "publication_succeeded",
        ],
        requiredApprovals: [{ scope: "publish_work_branch", subjectType: "publication_artifact" }],
      },
    } as any);
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "publication-gate",
      sourceType: "mcp",
      title: "Publish",
      description: "Publish exact branch",
      workflowId: "publication-gate",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-write",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      baseCommit: "b".repeat(40),
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
    });
    const sourceSubject = "workspace:" + "a".repeat(64);
    work = store.getWork(work.workItemId, "alice", "team-a");
    work = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, sourceSubject, 100);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "expert_result",
      status: "passed",
      source: "worker_verified",
      subjectRevision: sourceSubject,
    });
    work = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
      110,
    );
    store.submitReviewDecision(
      work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: work.stateRevision,
        subjectRevision: sourceSubject,
        decision: "accepted",
      },
      120,
    );

    const publication = publications.createOrReusePublication(
      {
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workspaceId: workspace.workspaceId,
        sourceSubjectRevision: sourceSubject,
        baseCommit: "b".repeat(40),
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 1,
        branchName: "skillhub/work/work-a1",
        pushRemoteName: "origin",
        ownerWorkerId: "worker-a",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "Publish\n",
        executionSnapshot: {
          workspacePath: "/srv/workspaces/work-a1",
          repositoryUrl: "https://example.test/ota.git",
          defaultBranch: "main",
          branchPrefix: "skillhub/work/",
          protectedBranches: ["main"],
          allowedPushRemote: "origin",
          expectedContentRevision: "a".repeat(64),
          approvedChangeSummary: {
            baseCommit: "b".repeat(40),
            changedFiles: ["README.md"],
            addedFiles: [],
            deletedFiles: [],
            diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
            contentRevision: "a".repeat(64),
          },
        },
      } as any,
      130,
    );
    publications.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      140,
    );
    const publicationSubject = "publication:" + publication.publicationId + ":" + "c".repeat(40);

    let gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("required_approval:publish_work_branch"));
    assert.ok(gate.missing.includes("publication_succeeded"));

    work = store.getWork(work.workItemId, "alice", "team-a");
    store.recordApproval(
      work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: work.stateRevision,
        actor: "alice",
        role: "developer",
        approvalScope: "publish_work_branch",
        subjectType: "publication_artifact",
        subjectRevision: publicationSubject,
        decision: "approved",
      },
      150,
    );
    publications.transitionPublication(publication.publicationId, "approved", {}, 150);
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(!gate.missing.includes("required_approval:publish_work_branch"));
    assert.ok(gate.missing.includes("publication_succeeded"));

    publications.transitionPublication(publication.publicationId, "pushing", {}, 160);
    publications.transitionPublication(publication.publicationId, "pushed", {}, 170);
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.ok(gate.missing.includes("publication_succeeded"), "pushed state alone must not satisfy gate");

    store.recordEvidence(
      work.workItemId,
      "alice",
      "team-a",
      {
        workAttemptId: attempt.workAttemptId,
        type: "publication",
        status: "passed",
        source: "worker_verified",
        artifactRef: "publication:" + publication.publicationId,
        subjectRevision: publicationSubject,
        environmentIdentity: "publication-policy@1",
        verifierIdentity: "team-skill-hub-publication",
      },
      180,
    );
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(gate.ready, true);
    assert.deepEqual(gate.missing, []);

    work = store.getWork(work.workItemId, "alice", "team-a");
    store.setCurrentSubjectRevision(
      work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "workspace:" + "e".repeat(64),
      190,
    );
    assert.equal(store.listEvidence(work.workItemId).find((e) => e.type === "publication")?.stale, true);
    assert.ok(
      store.evaluateCompletionGate(work.workItemId, "alice", "team-a").missing.includes("publication_succeeded"),
    );

    store.close();
  } finally {
    publications.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code-change completion waits for change-request evidence after branch publication", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-change-request-gate-"));
  const file = path.join(dir, "runtime.db");
  const publications = new WorkPublicationStore(file);
  try {
    const store = new WorkOrchestrationStore(file);
    let work = store.createOrReuseWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "change-request-gate",
      sourceType: "mcp",
      title: "Code change",
      description: "Require branch and MR",
      workflowId: "bug-fix",
    });
    const attempt = store.createWorkAttempt(work.workItemId, "alice", "team-a", work.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-write",
      deploymentConfigVersion: 1,
    });
    const workspace = store.ensureWorkspace(work.workItemId, attempt.workAttemptId, {
      baseCommit: "b".repeat(40),
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
    });
    work = store.getWork(work.workItemId, "alice", "team-a");
    const sourceSubject = "workspace:" + "a".repeat(64);
    work = store.setCurrentSubjectRevision(work.workItemId, "alice", "team-a", work.stateRevision, sourceSubject, 100);
    for (const type of ["expert_result", "build", "unit_test"]) {
      store.recordEvidence(work.workItemId, "alice", "team-a", {
        workAttemptId: attempt.workAttemptId,
        type,
        status: "passed",
        source: "worker_verified",
        subjectRevision: sourceSubject,
      });
    }
    work = store.finishWorkAttempt(
      work.workItemId,
      attempt.workAttemptId,
      "alice",
      "team-a",
      work.stateRevision,
      "succeeded",
      "waiting_review",
      110,
    );
    store.submitReviewDecision(
      work.workItemId,
      "alice",
      "team-a",
      {
        expectedRevision: work.stateRevision,
        subjectRevision: sourceSubject,
        decision: "accepted",
      },
      120,
    );

    const publication = publications.createOrReusePublication(
      {
        workItemId: work.workItemId,
        workAttemptId: attempt.workAttemptId,
        workspaceId: workspace.workspaceId,
        sourceSubjectRevision: sourceSubject,
        baseCommit: "b".repeat(40),
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 1,
        branchName: "tsh/bug-fix/change-request-gate",
        pushRemoteName: "origin",
        ownerWorkerId: "worker-a",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "Code change\n",
        executionSnapshot: {
          workspacePath: "/srv/workspaces/change-request-gate",
          repositoryUrl: "https://example.test/ota.git",
          defaultBranch: "main",
          branchPrefix: "tsh/bug-fix/",
          protectedBranches: ["main"],
          allowedPushRemote: "origin",
          expectedContentRevision: "a".repeat(64),
          approvedChangeSummary: {
            baseCommit: "b".repeat(40),
            changedFiles: ["src/fix.ts"],
            addedFiles: [],
            deletedFiles: [],
            diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
            contentRevision: "a".repeat(64),
          },
        },
      } as any,
      130,
    );
    publications.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
        pushRefspec: "c".repeat(40) + ":refs/heads/" + publication.branchName,
      },
      140,
    );
    publications.transitionPublication(publication.publicationId, "approved", {}, 150);
    publications.transitionPublication(publication.publicationId, "pushing", {}, 160);
    publications.transitionPublication(publication.publicationId, "pushed", {}, 170);
    const publicationSubject = "publication:" + publication.publicationId + ":" + "c".repeat(40);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "publication",
      status: "passed",
      source: "worker_verified",
      artifactRef: "publication:" + publication.publicationId,
      subjectRevision: publicationSubject,
    });

    let gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.deepEqual(gate.missing, ["change_request_created"]);
    store.recordEvidence(work.workItemId, "alice", "team-a", {
      workAttemptId: attempt.workAttemptId,
      type: "pull_request",
      status: "passed",
      source: "external_verified",
      artifactRef: "https://git.example/merge_requests/42",
      subjectRevision: publicationSubject,
    });
    gate = store.evaluateCompletionGate(work.workItemId, "alice", "team-a");
    assert.equal(gate.ready, true);
    assert.deepEqual(gate.missing, []);
    store.close();
  } finally {
    publications.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publication_succeeded token is invalid without publication-required workflow", () => {
  withStore((store) => {
    const base = store.getWorkflow("code-fix-default").definition;
    assert.throws(
      () =>
        store.putWorkflow("bad-publication-gate", 1, {
          ...base,
          completion: { require: [...base.completion.require, "publication_succeeded"] },
        } as any),
      /INVALID_WORKFLOW/,
    );
  });
});

test("durable orchestration claim is exclusive, fenced by epoch, and survives reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-orchestration-claim-"));
  const file = path.join(dir, "runtime.db");
  let store = new WorkOrchestrationStore(file);
  try {
    const work = store.createOrReuseWork(
      {
        principalId: "alice",
        scope: "team-a",
        idempotencyKey: "claim-1",
        sourceType: "mcp",
        title: "Claim",
        description: "claim",
      },
      100,
    );

    const first = store.claimWorkForOrchestration(work.workItemId, "orchestrator-a", 200, 1_000);
    assert.equal(first.ownerId, "orchestrator-a");
    assert.equal(first.epoch, work.orchestrationEpoch + 1);
    assert.equal(store.getWork(work.workItemId, "alice", "team-a").orchestrationOwnerId, "orchestrator-a");
    assert.throws(
      () => store.claimWorkForOrchestration(work.workItemId, "orchestrator-b", 300, 1_000),
      /WORK_ORCHESTRATION_CLAIMED/,
    );

    store.close();
    store = new WorkOrchestrationStore(file);
    const reopened = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(reopened.orchestrationOwnerId, "orchestrator-a");
    assert.equal(reopened.orchestrationLeaseUntil, 1_200);
    store.assertWorkOrchestrationClaim(work.workItemId, "orchestrator-a", first.epoch, 1_199);

    const second = store.claimWorkForOrchestration(work.workItemId, "orchestrator-b", 1_201, 1_000);
    assert.equal(second.ownerId, "orchestrator-b");
    assert.equal(second.epoch, first.epoch + 1);
    const afterTakeover = store.getWork(work.workItemId, "alice", "team-a");
    assert.ok(afterTakeover.stateRevision > reopened.stateRevision);
    assert.throws(
      () =>
        store.transitionWork(work.workItemId, "alice", "team-a", afterTakeover.stateRevision, "running", 1_202, {
          ownerId: "orchestrator-a",
          epoch: first.epoch,
          now: 1_202,
        }),
      /STALE_ORCHESTRATION_CLAIM/,
    );
    assert.throws(
      () => store.assertWorkOrchestrationClaim(work.workItemId, "orchestrator-a", first.epoch, 1_202),
      /STALE_ORCHESTRATION_CLAIM/,
    );
    store.assertWorkOrchestrationClaim(work.workItemId, "orchestrator-b", second.epoch, 1_202);

    store.releaseWorkOrchestrationClaim(work.workItemId, "orchestrator-b", second.epoch, 1_203);
    assert.equal(store.getWork(work.workItemId, "alice", "team-a").orchestrationOwnerId, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked work persists complete resume metadata and can be explicitly resumed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-blocked-resume-"));
  const file = path.join(dir, "runtime.db");
  let store = new WorkOrchestrationStore(file);
  try {
    const work = store.createOrReuseWork(
      {
        principalId: "alice",
        scope: "team-a",
        idempotencyKey: "blocked-metadata",
        sourceType: "mcp",
        title: "Blocked",
        description: "blocked",
      },
      100,
    );
    const blocked = store.blockWork(
      work.workItemId,
      "alice",
      "team-a",
      work.stateRevision,
      "missing_permission",
      "MISSING_PERMISSION",
      200,
      { resumeCondition: "manual", blockedByType: "permission", blockedByRef: "repo:ota" },
    );
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedAt, 200);
    assert.equal(blocked.resumeCondition, "manual");
    assert.equal(blocked.blockedByType, "permission");
    assert.equal(blocked.blockedByRef, "repo:ota");

    store.close();
    store = new WorkOrchestrationStore(file);
    const reopened = store.getWork(work.workItemId, "alice", "team-a");
    assert.equal(reopened.blockedAt, 200);
    assert.equal(reopened.resumeCondition, "manual");
    assert.equal(reopened.blockedByType, "permission");
    assert.equal(reopened.blockedByRef, "repo:ota");

    const resumed = store.resumeBlockedWork(work.workItemId, "alice", "team-a", reopened.stateRevision, "queued", 300);
    assert.equal(resumed.status, "queued");
    assert.equal(resumed.blockedReason, null);
    assert.equal(resumed.blockedContext, null);
    assert.equal(resumed.blockedAt, null);
    assert.equal(resumed.resumeCondition, null);
    assert.equal(resumed.blockedByType, null);
    assert.equal(resumed.blockedByRef, null);
    assert.ok(store.listEvents(work.workItemId).events.some((event) => event.eventType === "work.resumed"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
