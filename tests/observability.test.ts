import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../src/observability.js";

const principal = { id: "dev-a", tenantId: "rd", roles: ["developer", "internal"] };

test("MCP observability redacts secrets and summarizes calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-observability-"));
  try {
    const store = new McpObservabilityStore(root);
    await store.recordCall({
      traceId: "trace-1",
      sessionId: "session-1",
      actorId: principal.id,
      tenantId: principal.tenantId,
      client: "codex",
      tool: "search_knowledge",
      args: {
        query: "contact user@example.com",
        apiKey: "skh_this_should_never_be_persisted"
      },
      latencyMs: 12,
      success: true
    });
    await store.recordCall({
      traceId: "trace-1",
      actorId: principal.id,
      tenantId: principal.tenantId,
      tool: "get_knowledge",
      args: {},
      latencyMs: 8,
      success: false,
      error: "not found"
    });

    const persisted = await readFile(path.join(root, "observability", "mcp-calls.jsonl"), "utf8");
    assert.doesNotMatch(persisted, /skh_this_should_never_be_persisted/);
    assert.doesNotMatch(persisted, /user@example\.com/);
    assert.match(persisted, /\[redacted-token\]|\[redacted\]/);

    const summary = await store.summary();
    assert.equal(summary.total, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.byTool.search_knowledge, 1);

    const traces = await store.listTraces();
    assert.equal(traces.length, 1);
    assert.equal(traces[0]?.traceId, "trace-1");
    assert.deepEqual(traces[0]?.tools, ["search_knowledge", "get_knowledge"]);
    assert.equal((await store.getTrace("trace-1")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge candidate review is append-only and preserves latest state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-"));
  try {
    const store = new McpObservabilityStore(root);
    const candidate = await store.createCandidate(principal, {
      traceId: "trace-2",
      title: "OTA recovery note",
      content: "New recovery behavior learned during troubleshooting.",
      sourceType: "troubleshooting",
      suggestedType: "knowledge",
      repository: "rd-skills",
      suggestedPath: "docs/ota/recovery.md"
    });
    assert.equal(candidate.status, "pending");

    const reviewed = await store.reviewCandidate(
      candidate.id,
      "approved",
      "admin-http",
      "Verified against current implementation"
    );
    assert.equal(reviewed.status, "approved");
    assert.equal(reviewed.reviewer, "admin-http");

    const listed = await store.listCandidates();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.status, "approved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge candidate supports edit review publish failure and retry lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-lifecycle-"));
  try {
    const store = new McpObservabilityStore(root);
    const created = await store.createCandidate(principal, {
      title: "Draft",
      content: "Initial content",
      sourceType: "manual",
      suggestedType: "knowledge",
      repository: "rd-skills",
      suggestedPath: "docs/draft.md"
    });

    const edited = await store.updateCandidate(created.id, {
      title: "Reviewed title",
      content: "Reviewed content",
      suggestedPath: "docs/reviewed.md"
    });
    assert.equal(edited.status, "pending");
    assert.equal(edited.title, "Reviewed title");

    const approved = await store.reviewCandidate(created.id, "approved", "admin-http", "looks good");
    assert.equal(approved.status, "approved");

    const publishing = await store.markCandidatePublishing(created.id);
    assert.equal(publishing.status, "publishing");

    const failed = await store.markCandidatePublishFailed(created.id, "token=secret-value network failed");
    assert.equal(failed.status, "publish_failed");
    assert.doesNotMatch(failed.publishError ?? "", /secret-value/);

    const retryReady = await store.updateCandidate(created.id, { content: "Reviewed content v2" });
    assert.equal(retryReady.status, "approved");

    await store.markCandidatePublishing(created.id);
    const published = await store.markCandidatePublished(created.id, {
      provider: "gitlab",
      projectPath: "ai/rd-skills",
      branch: "skill-hub-knowledge-abc",
      targetBranch: "master",
      filePath: "docs/reviewed.md",
      action: "create",
      mergeRequestIid: 42,
      mergeRequestUrl: "https://gitlab.example.com/ai/rd-skills/-/merge_requests/42",
      publishedAt: new Date().toISOString()
    });
    assert.equal(published.status, "published");
    assert.equal(published.publication?.mergeRequestIid, 42);
    await assert.rejects(
      () => store.updateCandidate(created.id, { title: "too late" }),
      /cannot be edited/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge gaps combine unmatched queries and negative feedback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-gaps-"));
  try {
    const store = new McpObservabilityStore(root);
    await store.submitFeedback(principal, {
      targetType: "knowledge",
      target: "rd-skills:docs/old.md#0",
      rating: "negative",
      reason: "OTA rollback document is outdated"
    });

    const gaps = await store.knowledgeGaps([
      { query: "Yocto CVE six month policy", count: 4 }
    ]);
    assert.ok(gaps.some((item) => item.query === "Yocto CVE six month policy" && item.occurrences === 4));
    assert.ok(gaps.some((item) => item.query === "OTA rollback document is outdated"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
