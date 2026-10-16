# Candidate Publish Diff Preview Design

Date: 2026-10-16
Status: Proposed

## 1. Background

The unified Review Center currently lets an administrator inspect a Knowledge Candidate's metadata and full candidate body before approval and publication. After approval, the administrator can create the publication PR/MR, but the detail page does not clearly show the exact repository-level change that publication is expected to create.

This is especially important for `KnowledgeCandidate` records because publication can either create a new Markdown file or update an existing file. The reviewer should be able to answer, before clicking **发布 PR/MR**:

- Which repository and target branch will be changed?
- Which path will be written?
- Is this a create or update operation?
- What lines will be added and removed?
- Is the preview based on the same target and desired content that the publisher will actually use?

The application already exposes `GET /admin/api/knowledge-candidates/:id/preview`, but that endpoint answers a different, semantic question: it compares the Candidate with its indexed Knowledge relation target. That behavior is useful and should remain intact. It is not guaranteed to be the same file/revision that `publishKnowledgeCandidate()` will operate on in the configured target repository, so publish-oriented Diff uses a separate endpoint.

Skill Bundle imports already have a preview concept, although today that preview is mostly a changed-file summary rather than a GitHub-style line diff.

This design adds a publish-oriented Diff view to Candidate review and aligns preview target resolution with publication target resolution so that the preview represents the expected PR/MR content as closely as practical.

## 2. Goals

- Add a dedicated **Diff 预览** view to Candidate details in the Review Center.
- Show repository, target branch, target path, operation (`create` / `update`), and line-level changes before publication.
- Use the same target-resolution rules for preview and publish.
- Compare candidate publication content against the current target branch content, not only against an indexed Knowledge relation target.
- Keep preview read-only; opening the Diff view must not create branches, commits, PRs, or MRs.
- Keep existing approval and publication state transitions unchanged.
- Preserve current Candidate detail and history views.
- Make the backend preview payload provider-neutral so the Admin UI does not need GitHub/GitLab-specific logic.
- Support both existing Candidate publishing types (`knowledge` and legacy `skill`) through the same publish-preview contract.
- Preserve the existing semantic Candidate preview endpoint and behavior.
- Make preview failure visible without preventing the reviewer from viewing the candidate itself.

## 3. Non-goals

- Do not change the Candidate approval rules.
- Do not require a reviewer to open the Diff tab before publishing in the first version.
- Do not introduce a new persistent review-baseline model for Knowledge Candidates in the first version.
- Do not guarantee that the target branch cannot change between preview and publication.
- Do not create a temporary publication branch just to calculate the preview.
- Do not replace the existing semantic relation preview (`knowledgeRelation`, `relationHint`) as a domain concept.
- Do not redesign Skill Bundle publication in this change.
- Do not embed a full third-party diff editor component unless a future requirement justifies the dependency.

## 4. User experience

### 4.1 Candidate navigation

Candidate detail navigation becomes:

```text
候选详情 | Diff 预览 | 历史记录
```

Canonical routes:

```text
/admin/review/items/candidate/:id
/admin/review/items/candidate/:id/diff
/admin/review/items/candidate/:id/history
```

The existing `return` query parameter continues to be preserved across tabs.

### 4.2 Diff header

The Diff view first shows a compact publication target summary:

```text
Repository      rd-knowledges
Target branch   main
Path            knowledge/codex-v6-guidance-e2e-2026-10-15-d6036b6b55d1.md
Operation       update
Baseline        <provider revision / commit SHA when available>
Summary         +12 -4
```

For a new file, `Operation` is `create`. If the final desired content is byte-for-byte equal to the target file, the view shows `no_change` and a clear message that publication currently has no content change to commit.

### 4.3 Diff body

The first version uses a server-generated, provider-neutral unified diff model rendered by the existing Admin UI. The visual treatment should resemble common Git review tools:

- file header
- hunk header (`@@ ... @@`)
- unchanged context lines
- removed lines
- added lines
- line numbers for old/new sides when available

Default context is 3 lines around each hunk. A small amount of extra context may be included by the backend implementation, but the first version does not need an interactive arbitrary-context loader.

Example:

