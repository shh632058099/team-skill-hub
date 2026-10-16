import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { buildClientIntegrationManifest, loadClientIntegrationRelease } from "../src/client-integration/release.js";

test("loads canonical client integration release metadata", async () => {
  const release = await loadClientIntegrationRelease();
  assert.equal(release.schemaVersion, 1);
  assert.ok(Number.isInteger(release.version) && release.version > 0);
  assert.ok(release.minimumSupportedVersion <= release.version);
  assert.ok(release.hookRuntimeVersion.length > 0);
  assert.ok(release.hookSchemaVersion > 0);
});

test("rejects invalid version ordering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-release-"));
  await mkdir(path.join(root, "client-integration"), { recursive: true });
  await writeFile(
    path.join(root, "client-integration", "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: 4,
      minimumSupportedVersion: 5,
      hookRuntimeVersion: "1.1.0",
      hookSchemaVersion: 1,
    }),
  );
  await assert.rejects(() => loadClientIntegrationRelease(root), /minimumSupportedVersion/);
});

test("renders relative package paths", async () => {
  const release = await loadClientIntegrationRelease();
  const manifest = buildClientIntegrationManifest(release, {
    releasedAt: "2026-10-15T11:30:00+08:00",
    serverVersion: "0.1.0",
    linuxSha256: "a".repeat(64),
    windowsSha256: "b".repeat(64),
  });
  assert.equal(manifest.packages.linux.path, `releases/${release.version}/linux.tar.gz`);
  assert.equal(manifest.packages.windows.path, `releases/${release.version}/windows.zip`);
  assert.equal(manifest.minimum_supported_version, release.minimumSupportedVersion);
});
