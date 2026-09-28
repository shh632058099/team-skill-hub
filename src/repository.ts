import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  MaterializedRepository,
  RepositoryConfig,
  SkillRepositoryProvider
} from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;

async function runGit(
  args: string[],
  cwd?: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv }
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(args, cwd);
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function gitAuthEnv(config: RepositoryConfig, dataDir: string): Promise<NodeJS.ProcessEnv> {
  if (config.gitAuth.type === "none") return {};

  if (config.gitAuth.type === "https-token") {
    const tokenEnv = config.gitAuth.tokenEnv ?? "GITLAB_TOKEN";
    const usernameEnv = config.gitAuth.usernameEnv ?? "GITLAB_USERNAME";
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`Repository ${config.id}: missing Git token environment variable ${tokenEnv}`);
    const username = process.env[usernameEnv] ?? "oauth2";
    const helperDir = path.join(dataDir, "runtime");
    const helperPath = path.join(helperDir, "git-askpass.sh");
    await mkdir(helperDir, { recursive: true });
    await writeFile(
      helperPath,
      "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' \"$SKILL_HUB_GIT_USERNAME\" ;;\n  *) printf '%s\\n' \"$SKILL_HUB_GIT_TOKEN\" ;;\nesac\n",
      { encoding: "utf8", mode: 0o700 }
    );
    await chmod(helperPath, 0o700);
    return {
      GIT_ASKPASS: helperPath,
      GIT_ASKPASS_REQUIRE: "force",
      SKILL_HUB_GIT_USERNAME: username,
      SKILL_HUB_GIT_TOKEN: token
    };
  }

  const keyPath = config.gitAuth.sshKeyPath;
  const knownHostsPath = config.gitAuth.knownHostsPath;
  if (!keyPath || !knownHostsPath) {
    throw new Error(`Repository ${config.id}: ssh auth requires ssh_key_path and known_hosts_path`);
  }
  await stat(keyPath);
  await stat(knownHostsPath);
  return {
    GIT_SSH_COMMAND: `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(knownHostsPath)}`
  };
}

async function digestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replaceAll("\\", "/");
      hash.update(rel);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        hash.update(await readFile(full));
      }
    }
  }
  await walk(root);
  return hash.digest("hex").slice(0, 16);
}

export class LocalRepositoryProvider implements SkillRepositoryProvider {
  readonly type = "local" as const;

  async materialize(config: RepositoryConfig): Promise<MaterializedRepository> {
    const sourceRoot = path.resolve(config.path!);
    const info = await stat(sourceRoot);
    if (!info.isDirectory()) throw new Error(`${sourceRoot} is not a directory`);
    const head = await tryGit(sourceRoot, ["rev-parse", "HEAD"]);
    const dirty = await tryGit(sourceRoot, ["status", "--porcelain"]);
    const digest = await digestTree(sourceRoot);
    const revision = head
      ? dirty
        ? `${head.slice(0, 12)}-dirty-${digest}`
        : head
      : `local-${digest}`;
    return { config, sourceRoot, revision };
  }
}

export class GitRepositoryProvider implements SkillRepositoryProvider {
  readonly type = "git" as const;

  async materialize(config: RepositoryConfig, dataDir: string): Promise<MaterializedRepository> {
    const authEnv = await gitAuthEnv(config, dataDir);
    const sourceRoot = path.join(dataDir, "sources", config.id);
    const gitDir = path.join(sourceRoot, ".git");
    await mkdir(path.dirname(sourceRoot), { recursive: true });
    let exists = true;
    try {
      await stat(gitDir);
    } catch {
      exists = false;
    }

    if (!exists) {
      await rm(sourceRoot, { recursive: true, force: true });
      await runGit(
        [
          "clone",
          "--depth",
          "1",
          "--no-tags",
          "--branch",
          config.branch ?? "main",
          config.gitUrl!,
          sourceRoot
        ],
        undefined,
        authEnv
      );
    } else {
      await runGit(["remote", "set-url", "origin", config.gitUrl!], sourceRoot, authEnv);
      await runGit(
        ["fetch", "--depth", "1", "--no-tags", "origin", config.branch ?? "main"],
        sourceRoot,
        authEnv
      );
      await runGit(["reset", "--hard", "FETCH_HEAD"], sourceRoot, authEnv);
      await runGit(["clean", "-ffdx"], sourceRoot, authEnv);
    }
    const revision = await runGit(["rev-parse", "HEAD"], sourceRoot, authEnv);
    if (!revision) throw new Error(`Repository ${config.id} has no resolved revision`);
    return { config, sourceRoot, revision };
  }
}

export async function createValidatedSnapshot(
  sourceRoot: string,
  dataDir: string,
  repositoryId: string,
  revision: string
): Promise<string> {
  const safeRevision = revision.replace(/[^A-Za-z0-9._-]/g, "_");
  const destination = path.join(dataDir, "revisions", repositoryId, safeRevision);
  try {
    const info = await stat(destination);
    if (info.isDirectory()) return destination;
  } catch {
    // continue
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(sourceRoot, destination, {
    recursive: true,
    filter(source) {
      const rel = path.relative(sourceRoot, source);
      return !rel.split(path.sep).includes(".git");
    }
  });
  return destination;
}
