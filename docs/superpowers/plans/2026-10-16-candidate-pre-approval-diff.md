# Candidate Pre-Approval Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lazy, read-only repository Diff to pending Candidate review so an administrator can inspect the expected file change before approval, while continuing to use GitHub/GitLab PR/MR pages after approval.

**Architecture:** Keep the existing Candidate detail route and add one `GET /admin/api/knowledge-candidates/:id/diff` endpoint. Reuse the same publication target/path/content rules used by publishing, read one file from the configured target branch through the provider API, generate server-side structured hunks, and fetch/render them only when the reviewer clicks **查看变更 Diff**. Existing `/preview`, approval, publish, reconcile, deletion, and PR/MR flows remain unchanged.

**Tech Stack:** TypeScript, Node.js 24+, Fastify, built-in Admin HTML/JavaScript, Node test runner, `diff` (jsdiff) for structured line diffs.

**Spec:** `docs/superpowers/specs/2026-10-16-candidate-diff-preview-design.md`

## Global Constraints

- The repository Diff is available only while the Candidate is `pending`.
- Candidate detail must not read GitHub/GitLab until the reviewer clicks **查看变更 Diff**.
- `GET /admin/api/knowledge-candidates/:id/preview` keeps its existing semantic behavior.
- The new endpoint is exactly `GET /admin/api/knowledge-candidates/:id/diff`.
- Preview is read-only: no branch, file write, commit, push, PR/MR creation, Candidate state mutation, or history mutation.
- After approval, Team Skill Hub does not render its own Candidate Diff; existing publication/deletion PR/MR links remain the review surface.
- Preserve provider-specific target-branch behavior: GitLab uses `knowledgePublishing.targetBranch || repository.branch || "main"`; GitHub uses `knowledgePublishing.targetBranch || "main"`.
- Normalize CRLF to LF for preview comparison and hunk generation.
- Preview failure must not disable or hide approve/reject controls.
- Do not change Candidate persistence or publish/delete state machines.

## Review Focus

- A Candidate with no explicit repository/path but with an `updates`/`supersedes` relation must preview the same repository/path that publishing would use; Task 2 pins this with an application test.
- A missing remote file must be treated as `create`, while provider errors other than 404 must fail safely without exposing provider response bodies; Task 1 pins both providers.
- GitHub repository paths containing nested Markdown paths must preserve `/` separators in the Contents API URL rather than encoding the entire path as one segment; Task 1 pins nested paths.
- CRLF-only differences must normalize to `no_change`, but non-ASCII Markdown and multiple separated edits must retain correct line counts/hunks; Task 2 pins these cases.
- Repeated expand/collapse in one Candidate page instance must not repeat the remote read, while opening the page alone must not call `/diff`; Task 4 pins the generated Admin script structure and request placement.

---

### Task 1: Shared publication target and read-only provider baseline

**Files:**
- Modify: `src/knowledge-publishing.ts`
- Test: `tests/knowledge-publishing.test.ts`

**Interfaces:**
- Produces: `KnowledgePublishTarget` with `filePath`, `targetBranch`, and `desiredContent`.
- Produces: `resolveKnowledgePublishTarget(candidate: KnowledgeCandidate, repository: RepositoryConfig): KnowledgePublishTarget`.
- Produces: `KnowledgePublishBaseline` with `exists` and `content`.
- Extends `KnowledgePublisher` with `readTargetFile(target: KnowledgePublishTarget, repository: RepositoryConfig): Promise<KnowledgePublishBaseline>`.
- Existing `publish`, `deletePublished`, and `reconcile` remain callable with their current signatures.

- [ ] **Step 1: Write failing publisher tests for shared target resolution**

Add tests asserting:

```ts
assert.deepEqual(resolveKnowledgePublishTarget(candidate(), repository()), {
  filePath: "docs/ota/recovery-note.md",
  targetBranch: "master",
  desiredContent: "# OTA recovery note\n\nRecovery behavior learned during troubleshooting.\n",
});

assert.equal(resolveKnowledgePublishTarget(candidate(), githubRepoWithoutTargetBranch).targetBranch, "main");
assert.equal(resolveKnowledgePublishTarget(candidate(), gitLabRepoWithoutTargetBranch).targetBranch, repository.branch);
```

Also retain Skill serialization behavior so complete `SKILL.md` content gets only the existing trailing newline treatment.

- [ ] **Step 2: Run the focused publishing tests and confirm they fail**

Run: `node --import tsx --test tests/knowledge-publishing.test.ts`

Expected: FAIL because `resolveKnowledgePublishTarget` / `readTargetFile` do not exist yet.

