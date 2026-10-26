import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Claim } from "./task-store.js";
import type { ExpertModelConfig } from "./expert-store.js";
import { prepareRepositoryWorkspace, type GitCredentialConfig } from "./repository-workspace.js";
import { buildCodexReadOnlyArgs } from "./codex-runtime.js";
import { buildCodexDockerArgs } from "./codex-container-executor.js";
import { runCodexProcess, type CodexProcessOptions } from "./codex-process.js";

export interface DockerCodexExecutorOptions {
  image: string;
  sourcePath: string;
  repositoryRoot?: string;
  sharedTempRoot?: string;
  gitCredentialConfigs?: Readonly<Record<string, GitCredentialConfig>>;
  network: string;
  seccompProfile?: "default" | "unconfined";
  envNames: readonly string[];
  modelCredentialEnvNames?: Readonly<Record<string, string>>;
  authFilePath?: string;
  configFilePath?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  runProcess?: (options: CodexProcessOptions) => Promise<string>;
}

const PROXY_ENV_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildExpertCodexConfig(
  config: ExpertModelConfig,
  options: DockerCodexExecutorOptions,
): { content: string; envNames: string[] } {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.providerId) || config.wireApi !== "responses")
    throw new Error("INVALID_EXPERT_MODEL_CONFIG");
  const allowed = new Set(options.envNames);
  if (config.allowedEnvNames.some((name) => !allowed.has(name))) throw new Error("EXPERT_MODEL_ENV_NOT_ALLOWED");
  let envKey: string | undefined;
  if (config.credentialRef) {
    envKey = options.modelCredentialEnvNames?.[config.credentialRef];
    if (!envKey || !config.allowedEnvNames.includes(envKey) || !allowed.has(envKey))
      throw new Error("EXPERT_MODEL_CREDENTIAL_NOT_CONFIGURED");
  } else {
    envKey = config.allowedEnvNames.find((name) => !PROXY_ENV_NAMES.has(name));
  }
  const content = [
    `model = ${tomlString(config.model)}`,
    `model_provider = ${tomlString(config.providerId)}`,
    "",
    `[model_providers.${config.providerId}]`,
    `name = ${tomlString(config.providerId)}`,
    `base_url = ${tomlString(config.baseUrl)}`,
    `wire_api = ${tomlString(config.wireApi)}`,
    ...(envKey ? [`env_key = ${tomlString(envKey)}`] : []),
    "",
  ].join("\n");
  const envNames = [
    ...new Set([...config.allowedEnvNames, ...options.envNames.filter((name) => PROXY_ENV_NAMES.has(name))]),
  ];
  return { content, envNames };
}

async function dockerCommand(
  args: readonly string[],
  timeoutMs = 2_000,
  maxOutputBytes = 256,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let outputOverflow = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("DOCKER_COMMAND_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const part = chunk.toString("utf8");
      if (stdout.length + part.length > maxOutputBytes) outputOverflow = true;
      stdout += part.slice(0, Math.max(0, maxOutputBytes - stdout.length));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (outputOverflow) reject(new Error("DOCKER_COMMAND_OUTPUT_OVERFLOW"));
      else resolve({ code, stdout: stdout.trim() });
    });
  });
}

