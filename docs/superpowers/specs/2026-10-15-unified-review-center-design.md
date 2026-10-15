# Unified Review Center Design

Date: 2026-10-15
Status: Proposed

## 1. Background

Team Skill Hub currently exposes two independent review experiences:

1. Knowledge / legacy Skill Candidate review under `/admin/review` and `/admin/review/candidates`.
2. Skill Bundle review under `/admin/skill-bundles`.

The business workflows are both valid, but the UI split makes review discovery confusing. An administrator can see pending `kc_*` candidate records in the Candidate Review page while a pending `sbi_*` Skill Bundle import is hidden in a different module. The status-card landing page also creates many route-specific entry points even though most of them ultimately show the same type of filtered list.

This design unifies review discovery and list navigation without forcing the underlying Candidate and Skill Bundle state machines into one persistence model.

## 2. Goals

- Provide one Admin review center for all reviewable content.
- Show Knowledge Candidate, legacy Skill Candidate, and Skill Bundle records in one server-side paginated list.
- Preserve the current status categories as quick-entry cards.
- Make status categories filters on one list rather than separate list implementations.
- Keep type-specific details and actions where the business semantics differ.
- Preserve existing Candidate and Skill Bundle workflow/state logic.
- Keep Skill Bundle import/creation as a separate creation workflow, while routing created imports into the unified review center.
- Preserve old Admin URLs through redirect or compatibility routes.
- Make future reviewable artifact types easier to add without creating another parallel review UI.

## 3. Non-goals

- Do not merge Candidate and Skill Bundle database tables.
- Do not rewrite Candidate or Skill Bundle publication state machines.
- Do not make all detail pages visually identical when the underlying data differs.
- Do not change repository publication semantics, PR/MR creation behavior, or approval requirements.
- Do not remove abnormal states such as `review_stale`, `published_drifted`, `deleting`, or `delete_failed` merely to simplify the UI.

## 4. UX model

### 4.1 Review center landing page

`/admin/review` becomes the unified **内容审核 / Review Center** landing page.

The existing status cards remain because they are useful shortcuts and at-a-glance workflow categories. They no longer represent separate list implementations.

Recommended cards:

- 待审核 / Pending
- 已批准 / Approved
- 等待合并 / Publishing
- 已拒绝 / Rejected
- 发布失败 / Publish failed
- 已发布 / Published
- 等待删除合并 / Deleting
- 删除失败 / Delete failed
- 已删除 / Deleted
- 审核已过期 / Review stale
- 发布内容漂移 / Published drifted
- 历史记录 / History

Each status card links to the same list route with a filter, for example:

```text
/admin/review/items?status=pending
/admin/review/items?status=published
/admin/review/items?status=review_stale
```

The landing page may show counts per status when the summary API can provide them cheaply. A count failure must not block navigation.

### 4.2 Unified review list

Canonical list route:

```text
/admin/review/items
```

Default behavior with no status parameter: show all reviewable items the current Admin can access, newest first.

Filters:

- Keyword
- Status
- Item kind
  - Candidate
  - Skill Bundle
- Content type
  - Knowledge Candidate
  - Legacy Skill Candidate
  - Skill Bundle / Skill
  - Skill Bundle / Collection
- Repository
- Source type
- Reviewer
- Submitter / Actor
- Namespace / Skill collection
- Import type (`skill` / `collection`) where applicable
- Page size

Recommended columns:

- 操作 / Action
- ID
- 标题 / Namespace
- 类型 / Type
- 状态 / Status
- 来源 / Source
- 仓库 / Repository
- 提交人 / Submitter
- 审核人 / Reviewer
- 更新时间 / Updated
- PR/MR

Type-specific data that does not fit naturally in the list stays in the detail page.

### 4.3 Unified details, type-specific rendering

The list is unified; the domain models are not.

Canonical detail routes:

```text
/admin/review/items/candidate/:id
/admin/review/items/skill-bundle/:id
```

Candidate details keep current content-oriented fields:

- title
- candidate content
- source type
- suggested type
- suggested path
- reviewer / review reason
- publication and deletion publication state

