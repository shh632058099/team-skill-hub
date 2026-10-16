import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../../src/observability.js";

test("invalid observability backend configuration fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-backend-config-"));
  const previousWrite = process.env.OBSERVABILITY_WRITE_BACKEND,
    previousRead = process.env.OBSERVABILITY_READ_BACKEND;
  try {
    process.env.OBSERVABILITY_WRITE_BACKEND = "sqltie";
    process.env.OBSERVABILITY_READ_BACKEND = "sqlite";
    assert.throws(() => new McpObservabilityStore(root), /OBSERVABILITY_WRITE_BACKEND|backend/i);
    process.env.OBSERVABILITY_WRITE_BACKEND = "sqlite";
    process.env.OBSERVABILITY_READ_BACKEND = "sqltie";
    assert.throws(() => new McpObservabilityStore(root), /OBSERVABILITY_READ_BACKEND|backend/i);
  } finally {
    if (previousWrite === undefined) delete process.env.OBSERVABILITY_WRITE_BACKEND;
    else process.env.OBSERVABILITY_WRITE_BACKEND = previousWrite;
    if (previousRead === undefined) delete process.env.OBSERVABILITY_READ_BACKEND;
    else process.env.OBSERVABILITY_READ_BACKEND = previousRead;
    await rm(root, { recursive: true, force: true });
  }
});
