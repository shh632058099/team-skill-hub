import { performance } from "node:perf_hooks";

const baseUrl = process.env.SKILL_HUB_URL ?? "http://127.0.0.1:8080/mcp";
const iterations = Number(process.env.BENCH_ITERATIONS ?? 100);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 10);
const query = process.env.BENCH_QUERY ?? "OTA API 精简 调用链 review";

async function callResolve() {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "resolve_skill",
        arguments: { query, top_k: 3 }
      }
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  await response.text();
}

const latencies = [];
let next = 0;
const started = performance.now();

async function worker() {
  for (;;) {
    const index = next++;
    if (index >= iterations) return;
    const begin = performance.now();
    await callResolve();
    latencies.push(performance.now() - begin);
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, iterations) }, () => worker())
);

const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);

function percentile(p) {
  if (latencies.length === 0) return 0;
  const index = Math.min(
    latencies.length - 1,
    Math.ceil(latencies.length * p) - 1
  );
  return latencies[index];
}

console.log(
  JSON.stringify(
    {
      url: baseUrl,
      iterations,
      concurrency,
      total_ms: Number(elapsed.toFixed(2)),
      requests_per_second: Number(((iterations * 1000) / elapsed).toFixed(2)),
      latency_ms: {
        min: Number((latencies[0] ?? 0).toFixed(2)),
        p50: Number(percentile(0.5).toFixed(2)),
        p95: Number(percentile(0.95).toFixed(2)),
        p99: Number(percentile(0.99).toFixed(2)),
        max: Number((latencies.at(-1) ?? 0).toFixed(2))
      }
    },
    null,
    2
  )
);
