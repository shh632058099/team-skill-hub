# Work Orchestration Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Phase 1 Team Skill Hub Work Orchestration model on top of the existing Expert Platform, preserving existing ExpertTask APIs while adding durable WorkItem orchestration, WorkAttempt/retry/rework semantics, evidence/review/completion gates, MCP/Admin surfaces, and real Claude CLI acceptance.

**Architecture:** Add a dedicated durable `WorkOrchestrationStore` in the same Expert Runtime SQLite database and a `WorkOrchestrator` service that coordinates WorkItems with the existing `ExpertDispatchService`. Existing ExpertTask/Run execution remains authoritative for actual Worker execution; the new layer links tasks to WorkAttempts, reconciles task outcomes into durable WorkItem state, and uses idempotent recovery rather than replacing the worker protocol. Tracker integrations are explicitly out of scope for this phase; the internal source identity/adapter boundary is designed so GitHub/GitLab/Jira can be added later.

**Tech Stack:** TypeScript, Node.js 22+, `node:sqlite`, Fastify, MCP SDK, existing Expert Platform Worker/SQLite/Admin UI.

**Spec:** `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`

## Global Constraints

- Keep all existing ExpertTask APIs and behavior backward compatible.
- WorkItem is Hub-owned; Tracker integrations are not implemented in Phase 1.
- Work orchestration state is durable; do not rely on process-only timers/sets as the source of truth.
- `WorkItem -> WorkAttempt -> ExpertTask -> Run -> Agent Turn(s)` remains the semantic hierarchy.
- Normal continuation stays in the same Run/session where the executor supports it; failure retry creates a new Run; human/review rework creates a new WorkAttempt.
- Workflow version, Expert, Deployment, and Deployment config version are pinned for each WorkAttempt.
- TaskFeedback is an orchestration signal, never a substitute for ReviewDecision or Approval.
- Completion evidence must identify provenance and the revision/artifact/environment it validates; stale evidence cannot satisfy the gate.
- Reconciliation occurs before dispatch/retry/resume.
- Phase 1 uses Workspace affinity: if a retained workspace cannot be validated on its owner Worker, block instead of guessing cross-Worker migration.
- No GitHub/GitLab/Jira polling or provider-specific workflow logic in this plan.
- Do not push or merge from the worktree.

## Review Focus

- Crash between WorkAttempt creation and ExpertTask linkage must reconcile to one task, never duplicate work.
- Duplicate MCP/Admin submissions with the same idempotency/source identity must reuse the same WorkItem; conflicting payloads must fail closed.
- A stale Run/WorkAttempt event or stale ReviewDecision must not advance the current WorkItem.
- Evidence for a previous revision must become stale and must not satisfy the current Completion Gate.
- Feedback with `needsRework=true` must create at most one new WorkAttempt even when replayed.

---

### Task 1: Durable WorkItem, Workflow, and WorkAttempt store

**Files:**
- Create: `src/expert-platform/work-orchestration-store.ts`
- Create: `tests/work-orchestration-store.test.ts`
- Add: `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`

**Interfaces:**
- Produces `WorkOrchestrationStore`, `WorkItemRecord`, `WorkAttemptRecord`, `WorkflowDefinitionRecord`.
- Produces `createOrReuseWork(input)`, `getWork(workItemId, principalId, scope)`, `createWorkAttempt(...)`, `linkAttemptTask(...)`, `transitionWork(...)`, `listDueWorkIds(...)`.
- The default workflow is immutable version `code-fix-default@1`, single-node, maxWorkAttempts=5, maxReworks=3, maxRunsPerWorkAttempt=3, maxTurnsPerRun=20, required evidence `expert_result`, human review required.

- [ ] **Step 1: Write failing store tests**
  - idempotent WorkItem creation and digest conflict.
  - source tuple uniqueness.
  - state revision CAS failure.
  - only one active WorkAttempt.
  - workflow version pinning.
  - reopen preserves all records.
- [ ] **Step 2: Run** `node --test --import tsx tests/work-orchestration-store.test.ts`
  - Expected: FAIL because the store/module does not exist.
- [ ] **Step 3: Implement the store and SQLite schema**
  - Tables: `work_workflows`, `work_items`, `work_attempts`, `work_events`.
  - All state mutations use `BEGIN IMMEDIATE` plus revision checks.
- [ ] **Step 4: Re-run the focused test**
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - `git add docs/superpowers/specs/2026-11-09-work-orchestration-design.md src/expert-platform/work-orchestration-store.ts tests/work-orchestration-store.test.ts`
  - `git commit -m "feat(work): add durable work orchestration store"`

### Task 2: Workspace, evidence, review decision, approval, and completion-gate persistence

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `tests/work-orchestration-store.test.ts`

