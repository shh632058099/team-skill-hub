import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildClaudeArgs, buildClaudeReadOnlyArgs, parseClaudeResult } from "../src/expert-platform/claude-runtime.js";
import { createDockerAgentExecutor } from "../src/expert-platform/docker-agent-executor.js";
import type { Claim } from "../src/expert-platform/task-store.js";

const claim: Claim = { workerId: "w", taskId: "t", runId: "r", fencing: 1, problem: "Read-only OTA analysis" };

test("Claude CLI args trust Docker isolation and do not restrict built-in tools", () => {
  const args = buildClaudeReadOnlyArgs("Find OTA transitions", "sonnet");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--tools") + 1], "default");
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args.at(-1), "Find OTA transitions");
  assert.throws(() => buildClaudeReadOnlyArgs("ok", "../../unsafe"), /INVALID_CLAUDE_REQUEST/);
});

test("Claude streaming args preserve unrestricted built-in tool access inside Docker", () => {
  const args = buildClaudeReadOnlyArgs("review code", "sonnet", true);
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--max-turns")), [
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--tools") + 1], "default");
  assert.ok(!args.includes("--allowedTools"));
});

test("Claude Work session persists and resumes with Docker-scoped unrestricted built-in tools", () => {
  const initial = buildClaudeArgs("Inspect OTA", "sonnet", true, 12, "read-only", { persist: true });
  assert.ok(!initial.includes("--no-session-persistence"));
  assert.equal(initial[initial.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(!initial.includes("--allowedTools"));

  const resumed = buildClaudeArgs("Continue OTA", "sonnet", true, 12, "workspace-write", {
    persist: true,
    resumeId: "22222222-2222-4222-8222-222222222222",
  });
  assert.ok(!resumed.includes("--no-session-persistence"));
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "22222222-2222-4222-8222-222222222222");
  assert.equal(resumed[resumed.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(!resumed.includes("--allowedTools"));
  assert.equal(resumed[resumed.indexOf("--tools") + 1], "default");
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
  const executor = createDockerAgentExecutor({
    image: "team-skill-hub-expert-claude:0.1.0",
    backend: "claude",
    claudeModel: "sonnet",
    claudeMaxTurns: 64,
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
  assert.equal(args[args.indexOf("--max-turns") + 1], "64");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("type=bind,src=/repo,dst=/workspace,readonly"));
  assert.equal(args[args.indexOf("--tools") + 1], "default");
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
    const executor = createDockerAgentExecutor({
      backend: "claude",
      claudeMaxTurns: 25,
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
    assert.equal(args[args.indexOf("--max-turns") + 1], "25");
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
  const executor = createDockerAgentExecutor({
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

test("Claude Router credential reference can target ANTHROPIC_AUTH_TOKEN", async () => {
  const previous = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "synthetic-test-value";
  try {
    let seen: { args: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;
    const executor = createDockerAgentExecutor({
      backend: "claude",
      image: "expert-claude",
      sourcePath: "/repo",
      network: "bridge",
      envNames: ["ANTHROPIC_AUTH_TOKEN"],
      modelCredentialEnvNames: { gateway: "ANTHROPIC_AUTH_TOKEN" },
      timeoutMs: 1000,
      runProcess: async (options) => {
        seen = options;
        return "ok";
      },
    });
    await executor(
      {
        ...claim,
        modelConfig: {
          providerId: "router",
          model: "gpt-5.6-luna",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages",
          credentialRef: "gateway",
          allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
        },
      },
      new AbortController().signal,
    );
    assert.equal(seen?.env?.ANTHROPIC_AUTH_TOKEN, "synthetic-test-value");
    assert.equal(seen?.env?.ANTHROPIC_BASE_URL, "https://router.example/v1");
    assert.ok(!seen?.args.join(" ").includes("synthetic-test-value"));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous;
  }
});

test("Claude max turns is configurable and validated", () => {
  const args = buildClaudeReadOnlyArgs("inspect", "sonnet", false, 38);
  assert.equal(args[args.indexOf("--max-turns") + 1], "38");
  assert.equal(buildClaudeReadOnlyArgs("inspect", "sonnet")[5], "12");
  assert.equal(buildClaudeReadOnlyArgs("inspect", "sonnet", false, 5000)[5], "5000");
  for (const bad of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => buildClaudeReadOnlyArgs("inspect", "sonnet", false, bad), /INVALID_CLAUDE_MAX_TURNS/);
  }
});

test("Claude workspace-write leaves all built-in tools available inside the isolated container", () => {
  const args = buildClaudeArgs("modify fixture", "sonnet", false, 12, "workspace-write");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--tools") + 1], "default");
  assert.ok(!args.includes("--allowedTools"));
});

test("Claude workspace-write profile gets rw workspace while keeping container root read-only", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "synthetic";
  const root = mkdtempSync(path.join(os.tmpdir(), "expert-claude-write-"));
  const origin = path.join(root, "origin");
  const checkouts = path.join(root, "checkouts");
  try {
    execFileSync("git", ["init", "-b", "main", origin]);
    writeFileSync(path.join(origin, "README.md"), "fixture\n");
    execFileSync("git", ["-C", origin, "add", "."]);
    execFileSync("git", [
      "-C",
      origin,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "base",
    ]);

    let args: readonly string[] = [];
    const modelConfig = {
      providerId: "router",
      model: "sonnet",
      baseUrl: "https://router.example/anthropic",
      wireApi: "anthropic-messages" as const,
      allowedEnvNames: ["ANTHROPIC_API_KEY"],
    };
    const executor = createDockerAgentExecutor({
      backend: "claude",
      image: "expert-claude",
      sourcePath: origin,
      repositoryRoot: checkouts,
      network: "bridge",
      envNames: ["ANTHROPIC_API_KEY"],
      timeoutMs: 1000,
      onStage: async () => undefined,
      runProcess: async (options) => {
        args = options.args;
        return "done";
      },
    });
    await executor(
      {
        ...claim,
        repositoryId: "repo-claude-write",
        repositoryUrl: origin,
        repositoryBranch: "main",
        workspaceKey: "work-claude-write-a1",
        modelConfig,
        deploymentSnapshot: {
          deploymentId: "claude-write",
          configVersion: 1,
          runtimeProfile: "claude-workspace-write",
          repository: { id: "repo-claude-write", url: origin, branch: "main" },
          executor: { backend: "claude", modelConfig },
        },
      },
      new AbortController().signal,
    );
    assert.ok(args.includes("--read-only"), "rootfs stays read-only");
    const workspaceMount = args.find((arg) => arg.includes(",dst=/workspace"));
    assert.ok(workspaceMount);
    assert.match(workspaceMount!, /work-claude-write-a1/);
    assert.ok(!workspaceMount!.endsWith(",readonly"));
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args[args.indexOf("--tools") + 1], "default");
    assert.ok(!args.includes("--allowedTools"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});
