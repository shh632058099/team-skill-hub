import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("linux client launcher resolves Node from NVM when hook PATH has no node", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-launcher-"));
  const home = path.join(root, "home");
  const clientRoot = path.join(root, "client");
  const launcher = path.join(clientRoot, "bin", "team-skill-hub-client");
  const runtime = path.join(clientRoot, "releases", "v1", "runtime", "client-runtime.mjs");
  const nvmNode = path.join(home, ".nvm", "versions", "node", "v99.0.0", "bin", "node");
  const hookPath = "/usr/bin:/bin";

  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(path.dirname(runtime), { recursive: true });
  await mkdir(path.dirname(nvmNode), { recursive: true });
  await copyFile("client-integration/runtime/team-skill-hub-client", launcher);
  await chmod(launcher, 0o755);
  await writeFile(path.join(clientRoot, "current"), "1\n", "utf8");
  await writeFile(runtime, "process.stdout.write(process.execPath);\n", "utf8");
  await symlink(process.execPath, nvmNode);

  const { stdout } = await execFileAsync("/bin/bash", [launcher], {
    env: {
      HOME: home,
      PATH: hookPath,
      TEAM_SKILL_HUB_CLIENT_ROOT: clientRoot
    }
  });

  assert.equal(stdout.trim(), process.execPath);
});
