import type {
  ChangeRequestProvider,
  ChangeRequestResult,
  CreateChangeRequestInput,
} from "./change-request-provider.js";
import type { GitCredentialConfig } from "./repository-workspace.js";

type FetchLike = typeof fetch;
type CredentialMap = Readonly<Record<string, GitCredentialConfig>>;

type RepositoryTarget = {
  origin: string;
  host: string;
  projectPath: string;
};

type GitHubPullRequest = {
  number?: number;
  html_url?: string;
  state?: string;
  merged_at?: string | null;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
};

type GitLabMergeRequest = {
  iid?: number;
  web_url?: string;
  state?: string;
  merged_at?: string | null;
  sha?: string;
  source_branch?: string;
  target_branch?: string;
};

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function parseRepositoryTarget(repositoryUrl: string): RepositoryTarget {
  const value = required(repositoryUrl, "CHANGE_REQUEST_REPOSITORY_INVALID");
  let host = "";
  let origin = "";
  let projectPath = "";

  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("CHANGE_REQUEST_REPOSITORY_INVALID");
    }
    host = parsed.hostname;
    origin = `https://${parsed.host}`;
    projectPath = parsed.pathname.replace(/^\/+/, "");
  } else {
    const ssh = /^git@([^:]+):(.+)$/.exec(value);
    if (!ssh) throw new Error("CHANGE_REQUEST_REPOSITORY_INVALID");
    host = ssh[1]!;
    origin = `https://${host}`;
    projectPath = ssh[2]!;
  }

  projectPath = projectPath
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!host || !projectPath || !projectPath.includes("/")) throw new Error("CHANGE_REQUEST_REPOSITORY_INVALID");
  return { origin, host: host.toLowerCase(), projectPath };
}

function resolveToken(credentials: CredentialMap, credentialGrantRef: string): string {
  const ref = required(credentialGrantRef, "CHANGE_REQUEST_CREDENTIAL_UNAVAILABLE");
  const credential = credentials[ref];
  if (!credential || credential.type !== "https-token") throw new Error("CHANGE_REQUEST_CREDENTIAL_UNAVAILABLE");
  const token = process.env[credential.tokenEnv]?.trim();
  if (!token) throw new Error("CHANGE_REQUEST_CREDENTIAL_UNAVAILABLE");
  return token;
}

function assertIdentity(input: CreateChangeRequestInput, result: ChangeRequestResult): void {
  if (result.headCommit.toLowerCase() !== input.headCommit.toLowerCase()) {
    throw new Error("CHANGE_REQUEST_HEAD_MISMATCH");
  }
  if (result.baseBranch !== input.baseBranch) throw new Error("CHANGE_REQUEST_BASE_MISMATCH");
}

export class GitHubChangeRequestProvider implements ChangeRequestProvider {
  private readonly target: RepositoryTarget;

  constructor(
    repositoryUrl: string,
    private readonly credentials: CredentialMap,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.target = parseRepositoryTarget(repositoryUrl);
  }

  private apiBase(): string {
    return this.target.host === "github.com" ? "https://api.github.com" : this.target.origin + "/api/v3";
  }

  private async request(url: string, token: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });
  }

  private result(input: CreateChangeRequestInput, pr: GitHubPullRequest): ChangeRequestResult {
    if (!pr.number || !pr.html_url || !pr.head?.sha || !pr.base?.ref) {
      throw new Error("CHANGE_REQUEST_RESPONSE_INVALID");
    }
    const result = {
      provider: "github",
      externalId: String(pr.number),
      url: pr.html_url,
      headCommit: pr.head.sha,
      baseBranch: pr.base.ref,
    };
    assertIdentity(input, result);
    return result;
  }

  async create(input: CreateChangeRequestInput): Promise<ChangeRequestResult> {
    const token = resolveToken(this.credentials, input.credentialGrantRef);
    const pullsUrl = `${this.apiBase()}/repos/${this.target.projectPath}/pulls`;
    let response = await this.request(pullsUrl, token, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
      }),
    });
    let pr: GitHubPullRequest | undefined;
    if (response.ok) pr = (await response.json().catch(() => undefined)) as GitHubPullRequest | undefined;

    if (response.status === 422 || !pr?.number || !pr.html_url) {
      const owner = this.target.projectPath.split("/")[0]!;
      const query = new URLSearchParams({
        state: "all",
        head: `${owner}:${input.headBranch}`,
        base: input.baseBranch,
      });
      response = await this.request(`${pullsUrl}?${query.toString()}`, token, { method: "GET" });
      if (!response.ok) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
      const rows = (await response.json().catch(() => [])) as GitHubPullRequest[];
      pr = rows[0];
      if (pr?.state === "closed" && !pr.merged_at && pr.number) {
        const reopened = await this.request(`${pullsUrl}/${pr.number}`, token, {
          method: "PATCH",
          body: JSON.stringify({ state: "open" }),
        });
        if (!reopened.ok) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
        pr = (await reopened.json().catch(() => undefined)) as GitHubPullRequest | undefined;
      }
    }

    if (!pr?.number || !pr.html_url) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
    if (!pr.head?.sha || !pr.base?.ref) {
      const detail = await this.request(`${pullsUrl}/${pr.number}`, token, { method: "GET" });
      if (!detail.ok) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
      pr = (await detail.json().catch(() => undefined)) as GitHubPullRequest | undefined;
    }
    if (!pr) throw new Error("CHANGE_REQUEST_RESPONSE_INVALID");
    return this.result(input, pr);
  }
}

