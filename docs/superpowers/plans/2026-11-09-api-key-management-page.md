# API Key Management Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move API Key management to a dedicated secondary Admin page with server-side search/filter/pagination and a default page size of 10.

**Architecture:** Reuse the existing ManagedApiKeyStore and mutation endpoints. Extend the existing GET /admin/api/api-keys route to accept filters and pagination via the shared admin pagination helpers, add a dedicated /admin/access/api-keys page, and reduce the Access Control landing page to summary + creation + management entry.

**Tech Stack:** TypeScript, Fastify, static Admin HTML/JS, node:test.

**Spec:** docs/superpowers/specs/2026-11-09-api-key-management-page-design.md

## Global Constraints

- Default page size is 10.
- Authentication semantics and create/update/reveal/rotate/delete APIs remain unchanged.
- API Key storage schema remains unchanged.
- Access Control landing page must not render an unbounded list.
- Search/filter changes reset to page 1.

## Review Focus

- Empty result sets remain usable and show total 0.
- Filter/page combinations cannot return items outside the filtered result set.
- A deleted/updated Key refreshes the current page safely if the last row disappears.
- The landing-page expert authorization datalist still has usable user IDs without loading an unbounded visible list.
- Existing admin-session controls and permission checks are unchanged.

---

### Task 1: Paginated API Key list API

**Files:**
- Modify: src/server.ts
- Test: tests/admin-routes.test.ts or a focused API-key admin route test

**Interfaces:**
- GET /admin/api/api-keys?q=&status=&tenant=&role=&sort=&limit=10&cursor=0
- Response: { keys, page, summary, facets }

- [ ] Write failing tests for default limit 10, search, status/tenant/role filters, sorting, and summary totals.
- [ ] Run focused tests and confirm RED.
- [ ] Implement filtering/sorting before paginateAdminRows.
- [ ] Run focused tests and confirm GREEN.

### Task 2: Dedicated API Key management page

**Files:**
- Modify: src/admin-ui.ts
- Modify: src/server.ts
- Test: tests/admin-ui-structure.test.ts

**Interfaces:**
- New export: ADMIN_API_KEYS_HTML
- New page: GET /admin/access/api-keys

- [ ] Write failing structure tests for the page route, toolbar, table, and default limit=10.
- [ ] Implement the dedicated page using the existing API mutations.
- [ ] Add search/status/tenant/role/sort controls and cursor pagination.
- [ ] Run structure tests and focused route tests.

### Task 3: Simplify Access Control landing page

**Files:**
- Modify: src/admin-ui.ts
- Test: tests/admin-ui-structure.test.ts

- [ ] Write failing test asserting the landing page has API Key summary/manage link but no unbounded key-list container.
- [ ] Replace the existing list with summary metrics and a link to /admin/access/api-keys.
- [ ] Keep creation UI collapsed by default and refresh summary after create.
- [ ] Ensure expert authorization datalist still loads user IDs from API facets/summary data.

### Task 4: Full verification

- [ ] Run git diff --check.
- [ ] Run npm run format:check.
- [ ] Run npm run lint.
- [ ] Run npm run build.
- [ ] Run npm test.
- [ ] Review the workspace diff for auth/regression issues.
