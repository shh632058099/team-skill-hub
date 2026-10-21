import type { Claim } from "./task-store.js";
import { buildCodexReadOnlyArgs } from "./codex-runtime.js";
import { buildCodexDockerArgs } from "./codex-container-executor.js";
import { runCodexProcess, type CodexProcessOptions } from "./codex-process.js";

export interface DockerCodexExecutorOptions {
  image: string;
  sourcePath: string;
  network: string;
  seccompProfile?: "default" | "unconfined";
  envNames: readonly string[];
  authFilePath?: string;
  configFilePath?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  runProcess?: (options: CodexProcessOptions) => Promise<string>;
}

export function createDockerCodexExecutor(options: DockerCodexExecutorOptions) {
  const runProcess = options.runProcess ?? runCodexProcess;
  return async (claim: Claim, signal: AbortSignal): Promise<string> => {
    const codexArgs = buildCodexReadOnlyArgs(claim.problem);
    const args = buildCodexDockerArgs({
      image: options.image,
      sourcePath: options.sourcePath,
      network: options.network,
      seccompProfile: options.seccompProfile,
      envNames: options.envNames,
      authFilePath: options.authFilePath,
      configFilePath: options.configFilePath,
      codexArgs,
    });
    return runProcess({
      executable: "docker",
      args,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      signal,
    });
  };
}
