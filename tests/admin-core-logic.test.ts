import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { McpObservabilityStore } from "../src/observability.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import type { AppConfig, Principal } from "../src/types.js";

const principal: Principal = { id: "admin-core", tenantId: "rd", roles: ["developer", "internal"] };

async function createService(dataDir: string) {
  const search = new SqliteFtsSearchBackend();
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: [
      {
        id: "rd-skills",
        name: "R&D Skills",
        provider: "local",
        path: dataDir,
        gitAuth: { type: "none" },
        webhookAliases: [],
        enabled: false,
        audience: ["developer"],
        visibility: ["internal"],
        pollingIntervalSeconds: 0,
        readRoles: ["developer", "internal"],
        syncRoles: ["admin"]
      }
    ]
  };
  const service = new SkillHubApplicationService(
    config,
    [],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [],
    new LoggingEventSink()
  );
  await service.initialize();
  return service;
}

test("admin session aggregation keeps actor/tenant isolation and derives failure/evidence state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-session-"));
  try {
    const service = await createService(root);
    const other: Principal = { id: "other-user", tenantId: "other-tenant", roles: ["developer", "internal"] };

    await service.recordClientEvent(principal, {
      event: "SessionStart",
      sessionId: "shared-session",
      client: "codex",
      metadata: { project_context: { repositoryId: "rd-skills" }, runtime_version: "0.9.0", hook_schema_version: 1 }
    });
    await service.recordClientEvent(principal, {
      event: "PostToolUse",
      sessionId: "shared-session",
      turnId: "turn-1",
      client: "codex",
      metadata: { evidence: { success: true, tests_passed: 3 } }
    });
    await service.recordClientEvent(other, {
      event: "SessionStart",
      sessionId: "shared-session",
      client: "codex",
      metadata: {}
    });

    await service.recordMcpCall({
      traceId: service.newMcpTraceId(),
      traceExplicit: true,
      sessionId: "shared-session",
      client: "codex",
      tool: "discover",
      args: { query: "ota" },
      latencyMs: 2,
      success: true,
      principal
    });
    await service.recordMcpCall({
      traceId: service.newMcpTraceId(),
      traceExplicit: true,
      sessionId: "shared-session",
      client: "codex",
      tool: "write_candidate",
      args: {},
      latencyMs: 3,
      success: false,
      error: "failed",
      principal
    });
    await service.recordMcpCall({
      traceId: service.newMcpTraceId(),
      traceExplicit: true,
      sessionId: "shared-session",
      client: "codex",
      tool: "search_knowledge",
      args: { query: "other" },
      latencyMs: 1,
      success: true,
      principal: other
    });

    const sessions = await service.listClientSessions(100);
    assert.equal(sessions.filter((item) => item.sessionId === "shared-session").length, 2);
    const session = sessions.find((item) => item.sessionId === "shared-session" && item.actorId === principal.id);
    assert.ok(session);
    assert.equal(session.eventCount, 2);
    assert.equal(session.callCount, 2);
    assert.equal(session.failedCallCount, 1);
    assert.equal(session.evidenceCount, 1);
    assert.equal(session.repositoryId, "rd-skills");
    assert.deepEqual(new Set(session.tools), new Set(["discover", "write_candidate"]));
    assert.equal(session.ended, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admin session filters compose with AND semantics and reuse classification matches reuse tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-filters-"));
  try {
    const service = await createService(root);
    await service.recordClientEvent(principal, {
      event: "SessionStart",
      sessionId: "reuse-session",
      client: "codex",
      metadata: { project_context: { repositoryId: "rd-skills" } }
    });
    await service.recordClientEvent(principal, {
      event: "PostToolUse",
      sessionId: "reuse-session",
      client: "codex",
      metadata: { evidence: { success: true } }
    });
    await service.recordMcpCall({
      traceId: service.newMcpTraceId(),
      traceExplicit: true,
      sessionId: "reuse-session",
      client: "codex",
      tool: "discover",
      args: { query: "kernel" },
      latencyMs: 1,
      success: false,
      error: "temporary",
      principal
    });

    const combined = await service.listClientSessions(100, {
      actorId: principal.id,
      repositoryId: "rd-skills",
      event: "PostToolUse",
      status: "failed",
      hasMcp: true,
      hasEvidence: true,
      hasReuse: true,
      q: "reuse-session"
    });
    assert.deepEqual(combined.map((item) => item.sessionId), ["reuse-session"]);

    assert.equal((await service.listClientSessions(100, { hasReuse: false })).some((item) => item.sessionId === "reuse-session"), false);
    assert.equal((await service.listClientSessions(100, { repositoryId: "other" })).length, 0);
    assert.equal((await service.listClientSessions(100, { status: "ended" })).some((item) => item.sessionId === "reuse-session"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate lifecycle rejects review and edit while publishing or after publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-candidate-"));
  try {
    const store = new McpObservabilityStore(root);
    const candidate = await store.createCandidate(principal, {
      title: "Core lifecycle",
      content: "Verified reusable behavior",
      sourceType: "manual",
      suggestedType: "knowledge",
      repository: "rd-skills"
    });
    await store.reviewCandidate(candidate.id, "approved", "reviewer", "verified", "useful");
    await store.markCandidatePublishing(candidate.id);

    await assert.rejects(
      () => store.reviewCandidate(candidate.id, "rejected", "reviewer", "late rejection", "false_positive"),
      /cannot be reviewed/
    );
    await assert.rejects(() => store.updateCandidate(candidate.id, { title: "editing during publish" }), /cannot be edited/);

    await store.markCandidatePublished(candidate.id, {
      provider: "gitlab",
      projectPath: "ai/rd-skills",
      branch: "candidate-core",
      targetBranch: "master",
      filePath: "knowledge/core.md",
      action: "create",
      mergeRequestIid: 7,
      mergeRequestUrl: "https://gitlab.example.test/mr/7",
      publishedAt: new Date().toISOString()
    });
    await assert.rejects(
      () => store.reviewCandidate(candidate.id, "approved", "reviewer", "too late", "useful"),
      /cannot be reviewed/
    );
    await assert.rejects(() => store.updateCandidate(candidate.id, { content: "too late" }), /cannot be edited/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate publication terminal transitions require publishing state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-publication-state-"));
  try {
    const store = new McpObservabilityStore(root);
    const pending = await store.createCandidate(principal, {
      title: "Publication state guard",
      content: "Verified reusable behavior",
      sourceType: "manual",
      suggestedType: "knowledge",
      repository: "rd-skills"
    });
    const publication = {
      provider: "gitlab" as const,
      projectPath: "ai/rd-skills",
      branch: "candidate-state",
      targetBranch: "master",
      filePath: "knowledge/state.md",
      action: "create" as const,
      mergeRequestIid: 9,
      mergeRequestUrl: "https://gitlab.example.test/mr/9",
      publishedAt: new Date().toISOString()
    };

    await assert.rejects(() => store.markCandidatePublished(pending.id, publication), /must be publishing/);
    await assert.rejects(() => store.markCandidatePublishFailed(pending.id, "network"), /must be publishing/);
    await store.reviewCandidate(pending.id, "approved", "reviewer", "verified", "useful");
    await assert.rejects(() => store.markCandidatePublished(pending.id, publication), /must be publishing/);
    await store.markCandidatePublishing(pending.id);
    const failed = await store.markCandidatePublishFailed(pending.id, "network");
    assert.equal(failed.status, "publish_failed");
    await store.markCandidatePublishing(pending.id);
    const published = await store.markCandidatePublished(pending.id, publication);
    assert.equal(published.status, "published");
    await assert.rejects(() => store.markCandidatePublishFailed(pending.id, "late"), /must be publishing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate review reasons are constrained by review outcome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-review-reason-"));
  try {
    const store = new McpObservabilityStore(root);
    const approved = await store.createCandidate(principal, {
      title: "Approved reason guard",
      content: "Verified reusable behavior",
      sourceType: "manual",
      suggestedType: "knowledge"
    });
    await assert.rejects(
      () => store.reviewCandidate(approved.id, "approved", "reviewer", "wrong reason", "false_positive"),
      /review reason is not valid/
    );
    assert.equal((await store.reviewCandidate(approved.id, "approved", "reviewer", "valid", "useful")).reviewReason, "useful");

    const rejected = await store.createCandidate(principal, {
      title: "Rejected reason guard",
      content: "Another reusable behavior",
      sourceType: "manual",
      suggestedType: "knowledge"
    });
    await assert.rejects(
      () => store.reviewCandidate(rejected.id, "rejected", "reviewer", "wrong reason", "needs_edit"),
      /review reason is not valid/
    );
    assert.equal((await store.reviewCandidate(rejected.id, "rejected", "reviewer", "valid", "duplicate")).reviewReason, "duplicate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication state can be updated while waiting for merge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-reconcile-state-"));
  try {
    const store = new McpObservabilityStore(root);
    const candidate = await store.createCandidate(principal, {
      title: "Reconcile state guard",
      content: "Verified reusable behavior",
      sourceType: "manual",
      suggestedType: "knowledge"
    });
    const publication = {
      provider: "gitlab" as const,
      projectPath: "ai/rd-skills",
      branch: "candidate-reconcile",
      targetBranch: "master",
      filePath: "knowledge/reconcile.md",
      action: "create" as const,
      mergeRequestIid: 11,
      mergeRequestUrl: "https://gitlab.example.test/mr/11",
      publishedAt: new Date().toISOString()
    };
    await assert.rejects(
      () => store.updateCandidatePublication(candidate.id, { ...publication, mergeRequestState: "merged" }),
      /must be publishing or published/
    );
    await store.reviewCandidate(candidate.id, "approved", "reviewer", "verified", "useful");
    await store.markCandidatePublishing(candidate.id);
    const waiting = await store.updateCandidatePublication(candidate.id, { ...publication, mergeRequestState: "opened" });
    assert.equal(waiting.status, "publishing");
    assert.equal(waiting.publication?.mergeRequestState, "opened");
    const published = await store.markCandidatePublished(candidate.id, { ...publication, mergeRequestState: "merged" });
    assert.equal(published.status, "published");
    const refreshed = await store.updateCandidatePublication(candidate.id, { ...publication, mergeRequestState: "merged", pipelineStatus: "success" });
    assert.equal(refreshed.publication?.pipelineStatus, "success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session time filters use inclusive overlap boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-time-filter-"));
  try {
    const service = await createService(root);
    await service.recordClientEvent(principal, { event: "SessionStart", sessionId: "time-session", client: "codex", metadata: {} });
    await service.recordMcpCall({ traceId: service.newMcpTraceId(), traceExplicit: true, sessionId: "time-session", client: "codex", tool: "search_knowledge", args: { query: "time" }, latencyMs: 1, success: true, principal });
    await service.recordClientEvent(principal, { event: "SessionEnd", sessionId: "time-session", client: "codex", metadata: {} });
    const session = (await service.listClientSessions()).find((item) => item.sessionId === "time-session");
    assert.ok(session);
    assert.equal((await service.listClientSessions(100, { from: session.endedAt })).some((item) => item.sessionId === "time-session"), true);
    assert.equal((await service.listClientSessions(100, { to: session.startedAt })).some((item) => item.sessionId === "time-session"), true);
    assert.equal((await service.listClientSessions(100, { from: new Date(Date.parse(session.endedAt) + 1).toISOString() })).some((item) => item.sessionId === "time-session"), false);
    assert.equal((await service.listClientSessions(100, { to: new Date(Date.parse(session.startedAt) - 1).toISOString() })).some((item) => item.sessionId === "time-session"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session list identity maps exactly to detail timeline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-session-detail-"));
  try {
    const service = await createService(root);
    const other: Principal = { id: "other-user", tenantId: "other-tenant", roles: ["developer", "internal"] };
    for (const [who, tool] of [[principal, "search_knowledge"], [other, "get_skill"]] as const) {
      await service.recordClientEvent(who, { event: "SessionStart", sessionId: "duplicate-id", client: "codex", metadata: {} });
      await service.recordMcpCall({
        traceId: service.newMcpTraceId(),
        traceExplicit: true,
        sessionId: "duplicate-id",
        client: "codex",
        tool,
        args: {},
        latencyMs: 1,
        success: true,
        principal: who
      });
    }
    const rows = (await service.listClientSessions()).filter((item) => item.sessionId === "duplicate-id");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const detail = await service.getClientSessionDetail(row.actorId, row.tenantId, row.sessionId);
      assert.equal(detail.actorId, row.actorId);
      assert.equal(detail.tenantId, row.tenantId);
      assert.equal(detail.timeline.length, row.eventCount + row.callCount);
      for (const item of detail.timeline) {
        const record = item.kind === "event" ? item.event : item.call;
        assert.equal(record.actorId, row.actorId);
        assert.equal(record.tenantId, row.tenantId);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge gap management clears terminal timestamps when reopened and preserves links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-gap-"));
  try {
    const store = new McpObservabilityStore(root);
    const [gap] = await store.knowledgeGaps([{ query: "OTA rollback recovery", count: 2 }]);
    assert.ok(gap);

    const ignored = await store.updateKnowledgeGapManagement(gap.key, { status: "ignored", candidateId: "kc-1" });
    assert.ok(ignored.ignoredAt);
    const reopened = await store.updateKnowledgeGapManagement(gap.key, { status: "active" });
    assert.equal(reopened.ignoredAt, undefined);
    assert.equal(reopened.resolvedAt, undefined);
    assert.equal(reopened.candidateId, "kc-1");

    const resolved = await store.updateKnowledgeGapManagement(gap.key, {
      status: "resolved",
      knowledge: { key: "rd:ota", repositoryId: "rd-skills", path: "knowledge/ota.md", title: "OTA" },
      commit: { repositoryId: "rd-skills", sha: "abc123" }
    });
    assert.ok(resolved.resolvedAt);
    const reopenedAgain = await store.updateKnowledgeGapManagement(gap.key, { status: "active" });
    assert.equal(reopenedAgain.resolvedAt, undefined);
    assert.equal(reopenedAgain.knowledge?.path, "knowledge/ota.md");
    assert.equal(reopenedAgain.commit?.sha, "abc123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("knowledge gap candidate creation is single-shot and terminal states reject creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-core-gap-candidate-"));
  try {
    const service = await createService(root);
    const gap = {
      key: "gap-core",
      query: "How should OTA rollback recover?",
      occurrences: 3,
      lastSeenAt: new Date().toISOString(),
      source: "unmatched-query" as const,
      members: ["How should OTA rollback recover?"]
    };
    (service as any).listKnowledgeGaps = async () => [
      { ...gap, management: (await (service as any).observability.listKnowledgeGapManagement()).get(gap.key) }
    ];

    const created = await service.createKnowledgeCandidateFromGap(gap.key, principal);
    assert.equal(created.sourceGapKey, gap.key);
    assert.equal(created.status, "pending");
    await assert.rejects(
      () => service.createKnowledgeCandidateFromGap(gap.key, principal),
      /already has a Candidate/
    );

    await (service as any).observability.updateKnowledgeGapManagement(gap.key, { status: "ignored", candidateId: undefined });
    await assert.rejects(() => service.createKnowledgeCandidateFromGap(gap.key, principal), /Ignored Knowledge gap/);
    await (service as any).observability.updateKnowledgeGapManagement(gap.key, { status: "resolved" });
    await assert.rejects(() => service.createKnowledgeCandidateFromGap(gap.key, principal), /Resolved Knowledge gap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
