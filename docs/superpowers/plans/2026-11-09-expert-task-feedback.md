# Expert Task Feedback Implementation Plan

> Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Invite optional feedback when a successful expert result is presented and show actual adoption in admin.
**Architecture:** Store feedback beside expert tasks in SQLite. MCP handles requester interactions and admin reads the stored result.
**Tech Stack:** TypeScript, node:sqlite, MCP, existing admin API and UI.
**Spec:** Result reminder and feedback design agreed in conversation.

## Constraints and review focus

- Match task ownership by authenticated principal and scope. Reject writes to other tasks or tasks that have not succeeded.
- One current feedback per task. No read-time writes for reminders.
- Preserve legacy tasks and group metrics using the deployment ID and config version captured on the task.
- Treat omitted rework as unknown. Distinguish unreviewed tasks from rejected results.
- A shared MCP identity cannot distinguish people using the same credential. Verify the deployment uses distinct identities where individual ownership is required.

## 1. Persistence and permissions

- [ ] In `tests/expert-platform-task-store.test.ts`, cover existing tasks without feedback, cross-principal and cross-scope denial, non-success denial, and repeated writes resulting in exactly one row.
- [ ] In `src/expert-platform/task-store.ts`, add a feedback table keyed by task ID with disposition (`adopted | partially_adopted | not_adopted`), optional reason, nullable boolean rework flag and updated timestamp. Atomically enforce succeeded status and ownership in the upsert. Include feedback cleanup in existing task deletion.
- [ ] Verify a second submission replaces the current values, including clearing optional fields when omitted. Run the task-store suite.

## 2. MCP result and submission

- [ ] Extend `tests/expert-platform-mcp-e2e.test.ts` to verify the result hint is present for eligible unreviewed results, omitted after feedback, and that invalid or unauthorized submissions fail.
- [ ] In `src/mcp.ts` and the existing dispatch service, expose `submit_expert_task_feedback(taskId, disposition, reason?, needsRework?)`. Resolve identity from authentication. Reuse existing tool registration and authorization conventions.
- [ ] On successful `get_expert_task_result`, return optional feedback guidance. Tell clients to present it after the full result, once per task per conversation. Only write on explicit user feedback. For ambiguous task references, ask which result the user means. Fetching results never records whether the prompt was shown.
- [ ] Run MCP E2E and repository permission suites.

## 3. Admin and reporting

- [ ] Extend `tests/expert-platform-admin-e2e.test.ts` for feedback details and grouped counts. Include a legacy task, an unreviewed success, an explicitly rejected result and two versions of the same deployment.
- [ ] Extend the existing admin detail in `src/server.ts` and `src/expert-admin-ui.ts` with read-only disposition, reason, rework and timestamp. Escape user-supplied text using the existing UI convention.
- [ ] Aggregate by expert, deployment ID and config version. Return successful, reviewed, unreviewed, each disposition and explicit rework counts. Use reviewed as the adoption-rate denominator and show no rate for zero reviews. Keep missing deployment versions in an unknown group.
- [ ] Run admin E2E and the repository's type check.

## 4. Real client acceptance

- [ ] Run one successful expert task each through Claude Code and Codex CLI. Check the full result precedes the prompt. Reply “部分采纳，需要补验证” and verify the task, disposition and rework shown in admin.
- [ ] Verify repeat viewing within a conversation, ambiguous references across two tasks, an unrelated reply, a different authenticated identity and a later feedback correction. Record client behavior separately from service-side guarantees.
