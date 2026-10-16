import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RepositoryConfig } from "./types.js";
import {
  canonicalTreeHash,
  diffSkillBundleTrees,
  skillBundleFileBytes,
  type SkillBundleFile,
  type SkillBundleImport,
  type SkillBundlePublication,
  type SkillBundlePullRequestPublication,
  type SkillBundleSnapshot,
} from "./skill-bundles.js";

const execFileAsync = promisify(execFile);
export type SkillBundleGitRun = (args: string[], cwd?: string) => Promise<string>;
type FetchLike = typeof fetch;

export class SkillBundleReviewStaleError extends Error {
  constructor(message = "Skill Bundle review baseline changed before publication") {
    super(message);
    this.name = "SkillBundleReviewStaleError";
  }
}

async function defaultGitRun(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function githubApiBase(baseUrl: string): string {
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  return url.hostname.toLowerCase() === "github.com" ? "https://api.github.com" : `${url.origin}/api/v3`;
}

function sshUrl(baseUrl: string, projectPath: string): string {
  const host = new URL(baseUrl).hostname;
  return `git@${host}:${projectPath.replace(/^\/+/, "").replace(/\.git$/i, "")}.git`;
}

function branchSuffix(id: string): string {
  return (
    id
      .replace(/^sbi_/, "")
      .replace(/[^A-Za-z0-9]+/g, "")
      .slice(0, 12)
      .toLowerCase() || "bundle"
  );
}

async function readTree(root: string): Promise<SkillBundleFile[]> {
  const result: SkillBundleFile[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  async function walk(dir: string, relative = ""): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) throw new Error(`replacementRoot contains symlink: ${relativePath}`);
      if (info.isDirectory()) {
        await walk(filePath, relativePath);
        continue;
      }
      if (!info.isFile()) throw new Error(`replacementRoot contains unsupported file: ${relativePath}`);
      const bytes = await readFile(filePath);
      let content: string | undefined;
      try {
        const decoded = decoder.decode(bytes);
        if (!decoded.includes("\0")) content = decoded;
      } catch {}
      const crypto = await import("node:crypto");
      result.push({
        path: relativePath.replaceAll("\\", "/"),
        ...(content !== undefined ? { content } : { contentBase64: bytes.toString("base64") }),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        mode: (info.mode & 0o111) !== 0 ? "0755" : "0644",
      });
    }
  }
  await walk(root);
  return result;
}

async function replaceRoot(worktree: string, targetRoot: string, snapshot: SkillBundleSnapshot): Promise<void> {
  const target = path.join(worktree, ...targetRoot.split("/"));
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const file of snapshot.files) {
    const destination = path.join(target, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, skillBundleFileBytes(file));
    await chmod(destination, file.mode === "0755" ? 0o755 : 0o644);
  }
}

export interface SkillBundleReconcileResult {
  publication: SkillBundlePullRequestPublication;
  finalTreeMatches?: boolean;
  finalDiff?: ReturnType<typeof diffSkillBundleTrees>;
}

