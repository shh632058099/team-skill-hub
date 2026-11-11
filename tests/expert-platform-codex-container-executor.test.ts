import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexDockerArgs } from "../src/expert-platform/codex-container-executor.js";

test("Docker Codex executor builds a constrained read-only invocation", () => {
  const args = buildCodexDockerArgs({
    image: "team-skill-hub-expert-worker-prototype",
    sourcePath: "/work/repo",
    network: "expert-egress",
    supplementalGroupId: 988,
    envNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
    codexArgs: ["exec", "--sandbox", "read-only", "--json", "inspect"],
  });
  assert.deepEqual(args.slice(0, 10), [
    "run",
    "--rm",
    "--init",
    "--network",
    "expert-egress",
    "--read-only",
    "--group-add",
    "988",
    "--cap-drop",
    "ALL",
  ]);
  assert.ok(args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(args.some((arg, index) => arg === "--group-add" && args[index + 1] === "988"));
  assert.ok(args.includes("OPENAI_API_KEY"));
  assert.ok(args.includes("HTTPS_PROXY"));
  assert.ok(args.includes("/home/expert:rw,uid=10001,gid=10001,size=64m"));
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "HOME=/home/expert"));
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "CODEX_HOME=/home/expert/.codex"));
  assert.ok(!args.some((arg, index) => arg === "--env" && (!args[index + 1] || args[index + 1]!.startsWith("--"))));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(!args.includes("seccomp=unconfined"));
  assert.ok(args.includes("512m"));
  assert.ok(args.includes("2"));
  assert.equal(args.at(-6), "team-skill-hub-expert-worker-prototype");
});

test("Docker Codex executor rejects host networking and protected env names", () => {
  assert.throws(
    () =>
      buildCodexDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "host",
        envNames: ["OPENAI_API_KEY"],
        codexArgs: ["--version"],
      }),
    /INVALID_NETWORK/,
  );
  assert.throws(
    () =>
      buildCodexDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: ["PATH"],
        codexArgs: ["--version"],
      }),
    /INVALID_ENV_NAME/,
  );
  assert.throws(
    () =>
      buildCodexDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: ["CODEX_HOME"],
        codexArgs: ["--version"],
      }),
    /INVALID_ENV_NAME/,
  );
});

test("Docker Codex executor mounts a per-worker provider config and API key env", () => {
  const args = buildCodexDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    seccompProfile: "unconfined",
    envNames: ["DEEPSEEK_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "HTTPS_PROXY"],
    configFilePath: "/etc/expert/deepseek-codex.toml",
    codexArgs: ["exec", "--sandbox", "read-only", "--json", "inspect"],
  });

  assert.ok(args.includes("type=bind,src=/etc/expert/deepseek-codex.toml,dst=/run/codex-config.toml,readonly"));
  assert.ok(args.includes("seccomp=unconfined"));
  assert.ok(args.includes("DEEPSEEK_API_KEY"));
  assert.ok(args.includes("AWS_BEARER_TOKEN_BEDROCK"));
  assert.ok(!args.some((arg) => arg.includes("/root/.codex/config.toml")));
});

test("Docker executor rejects unsafe per-task container names", () => {
  assert.throws(
    () =>
      buildCodexDockerArgs({
        image: "expert-worker",
        containerName: "bad name; rm -rf /",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: [],
        codexArgs: ["exec", "task"],
      }),
    /INVALID_CONTAINER_NAME/,
  );
});

test("Docker Codex executor makes only workspace writable while root and config mounts remain read-only", () => {
  const args = buildCodexDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    workspaceAccess: "read-write",
    network: "expert-egress",
    envNames: [],
    authFilePath: "/etc/expert/auth.json",
    configFilePath: "/etc/expert/config.toml",
    mcpConfigFilePath: "/etc/expert/mcp.json",
    codexArgs: ["exec", "--sandbox", "workspace-write", "--json", "edit"],
  });
  assert.ok(args.includes("--read-only"), "container rootfs must remain read-only");
  assert.ok(args.includes("type=bind,src=/work/repo,dst=/workspace"));
  assert.ok(!args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(args.includes("type=bind,src=/etc/expert/auth.json,dst=/run/codex-auth.json,readonly"));
  assert.ok(args.includes("type=bind,src=/etc/expert/config.toml,dst=/run/codex-config.toml,readonly"));
  assert.ok(args.includes("type=bind,src=/etc/expert/mcp.json,dst=/run/expert-mcp.json,readonly"));
});

test("Docker executor bind-mounts only an explicit runtime session directory", () => {
  const args = buildCodexDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: [],
    runtimeStatePath: "/work/work-1/.runtime-session/codex",
    runtimeStateTarget: "/home/expert/.codex",
    codexArgs: ["exec", "--json", "inspect"],
  });
  assert.ok(args.includes("type=bind,src=/work/work-1/.runtime-session/codex,dst=/home/expert/.codex"));
  assert.throws(
    () =>
      buildCodexDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: [],
        runtimeStatePath: "../escape",
        runtimeStateTarget: "/home/expert/.codex",
        codexArgs: ["exec", "inspect"],
      }),
    /INVALID_RUNTIME_STATE_PATH/,
  );
  assert.throws(
    () =>
      buildCodexDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: [],
        runtimeStatePath: "/work/runtime",
        runtimeStateTarget: "/etc",
        codexArgs: ["exec", "inspect"],
      }),
    /INVALID_RUNTIME_STATE_TARGET/,
  );
});
