# Candidate Pre-Approval Diff Design

Date: 2026-10-16
Status: Proposed

## 1. Background

The Review Center currently shows Candidate metadata and the full Candidate body, but an administrator cannot easily see what repository content would change before approving the Candidate.

The desired workflow is intentionally simple:

```text
Pending Candidate
  -> review metadata/content
  -> review Diff
  -> approve or reject

Approved Candidate
  -> publish PR/MR
  -> use the existing PR/MR link to inspect the real remote Diff

Published Candidate
  -> delete published content
  -> use the existing deletion PR/MR link to inspect the deletion Diff
```

The system does not need to maintain its own Diff view after approval. Once a PR/MR exists, GitHub/GitLab is the authoritative review surface.

## 2. Goals

- Show a repository-oriented line Diff while a Candidate is still `pending`.
- Let the reviewer understand the expected file change before clicking **批准**.
- Show the effective repository, target branch, target path, and create/update operation.
- Keep the preview read-only: no branch, commit, push, PR, or MR may be created.
- Preserve the existing approval, publish, reconcile, and deletion workflows.
- After publication or deletion publication is created, rely on the existing PR/MR links instead of maintaining a second local Diff view.
- Keep the implementation small and focused on the review-before-approval use case.

## 3. Non-goals

The first version explicitly does **not** add:

- Diff review after Candidate approval.
- Diff review after a publication PR/MR exists.
- Diff review for deletion PR/MR content.
- stale-preview detection or revision locking.
- source-branch comparison or retry-branch analysis.
- a persistent Candidate Diff snapshot.
- a second PR/MR viewer inside Team Skill Hub.
- changes to Skill Bundle review.
- changes to publish or delete state machines.

If a target branch changes between approval and later publication, the resulting PR/MR remains the authoritative result. This feature is an approval aid, not a publication lock.

## 4. User experience

### 4.1 Pending Candidate

For `status=pending`, Candidate detail keeps the existing information and adds a compact **查看变更 Diff** control before the approval buttons. The Diff is collapsed by default.

Recommended default layout:

```text
候选详情

ID              kc_...
标题            ...
仓库            rd-knowledges
建议路径        knowledge/example.md
状态            待审核
...

候选正文
...

[查看变更 Diff]

[批准] [拒绝] [删除 Candidate]
```

Only after the reviewer clicks **查看变更 Diff** does the page call `/diff` and expand the preview inline:

```text
[收起变更 Diff]

Repository       rd-knowledges
Target branch    main
Path             knowledge/example.md
Operation        update
Summary          +12 -4

@@ -10,7 +10,9 @@
 existing context
-old sentence
+replacement sentence
+new detail
 existing context
```

There is no separate Diff tab in the first version. The collapsed inline control keeps the Candidate page visually compact while still making Diff available immediately before approval. Loading is lazy: merely opening a pending Candidate must not trigger a remote repository read.

### 4.2 New file

If the target file does not exist, the preview shows a create Diff:

```diff
--- /dev/null
+++ b/knowledge/example.md
@@ -0,0 +1,4 @@
+# Example
+
+New content
```

### 4.3 No content change

If the target file already matches the expected Candidate publication content, show:

```text
目标文件内容与候选发布内容一致，没有内容差异。
```

This is informational only. The first version does not change approval or publish behavior because of this condition.

### 4.4 Approved and later states

For `approved` and `publish_failed`, the Candidate detail keeps the existing **发布 PR/MR** action. The local pre-approval Diff section is no longer shown.

For `publishing` and `published`, show the existing publication PR/MR link. The reviewer opens that PR/MR to inspect the actual Diff.

For deletion flow, once **删除已发布内容** creates a deletion PR/MR, show the existing deletion PR/MR link. The reviewer opens that PR/MR to inspect the deletion Diff.

Team Skill Hub does not duplicate GitHub/GitLab Diff rendering after a PR/MR exists.

## 5. Preview semantics

The pending Candidate preview answers one question:

> If this Candidate were published against the configured target branch now, what would the target file change look like?

The preview compares:

```text
current target-branch file
        ↓
expected Candidate publication content
```

It does not compare an existing publication source branch and does not claim to represent a future PR after the target branch moves.

The UI should label it as a current approval preview, not a frozen publication snapshot.

## 6. Backend design

### 6.1 Keep the existing semantic preview

The existing endpoint remains unchanged:

```text
GET /admin/api/knowledge-candidates/:id/preview
```

It continues to describe the Candidate in relation to indexed Knowledge content.

### 6.2 Add one repository Diff endpoint

Add:

```text
GET /admin/api/knowledge-candidates/:id/diff
```

The Admin UI calls this endpoint only for a `pending` Candidate, and only after the reviewer explicitly expands **查看变更 Diff**. Opening the Candidate detail page alone must not call the endpoint.

Recommended response:

