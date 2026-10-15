# Unified Review Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one Admin review center that shows Knowledge Candidates, legacy Skill Candidates, and Skill Bundle imports in a single server-side filtered/paginated list while preserving each domain's existing detail/actions.

**Architecture:** Add an application-layer `ReviewItem` projection and unified query/summary methods, expose them through new Admin endpoints, then replace the review module's duplicated status-specific navigation with one list route and type-aware detail shell. Candidate and Skill Bundle persistence and mutation endpoints remain unchanged; compatibility routes preserve old deep links.

**Tech Stack:** TypeScript 5.9, Node.js 24+, Fastify 5, built-in `node:test`, current static Admin HTML/JavaScript in `src/admin-ui.ts`.

**Spec:** `docs/superpowers/specs/2026-10-15-unified-review-center-design.md`

## Global Constraints

- Do not merge Candidate and Skill Bundle persistence tables.
- Do not rewrite Candidate or Skill Bundle publication state machines.
- Keep `/admin/skill-bundles` as the Skill Bundle import/create flow.
- A successful Skill Bundle import must navigate to `/admin/review/items/skill-bundle/<import-id>`.
- The unified list must sort globally by `updatedAt DESC`, with deterministic tie-breakers.
- Global pagination must happen after Candidate/Bundle merge and sort; one page from each source is explicitly insufficient.
- Unified source scans must remain bounded and fail clearly rather than becoming unbounded.
- Existing Candidate and Skill Bundle mutation endpoints remain authoritative.
- All new Admin review endpoints must use the existing `hasAdminAccess()` authorization gate.
- Old `/admin/review/candidates...` deep links must remain usable and retain Candidate-only semantics.

## Review Focus

- Mixed-source pagination around the page boundary: no duplicate or skipped `kc_*` / `sbi_*` rows when timestamps interleave.
- Sparse filtering: repository/type/status filters may require fetching additional bounded source rows before the global page is full.
- Malformed/unknown filter values: return a bounded empty/400 result consistently rather than widening access or scanning indefinitely.
- Deleted/stale records between list and detail navigation: show a clear not-found state and preserve a safe return path.
- External PR/MR links: render only validated HTTP(S) URLs; malformed publication data must not become executable links.

---

## File Structure

- Create `src/review-center.ts`: pure unified review types, Candidate/Bundle projection, filtering, ordering, summary, bounded pagination helpers.
- Modify `src/application.ts`: gather source rows/snapshots and expose `adminReviewItemsPage()` / `adminReviewSummary()` without changing domain mutations.
- Modify `src/server.ts`: add `/admin/api/review-items` and `/admin/api/review-summary`; keep existing detail/action APIs intact.
- Modify `src/admin-routes.ts`: recognize canonical unified review routes and compatibility Candidate routes.
- Modify `src/admin-ui.ts`: render unified status cards, filters/list, Candidate and Bundle detail shells, and post-import navigation.
- Create `tests/review-center.test.ts`: pure projection/filter/sort/pagination tests.
- Modify `tests/admin-routes.test.ts`: canonical + compatibility route parsing tests.
- Modify `tests/admin-ui-structure.test.ts`: unified review UI structure and links.
- Modify `tests/skill-bundle-admin-ui.test.ts`: import-only page and redirect target assertions.
- Create `tests/review-center-e2e.test.ts`: unified Admin API list/summary authorization and mixed-source behavior.
- Modify `tests/skill-bundle-entrypoints-e2e.test.ts`: preserve Bundle import/action endpoints and verify unified post-create integration contract where applicable.
- Re-run `tests/admin-candidate-actions-e2e.test.ts`: regression coverage for Candidate mutations.

### Task 1: Pure ReviewItem projection, filtering, ordering, and bounded paging

**Files:**
- Create: `src/review-center.ts`
- Create: `tests/review-center.test.ts`

**Interfaces:**
- Consumes: Candidate records from `McpObservabilityStore`/`listKnowledgeCandidates`, Skill Bundle imports plus optional snapshot counts.
- Produces:
  - `type ReviewItemKind = "candidate" | "skill-bundle"`
  - `type ReviewContentType = "knowledge" | "legacy-skill" | "skill-bundle-skill" | "skill-bundle-collection"`
  - `type ReviewStatusGroup = "pending" | "approved" | "publishing" | "rejected" | "publish_failed" | "published" | "deleting" | "delete_failed" | "deleted" | "review_stale" | "published_drifted"`
  - `interface ReviewItem`
  - `interface ReviewItemsQuery`
  - `projectCandidateReviewItem(candidate): ReviewItem`
  - `projectSkillBundleReviewItem(record, snapshotSummary?): ReviewItem`
  - `filterReviewItems(items, query): ReviewItem[]`
  - `sortReviewItems(items): ReviewItem[]`
  - `paginateReviewItems(items, query): { items: ReviewItem[]; page: ... }`
  - `summarizeReviewItems(items): { counts: Record<ReviewStatusGroup, number>; total: number }`

