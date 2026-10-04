# Knowledge Lifecycle Guide

## Supported metadata

Markdown Knowledge may use front matter:

~~~yaml
---
owner: ota-team
status: active
tags: [ota, recovery]
created_at: 2026-01-01
updated_at: 2026-09-30
valid_from: 2026-01-01
valid_until: 2027-01-01
source: ota-runbook
supersedes: docs/ota/legacy-recovery.md
review_cycle: 90d
---
~~~

Supported lifecycle states:

- `draf
- `active
- `deprecated
- `superseded
- `expired
- `archived

## Search behavior

Inactive states such as deprecated/superseded/expired/archived do not participate in normal retrieval. Draft content is down-ranked. Version applicability is applied only when the caller supplies an applicability context.

## Lifecycle audi

Admin Knowledge view reports deterministic issues such as:

- expired;
- deprecated/superseded/archived/draft state;
- missing owner;
- invalid validity/review dates;
- review overdue.

Review overdue is derived from `updated_at` (or `created_at`) plus `review_cycle`.

## Maintenance workflow

1. Open Knowledge -> Lifecycle Audit.
2. Inspect owner, status, review dates, validity, and issue.
3. Generate a pending Review Candidate for the lifecycle issue.
4. Edit the Candidate with verified content and metadata.
5. Approve with a review reason.
6. Publish through GitLab MR.
7. Merge and let normal Repository Sync/RAG indexing activate the new revision.

Do not edit indexed Knowledge directly in the Hub. Git remains the source of truth.
