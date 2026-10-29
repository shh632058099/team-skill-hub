import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Claim } from "./task-store.js";
import type { ExpertModelConfig } from "./expert-store.js";
import { prepareRepositoryWorkspace, type GitCredentialConfig } from "./repository-workspace.js";
import { buildCodexReadOnlyArgs } from "./codex-runtime.js";
import { parseClaudeResult, buildClaudeReadOnlyArgs } from "./claude-runtime.js";
import { buildCodexDockerArgs } from "./codex-container-executor.js";
import { runCodexProcess, type CodexProcessOptions } from "./codex-process.js";

export interface DockerCodexExecutorOptions {
  image: string;
  backend?: "codex" | "claude";
  claudeModel?: string;
  claudeMaxTurns?: number;
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
  onStage?: (claim: Claim, stage: string, details?: string) => Promise<void>;
  onActivity?: (claim: Claim, stage: string, sequence: number, tool?: string, count?: number) => Promise<void>;
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
    const backend = options.backend ?? "claude";
    if (backend !== "codex" && backend !== "claude") throw new Error("INVALID_EXECUTOR_BACKEND");
    const streaming = process.env.EXPERT_ACTIVITY_STREAM_ENABLED !== "0" && !options.runProcess;
    let codexArgs =
      backend === "claude"
        ? buildClaudeReadOnlyArgs(
            claim.problem,
            options.claudeModel ?? "sonnet",
            streaming,
            options.claudeMaxTurns ?? 12,
          )
        : buildCodexReadOnlyArgs(claim.problem);
    // URL-backed repository IDs are the new source-repository contract. If the
    // Hub cannot resolve their URL/branch, fail the task instead of analyzing the
    // worker's unrelated default sourcePath. Legacy IDs retain compatibility.
    if (claim.repositoryId?.startsWith("repo-") && (!claim.repositoryUrl || !claim.repositoryBranch)) {
      throw new Error("SOURCE_REPOSITORY_UNAVAILABLE");
    }
    const report = async (stage: string, details = "") => {
      try {
        await options.onStage?.(claim, stage, details);
      } catch {
        /* Observability must not block task execution. */
      }
    };
    await report("repository.started");
    let preparedRepository: Awaited<ReturnType<typeof prepareRepositoryWorkspace>> | undefined;
    try {
      preparedRepository =
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
    } catch (error) {
      await report("repository.failed", "REPOSITORY_PREPARATION_FAILED");
      throw error;
    }
    await report("repository.completed");
    const sourcePath = preparedRepository?.path ?? options.sourcePath;
    let generatedConfigDir: string | undefined;
    let configFilePath = options.configFilePath;
    let envNames = options.envNames;
    if (claim.modelConfig && backend === "codex" && claim.modelConfig.wireApi !== "responses") {
      throw new Error("EXPERT_MODEL_PROTOCOL_MISMATCH");
    }
    if (claim.modelConfig && backend === "claude" && claim.modelConfig.wireApi !== "anthropic-messages") {
      throw new Error("EXPERT_MODEL_PROTOCOL_MISMATCH");
    }
    if (backend === "claude" && claim.modelConfig) {
      codexArgs = buildClaudeReadOnlyArgs(
        claim.problem,
        claim.modelConfig.model,
        streaming,
        options.claudeMaxTurns ?? 12,
      );
    }
    let claudeChildEnv: NodeJS.ProcessEnv | undefined;
    if (claim.modelConfig && backend === "claude") {
      const model = claim.modelConfig;
      const allowed = new Set(options.envNames);
      if (model.allowedEnvNames.some((name) => !allowed.has(name))) throw new Error("EXPERT_MODEL_ENV_NOT_ALLOWED");
      const source = model.credentialRef
        ? options.modelCredentialEnvNames?.[model.credentialRef]
        : model.allowedEnvNames.includes("ANTHROPIC_AUTH_TOKEN")
          ? "ANTHROPIC_AUTH_TOKEN"
          : model.allowedEnvNames.includes("ANTHROPIC_API_KEY")
            ? "ANTHROPIC_API_KEY"
            : model.allowedEnvNames.includes("CLAUDE_CODE_OAUTH_TOKEN")
              ? "CLAUDE_CODE_OAUTH_TOKEN"
              : undefined;
      if (!source || !allowed.has(source) || !model.allowedEnvNames.includes(source))
        throw new Error("EXPERT_MODEL_CREDENTIAL_NOT_CONFIGURED");
      if (!process.env[source]) throw new Error("EXPERT_MODEL_CREDENTIAL_NOT_CONFIGURED");
      const target = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].includes(source)
        ? source
        : "ANTHROPIC_API_KEY";
      claudeChildEnv = {
        ...process.env,
        ANTHROPIC_BASE_URL: model.baseUrl,
        [target]: process.env[source],
      };
      envNames = [
        ...new Set([
          ...model.allowedEnvNames,
          ...options.envNames.filter((name) => PROXY_ENV_NAMES.has(name)),
          target,
          "ANTHROPIC_BASE_URL",
        ]),
      ];
    }
    if (claim.modelConfig && backend === "codex") {
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
      if (backend === "claude") {
        // Docker entrypoint is the Claude CLI for Claude-specific images.
        // Disable Codex-only env and auth injection; allow only explicitly configured env.
        const codeHomeIndex = args.findIndex((value) => value === "CODEX_HOME=/home/expert/.codex");
        if (codeHomeIndex >= 0) args[codeHomeIndex] = "CLAUDE_CONFIG_DIR=/home/expert/.claude";
      }
      await report("container.started");
      if (!options.runProcess) await cleanupSupersededTaskContainers(claim);
      await report(`${backend}.started`);
      let result: string;
      let sourceSequence = 0;
      let lastActivityAt = 0;
      let pendingActivity = Promise.resolve();
      let inflight = 0;
      const activityCounts = new Map<string, number>();
      const flushActivity = () => {
        for (const [key, count] of activityCounts) {
          activityCounts.delete(key);
          const [stage, tool] = key.split("|");
          if (!stage) continue;
          if (!options.onActivity || inflight >= 100) continue;
          const sequence = ++sourceSequence;
          inflight++;
          pendingActivity = pendingActivity
            .then(() => options.onActivity!(claim, stage, sequence, tool || undefined, count || undefined))
            .catch(() => {
              /* progress transport is best effort */
            })
            .then(() => {
              inflight--;
            });
        }
      };
      try {
        result = await runProcess({
          executable: "docker",
          args,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes ?? (streaming ? 64 * 1024 * 1024 : undefined),
          signal,
          onAbort: () => stopDockerContainer(containerName),
          ...(claudeChildEnv ? { env: claudeChildEnv } : {}),
          ...(streaming
            ? {
                streamingBackend: backend,
                onActivity: (activity: import("./execution-activity.js").ExecutionActivity) => {
                  const key = activity.kind + "|" + (activity.tool ?? "");
                  activityCounts.set(key, Math.min(100, (activityCounts.get(key) ?? 0) + (activity.count ?? 1)));
                  if (Date.now() - lastActivityAt >= 2000) {
                    lastActivityAt = Date.now();
                    flushActivity();
                  }
                },
              }
            : backend === "claude" && !options.runProcess
              ? { parseResult: parseClaudeResult }
              : {}),
        });
      } catch (error) {
        await report(`${backend}.failed`, "EXECUTION_FAILED");
        await report("container.failed", "EXECUTION_FAILED");
        throw error;
      }
      if (streaming) {
        flushActivity();
        // Briefly drain already accepted activity; never block final task completion on Hub progress.
        let drainTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            pendingActivity,
            new Promise<void>((resolve) => {
              drainTimer = setTimeout(resolve, 500);
            }),
          ]);
        } finally {
          if (drainTimer) clearTimeout(drainTimer);
        }
      }
      await report(`${backend}.completed`);
      await report("container.completed");
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
