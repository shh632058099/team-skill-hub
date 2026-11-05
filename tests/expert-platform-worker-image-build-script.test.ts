import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/build-worker-image.sh", import.meta.url).pathname;
const root = path.resolve(path.dirname(script), "..");

function fixture(serverVersion: string, extraEnv: Record<string, string> = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "worker-image-build-test-"));
  const logfile = path.join(temp, "docker.log");
  const docker = path.join(temp, "docker");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALL_LOG"
case "$1 $2" in
  'version --format') printf '%s\\n' "${serverVersion}" ;;
  'image inspect') [ \"$MOCK_BASE_PRESENT\" = '1' ] && exit 0 || exit 1 ;;
  build*)
    previous=''
    for arg in "$@"; do
      if [ "$previous" = '-f' ]; then cat "$arg" >> "$DOCKER_CALL_LOG.generated"; fi
      previous="$arg"
    done
    ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(docker, 0o755);
  const env = {
    ...process.env,
    PATH: `${temp}:${process.env.PATH}`,
    DOCKER_CALL_LOG: logfile,
    ...extraEnv,
  };
  return { temp, logfile, env };
}

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
}

test("auto mode selects legacy for old Docker Server and standard for modern Docker Server", () => {
  for (const [version, expected] of [
    ["18.09.9", "legacy"],
    ["20.10.0", "standard"],
    ["27.5.1", "standard"],
  ] as const) {
    const f = fixture(version);
    try {
      const result = run(f.env, "codex", "2.3.4");
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(f.logfile, "utf8");
      if (expected === "legacy") {
        assert.match(calls, /build -f .*Dockerfile\.legacy .*team-skill-hub-expert-worker:2\.3\.4/);
        assert.match(calls, /run --rm team-skill-hub-expert-worker:2\.3\.4/);
      } else {
        assert.match(calls, /build --pull -f .*Dockerfile .*team-skill-hub-expert-worker:2\.3\.4/);
        assert.doesNotMatch(calls, /run --rm/);
      }
      assert.match(result.stdout, /expert-worker-image-2\.3\.4\.tar/);
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  }
});

test("BUILD_MODE can force standard or legacy independent of Docker version", () => {
  for (const [mode, version, expected] of [
    ["legacy", "27.0.0", "legacy"],
    ["standard", "18.09.0", "standard"],
  ] as const) {
    const f = fixture(version, { BUILD_MODE: mode });
    try {
      const result = run(f.env, "claude", "2.3.4");
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(f.logfile, "utf8");
      assert.equal(calls.includes("Dockerfile.legacy"), expected === "legacy");
      assert.equal(calls.includes("run --rm team-skill-hub-expert-claude:2.3.4"), expected === "legacy");
    } finally {
      rmSync(f.temp, { recursive: true, force: true });
    }
  }
});

test("legacy mode derives Bullseye Dockerfiles for both backends and honors BASE_IMAGE", () => {
  const f = fixture("18.09.9", {
    BUILD_MODE: "legacy",
    BASE_IMAGE: "mirror.local/node:24-bullseye-slim",
    DEBIAN_SNAPSHOT: "20260824T000000Z",
  });
  try {
    for (const backend of ["claude", "codex"]) {
      const result = run(f.env, backend, "2.3.4");
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(f.logfile, "utf8");
      const dockerfilePath = calls.match(/build -f (\S+)/)?.[1];
      assert.ok(dockerfilePath);
      const generated = readFileSync(`${f.logfile}.generated`, "utf8");
      const source = readFileSync(
        path.join(root, "docker/expert-worker", backend === "claude" ? "Dockerfile.claude" : "Dockerfile"),
        "utf8",
      );
      assert.match(generated, /^FROM mirror\.local\/node:24-bullseye-slim/m);
      assert.match(generated, /snapshot\.debian\.org\/archive\/debian\/20260824T000000Z/);
      assert.match(generated, /snapshot\.debian\.org\/archive\/debian-security\/20260824T000000Z/);
      assert.doesNotMatch(generated, /bookworm/);
      assert.match(generated, /rm -f \/etc\/apt\/sources.list.d\/debian.sources/);
      assert.match(generated, /USER expert/);
      assert.match(generated, /WORKDIR \/workspace/);
      assert.match(generated, /CMD \["--version"\]/);
      assert.match(
        generated,
        backend === "claude"
          ? /ENTRYPOINT \["claude"\]/
          : /ENTRYPOINT \["\/usr\/local\/bin\/expert-codex-entrypoint"\]/,
      );
      assert.match(
        generated,
        source.includes("CODEX_VERSION") ? /CODEX_VERSION=0\.162\.1/ : /CLAUDE_VERSION=2\.1\.308/,
      );
      assert.match(calls, /run --rm/);
      assert.match(calls, /save -o/);
      assert.equal(existsSync(dockerfilePath), false, "temporary generated Dockerfile should be cleaned up");
    }
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("legacy mode reuses a base image that is already present locally", () => {
  const f = fixture("18.09.9", { BUILD_MODE: "legacy", MOCK_BASE_PRESENT: "1" });
  try {
    const result = run(f.env, "codex", "2.3.4");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(f.logfile, "utf8"), /pull node:24-bullseye-slim/);
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("legacy mode pulls base image only when it is not present locally", () => {
  const f = fixture("18.09.9", { BUILD_MODE: "legacy" });
  try {
    const result = run(f.env, "codex", "2.3.4");
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(f.logfile, "utf8"), /pull node:24-bullseye-slim/);
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("auto mode fails clearly when Docker Server version cannot be detected", () => {
  const f = fixture("");
  try {
    const result = run(f.env, "claude", "2.3.4");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unable to detect Docker Server version/);
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});

test("one Worker image build script keeps output names and validates arguments", () => {
  assert.doesNotThrow(() => execFileSync("bash", ["-n", script]));
  const f = fixture("27.0.0");
  try {
    for (const [backend, imageName, archive, dockerfile] of [
      ["claude", "team-skill-hub-expert-claude:2.3.4", "expert-claude-image-2.3.4.tar", "Dockerfile.claude"],
      ["codex", "team-skill-hub-expert-worker:2.3.4", "expert-worker-image-2.3.4.tar", "Dockerfile"],
    ] as [string, string, string, string][]) {
      const result = run(f.env, backend, "2.3.4");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(imageName.replaceAll(".", "\\.")));
      assert.match(result.stdout, new RegExp(archive.replaceAll(".", "\\.")));
      const calls = readFileSync(f.logfile, "utf8");
      assert.match(calls, new RegExp(`build --pull -f .*${dockerfile.replaceAll(".", "\\.")} -t`));
      assert.match(calls, new RegExp(`save -o .*${archive.replaceAll(".", "\\.")}`));
    }
    for (const arguments_ of [["unknown"], ["claude", "../invalid"]]) {
      const bad = run(f.env, ...arguments_);
      assert.equal(bad.status, 2);
    }
  } finally {
    rmSync(f.temp, { recursive: true, force: true });
  }
});
