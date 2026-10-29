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

test("Worker MCP configuration is isolated, read-only and never leaks a key into Docker argv", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-mcp-scope-"));
  const keyFile = path.join(dir, "worker-readonly");
  const key = "skh_" + "a".repeat(43);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const modelConfig = {
    providerId: "router",
    model: "test-model",
    baseUrl: "https://router.example/v1",
    wireApi: "responses" as const,
    allowedEnvNames: ["OPENAI_API_KEY"],
  };
  const createClaim = (backend: "codex" | "claude"): Claim => {
    const model =
      backend === "codex"
        ? modelConfig
        : { ...modelConfig, wireApi: "anthropic-messages" as const, allowedEnvNames: ["ANTHROPIC_API_KEY"] };
    return {
      ...claim,
      modelConfig: model,
      deploymentSnapshot: {
        deploymentId: "deployment",
        configVersion: 1,
        runtimeProfile: "readonly",
        repository: { id: "repo", url: "https://example.org/repo.git", branch: "main" },
        executor: { backend, modelConfig: model },
        mcp: {
          credentialRef: "read-only",
          urlOverride: "http://hub.internal:8080/mcp",
          allowedTools: ["search_skills", "search_knowledge"],
          required: true,
        },
      },
    };
  };
  const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fake-test-model-key";
  const originalUmask = process.umask(0o077);
  try {
    for (const backend of ["codex", "claude"] as const) {
      let mounted = "";
      const executor = createDockerCodexExecutor({
        backend,
        image: "expert-image",
        sourcePath: "/work/repo",
        network: "expert-network",
        envNames: backend === "codex" ? ["OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY"],
        mcpCredentialFiles: { "read-only": keyFile },
        timeoutMs: 1000,
        runProcess: async (options) => {
          const argv = options.args.join(" ");
          assert.ok(!argv.includes(key), "Docker arguments must not contain secrets");
          assert.ok(!argv.includes("--network host"));
          const pathSuffix =
            backend === "codex" ? ",dst=/run/codex-config.toml,readonly" : ",dst=/run/expert-mcp.json,readonly";
          const mount = options.args.find((arg) => arg.endsWith(pathSuffix));
          assert.ok(mount);
          mounted = mount!.slice("type=bind,src=".length, -pathSuffix.length);
          const content = readFileSync(mounted, "utf8");
          assert.equal(
            statSync(mounted).mode & 0o777,
            0o644,
            "container config must remain readable under worker umask 0077",
          );
          assert.doesNotMatch(content, /submit_expert_task/);
          if (backend === "codex") {
            assert.match(content, /search_skills/);
            assert.match(content, /enabled_tools/);
            assert.match(content, /default_tools_approval_mode = "approve"/);
            assert.match(content, /\[mcp_servers\.skillhub\.tools\.search_skills\]/);
            assert.match(content, /approval_mode = "approve"/);
            assert.ok(options.args.includes("SKILLHUB_EXPERT_MCP_API_KEY"));
            assert.equal(options.env?.SKILLHUB_EXPERT_MCP_API_KEY, key);
            assert.ok(!content.includes(key));
          } else {
            assert.ok(content.includes(key), "Claude's task-specific config contains the necessary key");
            assert.ok(options.args.includes("--strict-mcp-config"));
            assert.ok(argv.includes("mcp__skillhub__search_skills"));
          }
          return "ok";
        },
      });
      assert.equal(await executor(createClaim(backend), new AbortController().signal), "ok");
      assert.equal(existsSync(mounted), false, "temporary task MCP config must be deleted");
    }
  } finally {
    process.umask(originalUmask);
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Docker Codex executor runs codex JSONL through docker with read-only source", async () => {
  let seen: { executable: string; args: readonly string[]; signal?: AbortSignal } | undefined;
  const executor = createDockerCodexExecutor({
    backend: "codex",
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
    backend: "codex",
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
    backend: "codex",
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
    backend: "codex",
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
    backend: "codex",
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

test("Docker executor emits only bounded stage codes for successful execution", async () => {
  const stages: string[] = [];
  const execute = createDockerCodexExecutor({
    backend: "codex",
    image: "expert-image",
    sourcePath: "/work/repo",
    network: "bridge",
    envNames: ["OPENAI_API_KEY"],
    timeoutMs: 1000,
    onStage: async (_claim, stage, details) => {
      stages.push(stage + (details ? ":" + details : ""));
    },
    runProcess: async () => "safe result",
  });
  assert.equal(await execute(claim, new AbortController().signal), "safe result");
  assert.deepEqual(stages, [
    "repository.started",
    "repository.completed",
    "container.started",
    "codex.started",
    "codex.completed",
    "container.completed",
  ]);
});

test("Docker executor emits generic failure codes, not raw process stderr", async () => {
  const stages: string[] = [];
  const execute = createDockerCodexExecutor({
    backend: "codex",
    image: "expert-image",
    sourcePath: "/work/repo",
    network: "bridge",
    envNames: ["OPENAI_API_KEY"],
    timeoutMs: 1000,
    onStage: async (_claim, stage, details) => {
      stages.push(stage + (details ? ":" + details : ""));
    },
    runProcess: async () => {
      throw new Error("Bearer never-log-this-secret");
    },
  });
  await assert.rejects(() => execute(claim, new AbortController().signal), /never-log-this-secret/);
  assert.ok(stages.includes("codex.failed:EXECUTION_FAILED"));
  assert.ok(stages.includes("container.failed:EXECUTION_FAILED"));
  assert.doesNotMatch(stages.join(" "), /never-log-this-secret/);
});
