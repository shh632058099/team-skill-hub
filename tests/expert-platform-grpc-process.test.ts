import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { PersistentWorkerRegistry } from "../src/expert-platform/persistent-worker-registry.js";
import { startExpertWorkerGrpcServer } from "../src/expert-platform/grpc-transport.js";

test("worker can run in a separate OS process over TCP", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-grpc-process-"));
  const tasks = new ExpertTaskStore(path.join(dir, "tasks.sqlite"));
  const workers = new PersistentWorkerRegistry(path.join(dir, "workers.sqlite"));
  workers.enroll("worker-process", ["ota"]);
  workers.approve("worker-process");
  const token = workers.issueCredential("worker-process");
  const submitted = tasks.submit({
    principalId: "alice",
    scope: "org",
    idempotencyKey: "separate-process",
    problem: "investigate OTA failure",
    expertId: "ota",
  });

  const server = await startExpertWorkerGrpcServer(tasks, workers, "127.0.0.1:0");
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/expert-worker-client.ts", server.address, "worker-process", "ota", token],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === null) reject(new Error("WORKER_PROCESS_TERMINATED"));
        else if (code !== 0) reject(new Error(`WORKER_PROCESS_FAILED:${code}:${stderr}`));
        else resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    assert.equal(tasks.get(submitted.taskId, "alice", "org").result, "completed by separate worker process");
  } finally {
    await server.close();
    tasks.close();
    workers.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
