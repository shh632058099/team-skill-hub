# Skill Bundle Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement Bundle-first Skill import from MCP and Admin Web, with `skill|collection` replacement boundaries, immutable snapshots, review drift protection, one PR/MR publication, and merge-time final-tree verification.

**Architecture:** Add a dedicated Skill Bundle domain and SQLite-backed workflow store instead of extending `KnowledgeCandidate`. Application services normalize/validate/preview immutable snapshots against a materialized target repository, then a Git-based bundle publisher replaces only `replacementRoot`; MCP and Admin Web are adapters over the same service. Legacy `rd-skills` single-file submission is adapted only when its path can be mapped unambiguously; `custom-skills` stays on the existing Candidate path.

**Tech Stack:** TypeScript, Node.js 24, Fastify, MCP/Zod, node:sqlite, git CLI, JSZip, node:test.

**Spec:** `docs/repository/skill-bundle-import.md`

## Global Constraints

- `import_type=skill` replaces only `skills/<namespace>/<skill_path>/**`; `collection` replaces `skills/<namespace>/**`.
- `skill` snapshots contain exactly one root `SKILL.md`; collection Skill roots may not be ancestor/descendant nested.
- Snapshots are immutable; workflow history references snapshot IDs and never duplicates file bodies.
- Preview/approval stores target/tree/diff hashes; stale reviewed diffs become `review_stale` before publication.
- PR/MR merge is not enough for success: final `replacementRoot` tree must equal `expectedTreeSha256`, otherwise status is `published_drifted`.
- Bundle publishing never auto-merges and never introduces namespace ownership/locking.
- GitHub Bundle publishing uses temporary git worktrees; GitLab Bundle publishing reuses the configured publishing token and GitLab Repository/Commits/MR APIs, without SSH clone/push.
- Existing Knowledge Candidate publishing remains intact; `custom-skills` remains legacy in phase 1.

## Review Focus

- Path/case normalization must not permit replacement-root escape on Windows or POSIX.
- Reusing one `submission_key` for different target semantics must conflict even when file content is identical.
- Collection/single-skill overlap must not silently become `published` after an out-of-order merge.
- Retrying a failed publication must rebuild from the current approved target revision, not an old import branch.
- ZIP/Git imports must reject unsafe sources before files reach the common normalizer.

---

### Task 1: Skill Bundle domain, normalization, hashes and diff

**Files:**
- Create: `src/skill-bundles.ts`
- Test: `tests/skill-bundles.test.ts`

**Interfaces:**
- Produces: `SkillBundleImport`, `SkillBundleSnapshot`, `SkillBundleFile`, `SkillBundleDiff`, `normalizeSkillBundleInput`, `canonicalTreeHash`, `diffSkillBundleTrees`, `legacyRdSkillPathToTarget`.

- [x] Write failing tests for safe namespace/skill paths, exact-one-root skill snapshots, non-nested collection roots, canonical path/mode/content hashes, case collisions, replacement-root-scoped diff, and legacy `ota/design/SKILL.md` mapping.
- [x] Run `node --import tsx --test tests/skill-bundles.test.ts` and verify RED for missing module/API.
- [x] Implement domain types and pure normalization/hash/diff helpers with no repository/network side effects.
- [x] Re-run the focused test and then `npm test`.

### Task 2: Immutable SQLite snapshot/import workflow storage

**Files:**
- Modify: `src/storage/database.ts`
- Create: `src/storage/skill-bundle-repository.ts`
- Test: `tests/skill-bundle-storage.test.ts`

**Interfaces:**
- Consumes: Task 1 domain types.
- Produces: `SkillBundleRepository` with create/get/list/history/update methods and idempotency lookup.

- [x] Write failing storage tests proving snapshot files are stored once, import history only references snapshot ID/hash, state survives reopen, and mismatched idempotency semantics conflict.
- [x] Run the focused storage test and verify RED.
- [x] Add the next database migration for `skill_bundle_snapshot`, `skill_bundle_file`, `skill_bundle_import`, and `skill_bundle_import_history`, plus a focused repository implementation.
- [x] Re-run focused storage tests and `npm test`.

### Task 3: Application validation, materialized preview and review state machine

**Files:**
- Create: `src/skill-bundle-service.ts`
- Modify: `src/application.ts`
- Test: `tests/skill-bundle-service.test.ts`

**Interfaces:**
- Consumes: Task 1 domain and Task 2 repository.
- Produces: `submitSkillBundle`, `previewSkillBundle`, `reviewSkillBundle`, `list/getSkillBundleImports`, and review-stale transition semantics.

