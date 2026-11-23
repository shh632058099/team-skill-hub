# Workflow Verification Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make read-only Work use read-only semantics by default, prevent repository build/test verification from leaking into readonly workflows, and fail closed instead of retrying forever on verification infrastructure or continuation-budget failures.

**Architecture:** Keep Workflow as the policy authority and Repository as the command authority. MCP `submit_work` defaults omitted `workflowId` to `investigation` while the lower-level legacy fallback remains unchanged; effective verification only merges repository policy for `code_change` workflows. WorkOrchestrator converts deterministic verification infrastructure failures and continuation exhaustion into durable blocked states.

**Tech Stack:** TypeScript, Node test runner, SQLite-backed WorkOrchestrator.

**Spec:** docs/superpowers/specs/2026-11-23-workflow-verification-routing-design.md

## Global Constraints

- Preserve explicit `workflowId` behavior.
- Preserve lower-level repository workflow defaults and legacy orchestration-store fallback behavior.
- Preserve `code_change` build + unit-test requirements.
- Preserve ordinary `verification_failed` continuation for code/test failures that are not infrastructure failures.
- Do not touch unrelated `docs/repository` changes.

## Review Focus

- Explicit code-change workflow must still inherit repository verificationPolicy.
- Readonly workflow with repository verificationPolicy must have an empty repository-derived validationSnapshot.
- Readonly workflow-local validation.required must still run.
- Exit 127/process failure must block without continuation.
- Continuation limit must leave Work blocked, not running.

---

### Task 1: Safe MCP default Workflow

- [x] Add a failing MCP E2E test proving omitted workflowId uses investigation.
- [x] Default omitted MCP submit_work workflowId to investigation without changing legacy store fallback.
- [x] Run focused tests.

### Task 2: Verification policy scope

- [x] Add failing tests proving readonly ignores repository verificationPolicy but code_change still inherits it.
- [x] Change effectiveVerificationSteps.
- [x] Run focused tests.

### Task 3: Verification infrastructure failure handling

- [x] Add failing tests for exit 127/process failure -> blocked verification_environment with no continuation.
- [x] Implement classification and blocking.
- [x] Run focused tests.

### Task 4: Continuation budget terminal behavior

- [x] Change existing limit test to expect blocked continuation_limit instead of throw/running.
- [x] Implement durable blocked transition.
- [x] Run focused tests.

### Task 5: Client contract and end-to-end verification

- [x] Update submit_work description/client guidance so callers know omitted workflow is readonly-safe and code changes require explicit code-change workflow.
- [x] Run focused MCP/client tests.
- [x] Run TypeScript, lint/format, full suite.
- [x] Deploy local Hub.
- [x] Submit a real code-line-count Work and follow wait_work/get_work to completion.
- [x] Verify selected workflow, validationSnapshot, continuationCount, workspace changes, and final result.
- [x] Run final Superpower code review.
