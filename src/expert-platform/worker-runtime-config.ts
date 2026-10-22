import path from "node:path";
import { loadGitCredentialConfigs, type GitCredentialConfig } from "./repository-workspace.js";

export interface ExpertWorkerRuntimeConfig {
  hubAddress: string;
  workerId: string;
  workerCredential: string;
  capability: string;
  expertId?: string;
  sourcePath: string;
  repositoryRoot: string;
  gitCredentialConfigs: Record<string, GitCredentialConfig>;
  dockerImage: string;
  dockerNetwork: string;
  dockerSeccompProfile: "default" | "unconfined";
  codexAuthFilePath?: string;
  codexConfigFilePath?: string;
  modelEnvNames: string[];
  modelCredentialEnvNames: Record<string, string>;
  heartbeatMs: number;
  pollMs: number;
  taskTimeoutMs: number;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

function parseModelCredentialEnvNames(
  value: string | undefined,
  allowedEnvNames: readonly string[],
): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("INVALID_WORKER_CONFIG");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_WORKER_CONFIG");
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 100) throw new Error("INVALID_WORKER_CONFIG");
  const result: Record<string, string> = {};
  const forbidden = new Set([
    "PATH",
    "HOME",
    "CODEX_HOME",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "NODE_OPTIONS",
    "BASH_ENV",
    "ENV",
    "IFS",
    "SHELLOPTS",
  ]);
  for (const [ref, envName] of entries) {
    if (
      !ref.trim() ||
      ref.length > 100 ||
      typeof envName !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName) ||
      forbidden.has(envName) ||
      envName.startsWith("DOCKER_") ||
      !allowedEnvNames.includes(envName)
    ) {
      throw new Error("INVALID_WORKER_CONFIG");
    }
    result[ref] = envName;
  }
  return result;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("INVALID_WORKER_CONFIG");
  return parsed;
}

export function parseExpertWorkerConfig(env: Record<string, string | undefined>): ExpertWorkerRuntimeConfig {
  const hubAddress = env.EXPERT_HUB_ADDRESS?.trim() ?? "";
  const workerId = env.EXPERT_WORKER_ID?.trim() ?? "";
  const workerCredential = env.EXPERT_WORKER_CREDENTIAL?.trim() ?? "";
  const capability = env.EXPERT_CAPABILITY?.trim() ?? "";
  const expertId = env.EXPERT_ID?.trim() || capability;
  const sourcePath = env.EXPERT_SOURCE_PATH?.trim() ?? "";
  const repositoryRootBase =
    env.EXPERT_REPOSITORY_ROOT?.trim() ||
    (sourcePath ? path.join(path.dirname(sourcePath), "expert-repositories") : "");
  // EXPERT_REPOSITORY_ROOT is a base directory, never a shared checkout root.
  // Every worker gets a private clone namespace keyed by its stable worker ID.
  const repositoryRoot =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(workerId) && repositoryRootBase
      ? path.join(repositoryRootBase, workerId)
      : "";
  const gitCredentialConfigs = loadGitCredentialConfigs(env.EXPERT_GIT_CREDENTIALS_JSON);
  const dockerImage = env.EXPERT_DOCKER_IMAGE?.trim() ?? "";
  const dockerNetwork = env.EXPERT_DOCKER_NETWORK?.trim() ?? "";
  const dockerSeccompProfile = env.EXPERT_DOCKER_SECCOMP_PROFILE?.trim() || "default";
  const codexAuthFilePath = env.EXPERT_CODEX_AUTH_FILE?.trim() || undefined;
  const codexConfigFilePath = env.EXPERT_CODEX_CONFIG_FILE?.trim() || undefined;
  const modelEnvNames = (env.EXPERT_MODEL_ENV_NAMES ?? "OPENAI_API_KEY")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const modelCredentialEnvNames = parseModelCredentialEnvNames(env.EXPERT_MODEL_CREDENTIAL_REFS_JSON, modelEnvNames);

  const tlsCaPath = env.EXPERT_TLS_CA_PATH?.trim() || undefined;
  const tlsCertPath = env.EXPERT_TLS_CERT_PATH?.trim() || undefined;
  const tlsKeyPath = env.EXPERT_TLS_KEY_PATH?.trim() || undefined;
  const tlsConfigured = [tlsCaPath, tlsCertPath, tlsKeyPath].filter(Boolean).length;
  if (tlsConfigured !== 0 && tlsConfigured !== 3) {
    throw new Error("INVALID_WORKER_CONFIG");
  }

  if (
    !hubAddress ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(workerId) ||
    !workerCredential ||
    !capability ||
    (sourcePath !== "" && (!path.isAbsolute(sourcePath) || sourcePath === "/")) ||
    (!sourcePath && !env.EXPERT_REPOSITORY_ROOT?.trim()) ||
    !path.isAbsolute(repositoryRoot) ||
    repositoryRoot === "/" ||
    !dockerImage ||
    !dockerNetwork ||
    dockerNetwork === "host" ||
    dockerNetwork === "none" ||
    (dockerSeccompProfile !== "default" && dockerSeccompProfile !== "unconfined") ||
    (codexAuthFilePath !== undefined && (!path.isAbsolute(codexAuthFilePath) || codexAuthFilePath === "/")) ||
    (codexConfigFilePath !== undefined && (!path.isAbsolute(codexConfigFilePath) || codexConfigFilePath === "/")) ||
    modelEnvNames.length === 0
  ) {
    throw new Error("INVALID_WORKER_CONFIG");
  }

  return {
    hubAddress,
    workerId,
    workerCredential,
    capability,
    expertId,
    sourcePath,
    repositoryRoot,
    gitCredentialConfigs,
    dockerImage,
    dockerNetwork,
    dockerSeccompProfile,
    codexAuthFilePath,
    codexConfigFilePath,
    modelEnvNames,
    modelCredentialEnvNames,
    heartbeatMs: positiveInteger(env.EXPERT_HEARTBEAT_MS, 10_000),
    pollMs: positiveInteger(env.EXPERT_POLL_MS, 3_000),
    taskTimeoutMs: positiveInteger(env.EXPERT_TASK_TIMEOUT_MS, 120_000),
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
  };
}
