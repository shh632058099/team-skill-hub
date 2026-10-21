import { createExpertWorkerRuntime } from "../expert-platform/worker-daemon.js";
import { runExpertWorkerLoop } from "../expert-platform/worker-runtime.js";
import { parseExpertWorkerConfig } from "../expert-platform/worker-runtime-config.js";

const config = parseExpertWorkerConfig(process.env);
const runtime = createExpertWorkerRuntime(config);
const controller = new AbortController();

const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await runExpertWorkerLoop(() => runtime.runOnce(), {
    pollMs: config.pollMs,
    signal: controller.signal,
  });
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  runtime.close();
}
