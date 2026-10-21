import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExpertWorkerConfig } from "../src/expert-platform/worker-runtime-config.js";

test("worker runtime config parses a cross-host Docker Codex deployment", () => {
  const config = parseExpertWorkerConfig({
    EXPERT_HUB_ADDRESS: "hub.internal:7443",
    EXPERT_WORKER_ID: "ota-worker-01",
    EXPERT_WORKER_CREDENTIAL: "ewc_example",
    EXPERT_CAPABILITY: "ota",
    EXPERT_SOURCE_PATH: "/srv/repos/ota",
    EXPERT_DOCKER_IMAGE: "team-skill-hub-expert-worker-prototype",
    EXPERT_DOCKER_NETWORK: "expert-egress",
    EXPERT_DOCKER_SECCOMP_PROFILE: "unconfined",
    EXPERT_CODEX_AUTH_FILE: "/home/worker/.codex/auth.json",
    EXPERT_CODEX_CONFIG_FILE: "/etc/expert/ota-codex.toml",
    EXPERT_MODEL_ENV_NAMES: "OPENAI_API_KEY,HTTPS_PROXY,NO_PROXY",
    EXPERT_HEARTBEAT_MS: "10000",
    EXPERT_POLL_MS: "3000",
    EXPERT_TASK_TIMEOUT_MS: "90000",
    EXPERT_TLS_CA_PATH: "/etc/expert/ca.pem",
    EXPERT_TLS_CERT_PATH: "/etc/expert/worker.pem",
    EXPERT_TLS_KEY_PATH: "/etc/expert/worker-key.pem",
  });
  assert.equal(config.hubAddress, "hub.internal:7443");
  assert.equal(config.workerId, "ota-worker-01");
  assert.equal(config.capability, "ota");
  assert.equal(config.sourcePath, "/srv/repos/ota");
  assert.equal(config.dockerSeccompProfile, "unconfined");
  assert.equal(config.codexAuthFilePath, "/home/worker/.codex/auth.json");
  assert.equal(config.codexConfigFilePath, "/etc/expert/ota-codex.toml");
  assert.deepEqual(config.modelEnvNames, ["OPENAI_API_KEY", "HTTPS_PROXY", "NO_PROXY"]);
  assert.equal(config.heartbeatMs, 10_000);
  assert.equal(config.pollMs, 3_000);
  assert.equal(config.taskTimeoutMs, 90_000);
  assert.equal(config.tlsCaPath, "/etc/expert/ca.pem");
  assert.equal(config.tlsCertPath, "/etc/expert/worker.pem");
  assert.equal(config.tlsKeyPath, "/etc/expert/worker-key.pem");
});

test("worker runtime config rejects incomplete mTLS configuration", () => {
  assert.throws(
    () =>
      parseExpertWorkerConfig({
        EXPERT_HUB_ADDRESS: "hub:7443",
        EXPERT_WORKER_ID: "w",
        EXPERT_WORKER_CREDENTIAL: "token",
        EXPERT_CAPABILITY: "ota",
        EXPERT_SOURCE_PATH: "/repo",
        EXPERT_DOCKER_IMAGE: "worker",
        EXPERT_DOCKER_NETWORK: "expert-egress",
        EXPERT_TLS_CA_PATH: "/ca.pem",
      }),
    /INVALID_WORKER_CONFIG/,
  );
});

test("worker runtime config fails closed on invalid paths and intervals", () => {
  assert.throws(
    () =>
      parseExpertWorkerConfig({
        EXPERT_HUB_ADDRESS: "hub:7443",
        EXPERT_WORKER_ID: "w",
        EXPERT_WORKER_CREDENTIAL: "token",
        EXPERT_CAPABILITY: "ota",
        EXPERT_SOURCE_PATH: "relative",
        EXPERT_DOCKER_IMAGE: "worker",
        EXPERT_DOCKER_NETWORK: "expert-egress",
      }),
    /INVALID_WORKER_CONFIG/,
  );
  assert.throws(
    () =>
      parseExpertWorkerConfig({
        EXPERT_HUB_ADDRESS: "hub:7443",
        EXPERT_WORKER_ID: "w",
        EXPERT_WORKER_CREDENTIAL: "token",
        EXPERT_CAPABILITY: "ota",
        EXPERT_SOURCE_PATH: "/repo",
        EXPERT_DOCKER_IMAGE: "worker",
        EXPERT_DOCKER_NETWORK: "host",
      }),
    /INVALID_WORKER_CONFIG/,
  );
});

test("worker runtime config rejects a relative Codex provider config path", () => {
  assert.throws(
    () =>
      parseExpertWorkerConfig({
        EXPERT_HUB_ADDRESS: "hub:7443",
        EXPERT_WORKER_ID: "w",
        EXPERT_WORKER_CREDENTIAL: "token",
        EXPERT_CAPABILITY: "ota",
        EXPERT_SOURCE_PATH: "/repo",
        EXPERT_DOCKER_IMAGE: "worker",
        EXPERT_DOCKER_NETWORK: "expert-egress",
        EXPERT_CODEX_CONFIG_FILE: "provider.toml",
      }),
    /INVALID_WORKER_CONFIG/,
  );
});
