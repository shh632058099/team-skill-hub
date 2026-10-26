import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { test } from "node:test";
import { createDockerCodexExecutor } from "../src/expert-platform/docker-codex-executor.js";
import type { Claim } from "../src/expert-platform/task-store.js";

const claim: Claim = {
  workerId: "worker-1",
  taskId: "task-1",
  runId: "run-1",
  fencing: 1,
  problem: "Investigate OTA failure",
};

test("Docker Codex executor runs codex JSONL through docker with read-only source", async () => {
  let seen: { executable: string; args: readonly string[]; signal?: AbortSignal } | undefined;
  const executor = createDockerCodexExecutor({
    image: "team-skill-hub-expert-worker-prototype",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: ["OPENAI_API_KEY"],
    timeoutMs: 1000,
    runProcess: async (options) => {
      seen = options;
      return "container result";
    },
  });
  const signal = new AbortController().signal;
  assert.equal(await executor(claim, signal), "container result");
  assert.equal(seen?.executable, "docker");
  assert.ok(seen?.args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(seen?.args.includes("team-skill-hub-expert-worker-prototype"));
  assert.ok(seen?.args.includes("OPENAI_API_KEY"));
  assert.ok(seen?.args.includes("--json"));
  assert.equal(seen?.args.at(-1), claim.problem);
  assert.equal(seen?.signal, signal);
});

test("Docker Codex executor mounts an isolated per-expert provider config", async () => {
  let seen: { executable: string; args: readonly string[] } | undefined;
  let generatedPath = "";
  let generatedContent = "";
  const modelClaim: Claim = {
    ...claim,
    modelConfig: {
      providerId: "bst",
      model: "gpt-5.6-luna",
      baseUrl: "https://route.briancs.shop/v1",
      wireApi: "responses",
      allowedEnvNames: ["OPENAI_API_KEY"],
    },
  };
  const executor = createDockerCodexExecutor({
    image: "expert-worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
    timeoutMs: 1000,
    runProcess: async (options) => {
      seen = options;
      const mount = options.args.find(
        (arg) => arg.startsWith("type=bind,src=") && arg.endsWith(",dst=/run/codex-config.toml,readonly"),
      );
      assert.ok(mount);
      generatedPath = mount!.slice("type=bind,src=".length, -",dst=/run/codex-config.toml,readonly".length);
      generatedContent = readFileSync(generatedPath, "utf8");
      assert.equal(
        statSync(generatedPath).mode & 0o777,
        0o644,
        "container's non-root user must be able to read non-secret model config",
      );
      return "expert-specific result";
    },
  });
  const originalUmask = process.umask(0o077);
  try {
    assert.equal(await executor(modelClaim, new AbortController().signal), "expert-specific result");
  } finally {
    process.umask(originalUmask);
  }
  assert.match(generatedContent, /model = "gpt-5\.6-luna"/);
  assert.match(generatedContent, /model_provider = "bst"/);
  assert.match(generatedContent, /base_url = "https:\/\/route\.briancs\.shop\/v1"/);
  assert.ok(seen?.args.includes("OPENAI_API_KEY"));
  assert.ok(seen?.args.includes("HTTPS_PROXY"));
  assert.equal(existsSync(generatedPath), false, "temporary provider config must be removed after execution");
});

test("Docker Codex executor requires a configured secret reference and rejects env expansion", async () => {
  const executor = createDockerCodexExecutor({
    image: "expert-worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: ["OPENAI_API_KEY"],
    modelCredentialEnvNames: {},
    timeoutMs: 1000,
    runProcess: async () => "should not run",
  });
  await assert.rejects(
    () =>
      executor(
        {
          ...claim,
          modelConfig: {
            providerId: "bst",
            model: "m",
            baseUrl: "https://router.example/v1",
            wireApi: "responses",
            credentialRef: "missing",
            allowedEnvNames: ["OPENAI_API_KEY"],
          },
        },
        new AbortController().signal,
      ),
    /EXPERT_MODEL_CREDENTIAL_NOT_CONFIGURED/,
  );
  await assert.rejects(
    () =>
      executor(
        {
          ...claim,
          modelConfig: {
            providerId: "bst",
            model: "m",
            baseUrl: "https://router.example/v1",
            wireApi: "responses",
            allowedEnvNames: ["NODE_OPTIONS"],
          },
        },
        new AbortController().signal,
      ),
    /EXPERT_MODEL_ENV_NOT_ALLOWED/,
  );
});

test("Docker Codex executor fails closed when a new-style repository ID has no resolved source", async () => {
  let ran = false;
  const executor = createDockerCodexExecutor({
    image: "expert-worker",
    sourcePath: "/work/default-repo",
    network: "expert-egress",
    envNames: [],
    timeoutMs: 1000,
    runProcess: async () => {
      ran = true;
      return "must not run";
    },
  });
  await assert.rejects(
    () => executor({ ...claim, repositoryId: "repo-0123456789abcdefabcd" }, new AbortController().signal),
    /SOURCE_REPOSITORY_UNAVAILABLE/,
  );
  assert.equal(ran, false, "must not analyze the default worker source directory");
});

test("Docker Codex executor labels UUID-backed execution with task, run and fencing", async () => {
  const taskId = "71950fc2-e7e3-45fd-af39-0697e00ac219";
  const runId = "7cf042dc-33e2-48f3-a1ce-eea40ec4ba08";
  let args: readonly string[] = [];
  const executor = createDockerCodexExecutor({
    image: "expert-worker",
    sourcePath: "/work/repo",
    network: "bridge",
    envNames: [],
    timeoutMs: 1000,
    runProcess: async (options) => {
      args = options.args;
      return "test";
    },
  });
  await executor({ ...claim, taskId, runId, fencing: 2 }, new AbortController().signal);
  assert.ok(args.includes("team-skill-hub.expert-managed=1"));
  assert.ok(args.includes(`team-skill-hub.task-id=${taskId}`));
  assert.ok(args.includes(`team-skill-hub.run-id=${runId}`));
  assert.ok(args.includes("team-skill-hub.fencing=2"));
});
