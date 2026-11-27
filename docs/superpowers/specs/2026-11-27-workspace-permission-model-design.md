# Workspace Permission Model Redesign

> Date: 2026-11-27
>
> Status: Implemented and verified (`single-uid-v2`)
>
> Scope: Team Skill Hub Expert Worker repository workspaces

## 1. Intent

The current workspace permission model uses two Unix identities for one mutable working tree:

- Worker host process: `expert-worker` (currently uid 999, gid 988 on the WSL2 host)
- Agent container: fixed uid 10001 plus the Worker shared group

The model then attempts to preserve interoperability with recursive ownership checks, group-mode normalization, setgid directories, handoff validation, and a cleanup repair container.

This has become a reliability problem. Normal development tools create files with legitimate but different modes and ownership patterns. CMake, Ninja, compilers, test runners, copy tools, language package managers, and Agent turns can all produce files that are valid for development but violate one of the platform's handoff assumptions.

The redesign moves the security boundary away from per-file Unix mode choreography and toward container/mount boundaries.

The core principle is:

> One workspace has one mutable Unix identity. Development permissions inside the working tree are broad; security-sensitive resources are protected by mounts and platform-owned boundaries.

## 2. Goals

1. Let an Agent perform normal development work in the working tree without platform-specific chmod/chown conventions.
2. Eliminate repeated Worker ↔ Agent ownership handoffs for normal files.
3. Allow build systems and test runners to create, chmod, execute, rename, and delete files normally.
4. Keep Git metadata under platform control so the Agent cannot create commits, mutate refs/remotes, or bypass publication policy.
5. Keep credentials, Docker control, other workspaces, and the host filesystem outside the Agent boundary.
6. Preserve deterministic verification, review, publication, cleanup, retries, and multi-round Dynamic DAG execution.
7. Make permission failures exceptional and diagnostic rather than a normal lifecycle mechanism.

## 3. Non-goals

This design does not:

- give the Agent root;
- mount `docker.sock`;
- expose repository publication credentials to the Agent;
- allow the Agent to push branches or create MR/PR directly;
- make the host filesystem visible;
- weaken verification workspace immutability;
- replace Dynamic DAG verification/evidence rules;
- rely on `chmod -R 777`.

## 4. Current model and failure pattern

Current mutable-workspace flow:

```text
Worker uid=999 clones repository
        |
        | chmod/chgrp/setgid
        v
Agent uid=10001 modifies working tree
        |
        | files may be 0644 / 0755 / 0600 / tool-specific modes
        v
Worker uid=999 scans/reads/publishes/cleans
        |
        +--> shared-GID validation
        +--> permission handoff
        +--> cleanup repair container
        +--> retry / continuation permission checks
```

The platform currently has to reason about both Worker-owned and Agent-owned paths. That creates failure classes such as:

- `WORKER_CHECKOUT_OWNER_NOT_ALLOWED`
- `WORKER_CHECKOUT_GROUP_NOT_CONFIGURED`
- `WORKER_CHECKOUT_PERMISSION_NOT_SHARED`
- cleanup `EPERM` / `EACCES`
- repeated chmod/chown transitions around verification and later Agent turns

The recent CTest failure was a separate sandbox issue—Agent `/tmp` was mounted `noexec`—but it reinforces the same design lesson: development semantics should be intentionally available inside the sandbox rather than emerging from Docker defaults.

## 5. Approaches considered

### Approach A — Keep fixed Agent uid=10001 and simplify shared-group rules

Keep the current two-UID architecture, but stop recursively requiring group-write and normalize fewer modes.

Advantages:

- smallest migration;
- few Docker invocation changes;
- keeps current Agent identity stable.

Disadvantages:

- ownership still alternates between uid 999 and uid 10001;
- Worker still depends on group readability of Agent-created files;
- cleanup still needs cross-owner repair;
- future tools can still create files that violate handoff assumptions;
- permission logic remains distributed across checkout, execution, verification, publication, and cleanup.

This reduces symptoms but retains the architectural source of them.

