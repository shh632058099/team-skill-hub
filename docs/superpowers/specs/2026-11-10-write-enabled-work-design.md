# Write-enabled Work Design

> Date: 2026-11-10
> Status: Proposed
> Scope: Team Skill Hub Expert Platform / Work Orchestration
> Depends on: `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`

## 1. Intent

Add a controlled write-capable engineering execution path to Work Orchestration without weakening the existing read-only Expert Platform security model.

Target loop:

```
submit_work
  -> isolated writable Workspace
  -> Agent edits code
  -> deterministic Build/Test verification
  -> revision-bound Evidence
  -> waiting_review
  -> ReviewDecision
  -> Approval Gate
```

Phase 1 explicitly stops before automatic Git commit, push, PR/MR, or merge.

## 2. Goals

1. Runtime Profile becomes an enforceable execution-security contract, not only a Worker compatibility label.
2. A write-enabled Agent may mutate only its assigned WorkAttempt Workspace.
3. Container root filesystem, credentials, MCP configuration, auth files and host filesystem remain protected.
4. Build/Test runs against the exact resulting Workspace revision and produces current, revision-bound Evidence.
5. ReviewDecision and Approval remain separate concepts.
6. Completion requires current verification plus required review/approval state.
7. Existing read-only deployments and Work flows remain backward compatible.
8. Codex and Claude use equivalent capability semantics even though CLI controls differ.

## 3. Non-goals

This package does not implement automatic git commit, push, branch publication, PR/MR creation, merge, arbitrary host command execution, writable MCP tools, mutation outside the assigned Workspace, multi-node DAG execution, or broad Worker-host shell access.

## 4. Existing constraints

- Deployment already pins `runtimeProfile`.
- Worker advertises supported runtime profiles.
- Claim compatibility already checks Deployment profile against Worker support.
- Codex is doubly read-only today: Docker `/workspace` bind is readonly and Codex uses `--sandbox read-only`.
- Claude read-only permits only `Read,Glob,Grep`; Bash/Edit/Write are disabled.
- Verification already runs in an isolated read-only, no-network container.
- Workspace identity, owner Worker, physical path, base commit, cleanup and continuation affinity are durable.
- ReviewDecision, Approval, Evidence, revision staleness and Completion Gate already exist.

Therefore write support enriches the existing Runtime Profile path rather than introducing a second permission system.

## 5. Chosen approach

### 5.1 Runtime Profile is the execution permission contract

Initial platform-owned profiles:

```
codex-readonly
codex-workspace-write
claude-readonly
claude-workspace-write
```

Each resolves to a finite immutable policy:

```ts
type RuntimeProfilePolicy = {
  backend: "codex" | "claude";
  workspaceAccess: "read-only" | "read-write";
  agentPermissions: "read-only" | "workspace-write";
};
```

The registry is code-owned in this phase. Admin users select stable IDs; they cannot construct arbitrary mount or CLI fragments.

### 5.2 Authorization chain

Write capability is allowed only when all three agree:

```
Workflow execution requirement
      AND
Deployment runtimeProfile
      AND
Worker supportedRuntimeProfiles
```

Rules:

- Workflow may declare `execution.requiredRuntimeProfile`.
- If omitted, current Deployment selection behavior remains.
- If declared, dispatch must select a Deployment whose profile exactly matches.
- In auto routing, filter the existing eligible Deployment set by `requiredRuntimeProfile` before applying the existing selection/ranking rules.
- In explicit routing, if the named Deployment does not exactly match the required profile, fail deterministically with `RUNTIME_PROFILE_MISMATCH`; never fall back to another Deployment.
- If auto routing has no eligible Deployment with the required profile, fail deterministically with `RUNTIME_PROFILE_UNAVAILABLE`.
- Claim still requires Worker support for the pinned Deployment profile.
- Worker resolves the profile to the local platform policy.
- Unknown profiles fail closed for write semantics.

A Workflow cannot elevate a read-only Deployment.

### 5.3 Approval does not enable write permission

Approval is authorization for a specific subject revision, not runtime privilege escalation. Workspace write capability is fixed before execution by Workflow + Deployment + Worker profile compatibility.

## 6. Workflow model

Extend `WorkflowDefinition.execution`:

```yaml
execution:
  requiredRuntimeProfile: codex-workspace-write
  workspace:
    strategy: isolated
    reuseOnContinuation: true
    cleanup: on_terminal
```

- Profile ID is pinned with Workflow version.
- WorkAttempt pins Workflow version.
- ExpertTask already pins Deployment snapshot including runtime profile.
- Orchestrator validates required profile against selected Deployment before dispatch.
- Mismatch becomes deterministic `policy_blocked`, not retryable failure.
- Default Workflow does not gain write access.

## 7. Executor security model

### 7.1 Shared invariants

For both backends:

