import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { ExpertWorkerClient, startExpertWorkerGrpcServer } from "../src/expert-platform/grpc-transport.js";

test("approved remote worker claims, renews and completes over real gRPC TCP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-1", ["ota"]);
    workers.approve("worker-1");
    const token = workers.issueCredential("worker-1");
    const submitted = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "grpc",
      problem: "investigate OTA failure",
      expertId: "ota",
    });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-1", credential: token });
    const claim = await client.claimTask("worker-1", "ota");
    assert.equal(claim?.problem, "investigate OTA failure");
    assert.equal(claim?.taskId, submitted.taskId);
    await client.renewLease(claim!);
    await client.reportTaskStage(claim!, "repository.started");
    await client.reportTaskStage(claim!, "repository.completed");
    await client.reportTaskStage(claim!, "tool.activity", "", { sequence: 1, tool: "Read", count: 3 });
    await client.reportTaskStage(claim!, "tool.activity", "", { sequence: 1, tool: "Read", count: 3 });
    await assert.rejects(
      () => client.reportTaskStage(claim!, "tool.activity", "", { sequence: 1, tool: "Read", count: 4 }),
      /PROGRESS_SEQUENCE_CONFLICT/,
    );
    const observed = tasks.ownerEvents(submitted.taskId, "alice", "org", 0, 50);
    assert.equal(observed.events.filter((event) => event.type === "tool.activity").length, 1);

    await assert.rejects(() => client.reportTaskStage(claim!, "codex.started", "Bearer secret"), /INVALID_STAGE_EVENT/);
    await client.completeTask(claim!, "verified root cause", {
      repositoryUrl: "https://github.com/example/ota.git",
      repositoryBranch: "release",
      commitSha: "abcdef0123456789abcdef0123456789abcdef01",
    });
    const completed = tasks.get(submitted.taskId, "alice", "org");
    assert.equal(completed.result, "verified root cause");
    assert.ok(
      tasks
        .adminTaskDetail(submitted.taskId)
        ?.events.some((event) => (event as any).event_type === "repository.started"),
    );
    assert.equal(completed.repositoryUrl, "https://github.com/example/ota.git");
    assert.equal(completed.repositoryBranch, "release");
    assert.equal(completed.commitSha, "abcdef0123456789abcdef0123456789abcdef01");

    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unapproved worker is rejected before task claim", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("worker-pending", ["ota"]);
    tasks.submit({ principalId: "alice", scope: "org", idempotencyKey: "grpc", problem: "investigate OTA failure" });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, { workerId: "worker-pending", credential: "invalid" });
    await assert.rejects(() => client.claimTask("worker-pending", "ota"), /WORKER_UNAUTHENTICATED/);

    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker can only claim tasks targeted to its authorized expert capability", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-filter-"));
  try {
    const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
    const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
    workers.enroll("ota-worker", ["ota"]);
    workers.approve("ota-worker");
    const token = workers.issueCredential("ota-worker");
    tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "yocto-only",
      problem: "inspect yocto build",
      expertId: "yocto",
    });

    const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
    const client = new ExpertWorkerClient(server.address, {
      workerId: "ota-worker",
      credential: token,
    });

    assert.equal(await client.claimTask("ota-worker", "ota"), null);

    const ota = tasks.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "ota-only",
      problem: "inspect ota update",
      expertId: "ota",
    });
    const claim = await client.claimTask("ota-worker", "ota");
    assert.equal(claim?.taskId, ota.taskId);

    client.close();
    await server.close();
    tasks.close();
    workers.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