### Approach B — Run the Agent as the Worker uid/gid; protect Git metadata with mounts

Run every Agent for a Worker instance using that Worker's actual host uid/gid. The working tree is therefore always owned by one Unix identity.

For a mutable Agent container:

```text
/workspace          bind mount: read-write
/workspace/.git     nested bind mount: read-only
/tmp                tmpfs: read-write, exec
/home/expert        tmpfs/runtime state: read-write
container rootfs    read-only
```

Advantages:

- no normal ownership handoff;
- Worker and Agent can both read/write/chmod/delete working-tree files as the same owner;
- a file temporarily changed to `0600` or even `0000` is recoverable by the Worker because it remains the owner;
- cleanup becomes ordinary same-owner deletion;
- no need to use shared-group mode as the primary correctness mechanism;
- `.git` protection becomes an explicit kernel mount boundary rather than an ownership convention;
- publication remains Worker/platform controlled.

Disadvantages:

- container user becomes host-specific rather than fixed uid 10001;
- runtime images and Claude/Codex must work under an arbitrary non-root numeric uid;
- tests and helper code currently assuming uid 10001 must be updated;
- nested `.git` mounts need explicit handling for unusual repository layouts such as submodules/worktrees.

This is the recommended model.

### Approach C — Physically separate Git metadata from the working tree

Use a separate Git directory outside the mutable working tree and expose it read-only to Agents.

Advantages:

- strongest conceptual separation between source content and Git control plane;
- Agent working tree contains no writable repository metadata.

Disadvantages:

- larger Git refactor;
- more complex path handling for Git commands, worktrees, submodules, hooks, and publication;
- greater migration and compatibility cost than required to solve the current reliability problem.

This is a possible future hardening step, not the first redesign.

## 6. Decision

Adopt **Approach B: single mutable UID plus mount-based Git metadata protection**.

This follows the requested direction that the workspace should behave like a normal development environment, while security controls stay at the workspace boundary rather than being encoded into every file mode.

A local spike on the current Worker host validated the key assumptions:

- Agent container ran successfully as host `expert-worker` uid/gid `999:988`;
- Claude Code and the current Codex Worker image both started successfully under that numeric uid;
- Agent-created and modified working-tree files remained owned by `999:988` on the host;
- `git status` worked with a read-only nested `.git` mount;
- an attempted write to `.git` failed with `Read-only file system`.

## 7. Target permission model

### 7.1 Authorization layer versus filesystem implementation

The existing Deployment / Runtime Profile remains the **authorization source of truth** for whether an Agent may modify repository content.

For example:

```text
claude-readonly / codex-readonly
    -> workspaceAccess = read-only
    -> Agent sees /workspace as RO

claude-workspace-write / codex-workspace-write
    -> workspaceAccess = read-write
    -> Agent may receive /workspace as RW
```

`single-uid-v2` does not grant write authority by itself. It only defines how an already-authorized workspace access mode is implemented reliably at the Unix/Docker layer.

The effective permission decision is therefore layered:

```text
Deployment / Runtime Profile authorization
        ↓
Docker mount mode (RO or RW)
        ↓
single-uid-v2 filesystem identity
```

A readonly Runtime Profile must remain readonly even though the Agent and Worker use the same numeric uid/gid.

### 7.2 Identity

For each Worker process:

```text
workerUid = process.getuid()
workerGid = process.getgid()
```

Agent and verification containers use that same numeric uid/gid:

```text
--user <workerUid>:<workerGid>
```

The Worker must satisfy:

```text
workerUid > 0
workerGid > 0
```

A root Worker is invalid for `single-uid-v2` because mirroring uid 0 into the Agent would convert a filesystem-identity simplification into container root authority.

Only the primary uid/gid are propagated. The Agent must **not** inherit the Worker's supplementary groups. In particular, a Worker account that belongs to the host `docker` group must not pass that group into the Agent container.

There is no fixed execution uid as a workspace ownership boundary.

The security property is "non-root and isolated", not "uid must equal 10001".

For every v2 workspace, the filesystem identity is persisted as immutable workspace metadata:

