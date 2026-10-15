import assert from "node:assert/strict";
import test from "node:test";
import { releaseMetadataRequiresClientVersionBump, requiresClientVersionBump } from "../src/cli/client-integration-version-check.js";

test("client integration owned source changes require a version bump", () => {
  assert.equal(requiresClientVersionBump(["scripts/setup-codex-mcp.sh"]), true);
  assert.equal(requiresClientVersionBump(["client-integration/runtime/client-runtime.mjs"]), true);
  assert.equal(requiresClientVersionBump(["scripts/bootstrap-client-integration.ps1"]), true);
});

test("server-only changes do not require a client version bump", () => {
  assert.equal(requiresClientVersionBump(["src/server.ts", "README.md"]), false);
});

test("policy-only release metadata change does not require primary version bump", () => {
  assert.equal(requiresClientVersionBump(["client-integration/release.json"]), false);
});

test("minimum supported policy change alone does not require primary version bump", () => {
  const before = { schemaVersion: 1, version: 5, minimumSupportedVersion: 3, hookRuntimeVersion: "1.1.0", hookSchemaVersion: 1 };
  const after = { ...before, minimumSupportedVersion: 4 };
  assert.equal(releaseMetadataRequiresClientVersionBump(before, after), false);
});

test("hook or schema metadata change requires primary version bump", () => {
  const before = { schemaVersion: 1, version: 5, minimumSupportedVersion: 3, hookRuntimeVersion: "1.1.0", hookSchemaVersion: 1 };
  assert.equal(releaseMetadataRequiresClientVersionBump(before, { ...before, hookRuntimeVersion: "1.2.0" }), true);
  assert.equal(releaseMetadataRequiresClientVersionBump(before, { ...before, hookSchemaVersion: 2 }), true);
});
