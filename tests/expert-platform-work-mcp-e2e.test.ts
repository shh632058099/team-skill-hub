import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";
import { WorkPublicationStore } from "../src/expert-platform/work-publication-store.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { ApiKeyAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import type { AppConfig } from "../src/types.js";
import type { startServer as StartServer } from "../src/server.js";

interface McpResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; description?: string }>;
  };
  error?: { message?: string };
}

async function callMcp(
  url: string,
  apiKey: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
      "x-skill-hub-client": "claude-code-test",
      "x-skill-hub-session-id": "mcp-e2e-session",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  if (rpc.error) throw new Error(rpc.error.message ?? "MCP_REQUEST_FAILED");
  const text = rpc.result?.content?.find((item) => item.type === "text")?.text;
  if (!text || rpc.result?.isError) throw new Error(text ?? "MCP_TOOL_FAILED");
  return JSON.parse(text) as Record<string, any>;
}

async function callMcpWithoutSessionHeader(
  url: string,
  apiKey: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
      "x-skill-hub-client": "codex-proof-test",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  if (rpc.error) throw new Error(rpc.error.message ?? "MCP_REQUEST_FAILED");
  const text = rpc.result?.content?.find((item) => item.type === "text")?.text;
  if (!text || rpc.result?.isError) throw new Error(text ?? "MCP_TOOL_FAILED");
  return JSON.parse(text) as Record<string, any>;
}

async function listMcpTools(url: string, apiKey: string): Promise<Array<{ name: string; description?: string }>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-skill-hub-api-key": apiKey,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const rpc = JSON.parse(dataLine ? dataLine.slice(6) : body) as McpResponse;
  assert.ok(rpc.result?.tools);
  return rpc.result!.tools!;
}

