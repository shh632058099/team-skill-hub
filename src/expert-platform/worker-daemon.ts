import { readFileSync } from "node:fs";
import { createDockerCodexExecutor, type DockerCodexExecutorOptions } from "./docker-codex-executor.js";
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

interface ClosableRemoteWorkerClient extends RemoteWorkerClient {
  close(): void;
}

export interface ExpertWorkerRuntimeDependencies {
  createClient?: (config: ExpertWorkerRuntimeConfig) => ClosableRemoteWorkerClient;
  createExecutor?: (options: DockerCodexExecutorOptions) => ReturnType<typeof createDockerCodexExecutor>;
  preparePublication?: (input: PrepareGitPublicationInput) => Promise<PreparedGitPublication>;
  pushPublication?: (input: PushGitPublicationInput) => Promise<PushGitPublicationResult>;
}

export function createExpertWorkerRuntime(
  config: ExpertWorkerRuntimeConfig,
  dependencies: ExpertWorkerRuntimeDependencies = {},
): { runOnce(): Promise<boolean>; close(): void } {
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
      },
    );
  const onActivity: NonNullable<DockerCodexExecutorOptions["onActivity"]> = async (
    claim,
    stage,
    sequence,
    tool,
    count,
  ) => {
    const activity =
      stage === "tool.activity"
        ? {
            sequence,
            ...(tool ? { tool } : {}),
            ...(count === undefined ? {} : { count }),
          }
        : { sequence };
    await client.reportTaskStage?.(claim, stage, "", activity);
  };

  const executor =
    dependencies.createExecutor?.({
      image: config.dockerImage,
      ...(config.executorBackend ? { backend: config.executorBackend } : {}),
      ...(config.executorBackend === "claude"
        ? { claudeModel: config.claudeModel ?? "sonnet", claudeMaxTurns: config.claudeMaxTurns ?? 12 }
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
    createDockerCodexExecutor({
      image: config.dockerImage,
      ...(config.executorBackend ? { backend: config.executorBackend } : {}),
      ...(config.executorBackend === "claude"
        ? { claudeModel: config.claudeModel ?? "sonnet", claudeMaxTurns: config.claudeMaxTurns ?? 12 }
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

  const runPublicationOperation = async (): Promise<boolean> => {
    if (!client.claimPublicationOperation || !client.completePublicationOperation) return false;
    const claim = await client.claimPublicationOperation(config.workerId);
    if (!claim) return false;
    try {
      const snapshot = claim.executionSnapshot;
      if (!snapshot) throw new Error("PUBLICATION_EXECUTION_SNAPSHOT_MISSING");
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

  return {
    runOnce: async () => {
      if (await runPublicationOperation()) return true;
      if (client.claimWorkspaceCleanup && client.completeWorkspaceCleanup) {
        const cleanup = await client.claimWorkspaceCleanup(config.workerId);
        if (cleanup) {
          try {
            await removeWorkspaceDirectory(config.repositoryRoot, cleanup.workspaceKey);
            await client.completeWorkspaceCleanup(cleanup, true);
          } catch (error) {
            const raw = error instanceof Error ? error.message : "WORKSPACE_CLEANUP_FAILED";
            const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : "WORKSPACE_CLEANUP_FAILED";
            await client.completeWorkspaceCleanup(cleanup, false, code);
          }
          return true;
        }
      }
      return runRemoteWorkerOnce(client, config.workerId, config.capability, executor, {
        heartbeatMs: config.heartbeatMs,
        expertId: config.expertId ?? config.capability,
      });
    },
    close: () => client.close(),
  };
}
