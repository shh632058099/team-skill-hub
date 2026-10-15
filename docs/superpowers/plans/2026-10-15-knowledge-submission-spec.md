# Knowledge Submission Spec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Team Skill Hub the single source of truth for Knowledge submission rules, dynamically expose the active spec to clients, and route MCP, Admin, Gap/Curator and automatic Knowledge Candidates through the same server-side contract.

**Architecture:** Introduce a versioned `KnowledgeSubmissionSpecStore` persisted under `${DATA_DIR}/config/knowledge-submission-spec`, plus a `KnowledgeSubmissionService` that owns validation, normalization and rendering. The MCP and Admin layers only expose/modify this server contract, while all Knowledge Candidate creation paths call the same service before persistence. Client guidance stops embedding the six-section format and instead fetches the current spec before submission.

**Tech Stack:** TypeScript, Node.js, MCP SDK/Zod, existing Admin HTTP/UI, node:test, JSON persistence with atomic writes.

**Spec:** `docs/superpowers/specs/2026-10-15-knowledge-submission-spec-design.md`

## Global Constraints

- Do not use a git worktree; implement in the current checkout as explicitly approved by the user.
- Default Knowledge spec remains the current six-section Markdown structure: 问题、根因、解决方案、验证结果、适用范围、约束/限制.
- Default title max is 160 chars; recommended range is 20-80 chars; default content max is 50,000 chars.
- Spec persistence is under `${DATA_DIR}/config/knowledge-submission-spec/current.json` and `history/vN.json`.
- `schema_version` versions the spec file shape; `spec_version` versions Knowledge policy changes and monotonically increases.
- Rollback creates a new spec version by copying an older version; it never moves the active version backwards.
- The service always validates submissions server-side; client-provided `spec_version` is evidence, not authority.
- Old submissions are accepted only when they still validate under the current spec; otherwise return `KNOWLEDGE_SPEC_OUTDATED` with the current version and retry action.
- Automatic candidates must never fabricate required content such as unknown/N/A placeholders.
- Client guidance must retain the core safety prohibition against secrets, credentials, customer-sensitive data and unverified speculation.

## Review Focus

- Corrupt or partially-written spec files must fail closed or fall back only when the active file is absent, never silently accept malformed persisted policy.
- Concurrent saves must not create duplicate or regressing `spec_version` values; atomic writes and serialized save behavior are required.
- A stale `spec_version` submission that still conforms to current policy must be accepted and normalized using current rules; incompatible stale submissions must produce `KNOWLEDGE_SPEC_OUTDATED`.
- Existing non-Knowledge/legacy Skill Candidate paths must not be forced through the Knowledge contract.
- Automatic candidate generation with incomplete structured fields must record a skipped decision rather than emit low-quality placeholder Knowledge.

---

### Task 1: Versioned Knowledge Submission Spec Store

**Files:**
- Create: `src/knowledge-submission-spec.ts`
- Test: `tests/knowledge-submission-spec.test.ts`

**Interfaces:**
- Produces: `KnowledgeSubmissionSpec`, `defaultKnowledgeSubmissionSpec()`, `validateKnowledgeSubmissionSpec(value)`, `KnowledgeSubmissionSpecStore.loadCurrent()`, `.saveNext(specInput)`, `.history()`, `.rollbackTo(version)`.
- Persists current/history JSON under `${dataDir}/config/knowledge-submission-spec`.

- [ ] **Step 1: Write failing tests** covering default values, first-load fallback when files do not exist, save v2 from v1, history ordering, rollback creating vN+1, malformed persisted current failing closed, and two serialized saves producing distinct monotonic versions.
- [ ] **Step 2: Run** `node --import tsx --test tests/knowledge-submission-spec.test.ts` and verify failures are due to missing store/interfaces.
- [ ] **Step 3: Implement** the store with schema validation, atomic temp-file rename writes, and an in-process mutation queue.
- [ ] **Step 4: Re-run** the targeted test and verify PASS.
- [ ] **Step 5: Commit** `feat: add knowledge submission spec store`.

### Task 2: Unified Knowledge Submission Service

**Files:**
- Create: `src/knowledge-submission.ts`
- Modify: `src/knowledge-summary.ts`
- Test: `tests/knowledge-submission.test.ts`

**Interfaces:**
- Consumes: `KnowledgeSubmissionSpec` from Task 1.
- Produces: `KnowledgeSubmissionService.currentSpec()`, `.normalize({ title, content, submittedSpecVersion? })`, `.buildFromStructuredDraft(draft)` and `KnowledgeSpecOutdatedError`.

- [ ] **Step 1: Write failing tests** for exact six-section rendering, 50,000-char limit, title normalization, aliases, stale-compatible acceptance, stale-incompatible `KNOWLEDGE_SPEC_OUTDATED`, current-version invalid submission rejection, and structured drafts refusing missing required sections/placeholders.
- [ ] **Step 2: Run** `node --import tsx --test tests/knowledge-submission.test.ts` and verify RED.
- [ ] **Step 3: Implement** the service and refactor existing `knowledge-summary.ts` so parser behavior is driven by the active spec rather than duplicated hard-coded limits/headings.
- [ ] **Step 4: Re-run** targeted tests and verify PASS.
- [ ] **Step 5: Commit** `feat: centralize knowledge submission validation`.

### Task 3: Application and MCP Integration

**Files:**
- Modify: `src/application.ts`
- Modify: `src/mcp.ts`
- Modify: `src/observability.ts` or candidate metadata type location as required
- Modify: `src/index.ts`
- Test: `tests/mcp.test.ts` and/or a focused new `tests/knowledge-submission-mcp.test.ts`
- Test: existing candidate/application tests that cover `submitKnowledgeCandidate`.