test("MCP Work API drives durable work through review, rework, authorization and cancellation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "work-mcp-e2e-"));
  const runtimeDb = path.join(root, "runtime.sqlite");
  const dataDir = path.join(root, "app-data");
  const oldRuntimeDb = process.env.EXPERT_RUNTIME_DB;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;

  let app: Awaited<ReturnType<typeof StartServer>> | undefined;
  let tasks: ExpertTaskStore | undefined;
  try {
    const { startServer } = await import("../src/server.js");
    const apiKey = "work-api-key";
    const otherKey = "other-work-api-key";
    const adminKey = "admin-work-api-key";
    const workerKey = "worker-work-api-key";
    const auth = new ApiKeyAuthenticationProvider({
      [apiKey]: { id: "alice", roles: ["developer", "internal"], tenantId: "team-a" },
      [otherKey]: { id: "bob", roles: ["developer", "internal"], tenantId: "team-a" },
      [adminKey]: { id: "alice", roles: ["admin", "developer", "internal"], tenantId: "team-a" },
      [workerKey]: { id: "worker", roles: ["worker-mcp-readonly"], tenantId: "team-a" },
    });
    const search = new SqliteFtsSearchBackend();
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: [],
      authentication: { mode: "api-key", apiKeys: {} },
      repositories: [],
    };
    const service = new SkillHubApplicationService(
      config,
      [],
      new MemoryRegistryStore(),
      search,
      new SearchRoutingStrategy(search),
      auth,
      new StaticRolePermissionProvider(),
      [],
      new LoggingEventSink(),
    );
    await service.initialize();
    app = await startServer(config, service);
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

    const experts = new ExpertStore(runtimeDb);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota", "upgrade", "rollback"],
      active: true,
    });
    experts.putDefinition({
      id: "ota-write",
      displayName: "OTA Write Expert",
      capabilities: ["ota-write"],
      keywords: ["ota-write", "mutation"],
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
    experts.putDeployment({
      id: "ota-write-default",
      expertId: "ota-write",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
    });
    experts.close();
    tasks = new ExpertTaskStore(runtimeDb);
    const workflowSetup = new WorkOrchestrationStore(runtimeDb);
    const baseWorkflow = workflowSetup.getWorkflow("code-fix-default").definition;
    workflowSetup.putWorkflow("mcp-verified", 1, {
      ...baseWorkflow,
      validation: {
        requiredEvidence: ["expert_result", "readme_check"],
        required: [
          {
            id: "readme-check",
            type: "command",
            argv: ["node", "-e", "require('fs').accessSync('tests/README.md')"],
            timeoutMs: 30_000,
            evidenceType: "readme_check",
          },
        ],
      },
    });
    workflowSetup.putWorkflow("mcp-write-approval", 1, {
      ...structuredClone(baseWorkflow),
      execution: {
        ...structuredClone(baseWorkflow.execution),
        requiredRuntimeProfile: "codex-workspace-write",
      },
      completion: {
        require: [...baseWorkflow.completion.require, "required_approvals_approved"],
        requiredApprovals: [{ scope: "work_completion", subjectType: "workspace_revision" }],
      },
    });
    workflowSetup.close();

    const tools = await listMcpTools(mcpUrl, apiKey);
    for (const name of [
      "submit_work",
      "update_work_source",
      "get_work",
      "wait_work",
      "review_work",
      "approve_work",
      "record_work_evidence",
      "resume_work",
      "cancel_work",
    ]) {
      assert.ok(
        tools.some((tool) => tool.name === name),
        `missing MCP tool ${name}`,
      );
    }

    const signedSessionId = "11111111-1111-4111-8111-111111111111";
    const signedIdempotencyKey = "mcp-signed-session-work";
    const signedAt = Date.now();
    const signedProof = `${signedAt}.${createHmac("sha256", apiKey)
      .update(`team-skill-hub/client-session/v1\n${signedSessionId}\n${signedIdempotencyKey}\n${signedAt}`)
      .digest("hex")}`;
    const signedSubmission = await callMcpWithoutSessionHeader(mcpUrl, apiKey, 901, "submit_work", {
      title: "Signed native MCP session",
      description: "Verify stateless MCP can bind native client session",
      idempotencyKey: signedIdempotencyKey,
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
      clientSessionId: signedSessionId,
      clientSessionProof: signedProof,
    });
    assert.equal(signedSubmission.work.sourceScope, `codex-proof-test/${signedSessionId}`);
    const signedWorkId = String(signedSubmission.work.workItemId);
    const updateAt = Date.now();
    const updateProof = `${updateAt}.${createHmac("sha256", apiKey)
      .update(`team-skill-hub/client-session/v1\n${signedSessionId}\n${signedWorkId}\n${updateAt}`)
      .digest("hex")}`;
    const signedTerminal = await callMcpWithoutSessionHeader(mcpUrl, apiKey, 902, "update_work_source", {
      workItemId: signedWorkId,
      sourceControlToken: signedSubmission.sourceControlToken,
      state: "terminal",
      clientSessionId: signedSessionId,
      clientSessionProof: updateProof,
    });
    assert.equal(signedTerminal.work.status, "cancelled");
    assert.equal(signedTerminal.sourceObservations.at(-1).reconciliationAction, "cancel");

    const submitted = await callMcp(mcpUrl, apiKey, 1, "submit_work", {
      title: "Inspect OTA rollback",
      description: "Inspect OTA rollback handling after power loss",
      idempotencyKey: "mcp-work-1",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const workId = String(submitted.work.workItemId);
    assert.equal(submitted.workItemId, workId);
    assert.equal(submitted.status, "running");
    assert.match(submitted.sourceControlToken, /^wsc_[A-Za-z0-9_-]{40,}$/);
    const taskId = String(submitted.currentTask.taskId);
    assert.match(workId, /^[0-9a-f-]{36}$/i);
    assert.equal(submitted.work.status, "running");
    assert.equal(submitted.work.sourceType, "mcp");
    assert.equal(submitted.work.sourceScope, "claude-code-test/mcp-e2e-session");
    assert.equal(submitted.work.sourceRef, "mcp-work-1");
    assert.equal(submitted.sourceObservations.length, 1);
    assert.equal(submitted.sourceObservations[0].state, "active");
    assert.equal(submitted.sourceObservations[0].reconciliationAction, "noop");
    assert.equal(submitted.attempts.length, 1);

    const replay = await callMcp(mcpUrl, apiKey, 2, "submit_work", {
      title: "Inspect OTA rollback",
      description: "Inspect OTA rollback handling after power loss",
      idempotencyKey: "mcp-work-1",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    assert.equal(replay.work.workItemId, workId);
    assert.equal(replay.currentTask.taskId, taskId);

    await assert.rejects(
      () =>
        callMcp(mcpUrl, apiKey, 3, "submit_work", {
          title: "Conflicting work",
          description: "Different payload",
          idempotencyKey: "mcp-work-1",
          expertId: "ota",
          routingMode: "explicit",
          repositoryId: "ota-repo",
          deploymentId: "ota-default",
        }),
      /WORK_IDEMPOTENCY_CONFLICT/,
    );
    await assert.rejects(() => callMcp(mcpUrl, otherKey, 4, "get_work", { workItemId: workId }), /FORBIDDEN|NOT_FOUND/);

    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    assert.equal(claim.taskId, taskId);
    tasks.recordActivity(claim, "model.started", 1, "", 0, 1_100);
    tasks.recordActivity(claim, "model.completed", 2, "", 0, 1_200);
    tasks.complete(claim, "OTA analysis complete", 2_000, { commitSha: "a".repeat(40) });

    const waiting = await callMcp(mcpUrl, apiKey, 5, "wait_work", {
      workItemId: workId,
      afterEventId: 0,
      timeoutMs: 500,
    });
    assert.equal(waiting.work.status, "waiting_review");
    assert.equal(waiting.evidence[0].subjectRevision, "a".repeat(40));
    assert.equal(waiting.turns.length, 1);
    assert.equal(waiting.turns[0].runId, claim.runId);
    assert.equal(waiting.turns[0].status, "succeeded");
    assert.equal(waiting.workspace.workspaceKey, submitted.currentTask.workspaceKey);
    assert.deepEqual(waiting.verification.requiredEvidence, ["expert_result"]);
    assert.deepEqual(waiting.verification.requiredSteps, []);
    assert.deepEqual(waiting.verification.results, []);
    assert.equal(waiting.verification.passed, 0);
    assert.equal(waiting.verification.failed, 0);
    assert.ok(Array.isArray(waiting.events));
    assert.ok(Number(waiting.nextEventId) > 0);

    const completed = await callMcp(mcpUrl, apiKey, 6, "review_work", {
      workItemId: workId,
      expectedRevision: waiting.work.stateRevision,
      subjectRevision: "a".repeat(40),
      decision: "accepted",
      reason: "verified",
    });
    assert.equal(completed.work.status, "completed");
    assert.equal(completed.gate.ready, true);

    const workflowBound = await callMcp(mcpUrl, apiKey, 59, "submit_work", {
      title: "Workflow-bound MCP work",
      description: "Verify MCP can select a registered workflow",
      idempotencyKey: "mcp-work-workflow-id",
      workflowId: "mcp-verified",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    assert.equal(workflowBound.work.workflowId, "mcp-verified");
    assert.equal(workflowBound.work.workflowVersion, 1);
    assert.deepEqual(workflowBound.currentTask.validationSnapshot, [
      {
        id: "readme-check",
        type: "command",
        argv: ["node", "-e", "require('fs').accessSync('tests/README.md')"],
        timeoutMs: 30_000,
        evidenceType: "readme_check",
      },
    ]);
    await callMcp(mcpUrl, apiKey, 58, "cancel_work", {
      workItemId: workflowBound.work.workItemId,
    });

    const approvalSubmission = await callMcp(mcpUrl, apiKey, 66, "submit_work", {
      title: "Approval-gated workspace change",
      description: "Modify a fixture and require explicit completion approval",
      idempotencyKey: "mcp-work-approval",
      workflowId: "mcp-write-approval",
      expertId: "ota-write",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-write-default",
    });
    const approvalTaskId = String(approvalSubmission.currentTask.taskId);
    const approvalClaim = tasks.claim("worker-a", 7_000, 30_000, "ota-write")!;
    assert.equal(approvalClaim.taskId, approvalTaskId);
    const approvalSummary = {
      baseCommit: "c".repeat(40),
      changedFiles: ["fixture.txt"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
      contentRevision: "d".repeat(64),
    };
    const approvalSubject = "workspace:" + approvalSummary.contentRevision;
    tasks.complete(
      approvalClaim,
      "workspace updated",
      8_000,
      { commitSha: approvalSummary.baseCommit },
      undefined,
      approvalSummary,
    );
    const approvalWaiting = await callMcp(mcpUrl, apiKey, 67, "get_work", {
      workItemId: approvalSubmission.work.workItemId,
    });
    assert.equal(approvalWaiting.work.status, "waiting_review");
    assert.equal(approvalWaiting.work.currentSubjectRevision, approvalSubject);
    assert.ok(approvalWaiting.gate.missing.includes("review_accepted"));
    assert.ok(approvalWaiting.gate.missing.includes("required_approval:work_completion"));
    assert.deepEqual(approvalWaiting.runtime, {
      requiredProfile: "codex-workspace-write",
      effectiveProfile: "codex-workspace-write",
    });
    assert.deepEqual(approvalWaiting.workspaceChangeSummary, approvalSummary);
    assert.equal(Array.isArray(approvalWaiting.reviews), true);
    assert.equal(Array.isArray(approvalWaiting.approvals), true);

    const approvalReviewed = await callMcp(mcpUrl, apiKey, 68, "review_work", {
      workItemId: approvalSubmission.work.workItemId,
      expectedRevision: approvalWaiting.work.stateRevision,
      subjectRevision: approvalSubject,
      decision: "accepted",
    });
    assert.equal(approvalReviewed.work.status, "waiting_review");
    assert.deepEqual(approvalReviewed.gate.missing, ["required_approval:work_completion"]);
    assert.equal(approvalReviewed.reviews.at(-1).decision, "accepted");
    assert.equal(approvalReviewed.reviews.at(-1).subjectRevision, approvalSubject);

    await assert.rejects(
      () =>
        callMcp(mcpUrl, workerKey, 69, "approve_work", {
          workItemId: approvalSubmission.work.workItemId,
          expectedRevision: approvalReviewed.work.stateRevision,
          subjectRevision: approvalSubject,
          approvalScope: "work_completion",
          decision: "approved",
        }),
      /MCP_TOOL_FORBIDDEN_FOR_PRINCIPAL|WORK_APPROVAL_FORBIDDEN/,
    );
    await assert.rejects(
      () =>
        callMcp(mcpUrl, apiKey, 70, "approve_work", {
          workItemId: approvalSubmission.work.workItemId,
          expectedRevision: approvalReviewed.work.stateRevision - 1,
          subjectRevision: approvalSubject,
          approvalScope: "work_completion",
          decision: "approved",
        }),
      /STALE_WORK_REVISION/,
    );
    await assert.rejects(
      () =>
        callMcp(mcpUrl, apiKey, 71, "approve_work", {
          workItemId: approvalSubmission.work.workItemId,
          expectedRevision: approvalReviewed.work.stateRevision,
          subjectRevision: "workspace:" + "e".repeat(64),
          approvalScope: "work_completion",
          decision: "approved",
        }),
      /STALE_WORK_SUBJECT/,
    );

    const approvalCompleted = await callMcp(mcpUrl, apiKey, 72, "approve_work", {
      workItemId: approvalSubmission.work.workItemId,
      expectedRevision: approvalReviewed.work.stateRevision,
      subjectRevision: approvalSubject,
      approvalScope: "work_completion",
      decision: "approved",
      actor: "mallory",
      role: "admin",
    });
    assert.equal(approvalCompleted.work.status, "completed");
    assert.equal(approvalCompleted.gate.ready, true);
    assert.equal(approvalCompleted.approvals.at(-1).actor, "alice");
    assert.equal(approvalCompleted.approvals.at(-1).role, "developer");
    const approvalStore = new WorkOrchestrationStore(runtimeDb);
    const developerApproval = approvalStore.listApprovals(approvalSubmission.work.workItemId).at(-1)!;
    assert.equal(developerApproval.actor, "alice");
    assert.equal(developerApproval.role, "developer");
    assert.equal(developerApproval.approvalScope, "work_completion");
    assert.equal(developerApproval.subjectType, "workspace_revision");
    assert.equal(developerApproval.subjectRevision, approvalSubject);
    approvalStore.close();

    const adminSubmission = await callMcp(mcpUrl, apiKey, 73, "submit_work", {
      title: "Admin approval precedence",
      description: "Verify admin role is recorded when principal has admin and developer",
      idempotencyKey: "mcp-work-admin-approval",
      workflowId: "mcp-write-approval",
      expertId: "ota-write",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-write-default",
    });
    const adminClaim = tasks.claim("worker-a", 9_000, 30_000, "ota-write")!;
    assert.equal(adminClaim.taskId, adminSubmission.currentTask.taskId);
    const adminSummary = {
      ...approvalSummary,
      contentRevision: "f".repeat(64),
    };
    const adminSubject = "workspace:" + adminSummary.contentRevision;
    tasks.complete(
      adminClaim,
      "admin workspace updated",
      10_000,
      { commitSha: adminSummary.baseCommit },
      undefined,
      adminSummary,
    );
    const adminWaiting = await callMcp(mcpUrl, apiKey, 74, "get_work", { workItemId: adminSubmission.work.workItemId });
    const adminReviewed = await callMcp(mcpUrl, apiKey, 75, "review_work", {
      workItemId: adminSubmission.work.workItemId,
      expectedRevision: adminWaiting.work.stateRevision,
      subjectRevision: adminSubject,
      decision: "accepted",
    });
    const adminCompleted = await callMcp(mcpUrl, adminKey, 76, "approve_work", {
      workItemId: adminSubmission.work.workItemId,
      expectedRevision: adminReviewed.work.stateRevision,
      subjectRevision: adminSubject,
      approvalScope: "work_completion",
      decision: "approved",
    });
    assert.equal(adminCompleted.work.status, "completed");
    const adminStore = new WorkOrchestrationStore(runtimeDb);
    assert.equal(adminStore.listApprovals(adminSubmission.work.workItemId).at(-1)!.role, "admin");
    adminStore.close();

    const publicationSubmission = await callMcp(mcpUrl, apiKey, 77, "submit_work", {
      title: "Publication approval via MCP",
      description: "Prepare a publication artifact and approve only its exact commit",
      idempotencyKey: "mcp-work-publication-approval",
      workflowId: "mcp-write-approval",
      expertId: "ota-write",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-write-default",
    });
    const publicationClaim = tasks.claim("worker-a", 11_000, 30_000, "ota-write")!;
    assert.equal(publicationClaim.taskId, publicationSubmission.currentTask.taskId);
    const publicationSummary = {
      ...approvalSummary,
      contentRevision: "1".repeat(64),
    };
    const publicationWorkspaceSubject = "workspace:" + publicationSummary.contentRevision;
    tasks.complete(
      publicationClaim,
      "publication workspace updated",
      12_000,
      { commitSha: publicationSummary.baseCommit },
      undefined,
      publicationSummary,
    );
    const publicationWaiting = await callMcp(mcpUrl, apiKey, 78, "get_work", {
      workItemId: publicationSubmission.work.workItemId,
    });
    const publicationReviewed = await callMcp(mcpUrl, apiKey, 79, "review_work", {
      workItemId: publicationSubmission.work.workItemId,
      expectedRevision: publicationWaiting.work.stateRevision,
      subjectRevision: publicationWorkspaceSubject,
      decision: "accepted",
    });
    const publicationStore = new WorkPublicationStore(runtimeDb);
    const publication = publicationStore.createOrReusePublication(
      {
        workItemId: publicationSubmission.work.workItemId,
        workAttemptId: publicationReviewed.attempts.at(-1).workAttemptId,
        workspaceId: publicationReviewed.workspace.workspaceId,
        sourceSubjectRevision: publicationWorkspaceSubject,
        baseCommit: publicationSummary.baseCommit,
        repositoryId: "ota-repo",
        repositoryIdentityRevision: 1,
        publicationPolicyRevision: 1,
        branchName: "skillhub/work/mcp-publication-a1",
        pushRemoteName: "origin",
        pushRefspec: "2".repeat(40) + ":refs/heads/skillhub/work/mcp-publication-a1",
        ownerWorkerId: "worker-a",
        commitTimestamp: 1_800_000_000_000,
        commitAuthorName: "Team Skill Hub",
        commitAuthorEmail: "team-skill-hub@local.invalid",
        commitMessage: "Publication approval MCP\n",
        executionSnapshot: {
          workspacePath: "/srv/workspaces/mcp-publication",
          repositoryUrl: "https://example.test/ota.git",
          defaultBranch: "main",
          branchPrefix: "skillhub/work/",
          protectedBranches: ["main"],
          allowedPushRemote: "origin",
          credentialRef: "publish-ref",
          expectedContentRevision: publicationSummary.contentRevision,
          approvedChangeSummary: publicationSummary,
        },
      },
      13_000,
    );
    const preparedPublication = publicationStore.transitionPublication(
      publication.publicationId,
      "prepared",
      {
        commitSha: "2".repeat(40),
        treeSha: "3".repeat(40),
        artifactRef: "publication:" + publication.publicationId,
      },
      13_100,
    );
    publicationStore.close();
    const publicationVisible = await callMcp(mcpUrl, apiKey, 82, "get_work", {
      workItemId: publicationSubmission.work.workItemId,
    });
    assert.deepEqual(publicationVisible.publication, {
      publicationId: preparedPublication.publicationId,
      state: "prepared",
      sourceSubjectRevision: publicationWorkspaceSubject,
      repositoryId: "ota-repo",
      publicationPolicyRevision: 1,
      branchName: "skillhub/work/mcp-publication-a1",
      commitSha: "2".repeat(40),
      treeSha: "3".repeat(40),
      artifactRef: "publication:" + preparedPublication.publicationId,
      approvalState: "pending",
      retryCount: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorContext: null,
      preparedAt: 13_100,
      approvedAt: null,
      pushedAt: null,
    });
    const visibleJson = JSON.stringify(publicationVisible);
    assert.equal(visibleJson.includes("credentialRef"), false);
    assert.equal(visibleJson.includes("publish-ref"), false);
    assert.equal(visibleJson.includes("executionSnapshot"), false);
    const publicationSubject = "publication:" + preparedPublication.publicationId + ":" + preparedPublication.commitSha;

    await assert.rejects(
      () =>
        callMcp(mcpUrl, workerKey, 80, "approve_work", {
          workItemId: publicationSubmission.work.workItemId,
          expectedRevision: publicationReviewed.work.stateRevision,
          subjectRevision: publicationSubject,
          approvalScope: "publish_work_branch",
          decision: "approved",
        }),
      /MCP_TOOL_FORBIDDEN_FOR_PRINCIPAL|WORK_APPROVAL_FORBIDDEN/,
    );
    const publicationApproved = await callMcp(mcpUrl, apiKey, 81, "approve_work", {
      workItemId: publicationSubmission.work.workItemId,
      expectedRevision: publicationReviewed.work.stateRevision,
      subjectRevision: publicationSubject,
      approvalScope: "publish_work_branch",
      decision: "approved",
      actor: "mallory",
      role: "admin",
    });
    assert.equal(publicationApproved.work.status, "waiting_review");
    const publicationCheck = new WorkPublicationStore(runtimeDb);
    assert.equal(publicationCheck.getPublication(preparedPublication.publicationId).state, "approved");
    publicationCheck.close();
    const publicationApprovalStore = new WorkOrchestrationStore(runtimeDb);
    const storedPublicationApproval = publicationApprovalStore
      .listApprovals(publicationSubmission.work.workItemId)
      .at(-1)!;
    assert.equal(storedPublicationApproval.actor, "alice");
    assert.equal(storedPublicationApproval.role, "developer");
    assert.equal(storedPublicationApproval.approvalScope, "publish_work_branch");
    assert.equal(storedPublicationApproval.subjectType, "publication_artifact");
    assert.equal(storedPublicationApproval.subjectRevision, publicationSubject);
    publicationApprovalStore.close();

    const omittedRouteIds = await callMcp(mcpUrl, apiKey, 60, "submit_work", {
      title: "Auto route omitted identifiers",
      description: "Verify Claude optional routing placeholders are treated as omitted",
      idempotencyKey: "mcp-work-omit-route-ids",
      expertId: "ota",
      repositoryId: ":omit:",
      deploymentId: ":omit:",
    });
    assert.equal(omittedRouteIds.work.status, "running");
    assert.equal(omittedRouteIds.work.repositoryId, null);
    assert.equal(omittedRouteIds.work.requestedDeploymentId, null);
    assert.equal(omittedRouteIds.currentTask.deploymentId, "ota-default");
    await callMcp(mcpUrl, apiKey, 61, "cancel_work", {
      workItemId: omittedRouteIds.work.workItemId,
    });

    const unspecifiedRouteIds = await callMcp(mcpUrl, apiKey, 62, "submit_work", {
      title: "Auto route unspecified identifiers",
      description: "Verify Claude unspecified routing placeholders are treated as omitted",
      idempotencyKey: "mcp-work-unspecified-route-ids",
      expertId: "ota",
      repositoryId: "__UNSPECIFIED__",
      deploymentId: "__UNSPECIFIED__",
    });
    assert.equal(unspecifiedRouteIds.work.status, "running");
    assert.equal(unspecifiedRouteIds.work.repositoryId, null);
    assert.equal(unspecifiedRouteIds.work.requestedDeploymentId, null);
    assert.equal(unspecifiedRouteIds.currentTask.deploymentId, "ota-default");
    await callMcp(mcpUrl, apiKey, 63, "cancel_work", {
      workItemId: unspecifiedRouteIds.work.workItemId,
    });

    const autoRoutingIgnoresPlaceholders = await callMcp(mcpUrl, apiKey, 64, "submit_work", {
      title: "Auto routing ignores placeholder route values",
      description: "Auto routing must ignore model-generated placeholder route identifiers",
      idempotencyKey: "mcp-work-auto-routing-placeholder",
      expertId: "ota",
      routingMode: "auto",
      repositoryId: "unspecified",
      deploymentId: "unspecified",
    });
    assert.equal(autoRoutingIgnoresPlaceholders.work.status, "running");
    assert.equal(autoRoutingIgnoresPlaceholders.work.repositoryId, null);
    assert.equal(autoRoutingIgnoresPlaceholders.work.requestedDeploymentId, null);
    assert.equal(autoRoutingIgnoresPlaceholders.currentTask.deploymentId, "ota-default");
    await callMcp(mcpUrl, apiKey, 65, "cancel_work", {
      workItemId: autoRoutingIgnoresPlaceholders.work.workItemId,
    });

    const sourceTerminalSubmission = await callMcp(mcpUrl, apiKey, 801, "submit_work", {
      title: "MCP source terminal",
      description: "validate source terminal cancellation",
      idempotencyKey: "mcp-source-terminal",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const sourceTerminalClaim = tasks.claim("worker-source-terminal", 10_000, 30_000, "ota")!;
    assert.equal(sourceTerminalClaim.taskId, sourceTerminalSubmission.currentTask.taskId);
    const sourceTerminal = await callMcp(mcpUrl, apiKey, 802, "update_work_source", {
      workItemId: sourceTerminalSubmission.work.workItemId,
      sourceControlToken: sourceTerminalSubmission.sourceControlToken,
      state: "terminal",
      detail: "source lifecycle ended",
    });
    assert.equal(sourceTerminal.work.status, "cancelled");
    assert.equal(sourceTerminal.currentTask.status, "running");
    assert.equal(sourceTerminal.currentTask.cancellationRequested, true);
    assert.equal(sourceTerminal.sourceObservations.at(-1).state, "terminal");
    assert.equal(sourceTerminal.sourceObservations.at(-1).reconciliationAction, "cancel");

    const blockedSubmission = await callMcp(mcpUrl, apiKey, 82, "submit_work", {
      title: "Resume blocked OTA work",
      description: "Block on a missing deployment and resume after it is configured",
      idempotencyKey: "mcp-work-resume",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-resume-default",
    });
    assert.equal(blockedSubmission.work.status, "blocked");
    assert.equal(blockedSubmission.work.resumeCondition, "manual");
    assert.ok(Number(blockedSubmission.work.blockedAt) > 0);

    const resumeExperts = new ExpertStore(runtimeDb);
    resumeExperts.putDeployment({
      id: "ota-resume-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    resumeExperts.close();
    const resumedWork = await callMcp(mcpUrl, apiKey, 83, "resume_work", {
      workItemId: blockedSubmission.work.workItemId,
      expectedRevision: blockedSubmission.work.stateRevision,
    });
    assert.equal(resumedWork.work.status, "running");
    assert.equal(resumedWork.work.blockedReason, null);
    assert.ok(resumedWork.currentTask?.taskId);
    await callMcp(mcpUrl, apiKey, 84, "cancel_work", { workItemId: blockedSubmission.work.workItemId });

    const reworkSubmission = await callMcp(mcpUrl, apiKey, 7, "submit_work", {
      title: "Inspect OTA retry",
      description: "Inspect OTA retry path",
      idempotencyKey: "mcp-work-rework",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const reworkTaskId = String(reworkSubmission.currentTask.taskId);
    const reworkClaim = tasks.claim("worker-a", 3_000, 30_000, "ota")!;
    assert.equal(reworkClaim.taskId, reworkTaskId);
    tasks.complete(reworkClaim, "needs more validation", 4_000, { commitSha: "b".repeat(40) });
    const reworkWaiting = await callMcp(mcpUrl, apiKey, 8, "get_work", {
      workItemId: reworkSubmission.work.workItemId,
    });
    assert.equal(reworkWaiting.work.status, "waiting_review");

    const feedback = await callMcp(mcpUrl, apiKey, 9, "submit_expert_task_feedback", {
      taskId: reworkTaskId,
      disposition: "partially_adopted",
      reason: "补验证",
      needsRework: true,
    });
    assert.equal(feedback.feedback.disposition, "partially_adopted");
    assert.equal(feedback.work.attempts.length, 2);
    assert.equal(feedback.work.work.status, "running");
    assert.equal(feedback.work.attempts[1].originWorkAttemptId, feedback.work.attempts[0].workAttemptId);
    assert.equal(feedback.work.attempts[1].whatShouldChange, "补验证");
    assert.equal(feedback.work.attempts[1].createdBy, "alice");

    const cancellable = await callMcp(mcpUrl, apiKey, 10, "submit_work", {
      title: "Cancel OTA work",
      description: "Cancel this OTA work before execution",
      idempotencyKey: "mcp-work-cancel",
      expertId: "ota",
      routingMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-default",
    });
    const cancelled = await callMcp(mcpUrl, apiKey, 11, "cancel_work", {
      workItemId: cancellable.work.workItemId,
    });
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(cancelled.attempts[0].status, "cancelled");
  } finally {
    tasks?.close();
    if (app) await app.close();
    if (oldRuntimeDb === undefined) delete process.env.EXPERT_RUNTIME_DB;
    else process.env.EXPERT_RUNTIME_DB = oldRuntimeDb;
    rmSync(root, { recursive: true, force: true });
  }
});

test("server startup reconciliation advances durable completed work without a client read", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "work-reconcile-server-"));
  const runtimeDb = path.join(root, "runtime.sqlite");
  const dataDir = path.join(root, "app-data");
  const oldRuntimeDb = process.env.EXPERT_RUNTIME_DB;
  const oldInterval = process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;
  process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS = "20";

  let app: Awaited<ReturnType<typeof StartServer>> | undefined;
  let observer: WorkOrchestrationStore | undefined;
  try {
    const experts = new ExpertStore(runtimeDb);
    const tasks = new ExpertTaskStore(runtimeDb);
    const work = new WorkOrchestrationStore(runtimeDb);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota"],
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
    const orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const detail = orchestrator.submitWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "server-reconcile-1",
      sourceType: "mcp",
      title: "Recover completed work",
      description: "observe task completion after server restart",
      expertId: "ota",
      deploymentId: "ota-default",
      repositoryId: "ota-repo",
    });
    const claim = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    tasks.complete(claim, "done before restart", 2_000, { commitSha: "e".repeat(40) });
    work.close();
    tasks.close();
    experts.close();

    const auth = new ApiKeyAuthenticationProvider({
      "work-reconcile-key": { id: "alice", roles: ["developer", "internal"], tenantId: "team-a" },
    });
    const search = new SqliteFtsSearchBackend();
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: [],
      authentication: { mode: "api-key", apiKeys: {} },
      repositories: [],
    };
    const service = new SkillHubApplicationService(
      config,
      [],
      new MemoryRegistryStore(),
      search,
      new SearchRoutingStrategy(search),
      auth,
      new StaticRolePermissionProvider(),
      [],
      new LoggingEventSink(),
    );
    await service.initialize();
    const { startServer } = await import("../src/server.js");
    app = await startServer(config, service);

    observer = new WorkOrchestrationStore(runtimeDb);
    const deadline = Date.now() + 1_500;
    let status = observer.getWork(detail.work.workItemId, "alice", "team-a").status;
    while (status !== "waiting_review" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = observer.getWork(detail.work.workItemId, "alice", "team-a").status;
    }
    assert.equal(status, "waiting_review");
  } finally {
    observer?.close();
    if (app) await app.close();
    if (oldRuntimeDb === undefined) delete process.env.EXPERT_RUNTIME_DB;
    else process.env.EXPERT_RUNTIME_DB = oldRuntimeDb;
    if (oldInterval === undefined) delete process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS;
    else process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS = oldInterval;
    rmSync(root, { recursive: true, force: true });
  }
});

test("server restart resumes one durable verification continuation and preserves one WorkAttempt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "work-verification-restart-"));
  const runtimeDb = path.join(root, "runtime.sqlite");
  const dataDir = path.join(root, "app-data");
  const oldRuntimeDb = process.env.EXPERT_RUNTIME_DB;
  const oldInterval = process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS;
  process.env.EXPERT_RUNTIME_DB = runtimeDb;
  process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS = "20";

  let app: Awaited<ReturnType<typeof StartServer>> | undefined;
  let observerTasks: ExpertTaskStore | undefined;
  let observerWork: WorkOrchestrationStore | undefined;
  try {
    const experts = new ExpertStore(runtimeDb);
    const tasks = new ExpertTaskStore(runtimeDb);
    const work = new WorkOrchestrationStore(runtimeDb);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["ota"],
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
    const baseWorkflow = work.getWorkflow("code-fix-default").definition;
    work.putWorkflow("restart-verified", 1, {
      ...baseWorkflow,
      lifecycle: { ...baseWorkflow.lifecycle, continuation: { maxTurnsPerRun: 2 } },
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
    const orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const detail = orchestrator.submitWork({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "restart-verification-continuation",
      sourceType: "mcp",
      title: "Restart verification continuation",
      description: "resume a failed verifier exactly once after restart",
      workflowId: "restart-verified",
      expertId: "ota",
      deploymentId: "ota-default",
      repositoryId: "ota-repo",
    });
    const attempt = detail.attempts[0]!;
    const workspace = work.getWorkspace(attempt.workspaceId!);
    const revision = "f".repeat(40);
    work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      1_100,
      revision,
    );
    const first = tasks.claim("worker-a", 1_000, 30_000, "ota")!;
    tasks.complete(first, "first run", 2_000, { commitSha: revision }, [
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
    const scheduled = orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 3_000);
    assert.equal(scheduled.work.nextActionType, "continuation");
    assert.equal(scheduled.currentTask!.continuationCount, 0);
    assert.equal(scheduled.attempts.length, 1);
    const taskId = scheduled.currentTask!.taskId;
    work.close();
    tasks.close();
    experts.close();

    const registry = new PersistentWorkerRegistry(path.join(root, "expert-workers.sqlite"));
    registry.enroll("worker-a", ["ota"]);
    registry.approve("worker-a");
    registry.recordHeartbeat("worker-a", Date.now());
    registry.close();

    const auth = new ApiKeyAuthenticationProvider({
      "work-restart-key": { id: "alice", roles: ["developer", "internal"], tenantId: "team-a" },
    });
    const search = new SqliteFtsSearchBackend();
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: [],
      authentication: { mode: "api-key", apiKeys: {} },
      repositories: [],
    };
    const service = new SkillHubApplicationService(
      config,
      [],
      new MemoryRegistryStore(),
      search,
      new SearchRoutingStrategy(search),
      auth,
      new StaticRolePermissionProvider(),
      [],
      new LoggingEventSink(),
    );
    await service.initialize();
    const { startServer } = await import("../src/server.js");
    app = await startServer(config, service);

    observerTasks = new ExpertTaskStore(runtimeDb);
    observerWork = new WorkOrchestrationStore(runtimeDb);
    const requeueDeadline = Date.now() + 1_500;
    let continued = observerTasks.get(taskId, "alice", "team-a");
    while ((continued.status !== "queued" || continued.continuationCount !== 1) && Date.now() < requeueDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continued = observerTasks.get(taskId, "alice", "team-a");
    }
    assert.equal(continued.status, "queued");
    assert.equal(continued.continuationCount, 1);
    assert.equal(observerWork.listAttempts(detail.work.workItemId).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(observerTasks.get(taskId, "alice", "team-a").continuationCount, 1);

    const second = observerTasks.claim("worker-a", Date.now(), 30_000, "ota")!;
    assert.equal(second.taskId, taskId);
    assert.notEqual(second.runId, first.runId);
    observerTasks.complete(second, "second run", Date.now(), { commitSha: revision }, [
      {
        stepId: "unit",
        type: "command",
        evidenceType: "unit_test",
        status: "passed",
        exitCode: 0,
        durationMs: 8,
        errorCode: null,
        subjectRevision: revision,
        environmentIdentity: "worker:worker-a",
        verifierIdentity: "team-skill-hub-worker",
      },
    ]);

    const finishDeadline = Date.now() + 1_500;
    let finalStatus = observerWork.getWork(detail.work.workItemId, "alice", "team-a").status;
    while (finalStatus !== "waiting_review" && Date.now() < finishDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finalStatus = observerWork.getWork(detail.work.workItemId, "alice", "team-a").status;
    }
    assert.equal(finalStatus, "waiting_review");
    assert.equal(observerWork.listAttempts(detail.work.workItemId).length, 1);
    const unitEvidence = observerWork
      .listEvidence(detail.work.workItemId)
      .filter((item) => item.type === "unit_test" && item.subjectRevision === revision);
    assert.equal(unitEvidence.length, 2);
    assert.deepEqual(unitEvidence.map((item) => item.status).sort(), ["failed", "passed"]);
  } finally {
    observerTasks?.close();
    observerWork?.close();
    if (app) await app.close();
    if (oldRuntimeDb === undefined) delete process.env.EXPERT_RUNTIME_DB;
    else process.env.EXPERT_RUNTIME_DB = oldRuntimeDb;
    if (oldInterval === undefined) delete process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS;
    else process.env.EXPERT_WORK_RECONCILE_INTERVAL_MS = oldInterval;
    rmSync(root, { recursive: true, force: true });
  }
});
