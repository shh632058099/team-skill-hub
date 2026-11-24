import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";

test("maxReworks is enforced at the authoritative WorkAttempt creation boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-attempt-limit-"));
  const store = new WorkOrchestrationStore(join(dir, "runtime.db"));
  try {
    const base = store.getWorkflow("investigation").definition;
    store.putWorkflow("rework-limit", 1, {
      ...structuredClone(base),
      lifecycle: {
        ...structuredClone(base.lifecycle),
        attempt: { maxWorkAttempts: 5, maxReworks: 1 },
      },
      graph: { mode: "dynamic-dag" },
    });
    const work = store.createOrReuseWork({
      principalId: "a",
      scope: "s",
      idempotencyKey: "k",
      sourceType: "mcp",
      title: "t",
      description: "d",
      workflowId: "rework-limit",
    });
    let current = store.getWorkInternal(work.workItemId);
    const initial = store.createWorkAttempt(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      {
        reason: "initial",
        expertId: "e",
        deploymentId: "d",
        deploymentConfigVersion: 1,
      },
      10,
    );
    current = store.getWorkInternal(work.workItemId);
    store.finishWorkAttempt(
      work.workItemId,
      initial.workAttemptId,
      "a",
      "s",
      current.stateRevision,
      "succeeded",
      "running",
      11,
    );

    current = store.getWorkInternal(work.workItemId);
    const rework = store.createWorkAttempt(
      work.workItemId,
      "a",
      "s",
      current.stateRevision,
      {
        reason: "review_rework",
        parentWorkAttemptId: initial.workAttemptId,
        expertId: "e",
        deploymentId: "d",
        deploymentConfigVersion: 1,
      },
      20,
    );
    current = store.getWorkInternal(work.workItemId);
    store.finishWorkAttempt(
      work.workItemId,
      rework.workAttemptId,
      "a",
      "s",
      current.stateRevision,
      "succeeded",
      "running",
      21,
    );

    current = store.getWorkInternal(work.workItemId);
    assert.throws(
      () =>
        store.createWorkAttempt(
          work.workItemId,
          "a",
          "s",
          current.stateRevision,
          {
            reason: "review_rework",
            parentWorkAttemptId: rework.workAttemptId,
            expertId: "e",
            deploymentId: "d",
            deploymentConfigVersion: 1,
          },
          30,
        ),
      /WORK_REWORK_LIMIT_REACHED/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
