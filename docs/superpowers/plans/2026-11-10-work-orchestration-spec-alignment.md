# Work Orchestration Spec Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining internal Phase 1 alignment gaps against `2026-11-09-work-orchestration-design.md` while keeping GitHub/GitLab/Jira adapters deferred.

**Architecture:** Extend the existing durable SQLite-based Work Orchestration model rather than introducing a second scheduler or workflow layer. WorkItem state remains authoritative in `WorkOrchestrationStore`; `WorkOrchestrator` gains explicit claim/resume/rework/event semantics, and MCP/Admin surfaces expose only the minimal controls required by the approved spec.

**Tech Stack:** TypeScript, Node.js 22+, node:sqlite, Fastify, MCP SDK, existing Expert Platform worker/runtime.

**Spec:** `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`

## Global Constraints

- Preserve all existing ExpertTask APIs and standalone ExpertTask behavior.
- Keep GitHub/GitLab/Jira adapters and tracker polling out of scope.
- Use durable SQLite state as the source of truth; in-memory timers are only wake-up mechanisms.
- Reconcile current facts before dispatch/retry/resume.
- All WorkItem mutations remain CAS/fencing protected.
- Do not allow blocked work to resume implicitly without revalidation.
- TaskFeedback remains a signal and never becomes an Approval.
- Rework remains a new WorkAttempt, not a Run retry.
- Preserve existing Workspace affinity and fail-closed behavior.
- TDD is mandatory: each behavior change starts with a focused failing regression test.
- Do not push or merge from this worktree.

## Review Focus

- Two orchestrator loops racing for the same WorkItem must not both dispatch or mutate it.
- A stale orchestration claim/epoch must fail closed after ownership changes or state advances.
- Resuming blocked work must preserve auditability and must reconcile current Worker/Workspace/policy facts before any dispatch.
- Replayed feedback/review rework requests must not create duplicate WorkAttempts or conflicting audit context.
- High-level Work events must describe orchestration meaning without duplicating low-level Task/Run events.

---

### Task 1: Durable WorkItem orchestration claim and fencing

**Files:**

- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**

- Add durable claim fields to WorkItem persistence: owner token/id, claim epoch, lease/claimed-at metadata as needed by current single-writer SQLite architecture.
- Produce store operations equivalent to `claimWorkForOrchestration(...)`, `renew/release` if needed, and require the current claim epoch on orchestration mutations that can dispatch/retry/resume.
- Reuse existing `state_revision` CAS; do not replace it.
- A stale claim must never create a WorkAttempt, retry a Run, resume a blocked WorkItem, or complete/cancel the current WorkItem.

- [ ] **Step 1: Add focused failing store/orchestrator tests**
  - concurrent claim attempts produce one owner/epoch;
  - stale epoch is rejected after a new claim;
  - reconciliation with a stale claim cannot dispatch;
  - claim survives process restart because it is stored in SQLite;
  - expired claim can be safely reclaimed only after re-reading current WorkItem state.
- [ ] **Step 2: Run focused tests and observe RED for missing claim/fencing behavior.**
- [ ] **Step 3: Implement the minimal durable claim schema and store APIs using `BEGIN IMMEDIATE` + revision/epoch checks.**
- [ ] **Step 4: Make `WorkOrchestrator.reconcileWork/reconcileDue/reconcileStartup` claim before orchestration effects and fence all dispatch/retry/resume effects.**
- [ ] **Step 5: Re-run focused tests and observe GREEN.**
- [ ] **Step 6: Run the project check/build/full test suite.**
- [ ] **Step 7: Commit this task with a focused commit.**

### Task 2: Complete blocked metadata and explicit resume contract

**Files:**

- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/mcp.ts`
- Modify: `src/server.ts`
- Modify: `src/expert-admin-ui.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`
- Test: `tests/expert-platform-admin-e2e.test.ts`

**Interfaces:**

- Persist blocked metadata required by the spec: `blocked_at`, `resume_condition`, `blocked_by_type`, `blocked_by_ref` in addition to existing reason/context.
- Add an explicit `resumeWork(...)` orchestration API that transitions blocked work back to a resumable state only after current-fact reconciliation under a valid orchestration claim.
- Expose MCP `resume_work` and Admin resume action; keep automatic tracker-driven resume out of scope.
- Emit `work.resumed` with the prior blocker metadata and actor/source.

- [ ] **Step 1: Add failing tests for full blocked metadata round-trip and restart persistence.**
- [ ] **Step 2: Add failing tests proving blocked work does not resume through ordinary periodic reconciliation alone.**
- [ ] **Step 3: Add failing tests for explicit resume success, stale revision/claim rejection, and workspace-owner-offline remaining blocked.**
- [ ] **Step 4: Implement store schema/migration + blocked metadata write/read.**
- [ ] **Step 5: Implement `resumeWork` with reconciliation-before-dispatch and claim fencing.**
- [ ] **Step 6: Add MCP/Admin surfaces and update Work detail UI.**
- [ ] **Step 7: Run focused tests, then full check/build/test.**
- [ ] **Step 8: Commit this task with a focused commit.**

### Task 3: Durable rework audit context

**Files:**

- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/mcp.ts`
- Modify: `src/expert-admin-ui.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**

- Persist on each rework WorkAttempt: origin WorkAttempt, reason, `review_context`, `what_should_change`, `created_by`.
- Feedback-driven rework derives context from persisted TaskFeedback; ReviewDecision rework derives context from the review request payload.
- Replays must reuse the already-created rework attempt and must not overwrite its audit context with a conflicting replay.

- [ ] **Step 1: Add failing persistence and replay tests.**
- [ ] **Step 2: Add failing orchestrator tests for feedback-driven and review-driven audit context.**
- [ ] **Step 3: Implement schema/migration and WorkAttempt record mapping.**
- [ ] **Step 4: Thread explicit rework context through `handleTaskFeedback`, `submitReview`, and `startAttempt`.**
- [ ] **Step 5: Expose the context in WorkDetail/MCP/Admin UI without leaking secrets.**
- [ ] **Step 6: Run focused tests, then full check/build/test.**
- [ ] **Step 7: Commit this task with a focused commit.**

### Task 4: High-level orchestration event taxonomy alignment

**Files:**

- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**

- Add explicit high-level events where the approved spec requires semantic distinction: `run.continued`, `run.retry_scheduled`, `work.resumed`, `evidence.staled`, `review.requested` where a review gate is entered, `approval.invalidated`, and `rework.started`.
- Keep low-level Task/Run event streams unchanged.
- Ensure replay/idempotent reconciliation does not duplicate semantic events.

- [ ] **Step 1: Add failing event-sequence/idempotency tests.**
- [ ] **Step 2: Implement event emission at the durable state transition that owns each semantic event.**
- [ ] **Step 3: Verify event details are bounded and contain IDs/reasons/revisions rather than raw sensitive payloads.**
- [ ] **Step 4: Run focused tests, then full check/build/test.**
- [ ] **Step 5: Commit this task with a focused commit.**

### Task 5: Whole-branch Superpowers review and acceptance

**Files:**

- Modify only if review finds a verified defect; every defect fix begins with a failing regression test.

- [ ] **Step 1: Run `git diff --check`, formatting/lint/type checks, build, and the full test suite.**
- [ ] **Step 2: Review the entire branch against `2026-11-09-work-orchestration-design.md`, explicitly excluding GitHub/GitLab/Jira adapters and Phase 3 autonomous PR/CI/merge automation.**
- [ ] **Step 3: Fix Critical/Important findings with RED -> GREEN regression tests.**
- [ ] **Step 4: Re-run final verification after the last source change.**
- [ ] **Step 5: Record final alignment status and any intentionally deferred minor items in the execution ledger.**
