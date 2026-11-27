import { readFileSync } from "node:fs";
import { createDockerAgentExecutor, type DockerAgentExecutorOptions } from "./docker-agent-executor.js";
import { ExpertWorkerClient } from "./grpc-transport.js";
import { runRemoteWorkerOnce, type RemoteWorkerClient } from "./remote-worker.js";
import type { ExpertWorkerRuntimeConfig } from "./worker-runtime-config.js";
import { removeWorkspaceDirectory } from "./workspace-cleanup.js";
import {
  prepareGitPublication,
  pushGitPublication,
  type PrepareGitPublicationInput,
  type PreparedGitPublication,
  type PushGitPublicationInput,
  type PushGitPublicationResult,
} from "./git-publication-executor.js";
import { createGitChangeRequestProvider } from "./git-change-request-provider.js";
import type { ChangeRequestProvider } from "./change-request-provider.js";
import { assertWorkspaceProcessIdentity, supportsSingleUidWorkspace } from "./workspace-process-identity.js";

interface ClosableRemoteWorkerClient extends RemoteWorkerClient {
  close(): void;
}

export interface ExpertWorkerRuntimeDependencies {
  createClient?: (config: ExpertWorkerRuntimeConfig) => ClosableRemoteWorkerClient;
  createExecutor?: (options: DockerAgentExecutorOptions) => ReturnType<typeof createDockerAgentExecutor>;
  preparePublication?: (input: PrepareGitPublicationInput) => Promise<PreparedGitPublication>;
  pushPublication?: (input: PushGitPublicationInput) => Promise<PushGitPublicationResult>;
  createChangeRequestProvider?: (
    repositoryUrl: string,
    credentials: ExpertWorkerRuntimeConfig["gitCredentialConfigs"],
  ) => ChangeRequestProvider;
  workerIdentity?: { uid: number; gid: number };
}

export function workspacePermissionModelsForWorkerIdentity(identity: {
  uid: number;
  gid: number;
}): Array<"shared-gid-v1" | "single-uid-v2"> {
  return supportsSingleUidWorkspace(identity) ? ["shared-gid-v1", "single-uid-v2"] : ["shared-gid-v1"];
}

