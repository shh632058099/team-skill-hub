import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { McpWorkAdapter } from "../src/expert-platform/mcp-work-adapter.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-work-adapter-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
  experts.putDeployment({
    id: "ota-default",
    expertId: "ota",
    repositoryIds: ["ota-repo"],
    repositories: [],
    principals: ["alice"],
    runtimeProfile: "codex-readonly",
    active: true,
  });
  const orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
  const adapter = new McpWorkAdapter(work, orchestrator);
  return {
    dir,
    experts,
    tasks,
    work,
    orchestrator,
    adapter,
    close() {
      work.close();
      tasks.close();
      experts.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const context = {
  principalId: "alice",
  scope: "team-a",
  client: "claude-code",
  sessionId: "sess-1",
  trustedSession: true,
} as const;

function input(idempotencyKey: string) {
  return {
    title: "Inspect OTA",
    description: "read-only",
    idempotencyKey,
    expertId: "ota",
    deploymentId: "ota-default",
    repositoryId: "ota-repo",
  };
}

test("MCP adapter uses session scope plus idempotency key as stable source identity", () => {
  const f = fixture();
  try {
    const first = f.adapter.submit(input("work-a"), context, 1000);
    const retry = f.adapter.submit(input("work-a"), context, 1100);
    const second = f.adapter.submit(input("work-b"), context, 1200);
    assert.equal(first.work.workItemId, retry.work.workItemId);
    assert.notEqual(first.work.workItemId, second.work.workItemId);
    assert.equal(first.work.sourceType, "mcp");
    assert.equal(first.work.sourceScope, "claude-code/sess-1");
    assert.equal(first.work.sourceRef, "work-a");
    assert.match(first.sourceControlToken, /^wsc_[A-Za-z0-9_-]{40,}$/);
    assert.match(retry.sourceControlToken, /^wsc_[A-Za-z0-9_-]{40,}$/);
    assert.notEqual(retry.sourceControlToken, first.sourceControlToken, "retry rotates the source control capability");
    assert.equal(f.work.listSourceObservations(first.work.workItemId).length, 1);
  } finally {
    f.close();
  }
});

test("MCP terminal source signal cancels a post-cutover Dynamic DAG Work before execution starts", () => {
  const f = fixture();
  try {
    const detail = f.adapter.submit(input("work-terminal"), context, 1000);
    assert.equal(detail.work.orchestrationEngine, "dynamic-dag");
    assert.equal(detail.work.status, "queued");
    assert.equal(detail.currentTask, null);
    const cancelled = f.adapter.updateSource(
      detail.work.workItemId,
      { state: "terminal", detail: "user closed source", sourceControlToken: detail.sourceControlToken },
      context,
      2000,
    );
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(cancelled.currentTask, null);
    const obs = f.work.listSourceObservations(detail.work.workItemId).at(-1)!;
    assert.equal(obs.state, "terminal");
    assert.equal(obs.reconciliationAction, "cancel");
  } finally {
    f.close();
  }
});

test("MCP source control token authorizes an unbound client and rejects an invalid token", () => {
  const f = fixture();
  try {
    const unbound = { ...context, sessionId: undefined, trustedSession: false };
    const detail = f.adapter.submit(input("work-untrusted"), unbound, 1000);
    assert.throws(
      () =>
        f.adapter.updateSource(
          detail.work.workItemId,
          { state: "terminal", sourceControlToken: "wsc_invalid" },
          unbound,
          1500,
        ),
      /MCP_SOURCE_CONTROL_DENIED/,
    );
    const cancelled = f.adapter.updateSource(
      detail.work.workItemId,
      { state: "terminal", sourceControlToken: detail.sourceControlToken },
      unbound,
      2000,
    );
    assert.equal(cancelled.work.status, "cancelled");
  } finally {
    f.close();
  }
});

test("idempotent MCP submit retries keep a bounded set of source control capabilities valid", () => {
  const f = fixture();
  try {
    const unbound = { ...context, sessionId: undefined, trustedSession: false };
    const first = f.adapter.submit(input("work-retry-capability"), unbound, 1000);
    const retry = f.adapter.submit(input("work-retry-capability"), unbound, 1100);
    assert.notEqual(first.sourceControlToken, retry.sourceControlToken);
    const active = f.adapter.updateSource(
      first.work.workItemId,
      { state: "active", detail: "first retry response still usable", sourceControlToken: first.sourceControlToken },
      unbound,
      1200,
    );
    assert.equal(active.work.status, "queued");
    const cancelled = f.adapter.updateSource(
      retry.work.workItemId,
      { state: "terminal", sourceControlToken: retry.sourceControlToken },
      unbound,
      1300,
    );
    assert.equal(cancelled.work.status, "cancelled");
  } finally {
    f.close();
  }
});

test("expired MCP source control capability is rejected while a refreshed capability remains valid", () => {
  const f = fixture();
  try {
    const unbound = { ...context, sessionId: undefined, trustedSession: false };
    const first = f.adapter.submit(input("work-expiring-capability"), unbound, 1000);
    const refreshed = f.adapter.submit(input("work-expiring-capability"), unbound, 1000 + 30 * 24 * 60 * 60 * 1000);
    assert.throws(
      () =>
        f.adapter.updateSource(
          first.work.workItemId,
          { state: "terminal", sourceControlToken: first.sourceControlToken },
          unbound,
          1001 + 30 * 24 * 60 * 60 * 1000,
        ),
      /MCP_SOURCE_CONTROL_DENIED/,
    );
    const cancelled = f.adapter.updateSource(
      refreshed.work.workItemId,
      { state: "terminal", sourceControlToken: refreshed.sourceControlToken },
      unbound,
      1001 + 30 * 24 * 60 * 60 * 1000,
    );
    assert.equal(cancelled.work.status, "cancelled");
  } finally {
    f.close();
  }
});

test("MCP source signal is session-bound even for the same principal", () => {
  const f = fixture();
  try {
    const detail = f.adapter.submit(input("work-session-bound"), context, 1000);
    assert.throws(
      () =>
        f.adapter.updateSource(
          detail.work.workItemId,
          { state: "terminal", sourceControlToken: detail.sourceControlToken },
          { ...context, sessionId: "sess-2" },
          2000,
        ),
      /MCP_SOURCE_SCOPE_MISMATCH/,
    );
    assert.equal(f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a").work.status, "queued");
  } finally {
    f.close();
  }
});