- [x] Write failing tests for repository authorization, applying a snapshot only at `replacementRoot`, reuse of `scanSkills/validateSkills`, sibling preservation, approved target/diff hashes, and `review_stale` when approved boundary changes.
- [x] Run focused tests and verify RED.
- [x] Implement target repository materialization helpers and common application workflow, reusing configured skill publishing target and existing Skill validation rules.
- [x] Re-run focused tests and `npm test`.

### Task 4: Bundle publisher and reconciliation

**Files:**
- Create: `src/skill-bundle-publishing.ts`
- Modify: `src/skill-bundle-service.ts`
- Test: `tests/skill-bundle-publishing.test.ts`

**Interfaces:**
- Consumes: approved imports/snapshots and repository publishing config.
- Produces: GitHub/GitLab PR/MR publication records, no-op outcome, merge reconciliation, `published_drifted` final-tree verification.

- [x] Write failing tests for full replacementRoot snapshot writes/deletes, mode preservation, one commit/PR, no-op, deterministic branch reuse, rebuild-from-approved-target retry, GitHub/GitLab reconciliation, and final-tree drift.
- [x] Run focused tests and verify RED.
- [x] Implement common git-worktree publisher with provider-specific PR/MR API calls and safe force-with-lease branch update.
- [x] Re-run focused tests and `npm test`.

### Task 5: MCP entry point and legacy adapter

**Files:**
- Modify: `src/mcp.ts`
- Modify: `src/application.ts`
- Test: `tests/mcp-skill-bundle.test.ts`

**Interfaces:**
- Consumes: Task 3 application methods.
- Produces: MCP `submit_skill_bundle` as the only client-visible Skill submission entrypoint. The legacy `submit_skill_candidate` MCP entrypoint was removed after Bundle-first migration completed.

- [x] Write failing MCP tests for `skill` and `collection` payload schemas, optional mode, idempotency key, no direct PR creation, principal authorization, and legacy mapping without changing `custom-skills` behavior.
- [x] Run focused test and verify RED.
- [x] Register the Bundle tool; after migration, remove the legacy `submit_skill_candidate` MCP entrypoint and keep Knowledge Candidate APIs Knowledge-only.
- [x] Re-run focused tests and `npm test`.

### Task 6: Admin API, ZIP/Git import and Admin Web UX

**Files:**
- Create: `src/skill-bundle-sources.ts`
- Modify: `src/server.ts`
- Modify: `src/admin-ui.ts`
- Modify: `package.json` / lockfile if JSZip must be promoted to runtime dependency
- Test: `tests/skill-bundle-admin-api.test.ts`
- Test: `tests/admin-ui-structure.test.ts`

**Interfaces:**
- Consumes: Task 3/4 service methods.
- Produces: `/admin/api/skill-bundles/*` endpoints and Admin `Skill Bundle` Import / Pending Review / History views.

- [x] Write failing API/source tests for manual file preview/import, ZIP source-root extraction, Git HTTPS allowlist/private-address rejection, shallow no-submodule/no-LFS import, approve/reject/publish/reconcile, and `published_drifted` re-import flow.
- [x] Write failing UI structure tests for operation-first Bundle list, import type, replacement root, diff counts, source form and drift status.
- [x] Run focused tests and verify RED.
- [x] Implement source adapters and API routes with Admin auth; add Bundle page using the existing Admin shell/navigation patterns.
- [x] Re-run focused tests and `npm test`.

### Task 7: Integration, observability, docs and full verification

**Files:**
- Modify: `docs/repository/README.md` only if required to link the completed capability
- Modify: observability/admin status presentation files only where Bundle-specific fields/events are required
- Test: `tests/skill-bundle-integration.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: end-to-end verified Bundle workflow without regression to existing Knowledge Candidate/Skill consumption paths.

- [x] Write an end-to-end failing integration test: submit `ota/design`, approve/publish/reconcile; submit `ota/usage` and prove it cannot delete design; exercise a collection overlap and final drift detection.
- [x] Run focused integration test and verify RED.
- [x] Add the minimal integration/observability wiring needed for the full flow and existing repository sync consumption.
- [x] Run `npm run build`, focused Bundle tests, and full `npm test`; inspect failures rather than masking pre-existing regressions.
- [x] Run a final code review against the spec and plan, then fix Critical/Important findings with RED→GREEN tests.

## Execution note

The repository is currently on `master` with unrelated dirty changes from prior work. The user explicitly requested implementation in this workspace. Do not reset, overwrite, stage, or commit unrelated dirty files; commits are intentionally deferred unless the user separately asks for commit/push.
