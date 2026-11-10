# Write-enabled Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a controlled workspace-write execution path where Workflow-selected Runtime Profiles allow Codex/Claude to edit only the isolated WorkAttempt Workspace, then Build/Test verification, ReviewDecision and explicit Approval determine completion.

**Architecture:** Formalize Runtime Profile IDs as platform-owned security policies. Workflow pins a required profile, dispatch enforces exact Deployment compatibility, Worker resolves that profile to backend-specific Docker/CLI permissions, and the Worker computes a deterministic Workspace content revision after mutation. Existing Verification consumes that exact resulting Workspace, while Completion Gate requires current Evidence, Review and configured Approval. Git commit/push/PR remain out of scope.

**Tech Stack:** TypeScript, Node.js, SQLite, gRPC, Docker, Codex CLI, Claude Code CLI, node:test.

**Spec:** `docs/superpowers/specs/2026-11-10-write-enabled-work-design.md`

## Global Constraints

- No caller-provided `writable` boolean or arbitrary sandbox override.
- Platform-owned initial profiles are exactly `codex-readonly`, `codex-workspace-write`, `claude-readonly`, `claude-workspace-write`.
- Unknown/custom Runtime Profiles never gain workspace-write permission by name matching.
- Docker root filesystem remains `--read-only`; only validated `/workspace` may become read-write.
- Credentials, auth/config/MCP mounts remain read-only.
- Codex write mode uses `--sandbox workspace-write`; never `danger-full-access`.
- Claude write mode permits `Read,Glob,Grep,Edit,Write`; Bash remains disabled.
- Verification remains independent, read-only, no-network, and without model/MCP/Git secrets.
- Write-enabled subject revision is `workspace:<contentRevision>`.
- Approval is never a runtime privilege escalation mechanism.
- Approval caller must have `admin` or `developer`; Worker principals cannot approve.
- This package does not commit, push, create PR/MR, or merge.

## Review Focus

1. Unknown/custom Runtime Profile presented by Deployment or Worker must fail closed for write semantics rather than accidentally matching by name.
2. Explicit Deployment whose profile mismatches Workflow requirement must block deterministically without fallback; auto routing must select only exact-profile Deployments.
3. Writable mount path must remain under the Worker repository root; symlink/path traversal must not turn an arbitrary host path into a read-write mount.
4. Workspace content digest must include tracked modifications plus added/deleted/untracked files deterministically, while ignoring Git metadata ordering/noise.
5. Review/Approval/Evidence from a prior workspace revision must become stale and must not satisfy the current Completion Gate.

---

### Task 1: Platform Runtime Profile policy registry

**Files:**
- Create: `src/expert-platform/runtime-profile-policy.ts`
- Test: `tests/expert-platform-runtime-profile-policy.test.ts`
- Modify: `src/expert-platform/worker-runtime-config.ts`
- Test: `tests/expert-platform-worker-runtime-config.test.ts`

**Interfaces:**
- Produces: `RuntimeProfileId`, `RuntimeProfilePolicy`, `resolveRuntimeProfilePolicy(profileId: string): RuntimeProfilePolicy`.
- Produces: `isPlatformWorkspaceWriteProfile(profileId: string): boolean`.
- Worker config continues to advertise configured profile IDs; it does not infer permissions itself.

- [ ] **Step 1: Write failing registry tests**
  - exact four platform IDs resolve to the expected backend/workspaceAccess/agentPermissions.
  - unknown ID throws `UNKNOWN_RUNTIME_PROFILE`.
  - `custom-workspace-write` does not gain permission by substring.
  - backend mismatch helper rejects `claude-workspace-write` on a Codex Worker.

- [ ] **Step 2: Run RED**
  - Run: `node --test --import tsx tests/expert-platform-runtime-profile-policy.test.ts tests/expert-platform-worker-runtime-config.test.ts`
  - Expected: FAIL because registry does not exist.

- [ ] **Step 3: Implement the registry**
  - Create `runtime-profile-policy.ts` with the finite four-entry map.
  - Keep worker env parsing syntax-compatible with existing custom profile strings, but do not grant them write policy.

- [ ] **Step 4: Run GREEN**
  - Same command; expected PASS.

