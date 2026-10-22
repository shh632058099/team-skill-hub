import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runExpertAdmin } from "../src/expert-platform/expert-admin.js";

test("expert admin can define and deploy an expert", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-admin-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    assert.deepEqual(runExpertAdmin(db, ["define", "ota", "OTA Expert", "ota,upgrade", "firmware"]), {
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota", "upgrade"],
      keywords: ["firmware"],
      active: true,
    });
    assert.deepEqual(runExpertAdmin(db, ["deploy", "ota-default", "ota", "ota-repo", "alice,bob", "codex-readonly"]), {
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice", "bob"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    assert.equal((runExpertAdmin(db, ["list-deployments"]) as unknown[]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