- [ ] **Step 1: Write failing projection tests**

Add tests named:

```ts
test("candidate projection distinguishes knowledge and legacy skill", ...)
test("skill bundle projection distinguishes skill and collection", ...)
test("review projection preserves original status and normalized status group", ...)
```

Assert exact `kind`, `contentType`, `title`, `repository`, `submitter`, `namespace`, `importType`, and publication URL mapping from representative records.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --import tsx --test tests/review-center.test.ts
```

Expected: FAIL because `src/review-center.ts` / projection functions do not exist.

- [ ] **Step 3: Implement the projection types and functions**

Implement the exported signatures above in `src/review-center.ts`. Keep functions pure; do not read storage from this file.

- [ ] **Step 4: Add failing mixed filter/sort tests**

Add tests for:

```ts
test("mixed review items filter by kind content type status repository and namespace", ...)
test("review items sort by updatedAt desc then kind then id", ...)
test("unknown filter value does not widen results", ...)
```

The unknown `kind`, `type`, or `status` query must produce no matches (or be rejected by the caller later), never silently behave as `all`.

- [ ] **Step 5: Implement filtering and deterministic sort**

`filterReviewItems()` supports `q`, `status`, `kind`, `type`, `repository`, `sourceType`, `reviewer`, `submitter`, `namespace`, `skillCollection`, and `importType`. `sortReviewItems()` uses `updatedAt DESC`, then `kind`, then `id`.

- [ ] **Step 6: Add failing paging/summary boundary tests**

Add assertions that an interleaved 6-row Candidate/Bundle dataset with `limit=2` yields exact pages `[0..1]`, `[2..3]`, `[4..5]` with no duplicates, and that summary counts include Bundle-only states (`review_stale`, `published_drifted`) and Candidate-only states (`deleting`, `deleted`).

- [ ] **Step 7: Implement `paginateReviewItems()` and `summarizeReviewItems()`**

Use the current Admin offset cursor semantics: normalize invalid/negative cursor to `0`, cap limit to 100, expose `nextCursor`/`previousCursor` only when valid.

- [ ] **Step 8: Run Task 1 tests**

Run:

```bash
node --import tsx --test tests/review-center.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/review-center.ts tests/review-center.test.ts
git commit -m "feat: add unified review item projection"
```

### Task 2: Application-layer unified source gathering and correct global pagination

**Files:**
- Modify: `src/application.ts:2013,3267-3282,3385+`
- Modify: `src/review-center.ts`
- Modify: `tests/review-center.test.ts`

**Interfaces:**
- Consumes: Task 1 projection/filter/sort/paging helpers; `this.observability.adminCandidatesPage(...)` / bounded candidate listing; `this.skillBundles.listImportsPage(...)` / bounded bundle listing; `getSnapshot()`.
- Produces:
  - `adminReviewItemsPage(query: ReviewItemsQuery): Promise<{ items: ReviewItem[]; page: ReviewPage }>`
  - `adminReviewSummary(): Promise<{ counts: Record<ReviewStatusGroup, number>; total: number }>`
  - bounded internal source collector with an explicit max scan constant, e.g. `ADMIN_REVIEW_MAX_SOURCE_ROWS`.

- [ ] **Step 1: Write failing source-window tests**

Extend `tests/review-center.test.ts` with an exported helper test (or a small application fixture test) that proves a single-page-per-source merge would be wrong: Candidate timestamps and Bundle timestamps interleave such that the second global page requires rows beyond one source's first page.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test tests/review-center.test.ts
```

Expected: FAIL because the bounded source collector/application methods do not exist.

- [ ] **Step 3: Implement `SkillHubApplicationService.adminReviewItemsPage()`**

Signature:

```ts
async adminReviewItemsPage(query: ReviewItemsQuery): Promise<{
  items: ReviewItem[];
  page: ReviewPage;
}>
```

