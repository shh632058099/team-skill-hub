import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { computeWorkspaceChangeSummary, type WorkspaceChangeSummary } from "./workspace-change-summary.js";
import { validatePublicationBranch } from "./publication-policy.js";
import type { GitCredentialConfig } from "./repository-workspace.js";

export interface PublicationCommitMetadata {
  authorName: string;
  authorEmail: string;
  message: string;
  timestamp: number;
}

export interface PrepareGitPublicationInput {
  workspacePath: string;
  sourceSubjectRevision: string;
  expectedContentRevision: string;
  approvedChangeSummary: WorkspaceChangeSummary;
  baseCommit: string;
  repositoryUrl: string;
  branchName: string;
  branchPrefix: string;
  defaultBranch: string;
  protectedBranches: readonly string[];
  commitMetadata: PublicationCommitMetadata;
}

export interface PreparedGitPublication {
  branchName: string;
  commitSha: string;
  treeSha: string;
}

export interface PushGitPublicationInput {
  workspacePath: string;
  repositoryUrl: string;
  branchName: string;
  branchPrefix: string;
  defaultBranch: string;
  protectedBranches: readonly string[];
  commitSha: string;
  allowedPushRemote: "origin";
  credentialRef?: string;
  credentials?: Readonly<Record<string, GitCredentialConfig>>;
  runGit?: (
    cwd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  skipLocalRepositoryValidationForTest?: boolean;
}

export interface PushGitPublicationResult {
  status: "pushed" | "already_pushed";
  remoteCommitSha: string;
}

const GIT_CONFIG_ARGS = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=true", "-c", "credential.helper="] as const;

function runGit(
  cwd: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...GIT_CONFIG_ARGS, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= 8 * 1024 * 1024) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      };
      if (result.code !== 0 && !options.allowFailure) reject(new Error("PUBLICATION_GIT_FAILED"));
      else resolve(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function summariesMatch(left: WorkspaceChangeSummary, right: WorkspaceChangeSummary): boolean {
  return (
    left.baseCommit.toLowerCase() === right.baseCommit.toLowerCase() &&
    left.contentRevision === right.contentRevision &&
    JSON.stringify(left.changedFiles) === JSON.stringify(right.changedFiles) &&
    JSON.stringify(left.addedFiles) === JSON.stringify(right.addedFiles) &&
    JSON.stringify(left.deletedFiles) === JSON.stringify(right.deletedFiles) &&
    left.diffStat.filesChanged === right.diffStat.filesChanged &&
    left.diffStat.insertions === right.diffStat.insertions &&
    left.diffStat.deletions === right.diffStat.deletions
  );
}

async function assertNoContentTransformAttributes(workspacePath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  for (const attribute of ["filter", "text", "eol", "working-tree-encoding"]) {
    const result = await runGit(workspacePath, ["check-attr", "-z", attribute, "--", ...paths]);
    const tokens = result.stdout.split("\0").filter(Boolean);
    for (let index = 0; index + 2 < tokens.length; index += 3) {
      const value = tokens[index + 2]!;
      if (value === "unspecified" || value === "unset") continue;
      throw new Error("PUBLICATION_CONTENT_FILTER_UNSUPPORTED");
    }
  }
}

function commitEnvironment(metadata: PublicationCommitMetadata): NodeJS.ProcessEnv {
  if (
    !metadata.authorName.trim() ||
    !metadata.authorEmail.trim() ||
    !metadata.message.trim() ||
    !Number.isSafeInteger(metadata.timestamp) ||
    metadata.timestamp <= 0
  ) {
    throw new Error("INVALID_PUBLICATION_METADATA");
  }
  const date = new Date(metadata.timestamp).toISOString();
  return {
    GIT_AUTHOR_NAME: metadata.authorName,
    GIT_AUTHOR_EMAIL: metadata.authorEmail,
    GIT_COMMITTER_NAME: metadata.authorName,
    GIT_COMMITTER_EMAIL: metadata.authorEmail,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

function publicationSshCommand(keyPath: string): string {
  const escaped = keyPath.replace(/'/g, "'\\''");
  return "ssh -i '" + escaped + "' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new";
}

async function runPushGit(
  input: PushGitPublicationInput,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (input.runGit) return input.runGit(input.workspacePath, [...GIT_CONFIG_ARGS, ...args], env);
  return runGit(input.workspacePath, args, { env, allowFailure: true });
}

function parseRemoteHead(stdout: string, expectedRef: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) throw new Error("PUBLICATION_REMOTE_STATE_INVALID");
  const [sha, ref] = lines[0]!.split(/\s+/, 2);
  if (!sha || ref !== expectedRef || !/^[a-f0-9]{40,64}$/i.test(sha)) {
    throw new Error("PUBLICATION_REMOTE_STATE_INVALID");
  }
  return sha.toLowerCase();
}

export async function pushGitPublication(input: PushGitPublicationInput): Promise<PushGitPublicationResult> {
  if (input.allowedPushRemote !== "origin") throw new Error("PUBLICATION_NOT_ALLOWED");
  const branchName = validatePublicationBranch({
    branchName: input.branchName,
    branchPrefix: input.branchPrefix,
    defaultBranch: input.defaultBranch,
    protectedBranches: input.protectedBranches,
  });
  const commitSha = input.commitSha.toLowerCase();
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) throw new Error("INVALID_PUBLICATION");
  const targetRef = "refs/heads/" + branchName;
  const refspec = commitSha + ":" + targetRef;
  if (refspec.startsWith("+") || refspec.includes("*") || refspec.endsWith(":")) {
    throw new Error("PUBLICATION_NOT_ALLOWED");
  }

  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  let credentialTempDir: string | undefined;
  try {
    if (input.credentialRef) {
      const credential = input.credentials?.[input.credentialRef];
      if (!credential) throw new Error("PUBLICATION_CREDENTIAL_UNAVAILABLE");
      if (credential.type === "ssh-key") {
        if (!path.isAbsolute(credential.path) || credential.path === "/" || !existsSync(credential.path)) {
          throw new Error("PUBLICATION_CREDENTIAL_UNAVAILABLE");
        }
        if (!input.repositoryUrl.startsWith("git@") && !input.repositoryUrl.startsWith("ssh://")) {
          throw new Error("PUBLICATION_CREDENTIAL_UNAVAILABLE");
        }
        env.GIT_SSH_COMMAND = publicationSshCommand(credential.path);
      } else {
        if (!input.repositoryUrl.startsWith("https://")) throw new Error("PUBLICATION_CREDENTIAL_UNAVAILABLE");
        const token = process.env[credential.tokenEnv];
        if (!token) throw new Error("PUBLICATION_CREDENTIAL_UNAVAILABLE");
        credentialTempDir = mkdtempSync(path.join(os.tmpdir(), "expert-publication-git-askpass-"));
        const askpass = path.join(credentialTempDir, "askpass.sh");
        const usernameVar = "$" + "{EXPERT_GIT_HTTP_USERNAME:-x-access-token}";
        const tokenVar = "$" + "EXPERT_GIT_HTTP_TOKEN";
        writeFileSync(
          askpass,
          '#!/bin/sh\ncase "$1" in *sername*) printf \'%s\\n\' "' +
            usernameVar +
            "\" ;; *) printf '%s\\n' \"" +
            tokenVar +
            '" ;; esac\n',
          { mode: 0o700 },
        );
        chmodSync(askpass, 0o700);
        env.GIT_ASKPASS = askpass;
        env.EXPERT_GIT_HTTP_TOKEN = token;
        env.EXPERT_GIT_HTTP_USERNAME = credential.username || "x-access-token";
      }
    } else if (
      input.repositoryUrl.startsWith("https://") ||
      input.repositoryUrl.startsWith("git@") ||
      input.repositoryUrl.startsWith("ssh://")
    ) {
      throw new Error("PUBLICATION_CREDENTIAL_UNAVAILABLE");
    }

    if (!input.skipLocalRepositoryValidationForTest) {
      const remotes = await runPushGit(input, ["remote"], env);
      if (remotes.code !== 0) throw new Error("PUBLICATION_REPOSITORY_MISMATCH");
      const remoteNames = remotes.stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (remoteNames.length !== 1 || remoteNames[0] !== "origin") {
        throw new Error("PUBLICATION_REPOSITORY_MISMATCH");
      }
      const origin = await runPushGit(input, ["remote", "get-url", "origin"], env);
      if (origin.code !== 0 || origin.stdout.trim() !== input.repositoryUrl) {
        throw new Error("PUBLICATION_REPOSITORY_MISMATCH");
      }
      const localCommit = await runPushGit(input, ["cat-file", "-e", commitSha + "^{commit}"], env);
      if (localCommit.code !== 0) throw new Error("PUBLICATION_ARTIFACT_NOT_PREPARED");
      const localRef = await runPushGit(input, ["show-ref", "--verify", "--hash", targetRef], env);
      if (localRef.code !== 0 || localRef.stdout.trim().toLowerCase() !== commitSha) {
        throw new Error("PUBLICATION_ARTIFACT_NOT_PREPARED");
      }
    }

    const remoteBefore = await runPushGit(input, ["ls-remote", "--heads", "origin", targetRef], env);
    if (remoteBefore.code !== 0) throw new Error("PUBLICATION_PUSH_FAILED");
    const existingSha = parseRemoteHead(remoteBefore.stdout, targetRef);
    if (existingSha === commitSha) return { status: "already_pushed", remoteCommitSha: commitSha };
    if (existingSha !== null) throw new Error("PUBLICATION_REF_CONFLICT");

    const pushed = await runPushGit(input, ["push", "--porcelain", "origin", refspec], env);
    if (pushed.code !== 0) throw new Error("PUBLICATION_PUSH_FAILED");

    const remoteAfter = await runPushGit(input, ["ls-remote", "--heads", "origin", targetRef], env);
    if (remoteAfter.code !== 0) throw new Error("PUBLICATION_PUSH_FAILED");
    const pushedSha = parseRemoteHead(remoteAfter.stdout, targetRef);
    if (pushedSha !== commitSha) {
      if (pushedSha !== null) throw new Error("PUBLICATION_REF_CONFLICT");
      throw new Error("PUBLICATION_PUSH_FAILED");
    }
    return { status: "pushed", remoteCommitSha: commitSha };
  } finally {
    if (credentialTempDir) rmSync(credentialTempDir, { recursive: true, force: true });
    delete env.EXPERT_GIT_HTTP_TOKEN;
  }
}

export async function prepareGitPublication(input: PrepareGitPublicationInput): Promise<PreparedGitPublication> {
  const branchName = validatePublicationBranch({
    branchName: input.branchName,
    branchPrefix: input.branchPrefix,
    defaultBranch: input.defaultBranch,
    protectedBranches: input.protectedBranches,
  });
  if (input.sourceSubjectRevision !== "workspace:" + input.expectedContentRevision)
    throw new Error("PUBLICATION_SOURCE_STALE");
  if (input.approvedChangeSummary.baseCommit.toLowerCase() !== input.baseCommit.toLowerCase())
    throw new Error("PUBLICATION_BASE_MISMATCH");

  const baseExists = await runGit(input.workspacePath, ["cat-file", "-e", input.baseCommit + "^{commit}"], {
    allowFailure: true,
  });
  if (baseExists.code !== 0) throw new Error("PUBLICATION_BASE_MISMATCH");

  const current = await computeWorkspaceChangeSummary(input.workspacePath, input.baseCommit);
  if (
    current.contentRevision !== input.expectedContentRevision ||
    !summariesMatch(current, input.approvedChangeSummary)
  )
    throw new Error("PUBLICATION_SOURCE_STALE");
  if (current.diffStat.filesChanged === 0) throw new Error("PUBLICATION_CONTENT_MISMATCH");

  const remotes = (await runGit(input.workspacePath, ["remote"])).stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (remotes.length !== 1 || remotes[0] !== "origin") throw new Error("PUBLICATION_REPOSITORY_MISMATCH");
  const originUrl = (await runGit(input.workspacePath, ["remote", "get-url", "origin"])).stdout.trim();
  if (originUrl !== input.repositoryUrl) throw new Error("PUBLICATION_REPOSITORY_MISMATCH");

  const changedPaths = [...current.changedFiles, ...current.addedFiles, ...current.deletedFiles].sort();
  await assertNoContentTransformAttributes(input.workspacePath, changedPaths);

  const hooksDir = path.join(os.tmpdir(), "team-skill-hub-publication-empty-hooks");
  mkdirSync(hooksDir, { recursive: true });
  const mutatingConfig = ["-c", "core.hooksPath=" + hooksDir] as const;
  await runGit(input.workspacePath, [...mutatingConfig, "add", "-A", "--", "."]);
  const treeSha = (await runGit(input.workspacePath, [...mutatingConfig, "write-tree"])).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(treeSha)) throw new Error("PUBLICATION_CONTENT_MISMATCH");

  const env = commitEnvironment(input.commitMetadata);
  const commitSha = (
    await runGit(input.workspacePath, [...mutatingConfig, "commit-tree", treeSha, "-p", input.baseCommit], {
      env,
      input: input.commitMetadata.message,
    })
  ).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) throw new Error("PUBLICATION_GIT_FAILED");

  const ref = "refs/heads/" + branchName;
  const existingRef = await runGit(input.workspacePath, ["show-ref", "--verify", "--hash", ref], {
    allowFailure: true,
  });
  if (existingRef.code === 0 && existingRef.stdout.trim() !== commitSha) throw new Error("PUBLICATION_REF_CONFLICT");

  await runGit(input.workspacePath, [...mutatingConfig, "update-ref", ref, commitSha]);
  await runGit(input.workspacePath, [...mutatingConfig, "symbolic-ref", "HEAD", ref]);

  const status = (
    await runGit(input.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"])
  ).stdout.trim();
  if (status) throw new Error("PUBLICATION_CONTENT_MISMATCH");
  const after = await computeWorkspaceChangeSummary(input.workspacePath, input.baseCommit);
  if (!summariesMatch(after, input.approvedChangeSummary)) throw new Error("PUBLICATION_CONTENT_MISMATCH");
  const committedTree = (await runGit(input.workspacePath, ["rev-parse", commitSha + "^{tree}"])).stdout.trim();
  if (committedTree !== treeSha) throw new Error("PUBLICATION_CONTENT_MISMATCH");

  return { branchName, commitSha, treeSha };
}