- [ ] **Step 3: Implement the shared target resolver in `src/knowledge-publishing.ts`**

Add these exact public types/signatures:

```ts
export interface KnowledgePublishTarget {
  filePath: string;
  targetBranch: string;
  desiredContent: string;
}

export interface KnowledgePublishBaseline {
  exists: boolean;
  content: string;
}

export function resolveKnowledgePublishTarget(
  candidate: KnowledgeCandidate,
  repository: RepositoryConfig,
): KnowledgePublishTarget;
```

The helper must reuse `assertSafePath` and the current `markdownForCandidate` serialization, and preserve the existing provider-specific target-branch fallback rules. Refactor both provider `publish()` implementations to consume this resolver instead of independently recomputing path/branch/content.

- [ ] **Step 4: Write failing GitLab baseline-read tests**

Add tests that call `GitLabKnowledgePublisher.readTargetFile(...)` and assert:

```ts
assert.equal(calls.length, 1);
assert.equal(calls[0]?.method, "GET");
assert.match(calls[0]?.url ?? "", /repository\/files\/docs%2Fota%2Frecovery-note\.md\?ref=master/);
assert.deepEqual(result, { exists: true, content: "existing\n" });
```

Add a 404 case expecting `{ exists: false, content: "" }`, and a 500 case whose thrown message contains status/context but does **not** contain a secret-like provider body supplied by the mock.

- [ ] **Step 5: Implement GitLab `readTargetFile`**

Signature:

```ts
async readTargetFile(
  target: KnowledgePublishTarget,
  repository: RepositoryConfig,
): Promise<KnowledgePublishBaseline>;
```

Use one `GET` to the repository-files endpoint at `target.targetBranch`, decode base64 UTF-8 content, map 404 to `exists=false`, and throw a bounded/sanitized error for other statuses without embedding the raw response body.

- [ ] **Step 6: Write failing GitHub baseline-read tests**

Add tests for existing, missing, and provider-error cases. For a nested target path, assert the request URL keeps path separators:

```ts
assert.match(url, /\/contents\/docs\/ota\/recovery-note\.md\?ref=main$/);
```

The successful mock returns base64 content; 404 returns `{ exists: false, content: "" }`; non-404 failure must not expose the mocked provider body.

- [ ] **Step 7: Implement GitHub `readTargetFile`**

Use the GitHub Contents API at `ref=target.targetBranch`. Encode each path segment individually and join with `/`. Accept only a file response with base64 content; map 404 to missing; return a safe error for unsupported encoding/content or provider failure.

- [ ] **Step 8: Run publishing tests**

Run: `node --import tsx --test tests/knowledge-publishing.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/knowledge-publishing.ts tests/knowledge-publishing.test.ts
git commit -m "feat: add read-only candidate publication target preview"
```

### Task 2: Application-level Candidate Diff generation

