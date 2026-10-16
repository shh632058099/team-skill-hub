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
