import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRuntimeProfileBackend,
  isPlatformWorkspaceWriteProfile,
  resolveRuntimeProfilePolicy,
} from "../src/expert-platform/runtime-profile-policy.js";

test("platform runtime profiles resolve to finite immutable policies", () => {
  assert.deepEqual(resolveRuntimeProfilePolicy("codex-readonly"), {
    id: "codex-readonly",
    backend: "codex",
    workspaceAccess: "read-only",
    agentPermissions: "read-only",
  });
  assert.deepEqual(resolveRuntimeProfilePolicy("codex-workspace-write"), {
    id: "codex-workspace-write",
    backend: "codex",
    workspaceAccess: "read-write",
    agentPermissions: "workspace-write",
  });
  assert.deepEqual(resolveRuntimeProfilePolicy("claude-readonly"), {
    id: "claude-readonly",
    backend: "claude",
    workspaceAccess: "read-only",
    agentPermissions: "read-only",
  });
  assert.deepEqual(resolveRuntimeProfilePolicy("claude-workspace-write"), {
    id: "claude-workspace-write",
    backend: "claude",
    workspaceAccess: "read-write",
    agentPermissions: "workspace-write",
  });
});

test("unknown or name-similar profiles never gain workspace-write permission", () => {
  assert.equal(isPlatformWorkspaceWriteProfile("custom-workspace-write"), false);
  assert.equal(isPlatformWorkspaceWriteProfile("codex-workspace-write-extra"), false);
  assert.throws(() => resolveRuntimeProfilePolicy("custom-workspace-write"), /UNKNOWN_RUNTIME_PROFILE/);
});

test("runtime profile backend mismatch fails closed", () => {
  assert.doesNotThrow(() => assertRuntimeProfileBackend("codex-workspace-write", "codex"));
  assert.throws(
    () => assertRuntimeProfileBackend("claude-workspace-write", "codex"),
    /RUNTIME_PROFILE_BACKEND_MISMATCH/,
  );
});