Resolve `limit` and global offset first. Fetch enough bounded rows from both sources to cover `offset + limit` matching rows after projection/filtering; when a source page is sparse after filters, continue paging that source until the target window is satisfiable, the source is exhausted, or `ADMIN_REVIEW_MAX_SOURCE_ROWS` is reached. Merge, sort globally, then slice the requested window.

- [ ] **Step 4: Add scan-bound failure test**

Test that a filter producing no matches across a synthetic source larger than the configured max scan returns/throws a specific bounded-scan error instead of continuing indefinitely.

- [ ] **Step 5: Implement scan-bound enforcement**

Use one explicit error message such as `Admin review query exceeded bounded source scan`; server mapping in Task 3 will return HTTP 400.

- [ ] **Step 6: Implement `adminReviewSummary()`**

Use bounded complete review sources suitable for the current Admin dataset and `summarizeReviewItems()`. If complete summary cannot be obtained within the configured bound, return the same explicit bounded-scan error; do not report partial counts as complete.

- [ ] **Step 7: Run Task 1/2 focused tests**

Run:

```bash
node --import tsx --test tests/review-center.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/application.ts src/review-center.ts tests/review-center.test.ts
git commit -m "feat: query unified review items"
```

### Task 3: Admin review APIs and authorization

**Files:**
- Modify: `src/server.ts:1144-1274` (place unified review endpoints adjacent to existing Candidate/Bundle Admin APIs)
- Create: `tests/review-center-e2e.test.ts`

**Interfaces:**
- Consumes: `service.adminReviewItemsPage(query)` and `service.adminReviewSummary()` from Task 2.
- Produces:
  - `GET /admin/api/review-items`
  - `GET /admin/api/review-summary`

- [ ] **Step 1: Write failing HTTP authorization/list tests**

Create `tests/review-center-e2e.test.ts` with the existing temporary-service fixture pattern. Assert:

```ts
GET /admin/api/review-items              -> 403 without admin access
GET /admin/api/review-summary            -> 403 without admin access
GET /admin/api/review-items?status=pending -> 200 with admin access
```

