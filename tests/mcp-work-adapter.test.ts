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

const context = { principalId: "alice", scope: "team-a", client: "claude-code", sessionId: "sess-1" } as const;

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
    assert.equal(f.work.listSourceObservations(first.work.workItemId).length, 1);
  } finally {
    f.close();
  }
});

test("MCP terminal source signal safely cancels active work through orchestrator", () => {
  const f = fixture();
  try {
    const detail = f.adapter.submit(input("work-terminal"), context, 1000);
    const claim = f.tasks.claim("worker-a", 1500, 30000, "ota")!;
    assert.equal(claim.taskId, detail.currentTask!.taskId);
    const cancelled = f.adapter.updateSource(
      detail.work.workItemId,
      { state: "terminal", detail: "user closed source" },
      context,
      2000,
    );
    assert.equal(cancelled.work.status, "cancelled");
    assert.equal(cancelled.currentTask!.status, "running");
    assert.equal(cancelled.currentTask!.cancellationRequested, true);
    const obs = f.work.listSourceObservations(detail.work.workItemId).at(-1)!;
    assert.equal(obs.state, "terminal");
    assert.equal(obs.reconciliationAction, "cancel");
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
          { state: "terminal" },
          { ...context, sessionId: "sess-2" },
          2000,
        ),
      /MCP_SOURCE_SCOPE_MISMATCH/,
    );
    assert.equal(f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a").work.status, "running");
  } finally {
    f.close();
  }
});
