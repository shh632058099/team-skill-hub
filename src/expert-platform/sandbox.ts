import path from "node:path";

export interface SandboxRunConfig {
  image: string;
  sourcePath: string;
  command: readonly string[];
}

/**
 * Build a restricted offline read-only analysis sandbox.
 * Agent networking and model credentials require a separate reviewed profile.
 */
export function buildReadOnlySandboxArgs(config: SandboxRunConfig): string[] {
  if (!path.isAbsolute(config.sourcePath) || config.sourcePath === "/") {
    throw new Error("INVALID_SOURCE_PATH");
  }
  if (!config.image || config.image.startsWith("-")) throw new Error("INVALID_IMAGE");
  if (config.command.length === 0 || config.command.some((item) => !item || item.includes("\0"))) {
    throw new Error("INVALID_COMMAND");
  }
  return [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--user",
    "65534:65534",
    "--mount",
    `type=bind,src=${config.sourcePath},dst=/source,readonly`,
    "--mount",
    "type=tmpfs,dst=/tmp,tmpfs-size=16777216",
    "--workdir",
    "/source",
    config.image,
    ...config.command,
  ];
}
