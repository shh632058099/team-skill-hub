import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";

test("dispatch auto-routes and persists routing metadata on task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });

    const dispatch = new ExpertDispatchService(experts, tasks);
    const task = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "auto-1",
      problem: "investigate ota upgrade failure",
      repositoryId: "ota-repo",
    });

    assert.equal(task.expertId, "ota");
    assert.equal(task.repositoryId, "ota-repo");
    assert.equal(task.selectionMode, "auto");
    assert.equal(task.schemaVersion, 1);
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch preserves strict explicit selection and repository authorization", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: [],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });

    const dispatch = new ExpertDispatchService(experts, tasks);
    assert.throws(
      () =>
        dispatch.submit({
          principalId: "alice",
          scope: "org",
          idempotencyKey: "explicit-bad",
          problem: "inspect update",
          expertId: "ota",
          repositoryId: "other-repo",
        }),
      /REPOSITORY_FORBIDDEN/,
    );

    const task = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "explicit-good",
      problem: "inspect update",
      expertId: "ota",
      repositoryId: "ota-repo",
    });
    assert.equal(task.selectionMode, "explicit");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
