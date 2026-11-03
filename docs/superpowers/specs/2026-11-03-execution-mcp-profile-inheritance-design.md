# Execution MCP Profile Inheritance Design

## Intent

Simplify Admin execution configuration so an execution normally selects a reusable MCP Profile and inherits its settings. Administrators should only see/edit URL, Credential, Tools, and Required when they explicitly enable custom overrides. This removes duplicated configuration and ensures later Profile changes flow into deployments that do not override those fields.

## Goals

- Execution configuration selects a named MCP Profile; `default` remains the initial/default selection for backward compatibility.
- With custom override disabled, persist only the Profile reference. Do not copy URL, credential, tools, or required into the deployment record.
- With custom override enabled, expose optional per-field overrides. Empty/unset values continue inheriting from the referenced Profile.
- Resolve the selected Profile and overrides at dispatch time, then store the fully resolved immutable MCP settings in the task deployment snapshot. Existing queued/running task snapshots must not change when a Profile is edited later.
- Preserve existing deployments that already store flat MCP fields as explicit overrides; editing/saving them must not silently discard their current effective behavior.
- Keep MCP tool allowlist validation: deployment tool overrides must be a subset of the selected Profile's allowed tools; actual tool authorization remains enforced by the MCP credential/principal.
- Apply identically to Claude and Codex workers.

## Non-goals

- No changes to MCP authentication, principal/role authorization, Worker credential storage, or the global Profile editor.
- No new profile versioning or automatic mutation of existing task snapshots.
- No removal of the legacy flat MCP fields in this change; they remain readable for compatibility.

## Approaches

1. **UI-only simplification / copy Profile values into deployments** — smallest UI change, but duplicates configuration and Profile updates do not propagate. Rejected because it does not provide true inheritance.
2. **Reference plus sparse per-field overrides (selected)** — store `profileRef` and only explicitly supplied overrides; resolve at dispatch. Small schema-compatible evolution, true inheritance, and preserves immutable task snapshots.
3. **New nested override object with a database migration** — cleaner long-term shape, but requires a broader data migration and compatibility surface than needed for this fix.

## Data and resolution behavior

- Deployment MCP data supports `profileRef`, plus optional `urlOverride`, `credentialRef`, `allowedTools`, and `required` fields. The latter fields are sparse overrides, not required duplicated copies.
- `profileRef` absent continues to resolve to `default` for legacy records. The Admin editor should explicitly show/select `default`.
- `urlOverride` absent/blank inherits Profile URL.
- `credentialRef` absent/blank inherits Profile credential reference.
- `allowedTools` absent means inherit all Profile tools. A provided list must be non-empty and a subset of Profile tools.
- `required` absent means inherit Profile `required`; explicit `true`/`false` overrides it.
- Dispatch resolves the effective MCP configuration from the current Profile plus sparse overrides. The resolved values are written into the task snapshot so task execution is deterministic even if the Profile changes afterward.
- A missing referenced Profile must fail clearly; it must not silently fall back to `default` when a non-default `profileRef` was explicitly selected.

## Admin UI behavior

- Replace free-text Profile reference with a dropdown populated from `/admin/api/expert-config/mcp-profiles`.
- Default selection is `default`.
- Add a “自定义覆盖” toggle, off by default.
- When off, hide override fields and save only `{ profileRef }` (or omit MCP only when the existing product semantics explicitly mean MCP disabled; default profile behavior remains consistent with current dispatch behavior).
- When on, show optional URL and Credential inputs, optional allowed-tools picker, and a Required selector with `继承 Profile / 必需 / 非必需` so explicit false can be distinguished from inheritance.
- Edit existing legacy deployments by displaying their current flat fields as overrides. Do not rewrite them as inheritance merely by opening the form; only an intentional switch to inheritance should remove their overrides.
- Profile load failure must block editing/saving rather than presenting an empty dropdown as a valid configuration.

## API and compatibility

- Make deployment MCP `credentialRef` and `allowedTools` optional in the schema and TypeScript record types; validate values when present.
- Preserve existing flat JSON records in SQLite; no table migration is needed because `mcp_json` already stores JSON.
- Existing records with `credentialRef` and `allowedTools` continue to act as explicit overrides.
- New profile-only records resolve through the same dispatch path.
- API validation should verify the selected Profile exists and validate tool overrides against that Profile.

## Verification / acceptance

- Unit tests prove profile-only deployment inherits all fields and Profile updates affect newly submitted tasks.
- Unit tests prove each sparse override independently overrides only its field; `required: false` must be preserved.
- Unit tests prove tool override outside Profile allowlist and unknown explicit Profile IDs fail.
- Regression tests prove legacy full-field deployments preserve their prior effective settings.
- Integration tests cover Admin create/edit payloads and dispatch snapshots.
- Run formatting, typecheck/build, focused tests, and the full relevant test suite.
- Run Superpowers code review.
- Deploy using `deploy-local-wsl2.sh`; validate the actual Admin page/API and create controlled test configurations/tasks for both Claude and Codex. Verify effective snapshot fields and clean up test records without changing production Profile settings.

## Assumptions

- The existing global Profile API remains the source of truth for MCP defaults.
- Existing deployment MCP settings are intended as explicit overrides, because they were previously mandatory fields.
- The user has approved true reference-based inheritance rather than copied Profile values.
