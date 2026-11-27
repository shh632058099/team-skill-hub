import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { ExpertWorkerClient, startExpertWorkerGrpcServer } from "../src/expert-platform/grpc-transport.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";

test("approved remote worker claims, renews and completes over real gRPC TCP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-1", ["ota"]);
    workers.approve("worker-1");
    const token = workers.issueCredential("worker-1");
    const submitted = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc",
      problem: "investigate OTA failure",
      expertId: "ota",
      workspaceKey: "grpc-work-a1",
      executionWorkspaceAccess: "read-only",
    });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token });
    const claim = await client.claimTask("worker-1", "ota");
    assert.equal(claim?.problem, "investigate OTA failure");
    assert.equal(claim?.taskId, submitted.taskId);
    assert.equal(claim?.executionWorkspaceAccess, "read-only");
    await client.renewLease(claim!);
    await client.reportTaskStage(claim!, "repository.started");
    await client.reportTaskStage(claim!, "repository.completed");
    await client.reportTaskStage(claim!, "tool.activity", "", { sequence: 1, tool: "Read", count: 3 });
    await client.reportTaskStage(claim!, "tool.activity", "", { sequence: 1, tool: "Read", count: 3 });
    await client.reportTaskStage(claim!, "model.output", "Investigating retry path. api_key=secret-token", {
      sequence: 2,
    });
    await assert.rejects(
      () => client.reportTaskStage(claim!, "tool.activity", "", { sequence: 1, tool: "Read", count: 4 }),
      /PROGRESS_SEQUENCE_CONFLICT/,
    );
    const observed = tasks.ownerEvents(submitted.taskId, "alice", "org", 0, 50);
    assert.equal(observed.events.filter((event) => event.type === "tool.activity").length, 1);
    assert.equal(
      observed.events.find((event) => event.type === "model.output")?.details,
      "Investigating retry path. api_key=[REDACTED]",
    );

    await assert.rejects(() => client.reportTaskStage(claim!, "codex.started", "Bearer secret"), /INVALID_STAGE_EVENT/);
    await client.completeTask(
      claim!,
      "verified root cause",
      {
        repositoryUrl: "https://github.com/example/ota.git",
        repositoryBranch: "release",
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      },
      undefined,
      undefined,
      "99999999-9999-4999-8999-999999999999",
    );
    const completed = tasks.get(submitted.taskId, "alice", "org");
    assert.equal(completed.result, "verified root cause");
    assert.ok(
      tasks
        .adminTaskDetail(submitted.taskId)
        ?.events.some((event) => (event as any).event_type === "repository.started"),
    );
    assert.equal(completed.repositoryUrl, "https://github.com/example/ota.git");
    assert.equal(completed.repositoryBranch, "release");
    assert.equal(completed.commitSha, "abcdef0123456789abcdef0123456789abcdef01");
    assert.equal(completed.runtimeSessionId, "99999999-9999-4999-8999-999999999999");

    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gRPC failure transports safe run diagnostics to admin detail", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-diag-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-1", ["ota"]);
    workers.approve("worker-1");
    const token = workers.issueCredential("worker-1");
    const submitted = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc-diag",
      problem: "debug provider failure",
      expertId: "ota",
    });
    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token });
    const claim = await client.claimTask("worker-1", "ota");
    assert.ok(claim);
    await client.failTask(claim!, "MODEL_RATE_LIMITED", {
      errorCode: "MODEL_RATE_LIMITED",
      backend: "claude",
      exitCode: 1,
      httpStatus: 429,
      requestId: "req-grpc",
      endpointHost: "anthropic.example.test",
      message: "rate limited",
    });
    const run = (tasks.adminTaskDetail(submitted.taskId)!.runs as Array<{ diagnostic?: unknown }>)[0];
    assert.deepEqual(run?.diagnostic, {
      errorCode: "MODEL_RATE_LIMITED",
      backend: "claude",
      exitCode: 1,
      httpStatus: 429,
      requestId: "req-grpc",
      endpointHost: "anthropic.example.test",
      message: "rate limited",
    });
    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace.ready updates the durable Workspace and stale reports are fenced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-workspace-"));
  try {
    const runtimeDb = path.join(dir, "runtime.sqlite");
    const tasks = new ExpertTaskStore(runtimeDb);
    const work = new WorkOrchestrationStore(runtimeDb);
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-1", ["ota"]);
    workers.approve("worker-1");
    const token = workers.issueCredential("worker-1");

    const item = work.createOrReuseWork({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc-workspace",
      sourceType: "mcp",
      title: "Workspace report",
      description: "report workspace",
    });
    const attempt = work.createWorkAttempt(item.workItemId, "alice", "org", item.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = work.ensureWorkspace(item.workItemId, attempt.workAttemptId, {
      repositoryUrl: "https://example.test/ota.git",
      branch: "main",
    });
    const task = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc-workspace-task",
      problem: "inspect",
      expertId: "ota",
      workItemId: item.workItemId,
      workAttemptId: attempt.workAttemptId,
      workflowId: attempt.workflowId,
      workflowVersion: attempt.workflowVersion,
      workspaceKey: workspace.workspaceKey,
      validationSnapshot: [
        {
          id: "unit-test",
          type: "command",
          argv: ["npm", "test"],
          timeoutMs: 120_000,
          evidenceType: "unit_test",
        },
      ],
    });
    work.linkAttemptTask(attempt.workAttemptId, task.taskId);

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0", { workStore: work });
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token }, {
      supportedWorkspacePermissionModels: ["shared-gid-v1", "single-uid-v2"],
    } as any);
    const claim = await client.claimTask("worker-1", "ota");
    assert.equal(claim?.workspaceKey, workspace.workspaceKey);
    assert.equal((claim as any)?.workspacePermissionModel, "single-uid-v2");
    assert.equal((claim as any)?.workspaceOwnerUid, null);
    assert.equal((claim as any)?.workspaceOwnerGid, null);
    const selectedBeforeReady = tasks.getByIdempotency("alice", "org", "grpc-workspace-task");
    assert.equal((selectedBeforeReady as any)?.workspacePermissionModel, "single-uid-v2");
    assert.equal((selectedBeforeReady as any)?.workspaceOwnerUid, null);
    assert.equal((selectedBeforeReady as any)?.workspaceOwnerGid, null);
    assert.deepEqual(claim?.validationSnapshot, [
      {
        id: "unit-test",
        type: "command",
        argv: ["npm", "test"],
        timeoutMs: 120_000,
        evidenceType: "unit_test",
      },
    ]);

    await client.reportTaskStage(
      claim!,
      "workspace.ready",
      JSON.stringify({
        workspaceKey: workspace.workspaceKey,
        path: "/srv/expert/workspaces/" + workspace.workspaceKey,
        commitSha: "a".repeat(40),
        permissionModel: "single-uid-v2",
        ownerUid: 999,
        ownerGid: 988,
      }),
    );
    const ready = work.getWorkspace(workspace.workspaceId);
    assert.equal(ready.state, "ready");
    assert.equal(ready.ownerWorkerId, "worker-1");
    assert.equal(ready.path, "/srv/expert/workspaces/" + workspace.workspaceKey);
    assert.equal(ready.baseCommit, "a".repeat(40));
    assert.equal((ready as any).permissionModel, "single-uid-v2");
    assert.equal((ready as any).ownerUid, 999);
    assert.equal((ready as any).ownerGid, 988);

    await client.completeTask(claim!, "done");

    const followup = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc-workspace-v2-followup",
      problem: "review existing workspace",
      expertId: "ota",
      workspaceKey: workspace.workspaceKey,
      workspacePermissionModel: "single-uid-v2",
      workspaceOwnerUid: 999,
      workspaceOwnerGid: 988,
    } as any);
    const legacyClient = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token });
    assert.equal(await legacyClient.claimTask("worker-1", "ota"), null);
    legacyClient.close();

    const v2Claim = await client.claimTask("worker-1", "ota");
    assert.equal(v2Claim?.taskId, followup.taskId);
    assert.equal((v2Claim as any)?.workspacePermissionModel, "single-uid-v2");
    assert.equal((v2Claim as any)?.workspaceOwnerUid, 999);
    assert.equal((v2Claim as any)?.workspaceOwnerGid, 988);
    await client.completeTask(v2Claim!, "done");
    await assert.rejects(
      () =>
        client.reportTaskStage(
          claim!,
          "workspace.ready",
          JSON.stringify({
            workspaceKey: workspace.workspaceKey,
            path: "/srv/expert/workspaces/" + workspace.workspaceKey,
            commitSha: "b".repeat(40),
          }),
        ),
      /STALE_ATTEMPT/,
    );

    client.close();
    await server.close();
    work.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup client treats old Hub responses without permission identity as shared-gid-v1", async () => {
  const client = new ExpertWorkerClient("127.0.0.1:1", { workerId: "worker-old-hub", credential: "token" });
  const raw = (client as any).client;
  raw.ClaimWorkspaceCleanup = (...args: any[]) => {
    const callback = args.at(-1);
    callback(null, {
      has_cleanup: true,
      workspace_id: "workspace-old",
      workspace_key: "work-old-a1",
      fencing: "1",
    });
  };
  try {
    const cleanup = await client.claimWorkspaceCleanup("worker-old-hub");
    assert.equal(cleanup?.permissionModel, "shared-gid-v1");
    assert.equal(cleanup?.ownerUid, null);
    assert.equal(cleanup?.ownerGid, null);
  } finally {
    client.close();
  }
});

