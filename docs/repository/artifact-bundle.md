# Artifact Bundle

## 1. Current model

Team Skill Hub uses **Artifact Bundle** as the common lifecycle for both Skill and Knowledge.

- `kind=skill`: directory-scoped artifact.
- `kind=knowledge`: currently file-scoped for a single Markdown document; the model also supports directory-scoped multi-file Knowledge.
- Every new submission produces an immutable final Snapshot, a baseline hash for the selected target scope, a diff, review state, and publication state.
- Historical Knowledge Candidates created before Artifact Bundle unification remain on the legacy path and are not migrated.

## 2. Merge and Replace

`submission_mode` supports:

| Mode      | Behavior                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `merge`   | Default. Add new submitted paths, overwrite submitted existing paths, preserve omitted paths in the target scope. |
| `replace` | Explicit full replacement of the selected target scope. Omitted paths in a directory-scoped artifact are deleted. |

The server normalizes an omitted or null MCP `submission_mode` to `merge`.

### Skill

A Skill is directory-scoped. Submitting only `SKILL.md` with default `merge` does **not** remove existing `scripts/`, `references/`, `assets/`, or other files. The service reads the current Skill tree, overlays submitted files, validates the complete result, and stores that complete final tree in the Snapshot.

Use `replace` only when the submitted tree is intentionally the complete desired Skill.

`skill_path` is logically namespace-relative, for example `systematic-debugging`. For LLM/MCP compatibility the server also accepts and normalizes `superpowers/systematic-debugging` and `skills/superpowers/systematic-debugging`, provided the namespace matches.

### Knowledge

A normal Knowledge document is file-scoped at the exact target `.md` path.

- `merge`: create or overwrite only that exact file.
- `replace`: also replaces only that exact file.
- A sibling Knowledge document is never in scope for a single-file Knowledge Bundle.

New Knowledge Candidates store an `artifactBundleId`. The Artifact Bundle is the lifecycle authority; the Candidate remains the user-facing review projection and retains Knowledge-specific metadata and relations.

## 3. Snapshot, review, and stale protection

At submission the server records `targetRevision`, `targetScopeSha256`, `snapshotSha256`, `submissionMode`, and `targetKind`.

The Snapshot is the **complete final result**, not only the submitted patch.

Approval records the exact baseline and diff shown to the reviewer. Before publication the target scope is read again. If it changed, publication is blocked and the record becomes `review_stale`; the approved Snapshot is never silently re-merged onto newer content.

## 4. Publication

GitHub and GitLab use the same logical file-action plan: create, update, chmod, and delete.

Merge does not generate deletes for omitted files. GitHub no longer implements merge by recursively deleting and recreating the whole target root.

A PR/MR is still the publication boundary. Only a merged PR/MR reaches `published`.

## 5. Admin UI

### Skill Bundle import

The import page provides:

- `Merge` — default; preserve omitted files.
- `Replace` — explicit; omitted files in the target directory are deleted.

### Review Center

Skill Bundle detail shows Submission Mode, Target Kind, Replacement Root, Target Revision, Target Scope SHA256, Review Baseline SHA256, Snapshot SHA256, file count, and publication state.

Knowledge Candidate detail shows the bound Artifact Bundle summary when `artifactBundleId` exists: Artifact Bundle ID, Bundle status, Submission Mode, Target Kind / Root, target and snapshot hashes, review baseline, and Snapshot file count.

The underlying Knowledge Bundle is not shown as a second Review Center item; Candidate is the single user-facing review item, while its Bundle remains the authoritative lifecycle record.

## 6. MCP entrypoints

Existing tool names are retained:

- `submit_skill_bundle`
- `submit_knowledge_candidate`

Both accept optional `submission_mode = merge | replace`; omission or MCP `null` means `merge`.

Neither submission tool publishes directly. They create pending review records.

## 7. Safety rules

- Never infer deletion from an omitted path in Merge mode.
- Fail closed if the current target scope cannot be read reliably.
- Do not widen a file-scoped Knowledge target to its parent directory.
- Do not rebase an already approved Snapshot onto changed target content.
- Keep Skill validation and Knowledge submission/relation validation in their respective adapters.
- Do not migrate historical Candidates as part of normal submission or publication.
