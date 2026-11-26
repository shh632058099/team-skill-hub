import assert from "node:assert/strict";
import { test } from "node:test";
import { createExpertWorkerRuntime } from "../src/expert-platform/worker-daemon.js";

test("daemon composes client, Docker executor and one worker iteration", async () => {
  const calls: string[] = [];
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: "/srv/expert-repositories",
      sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: ["OPENAI_API_KEY"],
      modelCredentialEnvNames: {},
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimTask: async () => {
          calls.push("claim");
          return null;
        },
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => calls.push("close"),
      }),
      createExecutor: () => async () => "unused",
    },
  );
  assert.equal(await runtime.runOnce(), false);
  runtime.close();
  assert.deepEqual(calls, ["claim", "close"]);
});

test("daemon forwards executor verification results when completing a task", async () => {
  const verification = [
    {
      stepId: "unit",
      type: "command",
      evidenceType: "unit_test",
      status: "passed" as const,
      exitCode: 0,
      durationMs: 10,
      errorCode: null,
      subjectRevision: "a".repeat(40),
      environmentIdentity: "worker:ota-worker-01",
      verifierIdentity: "team-skill-hub-worker",
    },
  ];
  let completedVerification: unknown;
  const summary = {
    baseCommit: "a".repeat(40),
    changedFiles: ["fixture.txt"],
    addedFiles: [],
    deletedFiles: [],
    diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
    contentRevision: "c".repeat(64),
  };
  let completedSummary: unknown;
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: "/srv/expert-repositories",
      sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: [],
      modelCredentialEnvNames: {},
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimTask: async () => ({
          workerId: "ota-worker-01",
          taskId: "task-1",
          runId: "run-1",
          fencing: 1,
          problem: "verify",
        }),
        renewLease: async () => undefined,
        completeTask: async (_claim, _result, _source, verificationResults, workspaceChangeSummary) => {
          completedVerification = verificationResults;
          completedSummary = workspaceChangeSummary;
        },
        failTask: async () => undefined,
        close: () => undefined,
      }),
      createExecutor: () => async () => ({
        result: "done",
        source: { commitSha: "a".repeat(40) },
        verificationResults: verification,
        workspaceChangeSummary: summary,
      }),
    },
  );

  assert.equal(await runtime.runOnce(), true);
  assert.deepEqual(completedVerification, verification);
  assert.deepEqual(completedSummary, summary);
  runtime.close();
});

test("daemon strips tool/count metadata from model activity before reporting to Hub", async () => {
  const reports: Array<{
    stage: string;
    details?: string;
    activity?: { sequence: number; tool?: string; count?: number };
  }> = [];
  let onActivity:
    | ((claim: any, stage: string, sequence: number, tool?: string, count?: number, details?: string) => Promise<void>)
    | undefined;
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: "/srv/expert-repositories",
      sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: [],
      modelCredentialEnvNames: {},
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimTask: async () => null,
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        reportTaskStage: async (
          _claim,
          stage,
          _details,
          activity?: { sequence: number; tool?: string; count?: number },
        ) => {
          reports.push({ stage, ...(_details ? { details: _details } : {}), ...(activity ? { activity } : {}) });
        },
        close: () => undefined,
      }),
      createExecutor: (options) => {
        onActivity = options.onActivity;
        return async () => "unused";
      },
    },
  );

  assert.equal(typeof onActivity, "function");
  const claim = { workerId: "ota-worker-01", taskId: "task-1", runId: "run-1", fencing: 1, problem: "x" };
  await onActivity!(claim, "model.started", 1, undefined, 1);
  await onActivity!(claim, "model.output", 2, undefined, 1, "Analyzing retry path");
  await onActivity!(claim, "tool.activity", 3, "Read", 3);
  await onActivity!(claim, "model.completed", 4, undefined, 1);
  assert.deepEqual(reports, [
    { stage: "model.started", activity: { sequence: 1 } },
    { stage: "model.output", details: "Analyzing retry path", activity: { sequence: 2 } },
    { stage: "tool.activity", activity: { sequence: 3, tool: "Read", count: 3 } },
    { stage: "model.completed", activity: { sequence: 4 } },
  ]);
  runtime.close();
});

test("daemon processes owner workspace cleanup before claiming another task", async () => {
  const { mkdtemp, mkdir, stat } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-cleanup-"));
  const workspaceKey = "work-11111111-a1";
  await mkdir(path.join(root, workspaceKey));
  const calls: string[] = [];
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: root,
      sharedTempRoot: path.join(root, ".runtime-tmp"),
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: [],
      modelCredentialEnvNames: {},
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimWorkspaceCleanup: async () => {
          calls.push("cleanup-claim");
          return { workspaceId: "workspace-1", workspaceKey, ownerWorkerId: "ota-worker-01", fencing: 1 };
        },
        completeWorkspaceCleanup: async (_claim, success) => {
          calls.push("cleanup-complete:" + String(success));
        },
        claimTask: async () => {
          calls.push("task-claim");
          return null;
        },
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => calls.push("close"),
      }),
      createExecutor: () => async () => "unused",
    },
  );

  assert.equal(await runtime.runOnce(), true);
  await assert.rejects(stat(path.join(root, workspaceKey)));
  assert.deepEqual(calls, ["cleanup-claim", "cleanup-complete:true"]);
  runtime.close();
});