```text
permissionModel = single-uid-v2
ownerWorkerId   = <worker id>
ownerUid        = <worker uid at workspace allocation>
ownerGid        = <worker gid at workspace allocation>
```

These values are captured when the workspace becomes ready and are not recomputed later as implicit defaults.

Before continuation, verification, publication, or cleanup, the Worker must prove:

```text
currentWorkerId  == workspace.ownerWorkerId
currentWorkerUid == workspace.ownerUid
currentWorkerGid == workspace.ownerGid
```

Any mismatch fails closed with a deterministic workspace-identity error. The platform must not silently `chown` an existing v2 workspace to a newly assigned uid/gid.

The identity must also be carried through the Worker protocol rather than existing only in Hub storage:

- task claiming advertises `supportedWorkspacePermissionModels`; a Worker advertises `single-uid-v2` only when its current uid/gid are valid;
- `workspace.ready` reports `permissionModel`, `ownerUid`, and `ownerGid` together with workspace key/path/base commit;
- Hub persists `ownerWorkerId + permissionModel + ownerUid + ownerGid` atomically when accepting `workspace.ready`;
- every workspace-affine continuation, verification, publication, and cleanup claim carries the expected permission model and owner uid/gid;
- before touching the workspace path, the Worker compares the expected identity with its current process identity and fails closed on drift.

This makes the Hub's durable workspace identity and the Worker's local filesystem identity mutually checkable instead of relying only on `ownerWorkerId`.

### 7.3 Mutable working tree

For `workspaceAccess=read-write`:

```text
/workspace = RW
```

The Agent may:

- create/delete files and directories;
- rename files;
- chmod files;
- create executable files;
- run compilers and build tools;
- create local build directories;
- run tests;
- use normal language package/build tooling;
- read Git status/diff information.

The platform does not require generated files to use a particular group-write mode.

The platform does not recursively scan the entire working tree merely to prove a theoretical future handoff is possible.

### 7.4 Git metadata

For a normal repository:

```text
/workspace/.git = RO nested bind mount
```

The Agent may read Git metadata for commands such as:

- `git status`
- `git diff`
- `git log`
- `git show`

The Agent must not mutate:

- config/remotes;
- HEAD;
- refs;
- index;
- hooks;
- repository publication state.

Commit preparation, refs, branch publication, push, and MR/PR remain platform-owned actions.

The Agent Git contract is explicit:

| Git operation | Agent | Worker/platform |
|---|---:|---:|
| `git status`, `git diff`, `git log`, `git show`, `git blame`, `git grep` | Allowed | Allowed |
| read a file from `HEAD` / base commit | Allowed | Allowed |
| `git add`, `git commit`, `git commit-tree` | Forbidden | Allowed when policy permits |
| `git stash`, `git reset`, `git switch`, branch-changing `git checkout` | Forbidden | Platform-controlled only |
| `git update-ref`, remote/config mutation | Forbidden | Platform-controlled only |
| `git push`, MR/PR creation | Forbidden | Allowed when publication policy permits |

If an Agent needs to restore working-tree content, it must do so without mutating Git metadata, for example by reading the desired blob from the base commit and overwriting the working-tree file, or by using a future platform-owned restore operation.

Agent containers should set:

```text
GIT_OPTIONAL_LOCKS=0
```

so read-only Git commands do not opportunistically refresh writable index/cache state.

The mount boundary is authoritative. File ownership alone is not considered a sufficient Git security boundary.

### 7.5 Scratch and home

Agent scratch must support normal development semantics:

```text
/tmp         rw,exec
/home/expert rw
```

`/tmp` remains isolated tmpfs and is not persistent across Agent containers.

The container remains:

- non-root;
- `--cap-drop ALL`;
- `no-new-privileges`;
- read-only root filesystem;
- resource limited.

### 7.6 Verification

Verification runs with the same Worker uid/gid but a read-only repository mount:

```text
/workspace = RO
/tmp       = RW + exec
```

Verification may build into `/tmp` and execute generated programs there.

