# API Key Management Page Design

## Intent

The current Access Control page mixes administrator session management, API Key creation, and the complete API Key list on one page. As the number of keys grows, the page becomes long and hard to scan.

## Goals

- Keep the Access Control landing page stable regardless of API Key count.
- Move the full API Key list to a dedicated secondary page.
- Default to 10 rows per page.
- Preserve existing API Key creation, revoke/disable/delete semantics and permissions.
- Keep visual style consistent with the existing Admin UI.

## Non-goals

- No change to API Key authentication semantics.
- No database schema change unless pagination/search cannot be supported by current storage APIs.
- No redesign of administrator session management.

## Approaches

1. Same-page pagination: smallest change, but the Access Control page still grows in complexity.
2. Dedicated secondary API Key management page: selected. Keeps the landing page concise and scales cleanly.
3. Same-page table with drawer: rejected because it introduces a new interaction pattern not otherwise used by this Admin UI.

## Selected UX

### Access Control landing page

Keep:
- administrator login/session area
- API Key summary card

Replace the full Key list with:
- total key count
- enabled count
- disabled/revoked count
- Create API Key action
- Manage all API Keys link/button

The create form is collapsed by default and expands on demand. After successful creation, the form collapses again and summary/list data refreshes.

### Secondary page: Access Control / API Keys

Header:
- breadcrumb/back link
- title
- Create API Key button

Toolbar:
- search by key name or user id
- status filter
- tenant filter
- role filter
- sort by recently updated / created time / name

Table columns:
- Name
- User
- Tenant
- Roles
- Status
- Last used (currently displayed as `未记录`; the current API Key model has no last-used timestamp)
- Created at
- Actions

Row actions are grouped under a compact ... menu where appropriate.

Pagination:
- default 10 rows per page
- next/previous and page number navigation
- total result count
- changing search/filter resets to page 1

## Backend behavior

Prefer server-side search/filter/pagination so large Key sets do not require sending the full collection to the browser.

Expected query shape:

GET /admin/api/api-keys?q=&status=&tenant=&role=&sort=&page=1&pageSize=10

Response should include:
- items
- page
- pageSize
- total
- totalPages

If an existing API already supports equivalent filtering/pagination, reuse it rather than creating a parallel endpoint.

## Compatibility

- Existing create/revoke/delete APIs remain unchanged where possible.
- Existing access-control landing URL remains unchanged.
- Existing admin session controls remain on the current page.
- Existing permissions remain authoritative.

## Tests

Cover:
- landing page no longer renders an unbounded key table
- secondary API Key page route exists
- default page size is 10
- search/filter/pagination query behavior
- page resets when filter changes
- create flow refreshes summary/list
- existing revoke/delete behavior still works

## Implementation ruling

The current managed API Key record does not persist `lastUsedAt`. This UI change does not add authentication-path usage tracking or a storage migration. The management table displays `未记录` for Last used and provides sorting by updated time, created time, or label.
