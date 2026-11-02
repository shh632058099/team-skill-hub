import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";

test("worker credential is issued once and validates after reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-cred-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const first = new PersistentWorkerRegistry(file);
    first.enroll("worker-1", ["ota"]);
    first.approve("worker-1");
    const token = first.issueCredential("worker-1");
    assert.match(token, /^ewc_[A-Za-z0-9_-]+$/);
    assert.equal(first.authenticate("worker-1", token), true);
    first.close();

    const second = new PersistentWorkerRegistry(file);
    assert.equal(second.authenticate("worker-1", token), true);
    assert.equal(second.authenticate("worker-1", token + "x"), false);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential rotation invalidates previous token and revocation invalidates current token", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-cred-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const registry = new PersistentWorkerRegistry(file);
    registry.enroll("worker-1", ["ota"]);
    registry.approve("worker-1");
    const first = registry.issueCredential("worker-1");
    const second = registry.issueCredential("worker-1");
    assert.equal(registry.authenticate("worker-1", first), false);
    assert.equal(registry.authenticate("worker-1", second), true);
    registry.revoke("worker-1");
    assert.equal(registry.authenticate("worker-1", second), false);
    registry.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