export class SkillBundlePublisher {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly gitRun: SkillBundleGitRun = defaultGitRun,
  ) {}

  private resolve(repository: RepositoryConfig) {
    const config = repository.skillPublishing;
    if (!config?.enabled) throw new Error("Skill publishing is disabled for repository");
    if (!config.projectPath) throw new Error("Skill publishing projectPath is required");
    const baseUrl = (config.baseUrl ?? (config.provider === "github" ? "https://github.com" : undefined))?.replace(
      /\/+$/,
      "",
    );
    if (!baseUrl) throw new Error("Skill publishing baseUrl is required");
    const token = process.env[config.tokenEnv];
    if (!token) throw new Error(`Missing Skill publishing token environment variable ${config.tokenEnv}`);
    return {
      config,
      baseUrl,
      projectPath: config.projectPath.replace(/^\/+/, "").replace(/\.git$/i, ""),
      token,
      remoteUrl: sshUrl(baseUrl, config.projectPath),
      targetBranch: config.targetBranch || repository.branch || "main",
    };
  }

  private async request(
    url: string,
    token: string,
    provider: "github" | "gitlab",
    init: RequestInit,
  ): Promise<Response> {
    return await this.fetchImpl(url, {
      ...init,
      headers: {
        ...(provider === "github"
          ? {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              "x-github-api-version": "2022-11-28",
            }
          : { "private-token": token }),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async readGitLabReplacementRoot(
    baseUrl: string,
    projectPath: string,
    token: string,
    replacementRoot: string,
    ref: string,
  ): Promise<SkillBundleFile[]> {
    const project = encodeURIComponent(projectPath);
    const entries: Array<{ type?: string; path?: string; mode?: string }> = [];
    let page = 1;
    while (true) {
      const query = new URLSearchParams({
        path: replacementRoot,
        ref,
        recursive: "true",
        per_page: "100",
        page: String(page),
      });
      const response = await this.request(
        `${baseUrl}/api/v4/projects/${project}/repository/tree?${query.toString()}`,
        token,
        "gitlab",
        { method: "GET" },
      );
      if (response.status === 404) return [];
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`GitLab repository tree lookup failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      const rows = (await response.json()) as Array<{ type?: string; path?: string; mode?: string }>;
      entries.push(...rows);
      const nextPage = response.headers.get("x-next-page");
      if (nextPage) {
        page = Number(nextPage);
        continue;
      }
      if (rows.length < 100) break;
      page += 1;
    }

    const files: SkillBundleFile[] = [];
    const crypto = await import("node:crypto");
    for (const entry of entries) {
      if (entry.type !== "blob" || !entry.path) continue;
      const response = await this.request(
        `${baseUrl}/api/v4/projects/${project}/repository/files/${encodeURIComponent(entry.path)}?ref=${encodeURIComponent(ref)}`,
        token,
        "gitlab",
        { method: "GET" },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`GitLab repository file lookup failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      const file = (await response.json()) as {
        content?: string;
        encoding?: string;
        execute_filemode?: boolean;
      };
      if (typeof file.content !== "string")
        throw new Error(`GitLab repository file response is incomplete: ${entry.path}`);
      const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
      const relativePath = entry.path.startsWith(`${replacementRoot}/`)
        ? entry.path.slice(replacementRoot.length + 1)
        : entry.path;
      let content: string | undefined;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!decoded.includes("\0")) content = decoded;
      } catch {}
      files.push({
        path: relativePath,
        ...(content !== undefined ? { content } : { contentBase64: bytes.toString("base64") }),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        mode: file.execute_filemode === true || entry.mode === "100755" ? "0755" : "0644",
      });
    }
    return files;
  }

  private async gitLabBranchHeadIfExists(
    baseUrl: string,
    projectPath: string,
    token: string,
    branch: string,
  ): Promise<string | undefined> {
    const project = encodeURIComponent(projectPath);
    const response = await this.request(
      `${baseUrl}/api/v4/projects/${project}/repository/branches/${encodeURIComponent(branch)}`,
      token,
      "gitlab",
      { method: "GET" },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitLab branch lookup failed (${response.status})`);
    const value = (await response.json()) as { commit?: { id?: string } };
    if (!value.commit?.id) throw new Error("GitLab branch response is incomplete");
    return value.commit.id;
  }

  private async gitLabBranchHead(baseUrl: string, projectPath: string, token: string, branch: string): Promise<string> {
    const revision = await this.gitLabBranchHeadIfExists(baseUrl, projectPath, token, branch);
    if (!revision) throw new Error("GitLab branch lookup failed (404)");
    return revision;
  }

  private async publishGitLab(
    record: SkillBundleImport,
    snapshot: SkillBundleSnapshot,
    baseUrl: string,
    projectPath: string,
    token: string,
    targetBranch: string,
    branch: string,
  ): Promise<SkillBundlePublication> {
    const targetRevision = await this.gitLabBranchHead(baseUrl, projectPath, token, targetBranch);
    const before = await this.readGitLabReplacementRoot(
      baseUrl,
      projectPath,
      token,
      record.replacementRoot,
      targetRevision,
    );
    if (canonicalTreeHash(before) !== record.review?.targetTreeSha256) throw new SkillBundleReviewStaleError();

    const expectedTreeSha256 = canonicalTreeHash(snapshot.files);
    if (canonicalTreeHash(before) === expectedTreeSha256) {
      return {
        kind: "no-op",
        targetRevision,
        targetRoot: record.replacementRoot,
        checkedAt: new Date().toISOString(),
        expectedTreeSha256,
      };
    }

    const diff = diffSkillBundleTrees(before, snapshot.files);
    const beforeByPath = new Map(before.map((file) => [file.path, file]));
    const snapshotByPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const actions: Array<{
      action: "create" | "update" | "delete" | "chmod";
      file_path: string;
      content?: string;
      encoding?: "base64";
      execute_filemode?: boolean;
    }> = [];
    const addWriteAction = (action: "create" | "update", relativePath: string) => {
      const file = snapshotByPath.get(relativePath);
      if (!file) throw new Error(`Skill Bundle snapshot file is missing: ${relativePath}`);
      const filePath = `${record.replacementRoot}/${relativePath}`;
      actions.push({
        action,
        file_path: filePath,
        content: skillBundleFileBytes(file).toString("base64"),
        encoding: "base64",
      });
      const previousMode = beforeByPath.get(relativePath)?.mode ?? "0644";
      if (file.mode !== previousMode) {
        actions.push({
          action: "chmod",
          file_path: filePath,
          execute_filemode: file.mode === "0755",
        });
      }
    };
    for (const relativePath of diff.modified) addWriteAction("update", relativePath);
    for (const relativePath of diff.added) addWriteAction("create", relativePath);
    for (const relativePath of diff.deleted) {
      actions.push({ action: "delete", file_path: `${record.replacementRoot}/${relativePath}` });
    }

    const project = encodeURIComponent(projectPath);
    const existingBranchRevision = await this.gitLabBranchHeadIfExists(baseUrl, projectPath, token, branch);
    if (!existingBranchRevision) {
      const createBranch = await this.request(
        `${baseUrl}/api/v4/projects/${project}/repository/branches`,
        token,
        "gitlab",
        {
          method: "POST",
          body: JSON.stringify({ branch, ref: targetRevision }),
        },
      );
      if (!createBranch.ok) {
        const detail = await createBranch.text().catch(() => "");
        throw new Error(
          `GitLab Skill Bundle branch creation failed (${createBranch.status}): ${detail.slice(0, 1000)}`,
        );
      }
    }

    const commit = await this.request(`${baseUrl}/api/v4/projects/${project}/repository/commits`, token, "gitlab", {
      method: "POST",
      body: JSON.stringify({
        branch,
        ...(existingBranchRevision ? { start_sha: targetRevision, force: true } : {}),
        commit_message: `feat: sync skill bundle ${record.namespace} from ${record.id}`,
        actions,
      }),
    });
    if (!commit.ok) {
      const detail = await commit.text().catch(() => "");
      throw new Error(`GitLab Skill Bundle commit failed (${commit.status}): ${detail.slice(0, 1000)}`);
    }

    const create = await this.request(`${baseUrl}/api/v4/projects/${project}/merge_requests`, token, "gitlab", {
      method: "POST",
      body: JSON.stringify({
        source_branch: branch,
        target_branch: targetBranch,
        title: `Sync Skill Bundle: ${record.namespace}`,
        description: `Skill Bundle Import: ${record.id}\nReplacement root: ${record.replacementRoot}`,
      }),
    });
    let mr: { iid?: number; web_url?: string; state?: string } | undefined;
    if (create.ok) mr = (await create.json()) as typeof mr;
    else if (create.status === 409) {
      const list = await this.request(
        `${baseUrl}/api/v4/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(targetBranch)}`,
        token,
        "gitlab",
        { method: "GET" },
      );
      if (list.ok) mr = ((await list.json()) as Array<NonNullable<typeof mr>>)[0];
    }
    if (!mr?.iid || !mr.web_url) throw new Error(`GitLab merge request creation failed (${create.status})`);
    const now = new Date().toISOString();
    return {
      kind: "pull-request",
      provider: "gitlab",
      projectPath,
      branch,
      targetBranch,
      targetRoot: record.replacementRoot,
      mergeRequestIid: mr.iid,
      mergeRequestUrl: mr.web_url,
      mergeRequestState: mr.state === "closed" || mr.state === "locked" ? mr.state : "opened",
      added: diff.added.length,
      modified: diff.modified.length,
      deleted: diff.deleted.length,
      expectedTreeSha256,
      pullRequestCreatedAt: now,
      lastCheckedAt: now,
    };
  }

  async publish(
    record: SkillBundleImport,
    snapshot: SkillBundleSnapshot,
    repository: RepositoryConfig,
  ): Promise<SkillBundlePublication> {
    if (!["approved", "publish_failed"].includes(record.status))
      throw new Error("Skill Bundle import must be approved before publishing");
    if (!record.review?.targetTreeSha256 || !record.review.targetRevision) {
      throw new Error("Skill Bundle approval review is missing target baseline");
    }
    const { config, baseUrl, projectPath, token, remoteUrl, targetBranch } = this.resolve(repository);
    const branch = `${config.branchPrefix || "skill-hub-skill"}-${branchSuffix(record.id)}`;
    if (config.provider === "gitlab") {
      return await this.publishGitLab(record, snapshot, baseUrl, projectPath, token, targetBranch, branch);
    }
    const parent = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-publish-"));
    const worktree = path.join(parent, "repo");
    try {
      await this.gitRun(["clone", "--depth", "1", "--no-tags", "--branch", targetBranch, remoteUrl, worktree]);
      const targetPath = path.join(worktree, ...record.replacementRoot.split("/"));
      const before = await readTree(targetPath);
      if (canonicalTreeHash(before) !== record.review.targetTreeSha256) {
        throw new SkillBundleReviewStaleError();
      }
      const expectedTreeSha256 = canonicalTreeHash(snapshot.files);
      if (canonicalTreeHash(before) === expectedTreeSha256) {
        const targetRevision = (await this.gitRun(["rev-parse", "HEAD"], worktree)) || targetBranch;
        return {
          kind: "no-op",
          targetRevision,
          targetRoot: record.replacementRoot,
          checkedAt: new Date().toISOString(),
          expectedTreeSha256,
        };
      }
      const diff = diffSkillBundleTrees(before, snapshot.files);
      const remoteBranch = await this.gitRun(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], worktree);
      const remoteBranchSha = remoteBranch.trim() ? remoteBranch.trim().split(/\s+/)[0] : undefined;
      await this.gitRun(["checkout", "-B", branch], worktree);
      await replaceRoot(worktree, record.replacementRoot, snapshot);
      await this.gitRun(["add", "-A", "--", record.replacementRoot], worktree);
      await this.gitRun(["config", "user.name", "Team Skill Hub"], worktree);
      await this.gitRun(["config", "user.email", "team-skill-hub@localhost"], worktree);
      await this.gitRun(["commit", "-m", `feat: sync skill bundle ${record.namespace} from ${record.id}`], worktree);
      if (remoteBranchSha) {
        await this.gitRun(
          ["push", `--force-with-lease=refs/heads/${branch}:${remoteBranchSha}`, "origin", `HEAD:refs/heads/${branch}`],
          worktree,
        );
      } else {
        await this.gitRun(["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], worktree);
      }
      const now = new Date().toISOString();
      if (config.provider === "github") {
        const api = githubApiBase(baseUrl);
        const create = await this.request(`${api}/repos/${projectPath}/pulls`, token, "github", {
          method: "POST",
          body: JSON.stringify({
            title: `Sync Skill Bundle: ${record.namespace}`,
            head: branch,
            base: targetBranch,
            body: `Skill Bundle Import: ${record.id}\nReplacement root: ${record.replacementRoot}\nAdded: ${diff.added.length}, modified: ${diff.modified.length}, deleted: ${diff.deleted.length}`,
          }),
        });
        let pr: { number?: number; html_url?: string; state?: string } | undefined;
        if (create.ok) pr = (await create.json()) as typeof pr;
        else if (create.status === 422) {
          const list = await this.request(
            `${api}/repos/${projectPath}/pulls?state=open&head=${encodeURIComponent(projectPath.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(targetBranch)}`,
            token,
            "github",
            { method: "GET" },
          );
          if (list.ok) pr = ((await list.json()) as Array<NonNullable<typeof pr>>)[0];
        }
        if (!pr?.number || !pr.html_url) throw new Error(`GitHub pull request creation failed (${create.status})`);
        return {
          kind: "pull-request",
          provider: "github",
          projectPath,
          branch,
          targetBranch,
          targetRoot: record.replacementRoot,
          mergeRequestIid: pr.number,
          mergeRequestUrl: pr.html_url,
          mergeRequestState: pr.state === "closed" ? "closed" : "opened",
          added: diff.added.length,
          modified: diff.modified.length,
          deleted: diff.deleted.length,
          expectedTreeSha256,
          pullRequestCreatedAt: now,
          lastCheckedAt: now,
        };
      }
      throw new Error(`Unsupported Skill publishing provider: ${config.provider}`);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  async reconcile(
    publication: SkillBundlePullRequestPublication,
    snapshot: SkillBundleSnapshot,
    repository: RepositoryConfig,
  ): Promise<SkillBundleReconcileResult> {
    const { config, baseUrl, projectPath, token, remoteUrl, targetBranch } = this.resolve(repository);
    if (publication.projectPath !== projectPath)
      throw new Error("Skill Bundle publication project does not match repository configuration");
    const now = new Date().toISOString();
    let next: SkillBundlePullRequestPublication;
    if (config.provider === "github") {
      const response = await this.request(
        `${githubApiBase(baseUrl)}/repos/${projectPath}/pulls/${publication.mergeRequestIid}`,
        token,
        "github",
        { method: "GET" },
      );
      if (!response.ok) throw new Error(`GitHub pull request lookup failed (${response.status})`);
      const pr = (await response.json()) as {
        state?: string;
        merged_at?: string | null;
        closed_at?: string | null;
        merge_commit_sha?: string | null;
      };
      const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "opened";
      next = {
        ...publication,
        mergeRequestState: state,
        lastCheckedAt: now,
        ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}),
        ...(pr.closed_at ? { closedAt: pr.closed_at } : {}),
        ...(pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
      };
    } else {
      const response = await this.request(
        `${baseUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${publication.mergeRequestIid}`,
        token,
        "gitlab",
        { method: "GET" },
      );
      if (!response.ok) throw new Error(`GitLab merge request lookup failed (${response.status})`);
      const mr = (await response.json()) as {
        state?: string;
        merged_at?: string | null;
        closed_at?: string | null;
        merge_commit_sha?: string | null;
      };
      const state = mr.state === "merged" || mr.state === "closed" || mr.state === "locked" ? mr.state : "opened";
      next = {
        ...publication,
        mergeRequestState: state,
        lastCheckedAt: now,
        ...(mr.merged_at ? { mergedAt: mr.merged_at } : {}),
        ...(mr.closed_at ? { closedAt: mr.closed_at } : {}),
        ...(mr.merge_commit_sha ? { mergeCommitSha: mr.merge_commit_sha } : {}),
      };
    }
    if (next.mergeRequestState !== "merged") return { publication: next };
    if (config.provider === "gitlab") {
      const tree = await this.readGitLabReplacementRoot(
        baseUrl,
        projectPath,
        token,
        next.targetRoot,
        next.mergeCommitSha ?? targetBranch,
      );
      const finalTreeSha256 = canonicalTreeHash(tree);
      next = { ...next, finalTreeSha256, finalTreeVerifiedAt: new Date().toISOString() };
      const finalTreeMatches = finalTreeSha256 === next.expectedTreeSha256;
      return {
        publication: next,
        finalTreeMatches,
        ...(finalTreeMatches ? {} : { finalDiff: diffSkillBundleTrees(snapshot.files, tree) }),
      };
    }
    const parent = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-reconcile-"));
    const worktree = path.join(parent, "repo");
    try {
      await this.gitRun(["clone", "--depth", "1", "--no-tags", "--branch", targetBranch, remoteUrl, worktree]);
      const tree = await readTree(path.join(worktree, ...next.targetRoot.split("/")));
      const finalTreeSha256 = canonicalTreeHash(tree);
      next = { ...next, finalTreeSha256, finalTreeVerifiedAt: new Date().toISOString() };
      const finalTreeMatches = finalTreeSha256 === next.expectedTreeSha256;
      return {
        publication: next,
        finalTreeMatches,
        ...(finalTreeMatches ? {} : { finalDiff: diffSkillBundleTrees(snapshot.files, tree) }),
      };
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
}
