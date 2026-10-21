import path from "node:path";

export interface ExpertWorkerRuntimeConfig {
  hubAddress: string;
  workerId: string;
  workerCredential: string;
  capability: string;
  expertId?: string;
  sourcePath: string;
  dockerImage: string;
  dockerNetwork: string;
  dockerSeccompProfile: "default" | "unconfined";
  codexAuthFilePath?: string;
  codexConfigFilePath?: string;
  modelEnvNames: string[];
  heartbeatMs: number;
  pollMs: number;
  taskTimeoutMs: number;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
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
  const dockerImage = env.EXPERT_DOCKER_IMAGE?.trim() ?? "";
  const dockerNetwork = env.EXPERT_DOCKER_NETWORK?.trim() ?? "";
  const dockerSeccompProfile = env.EXPERT_DOCKER_SECCOMP_PROFILE?.trim() || "default";
  const codexAuthFilePath = env.EXPERT_CODEX_AUTH_FILE?.trim() || undefined;
  const codexConfigFilePath = env.EXPERT_CODEX_CONFIG_FILE?.trim() || undefined;
  const modelEnvNames = (env.EXPERT_MODEL_ENV_NAMES ?? "OPENAI_API_KEY")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const tlsCaPath = env.EXPERT_TLS_CA_PATH?.trim() || undefined;
  const tlsCertPath = env.EXPERT_TLS_CERT_PATH?.trim() || undefined;
  const tlsKeyPath = env.EXPERT_TLS_KEY_PATH?.trim() || undefined;
  const tlsConfigured = [tlsCaPath, tlsCertPath, tlsKeyPath].filter(Boolean).length;
  if (tlsConfigured !== 0 && tlsConfigured !== 3) {
    throw new Error("INVALID_WORKER_CONFIG");
  }

  if (
    !hubAddress ||
    !workerId ||
    !workerCredential ||
    !capability ||
    !path.isAbsolute(sourcePath) ||
    sourcePath === "/" ||
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
    dockerImage,
    dockerNetwork,
    dockerSeccompProfile,
    codexAuthFilePath,
    codexConfigFilePath,
    modelEnvNames,
    heartbeatMs: positiveInteger(env.EXPERT_HEARTBEAT_MS, 10_000),
    pollMs: positiveInteger(env.EXPERT_POLL_MS, 3_000),
    taskTimeoutMs: positiveInteger(env.EXPERT_TASK_TIMEOUT_MS, 120_000),
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
  };
}