```diff
--- a/knowledge/example.md
+++ b/knowledge/example.md
@@ -10,7 +10,9 @@
 Existing context
-old sentence
+replacement sentence
+new detail
 Existing context
```

For a created file:

```diff
--- /dev/null
+++ b/knowledge/example.md
@@ -0,0 +1,8 @@
+# Example
+...
```

### 4.4 State behavior

The Diff tab is primarily a pre-publication review surface:

- `pending`: reviewer can inspect expected repository change before approval.
- `approved` / `publish_failed`: reviewer can inspect immediately before publication/retry.
- `publishing`, `published`, and deletion-related states: the page should prefer the existing PR/MR link and clearly state that the remote PR/MR Diff is authoritative. It must not present a newly recomputed live preview as though it were the content of an already-created PR/MR.
- deleted Candidate records are naturally unavailable because the Candidate no longer exists.

The first version does not lock the preview baseline. Therefore every pre-publication preview must label the baseline as a live read from the configured target branch and must not imply that an earlier preview is permanently frozen.

### 4.5 Failure behavior

If target content cannot be read, the Diff tab shows a focused error with enough context to act on it:

- repository
- target branch
- path
- error category/message

The Candidate detail page itself remains usable. Publication behavior is not silently changed by preview failure.

## 5. Publish target model

### 5.1 Problem in the current flow

`publishKnowledgeCandidate()` independently resolves:

- repository
- publication route
- target branch
- publish path
- desired Markdown content

The existing Candidate preview instead starts with `knowledgeRelation` / `relationHint`, looks up the indexed Knowledge document, and compares that document content to `candidate.content`.

Those are different questions:

1. **Semantic relation preview:** how does the candidate relate to an indexed Knowledge document?
2. **Publish diff preview:** what repository change will publication attempt to create now?

The new Diff tab answers the second question.

### 5.2 Shared target resolution

Introduce a shared application-level publication target resolver used by both preview and publish.

Conceptual model:

```ts
interface KnowledgePublishTarget {
  repositoryId: string;
  repository: RepositoryConfig;
  publishingType: "knowledge" | "skill";
  targetBranch: string;
  path: string;
  desiredContent: string;
}
```

The exact type may remain internal rather than being exported.

The resolver owns the existing rules for:

- repository fallback
- relation-target repository compatibility
- default publish path
- configured publication route
- target branch selection
- final Markdown serialization used by the publisher

Target-branch resolution must preserve current provider behavior unless a separate compatibility change is approved. In particular, the current GitLab publisher falls back through `knowledgePublishing.targetBranch -> repository.branch -> main`, while the current GitHub publisher falls back through `knowledgePublishing.targetBranch -> main`. Moving this logic into a shared resolver must not silently make those semantics identical.

The key invariant is:

> Given the same Candidate and configuration, preview and publish must resolve the same repository, branch, path, and desired file content.

### 5.3 Desired content serialization

Today publisher implementations derive `desiredContent` internally through `markdownForCandidate(candidate)`. To prevent preview/publish drift, desired-content construction should be promoted to a shared provider-neutral helper or passed into the publisher from the resolved publication target.

Preferred direction:

```text
Candidate
  -> resolveKnowledgePublishTarget()
       -> repository
       -> targetBranch
       -> path
       -> desiredContent
  -> preview reads baseline and diffs it
  -> publish writes desiredContent to the same target
```

Avoid implementing one Markdown formatter in preview and another in publisher code.

## 6. Provider-neutral baseline reader

### 6.1 Read contract

Add a read-only publication-preview capability alongside publishing. The exact interface may be a separate reader or a method on the publisher abstraction, but it must not mutate the remote repository.

Recommended shape:

```ts
interface KnowledgePublishBaseline {
  exists: boolean;
  content?: string;
  revision?: string;
}

interface KnowledgePublisher {
  readBaseline(
    target: KnowledgePublishTarget,
    repository: RepositoryConfig,
  ): Promise<KnowledgePublishBaseline>;

  publish(...): Promise<KnowledgePublicationResult>;
  deletePublished(...): Promise<KnowledgePublicationResult>;
  reconcile(...): Promise<...>;
}
```

