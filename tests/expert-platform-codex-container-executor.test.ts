import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexDockerArgs } from "../src/expert-platform/codex-container-executor.js";

test("Docker Codex executor builds a constrained read-only invocation", () => {
  const args = buildCodexDockerArgs({
    image: "team-skill-hub-expert-worker-prototype",
    sourcePath: "/work/repo",
    network: "expert-egress",
    envNames: ["OPENAI_API_KEY", "HTTPS_PROXY"],
    codexArgs: ["exec", "--sandbox", "read-only", "--json", "inspect"],
  });
  assert.deepEqual(args.slice(0, 8), [
    "run",
    "--rm",
    "--init",
    "--network",
    "expert-egress",
    "--read-only",
    "--cap-drop",
    "ALL",
  ]);
  assert.ok(args.includes("type=bind,src=/work/repo,dst=/workspace,readonly"));
  assert.ok(args.includes("OPENAI_API_KEY"));
  assert.ok(args.includes("HTTPS_PROXY"));
  assert.ok(args.includes("/home/expert:rw,uid=10001,gid=10001,size=64m"));
  assert.ok(args.includes("HOME=/home/expert"));
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
