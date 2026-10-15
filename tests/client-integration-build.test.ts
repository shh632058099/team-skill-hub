import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);

test("builds versioned linux and windows client packages with matching hashes", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "skill-hub-client-build-"));
  await execFileAsync(process.execPath, ["--import", "tsx", "src/cli/build-client-integration.ts", "--out", out], { cwd: process.cwd() });
  const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
  const version = manifest.version;
  const linux = path.join(out, "releases", String(version), "linux.tar.gz");
  const windows = path.join(out, "releases", String(version), "windows.zip");
  await stat(linux); await stat(windows);
  const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
  assert.equal(await hash(linux), manifest.packages.linux.sha256);
  assert.equal(await hash(windows), manifest.packages.windows.sha256);
  assert.equal(manifest.packages.linux.path, `releases/${version}/linux.tar.gz`);
  const zip = await JSZip.loadAsync(await readFile(windows));
  assert.ok(zip.file("release.json"));
  assert.ok(zip.file("scripts/setup-codex-mcp.ps1"));
});
