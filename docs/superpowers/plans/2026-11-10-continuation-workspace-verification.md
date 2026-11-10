# Continuation, Workspace Lifecycle, and Verification Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the completed Work Orchestration Phase 1 with durable Run/Turn continuation semantics, real per-WorkAttempt workspace lifecycle, and Worker-executed verification evidence, without adding Tracker adapters or write-enabled/PR automation.

**Architecture:** Keep WorkItem/WorkAttempt as the durable control plane. ExpertTask remains the execution object; process-level continuation reuses the same ExpertTask and WorkAttempt but creates a new Run on the same logical workspace. Worker repository preparation becomes workspace-keyed instead of repository-only. Verification runs on the same prepared workspace after agent execution and reports structured worker-verified Evidence to the Hub. Current Codex/Claude runtimes do not expose reliable session resume, so this plan does not claim same-model-session resume; it persists Turn/Run boundaries so a future Runtime Adapter can add resume without changing orchestration semantics.

**Tech Stack:** TypeScript, Node.js, SQLite, gRPC, Docker, Codex/Claude CLI workers, node:test.

**Spec:** `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`

## Global Constraints

- MCP remains the active Work source; GitHub/GitLab/Jira Tracker adapters are out of scope.
- Existing standalone `submit_expert_task` behavior remains backward-compatible.
- No Agent text parsing is used to decide completion or continuation.
- WorkItem, WorkAttempt, retry/continuation scheduling, workspace identity, evidence and gate state remain durable.
- Every WorkAttempt keeps pinned workflow/expert/deployment config.
- Continuation/retry must reconcile current Work/Task/Worker/Workspace facts before dispatch.
- Workspace owner affinity is fail-closed; no implicit cross-Worker migration.
- Evidence used by Completion Gate must bind the current subject revision and verifier/environment identity.
- Current read-only Runtime Profiles remain read-only; write-enabled Work is a later package.

## Review Focus

1. A stale completion/turn event from an older Run must never advance the current Run or WorkItem.
2. A continuation after Worker/workspace loss must block with `workspace_unavailable`, not silently create a different checkout.
3. Two WorkAttempts for the same repository must never share a physical checkout.
4. Verification failure must not be recorded as passed Evidence or allow the Completion Gate to complete.
5. Hub restart during scheduled continuation/verification must reconcile exactly once without creating another effective Task.

---

### Task 1: Persist Run Turn boundaries

**Files:**
- Modify: `src/expert-platform/task-store.ts`
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify: `src/expert-platform/worker-daemon.ts`
- Test: `tests/expert-platform-task-store.test.ts`
- Test: `tests/expert-platform-worker-daemon.test.ts`

**Interfaces:**
- Produces: `TaskRunTurnRecord`, `ExpertTaskStore.recordRunActivity(...)`, `ExpertTaskStore.listRunTurns(taskId)`.
- Existing `reportTaskStage` remains the transport; `model.started` opens a Turn and `model.completed/model.failed` closes the active Turn using run fencing + source sequence.

- [ ] Write failing tests that persist Turn #1/#2 under one Run, ignore duplicate source sequence, and fence stale Run events.
- [ ] Run focused tests and verify RED.
- [ ] Add `expert_run_turns` SQLite table and turn recording/list APIs.
- [ ] Route model activity stage reports into the Turn store without changing existing event retention.
- [ ] Run focused tests and verify GREEN.
- [ ] Run task/worker/grpc regression tests.

### Task 2: Durable process-level continuation on the same ExpertTask

**Files:**
- Modify: `src/expert-platform/task-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-task-store.test.ts`

**Interfaces:**
- Produces: `ExpertTaskStore.scheduleContinuation(taskId, expectedRunId, reason, now)`.
- Produces: durable `next_action_type=continuation` and continuation count bounded by `maxTurnsPerRun`.
- Semantics: same WorkAttempt + same ExpertTask, new Run when Worker reclaims; no claim of same CLI session resume.

- [ ] Write failing tests for succeeded Task -> continuation scheduled -> same Task ID requeued -> new Run/fencing.
- [ ] Add stale-run/idempotent scheduling tests and max continuation limit test.
- [ ] Run focused tests and verify RED.
- [ ] Implement Task continuation requeue and WorkOrchestrator scheduling/reconciliation.
- [ ] Verify continuation never creates a second WorkAttempt or second effective ExpertTask.
- [ ] Run focused and Work/MCP regression tests.

### Task 3: Make physical repository checkouts workspace-keyed