- Docker root remains `--read-only`.
- `/workspace` is the only persistent writable mount for workspace-write profiles.
- `/tmp` and agent HOME remain tmpfs.
- auth/config/MCP mounts remain readonly.
- no Docker socket.
- no host path other than validated Workspace plus explicit readonly config/credential mounts.
- capabilities remain dropped.
- `no-new-privileges` remains enabled.
- existing pids/memory/cpu limits remain.
- Workspace path must validate under Worker repository root.
- Verifier never inherits Agent write privileges.

### 7.2 Codex workspace-write

For `codex-workspace-write`:

```
container rootfs: readonly
/workspace: bind rw
Codex: --sandbox workspace-write
```

Read-only remains readonly bind + `--sandbox read-only`. Never use `danger-full-access`.

### 7.3 Claude workspace-write

For `claude-workspace-write`:

```
container rootfs: readonly
/workspace: bind rw
allowed tools: Read,Glob,Grep,Edit,Write
```

Bash is intentionally excluded from this package. Build/Test belongs to deterministic Verification, not free-form Agent shell execution. If later needed, add a separate reviewed profile.

## 8. Git and Workspace semantics

The Agent edits the checkout but does not create Git history in this package.

After Agent completion, Worker computes a sanitized Workspace change snapshot:

```ts
type WorkspaceChangeSummary = {
  baseCommit: string;
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  diffStat: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  contentRevision: string;
};
```

Constraints:

- no raw diff required in core DB.
- paths are repository-relative and bounded.
- `contentRevision` is a deterministic digest of resulting worktree content, not a fake commit SHA.
- `baseCommit` remains checked-out source revision.
- identical resulting content must produce identical contentRevision.

## 9. Subject revision semantics

Read-only Work may continue using source commit SHA.

Write-enabled Work uses:

```
subjectRevision = workspace:<contentRevision>
```

Flow:

1. Agent completes.
2. Worker computes WorkspaceChangeSummary.
3. Verification runs against that exact Workspace.
4. Worker reports change summary + verification results.
5. Orchestrator sets current subject revision to `workspace:<digest>`.
6. Evidence binds to that revision.
7. Previous Evidence / Review / Approval is stale when content revision changes.

## 10. Verification pipeline

```
Agent container
  rw /workspace
      |
      v
Agent exits
      |
      v
Worker computes contentRevision
      |
      v
Verification container(s)
  ro /workspace
  network none
  no model/MCP/Git secrets
      |
      v
VerificationResults
      |
      v
worker_verified Evidence
```

Build/Test commands remain Workflow-defined argv-only verification steps. Failed required verification follows the existing durable continuation policy.

## 11. Run / continuation semantics

Continuation preserves:

```
same WorkItem
same WorkAttempt
same ExpertTask
same Workspace
same required Runtime Profile
preferred same owner Worker
new Run when process-level continuation is needed
```

Never silently downgrade or switch the write profile. Existing owner-unavailable fail-closed behavior remains.

## 12. ReviewDecision and Approval

Review answers whether the proposed solution is acceptable. Existing decisions remain accepted/rework/rejected and bind to current subject revision.

Approval answers whether this exact subject revision is authorized for the next controlled action / completion policy.

Initial scope:

```
approvalScope = "work_completion"
subjectType = "workspace_revision"
subjectRevision = "workspace:<digest>"
```

For write-enabled Work, extend the Workflow schema structurally rather than encoding approval scope into a free-form string:

```ts
completion: {
  require: Array<
    | "latest_work_attempt_succeeded"
    | "required_evidence_passed"
    | "no_unresolved_blocker"
    | "review_accepted"
    | "required_approvals_approved"
  >;
  requiredApprovals?: Array<{
    scope: "work_completion";
    subjectType: "workspace_revision";
  }>;
}
```

Phase 1 supports only the platform-defined pair `work_completion + workspace_revision`. The definition validator rejects unknown approval scopes or subject types. A later package may generalize the registry without changing stored Approval rows.

When `required_approvals_approved` is present, Completion Gate checks every `requiredApprovals` entry against a non-stale `approved` Approval for the exact current subject revision. Missing reasons are reported as `required_approval:<scope>`.

Review without Approval is insufficient. Approval without Review is insufficient. Stale Review/Approval is insufficient.

## 13. MCP API

### submit_work

No `writable=true` or sandbox override is exposed. Caller selects a Workflow; Workflow selects required Runtime Profile.

### get_work / wait_work

Expose required/effective Runtime Profile, WorkspaceChangeSummary, current content revision, Verification, Review, Approval and Completion Gate.

### approval action

Expose a dedicated approval tool for explicit human authorization.

Inputs:

- workItemId
- expectedRevision
- subjectRevision
- approvalScope
- decision

Actor and role derive from authenticated principal/authorization context, not free-form model strings. The Agent cannot self-approve.

