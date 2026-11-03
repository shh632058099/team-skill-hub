# Execution MCP Profile Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make execution configurations inherit MCP settings from a selected global Profile by default, with sparse per-field overrides.

**Architecture:** Keep the existing `mcp_json` storage and deployment snapshot model. Extend deployment MCP records to hold a Profile reference plus optional overrides; resolve the effective configuration from the current Profile at dispatch time and snapshot the resolved values. Update Admin UI to default to profile-only inheritance and expose overrides only when explicitly enabled.

**Tech Stack:** TypeScript, Fastify, Zod, SQLite, vanilla Admin UI, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-03-execution-mcp-profile-inheritance-design.md`

## Global Constraints

- Existing full-field deployment MCP records remain valid explicit overrides.
- Missing `profileRef` resolves to `default`; an explicitly missing Profile is an error.
- Absent override fields inherit Profile values; `required: false` is a valid explicit override.
- Tool overrides must be a subset of the selected Profile's allowed tools.
- Task snapshots contain fully resolved MCP settings and remain immutable.
- Claude and Codex consume the same resolved task snapshot.

## Review Focus

- Legacy deployment MCP objects without `profileRef` must retain behavior — regression test legacy snapshot.
- Explicit unknown Profile IDs must fail, not silently fall back — dispatch test.
- Explicit `required: false` must not be treated as absent — resolution test.
- Empty UI override fields must be omitted, not serialized as empty values — UI payload test/manual API verification.
- Profile edits must affect new tasks but not old snapshots — dispatch/task snapshot test.

---

### Task 1: Resolve MCP Profile inheritance at dispatch

**Files:**

- Modify: `src/expert-platform/expert-store.ts`
- Modify: `src/expert-platform/expert-dispatch-service.ts`
- Modify: `src/expert-platform/task-store.ts` only if snapshot typing needs adjustment
- Test: `tests/expert-platform-expert-store.test.ts`
- Test: `tests/expert-platform-mcp-e2e.test.ts`

**Interfaces:**

- Deployment `mcp` fields: `profileRef?: string`, `urlOverride?: string`, `credentialRef?: string`, `allowedTools?: string[]`, `required?: boolean`.
- Effective snapshot remains `{ profileRef?, urlOverride?, credentialRef, allowedTools, required }` with all effective values resolved.
- `ExpertStore.getMcpProfile(id)` is the source of Profile values.

- [x] **Step 1: Write failing dispatch tests** for profile-only inheritance, sparse overrides, `required:false`, profile update affecting subsequent submissions, immutable prior snapshot, unknown Profile, out-of-profile tool override, and legacy full-field record compatibility.
- [x] **Step 2: Run the focused tests and confirm expected failures.**
- [x] **Step 3: Implement resolver in dispatch**: profileRef defaults to `default`; merge only explicitly present override fields; validate tools subset; fail unknown explicit Profile; snapshot resolved values.
- [x] **Step 4: Run focused tests and confirm pass.**

### Task 2: Make API schema and validation support sparse overrides

**Files:**

- Modify: `src/server.ts`
- Test: `tests/expert-platform-expert-store.test.ts` or existing server API test file (locate exact coverage before editing)

**Interfaces:**

- API deployment MCP schema accepts optional `credentialRef`, `allowedTools`, and `required`.
- Profile existence and tool-subset checks use selected Profile, not a hard-coded default.

- [x] **Step 1: Define API acceptance cases** for profile-only payload acceptance, explicit invalid Profile rejection, invalid tool override rejection, and legacy full payload acceptance.
- [x] **Step 2: Confirm the pre-change schema rejected profile-only payloads; exercise the accepted/rejected cases after implementation.**
- [x] **Step 3: Implement schema and API validation** while retaining current MCP tool availability validation.
- [x] **Step 4: Run focused API tests.**

### Task 3: Update Admin execution configuration UI

**Files:**

- Modify: `src/expert-admin-ui.ts`
- Test: existing Admin UI tests if available; otherwise add focused static/DOM behavior tests following repository conventions.

**Interfaces:**

- Profile selector populated from `/admin/api/expert-config/mcp-profiles`.
- Toggle `mcpCustomOverrides` controls visibility of override controls.
- Required override selector values: `inherit`, `required`, `optional`.

- [x] **Step 1: Define UI acceptance cases** for default inheritance payload, toggle visibility, sparse field omission, required tri-state, edit legacy configuration as overrides, and load failure blocking save.
- [x] **Step 2: Validate the existing UI test coverage and use real Admin page/API smoke tests for the new controls and payload.**
- [x] **Step 3: Implement UI**: profile dropdown; override toggle off by default for new records; optional URL/Credential/Tools; tri-state Required; preserve legacy flat MCP records as override mode when editing; load profiles before allowing save.
- [x] **Step 4: Run UI tests and formatting.**

### Task 4: End-to-end verification, docs, and review

**Files:**

- Modify: `docs/expert-platform/add-expert.md` if execution MCP configuration docs exist there.
- Test: focused tests plus full relevant project suite.

- [x] **Step 1: Run build, typecheck, focused tests, and full test suite.** Full suite: 559 passed, 0 failed.
- [x] **Step 2: Review the complete workspace diff against the design spec and plan; tighten API error handling so only a missing Profile is treated as a compatibility case.**
- [x] **Step 3: Deploy with `./deploy-local-wsl2.sh`.**
- [x] **Step 4: Verify actual Admin UI/API, create an isolated temporary deployment, verify profile-only persistence, and clean up the test record. Dispatch unit tests cover Claude and Codex resolved snapshots, profile update affecting new tasks only, and immutable existing snapshots. The production `default` Profile was not mutated.**
- [x] **Step 5: Re-run post-deploy smoke tests and report exact results.**
