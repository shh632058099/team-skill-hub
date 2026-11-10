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
        completeTask: async (_claim, _result, _source, verificationResults) => {
          completedVerification = verificationResults;
        },
        failTask: async () => undefined,
        close: () => undefined,
      }),
      createExecutor: () => async () => ({
        result: "done",
        source: { commitSha: "a".repeat(40) },
        verificationResults: verification,
      }),
    },
  );

  assert.equal(await runtime.runOnce(), true);
  assert.deepEqual(completedVerification, verification);
  runtime.close();
});

test("daemon strips tool/count metadata from model activity before reporting to Hub", async () => {
  const reports: Array<{ stage: string; activity?: { sequence: number; tool?: string; count?: number } }> = [];
  let onActivity:
    ((claim: any, stage: string, sequence: number, tool?: string, count?: number) => Promise<void>) | undefined;
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
          reports.push({ stage, ...(activity ? { activity } : {}) });
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
  await onActivity!(claim, "tool.activity", 2, "Read", 3);
  await onActivity!(claim, "model.completed", 3, undefined, 1);
  assert.deepEqual(reports, [
    { stage: "model.started", activity: { sequence: 1 } },
    { stage: "tool.activity", activity: { sequence: 2, tool: "Read", count: 3 } },
    { stage: "model.completed", activity: { sequence: 3 } },
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
  });
  runtime.close();
});