Stub `adminReviewItemsPage` with one `kc_*` and one `sbi_*` row and assert both are returned in `items`.

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --import tsx --test tests/review-center-e2e.test.ts
```

Expected: FAIL/404 because the endpoints do not exist.

- [ ] **Step 3: Add the two Fastify routes**

`GET /admin/api/review-items` forwards the supported query keys and returns `{ items, page }`. `GET /admin/api/review-summary` returns `{ counts, total }`. Both call `hasAdminAccess()` before service work.

- [ ] **Step 4: Add failing invalid/bounded-scan tests**

Assert an unsupported `kind/type/status` or the Task 2 bounded-scan error maps to HTTP 400 with a clear `error` string, while authorization remains 403.

- [ ] **Step 5: Implement query validation/error mapping**

Validate enum-like values before invoking the service. Do not silently drop malformed filters.

- [ ] **Step 6: Add mixed ordering/filter HTTP assertions**

Assert `kind=candidate` returns only Candidate rows, `kind=skill-bundle` only Bundle rows, and a pending response preserves service-level mixed global order.

- [ ] **Step 7: Run Task 3 tests**

Run:

```bash
node --import tsx --test tests/review-center-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts tests/review-center-e2e.test.ts
git commit -m "feat: expose unified review admin APIs"
```

### Task 4: Canonical unified Admin routes and compatibility deep links

**Files:**
- Modify: `src/admin-routes.ts:1-55`
- Modify: `tests/admin-routes.test.ts:14-33,78-90`

**Interfaces:**
- Consumes: spec canonical routes.
- Produces route parsing for:
  - `/admin/review`
  - `/admin/review/items`
  - `/admin/review/items/candidate/:id`
  - `/admin/review/items/skill-bundle/:id`
  - `/admin/review/history`
  - legacy `/admin/review/candidates...` compatibility recognition.

- [ ] **Step 1: Add failing canonical route tests**

Assert exact `parseAdminRoute()` results for unified list and both detail kinds, including percent-encoded IDs and malformed encodings.

- [ ] **Step 2: Add failing compatibility tests**

Assert `/admin/review/candidates?status=pending` remains recognizable as a Candidate-only compatibility route and `/admin/review/candidates/:id/history` remains routable.

- [ ] **Step 3: Run and verify failure**

Run:

```bash
node --import tsx --test tests/admin-routes.test.ts
```

Expected: FAIL on new unified paths.

- [ ] **Step 4: Extend `AdminRoute` and `parseAdminRoute()`**

Represent unified review item list/detail kinds explicitly enough that `admin-ui.ts` can distinguish Candidate vs Skill Bundle without guessing from ID prefixes. Preserve current generic module parsing for gaps/governance.

- [ ] **Step 5: Add safe return-path regression assertion**

Verify a return path under `/admin/review/items?...` is accepted when `/admin/review/` is the allowed prefix and an external origin remains rejected.

- [ ] **Step 6: Run Task 4 tests**

Run:

```bash
node --import tsx --test tests/admin-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin-routes.ts tests/admin-routes.test.ts
git commit -m "feat: route unified review center"
```

### Task 5: Unified review landing page and list UI

**Files:**
- Modify: `src/admin-ui.ts:25-26,943-1007`
- Modify: `tests/admin-ui-structure.test.ts:32-165`

**Interfaces:**
- Consumes: `GET /admin/api/review-summary`, `GET /admin/api/review-items`, canonical routes from Task 4.
- Produces:
  - `/admin/review` status-card landing page labeled `审核中心` or `内容审核`
  - `/admin/review/items` one reusable filtered list
  - status cards that link to `/admin/review/items?status=<group>`
  - list row links to `/admin/review/items/<kind>/<id>`.

- [ ] **Step 1: Rewrite UI structure tests first**

Change the module-index expectations from `/admin/review/candidates?status=...` to `/admin/review/items?status=...`. Add assertions for `全部审核项`, `审核已过期`, `发布内容漂移`, and the `/admin/api/review-summary` endpoint.

- [ ] **Step 2: Add failing unified filter/list assertions**

Require `ADMIN_MODULE_HTML` to contain controls for `状态`, `内容类型`, `Item Kind`, `仓库`, `来源类型`, `审核人`, `提交人`, `Namespace / Skill 分类`, `Import Type`, page size, and `/admin/api/review-items`.

- [ ] **Step 3: Run structure tests and verify failure**

Run:

```bash
node --import tsx --test tests/admin-ui-structure.test.ts
```

Expected: FAIL because the current module index/list is Candidate-only.

- [ ] **Step 4: Replace review status-card links with unified list links**

Keep the visual category cards, but every workflow card routes to `/admin/review/items?status=...`; add a `全部审核项` route. Load counts asynchronously from `/admin/api/review-summary`; count-load errors must leave links usable.

- [ ] **Step 5: Implement one review-list renderer**

When route is `/admin/review/items`, render the unified filters and table columns:

```text
操作 | ID | 标题/Namespace | 类型 | 状态 | 来源 | 仓库 | 提交人 | 审核人 | 更新时间 | PR/MR
```

Use the API `page.nextCursor/previousCursor`; changing filters updates the URL query. Candidate compatibility routes inject `kind=candidate` before loading this same list.

- [ ] **Step 6: Add PR/MR link safety test**

In `tests/admin-ui-structure.test.ts`, require use of the existing HTTP(S)-only external URL helper for unified list/detail publication links and assert no raw `javascript:` publication URL is rendered as a link.

- [ ] **Step 7: Run Task 5 tests**

Run:

```bash
node --import tsx --test tests/admin-ui-structure.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/admin-ui.ts tests/admin-ui-structure.test.ts
git commit -m "feat: unify review inbox UI"
```

### Task 6: Type-aware Candidate and Skill Bundle detail shell

**Files:**
- Modify: `src/admin-ui.ts:980-1007` and current `ADMIN_SKILL_BUNDLES_HTML` detail logic
- Modify: `tests/admin-ui-structure.test.ts`
- Modify: `tests/skill-bundle-admin-ui.test.ts`

**Interfaces:**
- Consumes existing detail/action APIs:
  - Candidate: `/admin/api/knowledge-candidates/:id` and current review/publish/reconcile/delete endpoints.
  - Bundle: `/admin/api/skill-bundles/:id`, `/:id/preview`, `/:id/history`, and approve/reject/publish/reconcile/reimport endpoints.
- Produces canonical detail UI routes:
  - `/admin/review/items/candidate/:id`
  - `/admin/review/items/skill-bundle/:id`

- [ ] **Step 1: Add failing Candidate detail-route assertions**

Update existing Candidate detail tests to expect the unified detail shell and `返回审核列表`, while preserving all existing action labels and endpoints.

- [ ] **Step 2: Add failing Bundle detail assertions**

Require unified Bundle detail rendering to include `Namespace`, `Import Type`, `Replacement Root`, `Snapshot`, `Skill`, `Files`, preview diff, status, reviewer, PR/MR, and the existing Bundle action labels.

- [ ] **Step 3: Run the two UI test files and verify failure**

Run:

```bash
node --import tsx --test tests/admin-ui-structure.test.ts tests/skill-bundle-admin-ui.test.ts
```

Expected: FAIL because Bundle review detail still lives only inside `/admin/skill-bundles`.

- [ ] **Step 4: Move Candidate detail rendering under the unified route shell**

Reuse current `candidateDetailBody`, history rendering, and action functions. Preserve safe `return` query behavior so a user returns to their exact filtered unified list.

- [ ] **Step 5: Add Bundle detail renderer under the unified route shell**

Fetch the existing Bundle detail + preview endpoints. Resolve action buttons by Bundle status exactly as current `actionsFor()` does; do not create new mutation semantics.

- [ ] **Step 6: Add stale/deleted detail failure behavior**

Tests should require a not-found/error message plus a link back to the safe filtered review list when either Candidate or Bundle detail fetch returns 404.

- [ ] **Step 7: Reduce `/admin/skill-bundles` to import/create primary UI**

Keep import source fields, preview, target path, and create action. Remove Pending/History as the primary review surface (or retain only compatibility links into the unified Review Center).

- [ ] **Step 8: Run Task 6 tests**

Run:

```bash
node --import tsx --test tests/admin-ui-structure.test.ts tests/skill-bundle-admin-ui.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/admin-ui.ts tests/admin-ui-structure.test.ts tests/skill-bundle-admin-ui.test.ts
git commit -m "feat: unify review item details"
```

### Task 7: Unified review history access

**Files:**
- Modify: `src/admin-ui.ts` (review history route/view)
- Modify: `src/server.ts` only if a small Admin history projection endpoint is required
- Modify: `src/application.ts` only if server-side cross-source history projection is implemented
- Modify: `tests/admin-ui-structure.test.ts`
- Modify/Create: history-focused coverage adjacent to `tests/review-center-e2e.test.ts`

**Interfaces:**
- Consumes: existing Candidate history API and Skill Bundle history API.
- Produces: `/admin/review/history` with a type selector and access to both Candidate and Bundle history; it must not claim globally ordered mixed history unless the server guarantees it.

- [ ] **Step 1: Add failing history UI assertions**

Require `/admin/review/history` to expose a type selector with Candidate and Skill Bundle options, and require Bundle history access from the unified Bundle detail shell.

- [ ] **Step 2: Run focused history/UI tests and verify failure**

Run:

```bash
node --import tsx --test tests/admin-ui-structure.test.ts tests/review-center-e2e.test.ts
```

Expected: FAIL because the current global history page only queries Candidate history.

- [ ] **Step 3: Implement the minimum truthful unified history behavior**

Use the spec's acceptable minimum: preserve Candidate history, expose Skill Bundle history from Bundle detail, and add a type selector on `/admin/review/history`. If a mixed server-side history endpoint is added, it must globally sort and paginate correctly; otherwise render one selected source at a time and label it accordingly.

- [ ] **Step 4: Add history not-found and safe-return tests**

Assert missing Candidate/Bundle history gives a clear empty/not-found state and the return link stays within `/admin/review/`.

- [ ] **Step 5: Run Task 7 tests**

Run:

```bash
node --import tsx --test tests/admin-ui-structure.test.ts tests/review-center-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin-ui.ts src/server.ts src/application.ts tests/admin-ui-structure.test.ts tests/review-center-e2e.test.ts
git commit -m "feat: expose unified review history"
```

Skip unchanged paths in the `git add` command.

### Task 8: Skill Bundle import handoff and compatibility redirects

**Files:**
- Modify: `src/admin-ui.ts` (`createImport()` and compatibility routing)
- Modify: `tests/skill-bundle-admin-ui.test.ts`
- Modify: `tests/skill-bundle-entrypoints-e2e.test.ts`
- Modify: `tests/admin-ui-structure.test.ts`

**Interfaces:**
- Consumes: successful import response `{ import: { id } }`.
- Produces: browser navigation to `/admin/review/items/skill-bundle/<id>` after import; old Candidate deep links normalize into canonical unified routes without losing filters.

- [ ] **Step 1: Add failing import-handoff assertion**

Require `ADMIN_SKILL_BUNDLES_HTML` `createImport()` success path to assign/navigate to `/admin/review/items/skill-bundle/` plus encoded import ID instead of opening the legacy local Bundle detail panel.

- [ ] **Step 2: Add compatibility URL assertions**

Require old Candidate list links to preserve existing query parameters and append/force `kind=candidate`; old Candidate detail/history paths must resolve to the canonical Candidate detail/history shell.

- [ ] **Step 3: Run focused UI tests and verify failure**

Run:

```bash
node --import tsx --test tests/skill-bundle-admin-ui.test.ts tests/admin-ui-structure.test.ts
```

Expected: FAIL on the old `openBundle(d.import.id)` flow / legacy links.

- [ ] **Step 4: Implement import navigation and compatibility normalization**

Use `encodeURIComponent(d.import.id)` and `location.assign(...)` (or the project's established equivalent). Do not change the import API response.

- [ ] **Step 5: Extend Bundle entrypoint E2E regression coverage**

Keep assertions that preview/import/list/detail/approve APIs still function unchanged; add an assertion that no server API rename was required for the unified UI.

- [ ] **Step 6: Run Task 8 tests**
Run:

```bash
node --import tsx --test tests/skill-bundle-admin-ui.test.ts tests/skill-bundle-entrypoints-e2e.test.ts tests/admin-ui-structure.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin-ui.ts tests/skill-bundle-admin-ui.test.ts tests/skill-bundle-entrypoints-e2e.test.ts tests/admin-ui-structure.test.ts
git commit -m "feat: hand off bundle imports to review center"
```

### Task 9: Full regression validation and documentation alignment

**Files:**
- Modify only if tests reveal required corrections: files from Tasks 1-8.
- Review: `docs/superpowers/specs/2026-10-15-unified-review-center-design.md`
- Review/update if behavior wording changed: relevant Admin/developer docs discovered by exact search for `候选审核`, `/admin/review/candidates`, and `Skill Bundle 导入 / 审核`.

**Interfaces:**
- Consumes all prior tasks.
- Produces a validated integrated review workflow with no regression in Candidate/Bundle actions.

- [ ] **Step 1: Run Candidate mutation regressions**

Run:

```bash
node --import tsx --test tests/admin-candidate-actions-e2e.test.ts
```

Expected: PASS unchanged.

- [ ] **Step 2: Run Bundle workflow regressions**

Run:

```bash
node --import tsx --test tests/skill-bundle-entrypoints-e2e.test.ts tests/skill-bundle-publishing.test.ts tests/skill-bundles.test.ts tests/skill-bundle-storage.test.ts
```

Expected: PASS unchanged except UI navigation assertions intentionally updated earlier.

- [ ] **Step 3: Run all review/admin focused tests**

Run:

```bash
node --import tsx --test \
  tests/review-center.test.ts \
  tests/review-center-e2e.test.ts \
  tests/admin-routes.test.ts \
  tests/admin-ui-structure.test.ts \
  tests/skill-bundle-admin-ui.test.ts
