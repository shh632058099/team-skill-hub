import { spawn } from "node:child_process";
import { chmod, chown, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { EXECUTION_CONTAINER_UID } from "./repository-workspace.js";

export interface WorkspaceCleanupOptions {
  image: string;
  workerGroupId: number;
  runDocker?: (args: readonly string[]) => Promise<number>;
  removeDirectory?: (target: string) => Promise<void>;
}

export function buildWorkspaceCleanupRepairDockerArgs(target: string, image: string, workerGroupId: number): string[] {
  if (!path.isAbsolute(target) || target === path.parse(target).root) throw new Error("INVALID_WORKSPACE_PATH");
  if (!image || image.startsWith("-") || /[\r\n\0]/.test(image)) throw new Error("INVALID_WORKSPACE_CLEANUP_IMAGE");
  if (!Number.isSafeInteger(workerGroupId) || workerGroupId < 1) throw new Error("INVALID_WORKSPACE_CLEANUP_GROUP");
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    `${EXECUTION_CONTAINER_UID}:${workerGroupId}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--cpus",
    "1",
    "--mount",
    `type=bind,src=${target},dst=/workspace`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    `find /workspace -xdev -uid ${EXECUTION_CONTAINER_UID} -exec chmod g+rwX -- {} +`,
  ];
}

function defaultRunDocker(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => resolve(typeof code === "number" ? code : 1));
  });
}

function permissionFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}

export async function removeWorkspaceDirectory(
  repositoryRoot: string,
  workspaceKey: string,
  options?: WorkspaceCleanupOptions,
): Promise<string> {
  if (!path.isAbsolute(repositoryRoot) || repositoryRoot === path.parse(repositoryRoot).root) {
    throw new Error("INVALID_WORKSPACE_ROOT");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(workspaceKey)) {
    throw new Error("INVALID_WORKSPACE_KEY");
  }
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, workspaceKey);
  if (path.dirname(target) !== root || target === root) throw new Error("INVALID_WORKSPACE_PATH");
  const removeDirectory =
    options?.removeDirectory ?? ((candidate: string) => rm(candidate, { recursive: true, force: true }));
  try {
    await removeDirectory(target);
  } catch (error) {
    if (!options || !permissionFailure(error)) throw error;
    const stat = await lstat(target);
    const workerUid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (!stat.isDirectory() || stat.uid !== workerUid) throw new Error("WORKSPACE_CLEANUP_OWNER_INVALID");
    if (stat.gid !== options.workerGroupId) {
      try {
        await chown(target, stat.uid, options.workerGroupId);
      } catch (chownError) {
        if (permissionFailure(chownError)) throw new Error("WORKSPACE_CLEANUP_GROUP_NOT_CONFIGURED");
        throw chownError;
      }
    }
    await chmod(target, 0o770);
    const runDocker = options.runDocker ?? defaultRunDocker;
    const code = await runDocker(buildWorkspaceCleanupRepairDockerArgs(target, options.image, options.workerGroupId));
    if (code !== 0) throw new Error("WORKSPACE_CLEANUP_PERMISSION_REPAIR_FAILED");
    await removeDirectory(target);
  }
  return target;
}
