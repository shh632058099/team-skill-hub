import { readFileSync } from "node:fs";
import { createDockerCodexExecutor, type DockerCodexExecutorOptions } from "./docker-codex-executor.js";
import { ExpertWorkerClient } from "./grpc-transport.js";
import { runRemoteWorkerOnce, type RemoteWorkerClient } from "./remote-worker.js";
import type { ExpertWorkerRuntimeConfig } from "./worker-runtime-config.js";

interface ClosableRemoteWorkerClient extends RemoteWorkerClient {
  close(): void;
}

export interface ExpertWorkerRuntimeDependencies {
  createClient?: (config: ExpertWorkerRuntimeConfig) => ClosableRemoteWorkerClient;
  createExecutor?: (options: DockerCodexExecutorOptions) => ReturnType<typeof createDockerCodexExecutor>;
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
      tls ? { tls } : {},
    );
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
      ...(config.codexAuthFilePath ? { authFilePath: config.codexAuthFilePath } : {}),
      ...(config.codexConfigFilePath ? { configFilePath: config.codexConfigFilePath } : {}),
      timeoutMs: config.taskTimeoutMs,
      onStage: async (claim, stage, details) => {
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
      ...(config.codexAuthFilePath ? { authFilePath: config.codexAuthFilePath } : {}),
      ...(config.codexConfigFilePath ? { configFilePath: config.codexConfigFilePath } : {}),
      timeoutMs: config.taskTimeoutMs,
      onActivity: async (claim, stage, sequence, tool, count) => {
        await client.reportTaskStage?.(claim, stage, "", { sequence, tool, count });
      },
      onStage: async (claim, stage, details) => {
        try {
          await client.reportTaskStage?.(claim, stage, details);
        } catch {
          /* Best effort */
        }
      },
    });

  return {
    runOnce: () =>
      runRemoteWorkerOnce(client, config.workerId, config.capability, executor, {
        heartbeatMs: config.heartbeatMs,
        expertId: config.expertId ?? config.capability,
      }),
    close: () => client.close(),
  };
}