**Interfaces:**
- Consumes: `KnowledgeSubmissionSpecStore` and `KnowledgeSubmissionService`.
- Produces MCP tool `get_knowledge_submission_spec` and extends `submit_knowledge_candidate` with optional/required-by-guidance `spec_version`.
- Candidate records gain `submissionSpecVersion`, `submissionSpecSchemaVersion`, and `submissionMode` for Knowledge items.

- [ ] **Step 1: Write failing tests** proving MCP returns current spec/template/instruction, 50k content is accepted, stale incompatible submission returns structured outdated error, and candidate metadata records applied spec/version/mode.
- [ ] **Step 2: Run** the focused MCP/application tests and verify RED.
- [ ] **Step 3: Wire** store/service construction in `index.ts`, expose application methods, register MCP tool, and route `submitKnowledgeCandidate` Knowledge inputs through the unified service while leaving Skill compatibility paths unchanged.
- [ ] **Step 4: Re-run** focused tests and verify PASS.
- [ ] **Step 5: Commit** `feat: expose knowledge submission spec over mcp`.

### Task 4: Automatic Candidate and Gap/Curator Unification

**Files:**
- Modify: `src/application.ts`
- Modify: `src/knowledge-curation.ts` if Curator application creates/updates Knowledge content outside the unified path.
- Test: candidate detection/automatic candidate tests and gap/curation tests.

**Interfaces:**
- Consumes: `KnowledgeSubmissionService.buildFromStructuredDraft()` / `.normalize()`.
- Produces: all newly-created Knowledge Candidates use the same normalization path; automatic creation skips when required structured fields are missing.

- [ ] **Step 1: Write failing tests** showing an automatic candidate is normalized with current spec metadata and a candidate with insufficient required fields is skipped with `missing-required-knowledge-field` instead of creating placeholder content.
- [ ] **Step 2: Add failing tests** for Gap/Admin/Curator-created Knowledge paths that previously bypassed normalization, where such bypass exists.
- [ ] **Step 3: Run** focused automatic/gap/curator tests and verify RED.
- [ ] **Step 4: Route** these flows through a single internal `createKnowledgeCandidate` helper backed by `KnowledgeSubmissionService`; keep direct observability persistence private to already-normalized Knowledge.
- [ ] **Step 5: Re-run** focused tests and verify PASS.
- [ ] **Step 6: Commit** `refactor: unify knowledge candidate creation`.

### Task 5: Admin Spec API and UI

**Files:**
- Modify: `src/server.ts`
- Modify: `src/admin-ui.ts`
- Test: Admin server/UI tests (create focused test file if current tests are broad).

**Interfaces:**
- Consumes: `KnowledgeSubmissionSpecStore` through application service methods.
- Produces endpoints for current spec, save-new-version, history, rollback, and `/admin/knowledge-submission-spec` editor page.

- [ ] **Step 1: Write failing API tests** for GET current/history, PUT/save creating version+1, rollback creating version+1 from historical content, invalid config rejection, and admin authorization.
- [ ] **Step 2: Write failing UI/static assertions** for current version display, title/content fields, section editor, safety toggles, template preview, save, history and rollback controls.
- [ ] **Step 3: Run** focused tests and verify RED.
- [ ] **Step 4: Implement** Admin endpoints and dedicated page; save/rollback must hot-apply without restart.
- [ ] **Step 5: Re-run** focused tests and verify PASS.
- [ ] **Step 6: Commit** `feat: manage knowledge submission spec in admin`.

### Task 6: Client Guidance and Documentation Migration

**Files:**
- Modify: `client-integration/templates/codex-guidance.md`
- Modify: `client-integration/templates/claude-guidance.md`
- Modify: `scripts/setup-codex-mcp.sh`
- Modify: `scripts/setup-codex-mcp.ps1`
- Modify: `scripts/setup-claude-code.sh`
- Modify: `scripts/setup-claude-code.ps1`
- Modify: `docs/developer/developer-guide.md`
- Test: `tests/client-integration-bootstrap.test.ts` plus any guidance snapshot/string tests.

**Interfaces:**
- Consumes: MCP tool names from Task 3.
- Produces: clients instruct models to call `get_knowledge_submission_spec` before manual Knowledge submission and no longer embed the six-section spec.

- [ ] **Step 1: Write failing tests** that require `get_knowledge_submission_spec` guidance and forbid embedded `## 问题`/fixed six-section blocks in generated client guidance.
- [ ] **Step 2: Run** focused client integration tests and verify RED.
- [ ] **Step 3: Update** templates/setup scripts/docs to reference the dynamic server spec while retaining core safety rules.
- [ ] **Step 4: Re-run** focused tests and verify PASS.
- [ ] **Step 5: Commit** `docs: fetch knowledge submission rules from server`.

### Task 7: Whole-System Regression, Real Deployment and Review

**Files:**
- No new feature files unless review fixes require them.

**Interfaces:**
- Validates all previous task outputs together.

- [ ] **Step 1: Run** `npm test` and require all tests to pass.
- [ ] **Step 2: Run** `npm run build` and `git diff --check`.
- [ ] **Step 3: Run** `./deploy-local-wsl2.sh`, verify readiness, and use the real Team Skill Hub MCP path to fetch the current spec and submit a disposable Knowledge Candidate using its `spec_version`; verify Admin can read it and delete the disposable Candidate afterward.
- [ ] **Step 4: Run Superpowers whole-branch code review** against the design/plan; fix Critical/Important findings with RED→GREEN tests and re-run the full suite once.
- [ ] **Step 5: Commit** any review fixes. Do not push unless the user asks.