test("workspace cleanup RPC is owner-scoped and fenced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-cleanup-"));
  try {
    const runtimeDb = path.join(dir, "runtime.sqlite");
    const tasks = new ExpertTaskStore(runtimeDb);
    const work = new WorkOrchestrationStore(runtimeDb);
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    for (const id of ["worker-a", "worker-b"]) {
      workers.enroll(id, ["ota"]);
      workers.approve(id);
    }
    const tokenA = workers.issueCredential("worker-a");
    const tokenB = workers.issueCredential("worker-b");
    const item = work.createOrReuseWork({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc-cleanup",
      sourceType: "mcp",
      title: "cleanup",
      description: "cleanup",
    });
    const attempt = work.createWorkAttempt(item.workItemId, "alice", "org", item.stateRevision, {
      reason: "initial",
      expertId: "ota",
      deploymentId: "ota-default",
      deploymentConfigVersion: 1,
    });
    const workspace = work.ensureWorkspace(item.workItemId, attempt.workAttemptId, {});
    work.assignWorkspaceOwner(
      workspace.workspaceId,
      "worker-a",
      "/srv/workspaces/" + workspace.workspaceKey,
      100,
      "a".repeat(40),
      { permissionModel: "single-uid-v2", ownerUid: 999, ownerGid: 988 },
    );
    work.requestTerminalWorkspaceCleanup(item.workItemId, 200);

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0", { workStore: work });
    const clientB = new ExpertWorkerClient(server.address, { workerId: "worker-b", credential: tokenB });
    assert.equal(await clientB.claimWorkspaceCleanup("worker-b"), null);

    const clientA = new ExpertWorkerClient(server.address, { workerId: "worker-a", credential: tokenA });
    const cleanup = await clientA.claimWorkspaceCleanup("worker-a");
    assert.equal(cleanup?.workspaceId, workspace.workspaceId);
    assert.equal((cleanup as any)?.permissionModel, "single-uid-v2");
    assert.equal((cleanup as any)?.ownerUid, 999);
    assert.equal((cleanup as any)?.ownerGid, 988);
    await clientA.completeWorkspaceCleanup(cleanup!, true);
    assert.equal(work.getWorkspace(workspace.workspaceId).state, "removed");
    await assert.rejects(() => clientA.completeWorkspaceCleanup(cleanup!, true), /STALE_WORKSPACE_CLEANUP/);

    clientA.close();
    clientB.close();
    await server.close();
    work.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unapproved worker is rejected before task claim", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-pending", ["ota"]);
    tasks.submit({ principalId: "alice", scope: "org", idempotencyKey: "grpc", problem: "investigate OTA failure" });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-pending", credential: "invalid" });
    await assert.rejects(() => client.claimTask("worker-pending", "ota"), /WORKER_UNAUTHENTICATED/);

    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker can only claim tasks targeted to its authorized expert capability", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-filter-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("ota-worker", ["ota"]);
    workers.approve("ota-worker");
    const token = workers.issueCredential("ota-worker");
    tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "yocto-only",
      problem: "inspect yocto build",
      expertId: "yocto",
    });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, {
      workerId: "ota-worker",
      credential: token,
    });

    assert.equal(await client.claimTask("ota-worker", "ota"), null);

    const ota = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "ota-only",
      problem: "inspect ota update",
      expertId: "ota",
    });
    const claim = await client.claimTask("ota-worker", "ota");
    assert.equal(claim?.taskId, ota.taskId);

    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gRPC completion transports workspace change summary durably", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-write-summary-"));
  try {
    const runtimeDb = path.join(dir, "runtime.sqlite");
    const tasks = new ExpertTaskStore(runtimeDb);
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-write", ["ota"]);
    workers.approve("worker-write");
    const token = workers.issueCredential("worker-write");
    const submitted = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc-write-summary",
      problem: "modify",
      expertId: "ota",
    });
    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-write", credential: token });
    const claim = await client.claimTask("worker-write", "ota", "ota");
    assert.ok(claim);
    const summary = {
      baseCommit: "a".repeat(40),
      changedFiles: ["fixture.txt"],
      addedFiles: [],
      deletedFiles: [],
      diffStat: { filesChanged: 1, insertions: 1, deletions: 1 },
      contentRevision: "d".repeat(64),
    };
    const verification = [
      {
        stepId: "unit",
        type: "command",
        evidenceType: "unit_test",
        status: "passed" as const,
        exitCode: 0,
        durationMs: 5,
        errorCode: null,
        subjectRevision: "workspace:" + summary.contentRevision,
        environmentIdentity: "worker:worker-write",
        verifierIdentity: "team-skill-hub-worker",
      },
    ];
    await client.completeTask(claim!, "done", { commitSha: summary.baseCommit }, verification, summary);
    assert.deepEqual(tasks.get(submitted.taskId, "alice", "org").workspaceChangeSummary, summary);
    client.close();
    await server.close();
    tasks.close();
    workers.close();

    const reopened = new ExpertTaskStore(runtimeDb);
    assert.deepEqual(reopened.get(submitted.taskId, "alice", "org").workspaceChangeSummary, summary);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publication operation RPC is owner-scoped and fenced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-publication-"));
  try {
    const runtimeDb = path.join(dir, "runtime.sqlite");
    const tasks = new ExpertTaskStore(runtimeDb);
    const work = new WorkOrchestrationStore(runtimeDb);
    const { WorkPublicationStore } = await import("../src/expert-platform/work-publication-store.js");
    const publications = new WorkPublicationStore(runtimeDb);
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    for (const id of ["worker-a", "worker-b"]) {
      workers.enroll(id, ["ota"]);
      workers.approve(id);
    }
    const tokenA = workers.issueCredential("worker-a");
    const tokenB = workers.issueCredential("worker-b");
    const publication = publications.createOrReusePublication({
      workItemId: "work-1",
      workAttemptId: "attempt-1",
      workspaceId: "workspace-1",
      sourceSubjectRevision: "workspace:" + "a".repeat(64),
      baseCommit: "b".repeat(40),
      repositoryId: "repo-1",
      repositoryIdentityRevision: 2,
      publicationPolicyRevision: 3,
      branchName: "skillhub/work/work1-a1",
      pushRemoteName: "origin",
      ownerWorkerId: "worker-a",
      commitTimestamp: 1_800_000_000_000,
      commitAuthorName: "Team Skill Hub",
      commitAuthorEmail: "team-skill-hub@local.invalid",
      commitMessage: "Fix\n",
      executionSnapshot: {
        workspacePath: "/srv/workspaces/work1",
        repositoryUrl: "/srv/remotes/ota.git",
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
    } as any);

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0", {
      workStore: work,
      publicationStore: publications,
    } as any);
    const clientB = new ExpertWorkerClient(server.address, { workerId: "worker-b", credential: tokenB });
    assert.equal(await clientB.claimPublicationOperation("worker-b"), null);

    const clientA = new ExpertWorkerClient(server.address, { workerId: "worker-a", credential: tokenA });
    const claim = await clientA.claimPublicationOperation("worker-a");
    assert.equal(claim?.publicationId, publication.publicationId);
    assert.equal(claim?.operation, "prepare");
    assert.equal(claim?.executionSnapshot?.workspacePath, "/srv/workspaces/work1");
    await clientA.completePublicationOperation(claim!, {
      success: true,
      commitSha: "c".repeat(40),
      treeSha: "d".repeat(40),
      artifactRef: "publication:" + publication.publicationId,
      pushRefspec: "c".repeat(40) + ":refs/heads/skillhub/work/work1-a1",
    });
    assert.equal(publications.getPublication(publication.publicationId).state, "prepared");
    await assert.rejects(
      () =>
        clientA.completePublicationOperation(claim!, {
          success: true,
          commitSha: "c".repeat(40),
          treeSha: "d".repeat(40),
          artifactRef: "publication:" + publication.publicationId,
          pushRefspec: "c".repeat(40) + ":refs/heads/skillhub/work/work1-a1",
        }),
      /STALE_PUBLICATION_OPERATION/,
    );

    clientA.close();
    clientB.close();
    await server.close();
    publications.close();
    work.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("change request operation RPC is owner-scoped and fenced", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-change-request-"));
  try {
    const runtimeDb = path.join(dir, "runtime.sqlite");
    const tasks = new ExpertTaskStore(runtimeDb);
    const { WorkChangeRequestStore } = await import("../src/expert-platform/work-change-request-store.js");
    const changeRequests = new WorkChangeRequestStore(runtimeDb);
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    for (const id of ["worker-a", "worker-b"]) {
      workers.enroll(id, ["ota"]);
      workers.approve(id);
    }
    const tokenA = workers.issueCredential("worker-a");
    const tokenB = workers.issueCredential("worker-b");
    const record = changeRequests.createOrReuse({
      workItemId: "work-1",
      workAttemptId: "attempt-1",
      publicationId: "pub-1",
      ownerWorkerId: "worker-a",
      repositoryIdentity: "repo-1@7",
      repositoryUrl: "https://github.com/example/project.git",
      headBranch: "tsh/work-a1",
      headCommit: "c".repeat(40),
      baseBranch: "main",
      title: "Fix",
      body: "Generated",
      idempotencyKey: "publication:pub-1",
      credentialGrantRef: "publish-token",
    });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0", {
      changeRequestStore: changeRequests,
    });
    const clientB = new ExpertWorkerClient(server.address, { workerId: "worker-b", credential: tokenB });
    assert.equal(await clientB.claimChangeRequestOperation("worker-b"), null);

    const clientA = new ExpertWorkerClient(server.address, { workerId: "worker-a", credential: tokenA });
    const claim = await clientA.claimChangeRequestOperation("worker-a");
    assert.equal(claim?.changeRequestId, record.changeRequestId);
    assert.equal(claim?.headCommit, "c".repeat(40));
    await clientA.completeChangeRequestOperation(claim!, {
      success: true,
      provider: "github",
      externalId: "17",
      url: "https://github.com/example/project/pull/17",
      headCommit: "c".repeat(40),
      baseBranch: "main",
    });
    assert.equal(changeRequests.get(record.changeRequestId).state, "created");
    await assert.rejects(
      () =>
        clientA.completeChangeRequestOperation(claim!, {
          success: true,
          provider: "github",
          externalId: "17",
          url: "https://github.com/example/project/pull/17",
          headCommit: "c".repeat(40),
          baseBranch: "main",
        }),
      /STALE_CHANGE_REQUEST_OPERATION/,
    );

    clientA.close();
    clientB.close();
    await server.close();
    changeRequests.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
