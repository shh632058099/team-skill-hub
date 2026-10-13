import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { KnowledgePublishingConfig, RepositoryConfig } from "./types.js";
import type { KnowledgeCandidate } from "./observability.js";

const execFileAsync = promisify(execFile);

export interface KnowledgePublicationResult {
  provider: "gitlab" | "github";
  projectPath: string;
  branch: string;
  targetBranch: string;
  filePath: string;
  action: "create" | "update";
  mergeRequestIid: number;
  mergeRequestUrl: string;
  publishedAt: string;
  mergeRequestState: "opened" | "merged" | "closed" | "locked";
  lastCheckedAt: string;
  mergedAt?: string;
  closedAt?: string;
  mergeCommitSha?: string;
  pipelineStatus?: string;
  hasConflicts?: boolean;
  detailedMergeStatus?: string;
  sourceBranchExists?: boolean;
}

export interface KnowledgePublisher {
  publish(candidate: KnowledgeCandidate, repository: RepositoryConfig): Promise<KnowledgePublicationResult>;
  reconcile(
    publication: NonNullable<KnowledgeCandidate["publication"]>,
    repository: RepositoryConfig
  ): Promise<Pick<
    KnowledgePublicationResult,
    | "mergeRequestState"
    | "lastCheckedAt"
    | "mergedAt"
    | "closedAt"
    | "mergeCommitSha"
    | "pipelineStatus"
    | "hasConflicts"
    | "detailedMergeStatus"
    | "sourceBranchExists"
  >>;
}

type FetchLike = typeof fetch;
type GitRun = (args: string[], cwd?: string) => Promise<string>;

async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      ...(cwd ? { cwd } : {}),
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return ascii || "knowledge";
}

function assertSafePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.startsWith(".") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Candidate suggestedPath is invalid");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Knowledge publishing currently requires a .md target path");
  }
  return normalized;
}

function inferGitLabLocation(gitUrl?: string): { baseUrl?: string; projectPath?: string } {
  if (!gitUrl) return {};
  const trimmed = gitUrl.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        baseUrl: url.origin,
        projectPath: url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "")
      };
    } catch {
      return {};
    }
  }

  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        baseUrl: "https://" + url.hostname,
        projectPath: url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "")
      };
    } catch {
      return {};
    }
  }

  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    return {
      baseUrl: "https://" + scp[1],
      projectPath: scp[2]!.replace(/^\/+/, "").replace(/\.git$/i, "")
    };
  }
  return {};
}

function githubApiBase(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const url = new URL(normalized);
  return url.hostname.toLowerCase() === "github.com" ? "https://api.github.com" : `${url.origin}/api/v3`;
}

function githubSshUrl(baseUrl: string, projectPath: string): string {
  const host = new URL(baseUrl).hostname;
  return `git@${host}:${projectPath.replace(/^\/+/, "").replace(/\.git$/i, "")}.git`;
}

