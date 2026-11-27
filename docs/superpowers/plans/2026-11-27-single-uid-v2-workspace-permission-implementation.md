# Single-UID Workspace Permission Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the cross-UID shared-GID workspace handoff with a persisted `single-uid-v2` model where Agent/verification containers use the Worker uid/gid, Runtime Profile still controls RO/RW, Agent Git metadata is read-only, and Worker-owned publication/cleanup remain authoritative.

**Architecture:** Persist workspace permission identity in `work_workspaces`, carry it through Worker protocol claims, validate it before every workspace-affine operation, and use it to build Agent/verification container mounts. Existing workspaces stay `shared-gid-v1`; only capable non-root Workers create v2 workspaces.

**Tech Stack:** TypeScript, Node.js, SQLite `DatabaseSync`, gRPC/protobuf, Docker CLI argument builders, node:test.

**Spec:** `docs/superpowers/specs/2026-11-27-workspace-permission-model-design.md`

## Global Constraints

- Existing Deployment / Runtime Profile remains the authorization source of truth for readonly vs workspace-write.
- `single-uid-v2` requires `uid > 0` and `gid > 0`.
- Agent containers inherit only primary uid/gid, never supplementary host groups.
- Mutable Agent: working tree RW only when authorized; `.git` RO; `/tmp` RW+exec.
- Verification: repository RO; `/tmp` RW+exec.
- Agent cannot mutate Git index/refs/remote/config or push; Worker retains commit/push/MR authority.
- Existing workspace rows migrate to `shared-gid-v1`; no retroactive uid/gid inference.
- Initial v2 Git layout supports only an in-workspace non-symlink `.git/` directory.
- Do not commit or push during implementation unless the user explicitly asks.

## Review Focus

- Same Worker ID restarted under a different uid/gid must fail continuation/publication/cleanup before touching the workspace.
- Readonly Runtime Profile must remain filesystem-readonly even though Agent and Worker share uid/gid.
- Worker running as uid/gid 0 must not advertise or create `single-uid-v2`.
- Old Workers that do not advertise v2 must continue to operate only on `shared-gid-v1` workspaces.
- Agent Git reads must work while Git metadata writes fail, for both Claude and Codex runtime images.

---

### Task 1: Persist Workspace Permission Identity

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Test: existing workspace orchestration store tests

**Interfaces:**
- Produces: `WorkspacePermissionModel = "shared-gid-v1" | "single-uid-v2"`
- Extends `WorkspaceRecord` with `permissionModel`, `ownerUid`, `ownerGid`
- Extends `assignWorkspaceOwner(...)` to atomically persist permission model + uid/gid for v2
- Extends `WorkspaceCleanupClaim` with expected permission model + uid/gid

- [x] Write failing store/migration tests for legacy v1 default, v2 persistence, identity drift rejection, cleanup claim identity.
- [x] Run focused store tests and verify RED.
- [x] Implement schema migration, row mapping, owner assignment and cleanup identity.
- [x] Run focused store tests and verify GREEN.

### Task 2: Carry Workspace Permission Identity Through gRPC

**Files:**
- Modify: `src/expert-platform/proto/expert-worker.proto`
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify: task/claim types as required
- Test: existing gRPC transport tests

**Interfaces:**
- Worker task claim advertises `supported_workspace_permission_models`
- `workspace.ready` includes `permissionModel`, `ownerUid`, `ownerGid`
- Workspace-affine task/cleanup/publication claims carry expected permission model + uid/gid

- [x] Write failing transport tests for v2 capability, ready identity validation, cleanup/publication identity, and legacy compatibility.
- [x] Run focused transport tests and verify RED.
- [x] Extend proto/types/parsers and persist identity atomically on `workspace.ready`.
- [x] Run focused transport tests and verify GREEN.

### Task 3: Implement Single-UID Container and Git Mount Semantics

**Files:**
- Modify: `src/expert-platform/agent-container-executor.ts`
- Modify: `src/expert-platform/verification-runner.ts`
- Modify: `src/expert-platform/docker-agent-executor.ts`
- Modify: `src/expert-platform/repository-workspace.ts`
- Test: Agent/Docker/repository permission tests

**Interfaces:**
- Container builders take explicit run uid/gid
- v2 writable Agent mounts working tree RW plus nested `.git` RO
- readonly Agent/verification mount workspace RO
- Agent sets `GIT_OPTIONAL_LOCKS=0`
- v2 normal-clone Git layout is validated

- [x] Write failing container contract and Git-layout tests.
- [x] Run focused tests and verify RED.
- [x] Implement v2 Docker args and repository preparation while preserving v1 behavior.
- [x] Run focused tests and verify GREEN.

### Task 4: Enforce Workspace Identity on All Workspace-Affine Operations

**Files:**
- Modify: `src/expert-platform/docker-agent-executor.ts`
- Modify: `src/expert-platform/worker-daemon.ts`
- Modify: `src/expert-platform/workspace-cleanup.ts`
- Test: worker daemon, cleanup and continuation tests

**Interfaces:**
- Central workspace process identity validator
- Deterministic model/uid/gid/root errors
- v2 cleanup uses same-owner host permission recovery; v1 retains legacy repair path

- [x] Write failing identity drift/root/cleanup/publication tests.
- [x] Run focused tests and verify RED.
- [x] Implement identity validation across continuation, verification, publication and cleanup.
- [x] Run focused tests and verify GREEN.

### Task 5: Compatibility, Real Docker Acceptance, and Full Regression

- [x] Add compatibility tests for old Worker/v1 and Runtime Profile RO/RW semantics.
- [x] Run real Docker Claude/Codex single-uid + `.git` RO + executable scratch smoke tests.
- [x] Run targeted expert-platform suites.
- [x] Run `git diff --check` and `npm run check`.
- [x] Run Superpowers whole-workspace review and fix every Critical/Important finding with RED→GREEN tests.
- [x] Report deployment separately; do not commit/push unless explicitly requested.
