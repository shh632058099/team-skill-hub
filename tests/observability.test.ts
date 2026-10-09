import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
        query: "contact user@example.com Bearer super-secret-token eyJabcde.abcdefgh.ijklmnop https://user:pass@example.com postgres://dbuser:dbpass@db.example.com/app AKIAABCDEFGHIJKLMNOP",
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
    assert.doesNotMatch(persisted, /super-secret-token|eyJabcde|user:pass|dbuser:dbpass|AKIAABCDEFGHIJKLMNOP/);
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

test("observability recovers corrupted lines and rotates oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-observability-rotation-"));
  try {
    const store = new McpObservabilityStore(root, 100, { retentionDays: 30, maxFileBytes: 1024 });
    for (let index = 0; index < 20; index += 1) {
      await store.recordCall({
        traceId: "trace-" + index,
        actorId: principal.id,
        tenantId: principal.tenantId,
        tool: "search_knowledge",
        args: { query: "rotation payload " + index + " " + "x".repeat(160) },
        latencyMs: index,
        success: true
      });
    }
    const dir = path.join(root, "observability");
    const archives = (await readdir(dir)).filter((name) => name.startsWith("mcp-calls.jsonl.archive."));
    assert.ok(archives.length >= 1);
    assert.equal((await readdir(dir)).some((name) => name.includes(".tmp.")), false);

    await appendFile(
      path.join(dir, "mcp-calls.jsonl"),
      '{broken-json\nnull\n{}\n{"id":"legacy","ts":"2026-01-01T00:00:00.000Z","tool":"legacy"}\n',
      "utf8"
    );
    const calls = await store.listCalls(100);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((item) => item.tool === "search_knowledge"));
    const summary = await store.summary();
    assert.equal(summary.total, calls.length);
    assert.doesNotThrow(() => JSON.stringify(summary));
    assert.ok((await store.listTraces()).length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client hook events persist only sanitized metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-client-events-"));
  try {
    const store = new McpObservabilityStore(root);
    const event = await store.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "PostToolUse",
      sessionId: "session-42",
      turnId: "turn-7",
      cwd: "/work/project",
      model: "gpt-test",
      permissionMode: "default",
      metadata: {
        tool_name: "Bash",
        apiKey: "skh_should_be_redacted"
      }
    });
    assert.equal(event.event, "PostToolUse");
    const listed = await store.listClientEvents();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.sessionId, "session-42");
    assert.equal(listed[0]?.metadata.apiKey, "[redacted]");
    const persisted = await readFile(path.join(root, "observability", "client-events.jsonl"), "utf8");
    assert.doesNotMatch(persisted, /skh_should_be_redacted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client event duplicate lookup uses stable lifecycle natural keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-client-event-dedupe-"));
  try {
    const store = new McpObservabilityStore(root);
    const first = await store.recordClientEvent(principal, {
      event: "PostToolUse",
      sessionId: "session-dedupe",
      turnId: "turn-1",
      metadata: { tool_use_id: "tool-1", tool_name: "Bash" }
    });
    const duplicate = await store.findDuplicateClientEvent(principal, {
      event: "PostToolUse",
      sessionId: "session-dedupe",
      turnId: "turn-1",
      metadata: { tool_use_id: "tool-1" }
    });
    const differentTool = await store.findDuplicateClientEvent(principal, {
      event: "PostToolUse",
      sessionId: "session-dedupe",
      turnId: "turn-1",
      metadata: { tool_use_id: "tool-2" }
    });
    assert.equal(duplicate?.id, first.id);
    assert.equal(differentTool, undefined);

    const stop = await store.recordClientEvent(principal, {
      event: "Stop",
      sessionId: "session-dedupe",
      turnId: "turn-1",
      metadata: {}
    });
    const duplicateStop = await store.findDuplicateClientEvent(principal, {
      event: "Stop",
      sessionId: "session-dedupe",
      turnId: "turn-1",
      metadata: {}
    });
    assert.equal(duplicateStop?.id, stop.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client session timeline sorts persisted events by timestamp", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-client-event-order-"));
  try {
    const store = new McpObservabilityStore(root);
    await store.recordClientEvent(principal, {
      event: "SessionStart",
      sessionId: "session-order",
      metadata: {}
    });
    const file = path.join(root, "observability", "client-events.jsonl");
    const rows = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const base = rows[0];
    await rm(file);
    await appendFile(file, JSON.stringify({ ...base, id: "evt_late", event: "SessionEnd", ts: "2026-09-30T10:00:03.000Z" }) + "\n");
    await appendFile(file, JSON.stringify({ ...base, id: "evt_early", event: "SessionStart", ts: "2026-09-30T10:00:01.000Z" }) + "\n");
    await appendFile(file, JSON.stringify({ ...base, id: "evt_middle", event: "UserPromptSubmit", ts: "2026-09-30T10:00:02.000Z" }) + "\n");
    const timeline = await store.getClientSessionTimeline(principal.id, principal.tenantId, "session-order");
    assert.deepEqual(
      timeline.map((item) => item.kind === "event" ? item.event.id : item.call.id),
      ["evt_early", "evt_middle", "evt_late"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop assistant excerpt keeps a larger bounded payload with server-side redaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-stop-excerpt-"));
  try {
    const store = new McpObservabilityStore(root);
    const longText = ("Verified OTA recovery behavior with regression coverage. ".repeat(30)) +
      " token=SUPER_SECRET_TOKEN_VALUE";
    const event = await store.recordClientEvent(principal, {
      event: "Stop",
      sessionId: "session-stop",
      turnId: "turn-stop",
      client: "codex",
      metadata: { assistant_result_excerpt: longText }
    });
    const excerpt = String(event.metadata.assistant_result_excerpt ?? "");
    assert.ok(excerpt.length > 500);
    assert.ok(excerpt.length <= 4000);
    assert.doesNotMatch(excerpt, /SUPER_SECRET_TOKEN_VALUE/);
    assert.match(excerpt, /\[redacted\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client sessions resolve only when a principal has one active session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-link-"));
  try {
    const store = new McpObservabilityStore(root);
    await store.recordClientEvent(principal, {
      event: "SessionStart",
      sessionId: "session-a",
      client: "codex",
      metadata: { source: "startup" }
    });
    assert.equal(await store.resolveUniqueActiveClientSession(principal), "session-a");

    const traceA = store.traceIdForSession(principal, "session-a");
    assert.equal(traceA, store.traceIdForSession(principal, "session-a"));
    assert.match(traceA, /^sess_[a-f0-9]{24}$/);

    await store.recordClientEvent(principal, {
      event: "SessionStart",
      sessionId: "session-b",
      client: "codex",
      metadata: { source: "startup" }
    });
    assert.equal(await store.resolveUniqueActiveClientSession(principal), undefined);

    await store.recordClientEvent(principal, {
      event: "SessionEnd",
      sessionId: "session-b",
      client: "codex",
      metadata: { reason: "other" }
    });
    assert.equal(await store.resolveUniqueActiveClientSession(principal), "session-a");

    await store.recordCall({
      traceId: traceA,
      sessionId: "session-a",
      actorId: principal.id,
      tenantId: principal.tenantId,
      client: "codex",
      tool: "search_knowledge",
      args: { query: "OTA checkpoint" },
      latencyMs: 5,
      success: true
    });
    const sessions = await store.listClientSessions();
    const session = sessions.find((item) => item.sessionId === "session-a");
    assert.equal(session?.callCount, 1);
    assert.equal(session?.eventCount, 1);
    assert.deepEqual(session?.tools, ["search_knowledge"]);

    const timeline = await store.getClientSessionTimeline(principal.id, principal.tenantId, "session-a");
    assert.deepEqual(timeline.map((item) => item.kind), ["event", "mcp-call"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge candidates mark exact duplicates without dropping submissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-duplicate-"));
  try {
    const store = new McpObservabilityStore(root);
    const first = await store.createCandidate(principal, {
      title: "OTA Recovery",
      content: "Verified recovery checkpoint behavior.",
      sourceType: "mcp-session",
      suggestedType: "knowledge",
      repository: "rd-skills",
      suggestedPath: "docs/ota/recovery.md"
    });
    const second = await store.createCandidate(principal, {
      title: "  ota recovery ",
      content: "Verified   recovery checkpoint behavior.",
      sourceType: "mcp-session",
      suggestedType: "knowledge",
      repository: "rd-skills",
      suggestedPath: "docs/ota/recovery-2.md"
    });
    assert.equal(second.duplicateOf, first.id);
    assert.equal(second.fingerprint, first.fingerprint);

    const edited = await store.updateCandidate(second.id, {
      content: "A materially different recovery rule."
    });
    assert.equal(edited.duplicateOf, undefined);
    assert.notEqual(edited.fingerprint, first.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge candidates surface deterministic near duplicates separately from exact duplicates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-near-duplicate-"));
  try {
    const store = new McpObservabilityStore(root);
    const first = await store.createCandidate(principal, {
      title: "OTA power loss recovery",
      content: "Device resumes from the last verified checkpoint after reboot and validates image integrity before boot.",
      sourceType: "codex-summary",
      suggestedType: "knowledge",
      repository: "rd-skills"
    });
    const second = await store.createCandidate(principal, {
      title: "OTA recovery after power loss",
      content: "After reboot the device resumes from the last verified checkpoint and validates image integrity before continuing boot.",
      sourceType: "manual",
      suggestedType: "knowledge",
      repository: "rd-skills"
    });
    assert.equal(second.duplicateOf, undefined);
    assert.equal(second.possibleDuplicateOf, first.id);
    assert.ok((second.duplicateSimilarity ?? 0) >= 0.78);

    const unrelated = await store.createCandidate(principal, {
      title: "Yocto CVE triage policy",
      content: "Security advisories are reviewed by release age and remediation ownership before each quarterly release.",
      sourceType: "manual",
      suggestedType: "knowledge",
      repository: "rd-skills"
    });
    assert.equal(unrelated.possibleDuplicateOf, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact candidate duplicate lookup ignores rejected items", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-lookup-"));
  try {
    const store = new McpObservabilityStore(root);
    const first = await store.createCandidate(principal, {
      title: "Verified OTA behavior",
      content: "The device resumes from the last safe checkpoint after reboot.",
      sourceType: "codex-summary",
      suggestedType: "knowledge"
    });
    assert.equal(
      (await store.findExactCandidateDuplicate(first.title, first.content))?.id,
      first.id
    );
    await store.reviewCandidate(first.id, "rejected", "admin-http", "not durable");
    assert.equal(
      await store.findExactCandidateDuplicate(first.title, first.content),
      undefined
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge candidate preserves explicit Knowledge relation metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-candidate-relation-"));
  try {
    const store = new McpObservabilityStore(root);
    const candidate = await store.createCandidate(principal, {
      title: "Updated OTA recovery behavior",
      content: "Recovery now resumes from the verified checkpoint.",
      sourceType: "review",
      suggestedType: "knowledge",
      repository: "rd-skills"
    });
    const updated = await store.updateCandidate(candidate.id, {
      knowledgeRelation: {
        type: "updates",
        target: {
          key: "rd-skills:docs/ota/recovery.md",
          repositoryId: "rd-skills",
          path: "docs/ota/recovery.md",
          title: "OTA Recovery"
        }
      }
    });
    assert.equal(updated.knowledgeRelation?.type, "updates");
    assert.equal(updated.knowledgeRelation?.target?.path, "docs/ota/recovery.md");
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
      "Verified against current implementation",
      "useful"
    );
    assert.equal(reviewed.status, "approved");
    assert.equal(reviewed.reviewer, "admin-http");
    assert.equal(reviewed.reviewReason, "useful");

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
      { query: "Yocto CVE six month policy", count: 4 },
      { query: "Yocto CVE 180 day rule", count: 2 }
    ]);
    const cveGap = gaps.find((item) => item.members?.some((member) => member.includes("CVE")));
    assert.ok(cveGap);
    assert.equal(cveGap?.occurrences, 6);
    assert.equal(cveGap?.members?.length, 2);
    assert.ok(gaps.some((item) => item.query === "OTA rollback document is outdated"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