A verification container cannot alter the source subject it is verifying.

### 7.7 Runtime session state

Runtime state such as Claude/Codex session directories is created and owned by the same Worker uid/gid.

The current group-ownership normalization for runtime session directories becomes unnecessary once the container shares Worker identity.

Runtime state remains mounted only at its explicit target path.

### 7.8 Publication

Publication remains a Worker/platform operation.

Because Worker and Agent share ownership of the working tree, the Worker can read changed files without requiring group-mode repair.

The Agent cannot mutate `.git` because its container sees the nested read-only mount.

The Worker host process retains normal access to the real `.git`, so existing controlled operations remain available:

```text
git add
git write-tree
git commit-tree
git update-ref
git symbolic-ref
controlled push
MR/PR creation
```

Publication continues to verify content revision and approved change summary before mutating Git state.

### 7.9 Cleanup

Normal cleanup becomes:

```text
rm -rf <workspace>
```

Because all mutable working-tree paths are owned by the Worker uid, the Worker can repair owner permissions itself when necessary.

If an Agent creates a directory with restrictive mode, the Worker is still that directory's owner and may chmod it before retrying cleanup.

The dedicated "uid 10001 permission repair container" should become unnecessary for v2 workspaces.

## 8. Security boundaries that remain strict

The redesign deliberately opens development behavior **inside one workspace**. It does not broaden authority outside it.

| Resource | Agent access |
|---|---|
| Working tree | RWX semantics |
| `.git` metadata | Read-only |
| `/tmp` | RW + exec |
| Runtime home/state | Explicit RW mount only |
| Git source/publication credentials | None |
| Docker socket | None |
| Other Worker workspaces | None |
| Host root filesystem | None |
| Hub admin credentials | None |
| Publication/push authority | None |
| Verification source mount | Read-only |

Security is therefore based on resource reachability and mount mode, not fragile owner/group combinations.

## 9. Permission invariants

For the new model the durable invariants become small:

1. Worker process is non-root.
2. Agent/verification process uses the Worker's uid/gid.
3. Agent receives only its own workspace mount.
4. Mutable Agent sees working tree RW.
5. Mutable Agent sees Git metadata RO.
6. Verification sees the entire workspace RO.
7. Agent scratch is isolated and executable.
8. Credentials are not present in the Agent workspace.
9. Publication is performed only by the platform.
10. Container rootfs remains read-only with all capabilities dropped.

Notably absent are invariants such as:

- every file must be group-writable;
- every Agent-created file must expose a specific shared-group mode;
- Worker-owned and execution-owned paths must be recursively classified before every turn.

## 10. Legacy workspace migration

Do not silently reinterpret an active legacy workspace.

Persist the permission model and filesystem identity directly on `work_workspaces`:

```text
permission_model TEXT NOT NULL
owner_uid        INTEGER
owner_gid        INTEGER
```

with the supported model values:

```text
shared-gid-v1
single-uid-v2
```

For `single-uid-v2`, `owner_uid` and `owner_gid` are mandatory and immutable after the workspace reaches `ready`. Existing rows are migrated with `permission_model='shared-gid-v1'` and nullable `owner_uid/owner_gid`; v1 rows do not invent a filesystem identity retroactively.

New workspaces use `single-uid-v2` only when the claiming Worker advertises support for it and satisfies the non-root uid/gid requirements.

Existing active v1 workspaces continue under `shared-gid-v1` behavior. This avoids a risky recursive ownership migration while a Work contains uncommitted changes.

If an operator explicitly migrates an active v1 workspace, migration must be a fenced platform operation and must preserve:

- base commit;
- working-tree bytes;
- executable bits;
- symlinks;
- content revision;
- current Work/Attempt binding.

After all v1 workspaces expire, remove v1 permission-repair paths.

## 11. Submodules, worktrees, and unusual Git layouts

The initial `single-uid-v2` implementation supports only a normal clone layout with an in-workspace `.git/` directory.

Before a v2 workspace becomes ready, repository preparation must enforce all of the following:

