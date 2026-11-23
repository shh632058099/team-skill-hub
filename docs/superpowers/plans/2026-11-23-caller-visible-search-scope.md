# Caller-visible search scope implementation plan

Source design: `docs/superpowers/specs/2026-11-23-caller-visible-search-scope-design.md`

## Task 1 — Lock the MCP contract with RED tests

Add focused MCP tests for default schemas without repositories, additive `discover_scoped`, legacy repository input not narrowing default search, and repository-list guidance.

## Task 2 — Add strict explicit repository scope

Add application-service validation that deduplicates requested IDs, requires at least one, validates all against caller-visible repositories, and throws `REPOSITORY_SCOPE_NOT_VISIBLE:<id>`. Add focused service tests.

## Task 3 — Remove repository topology from default MCP retrieval

Split the MCP filter schema. Remove repository inputs from `discover`, `list_skills`, `search_skills`, `resolve_skill`, `list_knowledge_sources`, and `search_knowledge`. Add `discover_scoped`. Update tool descriptions. Keep precise loaders unchanged.

## Task 4 — Convert project repository hard filters to ranking preferences

Extend internal `discover` with `preferredRepositories`, retrieve a wider candidate pool, apply a small deterministic ranking-only preference, and keep non-preferred visible candidates. Change `recommendProjectContext` to use preferred repositories instead of hard scope. Add cross-repository regression.

## Task 5 — Compatibility and guidance audit

Audit managed client guidance, Worker MCP profiles, examples, and docs for instructions that tell agents to guess/select repositories before search. Change only conflicting guidance. Bump client integration only if managed client artifacts change.

## Task 6 — Acceptance

Run focused tests, TypeScript, Prettier, diff check, full suite including Docker-backed tests, deploy to WSL2 Hub, verify health and MCP tools/list/default discover behavior. Do not commit/push unless explicitly requested.
