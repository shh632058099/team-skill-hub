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

- [x] **Step 1: Add focused failing store/orchestrator tests**
  - concurrent claim attempts produce one owner/epoch;
  - stale epoch is rejected after a new claim;
  - reconciliation with a stale claim cannot dispatch;
  - claim survives process restart because it is stored in SQLite;
  - expired claim can be safely reclaimed only after re-reading current WorkItem state.
- [x] **Step 2: Run focused tests and observe RED for missing claim/fencing behavior.**
- [x] **Step 3: Implement the minimal durable claim schema and store APIs using `BEGIN IMMEDIATE` + revision/epoch checks.**
- [x] **Step 4: Make `WorkOrchestrator.reconcileWork/reconcileDue/reconcileStartup` claim before orchestration effects and fence all dispatch/retry/resume effects.**
- [x] **Step 5: Re-run focused tests and observe GREEN.**
- [x] **Step 6: Run the project check/build/full test suite.**
- [x] **Step 7: Commit this task with a focused commit.**

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

- [x] **Step 1: Add failing tests for full blocked metadata round-trip and restart persistence.**
- [x] **Step 2: Add failing tests proving blocked work does not resume through ordinary periodic reconciliation alone.**
- [x] **Step 3: Add failing tests for explicit resume success, stale revision/claim rejection, and workspace-owner-offline remaining blocked.**
- [x] **Step 4: Implement store schema/migration + blocked metadata write/read.**
- [x] **Step 5: Implement `resumeWork` with reconciliation-before-dispatch and claim fencing.**
- [x] **Step 6: Add MCP/Admin surfaces and update Work detail UI.**
- [x] **Step 7: Run focused tests, then full check/build/test.**
- [x] **Step 8: Commit this task with a focused commit.**

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

- [x] **Step 1: Add failing persistence and replay tests.**
- [x] **Step 2: Add failing orchestrator tests for feedback-driven and review-driven audit context.**
- [x] **Step 3: Implement schema/migration and WorkAttempt record mapping.**
- [x] **Step 4: Thread explicit rework context through `handleTaskFeedback`, `submitReview`, and `startAttempt`.**
- [x] **Step 5: Expose the context in WorkDetail/MCP/Admin UI without leaking secrets.**
- [x] **Step 6: Run focused tests, then full check/build/test.**
- [x] **Step 7: Commit this task with a focused commit.**

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

- [x] **Step 1: Add failing event-sequence/idempotency tests.**
- [x] **Step 2: Implement event emission at the durable state transition that owns each semantic event.**
- [x] **Step 3: Verify event details are bounded and contain IDs/reasons/revisions rather than raw sensitive payloads.**
- [x] **Step 4: Run focused tests, then full check/build/test.**
- [x] **Step 5: Commit this task with a focused commit.**

### Task 5: Whole-branch Superpowers review and acceptance

**Files:**

- Modify only if review finds a verified defect; every defect fix begins with a failing regression test.

- [x] **Step 1: Run `git diff --check`, formatting/lint/type checks, build, and the full test suite.**
- [x] **Step 2: Review the entire branch against `2026-11-09-work-orchestration-design.md`, explicitly excluding GitHub/GitLab/Jira adapters and Phase 3 autonomous PR/CI/merge automation.**
- [x] **Step 3: Fix Critical/Important findings with RED -> GREEN regression tests.**
- [x] **Step 4: Re-run final verification after the last source change.**
- [x] **Step 5: Record final alignment status and any intentionally deferred minor items in the execution ledger.**

## Execution Result

Completed on 2026-11-10 against the approved Work Orchestration spec.

- Task 1 commit: `66b3848` — durable WorkItem orchestration claim/fencing.
- Task 2 commit: `40effe6` — complete blocked metadata and explicit MCP/Admin resume.
- Task 3 commit: `f03429a` — durable rework audit context.
- Task 4 commit: `493f2a9` — high-level orchestration event taxonomy.
- Final review-fix commit: `5f3b47b` — atomic claim fencing, durable rework crash recovery, and blocked-rework action preservation.
- Final focused Work Orchestration suite: 56/56 passed before final source review.
- Final project gate after the last source change: `npm run check` passed with 721/721 tests, 0 failures; formatting, ESLint, and build passed.
- `git diff --check` passed.
- Intentionally deferred: GitHub/GitLab/Jira adapters and tracker polling; Phase 3 autonomous PR review, external CI orchestration, and merge automation.

## 2026-11-11 MCP Adapter and Source Foundation Completion