```ts
interface CandidateDiffPreview {
  target: {
    repositoryId: string;
    targetBranch: string;
    path: string;
    operation: "create" | "update" | "no_change";
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

No branch metadata, PR metadata, stale token, snapshot ID, or approval token is required.

### 6.3 Resolve the same basic publication target

Preview must reuse the current Candidate publication rules needed to determine:

- repository
- publication route
- target branch
- publish path
- final serialized Candidate content

The implementation does not need a large new publishing abstraction. Small shared helpers are enough, especially for final Candidate serialization and target/path resolution, so preview does not independently invent different rules.

Existing provider-specific target-branch behavior must remain unchanged.

### 6.4 Read the current target file

The provider preview path is read-only.

For GitHub:

- read the configured target file from the target branch through the GitHub API;
- `404` means create;
- decode text content for update comparison.

For GitLab:

- read the configured target file from the target branch through the repository-files API;
- `404` means create;
- decode base64 content for update comparison.

Preview must never create or modify a remote branch, file, commit, PR, or MR.

## 7. Diff generation

Generate the line Diff on the server and return structured hunks to the Admin UI.

Use a small established Diff dependency if needed rather than implementing a custom Diff algorithm.

Required cases:

- create
- update
- no change
- multiple hunks
- non-ASCII Markdown
- LF/CRLF normalization

Use approximately 3 context lines around each hunk.

The UI renders a Git-style unified Diff with escaped text and simple added/removed/context styling.

## 8. Error behavior

Diff preview failure must not make the Candidate detail unusable.

Because preview is lazy, a failure appears only after the reviewer clicks **查看变更 Diff**. The page still shows the Candidate and approval controls, with a focused message in the expanded preview area such as:

```text
无法加载变更预览：读取目标仓库文件失败。
```

Do not expose tokens, Authorization headers, authenticated clone URLs, or raw secret-bearing provider responses.

The reviewer may still approve or reject based on the normal Candidate information. This feature does not introduce a hard approval gate.

## 9. Admin UI changes

The main UI change stays inside the existing Candidate detail renderer.

For `pending` Candidate detail:

1. load Candidate detail normally;
2. render a collapsed **查看变更 Diff** control without calling `/diff`;
3. when the reviewer clicks it, request `/diff` and expand the result inline;
4. allow the reviewer to collapse and re-expand the already loaded result without another request during the same page instance;
5. keep existing approval/rejection buttons unchanged.

For every other Candidate status:

- do not request `/diff`;
- retain existing Candidate detail behavior;
- retain publication and deletion PR/MR links.

No new Candidate route is required.

## 10. Testing strategy

### 10.1 Application/provider tests

Cover:

- repository/path resolution
- GitHub target-file read
- GitLab target-file read
- create preview
- update preview
- no-change preview
- non-ASCII content
- preview performs no remote mutation
- preview performs no Candidate state mutation

### 10.2 API tests

Cover:

- Admin authentication required
- Candidate not found
- successful pending Candidate preview
- target resolution failure
- remote target read failure
- existing `/preview` endpoint remains unchanged

### 10.3 Admin UI tests

Cover:

- pending Candidate renders a collapsed **查看变更 Diff** control
- opening the Candidate detail page does not call `/diff`
- clicking **查看变更 Diff** calls `/diff` once and expands the result inline
- collapsing the Diff does not require another remote read; re-expanding may reuse the already loaded result for that page instance
- added/removed lines are escaped and styled correctly
- preview failure does not hide approval controls
- non-pending Candidate does not call `/diff`
- publishing/published states still show publication PR/MR link
- deletion states still show deletion PR/MR link

## 11. Expected implementation scope

Likely files:

- `src/admin-ui.ts`
- `src/application.ts`
- `src/knowledge-publishing.ts`
- `src/server.ts`
- related publishing/Admin tests
- `package.json` / lock file only if a Diff dependency is added

No changes should be required to:

- Candidate persistence model
- Review Center list projection
- Skill Bundle workflow
- publication/deletion state machines

## 12. Acceptance criteria

The feature is complete when:

1. A `pending` Candidate detail page shows a collapsed **查看变更 Diff** control before approval.
2. The Diff is not fetched or rendered until the reviewer clicks that control, then it expands inline on the same page.
3. The preview clearly shows repository, target branch, path, create/update/no-change state, and added/removed counts.
4. Preview reads the current target branch and performs no remote or Candidate mutation.
5. Approval and rejection continue to work even if preview fails.
6. After approval, Team Skill Hub stops showing its own Candidate Diff preview.
7. After publish, the existing publication PR/MR link is the review surface for the actual publication Diff.
8. After delete publication is created, the existing deletion PR/MR link is the review surface for the actual deletion Diff.
9. Existing Candidate publishing and deletion behavior remains unchanged.
10. Existing semantic `/preview` behavior remains backward-compatible.
11. GitHub and GitLab preview paths have focused tests.

## 13. Future extensions

Only add these if later needed:

- require Diff success before approval
- freeze the approved Diff baseline
- stale-preview detection
- side-by-side Diff rendering
- Skill Bundle per-file line Diff

They are deliberately excluded from this change.