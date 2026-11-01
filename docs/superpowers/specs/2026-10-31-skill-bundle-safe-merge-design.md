# Skill Bundle Safe Update Design

- Date: 2026-10-31
- Status: Superseded by [Artifact Bundle Unification Design](2026-10-31-artifact-bundle-unification-design.md)
- Scope: Historical Skill-only proposal retained for context; the unified design governs Skill and Knowledge behavior.
## 1. Problem

When a caller submits a Skill update containing only newly added files, the current implementation treats the submitted file list as the complete Skill directory. Files not included in that submission are consequently shown as deletions and removed during publication.

Example: an existing Skill contains `SKILL.md`, `references/api.md`, and `scripts/build.sh`. A submission containing only `references/new-api.md` must add that file and retain all three existing files.

**Required behavior: files omitted from an update are kept by default.**

## 2. Scope and decisions

Only two modes are needed for an individual Skill:

| Mode | Behavior |
|---|---|
| `merge` (default) | Add submitted new files, overwrite submitted paths that already exist, and preserve every existing file not submitted. |
| `replace` (explicit) | Treat submitted files as the complete desired Skill directory. Existing files omitted from the submission are removed. |

Additional rules:

- If `submission_mode` is omitted for `import_type=skill`, the server must use `merge`. This must be enforced in service code, not left to the model/tool description.
- `replace` must be an explicit user/caller choice. Never infer it from an incomplete file list.
- No separate `deleted_files` operation is included. When a caller intentionally wants to remove old files, it can explicitly use `replace` and submit the complete desired directory.
- Creating a new Skill works in either mode; merge into a missing directory is equivalent to creating it.
- `import_type=collection` keeps its existing full-snapshot behavior and is not changed by this design.

## 3. Implementation

### 3.1 Merge before snapshot creation

In the Skill Bundle service, before creating the immutable snapshot:

1. Resolve and read the current target Skill directory from the repository.
2. For `merge`, copy the existing tree, then apply submitted files by relative path:
   - New path: add the file.
   - Existing path: replace that file's contents.
   - Path not present in the submission: leave it unchanged.
3. For `replace`, use only the submitted files as the final tree, preserving the current full-replacement behavior.
4. Run the existing Skill validation against the resulting complete tree.
5. Store the resulting complete tree in the existing Skill Bundle snapshot.

The snapshot must contain the final tree, not just the submitted overlay. Review and publication should continue consuming this same snapshot; they must not independently reinterpret the submitted file list.

The merge operation must preserve raw bytes and supported file modes for existing files, including binary assets and executable scripts. Do not decode and re-encode files that were not submitted.

### 3.2 Preview and Diff

Preview must compare the existing Skill tree with the final merged/replaced tree.

- In merge mode, omitted existing files are unchanged and must not appear as deletions.
- New submitted paths appear as additions.
- Submitted paths that already exist appear as modifications when their content changes.
- In replace mode, omitted existing paths appear as deletions, as explicitly requested by the caller.
- Binary files should be represented by file-level change information rather than lossy text diffs.

### 3.3 Publication

Both publishers must publish the exact final snapshot produced by the service.

- **GitHub:** do not call the current recursive `replaceRoot` behavior on the merge path. Apply the final-tree changes without deleting the target directory first. In merge mode, unsubmitted files must remain untouched.
- **GitLab:** generate file actions from the same final-tree Diff. In merge mode, no omitted file may produce a delete action.
- In replace mode, deletions are expected because the caller explicitly selected full replacement.
- Keep the existing PR/MR publication and reconciliation flow.

### 3.4 Interfaces

- Extend `submit_skill_bundle` with `submission_mode: "merge" | "replace"`; omission defaults to `merge` for individual Skills.
- Update the MCP tool description with the two mode semantics and a clear warning that `replace` deletes files omitted from the submitted tree.
- If the admin web preview/import endpoints can submit individual Skills, pass the same mode into the same service implementation. Do not create separate merge logic for MCP and web.
- No new `get_skill_bundle` tool is required for this fix. The server must preserve files it already has, even when the caller does not know their names.

## 4. Safety boundaries

- Reuse existing repository authorization, Skill path validation, and file validation.
- Reject absolute paths, traversal paths, duplicate paths, and unsupported file types using the existing validation layer; do not allow writes outside the selected Skill root.
- Preserve binary content and executable modes for files not submitted.
- If the existing repository tree cannot be read completely, fail the submission. Never silently fall back from merge to replace.
- Keep the final snapshot immutable through review and publication so the approved result is the result that gets published.

No new caller-supplied base hash, separate deletion API, historical migration, or new concurrency protocol is required for this scoped fix. Retain any existing stale-review/publication protections already provided by the current pipeline.

## 5. Acceptance tests

1. **Core regression:** existing Skill contains `SKILL.md`, `references/api.md`, `references/design.md`, `scripts/build.sh`, and binary `assets/diagram.png`. Submit only a new `references/new-api.md` in default mode. The final snapshot contains all six files; every old file is byte-identical and retains its mode; Diff shows only the new file as added.
2. **Update existing file:** submit a changed `SKILL.md` in default mode. All other files remain unchanged; Diff shows only `SKILL.md` modified.
3. **Add and update together:** submit one new path and one existing path. The new file is added, the existing path is updated, and all other files remain.
4. **Explicit replace:** submit `submission_mode="replace"` with a complete smaller tree. Omitted old files are deleted and appear in Diff.
5. **Default is merge:** omit `submission_mode` and verify that existing files are preserved.
6. **New Skill:** default merge creates a valid Skill when the target directory does not exist.
7. **Binary/mode preservation:** unsubmitted binary files and executable scripts remain byte-identical with their original supported modes.
8. **GitHub publication:** merge publication does not recursively remove/recreate the target Skill directory; unsubmitted nested files survive.
9. **GitLab publication:** merge publication emits no delete action for an omitted file; its resulting tree matches the GitHub logical result.
10. **Collection unchanged:** collection imports retain their existing full-snapshot semantics.

## 6. Implementation sequence

1. Add the server-side merge/replace behavior in the Skill Bundle service and persist the final complete tree as the snapshot.
2. Ensure preview/Diff uses the final tree and shows omitted files as unchanged in merge mode.
3. Update GitHub publication to avoid recursive target-root removal on the merge path; verify GitLab actions use the same final-tree Diff.
4. Add the MCP mode parameter and align admin web preview/import if those paths support individual Skills.
5. Add and run the acceptance tests above, then run the relevant Skill Bundle test suite and typecheck/build.