If exposing `KnowledgePublishTarget` directly to publishers creates an undesirable public dependency, the method can receive only `path` and `targetBranch`. The architectural requirement is provider-neutral read behavior, not this exact TypeScript signature.

### 6.2 GitHub

For GitHub publishing, preview should read the configured target branch without creating a worktree branch or pushing anything.

Preferred implementation choices, in order:

1. GitHub Contents API for a single file at `ref=<targetBranch>`.
2. Existing Git clone machinery only if the API approach cannot satisfy configured GitHub Enterprise/base URL behavior.

Expected result:

- `404` => file does not exist, operation is `create`.
- successful file read => decode UTF-8 content, operation is `update` unless unchanged.
- capture blob SHA or commit-ish metadata when cheaply available as `revision`.
- if the Contents API cannot return inline UTF-8 content because of provider size/encoding behavior, fail with a typed preview error or use a bounded read-only blob/raw-content fallback; do not silently treat the file as missing.

### 6.3 GitLab

For GitLab publishing, reuse the repository-files API already used by publication logic:

- GET file at the target branch when present.
- `404` => create.
- decode base64 file content.
- include available blob/commit metadata as `revision`.

### 6.4 Read-only guarantee

Preview code must never:

- create a branch
- write/update a file
- commit
- push
- create/reopen a PR/MR
- update Candidate publication state

Tests must verify that provider preview only performs read calls / read-only Git operations.

## 7. Diff generation

### 7.1 Server-side generation

Generate line diff data on the server. The browser should receive structured data rather than implementing its own diff algorithm.

Reasons:

- keeps behavior deterministic across clients
- makes API tests straightforward
- avoids shipping a large client diff library into the inline Admin page
- allows the same preview model to be reused by future clients

### 7.2 Diff model

Recommended response shape:

```ts
interface CandidatePublishPreview {
  candidate: {
    id: string;
    title: string;
    status: string;
  };
  target: {
    repositoryId: string;
    targetBranch: string;
    path: string;
    operation: "create" | "update" | "no_change";
    baselineRevision?: string;
  };
  summary: {
    addedLines: number;
    removedLines: number;
  };
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: Array<{
      kind: "context" | "add" | "remove";
      text: string;
      oldLine?: number;
      newLine?: number;
    }>;
  }>;
}
```

The API should not return credentials, authenticated clone URLs, tokens, request headers, or provider-internal secret-bearing errors.

### 7.3 Diff implementation

Prefer a small, established line-diff dependency already present in the dependency graph if one exists. Otherwise add the smallest suitable dependency rather than implementing a fragile diff algorithm from scratch.

The implementation must correctly handle:

- empty old file
- empty new file
- create
- update
- no change
- final newline differences
- CRLF/LF normalization policy
- multiple separated hunks
- non-ASCII Markdown content

Line-ending policy must be explicit. Recommended first-version behavior: compare decoded text after normalizing CRLF to LF, because publication writes logical UTF-8 Markdown content and the preview is meant to communicate content changes rather than repository line-ending noise. If the repository intentionally preserves CRLF, this choice should be revisited before implementation.

## 8. API changes

Preserve the existing semantic preview endpoint:

```text
GET /admin/api/knowledge-candidates/:id/preview
```

Add a separate publish-oriented endpoint:

```text
GET /admin/api/knowledge-candidates/:id/publish-preview
```

The new endpoint returns `CandidatePublishPreview` from Section 7. Keeping the two endpoints separate prevents a semantic/API break and makes the distinction explicit:

- `/preview` = Candidate vs indexed Knowledge relation target.
- `/publish-preview` = current repository target file vs content the publisher intends to write.

HTTP behavior:

- `200`: preview generated, including `no_change`.
- `404`: Candidate does not exist.
- `400` or `409`: Candidate exists, but target cannot be resolved because repository/path/configuration is incomplete or inconsistent.
- `502`: remote provider read failed after target resolution.

The exact error status for remote failures should follow existing server conventions if introducing `502` would be inconsistent with the current application, but the response must distinguish `not found Candidate` from `preview target/read failure`.

Do not return raw provider response bodies directly from this endpoint. Map failures to stable Admin-facing error codes/messages (for example `preview_target_unresolved`, `preview_remote_read_failed`, `preview_content_unsupported`) while retaining bounded provider detail only in server-side diagnostics.

