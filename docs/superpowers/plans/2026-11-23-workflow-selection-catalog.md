# Workflow Selection Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Team Skill Hub own discoverable Workflow selection semantics while Claude/Codex select the Workflow by the user's primary requested outcome.

**Architecture:** Extend the versioned Workflow definition with optional selection metadata, publish new built-in Workflow versions containing that metadata, and expose the latest selectable catalog over MCP. Keep clients thin: they use the primary-outcome rule and query `list_workflows` when ambiguous or when custom Workflows may apply.

**Tech Stack:** TypeScript, Node.js test runner, MCP SDK, SQLite-backed WorkOrchestrationStore, shell/PowerShell client bootstrap scripts.

**Spec:** `docs/superpowers/specs/2026-11-23-workflow-selection-catalog-design.md`

## Global Constraints

- Existing persisted/custom Workflow definitions without selection metadata must remain valid.
- `code-fix-default` remains a compatibility fallback and must not be advertised in the selectable MCP catalog.
- `submit_work.workflowId` omission must continue to default to `investigation`.
- Selection is based on primary requested outcome, not incidental build/test failures or secondary work.
- Do not change Expert/Deployment routing or verification semantics.
- Do not commit or push unless the user explicitly asks.

## Review Focus

- A legacy custom Workflow without selection metadata remains visible and safe to inspect.
- Multiple versions of one Workflow expose only the latest version in the MCP catalog.
- An explicit Workflow supplied to `submit_work` is never silently replaced by catalog logic.
- Built-in release/version bumps preserve old immutable definitions in existing databases.
- Claude/Codex guidance does not accidentally teach models to choose `build-fix` merely because a feature/bug task later fails verification.

---

### Task 1: Versioned Workflow selection metadata and catalog projection

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Test: `tests/work-orchestration-store.test.ts`

**Interfaces:**
- Produces: `WorkflowDefinition.selection?: { summary: string; useWhen: string[]; notWhen: string[] }`
- Produces: `WorkOrchestrationStore.listSelectableWorkflows()` returning latest non-compatibility Workflow versions with normalized selection metadata.

- [x] **Step 1: Write failing tests**
  - Latest built-ins carry expected selection summaries and new immutable versions.
  - A custom Workflow without selection metadata remains valid and is returned with `selectionConfigured=false`.
  - A custom Workflow with two versions returns only the latest.
  - `code-fix-default` is excluded.
  - Invalid selection strings/arrays are rejected.

- [x] **Step 2: Run focused store tests and verify RED**

Run: `node --test --import tsx tests/work-orchestration-store.test.ts`

Expected: new assertions fail because selection metadata/catalog projection do not exist.

- [x] **Step 3: Implement minimal store support**

Add selection normalization/validation, built-in metadata with version bumps, and `listSelectableWorkflows()`.

- [x] **Step 4: Re-run focused store tests and verify GREEN**

Run: `node --test --import tsx tests/work-orchestration-store.test.ts`

Expected: PASS.

### Task 2: MCP Workflow catalog

**Files:**
- Modify: `src/mcp.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**
- Consumes: `WorkOrchestrationStore.listSelectableWorkflows()`
- Produces: MCP tool `list_workflows`.

- [x] **Step 1: Write failing MCP E2E assertions**
  - Tool list contains `list_workflows`.
  - Calling it returns latest built-ins, custom Workflow discovery metadata, no `code-fix-default`, and the primary-outcome selection rule.
  - Existing `submit_work` omission still resolves to `investigation`.

- [x] **Step 2: Run focused MCP E2E and verify RED**

Run: `node --test --import tsx tests/expert-platform-work-mcp-e2e.test.ts`

Expected: fail because `list_workflows` is absent.

- [x] **Step 3: Register `list_workflows` and refine `submit_work.workflowId` description**

The tool is readonly and must not mutate Workflow selection. The description directs callers to use it for ambiguity/custom Workflow discovery.

- [x] **Step 4: Re-run focused MCP E2E and verify GREEN**

Run: `node --test --import tsx tests/expert-platform-work-mcp-e2e.test.ts`

Expected: PASS.

### Task 3: Claude/Codex integration guidance and release

**Files:**
- Modify: `scripts/setup-claude-code.sh`
- Modify: `scripts/setup-claude-code.ps1`
- Modify: `scripts/setup-codex-mcp.sh`
- Modify: `scripts/setup-codex-mcp.ps1`
- Modify: `src/cli/build-codex-plugin.ts`
- Modify: `client-integration/release.json`
- Test: `tests/client-integration-bootstrap.test.ts`
- Test: `tests/client-integration-release.test.ts`
- Test: `tests/codex-plugin-build.test.ts`

**Interfaces:**
- Consumes: MCP `list_workflows`.
- Produces: consistent client instruction to select by primary requested outcome and query the catalog when ambiguous.

- [x] **Step 1: Write failing client integration assertions**

Assert generated Claude/Codex guidance contains `primary requested outcome`, `list_workflows`, and the rule that incidental build/test failures do not change the Workflow.

- [x] **Step 2: Run focused client integration tests and verify RED**

Run: `node --test --import tsx tests/client-integration-bootstrap.test.ts tests/client-integration-release.test.ts tests/codex-plugin-build.test.ts`

Expected: fail on missing guidance/new release version.

- [x] **Step 3: Update generated guidance and bump Client Integration release**

Bump integration release only; hook runtime remains unchanged.

- [x] **Step 4: Re-run focused client integration tests and verify GREEN**

Expected: PASS.

### Task 4: Whole-change verification and review

**Files:**
- Review all files above plus spec/plan.

- [x] **Step 1: Run full test suite**

Use the repository's canonical test command. Expected: all tests pass.

- [x] **Step 2: Run typecheck/lint/format and `git diff --check`**

Expected: no new errors; existing lint warnings may remain if unchanged.

- [x] **Step 3: Perform fresh whole-change review**

Review against the spec with special attention to legacy custom Workflows, versioning, and client/server source-of-truth boundaries.

- [x] **Step 4: Run a real WSL2 Claude selection smoke test**

Use the installed/upgraded integration after deployment to verify one ambiguous code-change prompt calls/uses the Workflow catalog and submits a sensible explicit Workflow without changing Hub selection server-side.
