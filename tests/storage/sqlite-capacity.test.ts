import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpObservabilityStore } from "../../src/observability.js";

test("sqlite-only observability handles 30 concurrent users without lost session counts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-sqlite-capacity-"));
  try {
    const store = new McpObservabilityStore(root, 100000, { writeBackend: "sqlite", readBackend: "sqlite" });
    await Promise.all(
      Array.from({ length: 30 }, async (_, user) => {
        const principal = { id: `u${user}`, tenantId: "capacity", roles: ["developer"] };
        const sessionId = `s${user}`;
        await store.recordClientEvent(principal, { event: "SessionStart", sessionId, metadata: {} });
        for (let i = 0; i < 10; i++)
          await store.recordCall({
            traceId: `t${user}-${i}`,
            sessionId,
            actorId: principal.id,
            tenantId: principal.tenantId,
            tool: i % 2 ? "search_knowledge" : "discover",
            latencyMs: i,
            success: i !== 9,
          });
        await store.recordClientEvent(principal, { event: "SessionEnd", sessionId, metadata: {} });
      }),
    );
    const sessions = await store.listClientSessions(100);
    assert.equal(sessions.length, 30);
    assert.ok(sessions.every((s) => s.callCount === 10 && s.failedCallCount === 1 && s.ended));
    assert.equal((await store.listCalls(1000)).length, 300);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