**Files:**
- Modify: `src/application.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: create `tests/candidate-diff.test.ts`

**Interfaces:**
- Consumes: `resolveKnowledgePublishTarget(...)` and `KnowledgePublisher.readTargetFile(...)` from Task 1.
- Produces: `SkillHubApplicationService.getKnowledgeCandidateDiff(id: string): Promise<CandidateDiffPreview>`.
- Produces provider-neutral response fields `target`, `summary`, and `hunks` exactly as defined by the spec.

- [ ] **Step 1: Add the `diff` dependency**

Run: `npm install diff`

Expected: `package.json` and `package-lock.json` declare a direct runtime dependency on `diff`; do not rely on an undeclared transitive dependency.

- [ ] **Step 2: Write failing application tests for create/update/no-change**

Create `tests/candidate-diff.test.ts` using a service fixture with a configured test repository and a mocked provider read path. Cover:

```ts
assert.equal(result.target.operation, "create");
assert.equal(result.target.repositoryId, "rd-knowledges");
assert.equal(result.target.targetBranch, "main");
assert.equal(result.target.path, "knowledge/example.md");
assert.ok(result.summary.addedLines > 0);
assert.equal(result.summary.removedLines, 0);
```

For update, assert both additions/removals and at least two hunks for separated edits. For equal content, assert `operation === "no_change"`, zero counts, and no hunks.

- [ ] **Step 3: Run the new application test and confirm failure**

Run: `node --import tsx --test tests/candidate-diff.test.ts`

Expected: FAIL because `getKnowledgeCandidateDiff` does not exist.

- [ ] **Step 4: Extract one pure publication-context resolver inside `SkillHubApplicationService`**

Add a private helper used by both preview and `publishKnowledgeCandidate()` that resolves, without mutating Candidate state:

```ts
private resolveKnowledgeCandidatePublishContext(candidate: KnowledgeCandidate): {
  repositoryId: string;
  publishPath: string;
  publishingRepository: RepositoryConfig;
  target: KnowledgePublishTarget;
};
```

It must preserve the existing repository fallback, `updates`/`supersedes` relation target, cross-repository guard, `requirePublishingRoute(...)`, default path, and provider-specific publishing config. `publishKnowledgeCandidate()` may still persist missing `repository`/`suggestedPath` after resolution exactly as it does today.

- [ ] **Step 5: Implement `getKnowledgeCandidateDiff(id: string)`**

Add a public method that:

1. loads the Candidate and returns `Knowledge candidate not found` when absent;
2. requires `candidate.status === "pending"` and otherwise returns a stable `Knowledge candidate must be pending to preview diff` error;
3. resolves the publication context through the shared helper;
4. calls `createKnowledgePublisher(...).readTargetFile(...)` exactly once;
5. normalizes CRLF to LF in baseline and desired content;
6. uses jsdiff `structuredPatch` with three context lines;
7. maps hunk lines into `context` / `add` / `remove` with old/new line numbers;
8. returns `create`, `update`, or `no_change` plus added/removed totals;
9. performs no Candidate write/history/state mutation.

- [ ] **Step 6: Add review-focus tests**

Add tests for:

- relation target repository/path fallback matching publication behavior;
- CRLF baseline vs LF desired content => `no_change`;
- non-ASCII Markdown text preserved in hunk `text`;
- pending-only enforcement;
- Candidate `updatedAt` and history unchanged before/after preview.

- [ ] **Step 7: Run application Diff tests**

Run: `node --import tsx --test tests/candidate-diff.test.ts`

Expected: PASS.

- [ ] **Step 8: Run existing publishing tests to prove the refactor did not change publication behavior**

Run: `node --import tsx --test tests/knowledge-publishing.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/application.ts tests/candidate-diff.test.ts package.json package-lock.json
git commit -m "feat: generate pending candidate repository diff"
```

### Task 3: Admin `/diff` HTTP endpoint

**Files:**
- Modify: `src/server.ts`
- Test: `tests/admin-candidate-actions-e2e.test.ts`

**Interfaces:**
- Consumes: `service.getKnowledgeCandidateDiff(id)` from Task 2.
- Produces: `GET /admin/api/knowledge-candidates/:id/diff`.
- Existing `GET /admin/api/knowledge-candidates/:id/preview` remains unchanged.

- [ ] **Step 1: Write failing HTTP tests for the new endpoint**

Extend `tests/admin-candidate-actions-e2e.test.ts` with a focused server test that stubs `service.getKnowledgeCandidateDiff` and verifies:

```ts
const response = await fetch(candidateUrl + "/diff", { headers: adminHeaders });
assert.equal(response.status, 200);
assert.equal(requestedId, candidate.id);
assert.deepEqual(await response.json(), expectedDiff);
```

Also assert a request without the Admin key returns 403 and that the existing `/preview` route remains present/independent.

- [ ] **Step 2: Run the focused HTTP test and confirm failure**

Run: `node --import tsx --test tests/admin-candidate-actions-e2e.test.ts`

Expected: FAIL because `/diff` is not registered.

- [ ] **Step 3: Add the `/diff` Fastify route**

Add immediately alongside the current Candidate `/preview` route:

```ts
app.get<{ Params: { id: string } }>(
  "/admin/api/knowledge-candidates/:id/diff",
  async (request, reply) => { /* call getKnowledgeCandidateDiff */ },
);
```

Reuse the same Admin-access check. Candidate-not-found/pending-state/target-resolution/provider errors must return JSON `{ error }`; use existing server conventions, but do not expose provider response bodies because Task 1 already sanitizes remote-read errors.

- [ ] **Step 4: Add HTTP error cases**

Test Candidate-not-found and non-pending Diff requests return a non-2xx JSON error while `/admin/api/knowledge-candidates/:id/preview` behavior is unchanged.

- [ ] **Step 5: Run HTTP tests**

Run: `node --import tsx --test tests/admin-candidate-actions-e2e.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/server.ts tests/admin-candidate-actions-e2e.test.ts
git commit -m "feat: expose candidate diff endpoint"
```

### Task 4: Lazy inline Diff on pending Candidate detail

**Files:**
- Modify: `src/admin-ui.ts`
- Modify: `tests/admin-ui-structure.test.ts`
- Test: `tests/admin-ui-inline-scripts.test.ts` (existing parse regression; no content change required unless needed)

**Interfaces:**
- Consumes: `GET /admin/api/knowledge-candidates/:id/diff` from Task 3.
- Produces: collapsed `#candidateDiffToggle` and `#candidateDiffPanel` only for pending Candidate detail.
- Keeps existing approve/reject/publish/reconcile/delete controls and PR/MR links unchanged.

