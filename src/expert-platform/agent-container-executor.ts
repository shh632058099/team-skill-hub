import path from "node:path";

const ALLOWED_ENV_NAMES = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

const FORBIDDEN_ENV_NAMES = new Set([
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

function isAllowedEnvName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    name.length <= 128 &&
    !FORBIDDEN_ENV_NAMES.has(name) &&
    (ALLOWED_ENV_NAMES.has(name) || !name.startsWith("DOCKER_"))
  );
}

export interface AgentDockerConfig {
  image: string;
  containerName?: string;
  taskLabels?: { taskId: string; runId: string; fencing: number };
  sourcePath: string;
  workspaceAccess?: "read-only" | "read-write";
  network: string;
  seccompProfile?: "default" | "unconfined";
  supplementalGroupId?: number;
  primaryGroupId?: number;
  runAsUid?: number;
  runAsGid?: number;
  gitMetadataPath?: string;
  envNames: readonly string[];
  authFilePath?: string;
  configFilePath?: string;
  mcpConfigFilePath?: string;
  runtimeStatePath?: string;
  runtimeStateTarget?: string;
  commandArgs: readonly string[];
}

export function buildAgentDockerArgs(config: AgentDockerConfig): string[] {
  if (!path.isAbsolute(config.sourcePath) || config.sourcePath === "/") {
    throw new Error("INVALID_SOURCE_PATH");
  }
  if (!config.image || config.image.startsWith("-")) throw new Error("INVALID_IMAGE");
  if (config.containerName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.containerName)) {
    throw new Error("INVALID_CONTAINER_NAME");
  }
  if (
    config.taskLabels &&
    (!/^[a-f0-9-]{36}$/.test(config.taskLabels.taskId) ||
      !/^[a-f0-9-]{36}$/.test(config.taskLabels.runId) ||
      !Number.isSafeInteger(config.taskLabels.fencing) ||
      config.taskLabels.fencing < 1)
  )
    throw new Error("INVALID_TASK_LABELS");
  if (!config.network || config.network === "host" || config.network === "none") {
    throw new Error("INVALID_NETWORK");
  }
  if (
    config.seccompProfile !== undefined &&
    config.seccompProfile !== "default" &&
    config.seccompProfile !== "unconfined"
  ) {
    throw new Error("INVALID_SECCOMP_PROFILE");
  }
  if (
    config.supplementalGroupId !== undefined &&
    (!Number.isSafeInteger(config.supplementalGroupId) || config.supplementalGroupId < 1)
  ) {
    throw new Error("INVALID_SUPPLEMENTAL_GROUP_ID");
  }
  if (
    config.primaryGroupId !== undefined &&
    (!Number.isSafeInteger(config.primaryGroupId) || config.primaryGroupId < 1)
  ) {
    throw new Error("INVALID_PRIMARY_GROUP_ID");
  }
  const hasRunAsIdentity = config.runAsUid !== undefined || config.runAsGid !== undefined;
  if (
    hasRunAsIdentity &&
    (!Number.isSafeInteger(config.runAsUid) ||
      !Number.isSafeInteger(config.runAsGid) ||
      Number(config.runAsUid) <= 0 ||
      Number(config.runAsGid) <= 0)
  ) {
    throw new Error("INVALID_RUN_AS_IDENTITY");
  }
  if (config.gitMetadataPath !== undefined) {
    const expected = path.join(path.resolve(config.sourcePath), ".git");
    if (!path.isAbsolute(config.gitMetadataPath) || path.resolve(config.gitMetadataPath) !== expected) {
      throw new Error("INVALID_GIT_METADATA_PATH");
    }
  }
  if (config.authFilePath && (!path.isAbsolute(config.authFilePath) || config.authFilePath === "/")) {
    throw new Error("INVALID_AUTH_FILE_PATH");
  }
  if (config.configFilePath && (!path.isAbsolute(config.configFilePath) || config.configFilePath === "/")) {
    throw new Error("INVALID_CONFIG_FILE_PATH");
  }
  if (config.mcpConfigFilePath && (!path.isAbsolute(config.mcpConfigFilePath) || config.mcpConfigFilePath === "/"))
    throw new Error("INVALID_MCP_CONFIG_FILE_PATH");
  if (
    config.runtimeStatePath !== undefined &&
    (!path.isAbsolute(config.runtimeStatePath) || config.runtimeStatePath === path.parse(config.runtimeStatePath).root)
  )
    throw new Error("INVALID_RUNTIME_STATE_PATH");
  if (
    config.runtimeStateTarget !== undefined &&
    config.runtimeStateTarget !== "/home/expert/.codex" &&
    config.runtimeStateTarget !== "/home/expert/.claude"
  )
    throw new Error("INVALID_RUNTIME_STATE_TARGET");
  if ((config.runtimeStatePath === undefined) !== (config.runtimeStateTarget === undefined))
    throw new Error("INVALID_RUNTIME_STATE_MOUNT");
  if (config.envNames.some((name) => !isAllowedEnvName(name))) {
    throw new Error("INVALID_ENV_NAME");
  }
  if (config.commandArgs.length === 0 || config.commandArgs.some((arg) => !arg || arg.includes("\0"))) {
    throw new Error("INVALID_COMMAND");
  }

  const runUid = hasRunAsIdentity ? Number(config.runAsUid) : 10001;
  const runGid = hasRunAsIdentity ? Number(config.runAsGid) : (config.primaryGroupId ?? 10001);

  const args = [
    "run",
    "--rm",
    ...(config.containerName ? ["--name", config.containerName] : []),
    ...(config.taskLabels
      ? [
          "--label",
          "team-skill-hub.expert-managed=1",
          "--label",
          `team-skill-hub.task-id=${config.taskLabels.taskId}`,
          "--label",
          `team-skill-hub.run-id=${config.taskLabels.runId}`,
          "--label",
          `team-skill-hub.fencing=${config.taskLabels.fencing}`,
        ]
      : []),
    "--init",
    "--network",
    config.network,
    "--read-only",
    ...(hasRunAsIdentity
      ? ["--user", `${runUid}:${runGid}`]
      : config.primaryGroupId !== undefined
        ? ["--user", `10001:${config.primaryGroupId}`]
        : []),
    ...(!hasRunAsIdentity &&
    config.supplementalGroupId !== undefined &&
    config.supplementalGroupId !== config.primaryGroupId
      ? ["--group-add", String(config.supplementalGroupId)]
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
    `type=bind,src=${config.sourcePath},dst=/workspace${config.workspaceAccess === "read-write" ? "" : ",readonly"}`,
    ...(config.workspaceAccess === "read-write" && config.gitMetadataPath
      ? ["--mount", `type=bind,src=${config.gitMetadataPath},dst=/workspace/.git,readonly`]
      : []),
    "--tmpfs",
    `/tmp:rw,exec,uid=${runUid},gid=${runGid},size=32m`,
    "--tmpfs",
    `/home/expert:rw,uid=${runUid},gid=${runGid},size=64m`,
    ...(config.runtimeStatePath && config.runtimeStateTarget
      ? ["--mount", `type=bind,src=${config.runtimeStatePath},dst=${config.runtimeStateTarget}`]
      : []),
    "--env",
    "HOME=/home/expert",
    "--env",
    "CODEX_HOME=/home/expert/.codex",
    "--env",
    "GIT_OPTIONAL_LOCKS=0",
    "--workdir",
    "/workspace",
  ];

  // Docker's default seccomp profile can block the nested user namespace used
  // by Codex's read-only sandbox on some WSL2 hosts. Opting out is explicit;
  // the outer container remains non-privileged, read-only, and resource-limited.
  if (config.seccompProfile === "unconfined") {
    args.push("--security-opt", "seccomp=unconfined");
  }

  if (config.authFilePath) {
    args.push("--mount", `type=bind,src=${config.authFilePath},dst=/run/codex-auth.json,readonly`);
  }

  if (config.configFilePath) {
    args.push("--mount", `type=bind,src=${config.configFilePath},dst=/run/codex-config.toml,readonly`);
  }
  if (config.mcpConfigFilePath) {
    args.push("--mount", `type=bind,src=${config.mcpConfigFilePath},dst=/run/expert-mcp.json,readonly`);
  }

  for (const name of config.envNames) {
    args.push("--env", name);
  }

  args.push(config.image, ...config.commandArgs);
  return args;
}
