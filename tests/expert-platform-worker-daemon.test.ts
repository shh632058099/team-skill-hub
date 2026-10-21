import assert from "node:assert/strict";
import { test } from "node:test";
import { createExpertWorkerRuntime } from "../src/expert-platform/worker-daemon.js";

test("daemon composes client, Docker executor and one worker iteration", async () => {
  const calls: string[] = [];
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "default",
      modelEnvNames: ["OPENAI_API_KEY"],
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 60_000,
    },
    {
      createClient: () => ({
        claimTask: async () => {
          calls.push("claim");
          return null;
        },
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => calls.push("close"),
      }),
      createExecutor: () => async () => "unused",
    },
  );
  assert.equal(await runtime.runOnce(), false);
  runtime.close();
  assert.deepEqual(calls, ["claim", "close"]);
});

test("daemon forwards runtime configuration to Docker executor factory", () => {
  let seen: unknown;
  const runtime = createExpertWorkerRuntime(
    {
      hubAddress: "hub:7443",
      workerId: "ota-worker-01",
      workerCredential: "ewc_test",
      capability: "ota",
      sourcePath: "/srv/ota",
      dockerImage: "expert-worker",
      dockerNetwork: "expert-egress",
      dockerSeccompProfile: "unconfined",
      codexAuthFilePath: "/etc/expert/auth.json",
      codexConfigFilePath: "/etc/expert/provider.toml",
      modelEnvNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
      heartbeatMs: 1000,
      pollMs: 50,
      taskTimeoutMs: 90_000,
    },
    {
      createClient: () => ({
        claimTask: async () => null,
        renewLease: async () => undefined,
        completeTask: async () => undefined,
        failTask: async () => undefined,
        close: () => undefined,
      }),
      createExecutor: (options) => {
        seen = options;
        return async () => "unused";
      },
    },
  );
  assert.deepEqual(seen, {
    image: "expert-worker",
    sourcePath: "/srv/ota",
    network: "expert-egress",
    seccompProfile: "unconfined",
    envNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
    authFilePath: "/etc/expert/auth.json",
    configFilePath: "/etc/expert/provider.toml",
    timeoutMs: 90_000,
  });
  runtime.close();
});
