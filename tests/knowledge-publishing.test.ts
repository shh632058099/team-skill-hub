import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultCandidatePath,
  GitHubKnowledgePublisher,
  GitLabKnowledgePublisher,
  resolveKnowledgePublishTarget,
} from "../src/knowledge-publishing.js";
import type { RepositoryConfig } from "../src/types.js";
import type { KnowledgeCandidate } from "../src/observability.js";

function repository(): RepositoryConfig {
  return {
    id: "rd-skills",
    name: "R&D Skills",
    provider: "git",
    gitUrl: "git@gitlab.example.com:ai/rd-skills.git",
    branch: "master",
    gitAuth: { type: "none" },
    webhookAliases: [],
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 0,
    readRoles: ["developer", "internal"],
    syncRoles: ["admin"],
    knowledgePublishing: {
      enabled: true,
      provider: "gitlab",
      tokenEnv: "TEST_GITLAB_WRITE_TOKEN",
      targetBranch: "master",
      branchPrefix: "skill-hub-knowledge",
    },
  };
}

function githubRepository(): RepositoryConfig {
  return {
    ...repository(),
    gitUrl: "https://github.com/shh632058099/rd-skills.git",
    knowledgePublishing: {
      enabled: true,
      provider: "github",
      baseUrl: "https://github.com",
      projectPath: "shh632058099/rd-knowledges",
      tokenEnv: "TEST_GITHUB_TOKEN",
      targetBranch: "main",
      branchPrefix: "skill-hub-knowledge",
    },
  };
}

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    id: "kc_1234567890abcdef",
    ts: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    actorId: "dev-a",
    tenantId: "rd",
    traceId: "trace-1",
    title: "OTA recovery note",
    content: "Recovery behavior learned during troubleshooting.",
    sourceType: "troubleshooting",
    suggestedType: "knowledge",
    repository: "rd-skills",
    suggestedPath: "docs/ota/recovery-note.md",
    status: "approved",
    reviewer: "admin-http",
    reviewNote: "verified",
    ...overrides,
  };
}