async function stopDockerContainer(name: string): Promise<void> {
  // Cancellation can arrive while `docker run` is still creating the container.
  // Retry briefly so the create request cannot win a race against a one-shot stop.
  const deadline = Date.now() + 5_000;
  do {
    try {
      const inspect = await dockerCommand(["inspect", "-f", "{{.State.Status}}", name], 1_000);
      if (inspect.code === 0) {
        const removed = await dockerCommand(["rm", "-f", name], 2_000);
        if (removed.code === 0) return;
      }
    } catch {
      /* retry until the bounded deadline, then process-group kill is fallback */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("DOCKER_STOP_FAILED");
}

/** Remove only containers for earlier fenced attempts of a task already claimed by this Worker.
 * Never remove the same or a newer fencing value; only managed, labeled containers
 * on the same Docker daemon are eligible. Reclaim runs before launching the new attempt.
 */
export async function cleanupSupersededTaskContainers(claim: Pick<Claim, "taskId" | "fencing">): Promise<number> {
  if (!/^[a-f0-9-]{36}$/.test(claim.taskId) || !Number.isSafeInteger(claim.fencing) || claim.fencing < 1) {
    return 0; // legacy/mocked task IDs never trigger Docker container removal
  }
  const listing = await dockerCommand(
    [
      "ps",
      "-aq",
      "--filter",
      "label=team-skill-hub.expert-managed=1",
      "--filter",
      `label=team-skill-hub.task-id=${claim.taskId}`,
    ],
    3_000,
    64 * 1024,
  );
  if (listing.code !== 0) throw new Error("DOCKER_RECLAIM_LIST_FAILED");
  // Fail closed on truncated Docker output rather than acting on partial container IDs.
  const ids = listing.stdout.split(/\s+/).filter(Boolean);
  let removed = 0;
  for (const id of ids) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("DOCKER_RECLAIM_INVALID_CONTAINER_ID");
    const inspected = await dockerCommand(
      ["inspect", "-f", '{{index .Config.Labels "team-skill-hub.fencing"}}', id],
      2_000,
    );
    if (inspected.code !== 0) continue; // container already vanished
    const fence = Number(inspected.stdout);
    if (!Number.isSafeInteger(fence) || fence < 1 || fence >= claim.fencing) continue;
    const result = await dockerCommand(["rm", "-f", id], 5_000);
    if (result.code !== 0) throw new Error("DOCKER_RECLAIM_REMOVE_FAILED");
    removed++;
  }
  return removed;
}

export function createDockerCodexExecutor(options: DockerCodexExecutorOptions) {
  const runProcess = options.runProcess ?? runCodexProcess;
  return async (
    claim: Claim,
    signal: AbortSignal,
  ): Promise<
    string | { result: string; source: { repositoryUrl?: string; repositoryBranch?: string; commitSha: string } }
  > => {
    const codexArgs = buildCodexReadOnlyArgs(claim.problem);
    // URL-backed repository IDs are the new source-repository contract. If the
    // Hub cannot resolve their URL/branch, fail the task instead of analyzing the
    // worker's unrelated default sourcePath. Legacy IDs retain compatibility.
    if (claim.repositoryId?.startsWith("repo-") && (!claim.repositoryUrl || !claim.repositoryBranch)) {
      throw new Error("SOURCE_REPOSITORY_UNAVAILABLE");
    }
    const preparedRepository =
      claim.repositoryUrl && claim.repositoryBranch && claim.repositoryId
        ? await prepareRepositoryWorkspace({
            id: claim.repositoryId,
            url: claim.repositoryUrl,
            branch: claim.repositoryBranch,
            ...(claim.repositoryGitProxyUrl ? { gitProxyUrl: claim.repositoryGitProxyUrl } : {}),
            root: options.repositoryRoot ?? `${options.sourcePath.replace(/\/[^/]+$/, "")}/expert-repositories`,
            ...(claim.repositoryCredentialRef ? { credentialRef: claim.repositoryCredentialRef } : {}),
            credentials: options.gitCredentialConfigs,
          })
        : undefined;
    const sourcePath = preparedRepository?.path ?? options.sourcePath;
    let generatedConfigDir: string | undefined;
    let configFilePath = options.configFilePath;
    let envNames = options.envNames;
    if (claim.modelConfig) {
      const generated = buildExpertCodexConfig(claim.modelConfig, options);
      generatedConfigDir = mkdtempSync(path.join(options.sharedTempRoot ?? os.tmpdir(), ".expert-codex-config-"));
      configFilePath = path.join(generatedConfigDir, "config.toml");
      writeFileSync(configFilePath, generated.content, { mode: 0o644, flag: "wx" });
      // Creation mode is filtered by the worker launcher's umask; enforce readability explicitly.
      chmodSync(configFilePath, 0o644);
      envNames = generated.envNames;
    }
    try {
      const containerName = `expert-${createHash("sha256").update(`${claim.taskId}:${claim.runId}:${claim.fencing}`).digest("hex").slice(0, 24)}`;
      const args = buildCodexDockerArgs({
        image: options.image,
        containerName,
        ...(/^[a-f0-9-]{36}$/.test(claim.taskId) && /^[a-f0-9-]{36}$/.test(claim.runId)
          ? { taskLabels: { taskId: claim.taskId, runId: claim.runId, fencing: claim.fencing } }
          : {}),
        sourcePath,
        network: options.network,
        seccompProfile: options.seccompProfile,
        envNames,
        authFilePath: options.authFilePath,
        configFilePath,
        codexArgs,
      });
      if (!options.runProcess) await cleanupSupersededTaskContainers(claim);
      const result = await runProcess({
        executable: "docker",
        args,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        signal,
        onAbort: () => stopDockerContainer(containerName),
      });
      return preparedRepository
        ? {
            result,
            source: {
              repositoryUrl: claim.repositoryUrl,
              repositoryBranch: claim.repositoryBranch,
              commitSha: preparedRepository.commitSha,
            },
          }
        : result;
    } finally {
      if (generatedConfigDir) rmSync(generatedConfigDir, { recursive: true, force: true });
    }
  };
}
