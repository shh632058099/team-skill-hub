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
