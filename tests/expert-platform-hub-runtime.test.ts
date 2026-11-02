import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startExpertHubRuntimeFromEnv } from "../src/expert-platform/hub-runtime.js";

test("Hub runtime starts gRPC when runtime env is configured", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-hub-runtime-"));
  try {
    const runtime = await startExpertHubRuntimeFromEnv({
      EXPERT_RUNTIME_DB: path.join(dir, "runtime.sqlite"),
      EXPERT_WORKER_REGISTRY_DB: path.join(dir, "workers.sqlite"),
      EXPERT_GRPC_ADDRESS: "127.0.0.1:0",
    });
    assert.ok(runtime);
    assert.match(runtime.address, /^127\.0\.0\.1:\d+$/);
    await runtime.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hub runtime leaves gRPC disabled when only the shared runtime DB is configured", async () => {
  assert.equal(await startExpertHubRuntimeFromEnv({}), null);
  assert.equal(await startExpertHubRuntimeFromEnv({ EXPERT_RUNTIME_DB: "/tmp/runtime.sqlite" }), null);
  await assert.rejects(
    () => startExpertHubRuntimeFromEnv({ EXPERT_GRPC_ADDRESS: "127.0.0.1:0" }),
    /INVALID_EXPERT_HUB_CONFIG/,
  );
});
