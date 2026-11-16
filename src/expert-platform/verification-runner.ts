import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { VerificationPolicyStep, VerificationRunResult } from "./verification-policy.js";

export interface VerificationDockerResult {
  exitCode: number | null;
  timedOut: boolean;
  processError?: boolean;
}

export type VerificationDockerRunner = (
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<VerificationDockerResult>;

export interface VerificationContainerOptions {
  image: string;
  containerNamePrefix: string;
  supplementalGroupId?: number;
  primaryGroupId?: number;
  tmpfsSizeMb?: number;
  runDocker?: VerificationDockerRunner;
}

function removeContainer(name: string): void {
  try {
    const cleanup = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    cleanup.unref();
  } catch {
    /* Best effort; the container also uses --rm. */
  }
}

function defaultRunDocker(
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VerificationDockerResult> {
  if (signal.aborted) return Promise.reject(new Error("VERIFICATION_CANCELLED"));
  return new Promise((resolve, reject) => {
    const nameIndex = args.indexOf("--name");
    const containerName = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
    const child = spawn("docker", [...args], { stdio: "ignore" });
    let settled = false;
    let timedOut = false;
    const finish = (result: VerificationDockerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = () => {
      if (containerName) removeContainer(containerName);
      child.kill("SIGKILL");
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(new Error("VERIFICATION_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stop();
    }, timeoutMs);
    child.once("error", () => finish({ exitCode: null, timedOut: false, processError: true }));
    child.once("close", (code) => finish({ exitCode: typeof code === "number" ? code : null, timedOut }));
  });
}

function buildVerificationDockerArgs(
  workspacePath: string,
  step: VerificationPolicyStep,
  options: VerificationContainerOptions,
): string[] {
  if (!path.isAbsolute(workspacePath) || workspacePath === path.parse(workspacePath).root) {
    throw new Error("INVALID_VERIFICATION_WORKSPACE");
  }
  if (!options.image || options.image.startsWith("-") || /[\r\n\0]/.test(options.image)) {
    throw new Error("INVALID_VERIFICATION_IMAGE");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.containerNamePrefix)) {
    throw new Error("INVALID_VERIFICATION_CONTAINER");
  }
  if (
    options.supplementalGroupId !== undefined &&
    (!Number.isSafeInteger(options.supplementalGroupId) || options.supplementalGroupId < 1)
  ) {
    throw new Error("INVALID_VERIFICATION_GROUP");
  }
  if (
    options.primaryGroupId !== undefined &&
    (!Number.isSafeInteger(options.primaryGroupId) || options.primaryGroupId < 1)
  ) {
    throw new Error("INVALID_VERIFICATION_GROUP");
  }
  const tmpfsSizeMb = options.tmpfsSizeMb ?? 1024;
  if (!Number.isSafeInteger(tmpfsSizeMb) || tmpfsSizeMb < 64 || tmpfsSizeMb > 4096) {
    throw new Error("INVALID_VERIFICATION_TMPFS_SIZE");
  }
  if (!step.argv[0] || step.argv.some((arg) => !arg || arg.includes("\0"))) {
    throw new Error("INVALID_VERIFICATION_COMMAND");
  }
  const suffix = createHash("sha256").update(`${options.containerNamePrefix}:${step.id}`).digest("hex").slice(0, 20);
  const containerName = `verify-${suffix}`;
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--init",
    "--network",
    "none",
    "--read-only",
    ...(options.primaryGroupId !== undefined ? ["--user", `10001:${options.primaryGroupId}`] : []),
    ...(options.supplementalGroupId !== undefined && options.supplementalGroupId !== options.primaryGroupId
      ? ["--group-add", String(options.supplementalGroupId)]
      : []),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "2",
    "--mount",
    `type=bind,src=${workspacePath},dst=/workspace,readonly`,
    "--tmpfs",
    `/tmp:rw,exec,uid=10001,gid=${options.primaryGroupId ?? 10001},size=${tmpfsSizeMb}m`,
    "--tmpfs",
    `/home/expert:rw,uid=10001,gid=${options.primaryGroupId ?? 10001},size=64m`,
    "--env",
    "HOME=/home/expert",
    "--env",
    "GIT_CONFIG_COUNT=1",
    "--env",
    "GIT_CONFIG_KEY_0=safe.directory",
    "--env",
    "GIT_CONFIG_VALUE_0=/workspace",
    "--workdir",
    "/workspace",
    "--entrypoint",
    step.argv[0],
    options.image,
    ...step.argv.slice(1),
  ];
}

async function runStep(
  workspacePath: string,
  step: VerificationPolicyStep,
  signal: AbortSignal,
  options: VerificationContainerOptions,
): Promise<VerificationRunResult> {
  if (signal.aborted) throw new Error("VERIFICATION_CANCELLED");
  const startedAt = Date.now();
  const runDocker = options.runDocker ?? defaultRunDocker;
  const dockerArgs = buildVerificationDockerArgs(workspacePath, step, options);
  let execution: VerificationDockerResult;
  try {
    execution = await runDocker(dockerArgs, step.timeoutMs, signal);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.message === "VERIFICATION_CANCELLED")) throw error;
    execution = { exitCode: null, timedOut: false, processError: true };
  }
  return {
    stepId: step.id,
    type: step.type,
    evidenceType: step.evidenceType,
    status: execution.exitCode === 0 && !execution.timedOut && !execution.processError ? "passed" : "failed",
    exitCode: execution.exitCode,
    durationMs: Math.max(0, Date.now() - startedAt),
    errorCode: execution.timedOut
      ? "VERIFICATION_TIMEOUT"
      : execution.processError
        ? "VERIFICATION_PROCESS_FAILED"
        : execution.exitCode === 0
          ? null
          : "VERIFICATION_EXIT_NONZERO",
  };
}

export async function runVerificationPolicy(
  workspacePath: string,
  policy: readonly VerificationPolicyStep[],
  signal: AbortSignal,
  options: VerificationContainerOptions,
): Promise<VerificationRunResult[]> {
  if (signal.aborted) throw new Error("VERIFICATION_CANCELLED");
  const results: VerificationRunResult[] = [];
  for (const step of policy) results.push(await runStep(workspacePath, step, signal, options));
  return results;
}
