import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareGitPublication } from "../src/expert-platform/git-publication-executor.js";
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