- [ ] **Step 5: Commit**
  - `git commit -m "feat(worker): formalize runtime profile policies"`

### Task 2: Workflow required Runtime Profile and structured Approval requirements

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Test: `tests/work-orchestration-store.test.ts`

**Interfaces:**
- Extends `WorkflowDefinition.execution.requiredRuntimeProfile?: RuntimeProfileId`.
- Extends Completion Gate token union with `"required_approvals_approved"`.
- Adds `completion.requiredApprovals?: Array<{ scope: "work_completion"; subjectType: "workspace_revision" }>`.

- [ ] **Step 1: Write failing Workflow validation tests**
  - versioned Workflow accepts `codex-workspace-write`.
  - write-required Workflow rejects unknown/custom Runtime Profile.
  - `required_approvals_approved` requires a non-empty valid `requiredApprovals`.
  - unsupported approval scope/subject type rejects registration.
  - legacy Workflows without either field normalize unchanged.

- [ ] **Step 2: Run RED**
  - Run: `node --test --import tsx tests/work-orchestration-store.test.ts`
  - Expected: FAIL on new schema assertions.

- [ ] **Step 3: Implement schema normalization/validation**
  - Import Runtime Profile policy types.
  - Preserve default Workflow definition unchanged/read-only.

- [ ] **Step 4: Run GREEN**
  - Same test; expected PASS.

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): add runtime and approval workflow policy"`

### Task 3: Dispatch exact Runtime Profile compatibility

**Files:**
- Modify: `src/expert-platform/expert-dispatch-service.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/expert-platform-dispatch.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- `ExpertDispatchService.resolve(...)` accepts/uses `requiredRuntimeProfile?: string` from Work orchestration.
- Auto routing filters eligible Deployments before ranking.
- Explicit mismatch throws `RUNTIME_PROFILE_MISMATCH`.
- Auto no-match throws `RUNTIME_PROFILE_UNAVAILABLE`.

- [ ] **Step 1: Write failing dispatch tests**
  - auto chooses matching write Deployment over otherwise-valid readonly Deployment.
  - auto with no exact match throws `RUNTIME_PROFILE_UNAVAILABLE`.
  - explicit readonly Deployment for write Workflow throws `RUNTIME_PROFILE_MISMATCH`.
  - legacy submission without required profile preserves current routing.

- [ ] **Step 2: Run RED**
  - Run focused dispatch + orchestrator tests.

- [ ] **Step 3: Implement exact-profile filtering and deterministic blocker classification**
  - WorkOrchestrator passes pinned Workflow requirement into dispatch.
  - Deterministic failures map to durable `policy_blocked`, not retry.

- [ ] **Step 4: Run GREEN and Work/MCP regression tests**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): enforce required runtime profiles"`

### Task 4: Executor permission plumbing and Codex workspace-write

**Files:**
- Modify: `src/expert-platform/codex-container-executor.ts`
- Modify: `src/expert-platform/codex-runtime.ts`
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Modify: `src/expert-platform/worker-daemon.ts`
- Test: `tests/expert-platform-codex-container-executor.test.ts`
- Test: `tests/expert-platform-docker-codex-executor.test.ts`
- Test: `tests/expert-platform-worker-daemon.test.ts`

**Interfaces:**
- `CodexDockerConfig.workspaceAccess: "read-only" | "read-write"`.
- `buildCodexArgs(problem, workspaceAccess)` replaces read-only-only argument construction while preserving `buildCodexReadOnlyArgs` compatibility if needed.
- Executor resolves `claim.deploymentSnapshot.runtimeProfile` through Task 1 policy.

- [ ] **Step 1: Write failing security tests**
  - readonly emits readonly bind + `--sandbox read-only`.
  - write emits rw bind + `--sandbox workspace-write`.
  - rootfs remains `--read-only` in both.
  - auth/config/MCP mounts remain readonly.
  - unknown/custom profile fails before Docker launch.
  - validated Workspace path remains mandatory.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement permission plumbing**
  - No boolean from MCP/Workflow reaches Docker directly; only resolved policy does.

- [ ] **Step 4: Run GREEN plus repository/workspace/security regression tests**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(worker): add codex workspace-write profile"`