export class GitLabChangeRequestProvider implements ChangeRequestProvider {
  private readonly target: RepositoryTarget;

  constructor(
    repositoryUrl: string,
    private readonly credentials: CredentialMap,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.target = parseRepositoryTarget(repositoryUrl);
  }

  private async request(url: string, token: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      headers: {
        "private-token": token,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private result(input: CreateChangeRequestInput, mr: GitLabMergeRequest): ChangeRequestResult {
    if (!mr.iid || !mr.web_url || !mr.sha || !mr.target_branch) throw new Error("CHANGE_REQUEST_RESPONSE_INVALID");
    const result = {
      provider: "gitlab",
      externalId: String(mr.iid),
      url: mr.web_url,
      headCommit: mr.sha,
      baseBranch: mr.target_branch,
    };
    assertIdentity(input, result);
    if (mr.source_branch && mr.source_branch !== input.headBranch) throw new Error("CHANGE_REQUEST_HEAD_MISMATCH");
    return result;
  }

  async create(input: CreateChangeRequestInput): Promise<ChangeRequestResult> {
    const token = resolveToken(this.credentials, input.credentialGrantRef);
    const project = encodeURIComponent(this.target.projectPath);
    const mrUrl = `${this.target.origin}/api/v4/projects/${project}/merge_requests`;
    let response = await this.request(mrUrl, token, {
      method: "POST",
      body: JSON.stringify({
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.body,
      }),
    });
    let mr: GitLabMergeRequest | undefined;
    if (response.ok) mr = (await response.json().catch(() => undefined)) as GitLabMergeRequest | undefined;

    if (response.status === 409 || !mr?.iid || !mr.web_url) {
      const query = new URLSearchParams({
        state: "all",
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
      });
      response = await this.request(`${mrUrl}?${query.toString()}`, token, { method: "GET" });
      if (!response.ok) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
      const rows = (await response.json().catch(() => [])) as GitLabMergeRequest[];
      mr = rows[0];
      if (mr?.state === "closed" && !mr.merged_at && mr.iid) {
        const reopened = await this.request(`${mrUrl}/${mr.iid}`, token, {
          method: "PUT",
          body: JSON.stringify({ state_event: "reopen" }),
        });
        if (!reopened.ok) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
        mr = (await reopened.json().catch(() => undefined)) as GitLabMergeRequest | undefined;
      }
    }

    if (!mr?.iid || !mr.web_url) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
    if (!mr.sha || !mr.target_branch) {
      const detail = await this.request(`${mrUrl}/${mr.iid}`, token, { method: "GET" });
      if (!detail.ok) throw new Error("CHANGE_REQUEST_CREATE_FAILED");
      mr = (await detail.json().catch(() => undefined)) as GitLabMergeRequest | undefined;
    }
    if (!mr) throw new Error("CHANGE_REQUEST_RESPONSE_INVALID");
    return this.result(input, mr);
  }
}

export function createGitChangeRequestProvider(
  repositoryUrl: string,
  credentials: CredentialMap,
  fetchImpl: FetchLike = fetch,
): ChangeRequestProvider {
  const target = parseRepositoryTarget(repositoryUrl);
  if (target.host === "github.com" || target.host.includes("github")) {
    return new GitHubChangeRequestProvider(repositoryUrl, credentials, fetchImpl);
  }
  if (target.host === "gitlab.com" || target.host.includes("gitlab")) {
    return new GitLabChangeRequestProvider(repositoryUrl, credentials, fetchImpl);
  }
  throw new Error("CHANGE_REQUEST_PROVIDER_UNSUPPORTED");
}
