import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SkillBundleReviewStaleError,
  SkillBundlePublisher,
  type SkillBundleGitRun,
} from "../src/skill-bundle-publishing.js";
import {
  canonicalTreeHash,
  createSkillBundleSnapshot,
  normalizeSkillBundleInput,
  type SkillBundleImport,
} from "../src/skill-bundles.js";
import type { RepositoryConfig } from "../src/types.js";

const repository: RepositoryConfig = {
  id: "rd-skills",
  name: "RD Skills",
  provider: "git",
  gitUrl: "git@github.com:example/rd-skills.git",
  branch: "master",
  gitAuth: { type: "ssh" },
  webhookAliases: [],
  enabled: true,
  audience: ["developer"],
  visibility: ["internal"],
  pollingIntervalSeconds: 60,
  readRoles: [],
  syncRoles: [],
  skillPublishing: {
    enabled: true,
    provider: "github",
    baseUrl: "https://github.com",
    projectPath: "example/rd-skills",
    tokenEnv: "TEST_SKILL_BUNDLE_TOKEN",
    targetBranch: "master",
    branchPrefix: "skill-hub-skill",
  },
};

function bundle() {
  const normalized = normalizeSkillBundleInput({
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    files: [
      { path: "SKILL.md", content: "new skill\n" },
      { path: "scripts/run.sh", content: "#!/bin/sh\n", mode: "0755" },
    ],
  });
  const snapshot = createSkillBundleSnapshot(normalized, "2026-10-14T00:00:00.000Z");
  const record: SkillBundleImport = {
    id: "sbi_1234567890abcdef",
    revision: 0,
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    replacementRoot: "skills/ota/design",
    collection: "rd-skills",
    repository: "rd-skills",
    sourceType: "mcp",
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    status: "approved",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
  return { snapshot, record };
}

function approvedAgainst(
  record: SkillBundleImport,
  files: Array<{ path: string; content?: string; contentBase64?: string; mode?: "0644" | "0755" }>,
): SkillBundleImport {
  return {
    ...record,
    review: {
      reviewer: "admin",
      reviewedAt: "2026-10-14T00:10:00.000Z",
      targetRevision: "reviewed-target",
      targetTreeSha256: canonicalTreeHash(files),
      diffSha256: "reviewed-diff",
      added: 0,
      modified: 0,
      deleted: 0,
    },
  };
}

type FakeFile = string | { content: string; mode?: number };

function fakeGit(initialFiles: Record<string, FakeFile>, remoteBranch = false) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const run: SkillBundleGitRun = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    if (args[0] === "clone") {
      const target = args.at(-1)!;
      for (const [relative, value] of Object.entries(initialFiles)) {
        const file = path.join(target, ...relative.split("/"));
        await mkdir(path.dirname(file), { recursive: true });
        const content = typeof value === "string" ? value : value.content;
        await writeFile(file, content, "utf8");
        if (typeof value !== "string" && value.mode !== undefined) await chmod(file, value.mode);
      }
    }
    if (args[0] === "ls-remote") return remoteBranch ? "abc refs/heads/skill-hub-skill-1234567890ab" : "";
    return "";
  };
  return { run, calls };
}

