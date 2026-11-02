import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { runRemoteWorkerOnce } from "../src/expert-platform/remote-worker.js";
import type { Claim } from "../src/expert-platform/task-store.js";

class FakeClient {
  renews = 0;
  completed?: string;
  failed?: string;
  renewResponse: unknown = undefined;
  constructor(
    private readonly claim: Claim | null,
    private readonly renewError?: Error,
  ) {}
  async claimTask(): Promise<Claim | null> {
    return this.claim;
  }
  async renewLease(): Promise<unknown> {
    this.renews += 1;
    if (this.renewError) throw this.renewError;
    return this.renewResponse;
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

test("two-worker crash recovery: expired first run is fenced and second run wins", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-two-worker-recovery-"));
  const store = new ExpertTaskStore(path.join(dir, "runtime.sqlite"));
  try {
    const task = store.submit({
      principalId: "alice",
      scope: "team-a",
      idempotencyKey: "two-worker-recovery",
      problem: "inspect",
    });
    const firstClaim = store.claim("worker-1", Date.now(), 35);
    assert.ok(firstClaim);

    // Simulate a worker process disappearing: it never renews or reports completion.
    await new Promise((resolve) => setTimeout(resolve, 45));
    const secondClaim = store.claim("worker-2", Date.now(), 5_000);
    assert.ok(secondClaim);
    assert.notEqual(secondClaim!.runId, firstClaim!.runId);

    // A late response from the crashed worker cannot override the recovered run.
    assert.throws(() => store.complete(firstClaim!, "late worker-1 result", Date.now()), /STALE_ATTEMPT/);
    store.complete(secondClaim!, "worker-2 recovered result", Date.now());
    const final = store.get(task.taskId, "alice", "team-a");
    assert.equal(final.status, "succeeded");
    assert.equal(final.result, "worker-2 recovered result");
    const db = new (await import("node:sqlite")).DatabaseSync(path.join(dir, "runtime.sqlite"));
    const firstRun = db.prepare("SELECT status FROM expert_runs WHERE run_id=?").get(firstClaim!.runId) as {
      status: string;
    };
    const secondRun = db.prepare("SELECT status FROM expert_runs WHERE run_id=?").get(secondClaim!.runId) as {
      status: string;
    };
    assert.equal(firstRun.status, "expired");
    assert.equal(secondRun.status, "succeeded");
    db.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker aborts execution on cancellation request and acknowledges cancelled state", async () => {
  const client = new FakeClient(claim);
  client.renewResponse = { cancellation_requested: true };
  let aborted = false;
  const execution = runRemoteWorkerOnce(
    client,
    "worker-1",
    "ota",
    async (_claim, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      throw new Error("CODEX_CANCELLED");
    },
    { heartbeatMs: 10 },
  );
  assert.equal(await execution, true);
  assert.equal(aborted, true);
  assert.equal(client.failed, "TASK_CANCELLED");
  assert.equal(client.completed, undefined);
});
