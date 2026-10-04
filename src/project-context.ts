import path from "node:path";
import type { RepositoryConfig } from "./types.js";

export interface ProjectContextMatch {
  repositoryId: string;
  repositoryName: string;
  source: "local-path" | "git-remote" | "cwd-basename" | "cwd-segment";
  gitRemote?: string;
  gitRoot?: string;
  gitBranch?: string;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function canonicalGitRemote(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let remote = value.trim().replace(/[?#].*$/, "");
  remote = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
  const scp = remote.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp && !remote.includes("://")) remote = scp[1] + "/" + scp[2];
  else remote = remote.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  remote = remote.replace(/^\/+/,"").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return remote || undefined;
}

export function resolveProjectContext(
  cwd: string | undefined,
  repositories: RepositoryConfig[],
  git?: { remote?: string; root?: string; branch?: string }
): ProjectContextMatch | undefined {
  const gitRemote = canonicalGitRemote(git?.remote);
  if (gitRemote) {
    const remoteMatches = repositories.filter(
      (repository) => canonicalGitRemote(repository.gitUrl) === gitRemote
    );
    if (remoteMatches.length === 1) {
      const repository = remoteMatches[0]!;
      return {
        repositoryId: repository.id,
        repositoryName: repository.name,
        source: "git-remote",
        gitRemote,
        ...(git?.root ? { gitRoot: git.root } : {}),
        ...(git?.branch ? { gitBranch: git.branch } : {})
      };
    }
  }
  if (!cwd) return undefined;
  const normalizedCwd = normalize(cwd);
  const basename = slug(path.basename(cwd));
  const segments = normalizedCwd.split("/").filter(Boolean).map(slug);
  const matches: ProjectContextMatch[] = [];

  for (const repository of repositories) {
    if (repository.path) {
      const repositoryPath = normalize(repository.path);
      if (
        normalizedCwd === repositoryPath ||
        normalizedCwd.startsWith(repositoryPath + "/")
      ) {
        matches.push({
          repositoryId: repository.id,
          repositoryName: repository.name,
          source: "local-path",
          ...(gitRemote ? { gitRemote } : {}),
          ...(git?.root ? { gitRoot: git.root } : {}),
          ...(git?.branch ? { gitBranch: git.branch } : {})
        });
        continue;
      }
    }

    const id = slug(repository.id);
    const name = slug(repository.name);
    if (basename && (basename === id || basename === name)) {
      matches.push({
        repositoryId: repository.id,
        repositoryName: repository.name,
        source: "cwd-basename",
        ...(gitRemote ? { gitRemote } : {}),
        ...(git?.root ? { gitRoot: git.root } : {}),
        ...(git?.branch ? { gitBranch: git.branch } : {})
      });
      continue;
    }
    if (id && segments.includes(id)) {
      matches.push({
        repositoryId: repository.id,
        repositoryName: repository.name,
        source: "cwd-segment",
        ...(gitRemote ? { gitRemote } : {}),
        ...(git?.root ? { gitRoot: git.root } : {}),
        ...(git?.branch ? { gitBranch: git.branch } : {})
      });
    }
  }

  const unique = new Map(matches.map((item) => [item.repositoryId, item]));
  if (unique.size !== 1) return undefined;
  return [...unique.values()][0];
}