Skill Bundle details keep bundle-oriented fields:

- namespace
- import type
- repository
- replacement root
- snapshot SHA
- Skill count
- file count
- total bytes
- review baseline
- diff summary
- PR/MR
- drift information when applicable

The action toolbar is resolved by type and status.

### 4.4 Skill Bundle import remains a creation flow

`/admin/skill-bundles` remains available for **creating/importing** a Skill Bundle.

After a successful import, the UI should navigate directly to:

```text
/admin/review/items/skill-bundle/<import-id>
```

The old Skill Bundle Pending/History list UI should no longer be the primary review surface. It may be removed, or retained temporarily as a compatibility page that links/redirects into the Review Center.

## 5. Unified server-side review model

The browser must not fetch Candidate and Skill Bundle lists separately and merge them client-side. Client-side merging would make global sorting, pagination, status counts, and filter semantics unreliable.

Introduce a lightweight server projection:

```ts
type ReviewItemKind = "candidate" | "skill-bundle";

type ReviewContentType =
  | "knowledge"
  | "legacy-skill"
  | "skill-bundle-skill"
  | "skill-bundle-collection";

interface ReviewItem {
  kind: ReviewItemKind;
  id: string;
  title: string;
  contentType: ReviewContentType;
  status: string;
  statusGroup: ReviewStatusGroup;
  sourceType?: string;
  repository?: string;
  namespace?: string;
  skillCollection?: string;
  importType?: "skill" | "collection";
  submitter?: string;
  reviewer?: string;
  updatedAt: string;
  publication?: {
    provider?: string;
    mergeRequestIid?: number;
    mergeRequestUrl?: string;
    mergeRequestState?: string;
  };
}
```

This is an Admin read model only. It is not a replacement persistence model.

Candidate mapping:

- `kind = candidate`
- `title = candidate.title`
- `contentType = knowledge` when `suggestedType=knowledge`
- `contentType = legacy-skill` when `suggestedType=skill`
- `submitter = actorId` when available

Skill Bundle mapping:

- `kind = skill-bundle`
- `title = namespace` or a more descriptive derived title when available
- `contentType = skill-bundle-skill` for `importType=skill`
- `contentType = skill-bundle-collection` for `importType=collection`
- `submitter = record.submitter`

## 6. Status model

### 6.1 Principle

Do not force Candidate and Skill Bundle domain states into one stored enum.

The unified UI uses two concepts:

1. `status`: original underlying state, preserved exactly.
2. `statusGroup`: normalized UI grouping for list filtering and cards.

Recommended normalized groups:

```ts
type ReviewStatusGroup =
  | "pending"
  | "approved"
  | "publishing"
  | "rejected"
  | "publish_failed"
  | "published"
  | "deleting"
  | "delete_failed"
  | "deleted"
  | "review_stale"
  | "published_drifted";
```

Mapping is intentionally mostly one-to-one today. The abstraction exists so future artifact types can map different internal names into the same Admin category without changing their business state machines.

### 6.2 Type-specific availability

Not every state applies to every type.

Candidate-specific states include:

- deleting
- delete_failed
- deleted

Skill Bundle-specific states include:

- review_stale
- published_drifted

The filter should still show the full set of supported status groups. Selecting a type-inapplicable state simply returns zero items for that type.

## 7. APIs

### 7.1 Review summary

```text
GET /admin/api/review-summary
```

Response example:

```json
{
  "counts": {
    "pending": 12,
    "approved": 3,
    "publishing": 2,
    "rejected": 8,
    "publish_failed": 1,
    "published": 45,
    "deleting": 0,
    "delete_failed": 0,
    "deleted": 4,
    "review_stale": 1,
    "published_drifted": 0
  },
  "total": 76
}
```

Counts include all review item kinds unless a future query parameter explicitly narrows them.

### 7.2 Unified review list

```text
GET /admin/api/review-items
```

Query parameters:

- `q`
- `status`
- `kind`
- `type`
- `repository`
- `sourceType`
- `reviewer`
- `submitter`
- `namespace`
- `skillCollection`
- `importType`
- `limit`
- `cursor`

