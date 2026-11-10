import { rm } from "node:fs/promises";
import path from "node:path";

export async function removeWorkspaceDirectory(repositoryRoot: string, workspaceKey: string): Promise<string> {
  if (!path.isAbsolute(repositoryRoot) || repositoryRoot === path.parse(repositoryRoot).root) {
    throw new Error("INVALID_WORKSPACE_ROOT");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(workspaceKey)) {
    throw new Error("INVALID_WORKSPACE_KEY");
  }
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(root, workspaceKey);
  if (path.dirname(target) !== root || target === root) throw new Error("INVALID_WORKSPACE_PATH");
  await rm(target, { recursive: true, force: true });
  return target;
}
