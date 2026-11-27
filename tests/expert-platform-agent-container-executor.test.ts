import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentDockerArgs } from "../src/expert-platform/agent-container-executor.js";

test("Docker Codex executor builds a constrained read-only invocation", () => {
  const args = buildAgentDockerArgs({
    image: "team-skill-hub-expert-worker-prototype",
    sourcePath: "/work/repo",
    network: "expert-egress",
    supplementalGroupId: 988,
    primaryGroupId: 988,
    envNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
    commandArgs: ["exec", "--sandbox", "read-only", "--json", "inspect"],
  });
  assert.deepEqual(args.slice(0, 10), [
    "run",
    "--rm",
    "--init",
    "--network",
    "expert-egress",
    "--read-only",
    "--user",
    "10001:988",
    "--cap-drop",
    "ALL",
  ]);
  assert.ok(args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(!args.includes("--group-add"), "primary shared GID does not need a duplicate supplemental group");
  assert.ok(args.includes("OPENAI_API_KEY"));
  assert.ok(args.includes("HTTPS_PROXY"));
  assert.ok(args.includes("/home/expert:rw,uid=10001,gid=988,size=64m"));
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "HOME=/home/expert"));
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "CODEX_HOME=/home/expert/.codex"));
  assert.ok(!args.some((arg, index) => arg === "--env" && (!args[index + 1] || args[index + 1]!.startsWith("--"))));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(!args.includes("seccomp=unconfined"));
  assert.ok(args.includes("512m"));
  assert.ok(args.includes("2"));
  assert.equal(args.at(-6), "team-skill-hub-expert-worker-prototype");
});

test("Docker agent scratch tmpfs permits executing locally built tools and tests", () => {
  const args = buildAgentDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    primaryGroupId: 988,
    envNames: [],
    commandArgs: ["exec", "inspect"],
  });

  assert.ok(args.includes("/tmp:rw,exec,uid=10001,gid=988,size=32m"));
});

test("single-uid-v2 agent uses Worker identity, executable scratch, and read-only git metadata", () => {
  const args = buildAgentDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    workspaceAccess: "read-write",
    network: "expert-egress",
    supplementalGroupId: 1234,
    primaryGroupId: 988,
    runAsUid: 999,
    runAsGid: 988,
    gitMetadataPath: "/work/repo/.git",
    envNames: [],
    commandArgs: ["exec", "edit"],
  } as any);

  assert.ok(args.some((arg, index) => arg === "--user" && args[index + 1] === "999:988"));
  assert.ok(!args.includes("--group-add"), "v2 must not inherit supplementary groups");
  assert.ok(args.includes("type=bind,src=/work/repo,dst=/workspace"));
  assert.ok(args.includes("type=bind,src=/work/repo/.git,dst=/workspace/.git,readonly"));
  assert.ok(args.includes("/tmp:rw,exec,uid=999,gid=988,size=32m"));
  assert.ok(args.includes("/home/expert:rw,uid=999,gid=988,size=64m"));
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "GIT_OPTIONAL_LOCKS=0"));
});

test("single-uid-v2 agent rejects root or partial execution identity", () => {
  const base = {
    image: "worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: [],
    commandArgs: ["exec", "edit"],
  };
  assert.throws(() => buildAgentDockerArgs({ ...base, runAsUid: 0, runAsGid: 988 } as any), /INVALID_RUN_AS_IDENTITY/);
  assert.throws(() => buildAgentDockerArgs({ ...base, runAsUid: 999 } as any), /INVALID_RUN_AS_IDENTITY/);
});

test("Docker Codex executor rejects host networking and protected env names", () => {
  assert.throws(
    () =>
      buildAgentDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "host",
        envNames: ["OPENAI_API_KEY"],
        commandArgs: ["--version"],
      }),
    /INVALID_NETWORK/,
  );
  assert.throws(
    () =>
      buildAgentDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: ["PATH"],
        commandArgs: ["--version"],
      }),
    /INVALID_ENV_NAME/,
  );
  assert.throws(
    () =>
      buildAgentDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: ["CODEX_HOME"],
        commandArgs: ["--version"],
      }),
    /INVALID_ENV_NAME/,
  );
});

test("Docker Codex executor mounts a per-worker provider config and API key env", () => {
  const args = buildAgentDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    seccompProfile: "unconfined",
    envNames: ["DEEPSEEK_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "HTTPS_PROXY"],
    configFilePath: "/etc/expert/deepseek-codex.toml",
    commandArgs: ["exec", "--sandbox", "read-only", "--json", "inspect"],
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
      buildAgentDockerArgs({
        image: "expert-worker",
        containerName: "bad name; rm -rf /",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: [],
        commandArgs: ["exec", "task"],
      }),
    /INVALID_CONTAINER_NAME/,
  );
});

test("Docker Codex executor makes only workspace writable while root and config mounts remain read-only", () => {
  const args = buildAgentDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    workspaceAccess: "read-write",
    network: "expert-egress",
    envNames: [],
    authFilePath: "/etc/expert/auth.json",
    configFilePath: "/etc/expert/config.toml",
    mcpConfigFilePath: "/etc/expert/mcp.json",
    commandArgs: ["exec", "--sandbox", "workspace-write", "--json", "edit"],
  });
  assert.ok(args.includes("--read-only"), "container rootfs must remain read-only");
  assert.ok(args.includes("type=bind,src=/work/repo,dst=/workspace"));
  assert.ok(!args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(args.includes("type=bind,src=/etc/expert/auth.json,dst=/run/codex-auth.json,readonly"));
  assert.ok(args.includes("type=bind,src=/etc/expert/config.toml,dst=/run/codex-config.toml,readonly"));
  assert.ok(args.includes("type=bind,src=/etc/expert/mcp.json,dst=/run/expert-mcp.json,readonly"));
});

test("Docker executor bind-mounts only an explicit runtime session directory", () => {
  const args = buildAgentDockerArgs({
    image: "worker",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: [],
    runtimeStatePath: "/work/work-1/.runtime-session/codex",
    runtimeStateTarget: "/home/expert/.codex",
    commandArgs: ["exec", "--json", "inspect"],
  });
  assert.ok(args.includes("type=bind,src=/work/work-1/.runtime-session/codex,dst=/home/expert/.codex"));
  assert.throws(
    () =>
      buildAgentDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: [],
        runtimeStatePath: "../escape",
        runtimeStateTarget: "/home/expert/.codex",
        commandArgs: ["exec", "inspect"],
      }),
    /INVALID_RUNTIME_STATE_PATH/,
  );
  assert.throws(
    () =>
      buildAgentDockerArgs({
        image: "worker",
        sourcePath: "/work/repo",
        network: "expert-egress",
        envNames: [],
        runtimeStatePath: "/work/runtime",
        runtimeStateTarget: "/etc",
        commandArgs: ["exec", "inspect"],
      }),
    /INVALID_RUNTIME_STATE_TARGET/,
  );
});
