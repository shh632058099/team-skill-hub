import assert from "node:assert/strict";
import { test } from "node:test";
import { runRemoteWorkerOnce } from "../src/expert-platform/remote-worker.js";
import type { Claim } from "../src/expert-platform/task-store.js";

class FakeClient {
  renews = 0;
  completed?: string;
  failed?: string;
  constructor(
    private readonly claim: Claim | null,
    private readonly renewError?: Error,
  ) {}
  async claimTask(): Promise<Claim | null> {
    return this.claim;
  }
  async renewLease(): Promise<void> {
    this.renews += 1;
    if (this.renewError) throw this.renewError;
  }
  async completeTask(_claim: Claim, result: string): Promise<void> {
    this.completed = result;
  }
  async failTask(_claim: Claim, reason: string): Promise<void> {
    this.failed = reason;
  }
}

const claim: Claim = { workerId: "worker-1", taskId: "task-1", runId: "run-1", fencing: 1, problem: "inspect" };

test("remote worker renews lease while executor runs then completes", async () => {
  const client = new FakeClient(claim);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execution = runRemoteWorkerOnce(
    client,
    "worker-1",
    "ota",
    async () => {
      await gate;
      return "result";
    },
    { heartbeatMs: 10 },
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  release();
  assert.equal(await execution, true);
  assert.ok(client.renews >= 2);
  assert.equal(client.completed, "result");
});

test("lease renewal failure stops completion and aborts executor", async () => {
  const client = new FakeClient(claim, new Error("connection lost"));
  let aborted = false;
  const executed = runRemoteWorkerOnce(
    client,
    "worker-1",
    "ota",
    async (_claim, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return "must-not-complete";
    },
    { heartbeatMs: 10 },
  );
  await assert.rejects(executed, /WORKER_LEASE_LOST/);
  assert.equal(aborted, true);
  assert.equal(client.completed, undefined);
});

test("executor failure is reported to Hub with generic reason", async () => {
  const client = new FakeClient(claim);
  assert.equal(
    await runRemoteWorkerOnce(client, "worker-1", "ota", async () => {
      throw new Error("secret detail");
    }),
    true,
  );
  assert.equal(client.failed, "EXECUTION_FAILED");
  assert.equal(client.completed, undefined);
});
