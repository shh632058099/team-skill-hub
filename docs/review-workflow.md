# Knowledge Review Workflow

## Candidate states

Typical lifecycle:

~~~tex
pending
 -> approved
 -> publishing
 -> published

pending/approved/publish_failed
 -> rejected

publishing failure
 -> publish_failed
 -> retry
~~~

`published` means the GitLab publication/MR step was created successfully. MR state is tracked separately and may be opened, merged, closed, or locked.

## Review Inbox

The Admin Review Inbox supports:

- status/repository/source/reviewer/automatic filters;
- structured Engineering Evidence;
- detector reasoning and classification;
- exact/near duplicate warnings;
- relation hints;
- related Knowledge;
- CURRENT vs PROPOSED preview;
- conflict warning;
- append-only history;
- bulk approve/reject, up to 100 Candidates.

## Review reasons

Approval:

- `useful
- `needs_edi

Rejection:

- `false_positive
- `duplicate
- `low_reuse_value
- `outdated

These labels power automatic-Candidate quality metrics.

## Relations

Supported final relations:

- `new
- `duplicate_of
- `updates
- `supersedes
- `conflicts_with
- `related_to

Relation hints are advisory. The Reviewer confirms the target and relation.

`conflicts_with` cannot be published until resolved. `duplicate_of` should not produce a new Knowledge document.

## GitLab publication

Approved Candidates can create/update a target file through GitLab and create a Merge Request. Publishing is idempotent for an existing open MR. A closed MR is not silently reused.

Admin can refresh MR state and persist merge/close timestamps and merge commit SHA.

## Optional LLM-assisted curation

LLM curation is an optional Reviewer aid, not part of the trusted write path.

Enable a vendor-neutral HTTP JSON curator with:

~~~tex
KNOWLEDGE_CURATOR_URL=https://internal-curator.example/api/curate
KNOWLEDGE_CURATOR_TOKEN_ENV=KNOWLEDGE_CURATOR_TOKEN
KNOWLEDGE_CURATOR_TOKEN=<secret supplied by deployment environment>
~~~

The token value is never stored in Hub configuration. `KNOWLEDGE_CURATOR_TOKEN_ENV` contains only the environment-variable name.

Supported advisory operations:

- pending Candidate curation: title, concise body, category, suggested path, Skill-vs-Knowledge type and conflict hint;
- Knowledge Gap clustering proposal.

Every model response is validated locally for schema, bounded length, safe relative path, supported type and valid Gap membership. The Admin UI shows the proposal first. A Reviewer must explicitly apply it; the Candidate remains `pending` and still requires the normal Review -> GitLab MR -> human merge workflow.

The Curator cannot directly approve, publish, merge, or write formal Knowledge.
