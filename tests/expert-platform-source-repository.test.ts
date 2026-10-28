import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeSourceRepository } from "../src/expert-platform/source-repository.js";
import { loadGitCredentialConfigs, prepareRepositoryWorkspace } from "../src/expert-platform/repository-workspace.js";

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("source repository configuration derives stable internal IDs and validates URLs/branches", () => {
  const first = normalizeSourceRepository({ url: "https://github.com/example/ota.git", branch: "main" });
  const second = normalizeSourceRepository({ url: "https://github.com/example/ota.git", branch: "main" });
  const otherBranch = normalizeSourceRepository({ url: "https://github.com/example/ota.git", branch: "release/1.0" });
  assert.match(first.id, /^repo-[a-f0-9]{20}$/);
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, otherBranch.id);
  assert.throws(
    () => normalizeSourceRepository({ url: "file:///etc/passwd", branch: "main" }),
    /INVALID_SOURCE_REPOSITORY_URL/,
  );
  assert.throws(
    () => normalizeSourceRepository({ url: "https://127.0.0.1/repo.git", branch: "main" }),
    /INVALID_SOURCE_REPOSITORY_URL/,
  );
  assert.throws(
    () => normalizeSourceRepository({ url: "https://user:password@example.com/repo.git", branch: "main" }),
    /INVALID_SOURCE_REPOSITORY_URL/,
  );
  assert.equal(
    normalizeSourceRepository({
      url: "https://github.com/example/ota.git",
      branch: "main",
      credentialRef: "github-readonly",
    }).credentialRef,
    "github-readonly",
  );
  assert.equal(
    normalizeSourceRepository({
      url: "https://github.com/example/ota.git",
      branch: "main",
      gitProxyUrl: "http://proxy.internal:7890",
    }).gitProxyUrl,
    "http://proxy.internal:7890",
  );
  assert.throws(
    () =>
      normalizeSourceRepository({
        url: "https://github.com/example/ota.git",
        branch: "main",
        gitProxyUrl: "http://user:pass@proxy.internal:7890",
      }),
    /INVALID_GIT_PROXY_URL/,
  );
  assert.throws(
    () =>
      normalizeSourceRepository({
        url: "https://github.com/example/ota.git",
        branch: "main",
        gitProxyUrl: "file:///tmp/proxy",
      }),
    /INVALID_GIT_PROXY_URL/,
  );
  assert.throws(
    () => normalizeSourceRepository({ url: "git@github.com:example/repo.git", branch: "-upload-pack=evil" }),
    /INVALID_SOURCE_REPOSITORY_BRANCH/,
  );
});

test("worker clones configured repositories and refreshes to the configured branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expert-repository-workspace-"));
  try {
    const seed = path.join(root, "seed");
    const bare = path.join(root, "origin.git");
    const workspaceRoot = path.join(root, "workspaces");
    await mkdir(seed);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "test@example.invalid"], seed);
    git(["config", "user.name", "Expert Test"], seed);
    await writeFile(path.join(seed, "README.md"), "version one\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "initial"], seed);
    git(["init", "--bare", bare]);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-u", "origin", "main"], seed);

    const id = "repo-0123456789abcdefabcd";
    const input = { id, url: bare, branch: "main", root: workspaceRoot };
    const first = await prepareRepositoryWorkspace(input);
    assert.match(first.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(git(["-C", first.path, "show", "HEAD:README.md"]), "version one");

    await writeFile(path.join(seed, "README.md"), "version two\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "update"], seed);
    git(["push", "origin", "main"], seed);
    const second = await prepareRepositoryWorkspace(input);
    assert.equal(second.path, first.path);
    assert.notEqual(second.commitSha, first.commitSha);
    assert.equal(git(["-C", second.path, "show", "HEAD:README.md"]), "version two");
    // Fail closed if remote becomes unavailable. Never run analysis on cached HEAD.
    const unavailable = bare + ".offline";
    git(["init", "--bare", unavailable]);
    git(["remote", "set-url", "origin", unavailable], seed);
    await assert.rejects(prepareRepositoryWorkspace({ ...input, branch: "missing-branch" }), /GIT_OPERATION_FAILED/);
    assert.equal(git(["-C", second.path, "show", "HEAD:README.md"]), "version two");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git credential config supports SSH key paths and HTTPS token environment references", () => {
  assert.deepEqual(
    loadGitCredentialConfigs(
      JSON.stringify({
        "ota-ssh": "/etc/expert/keys/ota-readonly",
        "ota-https": { type: "https-token", tokenEnv: "EXPERT_GITHUB_READ_TOKEN" },
      }),
    ),
    {
      "ota-ssh": { type: "ssh-key", path: "/etc/expert/keys/ota-readonly" },
      "ota-https": { type: "https-token", tokenEnv: "EXPERT_GITHUB_READ_TOKEN" },
    },
  );
  assert.throws(
    () => loadGitCredentialConfigs(JSON.stringify({ bad: { type: "https-token", tokenEnv: "GITHUB-TOKEN" } })),
    /INVALID_EXPERT_GIT_CREDENTIALS_JSON/,
  );
});

test("HTTPS token credential requires HTTPS URL and token from configured environment variable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expert-repository-token-"));
  const oldToken = process.env.EXPERT_TEST_GIT_TOKEN;
  process.env.EXPERT_TEST_GIT_TOKEN = "test-token-value";
  try {
    const seed = path.join(root, "seed");
    await mkdir(seed);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "test@example.invalid"], seed);
    git(["config", "user.name", "Expert Test"], seed);
    await writeFile(path.join(seed, "README.md"), "token test\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "initial"], seed);
    const bare = path.join(root, "origin.git");
    git(["init", "--bare", bare]);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-u", "origin", "main"], seed);
    await assert.rejects(
      prepareRepositoryWorkspace({
        id: "repo-token-test",
        url: bare,
        branch: "main",
        root: path.join(root, "workspaces"),
        credentialRef: "https-token",
        credentials: { "https-token": { type: "https-token", tokenEnv: "EXPERT_TEST_GIT_TOKEN" } },
      }),
      /SOURCE_REPOSITORY_CREDENTIAL_TYPE_MISMATCH/,
    );
  } finally {
    if (oldToken === undefined) delete process.env.EXPERT_TEST_GIT_TOKEN;
    else process.env.EXPERT_TEST_GIT_TOKEN = oldToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("repository proxy is passed only to Git process configuration and is not persisted in the clone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expert-repository-proxy-"));
  try {
    const seed = path.join(root, "seed");
    const bare = path.join(root, "origin.git");
    await mkdir(seed);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "test@example.invalid"], seed);
    git(["config", "user.name", "Expert Test"], seed);
    await writeFile(path.join(seed, "README.md"), "proxy test\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "initial"], seed);
    git(["init", "--bare", bare]);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-u", "origin", "main"], seed);
    const result = await prepareRepositoryWorkspace({
      id: "repo-proxy-test",
      url: bare,
      branch: "main",
      root: path.join(root, "workspaces"),
      gitProxyUrl: "http://proxy.internal:7890",
    });
    assert.match(result.commitSha, /^[a-f0-9]{40}$/);
    assert.throws(() =>
      execFileSync("git", ["-C", result.path, "config", "--local", "--get", "http.proxy"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
