import { runWorkerAdmin } from "../expert-platform/worker-admin.js";

const dbPath = process.env.EXPERT_WORKER_REGISTRY_DB?.trim();
if (!dbPath) throw new Error("EXPERT_WORKER_REGISTRY_DB is required");

const result = runWorkerAdmin(dbPath, process.argv.slice(2));
console.log(JSON.stringify(result, null, 2));