Response:

```json
{
  "items": [],
  "page": {
    "total": 0,
    "limit": 20,
    "cursor": "...",
    "nextCursor": null,
    "previousCursor": null
  }
}
```

### 7.3 Detail lookup

The existing Candidate and Skill Bundle detail APIs remain valid and should remain the source of type-specific detail data.

The UI may call the existing endpoints after routing by item kind:

```text
GET /admin/api/knowledge-candidates/:id
GET /admin/api/skill-bundles/:id
```

A generic detail API is optional and not required for this refactor.

### 7.4 Actions

Do not create a generic catch-all mutation endpoint in this phase.

Candidate actions continue to use Candidate endpoints.

Skill Bundle actions continue to use Skill Bundle endpoints.

This keeps authorization, validation, idempotency, and workflow semantics in the existing domain services.

## 8. Server-side pagination and ordering

The unified list must provide globally correct ordering and pagination across both sources.

Recommended implementation:

1. Parse the unified cursor into a global offset (the current Admin UI already uses bounded offset-style pagination, so v1 does not need a new keyset cursor format).
2. Push source-specific filters down into the Candidate and Skill Bundle queries where possible.
3. Request enough rows from **each** source to cover at least `globalOffset + limit` matching rows, paging the source internally when filtering causes sparse matches; stop when the required bound is satisfied or the source is exhausted.
4. Project both sources into `ReviewItem`.
5. Apply remaining common filters.
6. Sort globally by `updatedAt DESC`, then by `kind`, then `id` for deterministic tie-breaking.
7. Slice `[globalOffset, globalOffset + limit)` only **after** the global merge and sort.
8. Return one opaque Admin cursor representing the next/previous global offset.

A single page from each source is explicitly insufficient because it can skip rows after the cross-source sort. The application-layer query must therefore obtain enough bounded source rows for the requested global window. It must still enforce a configured maximum scan bound and fail clearly rather than performing an unbounded scan.

## 9. Admin UI routing and compatibility

Canonical routes after this change:

```text
/admin/review
/admin/review/items
/admin/review/items/candidate/:id
/admin/review/items/skill-bundle/:id
/admin/review/history
/admin/skill-bundles               # import/create flow
```

Compatibility behavior:

- `/admin/review/candidates?...` -> redirect to `/admin/review/items?...&kind=candidate`, preserving the old route's Candidate-only semantics and all supported filters.
- `/admin/review/candidates/:id` -> redirect to `/admin/review/items/candidate/:id`.
- `/admin/review/candidates/:id/history` -> redirect or render the candidate history subview under the new detail shell.
- Existing `/admin/skill-bundles` remains valid for import creation.

Old deep links should not become 404s.

## 10. History

History remains type-specific in storage.

The Review Center should provide:

```text
/admin/review/history
```

The initial implementation may support unified history by projecting Candidate history and Skill Bundle history into a lightweight common history row:

- timestamp
- item kind
- item id
- title/namespace
- state
- reviewer
- reason/note

If global cross-source history pagination is too large for the first implementation, the acceptable minimum is:

- retain Candidate history behavior,
- add Skill Bundle history access from Bundle detail,
- expose a type selector on the history page,
- avoid pretending the two sources are globally ordered unless the server can guarantee that ordering.

## 11. Status cards and filters

Status cards are shortcuts, not separate modules.

The selected card should be reflected in the list URL and status filter control. Changing the status filter should produce the same result as clicking the equivalent card.

The Review Center landing page should also provide a clear **全部审核项 / View all** action.

Where useful, cards can display counts from `review-summary`.

## 12. Admin navigation

Rename the Admin entry from `候选审核` to `内容审核` or `审核中心`.

Recommended top-level Admin entries:

- 审核中心
- Skill Bundle 导入
- 知识缺口
- 仓库治理
- 运行观测

The distinction is intentional:

- **审核中心** = review existing submitted content.
- **Skill Bundle 导入** = create/import a new Skill Bundle.

## 13. Security and authorization