export function createExpertWorkerRuntime(
  config: ExpertWorkerRuntimeConfig,
  dependencies: ExpertWorkerRuntimeDependencies = {},
): { runOnce(): Promise<boolean>; close(): void } {
  const workerIdentity = dependencies.workerIdentity ?? {
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
  };
  const supportedWorkspacePermissionModels = workspacePermissionModelsForWorkerIdentity(workerIdentity);
  const tls =
    config.tlsCaPath && config.tlsCertPath && config.tlsKeyPath
      ? {
          ca: readFileSync(config.tlsCaPath),
          cert: readFileSync(config.tlsCertPath),
          key: readFileSync(config.tlsKeyPath),
        }
      : undefined;
  const client =
    dependencies.createClient?.(config) ??
    new ExpertWorkerClient(
      config.hubAddress,
      {
        workerId: config.workerId,
        credential: config.workerCredential,
      },
      {
        ...(tls ? { tls } : {}),
        supportedBackend: config.executorBackend,
        supportedRuntimeProfiles: config.supportedRuntimeProfiles ?? [],
        supportedWorkspacePermissionModels,
      },
    );
  let modelAttemptSequenceOffset = 0;
  const onActivity: NonNullable<DockerAgentExecutorOptions["onActivity"]> = async (
    claim,
    stage,
    sequence,
    tool,
    count,
    details,
  ) => {
    const activity =
      stage === "tool.activity"
        ? {
            sequence: sequence + modelAttemptSequenceOffset,
            ...(tool ? { tool } : {}),
            ...(count === undefined ? {} : { count }),
          }
        : { sequence: sequence + modelAttemptSequenceOffset };
    await client.reportTaskStage?.(claim, stage, details ?? "", activity);
  };

  const executor =
    dependencies.createExecutor?.({
      image: config.dockerImage,
      ...(config.executorBackend ? { backend: config.executorBackend } : {}),
      ...(config.executorBackend === "claude"
        ? { claudeModel: config.claudeModel ?? "sonnet", claudeMaxTurns: config.claudeMaxTurns ?? 100 }
        : {}),
      sourcePath: config.sourcePath,
      repositoryRoot: config.repositoryRoot,
      sharedTempRoot: config.sharedTempRoot,
      gitCredentialConfigs: config.gitCredentialConfigs,
      network: config.dockerNetwork,
      seccompProfile: config.dockerSeccompProfile,
      envNames: config.modelEnvNames,
      modelCredentialEnvNames: config.modelCredentialEnvNames,
      ...(config.mcpCredentialFiles ? { mcpCredentialFiles: config.mcpCredentialFiles } : {}),
      ...(config.mcpDefaultUrl ? { mcpDefaultUrl: config.mcpDefaultUrl } : {}),
      ...(config.codexAuthFilePath ? { authFilePath: config.codexAuthFilePath } : {}),
      ...(config.codexConfigFilePath ? { configFilePath: config.codexConfigFilePath } : {}),
      timeoutMs: config.taskTimeoutMs,
      workerIdentity,
      verificationTmpfsMb: config.verificationTmpfsMb ?? 1024,
      ...(config.taskIdleTimeoutMs !== undefined ? { idleTimeoutMs: config.taskIdleTimeoutMs } : {}),
      onActivity,
      onStage: async (claim, stage, details) => {
        if (stage === "workspace.ready") {
          if (!client.reportTaskStage) throw new Error("WORKSPACE_REPORT_UNAVAILABLE");
          await client.reportTaskStage(claim, stage, details);
          return;
        }
        try {
          await client.reportTaskStage?.(claim, stage, details);
        } catch {
          /* Best effort */
        }
      },
    }) ??
    createDockerAgentExecutor({
      image: config.dockerImage,
      ...(config.executorBackend ? { backend: config.executorBackend } : {}),
      ...(config.executorBackend === "claude"
        ? { claudeModel: config.claudeModel ?? "sonnet", claudeMaxTurns: config.claudeMaxTurns ?? 100 }
        : {}),
      sourcePath: config.sourcePath,
      repositoryRoot: config.repositoryRoot,
      sharedTempRoot: config.sharedTempRoot,
      gitCredentialConfigs: config.gitCredentialConfigs,
      network: config.dockerNetwork,
      seccompProfile: config.dockerSeccompProfile,
      envNames: config.modelEnvNames,
      modelCredentialEnvNames: config.modelCredentialEnvNames,
      ...(config.mcpCredentialFiles ? { mcpCredentialFiles: config.mcpCredentialFiles } : {}),
      ...(config.mcpDefaultUrl ? { mcpDefaultUrl: config.mcpDefaultUrl } : {}),
      ...(config.codexAuthFilePath ? { authFilePath: config.codexAuthFilePath } : {}),
      ...(config.codexConfigFilePath ? { configFilePath: config.codexConfigFilePath } : {}),
      timeoutMs: config.taskTimeoutMs,
      workerIdentity,
      verificationTmpfsMb: config.verificationTmpfsMb ?? 1024,
      ...(config.taskIdleTimeoutMs !== undefined ? { idleTimeoutMs: config.taskIdleTimeoutMs } : {}),
      onActivity,
      onStage: async (claim, stage, details) => {
        if (stage === "workspace.ready") {
          if (!client.reportTaskStage) throw new Error("WORKSPACE_REPORT_UNAVAILABLE");
          await client.reportTaskStage(claim, stage, details);
          return;
        }
        try {
          await client.reportTaskStage?.(claim, stage, details);
        } catch {
          /* Best effort */
        }
      },
    });

  const preparePublication = dependencies.preparePublication ?? prepareGitPublication;
  const pushPublication = dependencies.pushPublication ?? pushGitPublication;
  const createChangeRequestProvider = dependencies.createChangeRequestProvider ?? createGitChangeRequestProvider;

  const runPublicationOperation = async (): Promise<boolean> => {
    if (!client.claimPublicationOperation || !client.completePublicationOperation) return false;
    const claim = await client.claimPublicationOperation(config.workerId);
    if (!claim) return false;
    try {
      const snapshot = claim.executionSnapshot;
      if (!snapshot) throw new Error("PUBLICATION_EXECUTION_SNAPSHOT_MISSING");
      assertWorkspaceProcessIdentity(
        {
          permissionModel: snapshot.workspacePermissionModel,
          ownerUid: snapshot.workspaceOwnerUid,
          ownerGid: snapshot.workspaceOwnerGid,
        },
        workerIdentity,
      );
      if (claim.operation === "prepare") {
        const prepared = await preparePublication({
          workspacePath: snapshot.workspacePath,
          sourceSubjectRevision: claim.sourceSubjectRevision,
          expectedContentRevision: snapshot.expectedContentRevision,
          approvedChangeSummary: snapshot.approvedChangeSummary,
          baseCommit: claim.baseCommit,
          repositoryUrl: snapshot.repositoryUrl,
          branchName: claim.branchName,
          branchPrefix: snapshot.branchPrefix,
          defaultBranch: snapshot.defaultBranch,
          protectedBranches: snapshot.protectedBranches,
          commitMetadata: {
            authorName: claim.commitAuthorName,
            authorEmail: claim.commitAuthorEmail,
            message: claim.commitMessage,
            timestamp: claim.commitTimestamp,
          },
        });
        await client.completePublicationOperation(claim, {
          success: true,
          commitSha: prepared.commitSha,
          treeSha: prepared.treeSha,
          artifactRef: "publication:" + claim.publicationId,
          pushRefspec: prepared.commitSha + ":refs/heads/" + claim.branchName,
        });
        return true;
      }
      if (!claim.commitSha || !claim.pushRefspec) throw new Error("PUBLICATION_ARTIFACT_NOT_PREPARED");
      await pushPublication({
        workspacePath: snapshot.workspacePath,
        repositoryUrl: snapshot.repositoryUrl,
        branchName: claim.branchName,
        branchPrefix: snapshot.branchPrefix,
        defaultBranch: snapshot.defaultBranch,
        protectedBranches: snapshot.protectedBranches,
        commitSha: claim.commitSha,
        allowedPushRemote: snapshot.allowedPushRemote,
        ...(snapshot.credentialRef ? { credentialRef: snapshot.credentialRef } : {}),
        credentials: config.gitCredentialConfigs,
      });
      await client.completePublicationOperation(claim, { success: true });
      return true;
    } catch (error) {
      const raw = error instanceof Error ? error.message : "PUBLICATION_OPERATION_FAILED";
      const errorCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : "PUBLICATION_OPERATION_FAILED";
      await client.completePublicationOperation(claim, { success: false, errorCode });
      return true;
    }
  };

  const runChangeRequestOperation = async (): Promise<boolean> => {
    if (!client.claimChangeRequestOperation || !client.completeChangeRequestOperation) return false;
    const claim = await client.claimChangeRequestOperation(config.workerId);
    if (!claim) return false;
    try {
      const provider = createChangeRequestProvider(claim.repositoryUrl, config.gitCredentialConfigs);
      const result = await provider.create({
        repositoryIdentity: claim.repositoryIdentity,
        headBranch: claim.headBranch,
        headCommit: claim.headCommit,
        baseBranch: claim.baseBranch,
        title: claim.title,
        body: claim.body,
        idempotencyKey: claim.idempotencyKey,
        credentialGrantRef: claim.credentialGrantRef,
      });
      await client.completeChangeRequestOperation(claim, { success: true, ...result });
      return true;
    } catch (error) {
      const raw = error instanceof Error ? error.message : "CHANGE_REQUEST_CREATE_FAILED";
      const errorCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : "CHANGE_REQUEST_CREATE_FAILED";
      await client.completeChangeRequestOperation(claim, { success: false, errorCode });
      return true;
    }
  };

  return {
    runOnce: async () => {
      if (await runPublicationOperation()) return true;
      if (await runChangeRequestOperation()) return true;
      if (client.claimWorkspaceCleanup && client.completeWorkspaceCleanup) {
        const cleanup = await client.claimWorkspaceCleanup(config.workerId);
        if (cleanup) {
          try {
            assertWorkspaceProcessIdentity(
              {
                permissionModel: cleanup.permissionModel,
                ownerUid: cleanup.ownerUid,
                ownerGid: cleanup.ownerGid,
              },
              workerIdentity,
            );
            const workerGroupId =
              typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 10001;
            await removeWorkspaceDirectory(config.repositoryRoot, cleanup.workspaceKey, {
              image: config.dockerImage,
              workerGroupId,
              permissionModel: cleanup.permissionModel,
              workerUid: workerIdentity.uid,
            });
            await client.completeWorkspaceCleanup(cleanup, true);
          } catch (error) {
            const raw = error instanceof Error ? error.message : "WORKSPACE_CLEANUP_FAILED";
            const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : "WORKSPACE_CLEANUP_FAILED";
            await client.completeWorkspaceCleanup(cleanup, false, code);
          }
          return true;
        }
      }
      return runRemoteWorkerOnce(
        client,
        config.workerId,
        config.capability,
        async (claim, signal, modelAttempt = 1) => {
          modelAttemptSequenceOffset = (modelAttempt - 1) * 1_000_000;
          return executor(claim, signal);
        },
        {
          heartbeatMs: config.heartbeatMs,
          expertId: config.expertId ?? config.capability,
        },
      );
    },
    close: () => client.close(),
  };
}