```

Expected: PASS.

- [ ] **Step 4: Search docs for stale Admin route wording**

Run:

```bash
rg -n "候选审核|/admin/review/candidates|Skill Bundle 导入 / 审核" docs README.md
```

Update only docs that describe the Admin review UI; do not rewrite historical implementation records unless they are explicitly presented as current instructions.

- [ ] **Step 5: Run full project check**

Run:

```bash
npm run check
```

Expected: TypeScript build passes and all `tests/**/*.test.ts` pass.

- [ ] **Step 6: Verify the acceptance scenario with mixed pending data**

Using an existing test fixture or local test server, verify the unified Pending list includes at least one `kc_*` and one `sbi_*` row, and that selecting `kind=candidate` / `kind=skill-bundle` isolates them correctly.

- [ ] **Step 7: Review final diff**

Confirm:

- no Candidate or Bundle domain mutation semantics were replaced;
- no duplicate review list remains as the primary navigation surface;
- compatibility paths are tested;
- new APIs are Admin-gated;
- global pagination happens after mixed-source merge/sort;
- source scanning is bounded.

- [ ] **Step 8: Commit final docs/fixes**

```bash
git add <only files changed in this task>
git commit -m "docs: align unified review center guidance"
```

Skip this commit when Task 9 required no file changes.