Phase 1 authorization is platform-owned:

- caller must have role `admin` or `developer`.
- `worker-mcp-readonly` is always denied and the approval tool remains outside the Worker MCP allowlist.
- stored `actor` is `principal.id`.
- stored `role` is the authorizing role used by the platform: `admin` if present, otherwise `developer`.
- Workflow definitions cannot broaden the approver role set.
- approval must be an explicit user authorization; tool description and client guidance must prohibit implicit/model-inferred approval.

## 14. Admin UI

Work detail shows:

1. required/effective Runtime Profile
2. Workspace owner/base commit/content revision
3. change summary and changed path list
4. Verification build/test results
5. Review
6. Approval
7. Completion Gate

A full raw diff viewer is not required in this package.

## 15. Error and blocker semantics

Deterministic blockers:

- `RUNTIME_PROFILE_REQUIRED`
- `RUNTIME_PROFILE_MISMATCH`
- `RUNTIME_PROFILE_UNSUPPORTED`
- `RUNTIME_PROFILE_UNAVAILABLE`
- `WORKSPACE_WRITE_NOT_ALLOWED`
- `APPROVAL_REQUIRED`

They are durable policy/gate outcomes, not transient retries. Unknown profiles never imply write.

## 16. Backward compatibility

- Existing `codex-readonly` and `claude-readonly` behavior remains.
- Workflows without `execution.requiredRuntimeProfile` retain existing routing behavior.
- Default Workflow remains read-only in current deployments.
- Existing ExpertTask API remains.
- Existing Deployment profile strings are not rewritten.
- Unknown historic/custom profiles may retain existing claim compatibility for legacy/read-only execution paths, but never gain workspace-write semantics by name guessing.
- A Workflow that explicitly requires workspace-write must reference one of the platform-owned workspace-write profiles; custom/unknown profiles are rejected by Workflow validation for this capability.

## 17. Security invariants

1. Profile policy is finite and platform-owned.
2. Caller cannot enable write with a boolean.
3. Name pattern matching never grants privilege.
4. Unknown profile never implies write.
5. Workspace path validation is mandatory before rw mount.
6. Container root remains readonly.
7. Docker socket is never mounted.
8. Credentials/config remain readonly.
9. Verification remains independently readonly/no-network/no model secret.
10. Approval cannot elevate a running Agent.
11. Agent cannot satisfy its own ReviewDecision or Approval.
12. Revision changes stale prior Evidence / Review / Approval.

## 18. Implementation boundary

This package should implement:

1. Runtime Profile policy registry.
2. Workflow `execution.requiredRuntimeProfile` validation.
3. Dispatch profile compatibility enforcement.
4. Executor workspaceAccess plumbing.
5. Codex workspace-write mount + CLI sandbox.
6. Claude workspace-write mount + Edit/Write without Bash.
7. Workspace change summary + deterministic content revision.
8. write-aware subject revision.
9. Build/Test verification over resulting Workspace.
10. Completion Gate required approval.
11. authenticated MCP approval action.
12. MCP/Admin visibility.
13. real Codex + Claude live acceptance.

It does not implement Git publication.

## 19. Acceptance criteria

Security:

- readonly profile cannot modify Workspace.
- write profile can modify only Workspace.
- unknown/custom profile does not gain write.
- rootfs and credentials remain readonly.
- verifier remains isolated.

State:

- mutation creates deterministic `workspace:<digest>`.
- same content -> same revision.
- changed rework -> new revision.
- old Evidence/Review/Approval becomes stale.
- continuation preserves Workspace/profile.

Workflow:

- build/test PASS + review accepted + required approval approved -> complete.
- failed required verification -> existing continuation/rework policy.
- review without approval -> not complete.
- approval without review -> not complete.
- stale review/approval -> not complete.

Real acceptance:

```
submit_work(write-enabled workflow)
-> modify harmless fixture
-> build/test pass
-> change summary visible
-> waiting_review
-> review accepted
-> approval approved
-> completed
```

Run for both Codex and Claude. Claude uses Edit/Write, not Bash.

## 20. Approaches considered

### A. Runtime Profile-driven permissions — selected

Reuses existing Deployment/Worker compatibility, keeps a finite auditable policy vocabulary, prevents caller privilege escalation, and maps cleanly to backend-specific controls.

### B. Workflow writable boolean — rejected

Workflow alone must not elevate a read-only Deployment.

### C. Separate mutation Worker/Task — deferred

Introduces multi-node orchestration before the single-node write lifecycle is proven.

## 21. Builder calls

Implementation may choose:

- exact TypeScript shape of RuntimeProfilePolicy
- exact deterministic worktree digest algorithm
- bounded changed-file/path limits
- Admin presentation styling
- whether approval-awaiting is represented only by Gate missing state or a more explicit future status

These choices must preserve the invariants above.
