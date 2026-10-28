#!/usr/bin/env node
import { existsSync } from "node:fs";
const credentialFile =
  process.env.EXPERT_WORKER_CREDENTIAL_FILE?.trim() || "/var/lib/team-skill-hub-worker/worker-credential";
const required = [
  "EXPERT_HUB_ADDRESS",
  "EXPERT_WORKER_ID",
  "EXPERT_CAPABILITY",
  "EXPERT_REPOSITORY_ROOT",
  "EXPERT_DOCKER_IMAGE",
  "EXPERT_DOCKER_NETWORK",
  "EXPERT_MODEL_ENV_NAMES",
];
const missing = required.filter((key) => !process.env[key]?.trim());
if (
  !process.env.EXPERT_WORKER_CREDENTIAL?.trim() &&
  !process.env.EXPERT_WORKER_BOOTSTRAP_TOKEN?.trim() &&
  !existsSync(credentialFile)
) {
  missing.push("EXPERT_WORKER_BOOTSTRAP_TOKEN (or EXPERT_WORKER_CREDENTIAL / saved credential file)");
}
if (missing.length) {
  console.error(`Missing required Worker configuration keys: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Worker configuration has required settings (secret values not displayed).");
}
