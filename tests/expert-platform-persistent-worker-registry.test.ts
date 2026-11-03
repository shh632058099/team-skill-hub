import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("only non-active workers can be deleted and their ids can be re-enrolled", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-registry-delete-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const registry = new PersistentWorkerRegistry(file);

    registry.enroll("pending-worker", ["ota"]);
    registry.delete("pending-worker");
    assert.throws(() => registry.get("pending-worker"), /WORKER_NOT_FOUND/);
    assert.equal(registry.enroll("pending-worker", ["ota"]).status, "pending");

    registry.enroll("active-worker", ["ota"]);
    registry.approve("active-worker");
    assert.throws(() => registry.delete("active-worker"), /WORKER_ACTIVE/);
    assert.equal(registry.get("active-worker").status, "active");

    registry.revoke("active-worker");
    registry.delete("active-worker");
    assert.throws(() => registry.get("active-worker"), /WORKER_NOT_FOUND/);
    assert.equal(registry.enroll("active-worker", ["ota"]).status, "pending");

    registry.close();
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

test("worker presence distinguishes never connected, online, and heartbeat timeout", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-presence-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const registry = new PersistentWorkerRegistry(file);
    registry.enroll("presence-worker", ["ota"]);
    registry.approve("presence-worker");
    assert.equal(registry.get("presence-worker").connectionStatus, "not_connected");
    registry.recordHeartbeat("presence-worker", 100_000);
    const online = registry.get("presence-worker", 110_000, 45_000);
    assert.equal(online.connectionStatus, "online");
    assert.equal(online.lastSeenAt, 100_000);
    const stale = registry.get("presence-worker", 146_000, 45_000);
    assert.equal(stale.connectionStatus, "heartbeat_lost");
    assert.equal(stale.status, "active", "presence must not mutate approval state");
    registry.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy worker registry schema is upgraded with nullable heartbeat state", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-presence-migration-"));
  const file = path.join(dir, "runtime.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE expert_workers (id TEXT PRIMARY KEY, capabilities_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')), credential_hash TEXT)",
    );
    legacy
      .prepare("INSERT INTO expert_workers(id,capabilities_json,status) VALUES(?,?,?)")
      .run("legacy-worker", '["ota"]', "active");
    legacy.close();
    const registry = new PersistentWorkerRegistry(file);
    assert.equal(registry.get("legacy-worker").connectionStatus, "not_connected");
    assert.equal(registry.get("legacy-worker").lastSeenAt, null);
    registry.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