- All new Admin review endpoints use the same `hasAdminAccess()` gate as current Admin endpoints.
- Unified projection must not expose secrets or raw authentication metadata.
- Publication URLs must continue to be validated before rendering external links.
- Existing Candidate and Skill Bundle mutation endpoints remain authoritative for actions.
- The unified list does not grant new write capabilities; it only improves discovery/navigation.

## 14. Error handling

- Failure to load review summary counts must not block opening the review list.
- List API errors should be shown inline, preserving filter controls so the administrator can retry.
- If an item is deleted or becomes inaccessible between list and detail navigation, show a clear not-found message and a link back to the current filtered list.
- Type-specific action failures should remain on the detail page and retain the action context.

## 15. Migration plan

1. Add server-side ReviewItem projection and unified list/summary APIs.
2. Add tests for mapping, filters, global ordering, pagination, and status counts.
3. Replace `/admin/review` card links so they target `/admin/review/items?status=...`.
4. Implement unified list UI.
5. Move Candidate detail into the new review detail shell while reusing existing APIs/actions.
6. Move Skill Bundle detail into the new review detail shell while reusing existing APIs/actions.
7. Make Skill Bundle import completion navigate to the unified Bundle detail route.
8. Add compatibility redirects for old Candidate routes and any retired Skill Bundle review list routes.
9. Add/adjust Admin UI tests and end-to-end workflow tests.
10. Remove duplicate list rendering only after compatibility routes and tests are in place.

## 16. Testing strategy

### 16.1 Service/API tests

- Candidate maps to the expected `ReviewItem`.
- Legacy Skill Candidate maps to `legacy-skill`.
- Skill Bundle `skill` maps to `skill-bundle-skill`.
- Skill Bundle `collection` maps to `skill-bundle-collection`.
- Mixed Candidate/Bundle results are globally sorted by `updatedAt`.
- Status filtering works across both sources.
- Kind filtering isolates Candidate vs Skill Bundle sources correctly.
- Content-type filtering isolates Knowledge, legacy Skill Candidate, Bundle Skill, and Bundle Collection correctly.
- Repository, reviewer, submitter, namespace, collection, and import type filters behave correctly.
- Pagination never duplicates or skips rows across mixed types for a stable dataset.
- Summary counts match the unified list dataset.
- Admin authorization remains required.

### 16.2 UI tests

- Clicking each status card opens the same unified list route with the expected filter.
- Changing the status dropdown matches the corresponding card result.
- `superpowers` Skill Bundle appears in Pending beside pending Candidate records.
- Kind filter can show only Candidate or Skill Bundle.
- Content-type filter can show only Knowledge, legacy Skill Candidate, Bundle Skill, or Bundle Collection.
- Candidate row opens Candidate detail/actions.
- Skill Bundle row opens Bundle detail/actions.
- Skill Bundle import success navigates to unified review detail.
- Existing deep links redirect correctly.
- PR/MR links are rendered only for valid HTTP(S) URLs.

### 16.3 Regression tests

- Existing Candidate approve/reject/publish/reconcile/delete flows continue to pass.
- Existing Skill Bundle approve/reject/publish/reconcile/reimport flows continue to pass.
- Bundle import flow is unchanged except for post-create navigation.
- Candidate and Bundle history remain accessible.

## 17. Acceptance criteria

The redesign is complete when:

1. An Admin can open one Review Center and see both `kc_*` and `sbi_*` review items.
2. The existing status categories remain visible as shortcuts.
3. Every category opens the same review list with a status filter rather than a separate list implementation.
4. The unified list supports server-side filtering, deterministic sorting, and pagination.
5. Candidate and Skill Bundle detail/actions continue to use their existing domain services.
6. A newly submitted Skill Bundle appears in the same Pending review list as pending Candidates.
7. Old Admin review deep links remain usable through redirects/compatibility routing.
8. Existing Candidate and Skill Bundle business state machines are unchanged.

## 18. Recommended implementation boundary

This refactor should unify the **review presentation and query layer**, not the underlying workflow storage.

That boundary provides the main usability benefit while minimizing migration and publication risk. It also creates a reusable ReviewItem projection that can later incorporate additional reviewable artifact types without introducing another parallel Admin review module.
