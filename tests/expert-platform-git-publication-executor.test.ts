import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareGitPublication, pushGitPublication } from "../src/expert-platform/git-publication-executor.js";
import { computeWorkspaceChangeSummary } from "../src/expert-platform/workspace-change-summary.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "git-publication-"));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", "-b", "main", repo]);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const baseCommit = git(repo, ["rev-parse", "HEAD"]);
  return { root, remote, repo, baseCommit };
}

test("prepare publication creates deterministic local commit without remote side effect", async () => {
  const fixture = makeRepo();
  try {
    writeFileSync(path.join(fixture.repo, "README.md"), "base\nchanged\n");
    writeFileSync(path.join(fixture.repo, "added.txt"), "added\n");
    const summary = await computeWorkspaceChangeSummary(fixture.repo, fixture.baseCommit);
    const input = {
      workspacePath: fixture.repo,
      sourceSubjectRevision: "workspace:" + summary.contentRevision,
      expectedContentRevision: summary.contentRevision,
      approvedChangeSummary: summary,
      baseCommit: fixture.baseCommit,
      repositoryUrl: fixture.remote,
      branchName: "skillhub/work/work123-a1",
      branchPrefix: "skillhub/work/",
      defaultBranch: "main",
      protectedBranches: ["main"],
      commitMetadata: {
        authorName: "Team Skill Hub",
        authorEmail: "team-skill-hub@local.invalid",
        message:
          "Fix fixture\n\nWork-Item: work-123\nWork-Attempt: attempt-1\nWorkspace-Revision: workspace:" +
          summary.contentRevision +
          "\n",
        timestamp: 1_800_000_000_000,
      },
    };
    const prepared = await prepareGitPublication(input);
    assert.equal(prepared.branchName, input.branchName);
    assert.match(prepared.commitSha, /^[a-f0-9]{40}$/);
    assert.match(prepared.treeSha, /^[a-f0-9]{40}$/);
    assert.equal(git(fixture.repo, ["rev-parse", input.branchName]), prepared.commitSha);
    assert.equal(git(fixture.repo, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.throws(() => git(fixture.remote, ["show-ref", "--verify", "refs/heads/" + input.branchName]));

    const retry = await prepareGitPublication(input);
    assert.equal(retry.commitSha, prepared.commitSha);
    assert.equal(retry.treeSha, prepared.treeSha);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("prepare publication fails closed on stale content, base, remote, extra remote or content filter", async () => {
  const makeInput = async (repo: string, remote: string, baseCommit: string) => {
    writeFileSync(path.join(repo, "README.md"), "changed\n");
    const summary = await computeWorkspaceChangeSummary(repo, baseCommit);
    return {
      workspacePath: repo,
      sourceSubjectRevision: "workspace:" + summary.contentRevision,
      expectedContentRevision: summary.contentRevision,
      approvedChangeSummary: summary,
      baseCommit,
      repositoryUrl: remote,
      branchName: "skillhub/work/work123-a1",
      branchPrefix: "skillhub/work/",
      defaultBranch: "main",
      protectedBranches: ["main"],
      commitMetadata: {
        authorName: "Team Skill Hub",
        authorEmail: "team-skill-hub@local.invalid",
        message:
          "Fix\n\nWork-Item: w\nWork-Attempt: a\nWorkspace-Revision: workspace:" + summary.contentRevision + "\n",
        timestamp: 1_800_000_000_000,
      },
    };
  };

  {
    const f = makeRepo();
    try {
      const input = await makeInput(f.repo, f.remote, f.baseCommit);
      writeFileSync(path.join(f.repo, "README.md"), "changed again\n");
      await assert.rejects(() => prepareGitPublication(input), /PUBLICATION_SOURCE_STALE/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }

  {
    const f = makeRepo();
    try {
      const input = await makeInput(f.repo, f.remote, f.baseCommit);
      await assert.rejects(
        () => prepareGitPublication({ ...input, baseCommit: "f".repeat(40) }),
        /PUBLICATION_BASE_MISMATCH/,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }

  {
    const f = makeRepo();
    try {
      const input = await makeInput(f.repo, f.remote, f.baseCommit);
      await assert.rejects(
        () => prepareGitPublication({ ...input, repositoryUrl: path.join(f.root, "wrong.git") }),
        /PUBLICATION_REPOSITORY_MISMATCH/,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }

  {
    const f = makeRepo();
    try {
      const input = await makeInput(f.repo, f.remote, f.baseCommit);
      git(f.repo, ["remote", "add", "unexpected", f.remote]);
      await assert.rejects(() => prepareGitPublication(input), /PUBLICATION_REPOSITORY_MISMATCH/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }

  {
    const f = makeRepo();
    try {
      writeFileSync(path.join(f.repo, ".gitattributes"), "*.md filter=evil\n");
      git(f.repo, ["add", ".gitattributes"]);
      git(f.repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "attrs"]);
      git(f.repo, ["push", "origin", "main"]);
      const base = git(f.repo, ["rev-parse", "HEAD"]);
      writeFileSync(path.join(f.repo, "README.md"), "filtered change\n");
      const input = await makeInput(f.repo, f.remote, base);
      await assert.rejects(() => prepareGitPublication(input), /PUBLICATION_CONTENT_FILTER_UNSUPPORTED/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("controlled push is single-ref, idempotent, and rejects conflicting remote state", async () => {
  const fixture = makeRepo();
  try {
    writeFileSync(path.join(fixture.repo, "README.md"), "base\nchanged\n");
    const summary = await computeWorkspaceChangeSummary(fixture.repo, fixture.baseCommit);
    const prepared = await prepareGitPublication({
      workspacePath: fixture.repo,
      sourceSubjectRevision: "workspace:" + summary.contentRevision,
      expectedContentRevision: summary.contentRevision,
      approvedChangeSummary: summary,
      baseCommit: fixture.baseCommit,
      repositoryUrl: fixture.remote,
      branchName: "skillhub/work/push-a1",
      branchPrefix: "skillhub/work/",
      defaultBranch: "main",
      protectedBranches: ["main"],
      commitMetadata: {
        authorName: "Team Skill Hub",
        authorEmail: "team-skill-hub@local.invalid",
        message:
          "Push fixture\n\nWork-Item: push\nWork-Attempt: a1\nWorkspace-Revision: workspace:" +
          summary.contentRevision +
          "\n",
        timestamp: 1_800_000_000_000,
      },
    });

    const first = await pushGitPublication({
      workspacePath: fixture.repo,
      repositoryUrl: fixture.remote,
      branchName: prepared.branchName,
      branchPrefix: "skillhub/work/",
      defaultBranch: "main",
      protectedBranches: ["main"],
      commitSha: prepared.commitSha,
      allowedPushRemote: "origin",
    });
    assert.deepEqual(first, { status: "pushed", remoteCommitSha: prepared.commitSha });
    assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/" + prepared.branchName]), prepared.commitSha);

    const again = await pushGitPublication({
      workspacePath: fixture.repo,
      repositoryUrl: fixture.remote,
      branchName: prepared.branchName,
      branchPrefix: "skillhub/work/",
      defaultBranch: "main",
      protectedBranches: ["main"],
      commitSha: prepared.commitSha,
      allowedPushRemote: "origin",
    });
    assert.deepEqual(again, { status: "already_pushed", remoteCommitSha: prepared.commitSha });

    const conflictingRepo = path.join(fixture.root, "conflict");
    execFileSync("git", ["clone", fixture.remote, conflictingRepo]);
    git(conflictingRepo, ["config", "user.name", "Conflict"]);
    git(conflictingRepo, ["config", "user.email", "conflict@example.invalid"]);
    git(conflictingRepo, ["checkout", "-B", prepared.branchName, fixture.baseCommit]);
    writeFileSync(path.join(conflictingRepo, "conflict.txt"), "conflict\n");
    git(conflictingRepo, ["add", "."]);
    git(conflictingRepo, ["commit", "-m", "conflict"]);
    git(conflictingRepo, ["push", "--force", "origin", prepared.branchName]);
    await assert.rejects(
      () =>
        pushGitPublication({
          workspacePath: fixture.repo,
          repositoryUrl: fixture.remote,
          branchName: prepared.branchName,
          branchPrefix: "skillhub/work/",
          defaultBranch: "main",
          protectedBranches: ["main"],
          commitSha: prepared.commitSha,
          allowedPushRemote: "origin",
        }),
      /PUBLICATION_REF_CONFLICT/,
    );
    assert.notEqual(git(fixture.remote, ["rev-parse", "refs/heads/" + prepared.branchName]), prepared.commitSha);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("publication push credential stays out of argv, result, and error text", async () => {
  const secret = "super-secret-publication-token";
  const previous = process.env.PUBLICATION_TEST_TOKEN;
  process.env.PUBLICATION_TEST_TOKEN = secret;
  try {
    const seen: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const runner = async (_cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      seen.push({ args: [...args], env: { ...env } });
      if (args.includes("ls-remote")) return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "remote rejected " + secret, code: 1 };
    };
    await assert.rejects(
      () =>
        pushGitPublication({
          workspacePath: "/tmp/repo",
          repositoryUrl: "https://example.invalid/repo.git",
          branchName: "skillhub/work/secret-a1",
          branchPrefix: "skillhub/work/",
          defaultBranch: "main",
          protectedBranches: ["main"],
          commitSha: "a".repeat(40),
          allowedPushRemote: "origin",
          credentialRef: "publish-token",
          credentials: {
            "publish-token": { type: "https-token", tokenEnv: "PUBLICATION_TEST_TOKEN" },
          },
          runGit: runner,
          skipLocalRepositoryValidationForTest: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        return /PUBLICATION_PUSH_FAILED/.test(error.message);
      },
    );
    assert.ok(seen.length >= 2);
    assert.equal(
      seen.some((entry) => entry.args.join(" ").includes(secret)),
      false,
    );
    assert.equal(
      seen.some((entry) => entry.env.EXPERT_GIT_HTTP_TOKEN === secret),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.PUBLICATION_TEST_TOKEN;
    else process.env.PUBLICATION_TEST_TOKEN = previous;
  }
});
