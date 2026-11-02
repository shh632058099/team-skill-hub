import { runExpertAdmin } from "../expert-platform/expert-admin.js";

const dbPath = process.env.EXPERT_RUNTIME_DB?.trim();
if (!dbPath) throw new Error("EXPERT_RUNTIME_DB is required");

const result = runExpertAdmin(dbPath, process.argv.slice(2));
console.log(JSON.stringify(result, null, 2));