test("default Knowledge path is stable and unique per candidate", () => {
  assert.equal(
    defaultCandidatePath(candidate({ suggestedPath: undefined, title: "OTA 断电恢复修复" })),
    "knowledge/ota-1234567890ab.md",
  );
  assert.equal(
    defaultCandidatePath(candidate({ id: "kc_abcdef1234567890", suggestedPath: undefined, title: "纯中文知识" })),
    "knowledge/knowledge-abcdef123456.md",
  );
});

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("GitLab publisher creates a new file branch and merge request", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 }),
    responseJson({ file_path: "docs/ota/recovery-note.md", branch: "skill-hub-knowledge-1234567890ab" }, 201),
    responseJson({ iid: 12, web_url: "https://gitlab.example.com/ai/rd-skills/-/merge_requests/12" }, 201),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };

  try {
    const result = await new GitLabKnowledgePublisher(fetchMock).publish(candidate(), repository());
    assert.equal(result.action, "create");
    assert.equal(result.mergeRequestIid, 12);
    assert.equal(result.branch, "skill-hub-knowledge-1234567890ab");
    assert.equal(calls[2]?.method, "POST");
    const fileBody = JSON.parse(calls[2]?.body ?? "{}");
    assert.equal(fileBody.start_branch, "master");
    assert.match(fileBody.content, /^# OTA recovery note/);
    assert.equal(calls[3]?.method, "POST");
    assert.match(calls[3]?.url ?? "", /merge_requests$/);
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitLab publisher updates an existing target file", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const calls: Array<{ method: string; body?: string }> = [];
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 200 }),
    responseJson({ file_path: "docs/ota/recovery-note.md" }, 200),
    responseJson({ iid: 13, web_url: "https://gitlab.example.com/mr/13" }, 201),
  ];
  const fetchMock: typeof fetch = async (_input, init) => {
    calls.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };

  try {
    const result = await new GitLabKnowledgePublisher(fetchMock).publish(candidate(), repository());
    assert.equal(result.action, "update");
    assert.equal(calls[2]?.method, "PUT");
    assert.equal(JSON.parse(calls[2]?.body ?? "{}").start_branch, "master");
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitLab publisher retry skips identical branch content and reuses open MR", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const desired = "# OTA recovery note\n\nRecovery behavior learned during troubleshooting.\n";
  const calls: Array<{ url: string; method: string }> = [];
  const responses = [
    responseJson({ name: "skill-hub-knowledge-1234567890ab" }, 200),
    new Response(null, { status: 404 }),
    responseJson({ content: Buffer.from(desired).toString("base64"), encoding: "base64" }, 200),
    responseJson({ message: "Another open merge request already exists" }, 409),
    responseJson([{ iid: 14, web_url: "https://gitlab.example.com/mr/14" }], 200),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };

  try {
    const result = await new GitLabKnowledgePublisher(fetchMock).publish(
      candidate({ status: "publish_failed" }),
      repository(),
    );
    assert.equal(result.mergeRequestIid, 14);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET", "HEAD", "GET", "POST", "GET"],
    );
    assert.match(calls[4]?.url ?? "", /source_branch=skill-hub-knowledge-1234567890ab/);
    assert.match(calls[4]?.url ?? "", /state=all/);
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitLab publisher refuses to silently reuse a closed merge request", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const desired = "# OTA recovery note\n\nRecovery behavior learned during troubleshooting.\n";
  const responses = [
    responseJson({ name: "skill-hub-knowledge-1234567890ab" }, 200),
    new Response(null, { status: 404 }),
    responseJson({ content: Buffer.from(desired).toString("base64"), encoding: "base64" }, 200),
    responseJson({ message: "merge request already exists" }, 409),
    responseJson([{ iid: 15, web_url: "https://gitlab.example.com/mr/15", state: "closed" }], 200),
  ];
  const fetchMock: typeof fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  try {
    await assert.rejects(
      () => new GitLabKnowledgePublisher(fetchMock).publish(candidate({ status: "publish_failed" }), repository()),
      /merge request !15.*is closed/,
    );
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitLab publisher rejects missing token and unsafe target paths", async () => {
  delete process.env.TEST_GITLAB_WRITE_TOKEN;
  const publisher = new GitLabKnowledgePublisher(async () => {
    throw new Error("network should not be called");
  });

  await assert.rejects(() => publisher.publish(candidate(), repository()), /Missing GitLab publishing token/);

  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  try {
    await assert.rejects(
      () => publisher.publish(candidate({ suggestedPath: "../secret.md" }), repository()),
      /suggestedPath is invalid/,
    );
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitLab publisher reconciles merge request state", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const fetchMock: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = String(input);
    if (/merge_requests\/12$/.test(url)) {
      return responseJson({
        state: "merged",
        merged_at: "2026-09-30T03:30:00.000Z",
        merge_commit_sha: "abc123",
        has_conflicts: false,
        detailed_merge_status: "merged",
        head_pipeline: { status: "success" },
      });
    }
    if (/repository\/branches\/skill-hub-knowledge-1234567890ab$/.test(url)) {
      return new Response("", { status: 404 });
    }
    throw new Error("unexpected URL: " + url);
  };
  try {
    const result = await new GitLabKnowledgePublisher(fetchMock).reconcile(
      {
        provider: "gitlab",
        projectPath: "ai/rd-skills",
        branch: "skill-hub-knowledge-1234567890ab",
        targetBranch: "master",
        filePath: "docs/ota/recovery-note.md",
        action: "create",
        mergeRequestIid: 12,
        mergeRequestUrl: "https://gitlab.example.com/ai/rd-skills/-/merge_requests/12",
        publishedAt: "2026-09-29T00:00:00.000Z",
        mergeRequestState: "opened",
        lastCheckedAt: "2026-09-29T00:00:00.000Z",
      },
      repository(),
    );
    assert.equal(result.mergeRequestState, "merged");
    assert.equal(result.mergedAt, "2026-09-30T03:30:00.000Z");
    assert.equal(result.mergeCommitSha, "abc123");
    assert.equal(result.pipelineStatus, "success");
    assert.equal(result.hasConflicts, false);
    assert.equal(result.detailedMergeStatus, "merged");
    assert.equal(result.sourceBranchExists, false);
    assert.ok(result.lastCheckedAt);
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitHub publisher pushes candidate content over SSH and creates a pull request", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const gitCalls: string[][] = [];
  const gitRun = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "ls-remote") return "";
    return "";
  };
  const fetchMock: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.github.com/repos/shh632058099/rd-knowledges/pulls");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.head, "skill-hub-knowledge-1234567890ab");
    assert.equal(body.base, "main");
    return responseJson(
      {
        number: 21,
        html_url: "https://github.com/shh632058099/rd-knowledges/pull/21",
        state: "open",
      },
      201,
    );
  };

  try {
    const result = await new GitHubKnowledgePublisher(fetchMock, gitRun).publish(candidate(), githubRepository());
    assert.equal(result.provider, "github");
    assert.equal(result.projectPath, "shh632058099/rd-knowledges");
    assert.equal(result.mergeRequestIid, 21);
    const clone = gitCalls.find((call) => call[0] === "clone");
    assert.ok(clone);
    assert.ok(clone.includes("git@github.com:shh632058099/rd-knowledges.git"));
    const push = gitCalls.find((call) => call[0] === "push");
    assert.ok(push);
    assert.ok(push.includes("HEAD:refs/heads/skill-hub-knowledge-1234567890ab"));
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("GitHub publisher recovers when PR creation returns 200 without PR details", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const calls: Array<{ url: string; method: string }> = [];
  const responses = [
    responseJson({}, 200),
    responseJson(
      [
        {
          number: 22,
          html_url: "https://github.com/shh632058099/rd-knowledges/pull/22",
          state: "open",
          merged_at: null,
        },
      ],
      200,
    ),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  const gitRun = async (args: string[]) => {
    if (args[0] === "ls-remote") return "";
    return "";
  };
  try {
    const result = await new GitHubKnowledgePublisher(fetchMock, gitRun).publish(candidate(), githubRepository());
    assert.equal(result.mergeRequestIid, 22);
    assert.equal(result.mergeRequestState, "opened");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[1]?.method, "GET");
    assert.match(calls[1]?.url ?? "", /state=all/);
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("GitHub publisher reopens an existing closed pull request when retrying a candidate", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const responses = [
    responseJson({ message: "A pull request already exists" }, 422),
    responseJson([
      {
        number: 2,
        html_url: "https://github.com/shh632058099/rd-knowledges/pull/2",
        state: "closed",
        merged_at: null,
      },
    ]),
    responseJson({
      number: 2,
      html_url: "https://github.com/shh632058099/rd-knowledges/pull/2",
      state: "open",
      merged_at: null,
    }),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  const gitRun = async (args: string[]) => {
    if (args[0] === "ls-remote") return "existing-branch";
    return "";
  };
  try {
    const result = await new GitHubKnowledgePublisher(fetchMock, gitRun).publish(
      candidate({ status: "publish_failed" }),
      githubRepository(),
    );
    assert.equal(result.mergeRequestIid, 2);
    assert.equal(result.mergeRequestState, "opened");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[1]?.method, "GET");
    assert.match(calls[1]?.url ?? "", /state=all/);
    assert.equal(calls[2]?.method, "PATCH");
    assert.equal(calls[2]?.url, "https://api.github.com/repos/shh632058099/rd-knowledges/pulls/2");
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), { state: "open" });
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("GitHub publisher publishes a Skill candidate to the skill repository", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const gitCalls: string[][] = [];
  const repo: RepositoryConfig = {
    ...githubRepository(),
    branch: "master",
    knowledgePublishing: {
      enabled: true,
      provider: "github",
      baseUrl: "https://github.com",
      projectPath: "shh632058099/rd-skills",
      tokenEnv: "TEST_GITHUB_TOKEN",
      targetBranch: "master",
      branchPrefix: "skill-hub-skill",
    },
  };
  const skill = candidate({
    suggestedType: "skill",
    skillCollection: "rd-skills",
    title: "OTA deployment helper",
    suggestedPath: "ota/deployment-helper/SKILL.md",
    content:
      "---\nschema_version: 1\nname: ota-deployment-helper\ndescription: deploy OTA\nmetadata:\n  audience: [developer]\n---\n\n# OTA deployment helper\n",
  });
  const fetchMock: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.github.com/repos/shh632058099/rd-skills/pulls");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.head, "skill-hub-skill-1234567890ab");
    assert.equal(body.base, "master");
    assert.equal(body.title, "Skill: OTA deployment helper");
    assert.match(body.body, /Collection: rd-skills/);
    return responseJson(
      { number: 22, html_url: "https://github.com/shh632058099/rd-skills/pull/22", state: "open" },
      201,
    );
  };
  const gitRun = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "ls-remote") return "";
    return "";
  };
  try {
    const result = await new GitHubKnowledgePublisher(fetchMock, gitRun).publish(skill, repo);
    assert.equal(result.projectPath, "shh632058099/rd-skills");
    assert.equal(result.filePath, "ota/deployment-helper/SKILL.md");
    assert.equal(result.branch, "skill-hub-skill-1234567890ab");
    assert.ok(gitCalls.find((call) => call[0] === "clone")?.includes("git@github.com:shh632058099/rd-skills.git"));
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("GitHub publisher reconciles pull request state", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const responses = [
    responseJson({
      state: "closed",
      merged_at: "2026-10-12T08:00:00.000Z",
      closed_at: "2026-10-12T08:00:00.000Z",
      merge_commit_sha: "def456",
      mergeable: true,
      mergeable_state: "clean",
    }),
    new Response("", { status: 404 }),
  ];
  const fetchMock: typeof fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  try {
    const result = await new GitHubKnowledgePublisher(fetchMock, async () => "").reconcile(
      {
        provider: "github",
        projectPath: "shh632058099/rd-knowledges",
        branch: "skill-hub-knowledge-1234567890ab",
        targetBranch: "main",
        filePath: "docs/ota/recovery-note.md",
        action: "create",
        mergeRequestIid: 21,
        mergeRequestUrl: "https://github.com/shh632058099/rd-knowledges/pull/21",
        publishedAt: "2026-10-12T07:00:00.000Z",
        mergeRequestState: "opened",
        lastCheckedAt: "2026-10-12T07:00:00.000Z",
      },
      githubRepository(),
    );
    assert.equal(result.mergeRequestState, "merged");
    assert.equal(result.mergeCommitSha, "def456");
    assert.equal(result.hasConflicts, false);
    assert.equal(result.sourceBranchExists, false);
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("publication target resolver preserves provider branch rules and serialized content", () => {
  const gitlab = resolveKnowledgePublishTarget(candidate(), repository());
  assert.deepEqual(gitlab, {
    filePath: "docs/ota/recovery-note.md",
    targetBranch: "master",
    desiredContent: "# OTA recovery note\n\nRecovery behavior learned during troubleshooting.\n",
  });

  const github = githubRepository();
  github.knowledgePublishing = { ...github.knowledgePublishing!, targetBranch: "" };
  assert.equal(resolveKnowledgePublishTarget(candidate(), github).targetBranch, "main");

  const gitlabFallback = repository();
  gitlabFallback.knowledgePublishing = { ...gitlabFallback.knowledgePublishing!, targetBranch: "" };
  assert.equal(resolveKnowledgePublishTarget(candidate(), gitlabFallback).targetBranch, "master");
});

test("GitLab target reader is read-only and decodes base64 content", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return responseJson({ content: Buffer.from("existing\n").toString("base64"), encoding: "base64" });
  };
  try {
    const repo = repository();
    const target = resolveKnowledgePublishTarget(candidate(), repo);
    const result = await new GitLabKnowledgePublisher(fetchMock).readTargetFile(target, repo);
    assert.deepEqual(result, { exists: true, content: "existing\n" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.match(calls[0]?.url ?? "", /repository\/files\/docs%2Fota%2Frecovery-note\.md\?ref=master$/);
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitHub target reader preserves nested path separators and maps 404 to missing", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(null, { status: 404 });
  };
  try {
    const repo = githubRepository();
    const target = resolveKnowledgePublishTarget(candidate(), repo);
    const result = await new GitHubKnowledgePublisher(fetchMock).readTargetFile(target, repo);
    assert.deepEqual(result, { exists: false, content: "" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
    assert.match(calls[0]?.url ?? "", /\/contents\/docs\/ota\/recovery-note\.md\?ref=main$/);
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("provider target readers do not expose raw provider response bodies", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const secret = "token=super-secret";
  try {
    const gitlabRepo = repository();
    const gitlabTarget = resolveKnowledgePublishTarget(candidate(), gitlabRepo);
    await assert.rejects(
      () =>
        new GitLabKnowledgePublisher(async () => new Response(secret, { status: 500 })).readTargetFile(
          gitlabTarget,
          gitlabRepo,
        ),
      (error: unknown) =>
        error instanceof Error &&
        /GitLab target file read failed \(500\)/.test(error.message) &&
        !error.message.includes(secret),
    );

    const githubRepo = githubRepository();
    const githubTarget = resolveKnowledgePublishTarget(candidate(), githubRepo);
    await assert.rejects(
      () =>
        new GitHubKnowledgePublisher(async () => new Response(secret, { status: 500 })).readTargetFile(
          githubTarget,
          githubRepo,
        ),
      (error: unknown) =>
        error instanceof Error &&
        /GitHub target file read failed \(500\)/.test(error.message) &&
        !error.message.includes(secret),
    );
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("GitLab publisher creates a deletion merge request for a merged publication", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 200 }),
    responseJson({ file_path: "docs/ota/recovery-note.md" }, 200),
    responseJson({ id: "commit-1" }, 200),
    responseJson({ iid: 31, web_url: "https://gitlab.example.com/mr/31", state: "opened" }, 201),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  try {
    const published = candidate({
      status: "published",
      publication: {
        provider: "gitlab",
        projectPath: "ai/rd-skills",
        branch: "skill-hub-knowledge-1234567890ab",
        targetBranch: "master",
        filePath: "docs/ota/recovery-note.md",
        action: "create",
        mergeRequestIid: 12,
        mergeRequestUrl: "https://gitlab.example.com/mr/12",
        publishedAt: "2026-09-29T00:00:00.000Z",
        mergeRequestState: "merged",
        lastCheckedAt: "2026-09-30T00:00:00.000Z",
        mergedAt: "2026-09-30T00:00:00.000Z",
      },
    });
    const result = await new GitLabKnowledgePublisher(fetchMock).deletePublished(
      published,
      published.publication!,
      repository(),
    );
    assert.equal(result.action, "delete");
    assert.equal(result.mergeRequestIid, 31);
    assert.match(result.branch, /delete/);
    assert.equal(calls[3]?.method, "DELETE");
    assert.equal(JSON.parse(calls[3]?.body ?? "{}").start_branch, "master");
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitHub publisher creates a deletion pull request for a merged publication", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const gitCalls: string[][] = [];
  const fetchMock: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, "POST");
    return responseJson(
      { number: 32, html_url: "https://github.com/shh632058099/rd-knowledges/pull/32", state: "open" },
      201,
    );
  };
  const gitRun = async (args: string[]) => {
    gitCalls.push(args);
    return args[0] === "ls-remote" ? "" : "";
  };
  try {
    const published = candidate({
      status: "published",
      publication: {
        provider: "github",
        projectPath: "shh632058099/rd-knowledges",
        branch: "skill-hub-knowledge-1234567890ab",
        targetBranch: "main",
        filePath: "docs/ota/recovery-note.md",
        action: "create",
        mergeRequestIid: 21,
        mergeRequestUrl: "https://github.com/shh632058099/rd-knowledges/pull/21",
        publishedAt: "2026-10-12T07:00:00.000Z",
        mergeRequestState: "merged",
        lastCheckedAt: "2026-10-12T08:00:00.000Z",
        mergedAt: "2026-10-12T08:00:00.000Z",
      },
    });
    const result = await new GitHubKnowledgePublisher(fetchMock, gitRun).deletePublished(
      published,
      published.publication!,
      githubRepository(),
    );
    assert.equal(result.action, "delete");
    assert.equal(result.mergeRequestIid, 32);
    assert.ok(gitCalls.some((call) => call[0] === "rm" && call.includes("docs/ota/recovery-note.md")));
    assert.ok(gitCalls.some((call) => call[0] === "push" && call.join(" ").includes("delete")));
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});

test("GitLab deletion retry reuses the existing deletion branch and open merge request", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const calls: Array<{ url: string; method: string }> = [];
  const responses = [
    responseJson({ name: "skill-hub-knowledge-delete-1234567890ab" }, 200),
    new Response(null, { status: 200 }),
    new Response(null, { status: 404 }),
    responseJson({ message: "merge request already exists" }, 409),
    responseJson([{ iid: 33, web_url: "https://gitlab.example.com/mr/33", state: "opened" }], 200),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  try {
    const published = candidate({
      status: "published",
      publication: {
        provider: "gitlab",
        projectPath: "ai/rd-skills",
        branch: "skill-hub-knowledge-1234567890ab",
        targetBranch: "master",
        filePath: "docs/ota/recovery-note.md",
        action: "create",
        mergeRequestIid: 12,
        mergeRequestUrl: "https://gitlab.example.com/mr/12",
        publishedAt: "2026-09-29T00:00:00.000Z",
        mergeRequestState: "merged",
        lastCheckedAt: "2026-09-30T00:00:00.000Z",
        mergedAt: "2026-09-30T00:00:00.000Z",
      },
    });
    const result = await new GitLabKnowledgePublisher(fetchMock).deletePublished(
      published,
      published.publication!,
      repository(),
    );
    assert.equal(result.mergeRequestIid, 33);
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
    assert.match(calls.at(-1)?.url ?? "", /source_branch=skill-hub-knowledge-delete-1234567890ab/);
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitHub deletion retry reuses an existing deletion branch and open pull request", async () => {
  process.env.TEST_GITHUB_TOKEN = "github-token";
  const calls: Array<{ url: string; method: string }> = [];
  const gitCalls: string[][] = [];
  const responses = [
    responseJson({ message: "A pull request already exists" }, 422),
    responseJson(
      [
        {
          number: 34,
          html_url: "https://github.com/shh632058099/rd-knowledges/pull/34",
          state: "open",
          merged_at: null,
        },
      ],
      200,
    ),
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  };
  const gitRun = async (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === "ls-remote") return "existing-branch";
    if (args[0] === "rm") throw new Error("pathspec did not match because deletion is already committed");
    return "";
  };
  try {
    const published = candidate({
      status: "published",
      publication: {
        provider: "github",
        projectPath: "shh632058099/rd-knowledges",
        branch: "skill-hub-knowledge-1234567890ab",
        targetBranch: "main",
        filePath: "docs/ota/recovery-note.md",
        action: "create",
        mergeRequestIid: 21,
        mergeRequestUrl: "https://github.com/shh632058099/rd-knowledges/pull/21",
        publishedAt: "2026-10-12T07:00:00.000Z",
        mergeRequestState: "merged",
        lastCheckedAt: "2026-10-12T08:00:00.000Z",
        mergedAt: "2026-10-12T08:00:00.000Z",
      },
    });
    const result = await new GitHubKnowledgePublisher(fetchMock, gitRun).deletePublished(
      published,
      published.publication!,
      githubRepository(),
    );
    assert.equal(result.mergeRequestIid, 34);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[1]?.method, "GET");
  } finally {
    delete process.env.TEST_GITHUB_TOKEN;
  }
});