**Interfaces:**
- Produces `WorkspaceRecord`, `WorkEvidenceRecord`, `ReviewDecisionRecord`, `WorkApprovalRecord`.
- Produces `ensureWorkspace(...)`, `assignWorkspaceOwner(...)`, `recordEvidence(...)`, `markEvidenceStale(...)`, `submitReviewDecision(...)`, `recordApproval(...)`, `evaluateCompletionGate(...)`.
- `workspaceKey` is deterministic from WorkItem identity and collision-safe.
- Review/approval inputs carry expected WorkItem revision and subject revision.

- [ ] **Step 1: Add failing tests**
  - deterministic workspace key and owner affinity.
  - evidence provenance and subject revision persistence.
  - old evidence stales when subject revision changes.
  - stale review/approval revision rejected.
  - completion gate ignores stale evidence and TaskFeedback.
- [ ] **Step 2: Run focused test and observe RED.**
- [ ] **Step 3: Implement tables and methods**
  - Tables: `work_workspaces`, `work_evidence`, `work_review_decisions`, `work_approvals`.
- [ ] **Step 4: Re-run focused test and observe GREEN.**
- [ ] **Step 5: Commit**
  - `git commit -am "feat(work): persist workspace evidence and review gates"`

### Task 3: Link ExpertTask/Run to WorkAttempt and support durable Run retry

**Files:**
- Modify: `src/expert-platform/task-store.ts`
- Modify: `src/expert-platform/expert-dispatch-service.ts`
- Modify: `tests/expert-platform-task-store.test.ts`
- Modify: `tests/expert-platform-dispatch-service.test.ts` if present; otherwise extend `tests/work-orchestration-store.test.ts`.

**Interfaces:**
- Extend `Submission` / `DispatchInput` with optional `workItemId`, `workAttemptId`, `workflowId`, `workflowVersion`.
- Extend `TaskRecord` with the same nullable linkage.
- Produce `requeueForRetry(taskId, expectedWorkAttemptId, reason, now)` that clears the old lease/run binding but keeps the same ExpertTask identity so the next claim creates a new Run/fencing value.
- Claim updates the linked Work workspace owner through orchestration reconciliation; TaskStore itself does not own WorkItem state.

- [ ] **Step 1: Add failing tests**
  - linked metadata round trips.
  - legacy standalone tasks remain unchanged.
  - retry requeues only a terminal failed task for the current WorkAttempt.
  - stale workAttempt cannot requeue a task.
  - subsequent claim creates a new Run/fencing value.
- [ ] **Step 2: Run focused tests and observe RED.**
- [ ] **Step 3: Implement schema columns, dispatch propagation, and retry method.**
- [ ] **Step 4: Run focused tests and observe GREEN.**
- [ ] **Step 5: Commit**
  - `git commit -am "feat(work): link expert tasks to work attempts"`

### Task 4: WorkOrchestrator reconciliation, retry, blocked, rework, and completion

**Files:**
- Create: `src/expert-platform/work-orchestrator.ts`
- Create: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Constructor consumes `WorkOrchestrationStore`, `ExpertTaskStore`, `ExpertDispatchService`.
- Produces:
  - `submitWork(input): WorkItemDetail`
  - `reconcileWork(workItemId, principalId, scope, now?): WorkItemDetail`
  - `reconcileDue(now?, limit?): string[]`
  - `handleTaskFeedback(taskId, principalId, scope, feedback): WorkItemDetail | null`
  - `submitReview(workItemId, principalId, scope, input): WorkItemDetail`
  - `recordEvidence(workItemId, principalId, scope, input): WorkItemDetail`
  - `cancelWork(workItemId, principalId, scope): WorkItemDetail`
- Initial dispatch uses deterministic task idempotency key `work:<workItemId>:attempt:<sequence>`.
- Reconciliation classification:
  - succeeded task -> record `expert_result` evidence bound to current commit/deployment/workflow and enter `waiting_review`.
  - retryable failure -> durable next action + `requeueForRetry` after reconciliation/backoff until maxRunsPerWorkAttempt.
  - blocker failure -> `blocked`.
  - deterministic failure -> `failed`.
  - explicit rework -> exactly one new WorkAttempt and new linked ExpertTask.
- Replay of the same feedback/review/reconciliation is idempotent.

- [ ] **Step 1: Write failing orchestrator tests**
  - submit creates one WorkItem, one WorkAttempt, one linked ExpertTask.
  - crash-style reconciliation links/reuses the deterministic ExpertTask instead of duplicating.
  - success -> evidence -> waiting_review.
  - accepted review -> completed.
  - rework feedback replay creates exactly one second WorkAttempt.
  - transient failure schedules/requeues Run retry.
  - blocker failure enters durable blocked.
  - stale task/run cannot advance the current WorkAttempt.
- [ ] **Step 2: Run** `node --test --import tsx tests/work-orchestrator.test.ts` and observe RED.
- [ ] **Step 3: Implement minimal orchestrator logic and error classification.**
- [ ] **Step 4: Run focused tests and observe GREEN.**
- [ ] **Step 5: Commit**
  - `git add src/expert-platform/work-orchestrator.ts tests/work-orchestrator.test.ts`
  - `git commit -m "feat(work): orchestrate retries review and rework"`