function markdownForCandidate(candidate: KnowledgeCandidate): string {
  const body = candidate.content.trim();
  if (candidate.suggestedType === "skill") return body + "\n";
  if (/^#\s+/m.test(body)) return body + "\n";
  return "# " + candidate.title.trim() + "\n\n" + body + "\n";
}

function candidateLabel(candidate: KnowledgeCandidate): string {
  return candidate.suggestedType === "skill" ? "Skill" : "Knowledge";
}

export function defaultCandidatePath(candidate: KnowledgeCandidate): string {
  if (candidate.suggestedType === "skill") {
    const root = candidate.skillCollection === "custom-skills" ? "custom" : "skills";
    return `${root}/${slugify(candidate.title)}/SKILL.md`;
  }
  const idSuffix = candidate.id.replace(/^kc_/, "").replace(/[^A-Za-z0-9]+/g, "").slice(0, 12).toLowerCase() || "candidate";
  return `knowledge/${slugify(candidate.title)}-${idSuffix}.md`;
}

export class GitLabKnowledgePublisher implements KnowledgePublisher {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private resolve(repository: RepositoryConfig): {
    config: KnowledgePublishingConfig;
    baseUrl: string;
    projectPath: string;
    token: string;
  } {
    const config = repository.knowledgePublishing;
    if (!config?.enabled) throw new Error("Knowledge publishing is disabled for this repository");
    if (config.provider !== "gitlab") throw new Error("Unsupported knowledge publisher");

    const inferred = inferGitLabLocation(repository.gitUrl);
    const baseUrl = (config.baseUrl ?? inferred.baseUrl)?.replace(/\/+$/, "");
    const projectPath = config.projectPath ?? inferred.projectPath;
    if (!baseUrl) throw new Error("GitLab publishing baseUrl is not configured and could not be inferred");
    if (!projectPath) throw new Error("GitLab publishing projectPath is not configured and could not be inferred");

    const token = process.env[config.tokenEnv];
    if (!token) throw new Error(`Missing GitLab publishing token environment variable ${config.tokenEnv}`);
    return { config, baseUrl, projectPath, token };
  }

  private async request(
    url: string,
    token: string,
    init: RequestInit
  ): Promise<Response> {
    return await this.fetchImpl(url, {
      ...init,
      headers: {
        "private-token": token,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });
  }

  async publish(candidate: KnowledgeCandidate, repository: RepositoryConfig): Promise<KnowledgePublicationResult> {
    if (candidate.status !== "approved" && candidate.status !== "publish_failed") {
      throw new Error("Candidate must be approved before publishing");
    }

    const { config, baseUrl, projectPath, token } = this.resolve(repository);
    const project = encodeURIComponent(projectPath);
    const filePath = assertSafePath(
      candidate.suggestedPath ?? defaultCandidatePath(candidate)
    );
    const encodedFile = encodeURIComponent(filePath);
    const targetBranch = config.targetBranch || repository.branch || "main";
    const prefix = slugify(config.branchPrefix || "skill-hub-knowledge");
    const branch = `${prefix}-${candidate.id.replace(/^kc_/, "").slice(0, 12)}`;
    const desiredContent = markdownForCandidate(candidate);

    const fileUrl = `${baseUrl}/api/v4/projects/${project}/repository/files/${encodedFile}`;
    const branchUrl = `${baseUrl}/api/v4/projects/${project}/repository/branches/${encodeURIComponent(branch)}`;
    const branchResponse = await this.request(branchUrl, token, { method: "GET" });
    if (![200, 404].includes(branchResponse.status)) {
      const detail = await branchResponse.text().catch(() => "");
      throw new Error(`GitLab branch lookup failed (${branchResponse.status}): ${detail.slice(0, 500)}`);
    }
    const branchExists = branchResponse.status === 200;

    const targetExistsResponse = await this.request(
      fileUrl + "?ref=" + encodeURIComponent(targetBranch),
      token,
      { method: "HEAD" }
    );
    if (![200, 404].includes(targetExistsResponse.status)) {
      const detail = await targetExistsResponse.text().catch(() => "");
      throw new Error(`GitLab file lookup failed (${targetExistsResponse.status}): ${detail.slice(0, 500)}`);
    }

    let branchFileExists = false;
    let branchFileMatches = false;
    if (branchExists) {
      const branchFileResponse = await this.request(
        fileUrl + "?ref=" + encodeURIComponent(branch),
        token,
        { method: "GET" }
      );
      if (![200, 404].includes(branchFileResponse.status)) {
        const detail = await branchFileResponse.text().catch(() => "");
        throw new Error(`GitLab branch file lookup failed (${branchFileResponse.status}): ${detail.slice(0, 500)}`);
      }
      branchFileExists = branchFileResponse.status === 200;
      if (branchFileExists) {
        const existingFile = await branchFileResponse.json() as { content?: string; encoding?: string };
        if (existingFile.content && existingFile.encoding === "base64") {
          branchFileMatches = Buffer.from(existingFile.content, "base64").toString("utf8") === desiredContent;
        }
      }
    }

    const action: "create" | "update" = targetExistsResponse.status === 200 ? "update" : "create";
    if (!branchFileMatches) {
      const payload: Record<string, unknown> = {
        branch,
        content: desiredContent,
        commit_message: `${candidate.suggestedType === "skill" ? "feat" : "docs"}: add ${candidate.suggestedType} from ${candidate.id}`
      };
      if (!branchExists) payload.start_branch = targetBranch;

      const fileMethod =
        branchExists ? (branchFileExists ? "PUT" : "POST") : action === "create" ? "POST" : "PUT";
      const fileResponse = await this.request(fileUrl, token, {
        method: fileMethod,
        body: JSON.stringify(payload)
      });
      if (!fileResponse.ok) {
        const detail = await fileResponse.text().catch(() => "");
        throw new Error(`GitLab file publish failed (${fileResponse.status}): ${detail.slice(0, 1000)}`);
      }
    }

    let mr: { iid?: number; web_url?: string; state?: string; merged_at?: string; closed_at?: string; merge_commit_sha?: string } | undefined;
    const mrResponse = await this.request(
      `${baseUrl}/api/v4/projects/${project}/merge_requests`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          source_branch: branch,
          target_branch: targetBranch,
          title: `${candidateLabel(candidate)}: ${candidate.title}`,
          description: [
            `Created by Team Skill Hub ${candidate.suggestedType} review workflow.`,
            "",
            `Candidate: ${candidate.id}`,
            candidate.suggestedType === "skill" ? `Collection: ${candidate.skillCollection ?? "custom-skills"}` : undefined,
            candidate.traceId ? `Trace: ${candidate.traceId}` : undefined,
            candidate.reviewNote ? `Review note: ${candidate.reviewNote}` : undefined
          ].filter(Boolean).join("\n")
        })
      }
    );
    if (mrResponse.ok) {
      mr = await mrResponse.json() as { iid?: number; web_url?: string };
    } else if (mrResponse.status === 409) {
      const query = new URLSearchParams({
        state: "all",
        source_branch: branch,
        target_branch: targetBranch
      });
      const existing = await this.request(
        `${baseUrl}/api/v4/projects/${project}/merge_requests?${query.toString()}`,
        token,
        { method: "GET" }
      );
      if (existing.ok) {
        const rows = await existing.json() as Array<{
          iid?: number;
          web_url?: string;
          state?: string;
          merged_at?: string;
          closed_at?: string;
          merge_commit_sha?: string;
        }>;
        const existingMr = rows[0];
        if (existingMr?.state === "closed") {
          throw new Error(
            `Existing GitLab merge request !${existingMr.iid ?? "?"} for branch ${branch} is closed; create a new candidate revision or branch before publishing again`
          );
        }
        mr = existingMr;
      }
    }
    if (!mr) {
      const detail = mrResponse.ok ? "" : await mrResponse.text().catch(() => "");
      throw new Error(`GitLab merge request creation failed (${mrResponse.status}): ${detail.slice(0, 1000)}`);
    }
    if (!mr.iid || !mr.web_url) throw new Error("GitLab merge request response is incomplete");

    const publishedAt = new Date().toISOString();
    const mergeRequestState =
      mr.state === "merged" || mr.state === "closed" || mr.state === "locked" ? mr.state : "opened";
    return {
      provider: "gitlab",
      projectPath,
      branch,
      targetBranch,
      filePath,
      action,
      mergeRequestIid: mr.iid,
      mergeRequestUrl: mr.web_url,
      publishedAt,
      mergeRequestState,
      lastCheckedAt: publishedAt,
      ...(mr.merged_at ? { mergedAt: mr.merged_at } : {}),
      ...(mr.closed_at ? { closedAt: mr.closed_at } : {}),
      ...(mr.merge_commit_sha ? { mergeCommitSha: mr.merge_commit_sha } : {})
    };
  }

  async reconcile(
    publication: NonNullable<KnowledgeCandidate["publication"]>,
    repository: RepositoryConfig
  ): Promise<Pick<
    KnowledgePublicationResult,
    | "mergeRequestState"
    | "lastCheckedAt"
    | "mergedAt"
    | "closedAt"
    | "mergeCommitSha"
    | "pipelineStatus"
    | "hasConflicts"
    | "detailedMergeStatus"
    | "sourceBranchExists"
  >> {
    const { baseUrl, projectPath, token } = this.resolve(repository);
    if (publication.projectPath !== projectPath) {
      throw new Error("Knowledge publication project does not match repository publishing configuration");
    }
    const project = encodeURIComponent(projectPath);
    const response = await this.request(
      `${baseUrl}/api/v4/projects/${project}/merge_requests/${publication.mergeRequestIid}`,
      token,
      { method: "GET" }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitLab merge request lookup failed (${response.status}): ${detail.slice(0, 1000)}`);
    }
    const mr = await response.json() as {
      state?: string;
      merged_at?: string | null;
      closed_at?: string | null;
      merge_commit_sha?: string | null;
      has_conflicts?: boolean;
      detailed_merge_status?: string | null;
      head_pipeline?: { status?: string | null } | null;
    };
    const mergeRequestState =
      mr.state === "merged" || mr.state === "closed" || mr.state === "locked" ? mr.state : "opened";
    let sourceBranchExists: boolean | undefined;
    try {
      const branchResponse = await this.request(
        `${baseUrl}/api/v4/projects/${project}/repository/branches/${encodeURIComponent(publication.branch)}`,
        token,
        { method: "GET" }
      );
      if (branchResponse.status === 200) sourceBranchExists = true;
      else if (branchResponse.status === 404) sourceBranchExists = false;
    } catch {
      sourceBranchExists = undefined;
    }
    return {
      mergeRequestState,
      lastCheckedAt: new Date().toISOString(),
      ...(mr.merged_at ? { mergedAt: mr.merged_at } : {}),
      ...(mr.closed_at ? { closedAt: mr.closed_at } : {}),
      ...(mr.merge_commit_sha ? { mergeCommitSha: mr.merge_commit_sha } : {}),
      ...(mr.head_pipeline?.status ? { pipelineStatus: mr.head_pipeline.status } : {}),
      ...(mr.has_conflicts !== undefined ? { hasConflicts: mr.has_conflicts } : {}),
      ...(mr.detailed_merge_status ? { detailedMergeStatus: mr.detailed_merge_status } : {}),
      ...(sourceBranchExists !== undefined ? { sourceBranchExists } : {})
    };
  }
}

export class GitHubKnowledgePublisher implements KnowledgePublisher {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly gitRun: GitRun = runGit
  ) {}

  private resolve(repository: RepositoryConfig): {
    config: KnowledgePublishingConfig;
    apiBase: string;
    projectPath: string;
    token: string;
    sshUrl: string;
  } {
    const config = repository.knowledgePublishing;
    if (!config?.enabled) throw new Error("Knowledge publishing is disabled for this repository");
    if (config.provider !== "github") throw new Error("Unsupported knowledge publisher");
    const baseUrl = (config.baseUrl ?? "https://github.com").replace(/\/+$/, "");
    const projectPath = config.projectPath?.replace(/^\/+/, "").replace(/\.git$/i, "");
    if (!projectPath) throw new Error("GitHub publishing projectPath is required");
    const token = process.env[config.tokenEnv];
    if (!token) throw new Error(`Missing GitHub publishing token environment variable ${config.tokenEnv}`);
    return {
      config,
      apiBase: githubApiBase(baseUrl),
      projectPath,
      token,
      sshUrl: githubSshUrl(baseUrl, projectPath)
    };
  }

  private async request(url: string, token: string, init: RequestInit): Promise<Response> {
    return await this.fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {})
      }
    });
  }

  async publish(candidate: KnowledgeCandidate, repository: RepositoryConfig): Promise<KnowledgePublicationResult> {
    if (candidate.status !== "approved" && candidate.status !== "publish_failed") {
      throw new Error("Candidate must be approved before publishing");
    }

    const { config, apiBase, projectPath, token, sshUrl } = this.resolve(repository);
    const filePath = assertSafePath(candidate.suggestedPath ?? defaultCandidatePath(candidate));
    const targetBranch = config.targetBranch || "main";
    const prefix = slugify(config.branchPrefix || "skill-hub-knowledge");
    const branch = `${prefix}-${candidate.id.replace(/^kc_/, "").slice(0, 12)}`;
    const desiredContent = markdownForCandidate(candidate);
    const worktree = await mkdtemp(path.join(os.tmpdir(), "skill-hub-github-publish-"));
    let action: "create" | "update" = "create";

    try {
      await this.gitRun(["clone", "--depth", "1", "--no-tags", "--branch", targetBranch, sshUrl, worktree]);
      const targetFile = path.join(worktree, ...filePath.split("/"));
      try {
        await stat(targetFile);
        action = "update";
      } catch {
        action = "create";
      }

      const remoteBranch = await this.gitRun(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], worktree);
      if (remoteBranch) {
        await this.gitRun(["fetch", "--depth", "1", "origin", branch], worktree);
        await this.gitRun(["checkout", "-B", branch, "FETCH_HEAD"], worktree);
      } else {
        await this.gitRun(["checkout", "-B", branch], worktree);
      }

      let currentContent: string | undefined;
      try {
        currentContent = await readFile(targetFile, "utf8");
      } catch {
        currentContent = undefined;
      }
      if (currentContent !== desiredContent) {
        await mkdir(path.dirname(targetFile), { recursive: true });
        await writeFile(targetFile, desiredContent, "utf8");
        await this.gitRun(["add", "--", filePath], worktree);
        await this.gitRun(["config", "user.name", "Team Skill Hub"], worktree);
        await this.gitRun(["config", "user.email", "team-skill-hub@localhost"], worktree);
        await this.gitRun(["commit", "-m", `${candidate.suggestedType === "skill" ? "feat" : "docs"}: add ${candidate.suggestedType} from ${candidate.id}`], worktree);
        await this.gitRun(["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], worktree);
      }

      const pullsUrl = `${apiBase}/repos/${projectPath}/pulls`;
      let response = await this.request(pullsUrl, token, {
        method: "POST",
        body: JSON.stringify({
          title: `${candidateLabel(candidate)}: ${candidate.title}`,
          head: branch,
          base: targetBranch,
          body: [
            `Created by Team Skill Hub ${candidate.suggestedType} review workflow.`,
            "",
            `Candidate: ${candidate.id}`,
            candidate.suggestedType === "skill" ? `Collection: ${candidate.skillCollection ?? "custom-skills"}` : undefined,
            candidate.traceId ? `Trace: ${candidate.traceId}` : undefined,
            candidate.reviewNote ? `Review note: ${candidate.reviewNote}` : undefined
          ].filter(Boolean).join("\n")
        })
      });
      let pr: {
        number?: number;
        html_url?: string;
        state?: string;
        merged_at?: string | null;
        closed_at?: string | null;
        merge_commit_sha?: string | null;
        mergeable?: boolean | null;
        mergeable_state?: string;
      } | undefined;
      if (response.ok) {
        pr = await response.json().catch(() => undefined) as typeof pr;
      }
      if (response.status === 422 || !pr?.number || !pr.html_url) {
        const owner = projectPath.split("/")[0];
        const query = new URLSearchParams({ state: "all", head: `${owner}:${branch}`, base: targetBranch });
        response = await this.request(`${pullsUrl}?${query.toString()}`, token, { method: "GET" });
        if (response.ok) {
          const rows = await response.json() as Array<NonNullable<typeof pr>>;
          pr = rows[0];
          if (pr?.state === "closed" && !pr.merged_at) {
            if (!pr.number) {
              throw new Error(`Existing GitHub pull request for branch ${branch} is closed but has no pull request number`);
            }
            const reopenResponse = await this.request(`${pullsUrl}/${pr.number}`, token, {
              method: "PATCH",
              body: JSON.stringify({ state: "open" })
            });
            if (!reopenResponse.ok) {
              const detail = await reopenResponse.text().catch(() => "");
              throw new Error(`GitHub pull request reopen failed (${reopenResponse.status}): ${detail.slice(0, 1000)}`);
            }
            pr = await reopenResponse.json() as typeof pr;
          }
        }
      }
      if (!pr?.number || !pr.html_url) {
        const detail = response.ok ? "" : await response.text().catch(() => "");
        throw new Error(`GitHub pull request creation failed (${response.status}): ${detail.slice(0, 1000)}`);
      }

      const publishedAt = new Date().toISOString();
      return {
        provider: "github",
        projectPath,
        branch,
        targetBranch,
        filePath,
        action,
        mergeRequestIid: pr.number,
        mergeRequestUrl: pr.html_url,
        publishedAt,
        mergeRequestState: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "opened",
        lastCheckedAt: publishedAt,
        ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}),
        ...(pr.closed_at ? { closedAt: pr.closed_at } : {}),
        ...(pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
        ...(pr.mergeable !== undefined && pr.mergeable !== null ? { hasConflicts: !pr.mergeable } : {}),
        ...(pr.mergeable_state ? { detailedMergeStatus: pr.mergeable_state } : {})
      };
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  }

  async reconcile(
    publication: NonNullable<KnowledgeCandidate["publication"]>,
    repository: RepositoryConfig
  ): Promise<Pick<
    KnowledgePublicationResult,
    | "mergeRequestState"
    | "lastCheckedAt"
    | "mergedAt"
    | "closedAt"
    | "mergeCommitSha"
    | "pipelineStatus"
    | "hasConflicts"
    | "detailedMergeStatus"
    | "sourceBranchExists"
  >> {
    const { apiBase, projectPath, token } = this.resolve(repository);
    if (publication.projectPath !== projectPath) {
      throw new Error("Knowledge publication project does not match repository publishing configuration");
    }
    const response = await this.request(`${apiBase}/repos/${projectPath}/pulls/${publication.mergeRequestIid}`, token, {
      method: "GET"
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub pull request lookup failed (${response.status}): ${detail.slice(0, 1000)}`);
    }
    const pr = await response.json() as {
      state?: string;
      merged_at?: string | null;
      closed_at?: string | null;
      merge_commit_sha?: string | null;
      mergeable?: boolean | null;
      mergeable_state?: string;
    };
    const refResponse = await this.request(
      `${apiBase}/repos/${projectPath}/git/ref/heads/${encodeURIComponent(publication.branch)}`,
      token,
      { method: "GET" }
    );
    const sourceBranchExists = refResponse.status === 200 ? true : refResponse.status === 404 ? false : undefined;
    return {
      mergeRequestState: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "opened",
      lastCheckedAt: new Date().toISOString(),
      ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}),
      ...(pr.closed_at ? { closedAt: pr.closed_at } : {}),
      ...(pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
      ...(pr.mergeable !== undefined && pr.mergeable !== null ? { hasConflicts: !pr.mergeable } : {}),
      ...(pr.mergeable_state ? { detailedMergeStatus: pr.mergeable_state } : {}),
      ...(sourceBranchExists !== undefined ? { sourceBranchExists } : {})
    };
  }
}

export function createKnowledgePublisher(repository: RepositoryConfig): KnowledgePublisher {
  const provider = repository.knowledgePublishing?.provider ?? "gitlab";
  if (provider === "gitlab") return new GitLabKnowledgePublisher();
  if (provider === "github") return new GitHubKnowledgePublisher();
  throw new Error(`Unsupported knowledge publisher: ${provider}`);
}
