export type RuntimeProfileId =
  "codex-readonly" | "codex-workspace-write" | "claude-readonly" | "claude-workspace-write";

export type RuntimeProfilePolicy = {
  id: RuntimeProfileId;
  backend: "codex" | "claude";
  workspaceAccess: "read-only" | "read-write";
  agentPermissions: "read-only" | "workspace-write";
};

const POLICIES: Record<RuntimeProfileId, RuntimeProfilePolicy> = {
  "codex-readonly": {
    id: "codex-readonly",
    backend: "codex",
    workspaceAccess: "read-only",
    agentPermissions: "read-only",
  },
  "codex-workspace-write": {
    id: "codex-workspace-write",
    backend: "codex",
    workspaceAccess: "read-write",
    agentPermissions: "workspace-write",
  },
  "claude-readonly": {
    id: "claude-readonly",
    backend: "claude",
    workspaceAccess: "read-only",
    agentPermissions: "read-only",
  },
  "claude-workspace-write": {
    id: "claude-workspace-write",
    backend: "claude",
    workspaceAccess: "read-write",
    agentPermissions: "workspace-write",
  },
};

export function resolveRuntimeProfilePolicy(profileId: string): RuntimeProfilePolicy {
  const policy = POLICIES[profileId as RuntimeProfileId];
  if (!policy) throw new Error("UNKNOWN_RUNTIME_PROFILE");
  return policy;
}

export function isPlatformWorkspaceWriteProfile(profileId: string): boolean {
  try {
    return resolveRuntimeProfilePolicy(profileId).workspaceAccess === "read-write";
  } catch {
    return false;
  }
}

export function assertRuntimeProfileBackend(profileId: string, backend: "codex" | "claude"): RuntimeProfilePolicy {
  const policy = resolveRuntimeProfilePolicy(profileId);
  if (policy.backend !== backend) throw new Error("RUNTIME_PROFILE_BACKEND_MISMATCH");
  return policy;
}
