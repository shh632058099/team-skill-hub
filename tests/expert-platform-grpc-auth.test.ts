import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { ExpertWorkerClient, startExpertWorkerGrpcServer } from "../src/expert-platform/grpc-transport.js";

test("gRPC worker identity is bound to metadata credential", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-auth-"));
  const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
  const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
  workers.enroll("worker-1", ["ota"]);
  workers.approve("worker-1");
  const token = workers.issueCredential("worker-1");
  tasks.submit({ principalId: "alice", scope: "org", idempotencyKey: "auth", problem: "OTA failure", expertId: "ota" });
  const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
  try {
    const valid = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token });
    assert.ok(await valid.claimTask("worker-1", "ota"));
    valid.close();

    const forged = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token + "x" });
    await assert.rejects(() => forged.claimTask("worker-1", "ota"), /WORKER_UNAUTHENTICATED/);
    forged.close();
  } finally {
    await server.close();
    tasks.close();
    workers.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential identity must match request worker id and revocation takes effect immediately", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-auth-"));
  const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
  const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
  workers.enroll("worker-1", ["ota"]);
  workers.approve("worker-1");
  const token = workers.issueCredential("worker-1");
  workers.enroll("worker-2", ["ota"]);
  workers.approve("worker-2");
  const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
  try {
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token });
    await assert.rejects(() => client.claimTask("worker-2", "ota"), /WORKER_IDENTITY_MISMATCH/);
    workers.revoke("worker-1");
    await assert.rejects(() => client.claimTask("worker-1", "ota"), /WORKER_UNAUTHENTICATED/);
    client.close();
  } finally {
    await server.close();
    tasks.close();
    workers.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