### Task 5: MCP Work APIs and feedback integration

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/server.ts`
- Create: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**
- MCP tools:
  - `submit_work`
  - `get_work`
  - `wait_work`
  - `review_work`
  - `record_work_evidence`
  - `cancel_work`
- Existing `submit_expert_task_feedback` calls `handleTaskFeedback` after the Task feedback is persisted.
- Work tools enforce principal/scope ownership on every read/write.
- `submit_work` uses the authenticated client session/source request where available and never invents session identity.
- `wait_work` returns cursor/event progress and bounded wait semantics analogous to `wait_expert_task`.

- [ ] **Step 1: Write MCP E2E tests**
  - tool catalog.
  - submission/idempotency/conflict.
  - unauthorized WorkItem access denied.
  - success -> waiting_review -> review accepted -> completed.
  - feedback needsRework -> new WorkAttempt.
  - cancel propagation.
- [ ] **Step 2: Run focused E2E and observe RED.**
- [ ] **Step 3: Wire store/orchestrator lifecycle into MCP/server startup and implement tools.**
- [ ] **Step 4: Run focused E2E and observe GREEN.**
- [ ] **Step 5: Commit**
  - `git add src/mcp.ts src/server.ts tests/expert-platform-work-mcp-e2e.test.ts`
  - `git commit -m "feat(mcp): expose work orchestration tools"`

### Task 6: Durable background reconciliation

**Files:**
- Modify: `src/server.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `tests/work-orchestrator.test.ts`
- Modify: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**
- Server starts one bounded Work reconciliation loop when `EXPERT_RUNTIME_DB` is configured.
- Loop calls `reconcileDue`; durable `next_action_at` remains authoritative.
- Startup reconciliation handles incomplete `WorkAttempt -> ExpertTask` linkage and due retry/rework actions.
- Shutdown clears only the process timer; no Work state is lost.

- [ ] **Step 1: Add failing restart/reconciliation tests.**
- [ ] **Step 2: Observe RED.**
- [ ] **Step 3: Implement startup/interval/shutdown integration.**
- [ ] **Step 4: Observe GREEN.**
- [ ] **Step 5: Commit**
  - `git commit -am "feat(work): add durable reconciliation loop"`

### Task 7: Admin WorkItem list/detail UI and API

**Files:**
- Modify: `src/server.ts`
- Modify: `src/expert-admin-ui.ts`
- Modify: `tests/expert-platform-admin-e2e.test.ts`

**Interfaces:**
- Admin APIs:
  - `GET /admin/api/work-items`
  - `GET /admin/api/work-items/:id`
  - `POST /admin/api/work-items/:id/reconcile`
  - `POST /admin/api/work-items/:id/cancel`
- UI adds a `Work Items` top-level page and Work detail page.
- Detail renders current state/revision, pinned workflow/deployment, WorkAttempts/Runs, Workspace owner, Evidence provenance/staleness, ReviewDecision/Approval, Completion Gate, and high-level Work events.
- Existing Expert Task page remains intact.

- [ ] **Step 1: Add failing Admin API/HTML assertions.**
- [ ] **Step 2: Observe RED.**
- [ ] **Step 3: Implement API and UI.**
- [ ] **Step 4: Observe GREEN.**
- [ ] **Step 5: Commit**
  - `git commit -am "feat(admin): add work orchestration views"`

### Task 8: Full regression, review, local deployment, and Claude CLI acceptance

**Files:**
- Modify only if acceptance uncovers a defect; every defect fix must start with a failing regression test.
- Add acceptance notes to `docs/superpowers/plans/2026-11-09-work-orchestration-phase1.md` only if needed.

**Interfaces:**
- No new public interfaces unless required by a verified acceptance defect.

- [ ] **Step 1: Run formatting/build/full suite**
  - `git diff --check`
  - `npx prettier --check <changed ts/test files>`
  - `npm run build`
  - `npm test`
  - Expected: all pass, with baseline count >= 612 and no failures.
- [ ] **Step 2: Whole-branch code review**
  - Review against this plan and the design; fix Critical/Important findings with RED->GREEN regression tests.
- [ ] **Step 3: Deploy the worktree build to the local Team Skill Hub test runtime**
  - Use the existing local redeploy mechanism; do not push/merge.
- [ ] **Step 4: Real Claude CLI acceptance**
  - From a fresh Claude CLI session, use Team Skill Hub MCP `submit_work` for a real read-only OTA/code-review work item.
  - Observe WorkItem -> WorkAttempt -> ExpertTask -> Run -> waiting_review.
  - Submit a rework signal and verify exactly one new WorkAttempt.
  - Submit an accepted ReviewDecision after the final result and verify Completion Gate -> completed.
  - Re-read the completed WorkItem and verify the history/evidence/review data survive a Hub restart.
- [ ] **Step 5: Final verification**
  - Re-run the focused Work tests plus `npm run build`.
  - Record exact task IDs, WorkItem ID, attempt sequence, and statuses in the execution ledger.