The implementation was extended on `master` without creating another worktree. Scope remained limited to the MCP Adapter and provider-neutral Work/source foundations. GitHub/GitLab/Jira adapters, tracker polling, PR review automation, external CI orchestration, and merge automation remain intentionally deferred.

### Alignment status against the recommended implementation order

Items 1–13 in `2026-11-09-work-orchestration-design.md` are now implemented and acceptance-tested:

1. WorkItem data model + stable source identity + idempotency.
2. Durable WorkItem state machine + revision / orchestration claim / fencing.
3. Versioned WorkflowDefinition + pinned workflow version.
4. WorkAttempt / ExpertTask / Run / Agent Turn hierarchy.
5. Workspace first-class model + deterministic key + Worker affinity.
6. Persistent blocked semantics + explicit resume.
7. Evidence envelope + verification binding/staleness.
8. ReviewDecision / Approval separation.
9. Completion Gate.
10. Reconciliation-before-dispatch + durable retry/continuation scheduling.
11. Feedback -> Rework signal and durable audit context.
12. Admin WorkItem / Workflow / source-observation visibility.
13. MCP Work API and MCP source lifecycle adapter.

### MCP/source foundation added after the original Phase 1 ledger

- `9e34e9e` — MCP source adapter lifecycle and durable source observations.
- `6fe6d78` — trusted native MCP session identity when the client/hook supports it.
- `3cb8274` — provider-neutral `WorkSourceAdapter` / `WorkSourceIngestion` boundary.
- `d74ae88` — reconcile source state before initial dispatch.
- `9a40393` — PowerShell hook parity for source-update signing.
- `a437d6c` — opaque MCP source-control capability; only the hash is persisted and MCP observability redacts the token.
- `4907dfe` — stable MCP submit response fields for source-control handling.
- `7432d53` — source-state fencing before dispatch/resume/reconciliation advancement.
- `4ff23c6` — bounded multi-capability storage so idempotent/concurrent `submit_work` retries do not invalidate an earlier successful response immediately; capabilities expire after 30 days and legacy single-token storage migrates in place.

### Source lifecycle invariants now enforced

- MCP submission is normalized through `McpWorkAdapter -> WorkSourceIngestion -> WorkOrchestrator`; it does not create ExpertTask directly.
- Source observations are durable and replay-safe.
- A terminal source observation is reconciled by the Orchestrator, not by the Adapter.
- Active execution receives Task cancellation before Work termination; `waiting_review` is retained by the default source policy.
- Pending source observations are reconciled before initial dispatch, direct Work reconciliation, and explicit resume.
- `sourceControlToken` is an agent-held capability, not an external credential. Only SHA-256 hashes are stored; raw tokens are redacted from MCP observability.
- Native session proof remains an additional binding when available, but MCP source lifecycle correctness does not depend on a particular MCP client's PreToolUse hook behavior.
- Idempotent/concurrent MCP retries may hold multiple bounded source-control capabilities simultaneously so an earlier successful response does not become unusable because of a concurrent replay.

### Final validation

- Full project gate after the retry-capability change: `npm run check` passed with **745/745 tests**, 0 failures; formatting, ESLint, TypeScript build, and tests passed.
- `git diff --check` passed.
- Existing runtime database migration from single source-control capability to bounded multi-capability storage passed without reset.
- Local WSL2 deployment passed readiness with 3/3 repositories healthy.
- Real Claude CLI acceptance: `submit_work -> update_work_source(terminal) -> get_work` succeeded with the native Claude session UUID retained in `sourceScope`, final Work `cancelled`, observations `active/noop -> terminal/cancel`, and no source-control token printed.
- Real Codex CLI acceptance: source lifecycle succeeded even though Codex 0.162.1 did not propagate PreToolUse-updated MCP arguments; the opaque source-control capability allowed `terminal -> cancel` safely without depending on that client behavior.
- Real Codex retry acceptance: two identical `submit_work` calls reused the same WorkItem, returned two different private capabilities, the first capability successfully sent an `active` signal, the second successfully sent `terminal`, and the Work ended `cancelled`.

### Intentionally deferred after foundation completion

The next numbered items in the approved spec are external/provider work and remain deferred by design:

- 14. GitHub Adapter.
- 15. GitLab Adapter.
- 16. Auto polling / dispatch from external trackers.
- 17. PR review loop.
- 18. External CI / Human Review / Merge gate automation.

Do not start these provider-specific items until explicitly requested. Future work should continue from the provider-neutral source boundary rather than adding provider fields to WorkItem/ExpertTask.