```text
/workspace/.git exists
/workspace/.git is a directory
/workspace/.git is not a symlink
realpath(/workspace/.git) remains inside the workspace root
Git metadata ownership matches the Worker-owned repository boundary
```

Unsupported layouts fail closed rather than falling back to a writable metadata view.

Initial support matrix:

- normal clone with `.git/` directory — supported;
- Git worktree where `.git` is a file — unsupported in v2 initial rollout;
- repositories requiring mutable submodule metadata (`.git/modules/...`) — unsupported in v2 initial rollout;
- metadata paths that escape the workspace root — rejected.

Submodules/worktrees may be added later only with an explicit metadata-resolution design that preserves the same read-only Agent Git boundary.

## 12. Failure handling under v2

Permission failures should mean an actual sandbox or filesystem problem, not a routine mode mismatch.

Examples that remain blockers:

- workspace mount unexpectedly read-only for a repair Agent;
- Git metadata mount unexpectedly writable;
- workspace path escapes Worker repository root;
- source filesystem denies the Worker owner access;
- Docker cannot apply the required mount boundary;
- current Worker id/uid/gid differs from the persisted workspace identity;
- Worker uid/gid is root or otherwise invalid for v2;
- repository Git layout is unsupported for the v2 read-only metadata contract.

Examples that should no longer block merely because of mode:

- Agent creates a normal `0644` file;
- Agent creates a `0755` executable;
- Agent creates a `0600` temporary source file;
- build system chooses its own directory modes;
- later Agent turn reuses files from an earlier turn.

## 13. Test strategy

### Container contract tests

Verify generated Docker args use:

- persisted/validated Worker uid/gid;
- no inherited supplementary groups;
- RW workspace only when Runtime Profile authorizes workspace-write;
- RO workspace for readonly Agent execution and verification;
- nested RO Git metadata mount for writable Agent execution;
- executable `/tmp`;
- `GIT_OPTIONAL_LOCKS=0` for Agent Git reads;
- no Docker socket or publication credential mount.

### Real Docker integration tests

On a Linux/WSL2 test host:

1. create a repository owned by the Worker uid;
2. run Claude and Codex Agent containers as that Worker uid/gid;
3. create, edit, chmod, execute, and delete working-tree files;
4. verify readonly Runtime Profiles still receive `/workspace` RO;
5. verify writable Runtime Profiles receive the working tree RW but `.git` RO;
6. verify `git status` and `git diff` work with `GIT_OPTIONAL_LOCKS=0`;
7. verify writes to `.git` fail;
8. verify `git add`, `git stash`, branch-changing checkout/switch, and ref mutation fail in the Agent;
9. run a two-turn repair over the same workspace;
10. build and execute a C/C++ test binary;
11. run verification with workspace RO and `/tmp` exec;
12. publish through the Worker and verify exact approved content;
13. restart with the same Worker id but a different uid/gid and prove continuation/publication/cleanup fail closed;
14. reject creation of a v2 workspace when the Worker uid is 0.

### Cleanup tests

Exercise restrictive file modes and directories, then verify the Worker can recover and remove the workspace without a cross-UID repair helper.

### Dynamic DAG regression

Exercise:

```text
review
 -> repair #1
 -> verification
 -> review rework
 -> repair #2
 -> verification
 -> accepted
 -> publication
```

The same workspace must survive every round without ownership/group handoff failures.

## 14. Rollout sequence

