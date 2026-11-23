# Caller-visible search scope design

## Problem

Team Skill Hub already authenticates each MCP request with an API Token, resolves it to a `Principal`, and computes caller-visible repositories from repository `readRoles`, visibility, and enabled state. That is the correct authorization boundary.

The current MCP search surface nevertheless exposes optional `repositories` on default retrieval tools. An agent can infer or guess a repository from cwd, git remote, project name, or task context and accidentally turn a broad caller-visible search into a hard repository filter. This creates false negatives: a matching team Skill or Knowledge item can exist in another caller-visible repository but become invisible because the model guessed the wrong repository.

Repository IDs and Git URLs are platform organization details. A normal user often does not know them and should not have to know them to search Skills or Knowledge.

## Design principles

1. Authorization scope is server-owned. API Token -> Principal -> permissions determines the maximum search scope.
2. Default search tools accept intent and metadata, not repository topology.
3. Repository provenance remains in search results and precise load tools.
4. Explicit repository narrowing is a separate, exceptional operation and must never be inferred from cwd, git remote, project name, task text, or model preference.
5. Internal application APIs may retain repository filters for trusted server-side workflows.
6. Project context may prefer repositories for ranking, but must not hard-filter other caller-visible repositories.
7. Invalid explicit repository scope fails clearly instead of silently returning zero results.
8. Existing clients that still send a removed `repositories` field to default tools must not regain filtering authority.
9. An empty repository scope is invalid for explicit scoped discovery.
10. The result set must always remain bounded by the caller's permissions.

## Public MCP surface

### Default retrieval tools

The following tools no longer expose `repositories`:

- `discover`
- `list_skills`
- `search_skills`
- `resolve_skill`
- `list_knowledge_sources`
- `search_knowledge`

Their effective repository scope is always all caller-visible repositories. No repository lookup is required before a normal search.

### Explicit scoped discovery

Add `discover_scoped` for the exceptional case where the user explicitly requests limiting discovery to one or more Team Skill Hub repositories.

Rules:

- `repositories` is required and non-empty.
- Every requested repository must exist in the caller-visible repository set.
- Any unknown or non-visible repository causes `REPOSITORY_SCOPE_NOT_VISIBLE:<id>`.
- The tool description must say it is only for explicit user-requested narrowing.
- If the user refers to a repository by human meaning but the caller does not know its ID, `list_skill_repositories` may be called only then to resolve the visible repository list.
- The default search workflow must not call `list_skill_repositories` as a preflight step.

A separate scoped variant is intentionally not added for every search primitive. `discover_scoped` is the single explicit repository-scoped retrieval entry point.

### Repository listing

`list_skill_repositories` remains available for users asking what repositories exist, resolving a repository after explicit repository-limited intent, diagnostics, and provenance inspection. Its description must explicitly state that it is not a prerequisite for normal discovery/search.

### Precise load tools

`get_skill`, `get_skill_resource`, `get_knowledge`, and other exact loaders retain repository identifiers because they load an already-selected object whose provenance came from a previous result.

## Application service

Internal methods retain repository-aware parameters so trusted server workflows can still scope retrieval.

Add strict explicit scope validation:

```text
requested repository IDs
        ∩
caller-visible repository IDs
```

The operation succeeds only when every requested ID is visible.

## Project context behavior

Current project recommendations use preferred repositories as a hard filter. Change this to a soft ranking preference.

`discover()` gains internal `preferredRepositories?: string[]`.

Semantics:

- hard scope remains all caller-visible repositories unless a trusted internal caller passes `repositories`;
- preferred repositories receive a small deterministic ranking bonus;
- non-preferred caller-visible repositories remain candidates;
- raw search score/confidence returned to clients is preserved;
- the bonus affects ordering/selection only;
- discovery fetches a wider candidate pool before preference ranking.

`recommendProjectContext()` passes project/profile repositories through `preferredRepositories`, not `repositories`.

## Compatibility

- Default MCP schemas remove `repositories`.
- Existing callers that send the legacy field do not control scope; unknown object properties are stripped by the schema.
- Internal TypeScript APIs remain repository-aware.
- `discover_scoped` is additive.
- Precise load APIs are unchanged.
- Client integration is bumped only if managed guidance/templates embed the old repository-filter behavior.

## Test matrix

1. Principal can read A and B; matching Skill exists only in B. Default discover finds B.
2. Default search tool schemas expose no repository property.
3. Legacy `repositories` sent to a default MCP tool does not restrict search.
4. `discover_scoped` with A returns only A.
5. Unknown/non-visible scoped repository fails explicitly.
6. Empty scoped repository list is rejected.
7. Token permissions still prevent invisible repository access.
8. Project context prefers configured repositories but can still return a stronger relevant item from another visible repository.
9. `list_skill_repositories` remains available and is documented as non-preflight.
10. Existing exact-load and internal repository-filter behavior remains intact.
