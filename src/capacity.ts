import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { KnowledgeIndex } from "./knowledge.js";
import { McpObservabilityStore } from "./observability.js";
import type { KnowledgeChunk } from "./types.js";

export interface CapacityBenchmarkOptions {
  users?: number;
  chunks?: number;
  searchesPerUser?: number;
  writesPerUser?: number;
}

export interface CapacityBenchmarkResult {
  users: number;
  chunks: number;
  indexBuildDurationMs: number;
  sqlitePageCount: number;
  sqlitePageSize: number;
  sqliteApproxBytes: number;
  heapUsedAfterIndexBytes: number;
  totalSearches: number;
  searchDurationMs: number;
  searchQps: number;
  searchP50Ms: number;
  searchP95Ms: number;
  totalWrites: number;
  persistedWrites: number;
  writeDurationMs: number;
  writeErrors: number;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function syntheticChunks(count: number): KnowledgeChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `capacity:doc-${index}.md#0`,
    documentKey: `capacity:doc-${index}.md`,
    repositoryId: "capacity",
    revision: "benchmark",
    relativePath: `docs/topic-${index}.md`,
    title: `Capacity topic ${index}`,
    chunkIndex: 0,
    content:
      `Synthetic engineering knowledge topic-${index} checkpoint-${index % 97} ` +
      "recovery firmware validation release workflow deterministic search payload",
    metadata: { owner: "benchmark", status: "active" }
  }));
}

export async function runCapacityBenchmark(
  options: CapacityBenchmarkOptions = {}
): Promise<CapacityBenchmarkResult> {
  const users = Math.max(1, Math.min(Math.floor(options.users ?? 30), 200));
  const chunks = Math.max(100, Math.min(Math.floor(options.chunks ?? 10000), 100000));
  const searchesPerUser = Math.max(1, Math.min(Math.floor(options.searchesPerUser ?? 20), 200));
  const writesPerUser = Math.max(1, Math.min(Math.floor(options.writesPerUser ?? 3), 50));

  const index = new KnowledgeIndex();
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-capacity-"));
  try {
    const indexStarted = performance.now();
    index.rebuild(syntheticChunks(chunks));
    const indexBuildDurationMs = performance.now() - indexStarted;
    const storage = index.storageStats();
    const heapUsedAfterIndexBytes = process.memoryUsage().heapUsed;
    const latencies: number[] = [];
    const searchStarted = performance.now();
    await Promise.all(
      Array.from({ length: users }, async (_, user) => {
        for (let round = 0; round < searchesPerUser; round += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          const start = performance.now();
          const target = (user * searchesPerUser + round) % chunks;
          const results = index.search(
            `checkpoint-${target % 97} topic-${target}`,
            ["capacity"],
            5
          );
          latencies.push(performance.now() - start);
          if (!results.length) throw new Error("Synthetic capacity search returned no results");
        }
      })
    );
    const searchDurationMs = performance.now() - searchStarted;

    const store = new McpObservabilityStore(root, users * writesPerUser + 100);
    let writeErrors = 0;
    const writeStarted = performance.now();
    await Promise.all(
      Array.from({ length: users }, async (_, user) => {
        for (let round = 0; round < writesPerUser; round += 1) {
          try {
            await store.recordCall({
              traceId: `capacity-trace-${user}`,
              tool: "search_knowledge",
              actorId: `user-${user}`,
              tenantId: "capacity",
              latencyMs: round + 1,
              success: true,
              args: { round, query: `topic-${user}` }
            });
          } catch {
            writeErrors += 1;
          }
        }
      })
    );
    const writeDurationMs = performance.now() - writeStarted;
    const persistedWrites = (await store.listCalls(users * writesPerUser + 100)).length;
    const totalSearches = users * searchesPerUser;
    const totalWrites = users * writesPerUser;
    return {
      users,
      chunks,
      indexBuildDurationMs,
      sqlitePageCount: storage.sqlitePageCount,
      sqlitePageSize: storage.sqlitePageSize,
      sqliteApproxBytes: storage.sqliteApproxBytes,
      heapUsedAfterIndexBytes,
      totalSearches,
      searchDurationMs,
      searchQps: searchDurationMs > 0 ? (totalSearches * 1000) / searchDurationMs : totalSearches,
      searchP50Ms: percentile(latencies, 0.5),
      searchP95Ms: percentile(latencies, 0.95),
      totalWrites,
      persistedWrites,
      writeDurationMs,
      writeErrors
    };
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
}
