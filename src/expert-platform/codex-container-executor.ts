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

export interface CodexDockerConfig {
  image: string;
  containerName?: string;
  taskLabels?: { taskId: string; runId: string; fencing: number };
  sourcePath: string;
  network: string;
  seccompProfile?: "default" | "unconfined";
  supplementalGroupId?: number;
  envNames: readonly string[];
  authFilePath?: string;
  configFilePath?: string;
  mcpConfigFilePath?: string;
  codexArgs: readonly string[];
}

export function buildCodexDockerArgs(config: CodexDockerConfig): string[] {
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
  if (config.authFilePath && (!path.isAbsolute(config.authFilePath) || config.authFilePath === "/")) {
    throw new Error("INVALID_AUTH_FILE_PATH");
  }
  if (config.configFilePath && (!path.isAbsolute(config.configFilePath) || config.configFilePath === "/")) {
    throw new Error("INVALID_CONFIG_FILE_PATH");
  }
  if (config.mcpConfigFilePath && (!path.isAbsolute(config.mcpConfigFilePath) || config.mcpConfigFilePath === "/"))
    throw new Error("INVALID_MCP_CONFIG_FILE_PATH");
  if (config.envNames.some((name) => !isAllowedEnvName(name))) {
    throw new Error("INVALID_ENV_NAME");
  }
  if (config.codexArgs.length === 0 || config.codexArgs.some((arg) => !arg || arg.includes("\0"))) {
    throw new Error("INVALID_COMMAND");
  }

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
    ...(config.supplementalGroupId !== undefined ? ["--group-add", String(config.supplementalGroupId)] : []),
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
    `type=bind,src=${config.sourcePath},dst=/workspace,readonly`,
    "--mount",
    "type=tmpfs,dst=/tmp,tmpfs-size=33554432",
    "--tmpfs",
    "/home/expert:rw,uid=10001,gid=10001,size=64m",
    "--env",
    "HOME=/home/expert",
    "--env",
    "CODEX_HOME=/home/expert/.codex",
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

  args.push(config.image, ...config.codexArgs);
  return args;
}