1. Keep the already-fixed Agent `/tmp rw,exec` behavior independently.
2. Add schema support for `permission_model`, `owner_uid`, and `owner_gid`; migrate all existing workspaces to `shared-gid-v1`.
3. Extend Worker compatibility/protocol data with `supportedWorkspacePermissionModels` and workspace identity fields; old Workers must not claim v2 workspaces, and `workspace.ready` must persist the selected model plus uid/gid.
4. Add fail-closed Worker id/uid/gid validation and reject uid/gid 0 for v2.
5. Add explicit execution uid/gid to Agent/verification container configuration without inheriting supplementary groups.
6. Add strict normal-clone Git-layout validation.
7. Add nested read-only Git metadata mount plus `GIT_OPTIONAL_LOCKS=0`.
8. Add real-container tests proving Runtime Profile RO/RW semantics, worktree RW, and Git metadata RO for both Claude and Codex images.
9. Enable `single-uid-v2` only for newly created workspaces on capable Workers.
10. Stop running recursive shared-group permission validation for v2.
11. Simplify runtime-state ownership handling for v2.
12. Replace cross-UID cleanup repair with same-owner host cleanup/permission recovery for v2.
13. Run multi-round Dynamic DAG acceptance tests including verification, review rework, publication, and MR/PR creation.
14. Retire `shared-gid-v1` only after no active legacy workspace remains and all supported Workers advertise v2.

## 15. Acceptance criteria

The redesign is successful when all of the following are true:

- a normal compiler/build/test workflow can run without workspace-specific chmod workarounds;
- C/C++ test binaries created by an Agent can execute;
- two or more repair turns reuse the same workspace without ownership errors;
- Worker can inspect and publish Agent changes regardless of ordinary file modes;
- Worker can clean the workspace without a uid-10001 repair container;
- readonly Runtime Profiles remain filesystem-readonly despite shared Worker/Agent uid;
- Agent cannot modify `.git`;
- Agent cannot mutate Git index/refs or push;
- Agent cannot obtain publication credentials;
- verification cannot mutate the source workspace;
- a Worker id reused under a different uid/gid cannot continue, publish, or clean an existing v2 workspace;
- root Worker identity is rejected for v2;
- unsupported Git layouts fail closed;
- current publication stale/content checks remain intact;
- no `WORKER_CHECKOUT_PERMISSION_NOT_SHARED`-style blocker is required for v2 normal-file handoff.

## 16. Summary

The existing model treats Unix file ownership as both a collaboration mechanism and a security boundary. That forces two independent processes to continually negotiate ownership and mode on the same mutable tree.

The proposed model separates those responsibilities:

```text
Runtime Profile authorization
    -> decides whether the Agent is readonly or workspace-write

same persisted non-root uid/gid
    -> reliable collaboration inside an authorized writable working tree

mount boundaries
    -> enforce workspace RO/RW and isolate Git metadata/external resources

platform verification/publication
    -> durable policy, commit, push, and MR/PR authority
```

The working tree should feel like a normal developer checkout to the Agent. Security should come from what the sandbox can reach and which mounts are writable, not from requiring every development tool to accidentally produce the platform's preferred Unix mode.

## 17. Implementation verification

The initial `single-uid-v2` rollout described by this specification is implemented in the current working tree and has been verified against the acceptance criteria above.

Additional closure work performed during the final spec audit:

- initialized submodule or nested `.git` metadata inside the working tree now fails closed with `WORKSPACE_GIT_LAYOUT_UNSUPPORTED`;
- Worker configuration rejects any overlap between HTTPS Git source/publication token environment variables and the Agent model environment allowlist, preserving the "Git credentials: None" Agent boundary;
- current-subject Dynamic DAG facts are authoritative over legacy compatibility-derived facts, so successful publication and change-request DAG nodes cannot be overwritten by stale compatibility state;
- a full `single-uid-v2` Dynamic DAG acceptance covers two repair rounds, build and unit verification in each round, review rework, accepted review, publication prepare/push, and change-request creation while preserving one workspace identity throughout.

Fresh verification evidence on 2026-11-27:

- `git diff --check` passed;
- `npm run check` passed with 1060/1060 tests and 0 failures;
- Claude and Codex real-container smoke tests ran as Worker uid/gid and confirmed working-tree write access, nested read-only Git metadata, executable `/tmp`, and rejection of Git metadata mutations;
- verification real-container smoke test confirmed a read-only repository mount and successful C/C++ compile-and-execute from executable scratch;
- final production and test diff review found no remaining Critical or Important findings.

Deployment remains a separate operation. This implementation status describes the source tree and verification evidence; it does not imply that the currently running Hub/Worker processes have been upgraded to this revision.

