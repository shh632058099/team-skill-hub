import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { requestWorkerBootstrap } from "../expert-platform/grpc-transport.js";
import { createExpertWorkerRuntime } from "../expert-platform/worker-daemon.js";
import { runExpertWorkerLoop } from "../expert-platform/worker-runtime.js";
import { parseExpertWorkerConfig } from "../expert-platform/worker-runtime-config.js";

function grpcCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error ? Number(error.code) : undefined;
}

async function resolveWorkerCredential(env: NodeJS.ProcessEnv): Promise<string> {
  const configured = env.EXPERT_WORKER_CREDENTIAL?.trim();
  if (configured) return configured;

  const credentialFile =
    env.EXPERT_WORKER_CREDENTIAL_FILE?.trim() || "/var/lib/team-skill-hub-worker/worker-credential";
  if (!path.isAbsolute(credentialFile) || credentialFile === "/") throw new Error("INVALID_WORKER_CREDENTIAL_FILE");
  try {
    const saved = readFileSync(credentialFile, "utf8").trim();
    if (saved) {
      const pendingCredentialFile = `${credentialFile}.pending`;
      if (existsSync(pendingCredentialFile)) unlinkSync(pendingCredentialFile);
      delete env.EXPERT_WORKER_BOOTSTRAP_TOKEN;
      return saved;
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  const bootstrapToken = env.EXPERT_WORKER_BOOTSTRAP_TOKEN?.trim();
  const pendingCredentialFile = `${credentialFile}.pending`;
  const hubAddress = env.EXPERT_HUB_ADDRESS?.trim();
  const workerId = env.EXPERT_WORKER_ID?.trim();
  const capability = env.EXPERT_CAPABILITY?.trim();
  if (!bootstrapToken || !hubAddress || !workerId || !capability) {
    throw new Error("WORKER_CREDENTIAL_MISSING_CONFIGURE_BOOTSTRAP_OR_CREDENTIAL");
  }

  const caPath = env.EXPERT_TLS_CA_PATH?.trim();
  const certPath = env.EXPERT_TLS_CERT_PATH?.trim();
  const keyPath = env.EXPERT_TLS_KEY_PATH?.trim();
  const tlsCount = [caPath, certPath, keyPath].filter(Boolean).length;
  if (tlsCount !== 0 && tlsCount !== 3) throw new Error("INVALID_WORKER_CONFIG");
  const tls =
    tlsCount === 3
      ? { tls: { ca: readFileSync(caPath!), cert: readFileSync(certPath!), key: readFileSync(keyPath!) } }
      : {};

  if (!existsSync(pendingCredentialFile)) {
    mkdirSync(path.dirname(pendingCredentialFile), { recursive: true, mode: 0o750 });
    writeFileSync(pendingCredentialFile, `ewc_${randomBytes(32).toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  const proposedCredential = readFileSync(pendingCredentialFile, "utf8").trim();
  if (!/^ewc_[A-Za-z0-9_-]{43}$/.test(proposedCredential)) {
    throw new Error("WORKER_PENDING_CREDENTIAL_INVALID");
  }

  console.log(`Registering Worker ${workerId} with Hub; waiting for approval if required.`);
  while (true) {
    try {
      const response = await requestWorkerBootstrap(
        hubAddress,
        bootstrapToken,
        workerId,
        [capability],
        proposedCredential,
        tls,
      );
      if (response.credential) {
        if (response.credential !== proposedCredential) {
          throw new Error("WORKER_BOOTSTRAP_CREDENTIAL_MISMATCH");
        }
        linkSync(pendingCredentialFile, credentialFile);
        unlinkSync(pendingCredentialFile);
        delete env.EXPERT_WORKER_BOOTSTRAP_TOKEN;
        console.log(`Worker credential saved to ${credentialFile}; secret value was not logged.`);
        return response.credential;
      }
      if (response.status !== "pending") throw new Error("WORKER_BOOTSTRAP_CREDENTIAL_NOT_RETURNED");
      console.log("Worker is pending approval; retrying registration in 5 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      const code = grpcCode(error);
      if ([3, 6, 7, 16].includes(code ?? -1)) throw error;
      if (code !== 4 && code !== 14 && code !== 13) throw error;
      console.error("Worker bootstrap temporarily unavailable; retrying in 5 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

const workerCredential = await resolveWorkerCredential(process.env);
const config = parseExpertWorkerConfig({ ...process.env, EXPERT_WORKER_CREDENTIAL: workerCredential });
for (const directory of [config.sourcePath, config.repositoryRoot, config.sharedTempRoot].filter(Boolean)) {
  mkdirSync(directory, { recursive: true, mode: 0o750 });
}
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
