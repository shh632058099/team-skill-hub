import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";

test("bootstrap registration is idempotent before and after approval and rejects changed credentials", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-registry-bootstrap-"));
  const file = path.join(dir, "runtime.sqlite");
  const credential = `ewc_${"a".repeat(43)}`;
  try {
    const registry = new PersistentWorkerRegistry(file);
    assert.equal(
      registry.bootstrapRegister("worker-bootstrap", ["ota"], credential, false, []).worker.status,
      "pending",
    );
    assert.equal(
      registry.bootstrapRegister("worker-bootstrap", ["ota"], `ewc_${"b".repeat(43)}`, true, ["ota"]).worker.status,
      "pending",
    );
    assert.throws(
      () => registry.bootstrapRegister("worker-bootstrap", ["admin"], credential, false, []),
      /WORKER_CONFIGURATION_MISMATCH/,
    );
    registry.approve("worker-bootstrap");
    assert.equal(registry.bootstrapRegister("worker-bootstrap", ["ota"], credential, false, []).credential, credential);
    assert.equal(registry.bootstrapRegister("worker-bootstrap", ["ota"], credential, false, []).credential, credential);
    assert.throws(
      () => registry.bootstrapRegister("worker-bootstrap", ["ota"], `ewc_${"c".repeat(43)}`, false, []),
      /WORKER_CREDENTIAL_ALREADY_ISSUED/,
    );
    registry.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("approved worker survives registry reopen", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-registry-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const first = new PersistentWorkerRegistry(file);
    first.enroll("worker-1", ["ota", "upgrade"]);
    first.approve("worker-1");
    first.close();

    const second = new PersistentWorkerRegistry(file);
    assert.equal(second.isAuthorized("worker-1", "ota"), true);
    assert.equal(second.get("worker-1").status, "active");
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation survives reopen and blocks re-enrollment", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-registry-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const first = new PersistentWorkerRegistry(file);
    first.enroll("worker-1", ["ota"]);
    first.approve("worker-1");
    first.revoke("worker-1");
    first.close();

    const second = new PersistentWorkerRegistry(file);
    assert.equal(second.isAuthorized("worker-1", "ota"), false);
    assert.equal(second.get("worker-1").status, "revoked");
    assert.throws(() => second.enroll("worker-1", ["ota"]), /WORKER_ALREADY_EXISTS/);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
