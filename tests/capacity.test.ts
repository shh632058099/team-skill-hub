import assert from "node:assert/strict";
import test from "node:test";
import { runCapacityBenchmark } from "../src/capacity.js";

test("30-user capacity harness preserves concurrent observability writes", async () => {
  const result = await runCapacityBenchmark({
    users: 30,
    chunks: 1500,
    searchesPerUser: 3,
    writesPerUser: 2
  });
  assert.equal(result.users, 30);
  assert.equal(result.totalSearches, 90);
  assert.equal(result.writeErrors, 0);
  assert.equal(result.persistedWrites, result.totalWrites);
  assert.equal(result.persistedWrites, 60);
  assert.ok(result.sqlitePageSize > 0);
  assert.ok(result.sqlitePageCount > 0);
  assert.equal(result.sqliteApproxBytes, result.sqlitePageCount * result.sqlitePageSize);
  assert.ok(result.indexBuildDurationMs > 0);
  assert.ok(result.heapUsedAfterIndexBytes > 0);
  assert.ok(result.searchQps > 0);
  assert.ok(result.searchP95Ms >= result.searchP50Ms);
});