test("publisher rebuilds replacementRoot snapshot, deletes stale files and creates one GitHub PR", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "token";
  const { snapshot, record: rawRecord } = bundle();
  const record = approvedAgainst(rawRecord, [
    { path: "SKILL.md", content: "old skill\n" },
    { path: "old.txt", content: "stale\n" },
  ]);
  const git = fakeGit(
    {
      "skills/ota/design/SKILL.md": "old skill\n",
      "skills/ota/design/old.txt": "stale\n",
      "skills/ota/usage/SKILL.md": "sibling\n",
    },
    true,
  );
  let captured: { skill?: string; oldMissing?: boolean; sibling?: string } = {};
  const run: SkillBundleGitRun = async (args, cwd) => {
    const result = await git.run(args, cwd);
    if (args[0] === "commit" && cwd) {
      captured.skill = await readFile(path.join(cwd, "skills/ota/design/SKILL.md"), "utf8");
      try {
        await readFile(path.join(cwd, "skills/ota/design/old.txt"), "utf8");
        captured.oldMissing = false;
      } catch {
        captured.oldMissing = true;
      }
      captured.sibling = await readFile(path.join(cwd, "skills/ota/usage/SKILL.md"), "utf8");
    }
    return result;
  };
  const fetchMock: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.github.com/repos/example/rd-skills/pulls");
    assert.equal(init?.method, "POST");
    return new Response(
      JSON.stringify({ number: 7, html_url: "https://github.com/example/rd-skills/pull/7", state: "open" }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await new SkillBundlePublisher(fetchMock, run).publish(record, snapshot, repository);
    assert.equal(result.kind, "pull-request");
    assert.equal(result.kind === "pull-request" ? result.mergeRequestIid : 0, 7);
    assert.equal(captured.skill, "new skill\n");
    assert.equal(captured.oldMissing, true);
    assert.equal(captured.sibling, "sibling\n");
    assert.ok(git.calls.some(({ args }) => args[0] === "add" && args.includes("skills/ota/design")));
    assert.ok(
      git.calls.some(
        ({ args }) =>
          args[0] === "push" && args.includes("--force-with-lease=refs/heads/skill-hub-skill-1234567890ab:abc"),
      ),
    );
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("GitLab publisher uses publishing token and repository API without git clone or push", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "gitlab-write-token";
  const gitlabRepository: RepositoryConfig = {
    ...repository,
    gitUrl: "https://gitlab.example.com/example/rd-skills.git",
    gitAuth: { type: "https-token", tokenEnv: "IGNORED_GIT_TOKEN" },
    skillPublishing: {
      ...repository.skillPublishing!,
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectPath: "example/rd-skills",
    },
  };
  const { snapshot, record: rawRecord } = bundle();
  const reviewedFiles = [
    { path: "SKILL.md", content: "old skill\n" },
    { path: "old.txt", content: "stale\n" },
  ];
  const record = approvedAgainst(rawRecord, reviewedFiles);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    assert.equal(new Headers(init?.headers).get("private-token"), "gitlab-write-token");

    if (url.endsWith("/repository/branches/master")) {
      return Response.json({ commit: { id: "target-sha" } });
    }
    if (url.includes("/repository/tree?")) {
      return Response.json([
        { type: "blob", path: "skills/ota/design/SKILL.md", mode: "100644" },
        { type: "blob", path: "skills/ota/design/old.txt", mode: "100644" },
      ]);
    }
    if (url.includes("/repository/files/skills%2Fota%2Fdesign%2FSKILL.md?")) {
      return Response.json({
        content: Buffer.from("old skill\n").toString("base64"),
        encoding: "base64",
        execute_filemode: false,
      });
    }
    if (url.includes("/repository/files/skills%2Fota%2Fdesign%2Fold.txt?")) {
      return Response.json({
        content: Buffer.from("stale\n").toString("base64"),
        encoding: "base64",
        execute_filemode: false,
      });
    }
    if (url.endsWith("/repository/branches/skill-hub-skill-1234567890ab")) {
      return new Response("", { status: 404 });
    }
    if (url.endsWith("/repository/branches/skill-hub-base-1234567890ab")) {
      assert.equal(init?.method, "DELETE");
      return new Response(null, {
        status:
          requests.filter(({ url: requestUrl }) =>
            requestUrl.endsWith("/repository/branches/skill-hub-base-1234567890ab"),
          ).length === 1
            ? 404
            : 204,
      });
    }
    if (url.endsWith("/repository/branches")) {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as { branch: string; ref: string };
      assert.deepEqual(body, { branch: "skill-hub-base-1234567890ab", ref: "target-sha" });
      return Response.json({ name: body.branch, commit: { id: "target-sha" } }, { status: 201 });
    }
    if (url.endsWith("/repository/commits")) {
      const body = JSON.parse(String(init?.body)) as {
        branch: string;
        start_branch: string;
        start_sha: string;
        force: boolean;
        actions: Array<{
          action: string;
          file_path: string;
          content?: string;
          encoding?: string;
          execute_filemode?: boolean;
        }>;
      };
      assert.equal(body.branch, "skill-hub-skill-1234567890ab");
      assert.equal(body.start_branch, "skill-hub-base-1234567890ab");
      assert.equal(body.start_sha, undefined);
      assert.equal(body.force, undefined);
      assert.deepEqual(
        body.actions.map((action) => [action.action, action.file_path]),
        [
          ["update", "skills/ota/design/SKILL.md"],
          ["create", "skills/ota/design/scripts/run.sh"],
          ["chmod", "skills/ota/design/scripts/run.sh"],
          ["delete", "skills/ota/design/old.txt"],
        ],
      );
      assert.ok(body.actions.slice(0, 2).every((action) => action.encoding === "base64" && action.content));
      assert.equal(body.actions[2]?.execute_filemode, true);
      return Response.json({ id: "commit-sha" }, { status: 201 });
    }
    if (url.endsWith("/merge_requests")) {
      return Response.json(
        { iid: 9, web_url: "https://gitlab.example.com/example/rd-skills/-/merge_requests/9", state: "opened" },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await new SkillBundlePublisher(fetchMock, async () => {
      throw new Error("git should not be called for GitLab publishing");
    }).publish(record, snapshot, gitlabRepository);
    assert.equal(result.kind, "pull-request");
    assert.equal(result.kind === "pull-request" ? result.mergeRequestIid : 0, 9);
    assert.ok(
      requests.some(
        ({ url, init }) =>
          url.endsWith("/repository/branches") &&
          init?.method === "POST" &&
          String(init.body).includes("skill-hub-base-1234567890ab"),
      ),
    );
    assert.ok(requests.some(({ url }) => url.endsWith("/repository/commits")));
    assert.equal(
      requests.filter(
        ({ url, init }) =>
          url.endsWith("/repository/branches/skill-hub-base-1234567890ab") && init?.method === "DELETE",
      ).length,
      2,
    );
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("GitLab publisher resets an existing import branch from the reviewed target revision", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "gitlab-write-token";
  const gitlabRepository: RepositoryConfig = {
    ...repository,
    skillPublishing: {
      ...repository.skillPublishing!,
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectPath: "example/rd-skills",
    },
  };
  const { snapshot, record: rawRecord } = bundle();
  const record = approvedAgainst(rawRecord, [{ path: "SKILL.md", content: "old skill\n" }]);
  const calls: string[] = [];
  let baselineDeleteCount = 0;
  let commitBody: { start_branch?: string; start_sha?: string; force?: boolean } | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/repository/branches/master")) {
      return Response.json({ commit: { id: "target-sha" } });
    }
    if (url.endsWith("/repository/branches/skill-hub-skill-1234567890ab") && init?.method === "DELETE") {
      calls.push("delete-import");
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/repository/branches/skill-hub-skill-1234567890ab")) {
      calls.push("lookup-import");
      return Response.json({ commit: { id: "old-import-sha" } });
    }
    if (url.endsWith("/repository/branches/skill-hub-base-1234567890ab")) {
      assert.equal(init?.method, "DELETE");
      baselineDeleteCount += 1;
      calls.push(`delete-baseline-${baselineDeleteCount}`);
      return new Response(null, { status: baselineDeleteCount === 1 ? 404 : 204 });
    }
    if (url.endsWith("/repository/branches")) {
      calls.push("create-baseline");
      const body = JSON.parse(String(init?.body)) as { branch: string; ref: string };
      assert.deepEqual(body, { branch: "skill-hub-base-1234567890ab", ref: "target-sha" });
      return Response.json({ name: body.branch, commit: { id: "target-sha" } }, { status: 201 });
    }
    if (url.includes("/repository/tree?")) {
      return Response.json([{ type: "blob", path: "skills/ota/design/SKILL.md", mode: "100644" }]);
    }
    if (url.includes("/repository/files/skills%2Fota%2Fdesign%2FSKILL.md?")) {
      return Response.json({ content: Buffer.from("old skill\n").toString("base64"), encoding: "base64" });
    }
    if (url.endsWith("/repository/commits")) {
      calls.push("commit");
      commitBody = JSON.parse(String(init?.body)) as { start_branch?: string; start_sha?: string; force?: boolean };
      return Response.json({ id: "commit-sha" }, { status: 201 });
    }
    if (url.endsWith("/merge_requests")) {
      calls.push("merge-request");
      return Response.json(
        { iid: 10, web_url: "https://gitlab.example.com/example/rd-skills/-/merge_requests/10", state: "opened" },
        { status: 201 },
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await new SkillBundlePublisher(fetchMock, async () => {
      throw new Error("git should not be called for GitLab publishing");
    }).publish(record, snapshot, gitlabRepository);
    assert.equal(commitBody?.start_branch, "skill-hub-base-1234567890ab");
    assert.equal(commitBody?.start_sha, undefined);
    assert.equal(commitBody?.force, undefined);
    assert.deepEqual(calls, [
      "lookup-import",
      "delete-baseline-1",
      "create-baseline",
      "delete-import",
      "commit",
      "delete-baseline-2",
      "merge-request",
    ]);
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("publisher preserves binary asset bytes from snapshot", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "token";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const normalized = normalizeSkillBundleInput({
    namespace: "skill-creator",
    importType: "skill",
    files: [
      { path: "SKILL.md", content: "---\nname: skill-creator\n---\n\n# Skill Creator\n" },
      { path: "assets/skill-creator.png", contentBase64: png.toString("base64") },
    ],
  });
  const snapshot = createSkillBundleSnapshot(normalized, "2026-10-14T00:00:00.000Z");
  const rawRecord: SkillBundleImport = {
    id: "sbi_binary123456",
    revision: 0,
    namespace: "skill-creator",
    importType: "skill",
    replacementRoot: "skills/skill-creator",
    collection: "rd-skills",
    repository: "rd-skills",
    sourceType: "web-zip",
    snapshotId: snapshot.id,
    snapshotSha256: snapshot.sha256,
    status: "approved",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
  const record = approvedAgainst(rawRecord, []);
  const git = fakeGit({});
  let publishedBytes: Buffer | undefined;
  const run: SkillBundleGitRun = async (args, cwd) => {
    const result = await git.run(args, cwd);
    if (args[0] === "commit" && cwd)
      publishedBytes = await readFile(path.join(cwd, "skills/skill-creator/assets/skill-creator.png"));
    return result;
  };
  const fetchMock: typeof fetch = async () =>
    new Response(
      JSON.stringify({ number: 8, html_url: "https://github.com/example/rd-skills/pull/8", state: "open" }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  try {
    const result = await new SkillBundlePublisher(fetchMock, run).publish(record, snapshot, repository);
    assert.equal(result.kind, "pull-request");
    assert.deepEqual(publishedBytes, png);
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("publisher returns no-op when replacementRoot already equals snapshot", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "token";
  const { snapshot, record: rawRecord } = bundle();
  const record = approvedAgainst(rawRecord, snapshot.files);
  const git = fakeGit({
    "skills/ota/design/SKILL.md": "new skill\n",
    "skills/ota/design/scripts/run.sh": { content: "#!/bin/sh\n", mode: 0o755 },
  });
  try {
    const result = await new SkillBundlePublisher(async () => {
      throw new Error("PR should not be called");
    }, git.run).publish(record, snapshot, repository);
    assert.equal(result.kind, "no-op");
    assert.equal(
      git.calls.some(({ args }) => args[0] === "commit"),
      false,
    );
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("publisher rejects when target replacementRoot changes after service review check", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "token";
  const { snapshot, record: rawRecord } = bundle();
  const record = approvedAgainst(rawRecord, [{ path: "SKILL.md", content: "reviewed old skill\n" }]);
  const git = fakeGit({ "skills/ota/design/SKILL.md": "concurrent change\n" });
  try {
    await assert.rejects(
      () =>
        new SkillBundlePublisher(async () => {
          throw new Error("PR should not be called");
        }, git.run).publish(record, snapshot, repository),
      SkillBundleReviewStaleError,
    );
    assert.equal(
      git.calls.some(({ args }) => args[0] === "commit"),
      false,
    );
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("GitLab merged reconciliation verifies the final tree through repository API without git clone", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "gitlab-write-token";
  const gitlabRepository: RepositoryConfig = {
    ...repository,
    gitUrl: "https://gitlab.example.com/example/rd-skills.git",
    gitAuth: { type: "https-token", tokenEnv: "IGNORED_GIT_TOKEN" },
    skillPublishing: {
      ...repository.skillPublishing!,
      provider: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectPath: "example/rd-skills",
    },
  };
  const { snapshot, record } = bundle();
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("private-token"), "gitlab-write-token");
    if (url.endsWith("/merge_requests/9")) {
      return Response.json({
        state: "merged",
        merged_at: "2026-10-14T01:00:00.000Z",
        closed_at: "2026-10-14T01:00:00.000Z",
        merge_commit_sha: "merge-sha",
      });
    }
    if (url.includes("/repository/tree?")) {
      assert.match(url, /ref=merge-sha/);
      return Response.json([
        { type: "blob", path: "skills/ota/design/SKILL.md", mode: "100644" },
        { type: "blob", path: "skills/ota/design/scripts/run.sh", mode: "100755" },
      ]);
    }
    if (url.includes("/repository/files/skills%2Fota%2Fdesign%2FSKILL.md?")) {
      return Response.json({
        content: Buffer.from("new skill\n").toString("base64"),
        encoding: "base64",
        execute_filemode: false,
      });
    }
    if (url.includes("/repository/files/skills%2Fota%2Fdesign%2Fscripts%2Frun.sh?")) {
      return Response.json({
        content: Buffer.from("#!/bin/sh\n").toString("base64"),
        encoding: "base64",
        execute_filemode: true,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await new SkillBundlePublisher(fetchMock, async () => {
      throw new Error("git should not be called for GitLab reconciliation");
    }).reconcile(
      {
        kind: "pull-request",
        provider: "gitlab",
        projectPath: "example/rd-skills",
        branch: "skill-hub-skill-1234567890ab",
        targetBranch: "master",
        targetRoot: record.replacementRoot,
        mergeRequestIid: 9,
        mergeRequestUrl: "https://gitlab.example.com/example/rd-skills/-/merge_requests/9",
        mergeRequestState: "opened",
        added: 1,
        modified: 1,
        deleted: 0,
        expectedTreeSha256: snapshot.sha256,
        pullRequestCreatedAt: "2026-10-14T00:30:00.000Z",
        lastCheckedAt: "2026-10-14T00:30:00.000Z",
      },
      snapshot,
      gitlabRepository,
    );
    assert.equal(result.publication.mergeRequestState, "merged");
    assert.equal(result.finalTreeMatches, true);
    assert.equal(result.publication.finalTreeSha256, snapshot.sha256);
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});

test("merged reconciliation verifies the final replacementRoot tree", async () => {
  process.env.TEST_SKILL_BUNDLE_TOKEN = "token";
  const { snapshot, record } = bundle();
  const git = fakeGit({
    "skills/ota/design/SKILL.md": "concurrent different skill\n",
  });
  const fetchMock: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        state: "closed",
        merged_at: "2026-10-14T01:00:00.000Z",
        closed_at: "2026-10-14T01:00:00.000Z",
        merge_commit_sha: "deadbeef",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const result = await new SkillBundlePublisher(fetchMock, git.run).reconcile(
      {
        kind: "pull-request",
        provider: "github",
        projectPath: "example/rd-skills",
        branch: "skill-hub-skill-1234567890ab",
        targetBranch: "master",
        targetRoot: record.replacementRoot,
        mergeRequestIid: 7,
        mergeRequestUrl: "https://github.com/example/rd-skills/pull/7",
        mergeRequestState: "opened",
        added: 1,
        modified: 0,
        deleted: 0,
        expectedTreeSha256: snapshot.sha256,
        pullRequestCreatedAt: "2026-10-14T00:30:00.000Z",
        lastCheckedAt: "2026-10-14T00:30:00.000Z",
      },
      snapshot,
      repository,
    );
    assert.equal(result.publication.mergeRequestState, "merged");
    assert.equal(result.finalTreeMatches, false);
    assert.notEqual(result.publication.finalTreeSha256, snapshot.sha256);
    assert.ok(result.finalDiff?.modified.includes("SKILL.md"));
  } finally {
    delete process.env.TEST_SKILL_BUNDLE_TOKEN;
  }
});
