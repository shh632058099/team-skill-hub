import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerRegistry } from "../src/expert-platform/worker-registry.js";

test("workers require review before they are eligible", () => {
  const workers = new WorkerRegistry();
  const worker = workers.enroll("worker-1", ["ota"]);
  assert.equal(worker.status, "pending");
  assert.equal(workers.isAuthorized("worker-1", "ota"), false);
  workers.approve("worker-1");
  assert.equal(workers.isAuthorized("worker-1", "ota"), true);
  assert.equal(workers.isAuthorized("worker-1", "yocto"), false);
});
test("revocation takes immediate effect and does not silently re-enroll", () => {
  const workers = new WorkerRegistry();
  workers.enroll("worker-1", ["ota"]);
  workers.approve("worker-1");
  workers.revoke("worker-1");
  assert.equal(workers.isAuthorized("worker-1", "ota"), false);
  assert.throws(() => workers.enroll("worker-1", ["ota"]), /WORKER_ALREADY_EXISTS/);
  assert.throws(() => workers.approve("worker-1"), /WORKER_REVOKED/);
});
test("unknown identities and unapproved workers fail closed", () => {
  const workers = new WorkerRegistry();
  assert.equal(workers.isAuthorized("missing", "ota"), false);
  assert.throws(() => workers.enroll("", ["ota"]), /INVALID_WORKER/);
  assert.throws(() => workers.approve("missing"), /WORKER_NOT_FOUND/);
});
