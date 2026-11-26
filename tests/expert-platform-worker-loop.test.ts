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
  failureDiagnostic?: unknown;
  stages: Array<{ stage: string; details: string }> = [];
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
  async failTask(_claim: Claim, reason: string, diagnostic?: unknown): Promise<void> {
    this.failed = reason;
    this.failureDiagnostic = diagnostic;
  }
  async reportTaskStage(_claim: Claim, stage: string, details = ""): Promise<void> {
    this.stages.push({ stage, details });
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

test("transient model failure retries inside the same ExpertTask before failing the task", async () => {
  const client = new FakeClient(claim);
  let calls = 0;
  const transient = new Error("MODEL_RATE_LIMITED") as Error & { diagnostic?: unknown };
  transient.diagnostic = {
    errorCode: "MODEL_RATE_LIMITED",
    backend: "claude",
    httpStatus: 429,
    message: "rate limit exceeded",
  };
  assert.equal(
    await runRemoteWorkerOnce(
      client,
      "worker-1",
      "ota",
      async () => {
        calls++;
        if (calls < 3) throw transient;
        return "recovered";
      },
      { modelRetryDelaysMs: [0, 0] },
    ),
    true,
  );
  assert.equal(calls, 3);
  assert.equal(client.completed, "recovered");
  assert.equal(client.failed, undefined);
  assert.deepEqual(
    client.stages
      .filter((entry) => entry.stage === "model.retry")
      .map((entry) => ({ stage: entry.stage, details: JSON.parse(entry.details) })),
    [
      {
        stage: "model.retry",
        details: {
          errorCode: "MODEL_RATE_LIMITED",
          backend: "claude",
          httpStatus: 429,
          message: "rate limit exceeded",
          retryable: true,
          retryAttempt: 1,
          maxAttempts: 3,
        },
      },
      {
        stage: "model.retry",
        details: {
          errorCode: "MODEL_RATE_LIMITED",
          backend: "claude",
          httpStatus: 429,
          message: "rate limit exceeded",
          retryable: true,
          retryAttempt: 2,
          maxAttempts: 3,
        },
      },
    ],
  );
});

test("non-transient model failure is not retried inside the ExpertTask", async () => {
  const client = new FakeClient(claim);
  let calls = 0;
  const denied = new Error("AUTHENTICATION_FAILED") as Error & { diagnostic?: unknown };
  denied.diagnostic = {
    errorCode: "AUTHENTICATION_FAILED",
    backend: "claude",
    httpStatus: 401,
    message: "authentication rejected",
  };
  await runRemoteWorkerOnce(
    client,
    "worker-1",
    "ota",
    async () => {
      calls++;
      throw denied;
    },
    { modelRetryDelaysMs: [0, 0] },
  );
  assert.equal(calls, 1);
  assert.equal(client.failed, "AUTHENTICATION_FAILED");
});

test("exhausted transient model retry forwards safe detailed diagnostic and retry metadata", async () => {
  const client = new FakeClient(claim);
  let calls = 0;
  const transient = new Error("MODEL_REQUEST_FAILED") as Error & { diagnostic?: unknown };
  transient.diagnostic = {
    errorCode: "MODEL_REQUEST_FAILED",
    backend: "claude",
    exitCode: 1,
    httpStatus: 503,
    requestId: "req-503",
    endpointHost: "router.example.test",
    message: "upstream overloaded token=[REDACTED]",
  };
  await runRemoteWorkerOnce(
    client,
    "worker-1",
    "ota",
    async () => {
      calls++;
      throw transient;
    },
    { modelRetryDelaysMs: [0, 0] },
  );
  assert.equal(calls, 3);
  assert.equal(client.failed, "MODEL_REQUEST_FAILED");
  assert.deepEqual(client.failureDiagnostic, {
    ...(transient.diagnostic as Record<string, unknown>),
    retryable: true,
    retryAttempt: 3,
    maxAttempts: 3,
  });
});

test("worker forwards structured executor diagnostics only through the admin failure channel", async () => {
  const client = new FakeClient(claim);
  const error = new Error("MODEL_RATE_LIMITED") as Error & { diagnostic?: unknown };
  error.diagnostic = {
    errorCode: "MODEL_RATE_LIMITED",
    backend: "codex",
    exitCode: 1,
    httpStatus: 429,
    requestId: "req-123",
    endpointHost: "api.example.test",
    message: "rate limited token=[REDACTED]",
  };
  await runRemoteWorkerOnce(
    client,
    "worker-1",
    "ota",
    async () => {
      throw error;
    },
    { modelRetryDelaysMs: [] },
  );
  assert.equal(client.failed, "MODEL_RATE_LIMITED");
  assert.deepEqual(client.failureDiagnostic, {
    ...(error.diagnostic as Record<string, unknown>),
    retryable: true,
    retryAttempt: 1,
    maxAttempts: 1,
  });
});

test("worker forwards safe executor failure classifications to Hub", async () => {
  for (const code of [
    "MODEL_REQUEST_FAILED",
    "MODEL_RATE_LIMITED",
    "MODEL_NETWORK_FAILED",
    "EXECUTOR_TIMEOUT",
    "AUTHENTICATION_FAILED",
  ]) {
    const client = new FakeClient(claim);
    assert.equal(
      await runRemoteWorkerOnce(
        client,
        "worker-1",
        "ota",
        async () => {
          throw new Error(code + ":private detail must not be forwarded");
        },
        { modelRetryDelaysMs: [] },
      ),
      true,
    );
    assert.equal(client.failed, code);
    assert.equal(client.completed, undefined);
  }
});

test("semantic blocked agent outcome fails the ExpertTask instead of completing it", async () => {
  const client = new FakeClient(claim);
  assert.equal(
    await runRemoteWorkerOnce(client, "worker-1", "ota", async () => ({
      result: "Remote repository access is unavailable.",
      executionOutcome: { status: "blocked" as const, reasonCode: "REMOTE_ACCESS" },
    })),
    true,
  );
  assert.equal(client.completed, undefined);
  assert.equal(client.failed, "AGENT_BLOCKED:REMOTE_ACCESS\nRemote repository access is unavailable.");
});
test("worker forwards only known deterministic workspace error codes, never exception details", async () => {
  for (const code of [
    "WORKER_CHECKOUT_OWNER_NOT_ALLOWED",
    "WORKER_GIT_METADATA_OWNERSHIP_INVALID",
    "WORKER_CHECKOUT_GROUP_NOT_CONFIGURED",
    "WORKER_CHECKOUT_PERMISSION_NOT_SHARED",
    "WORKER_RUNTIME_STATE_OWNER_INVALID",
    "WORKER_RUNTIME_STATE_GROUP_NOT_CONFIGURED",
    "WORKSPACE_PREPARATION_INCOMPLETE",
    "WORKSPACE_PREPARATION_REVISION_MISMATCH",
  ]) {
    const client = new FakeClient(claim);
    assert.equal(
      await runRemoteWorkerOnce(client, "worker-1", "ota", async () => {
        throw new Error(code + ":/private/secret/filename");
      }),
      true,
    );
    assert.equal(client.failed, code);
  }
  const unknown = new FakeClient(claim);
  await runRemoteWorkerOnce(unknown, "worker-1", "ota", async () => {
    throw new Error("WORKER_FAKE_PERMISSION_DENIED:secret");
  });
  assert.equal(unknown.failed, "EXECUTION_FAILED");
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
      throw new Error("EXECUTOR_CANCELLED");
    },
    { heartbeatMs: 10 },
  );
  assert.equal(await execution, true);
  assert.equal(aborted, true);
  assert.equal(client.failed, "TASK_CANCELLED");
  assert.equal(client.completed, undefined);
});
