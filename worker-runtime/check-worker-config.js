#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

const instance = process.env.EXPERT_WORKER_INSTANCE?.trim() ?? "";
const validInstance = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(instance);
const dataRoot = validInstance ? path.join("/var/lib/team-skill-hub-worker", instance) : "";
const credentialFile =
  process.env.EXPERT_WORKER_CREDENTIAL_FILE?.trim() ||
  (dataRoot ? path.join(dataRoot, "worker-credential") : "");
const repositoryRoot =
  process.env.EXPERT_REPOSITORY_ROOT?.trim() || (dataRoot ? path.join(dataRoot, "repositories") : "");
const sourcePath = process.env.EXPERT_SOURCE_PATH?.trim() || (dataRoot ? path.join(dataRoot, "source") : "");

function managedPathIsAllowed(candidate) {
  if (!validInstance || process.env.EXPERT_ALLOW_MANAGED_PATH_OVERRIDES?.trim() === "true") return true;
  const managedRoot = path.resolve("/var/lib/team-skill-hub-worker");
  const resolved = path.resolve(candidate);
  const managedRelative = path.relative(managedRoot, resolved);
  const insideManaged =
    managedRelative === "" || (!managedRelative.startsWith("..") && !path.isAbsolute(managedRelative));
  if (!insideManaged) return true;
  const instanceRelative = path.relative(path.resolve(dataRoot), resolved);
  return instanceRelative === "" || (!instanceRelative.startsWith("..") && !path.isAbsolute(instanceRelative));
}

const required = [
  "EXPERT_HUB_ADDRESS",
  "EXPERT_WORKER_ID",
  "EXPERT_CAPABILITY",
  "EXPERT_DOCKER_IMAGE",
  "EXPERT_DOCKER_NETWORK",
  "EXPERT_MODEL_ENV_NAMES",
];
const missing = required.filter((key) => !process.env[key]?.trim());
if (!validInstance) missing.push("EXPERT_WORKER_INSTANCE");
if (!repositoryRoot || !sourcePath) missing.push("instance-local repository/source paths");
if (
  [credentialFile, repositoryRoot, sourcePath].some(
    (candidate) => candidate && !managedPathIsAllowed(candidate),
  )
) {
  missing.push("instance-managed paths must stay inside the selected Worker instance");
}
if (
  !process.env.EXPERT_WORKER_CREDENTIAL?.trim() &&
  !process.env.EXPERT_WORKER_BOOTSTRAP_TOKEN?.trim() &&
  (!credentialFile || !existsSync(credentialFile))
) {
  missing.push("EXPERT_WORKER_BOOTSTRAP_TOKEN (or EXPERT_WORKER_CREDENTIAL / saved credential file)");
}
if (missing.length) {
  console.error(`Missing or invalid Worker configuration: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Worker configuration has required settings (secret values not displayed).");
}