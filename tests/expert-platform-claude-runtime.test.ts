import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaudeReadOnlyArgs, parseClaudeResult } from "../src/expert-platform/claude-runtime.js";
import { createDockerCodexExecutor } from "../src/expert-platform/docker-codex-executor.js";
import type { Claim } from "../src/expert-platform/task-store.js";

const claim: Claim = { workerId: "w", taskId: "t", runId: "r", fencing: 1, problem: "Read-only OTA analysis" };

test("Claude CLI args enable only read-only tools and reject invalid model", () => {
  const args = buildClaudeReadOnlyArgs("Find OTA transitions", "sonnet");
  assert.ok(args.includes("Read,Glob,Grep"));
  assert.ok(args.includes("dontAsk"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args.at(-1), "Find OTA transitions");
  assert.ok(!args.some((a) => a.includes("bypassPermissions")));
  assert.throws(() => buildClaudeReadOnlyArgs("ok", "../../unsafe"), /INVALID_CLAUDE_REQUEST/);
});

test("Claude output accepts successful structured response and rejects failure or malformed response", () => {
  assert.equal(
    parseClaudeResult(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "source evidence" }),
    ),
    "source evidence",
  );
  for (const output of [
    "bad json",
    JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "error" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }),
  ]) {
    assert.throws(() => parseClaudeResult(output), /CLAUDE_/);
  }
});

test("Claude executor uses existing Docker isolation and selected model without Codex-only config mount", async () => {
  let args: readonly string[] = [];
  const stages: string[] = [];
  const executor = createDockerCodexExecutor({
    image: "team-skill-hub-expert-claude:0.1.0",
    backend: "claude",
    claudeModel: "sonnet",
    sourcePath: "/repo",
    network: "bridge",
    envNames: ["ANTHROPIC_API_KEY"],
    timeoutMs: 3000,
    runProcess: async (options) => {
      args = options.args;
      return "claude report";
    },
    onStage: async (_claim, stage) => {
      stages.push(stage);
    },
  });
  assert.equal(await executor(claim, new AbortController().signal), "claude report");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("type=bind,src=/repo,dst=/workspace,readonly"));
  assert.ok(args.includes("Read,Glob,Grep"));
  assert.ok(args.includes("CLAUDE_CONFIG_DIR=/home/expert/.claude"));
  assert.equal(args.at(-1), claim.problem);
  assert.ok(stages.includes("claude.started") && stages.includes("claude.completed"));
  assert.ok(!args.some((v) => v.startsWith("type=bind,src=") && v.includes("codex-auth")));
});

test("Claude Worker consumes Hub Anthropic model config and mapped AI Router credential without exposing secret in Docker args", async () => {
  const key = "expert-test-secret-not-in-args";
  const original = process.env.TEST_EXPERT_ROUTER_TOKEN;
  process.env.TEST_EXPERT_ROUTER_TOKEN = key;
  let args: readonly string[] = [];
  let env: NodeJS.ProcessEnv | undefined;
  try {
    const executor = createDockerCodexExecutor({
      backend: "claude",
      image: "expert-claude",
      sourcePath: "/repo",
      network: "bridge",
      envNames: ["TEST_EXPERT_ROUTER_TOKEN", "HTTPS_PROXY"],
      modelCredentialEnvNames: { "router-api": "TEST_EXPERT_ROUTER_TOKEN" },
      timeoutMs: 1000,
      runProcess: async (options) => {
        args = options.args;
        env = options.env;
        return "router result";
      },
    });
    const result = await executor(
      {
        ...claim,
        modelConfig: {
          providerId: "router",
          model: "claude-sonnet-router",
          baseUrl: "https://router.example/anthropic",
          wireApi: "anthropic-messages",
          credentialRef: "router-api",
          allowedEnvNames: ["TEST_EXPERT_ROUTER_TOKEN"],
        },
      },
      new AbortController().signal,
    );
    assert.equal(result, "router result");
    assert.ok(args.includes("claude-sonnet-router"));
    assert.ok(args.includes("ANTHROPIC_BASE_URL"));
    assert.ok(args.includes("ANTHROPIC_API_KEY"));
    assert.ok(!args.join(" ").includes(key));
    assert.equal(env?.ANTHROPIC_API_KEY, key);
    assert.equal(env?.ANTHROPIC_BASE_URL, "https://router.example/anthropic");
    assert.ok(!JSON.stringify(result).includes(key));
  } finally {
    if (original === undefined) delete process.env.TEST_EXPERT_ROUTER_TOKEN;
    else process.env.TEST_EXPERT_ROUTER_TOKEN = original;
  }
});

test("Claude rejects incompatible Responses config instead of silently ignoring it", async () => {
  const executor = createDockerCodexExecutor({
    backend: "claude",
    image: "expert-claude",
    sourcePath: "/repo",
    network: "bridge",
    envNames: ["ANTHROPIC_API_KEY"],
    timeoutMs: 1000,
    runProcess: async () => "unexpected",
  });
  await assert.rejects(
    () =>
      executor(
        {
          ...claim,
          modelConfig: {
            providerId: "router",
            model: "example",
            baseUrl: "https://router.example/v1",
            wireApi: "responses",
            allowedEnvNames: ["ANTHROPIC_API_KEY"],
          },
        },
        new AbortController().signal,
      ),
    /EXPERT_MODEL_PROTOCOL_MISMATCH/,
  );
});