**Files:**
- Modify: `src/expert-platform/task-store.ts`
- Modify: `src/expert-platform/expert-dispatch-service.ts`
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify: `src/expert-platform/repository-workspace.ts`
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Test: `tests/expert-platform-repository-workspace.test.ts`
- Test: `tests/expert-platform-docker-codex-executor.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- ExpertTask/Claim carries `workspaceKey`.
- `prepareRepositoryWorkspace({ ..., workspaceKey })` resolves checkout under `<worker-repository-root>/<workspaceKey>/<repositoryId>`.
- Same WorkAttempt continuation/retry reuses the same workspaceKey; a new WorkAttempt gets a different key.

- [ ] Write failing path isolation/reuse tests.
- [ ] Run tests and verify RED.
- [ ] Persist workspaceKey on ExpertTask and expose it through gRPC Claim.
- [ ] Update repository preparation to validate workspaceKey and isolate paths.
- [ ] Run focused tests and verify GREEN.
- [ ] Run existing Git credential/proxy/repository regression tests.

### Task 4: Report Workspace owner/path/state back to the Hub

**Files:**
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify: `src/expert-platform/remote-worker.ts`
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-grpc-transport.test.ts`

**Interfaces:**
- Worker reports `workspace.ready` with workspaceKey, ownerWorkerId, repository revision and a Worker-local path identifier.
- Hub transitions Workspace `allocating -> ready -> in_use -> retained`.
- Reconciliation verifies current active Task worker matches workspace owner.

- [ ] Write RED tests for owner/path update and stale worker event fencing.
- [ ] Add structured workspace stage payload to worker transport.
- [ ] Update durable Workspace records and lifecycle events.
- [ ] Add `workspace_unavailable` blocker when owner/workspace cannot be verified before continuation.
- [ ] Run focused and restart reconciliation tests.

### Task 5: Add explicit Workspace retention and terminal cleanup policy

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify/Create: `src/expert-platform/workspace-cleanup.ts`
- Test: `tests/workspace-cleanup.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Workflow workspace policy supports `cleanup: on_terminal|retain` and `reuseOnContinuation`.
- Cleanup request is durable; Worker-local deletion is idempotent.
- Hub records `cleaning/removed`; cleanup failure does not rewrite a completed WorkItem to failed.

- [ ] Write cleanup/retain/restart RED tests.
- [ ] Implement durable cleanup request/ack protocol.
- [ ] Implement safe deletion constrained beneath Worker repository root.
- [ ] Run focused tests and verify GREEN.

### Task 6: Pin a Verification policy into each WorkAttempt/ExpertTask

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/expert-dispatch-service.ts`
- Modify: `src/expert-platform/task-store.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/expert-platform-task-store.test.ts`

**Interfaces:**
- WorkflowDefinition adds/uses structured `validation.required[]` entries with stable IDs, command argv, timeout and evidence type.
- WorkAttempt pins the exact workflow version; ExpertTask Claim carries a validation snapshot.
- No free-form shell string execution: validation command is argv-based and policy-pinned.

- [ ] Write RED tests for workflow validation schema, version pinning and malformed command rejection.
- [ ] Persist validation snapshot with the Task.
- [ ] Expose validation policy in Claim.
- [ ] Run focused tests and verify GREEN.

### Task 7: Worker Verification Runner and structured Evidence

**Files:**
- Create: `src/expert-platform/verification-runner.ts`
- Modify: `src/expert-platform/docker-codex-executor.ts`
- Modify: `src/expert-platform/remote-worker.ts`
- Modify: `src/expert-platform/grpc-transport.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/expert-platform-verification-runner.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- `runVerificationPolicy(workspacePath, policy, signal) -> VerificationResult[]`.
- Worker sends verification results with type/status/subject revision/environment identity/verifier identity.
- Hub records them as `worker_verified` Evidence.
- Required failed verification schedules continuation if allowed; exhausted continuation leaves Work in `waiting_review` or `failed` per workflow policy.

- [ ] Write RED tests for PASS/FAIL/timeout/abort and no-shell execution.
- [ ] Implement isolated verifier process execution in the same workspace.
- [ ] Extend worker completion transport with structured verification results.
- [ ] Record Evidence only when subject revision equals the verified checkout revision.
- [ ] Connect failed required verification to Task 2 continuation scheduling.
- [ ] Run focused tests and verify GREEN.

### Task 8: Completion Gate, Admin/MCP visibility, restart acceptance

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-admin-ui.ts`
- Modify: `src/mcp.ts`
- Test: `tests/expert-platform-admin-e2e.test.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**
- Completion Gate consumes required current non-stale validation Evidence.
- `get_work/wait_work` expose turns, workspace lifecycle and verification summary.
- Admin Work detail displays Run/Turn, Workspace state, validation Evidence and continuation reason.

- [ ] Write RED Admin/MCP tests.
- [ ] Extend detail payloads/UI without breaking existing Work API fields.
- [ ] Verify stale/failed evidence cannot satisfy the gate.
- [ ] Restart Hub between continuation and verification completion and prove reconciliation resumes exactly once.
- [ ] Run full `npm run check`, whole-branch review, then real Claude CLI acceptance using MCP Work source and the persisted OTA Worker v2 configuration.
