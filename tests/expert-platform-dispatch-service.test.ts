import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";

test("V2 deployment snapshots are immutable, capability-gated and part of deduplication identity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-v2-snapshot-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "review",
      displayName: "Review",
      capabilities: ["review"],
      keywords: [],
      active: true,
    });
    const modelConfig = {
      providerId: "router",
      model: "review-model-a",
      baseUrl: "https://example.org/v1",
      wireApi: "responses" as const,
      credentialRef: "model",
      allowedEnvNames: ["OPENAI_API_KEY"],
    };
    const repository = { id: "repo", url: "https://github.com/example/example.git", branch: "main" };
    const baseline = {
      expertId: "review",
      repositoryIds: ["repo"],
      repositories: [repository],
      principals: ["alice"],
      runtimeProfile: "runtime-v2",
      active: true,
    };
    experts.putDeployment({ ...baseline, id: "d1", executor: { backend: "codex", modelConfig } });
    experts.putDeployment({
      ...baseline,
      id: "d2",
      executor: { backend: "codex", modelConfig: { ...modelConfig, model: "review-model-b" } },
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const input = {
      principalId: "alice",
      scope: "test",
      sourceClient: "claude",
      sourceSessionId: "stable-session",
      problem: "review this repository",
      expertId: "review",
      repositoryId: "repo",
      selectionMode: "explicit" as const,
    };
    assert.throws(() => dispatch.submit({ ...input, idempotencyKey: "ambiguous" }), /DEPLOYMENT_REQUIRED/);
    const first = dispatch.submit({ ...input, idempotencyKey: "first", deploymentId: "d1" });
    const second = dispatch.submit({ ...input, idempotencyKey: "second", deploymentId: "d2" });
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(first.deploymentSnapshot?.executor.modelConfig.model, "review-model-a");
    assert.equal(first.schemaVersion, 2);
    assert.equal(tasks.claim("old-worker", Date.now(), 30_000, "review"), null, "legacy Worker cannot claim V2");
    assert.equal(
      tasks.claim("wrong-backend", Date.now(), 30_000, "review", {
        backend: "claude",
        runtimeProfiles: ["runtime-v2"],
      }),
      null,
    );
    assert.equal(
      tasks.claim("wrong-profile", Date.now(), 30_000, "review", { backend: "codex", runtimeProfiles: ["other"] }),
      null,
    );
    experts.putDeployment({
      ...baseline,
      id: "d1",
      executor: { backend: "codex", modelConfig: { ...modelConfig, model: "changed-model" } },
    });
    const claim = tasks.claim("v2-worker", Date.now(), 30_000, "review", {
      backend: "codex",
      runtimeProfiles: ["runtime-v2"],
    });
    assert.equal(
      claim?.deploymentSnapshot?.executor.modelConfig.model,
      "review-model-a",
      "queued snapshot must not change",
    );
    assert.equal(claim?.taskId, first.taskId);
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      repositories: [],
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
      repositories: [],
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

test("dispatch infers the only configured URL repository when caller omits an internal repository ID", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-url-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({ id: "ota", displayName: "OTA Expert", capabilities: ["ota"], keywords: [], active: true });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["repo-0123456789abcdefabcd"],
      repositories: [{ id: "repo-0123456789abcdefabcd", url: "https://github.com/example/ota.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const task = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "url-auto-1",
      problem: "investigate ota",
    });
    assert.equal(task.expertId, "ota");
    assert.equal(task.repositoryId, "repo-0123456789abcdefabcd");
    assert.equal(task.selectionMode, "auto");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch does not combine principals and repositories across deployments", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-acl-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "review",
      displayName: "Review Expert",
      capabilities: ["review"],
      keywords: ["code"],
      active: true,
    });
    experts.putDeployment({
      id: "alice-a",
      expertId: "review",
      repositoryIds: ["repo-a"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    experts.putDeployment({
      id: "bob-b",
      expertId: "review",
      repositoryIds: ["repo-b"],
      repositories: [],
      principals: ["bob"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    assert.throws(
      () =>
        dispatch.submit({
          principalId: "alice",
          scope: "org",
          idempotencyKey: "acl-cross-product",
          problem: "review code",
          expertId: "review",
          repositoryId: "repo-b",
        }),
      /REPOSITORY_FORBIDDEN/,
    );
    const allowed = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "acl-allowed",
      problem: "review code",
      expertId: "review",
      repositoryId: "repo-a",
    });
    assert.equal(allowed.repositoryId, "repo-a");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch requires an explicit repository when the selected expert has multiple URL repositories", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-multi-repo-"));
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
      id: "ota-multi",
      expertId: "ota",
      repositoryIds: ["repo-aaaaaaaaaaaaaaaaaaaa", "repo-bbbbbbbbbbbbbbbbbbbb"],
      repositories: [
        { id: "repo-aaaaaaaaaaaaaaaaaaaa", url: "https://github.com/example/ota-core.git", branch: "main" },
        { id: "repo-bbbbbbbbbbbbbbbbbbbb", url: "https://github.com/example/ota-tests.git", branch: "main" },
      ],
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
          idempotencyKey: "multi-repo-missing",
          problem: "investigate ota upgrade failure",
          expertId: "ota",
        }),
      /REPOSITORY_REQUIRED/,
    );
    const explicit = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "multi-repo-explicit",
      problem: "investigate ota upgrade failure",
      expertId: "ota",
      repositoryId: "repo-bbbbbbbbbbbbbbbbbbbb",
    });
    assert.equal(explicit.repositoryId, "repo-bbbbbbbbbbbbbbbbbbbb");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
