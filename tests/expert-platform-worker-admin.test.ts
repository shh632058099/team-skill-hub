import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runWorkerAdmin } from "../src/expert-platform/worker-admin.js";

test("worker admin can enroll, approve, issue credential and revoke", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-admin-"));
  const db = path.join(dir, "workers.sqlite");
  try {
    assert.deepEqual(runWorkerAdmin(db, ["enroll", "worker-1", "ota,upgrade"]), {
      id: "worker-1",
      capabilities: ["ota", "upgrade"],
      status: "pending",
    });
    assert.deepEqual(runWorkerAdmin(db, ["approve", "worker-1"]), {
      id: "worker-1",
      status: "active",
    });
    const issued = runWorkerAdmin(db, ["issue-credential", "worker-1"]) as { credential: string };
    assert.match(issued.credential, /^ewc_/);
    assert.deepEqual(runWorkerAdmin(db, ["revoke", "worker-1"]), {
      id: "worker-1",
      status: "revoked",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