### Task 5: Claude workspace-write without Bash

**Files:**
- Modify: `src/expert-platform/claude-runtime.ts`
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Test: `tests/expert-platform-claude-runtime.test.ts`
- Test: `tests/expert-platform-docker-codex-executor.test.ts`

**Interfaces:**
- `buildClaudeArgs(problem, model, stream, maxTurns, agentPermissions)`.
- Read-only tools remain `Read,Glob,Grep`.
- Workspace-write tools are exactly `Read,Glob,Grep,Edit,Write`.

- [ ] **Step 1: Write failing tests**
  - readonly behavior unchanged.
  - write includes Edit/Write.
  - Bash, NotebookEdit and agent tools are absent in both.
  - Docker workspace bind follows resolved policy.
  - `claude-workspace-write` cannot execute on a Codex backend and vice versa.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement backend-specific Claude policy**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(worker): add claude workspace-write profile"`

### Task 6: Deterministic Workspace change summary and content revision

**Files:**
- Create: `src/expert-platform/workspace-change-summary.ts`
- Test: `tests/expert-platform-workspace-change-summary.test.ts`
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Modify: `src/expert-platform/remote-worker.ts`

**Interfaces:**
- Produces:
  `computeWorkspaceChangeSummary(workspacePath: string, baseCommit: string): Promise<WorkspaceChangeSummary>`.
- `WorkspaceChangeSummary` contains bounded changed/added/deleted path arrays, diffStat and `contentRevision`.
- Executor result optionally returns `workspaceChangeSummary`.

- [ ] **Step 1: Write failing deterministic Git fixture tests**
  - unchanged checkout produces stable empty summary.
  - tracked edit, added untracked file and deletion are all represented.
  - identical resulting content in two clones produces identical `contentRevision`.
  - changing file content changes `contentRevision`.
  - path list is repository-relative, sorted and bounded.
  - symlink/path traversal fixture cannot cause reads outside repository.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement using argv-only Git commands**
  - Use Git status/diff plumbing with explicit argv; do not invoke shell.
  - Digest a canonical normalized representation of resulting file state and deletion markers, not timestamps or Git index ordering.

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Integrate summary after successful Agent process and before Verification**

- [ ] **Step 6: Run Docker executor regression tests**

- [ ] **Step 7: Commit**
  - `git commit -m "feat(workspace): capture deterministic change revisions"`

### Task 7: Persist change summary and use workspace revision as Work subject

**Files:**
- Modify: `src/expert-platform/proto/expert-worker.proto`
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify: `src/expert-platform/task-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Test: `tests/expert-platform-task-store.test.ts`
- Test: `tests/expert-platform-grpc-transport.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Task completion persists `workspaceChangeSummary`.
- Write-enabled task subject is `workspace:<contentRevision>`; read-only remains commit SHA/current behavior.
- Verification results for write-enabled tasks bind to the workspace subject revision, not base commit.

- [ ] **Step 1: Write failing persistence/fencing tests**
  - gRPC completion survives restart with exact change summary.
  - mismatched verification subject is rejected.
  - mutation updates Work current subject to `workspace:<digest>`.
  - new content revision marks old Evidence/Review/Approval stale.
  - same content revision does not create false staleness.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Extend completion transport/store and subject calculation**

- [ ] **Step 4: Run GREEN including restart reconciliation tests**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): bind mutable work to workspace revisions"`

### Task 8: Verification over mutated Workspace

**Files:**
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Modify: `src/expert-platform/verification-runner.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/expert-platform-verification-runner.test.ts`
- Test: `tests/expert-platform-docker-codex-executor.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Verification remains readonly/no-network.
- Verification Evidence subject revision equals `workspace:<contentRevision>` for write-enabled Work.
- Failure uses existing durable continuation path on same Workspace/profile.

- [ ] **Step 1: Write failing tests**
  - verifier observes Agent-written file from same Workspace.
  - verifier mount is readonly even though Agent mount was rw.
  - verifier receives no model/MCP/Git credential env.
  - PASS Evidence binds workspace revision.
  - failed required verifier schedules continuation on same Task/Workspace/profile.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement subject override and ordering: Agent -> digest -> verifier -> completion**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): verify mutable workspace revisions"`

