import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

test("publication templates generate safe repository-specific permissions without handwritten JSON", () => {
  const base = { url: "https://github.com/example/repo.git", branch: "release/2026" };
  const review = normalizeSourceRepository({
    ...base,
    credentialRef: "git-writer",
    publicationTemplate: { preset: "change-request" },
  });
  assert.deepEqual(review.publicationPolicy, {
    version: 1,
    permissions: ["prepare-commit", "push-work-branch", "create-change-request"],
    branchPrefix: "tsh/",
    protectedBranches: ["main", "master", "release/2026"],
    allowedPushRemote: "origin",
    allowForcePush: false,
    allowDeleteRef: false,
  });
  assert.equal(review.credentialRef, "git-writer");
  const branchOnly = normalizeSourceRepository({
    ...base,
    publicationTemplate: { preset: "work-branch", branchPrefix: "expert/" },
  });
  assert.deepEqual(branchOnly.publicationPolicy?.permissions, ["prepare-commit", "push-work-branch"]);
  assert.equal(branchOnly.publicationPolicy?.branchPrefix, "expert/");
  assert.deepEqual(
    normalizeSourceRepository({
      ...base,
      publicationTemplate: { preset: "change-request" },
    }).publicationPolicy,
    review.publicationPolicy,
  );
  for (const branchPrefix of ["../escape/", "refs/heads/anything/", "a b/", "/absolute/", "missing-slash"]) {
    assert.throws(
      () => normalizeSourceRepository({ ...base, publicationTemplate: { preset: "change-request", branchPrefix } }),
      /INVALID_PUBLICATION_TEMPLATE/,
    );
  }
  assert.throws(
    () =>
      normalizeSourceRepository({
        ...base,
        publicationTemplate: { preset: "change-request" },
        publicationPolicy: review.publicationPolicy,
      }),
    /CONFLICTING_PUBLICATION_CONFIG/,
  );
});
test("CMake and CTest template emits isolated build/unit steps and never hides missing tests", () => {
  const base = { url: "https://github.com/example/repo.git", branch: "main" };
  const repo = normalizeSourceRepository({ ...base, verificationTemplate: { preset: "cmake-ctest" } });
  const steps = repo.verificationPolicy?.required ?? [];
  assert.equal(repo.verificationPolicy?.version, 1);
  assert.deepEqual(
    steps.map((step) => step.evidenceType),
    ["build", "unit_test"],
  );
  assert.ok(steps.every((step) => step.timeoutMs >= 600_000));
  assert.match(steps[0]?.argv[2] ?? "", /cmake -S \/workspace -B \/tmp\/build/);
  assert.match(steps[1]?.argv[2] ?? "", /--no-tests=error/);
  assert.match(steps[1]?.argv[2] ?? "", /cp -a \/workspace\/\. \/tmp\/src\//);
  assert.throws(
    () =>
      normalizeSourceRepository({
        ...base,
        verificationTemplate: { preset: "cmake-ctest" },
        verificationPolicy: repo.verificationPolicy,
      }),
    /CONFLICTING_VERIFICATION_CONFIG/,
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

test("repository checkouts are isolated by workspaceKey and reused within one workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expert-workspace-key-"));
  try {
    const seed = path.join(root, "seed");
    const bare = path.join(root, "origin.git");
    const workspaceRoot = path.join(root, "workspaces");
    await mkdir(seed);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "test@example.invalid"], seed);
    git(["config", "user.name", "Expert Test"], seed);
    await writeFile(path.join(seed, "README.md"), "workspace isolation\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "initial"], seed);
    git(["init", "--bare", bare]);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-u", "origin", "main"], seed);

    const common = { id: "repo-workspace-key", url: bare, branch: "main", root: workspaceRoot };
    const first = await prepareRepositoryWorkspace({ ...common, workspaceKey: "work-11111111-a1" });
    assert.ok(existsSync(path.join(first.path, ".git", "team-skill-hub-workspace-ready")));
    const again = await prepareRepositoryWorkspace({ ...common, workspaceKey: "work-11111111-a1" });
    const second = await prepareRepositoryWorkspace({ ...common, workspaceKey: "work-11111111-a2" });

    assert.equal(again.path, first.path);
    assert.notEqual(second.path, first.path);
    assert.equal(first.path, path.join(workspaceRoot, "work-11111111-a1", common.id));
    assert.equal(second.path, path.join(workspaceRoot, "work-11111111-a2", common.id));
    await assert.rejects(prepareRepositoryWorkspace({ ...common, workspaceKey: "../escape" }), /INVALID_WORKSPACE_KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted checkout cannot be misclassified as a ready WorkAttempt workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expert-incomplete-workspace-"));
  try {
    const seed = path.join(root, "seed");
    const bare = path.join(root, "origin.git");
    await mkdir(seed);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "test@example.invalid"], seed);
    git(["config", "user.name", "Expert Test"], seed);
    await writeFile(path.join(seed, "README.md"), "source exists\\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "initial"], seed);
    git(["init", "--bare", bare]);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-u", "origin", "main"], seed);
    const input = {
      id: "repo-interrupted",
      url: bare,
      branch: "main",
      root: path.join(root, "workspaces"),
      workspaceKey: "work-interrupted-a1",
      workspaceAccess: "read-write" as const,
    };
    await assert.rejects(
      prepareRepositoryWorkspace({
        ...input,
        runGit: async (args, cwd, env) => {
          if (args.includes("checkout")) throw new Error("GIT_OPERATION_FAILED:LFS_SMUDGE_INTERRUPTED");
          execFileSync("git", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
        },
      }),
      /LFS_SMUDGE_INTERRUPTED/,
    );
    const destination = path.join(input.root, input.workspaceKey, input.id);
    assert.ok(existsSync(path.join(destination, ".git")), "failed clone left Git metadata");
    assert.equal(existsSync(path.join(destination, "README.md")), false, "checkout did not complete");

    const recovered = await prepareRepositoryWorkspace(input);
    assert.equal(recovered.path, destination);
    assert.match(recovered.commitSha, /^[a-f0-9]{40}$/);
    assert.equal(readFileSync(path.join(destination, "README.md"), "utf8"), "source exists\\n");
    assert.equal(
      existsSync(path.join(destination, ".git", "team-skill-hub-workspace-ready")),
      true,
      "successful retry marks the workspace ready",
    );
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

test("re-preparing the same WorkAttempt workspace preserves uncommitted changes across continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expert-workspace-continuation-"));
  try {
    const seed = path.join(root, "seed");
    const bare = path.join(root, "origin.git");
    const workspaceRoot = path.join(root, "workspaces");
    await mkdir(seed);
    git(["init", "-b", "main"], seed);
    git(["config", "user.email", "test@example.invalid"], seed);
    git(["config", "user.name", "Expert Test"], seed);
    await writeFile(path.join(seed, "README.md"), "base\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "initial"], seed);
    git(["init", "--bare", bare]);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "-u", "origin", "main"], seed);

    const input = {
      id: "repo-continuation",
      url: bare,
      branch: "main",
      root: workspaceRoot,
      workspaceKey: "work-continuation-a1",
      workspaceAccess: "read-write" as const,
    };
    const first = await prepareRepositoryWorkspace(input);
    await writeFile(path.join(first.path, "README.md"), "modified in attempt\n");
    await writeFile(path.join(first.path, "new.txt"), "new\n");

    await writeFile(path.join(seed, "README.md"), "new upstream\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "upstream"], seed);
    git(["push", "origin", "main"], seed);

    const continued = await prepareRepositoryWorkspace(input);
    assert.equal(continued.path, first.path);
    assert.equal(continued.commitSha, first.commitSha, "WorkAttempt base revision must stay pinned");
    assert.equal(
      await import("node:fs/promises").then(({ readFile }) => readFile(path.join(first.path, "README.md"), "utf8")),
      "modified in attempt\n",
    );
    assert.equal(
      await import("node:fs/promises").then(({ readFile }) => readFile(path.join(first.path, "new.txt"), "utf8")),
      "new\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