test("daemon forwards runtime configuration to Docker executor factory", () => {
  let seen: unknown;
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: "/srv/expert-repositories",
      sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "unconfined",
      codexAuthFilePath: "/etc/expert/auth.json",
      codexConfigFilePath: "/etc/expert/provider.toml",
      modelEnvNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
      modelCredentialEnvNames: { "ai-router-default": "OPENAI_API_KEY" },
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 90_000,
      verificationTmpfsMb: 2048,
    },
    {
      createClient: () => ({
        claimTask: async () => null,
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => undefined,
      }),
      createExecutor: (options) => {
        seen = options;
        return async () => "unused";
      },
    },
  );
  assert.equal(typeof (seen as { onStage?: unknown })?.onStage, "function");
  const { onStage: _onStage, onActivity: _onActivity, ...configuration } = seen as Record<string, unknown>;
  assert.deepEqual(configuration, {
    image: "expert-worker",
    sourcePath: "/srv/ota",
    repositoryRoot: "/srv/expert-repositories",
    sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
    gitCredentialConfigs: {},
    network: "expert-egress",
    seccompProfile: "unconfined",
    envNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
    modelCredentialEnvNames: { "ai-router-default": "OPENAI_API_KEY" },
    authFilePath: "/etc/expert/auth.json",
    configFilePath: "/etc/expert/provider.toml",
    timeoutMs: 90_000,
    verificationTmpfsMb: 2048,
  });
  runtime.close();
});

test("daemon processes owner publication operation before claiming another task", async () => {
  const calls: string[] = [];
  const lease = {
    publicationId: "pub-1",
    ownerWorkerId: "ota-worker-01",
    operation: "prepare" as const,
    fencing: 3,
    workspaceId: "workspace-1",
    branchName: "skillhub/work/work1-a1",
    sourceSubjectRevision: "workspace:" + "a".repeat(64),
    baseCommit: "b".repeat(40),
    commitSha: null,
    treeSha: null,
    artifactRef: null,
    pushRefspec: null,
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
      allowedPushRemote: "origin" as const,
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
  };
  let completed: unknown;
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: "/srv/expert-repositories",
      sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: [],
      modelCredentialEnvNames: {},
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimPublicationOperation: async () => {
          calls.push("publication-claim");
          return lease;
        },
        completePublicationOperation: async (_claim: any, result: any) => {
          calls.push("publication-complete");
          completed = result;
        },
        claimTask: async () => {
          calls.push("task-claim");
          return null;
        },
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => undefined,
      }),
      createExecutor: () => async () => "unused",
      preparePublication: async (input: any) => {
        calls.push("publication-prepare:" + input.workspacePath);
        return { branchName: input.branchName, commitSha: "c".repeat(40), treeSha: "d".repeat(40) };
      },
    } as any,
  );

  assert.equal(await runtime.runOnce(), true);
  assert.deepEqual(calls, ["publication-claim", "publication-prepare:/srv/workspaces/work1", "publication-complete"]);
  assert.deepEqual(completed, {
    success: true,
    commitSha: "c".repeat(40),
    treeSha: "d".repeat(40),
    artifactRef: "publication:pub-1",
    pushRefspec: "c".repeat(40) + ":refs/heads/skillhub/work/work1-a1",
  });
  runtime.close();
});
test("daemon creates a change request on the host before claiming another task", async () => {
  const calls: string[] = [];
  let completed: unknown;
  const lease = {
    changeRequestId: "cr-1",
    ownerWorkerId: "ota-worker-01",
    fencing: 2,
    repositoryIdentity: "repo-1@7",
    repositoryUrl: "https://github.com/example/project.git",
    headBranch: "tsh/work-a1",
    headCommit: "c".repeat(40),
    baseBranch: "main",
    title: "Fix publication",
    body: "Generated by Team Skill Hub",
    idempotencyKey: "publication:pub-1",
    credentialGrantRef: "publish-token",
  };
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      repositoryRoot: "/srv/expert-repositories",
      sharedTempRoot: "/srv/expert-repositories/ota-worker-01/.runtime-tmp",
      gitCredentialConfigs: {},
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: [],
      modelCredentialEnvNames: {},
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimPublicationOperation: async () => {
          calls.push("publication-claim");
          return null;
        },
        completePublicationOperation: async () => undefined,
        claimChangeRequestOperation: async () => {
          calls.push("change-request-claim");
          return lease;
        },
        completeChangeRequestOperation: async (_claim: any, result: any) => {
          calls.push("change-request-complete");
          completed = result;
        },
        claimTask: async () => {
          calls.push("task-claim");
          return null;
        },
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => undefined,
      }),
      createExecutor: () => async () => "unused",
      createChangeRequestProvider: () => ({
        create: async (input: any) => {
          calls.push("provider-create:" + input.headBranch);
          return {
            provider: "github",
            externalId: "17",
            url: "https://github.com/example/project/pull/17",
            headCommit: input.headCommit,
            baseBranch: input.baseBranch,
          };
        },
      }),
    } as any,
  );

  assert.equal(await runtime.runOnce(), true);
  assert.deepEqual(calls, [
    "publication-claim",
    "change-request-claim",
    "provider-create:tsh/work-a1",
    "change-request-complete",
  ]);
  assert.deepEqual(completed, {
    success: true,
    provider: "github",
    externalId: "17",
    url: "https://github.com/example/project/pull/17",
    headCommit: "c".repeat(40),
    baseBranch: "main",
  });
  runtime.close();
});
