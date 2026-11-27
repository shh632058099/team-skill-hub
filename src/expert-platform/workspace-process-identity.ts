export type WorkspacePermissionModel = "shared-gid-v1" | "single-uid-v2";

export interface WorkspaceExpectedIdentity {
  permissionModel?: WorkspacePermissionModel | null;
  ownerUid?: number | null;
  ownerGid?: number | null;
}

export interface WorkerProcessIdentity {
  uid: number;
  gid: number;
}

export function supportsSingleUidWorkspace(identity: WorkerProcessIdentity): boolean {
  return (
    Number.isSafeInteger(identity.uid) && identity.uid > 0 && Number.isSafeInteger(identity.gid) && identity.gid > 0
  );
}

export function assertWorkspaceProcessIdentity(
  expected: WorkspaceExpectedIdentity,
  current: WorkerProcessIdentity,
): void {
  if (!expected.permissionModel || expected.permissionModel === "shared-gid-v1") return;
  if (expected.permissionModel !== "single-uid-v2") throw new Error("WORKSPACE_IDENTITY_MISMATCH");
  if (
    !supportsSingleUidWorkspace(current) ||
    !Number.isSafeInteger(expected.ownerUid) ||
    !Number.isSafeInteger(expected.ownerGid) ||
    Number(expected.ownerUid) <= 0 ||
    Number(expected.ownerGid) <= 0 ||
    expected.ownerUid !== current.uid ||
    expected.ownerGid !== current.gid
  ) {
    throw new Error("WORKSPACE_IDENTITY_MISMATCH");
  }
}
