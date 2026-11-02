import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/build-worker-image.sh", import.meta.url).pathname;

test("one Worker image build script supports both Claude and Codex without breaking image names", () => {
  assert.doesNotThrow(() => execFileSync("bash", ["-n", script]));
  const temp = mkdtempSync(path.join(os.tmpdir(), "worker-image-build-test-"));
  try {
    const docker = path.join(temp, "docker");
    const logfile = path.join(temp, "docker.log");
    writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALL_LOG"\n', { mode: 0o755 });
    chmodSync(docker, 0o755);
    const env = { ...process.env, PATH: `${temp}:${process.env.PATH}`, DOCKER_CALL_LOG: logfile };
    for (const [backend, imageName, dockerfile, archive] of [
      ["claude", "team-skill-hub-expert-claude:2.3.4", "Dockerfile.claude", "expert-claude-image-2.3.4.tar"],
      ["codex", "team-skill-hub-expert-worker:2.3.4", "Dockerfile", "expert-worker-image-2.3.4.tar"],
    ] as [string, string, string, string][]) {
      const result = spawnSync("bash", [script, backend, "2.3.4"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(imageName.replaceAll(".", "\\.")));
      assert.match(result.stdout, new RegExp(archive.replaceAll(".", "\\.")));
      const calls = readFileSync(logfile, "utf8").trim().split("\n");
      assert.match(calls.at(-2) ?? "", new RegExp(`build --pull -f .*${dockerfile.replaceAll(".", "\\.")} -t`));
      assert.ok(calls.at(-2)?.includes(imageName));
      assert.ok(calls.at(-1)?.includes(`save -o `));
      assert.ok(calls.at(-1)?.includes(archive));
    }
    for (const arguments_ of [["unknown"], ["claude", "../invalid"]]) {
      const bad = spawnSync("bash", [script, ...arguments_], { env, encoding: "utf8" });
      assert.equal(bad.status, 2);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
