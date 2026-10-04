import type { KnowledgePublishingConfig, RepositoryConfig } from "./types.js";
import type { KnowledgeCandidate } from "./observability.js";

export interface KnowledgePublicationResult {
  provider: "gitlab";
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

function markdownForCandidate(candidate: KnowledgeCandidate): string {
  const body = candidate.content.trim();
  if (/^#\s+/m.test(body)) return body + "\n";
  return "# " + candidate.title.trim() + "\n\n" + body + "\n";
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
      throw new Error("Knowledge candidate must be approved before publishing");
    }
    if (candidate.suggestedType !== "knowledge") {
      throw new Error("Automatic publishing currently supports Knowledge candidates only");
    }

    const { config, baseUrl, projectPath, token } = this.resolve(repository);
    const project = encodeURIComponent(projectPath);
    const filePath = assertSafePath(
      candidate.suggestedPath ?? `knowledge/${slugify(candidate.title)}.md`
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
        commit_message: `docs: add knowledge from ${candidate.id}`
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
          title: `Knowledge: ${candidate.title}`,
          description: [
            "Created by Team Skill Hub knowledge review workflow.",
            "",
            `Candidate: ${candidate.id}`,
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

export function createKnowledgePublisher(repository: RepositoryConfig): KnowledgePublisher {
  const provider = repository.knowledgePublishing?.provider ?? "gitlab";
  if (provider === "gitlab") return new GitLabKnowledgePublisher();
  throw new Error(`Unsupported knowledge publisher: ${provider}`);
}