## 9. Admin UI changes

### 9.1 Route parser

Extend Candidate review detail subresources to support:

```ts
subresource?: "diff" | "history";
```

Legacy Candidate review routes continue to redirect to the canonical Review Center route where applicable.

### 9.2 Candidate navigation renderer

Extend `candidateNav()` to render three tabs:

```text
候选详情 | Diff 预览 | 历史记录
```

### 9.3 Diff renderer

Add a dedicated `candidateDiff(id)` loader that calls the publish-preview endpoint and renders:

1. publication target summary
2. added/removed counters
3. unified diff hunks
4. empty/no-change state
5. focused preview error state

The renderer must use existing HTML escaping for every provider/candidate-derived string.

CSS should use the existing Admin design language. Added/removed/context lines need visually distinct backgrounds and prefixes, but no external CSS framework is required.

### 9.4 Publish action placement

Keep the Publish button on the Candidate detail page in the first version. Do not add a hard client-side gate requiring the Diff tab to be visited.

Optionally add a nearby **查看 Diff** link for `approved` and `publish_failed` states to make the preview discoverable immediately before publication.

## 10. Publication integration

Refactor `publishKnowledgeCandidate()` so target resolution occurs before state mutation and returns a reusable target object.

Recommended high-level flow:

```text
load Candidate
  -> validate candidate relationship constraints
  -> resolve publication target
  -> persist missing repository/suggestedPath defaults when needed
  -> mark Candidate publishing
  -> publisher.publish(candidate, resolvedTarget)
  -> persist publication
```

Preview flow:

```text
load Candidate
  -> resolve publication target with the same resolver
  -> publisher.readBaseline(resolvedTarget)
  -> diff baseline.content against resolvedTarget.desiredContent
  -> return structured preview
```

The resolver itself must not mutate Candidate state. If publish currently persists default repository/path values, that remains a publish-specific step after resolution. Preview reports the effective values without persisting them.

This preserves an important property: simply viewing Diff must not change Candidate history or updated timestamps.

## 11. Consistency and race behavior

The preview is a live snapshot, not a lock. It is a **single target-file preview**, not a guarantee that an already-existing deterministic publication branch contains no unrelated or stale changes.

Race example:

```text
T1 reviewer opens Diff against main@A
T2 another PR updates the same file, main becomes B
T3 reviewer clicks Publish
T4 publication operates against current target behavior
```

The first version accepts this race and labels preview baseline metadata clearly. The generated PR/MR remains the authoritative publication artifact.

Publication branches are deterministic per Candidate and current publisher implementations may reuse an existing remote branch on retry. If such a branch already exists, the preview must surface that fact when it can be determined cheaply, or at minimum show a warning that retry publication may reuse an existing source branch. The first version still previews the Candidate's target file only; it does not claim to enumerate unrelated files that might already exist on that branch.

A future version may add a `baselineRevision` confirmation and mark preview stale if target HEAD changed before publish, similar to Skill Bundle review baselines. That is deliberately out of scope here because it changes publication semantics and introduces a stronger approval contract.

## 12. Security and privacy

- Preview requires the same Admin access check as Candidate detail and publication APIs.
- Provider credentials stay server-side.
- No token, Authorization header, authenticated remote URL, SSH private material, or secret environment-variable value may appear in the preview response.
- Remote error bodies must continue to be bounded and should be sanitized before returning to Admin UI.
- File paths and external text must be HTML-escaped in the Admin UI.
- The path validation used for publication must also apply to preview.

## 13. Performance

Candidate Diff is loaded only when the Diff tab is opened; Candidate detail should not automatically fetch remote repository content.

This keeps normal review-list/detail navigation cheap and moves network cost to explicit preview usage.

The preview reads one target file and computes one text diff. No repository-wide tree diff is required for a Knowledge Candidate.

A reasonable provider-read timeout should reuse existing publishing request conventions. Preview failures should fail quickly enough that the Admin UI remains usable.

## 14. Testing strategy

### 14.1 Application tests

Cover target resolution and preview generation:

- explicit Candidate repository/path
- default repository/path resolution
- relation target repository/path behavior
- invalid cross-repository relation target
- create preview
- update preview
- no-change preview
- non-ASCII content
- multiple diff hunks
- preview does not mutate Candidate

### 14.2 Publisher tests

GitHub and GitLab preview tests should verify:

- target branch/path are correct
- existing file content is decoded correctly
- missing file maps to `exists=false`
- provider read errors are bounded/sanitized
- no branch creation, commit, push, file-write API, or PR/MR creation occurs

### 14.3 Server/API tests

Cover:

- Admin auth required
- Candidate not found
- existing semantic `/preview` response remains unchanged
- successful structured `/publish-preview` response
- unresolved publication target
- provider read failure and sanitized error mapping

### 14.4 Admin UI tests

Extend structure/routing tests to cover:

- Diff tab exists
- `/candidate/:id/diff` route resolves correctly
- preview endpoint is called only on the Diff view
- create/update/no-change rendering
- HTML escaping
- error rendering
- existing Candidate detail/history routes remain functional

### 14.5 Regression validation

Run the focused Candidate/publishing/Admin tests first, then the repository's normal full test suite and type checking.

## 15. Files expected to change

Likely implementation files:

- `src/admin-routes.ts`
- `src/admin-ui.ts`
- `src/application.ts`
- `src/knowledge-publishing.ts`
- Candidate publishing / server / Admin UI test files
- package manifest/lock only if a new diff dependency is required

`src/review-center.ts` should not need a domain-model change unless the implementation chooses to expose Diff availability in list projections, which is not required by this design.

Skill Bundle code should remain unchanged except for shared UI helpers if reuse is genuinely beneficial.

## 16. Alternatives considered

### 16.1 Frontend-only diff using the existing preview endpoint

Rejected as the primary design.

It would be easy to render, but it would compare against an indexed relation target rather than necessarily against the configured publication target branch/path. That creates a misleading "looks like PR diff" interface without guaranteeing PR-oriented semantics.

### 16.2 Clone the repository and run `git diff` for every preview

Viable but not preferred for a single-file Candidate.

It gives exact Git semantics but adds clone latency, filesystem work, SSH dependency, cleanup requirements, and higher operational cost. Provider file APIs are simpler for one target file.

### 16.3 Create the publication branch first and show the remote PR diff

Rejected.

Preview must be read-only. Creating a branch/commit/PR before the reviewer clicks Publish would collapse the distinction between review and publication.

### 16.4 Freeze Candidate preview baseline at approval time

Deferred.

This provides stronger audit guarantees but introduces a new persistent baseline, stale state, and re-approval behavior. Skill Bundle already has such concepts, but adding them to Knowledge Candidates should be a separate workflow decision.

## 17. Acceptance criteria

The feature is complete when all of the following are true:

1. Candidate details expose a dedicated **Diff 预览** tab.
2. The preview identifies the effective repository, target branch, target path, and create/update/no-change operation.
3. The preview compares the current configured target-branch file against the exact content publication intends to write for both Knowledge and legacy Skill Candidates.
4. Preview and publish share target/path/content resolution rather than duplicating those rules, while preserving existing provider-specific target-branch fallback semantics.
5. The UI renders line-level unified diff hunks with added/removed counts.
6. Opening preview performs no remote mutation and no Candidate state/history mutation.
7. Preview errors do not make Candidate detail unusable.
8. Existing approval, publish, reconcile, delete, and history workflows continue to behave as before.
9. GitHub and GitLab provider paths are covered by read-only preview tests.
10. The existing semantic `/preview` endpoint remains backward-compatible; publish Diff uses `/publish-preview`.
11. Retried publication with a pre-existing deterministic source branch is not misrepresented as a complete full-PR diff.
12. Existing unrelated worktree changes are preserved.

## 18. Future extensions

Possible follow-ups, intentionally excluded from the first implementation:

- require a reviewer to confirm a specific preview revision before Publish
- stale-preview detection when the target branch moves
- side-by-side diff mode
- expandable arbitrary context / full-file view
- syntax highlighting for Markdown/code fences
- reuse the same structured hunk renderer for Skill Bundle per-file diffs
- compare an already-created PR/MR head against target after publication
