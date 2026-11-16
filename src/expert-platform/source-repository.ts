import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ExpertSourceRepository } from "./expert-store.js";

export type SourceRepositoryInput = {
  url: string;
  branch: string;
  credentialRef?: string;
  gitProxyUrl?: string;
  publicationPolicy?: ExpertSourceRepository["publicationPolicy"];
  publicationTemplate?: { preset: "work-branch" | "change-request"; branchPrefix?: string };
  verificationPolicy?: ExpertSourceRepository["verificationPolicy"];
  verificationTemplate?: { preset: "cmake-ctest" };
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
  if (input.publicationTemplate && input.publicationPolicy) {
    throw new Error("CONFLICTING_PUBLICATION_CONFIG");
  }
  let publicationPolicy = input.publicationPolicy ? structuredClone(input.publicationPolicy) : undefined;
  if (input.publicationTemplate) {
    const { preset } = input.publicationTemplate;
    const branchPrefix = input.publicationTemplate.branchPrefix?.trim() ?? "tsh/";
    if (
      !["work-branch", "change-request"].includes(preset) ||
      branchPrefix.length > 100 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(branchPrefix) ||
      branchPrefix.startsWith("refs/") ||
      branchPrefix.includes("..") ||
      branchPrefix.includes("//") ||
      branchPrefix.includes("/.") ||
      branchPrefix.includes(".lock/")
    ) {
      throw new Error("INVALID_PUBLICATION_TEMPLATE");
    }
    publicationPolicy = {
      version: 1,
      permissions: [
        "prepare-commit",
        "push-work-branch",
        ...(preset === "change-request" ? (["create-change-request"] as const) : []),
      ],
      branchPrefix,
      protectedBranches: [...new Set(["main", "master", branch])],
      allowedPushRemote: "origin",
      allowForcePush: false,
      allowDeleteRef: false,
    };
  }
  if (input.verificationTemplate && input.verificationPolicy) {
    throw new Error("CONFLICTING_VERIFICATION_CONFIG");
  }
  const verificationPolicy = input.verificationTemplate
    ? {
        version: 1,
        required: [
          {
            id: "build",
            type: "command" as const,
            argv: [
              "sh",
              "-lc",
              "set -eu; cmake -S /workspace -B /tmp/build -G Ninja -DCMAKE_BUILD_TYPE=Debug; cmake --build /tmp/build --parallel 2",
            ],
            timeoutMs: 600_000,
            evidenceType: "build",
          },
          {
            id: "unit-test",
            type: "command" as const,
            argv: [
              "sh",
              "-lc",
              "set -eu; mkdir -p /tmp/src; cp -a /workspace/. /tmp/src/; chmod -R u+rwX /tmp/src; cmake -S /tmp/src -B /tmp/build -G Ninja -DCMAKE_BUILD_TYPE=Debug; cmake --build /tmp/build --parallel 2; ctest --test-dir /tmp/build --output-on-failure --no-tests=error",
            ],
            timeoutMs: 900_000,
            evidenceType: "unit_test",
          },
        ],
      }
    : input.verificationPolicy
      ? structuredClone(input.verificationPolicy)
      : undefined;
  return {
    id: sourceRepositoryId(url, branch),
    url,
    branch,
    ...(credentialRef ? { credentialRef } : {}),
    ...(gitProxyUrl ? { gitProxyUrl } : {}),
    ...(publicationPolicy ? { publicationPolicy } : {}),
    ...(verificationPolicy ? { verificationPolicy } : {}),
  };
}