- [ ] **Step 1: Write failing Admin structure tests**

Extend `tests/admin-ui-structure.test.ts` to require the generated module HTML/script to contain:

```ts
assertContainsAll(ADMIN_MODULE_HTML, [
  "查看变更 Diff",
  "收起变更 Diff",
  "candidateDiffToggle",
  "candidateDiffPanel",
  "/diff",
  "addedLines",
  "removedLines",
]);
```

Also assert the Diff control is created inside the `status==='pending'` Candidate branch and the request is attached to the toggle click handler rather than the initial Candidate detail fetch path.

- [ ] **Step 2: Run Admin UI tests and confirm failure**

Run: `node --import tsx --test tests/admin-ui-structure.test.ts tests/admin-ui-inline-scripts.test.ts`

Expected: FAIL on the new Diff structure assertions; inline-script parse test should remain valid once implementation lands.

- [ ] **Step 3: Add compact Diff styles and render helpers**

In `ADMIN_MODULE_HTML`, add focused CSS for the collapsed control/panel and line kinds. Add script helpers with these responsibilities:

```ts
function candidateDiffBody(diff): string;
async function toggleCandidateDiff(id, button, panel): Promise<void>;
```

`candidateDiffBody` must escape repository/path/hunk text through existing `esc(...)`, render repository/target branch/path/operation/+/- summary, and render old/new line numbers with add/remove/context classes.

- [ ] **Step 4: Implement lazy pending-only UI wiring**

Inside `candidateDetail(id)`:

- render **查看变更 Diff** plus an initially hidden panel only when `status === "pending"`;
- do not request `/diff` during initial Candidate detail loading;
- first click requests `/admin/api/knowledge-candidates/${encodeURIComponent(id)}/diff`, renders and expands;
- collapse changes the label to **查看变更 Diff** but retains the loaded HTML/data;
- re-expand in the same page instance performs no second request;
- request failure renders `无法加载变更预览：...` inside the panel and leaves approval/rejection controls active.

Do not render this control for approved/rejected/publishing/publish_failed/published/deleting/delete_failed/deleted states.

- [ ] **Step 5: Add HTML-escaping and non-pending assertions**

Add structure/source assertions that all Diff-derived text routes through `esc(...)`, and that publication/deletion `打开 PR/MR` behavior remains in `candidatePublicationBody(...)` with `target="_blank" rel="noopener noreferrer"`.

- [ ] **Step 6: Run Admin UI tests**

Run: `node --import tsx --test tests/admin-ui-structure.test.ts tests/admin-ui-inline-scripts.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/admin-ui.ts tests/admin-ui-structure.test.ts tests/admin-ui-inline-scripts.test.ts
git commit -m "feat: add lazy candidate diff review"
```

### Task 5: Regression verification and final review

**Files:**
- No planned product-code changes; fix only defects found by verification/review.

**Interfaces:**
- Verifies Tasks 1-4 as one shipped behavior.

- [ ] **Step 1: Run focused feature tests together**

Run:

```bash
node --import tsx --test \
  tests/knowledge-publishing.test.ts \
  tests/candidate-diff.test.ts \
  tests/admin-candidate-actions-e2e.test.ts \
  tests/admin-ui-structure.test.ts \
  tests/admin-ui-inline-scripts.test.ts
```

Expected: PASS with all selected tests executed.

- [ ] **Step 2: Run repository format/type/lint/test validation**

Run: `npm run check`

Expected: formatter check, ESLint, TypeScript build, and full test suite all PASS.

- [ ] **Step 3: Review the final branch against the spec**

Confirm specifically:

- opening a pending Candidate performs no `/diff` request;
- `/diff` performs only provider reads and no Candidate writes;
- approved/later Candidate states have no local Diff UI;
- existing publication/deletion PR/MR links still work;
- `/preview` remains semantically unchanged;
- GitHub/GitLab target-branch fallbacks are unchanged;
- no raw provider response body is surfaced to Admin UI.

- [ ] **Step 4: Run `git status --short` and inspect final diff**

Expected: no unrelated changes; only feature/spec/plan commits are present.

- [ ] **Step 5: Final commit only if verification produced fixes**

```bash
git add <only files changed by verification fixes>
git commit -m "fix: harden candidate diff preview"
```
