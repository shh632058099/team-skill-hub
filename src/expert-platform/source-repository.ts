import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ExpertSourceRepository } from "./expert-store.js";

export type SourceRepositoryInput = {
  url: string;
  branch: string;
  credentialRef?: string;
  gitProxyUrl?: string;
};

export function sourceRepositoryId(url: string, branch: string): string {
  return `repo-${createHash("sha256").update(`${url.trim()}\n${branch.trim()}`).digest("hex").slice(0, 20)}`;
}

export function normalizeSourceRepository(input: SourceRepositoryInput): ExpertSourceRepository {
  const url = input.url.trim();
  const branch = input.branch.trim();
  if (!url || url.length > 2048 || /[\r\n\0]/.test(url) || /\s/.test(url)) {
    throw new Error("INVALID_SOURCE_REPOSITORY_URL");
  }
  const httpsUrl = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._/-]+(?:\.git)?$/i.test(url);
  const sshUrl = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/i.test(url);
  if (!httpsUrl && !sshUrl) throw new Error("INVALID_SOURCE_REPOSITORY_URL");
  const host = httpsUrl
    ? url.slice("https://".length).split("/")[0]?.split(":")[0]
    : url.slice("git@".length).split(":")[0];
  if (!host || host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost") || isIP(host) !== 0) {
    throw new Error("INVALID_SOURCE_REPOSITORY_URL");
  }
  if (url.includes("..") || /(^|\/)\.(?:\/|$)/.test(url)) throw new Error("INVALID_SOURCE_REPOSITORY_URL");
  if (
    !branch ||
    branch.length > 250 ||
    branch.startsWith("-") ||
    /[\s~^:?*\[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  ) {
    throw new Error("INVALID_SOURCE_REPOSITORY_BRANCH");
  }
  const credentialRef = input.credentialRef?.trim() || undefined;
  if (credentialRef && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(credentialRef)) {
    throw new Error("INVALID_SOURCE_REPOSITORY_CREDENTIAL_REF");
  }
  const gitProxyUrl = input.gitProxyUrl?.trim() || undefined;
  if (gitProxyUrl) {
    let parsed: URL;
    try {
      parsed = new URL(gitProxyUrl);
    } catch {
      throw new Error("INVALID_GIT_PROXY_URL");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      /[\r\n\0]/.test(gitProxyUrl)
    ) {
      throw new Error("INVALID_GIT_PROXY_URL");
    }
  }
  return {
    id: sourceRepositoryId(url, branch),
    url,
    branch,
    ...(credentialRef ? { credentialRef } : {}),
    ...(gitProxyUrl ? { gitProxyUrl } : {}),
  };
}