### Task 9: Approval Completion Gate

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Completion Gate consumes `required_approvals_approved` + `requiredApprovals`.
- Missing reason format: `required_approval:work_completion`.

- [ ] **Step 1: Write failing Gate tests**
  - review accepted + evidence PASS but no approval => not ready.
  - approval only but no accepted review => not ready.
  - current approved `work_completion/workspace_revision` + accepted review + evidence => ready.
  - rejected/stale/wrong-subject/wrong-scope approval => not ready.
  - later workspace revision stales earlier approval.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement exact-current-revision Approval evaluation**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): require revision-bound approvals"`

### Task 10: Authenticated MCP Work approval action

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**
- Produces MCP tool `approve_work`.
- Input: `workItemId`, `expectedRevision`, `subjectRevision`, `approvalScope: "work_completion"`, `decision: "approved" | "rejected"`.
- Actor/role are derived from authenticated principal.
- Allowed caller roles: `admin` or `developer`.

- [ ] **Step 1: Write failing authorization/e2e tests**
  - developer approval stores principal ID + developer role.
  - admin wins as stored authorizing role when principal has both.
  - worker readonly principal is forbidden.
  - no user-provided actor/role fields exist in schema.
  - stale expectedRevision or subjectRevision rejects.
  - explicit approval can complete a Work only when Review and Gate conditions are otherwise satisfied.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement Orchestrator approval wrapper and MCP tool**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(mcp): add explicit work approval"`

### Task 11: MCP/Admin visibility for writable Work

**Files:**
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/mcp.ts`
- Modify: `src/server.ts`
- Modify: `src/expert-admin-ui.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`
- Test: `tests/expert-platform-admin-e2e.test.ts`

**Interfaces:**
- `get_work/wait_work` expose required/effective Runtime Profile, WorkspaceChangeSummary, content revision, Review, Approval and Gate.
- Admin detail renders the same information.

- [ ] **Step 1: Write failing MCP/Admin tests**
  - changed path list and diffStat visible.
  - required/effective profiles visible.
  - approval list contains no secrets.
  - Gate missing reason `required_approval:work_completion` visible.
  - legacy readonly Work detail remains compatible.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Extend detail payload/UI**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(admin): show writable work state"`

### Task 12: Worker v2 write-profile configuration and real acceptance

**Files:**
- Modify: `worker-runtime/worker.env.example`
- Modify: `worker-runtime/README.md`
- Modify: `docs/expert-platform/add-expert.md`
- Test: `tests/expert-platform-worker-install-scripts.test.ts`
- Runtime acceptance: current isolated Worktree + persisted OTA Worker

**Interfaces:**
- Worker may advertise both readonly and write profile only when the operator explicitly configures them.
- No migration silently adds write profile to existing Workers.

- [ ] **Step 1: Add configuration tests/documentation**
  - examples show explicit comma-separated write profile opt-in.
  - existing Worker env remains readonly unless edited.

- [ ] **Step 2: Run worker install/runtime config tests**

- [ ] **Step 3: Configure a dedicated write-capable acceptance Deployment/Worker profile**
  - Do not mutate existing readonly Deployment semantics.

- [ ] **Step 4: Real Codex acceptance through Claude CLI + MCP**
  - Submit write-enabled Workflow.
  - Modify a harmless repository fixture.
  - Assert WorkspaceChangeSummary and `workspace:<digest>`.
  - Assert Build/Test verifier PASS.
  - Assert `waiting_review`.
  - Submit accepted Review.
  - Assert Gate still missing `required_approval:work_completion`.
  - Submit explicit approval.
  - Assert `completed`.
  - Restart Hub and confirm durable final state.

- [ ] **Step 5: Real Claude-backend acceptance**
  - Same lifecycle with `claude-workspace-write`.
  - Confirm Agent tools include Edit/Write and exclude Bash.

- [ ] **Step 6: Full validation**
  - Run: `git diff --check && npm run check && npm run build`
  - Expected: 0 failures.

- [ ] **Step 7: Whole-package review**
  - Review security boundaries, revision staleness, Approval authorization, and backward compatibility.
