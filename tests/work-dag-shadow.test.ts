import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { projectShadowDag, reconcileShadowDag, type ShadowSource } from "../src/expert-platform/work-dag-shadow.js";

test("shadow graph uses durable source identities and preserves failed turns", () => {
  const source: ShadowSource = {
    workItemId: "work",
    stateRevision: 1,
    subject: "abc",
    status: "running",
    workflow: "policy@1",
    attempts: [{ id: "attempt", parent: null, status: "active", deployment: "deployment@1", workspace: null }],
    observations: [
      {
        id: "turn:task:run:1",
        attemptId: "attempt",
        kind: "agent",
        state: "failed",
        subject: null,
        predecessorIds: [],
      },
      {
        id: "turn:task:run:2",
        attemptId: "attempt",
        kind: "agent",
        state: "succeeded",
        subject: null,
        predecessorIds: ["turn:task:run:1"],
      },
    ],
  };
  const first = projectShadowDag(source);
  assert.equal(first.mode, "shadow");
  assert.equal(first.graph.nodes.length, 2);
  assert.equal(first.nodes[0]?.state, "failed");
  assert.deepEqual(first.graph.edges, [{ from: "turn:task:run:1", to: "turn:task:run:2" }]);
  const next = projectShadowDag({ ...source, stateRevision: 2 });
  assert.notEqual(first.sourceDigest, next.sourceDigest);
  assert.equal(first.semanticDigest, next.semanticDigest);
});

test("shadow projection reconciles across restart and drift without modifying authoritative Work", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-dag-shadow-"));
  const file = join(dir, "work.db");
  try {
    let store = new WorkOrchestrationStore(file);
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "k",
      sourceType: "mcp",
      title: "title",
      description: "description",
    });
    const source: ShadowSource = {
      workItemId: work.workItemId,
      stateRevision: work.stateRevision,
      subject: null,
      status: work.status,
      workflow: "policy@1",
      attempts: [],
      observations: [],
    };
    const before = store.getWorkInternal(work.workItemId);
    const first = reconcileShadowDag(store, () => source);
    assert.ok(first);
    assert.deepEqual(store.getWorkInternal(work.workItemId), before);
    store.close();
    store = new WorkOrchestrationStore(file);
    assert.equal(store.getShadowDag(work.workItemId)?.semanticDigest, first.semanticDigest);
    const db = new DatabaseSync(file);
    db.prepare("UPDATE work_shadow_dags SET projection_json='{}' WHERE work_item_id=?").run(work.workItemId);
    db.close();
    const repaired = reconcileShadowDag(store, () => source);
    assert.deepEqual(repaired, first);
    assert.deepEqual(store.getShadowDag(work.workItemId), first);
    let reads = 0;
    assert.equal(
      reconcileShadowDag(store, () => ({ ...source, stateRevision: source.stateRevision + reads++ })),
      null,
    );
    assert.equal(store.saveShadowDag({ ...first, stateRevision: work.stateRevision + 1 }), false);
    assert.deepEqual(store.getWorkInternal(work.workItemId), before);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
