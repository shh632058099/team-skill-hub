import assert from "node:assert/strict";
import test from "node:test";
import { GitLabKnowledgePublisher } from "../src/knowledge-publishing.js";
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
      branchPrefix: "skill-hub-knowledge"
    }
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
    ...overrides
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("GitLab publisher creates a new file branch and merge request", async () => {
  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 404 }),
    responseJson({ file_path: "docs/ota/recovery-note.md", branch: "skill-hub-knowledge-1234567890ab" }, 201),
    responseJson({ iid: 12, web_url: "https://gitlab.example.com/ai/rd-skills/-/merge_requests/12" }, 201)
  ];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined
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
    responseJson({ iid: 13, web_url: "https://gitlab.example.com/mr/13" }, 201)
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
    responseJson([{ iid: 14, web_url: "https://gitlab.example.com/mr/14" }], 200)
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
      repository()
    );
    assert.equal(result.mergeRequestIid, 14);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "HEAD", "GET", "POST", "GET"]);
    assert.match(calls[4]?.url ?? "", /source_branch=skill-hub-knowledge-1234567890ab/);
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});

test("GitLab publisher rejects missing token and unsafe target paths", async () => {
  delete process.env.TEST_GITLAB_WRITE_TOKEN;
  const publisher = new GitLabKnowledgePublisher(async () => {
    throw new Error("network should not be called");
  });

  await assert.rejects(
    () => publisher.publish(candidate(), repository()),
    /Missing GitLab publishing token/
  );

  process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
  try {
    await assert.rejects(
      () => publisher.publish(candidate({ suggestedPath: "../secret.md" }), repository()),
      /suggestedPath is invalid/
    );
  } finally {
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
  }
});
