import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertStore } from "../src/expert-platform/expert-store.js";

test("expert definitions and deployments persist across reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-store-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const first = new ExpertStore(file);
    first.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota", "upgrade"],
      keywords: ["firmware"],
      active: true,
    });
    first.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    first.close();

    const second = new ExpertStore(file);
    assert.deepEqual(second.getDefinition("ota").capabilities, ["ota", "upgrade"]);
    assert.deepEqual(second.getDeployment("ota-default"), {
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deployment requires an existing expert", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-store-"));
  try {
    const store = new ExpertStore(path.join(dir, "runtime.sqlite"));
    assert.throws(
      () =>
        store.putDeployment({
          id: "missing",
          expertId: "missing",
          repositoryIds: ["repo"],
          repositories: [],
          principals: ["alice"],
          runtimeProfile: "codex-readonly",
          active: true,
        }),
      /EXPERT_NOT_FOUND/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expert model config persists independently per expert", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-model-config-"));
  const file = path.join(dir, "runtime.sqlite");
  const modelConfig = {
    providerId: "bst",
    model: "gpt-5.6-luna",
    baseUrl: "https://route.briancs.shop/v1",
    wireApi: "responses" as const,
    credentialRef: "ai-router-default",
    allowedEnvNames: ["OPENAI_API_KEY"],
  };
  try {
    const store = new ExpertStore(file);
    store.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota"],
      keywords: [],
      active: true,
      modelConfig,
    });
    store.putDefinition({
      id: "review",
      displayName: "Review",
      capabilities: ["review"],
      keywords: [],
      active: true,
      modelConfig: { ...modelConfig, providerId: "review-router", model: "review-model" },
    });
    store.close();

    const reopened = new ExpertStore(file);
    assert.deepEqual(reopened.getDefinition("ota").modelConfig, modelConfig);
    assert.equal(reopened.getDefinition("review").modelConfig?.providerId, "review-router");
    assert.equal(reopened.getDefinition("review").modelConfig?.model, "review-model");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expert model config rejects unsafe env names and invalid API URLs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-model-config-invalid-"));
  try {
    const store = new ExpertStore(path.join(dir, "runtime.sqlite"));
    const base = { id: "bad", displayName: "Bad", capabilities: ["test"], keywords: [], active: true };
    assert.throws(
      () =>
        store.putDefinition({
          ...base,
          modelConfig: {
            providerId: "p",
            model: "m",
            baseUrl: "https://router.example/v1",
            wireApi: "responses",
            allowedEnvNames: ["CODEX_HOME"],
          },
        }),
      /INVALID_EXPERT/,
    );
    assert.throws(
      () =>
        store.putDefinition({
          ...base,
          modelConfig: {
            providerId: "p",
            model: "m",
            baseUrl: "https://user:pass@router.example/v1",
            wireApi: "responses",
            allowedEnvNames: ["OPENAI_API_KEY"],
          },
        }),
      /INVALID_EXPERT/,
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
