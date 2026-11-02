# Artifact Bundle Unification Design

- Date: 2026-10-31
- Status: Proposed; awaiting approval
- Scope: Unify Skill and Knowledge submission, snapshots, preview/diff, review, and publication around one Artifact Bundle core.

## 1. Intent

Skill and Knowledge are artifact kinds, not independent submission systems. Both use one bundle lifecycle and file-tree model so omitted files are preserved by default, review shows the exact final result, and GitHub/GitLab publish the same approved snapshot.

Domain rules remain separate: Skill validation understands SKILL.md and Skill directory structure; Knowledge validation understands Knowledge Markdown and Knowledge relations. These rules stay in kind adapters, not the shared bundle engine.

## 2. Current State

### Skill

- src/skill-bundles.ts defines SkillBundleImportType = "skill" | "collection", SkillBundleSnapshot, file metadata, tree hashing, and tree diff.
- src/skill-bundle-service.ts owns preview, submission, immutable snapshots, review baselines, stale-review detection, and publication orchestration.
- writeSnapshotRoot() removes the entire replacementRoot and writes only submitted files. This causes omitted files to be deleted.
- src/skill-bundle-publishing.ts repeats destructive root replacement in the GitHub path; GitLab emits file actions from a tree diff.

### Knowledge

- KnowledgeCandidate in src/observability.ts stores one content string, one suggestedPath, review state, relation metadata, and publication state.
- src/knowledge-submission.ts validates and normalizes one Markdown document.
- src/knowledge-publishing.ts has separate single-file GitLab/GitHub publishers.
- src/application.ts resolves Knowledge relation targets and computes a single-file diff. The default Knowledge target is one file under knowledge/.

Skill therefore has a bundle lifecycle, while Knowledge is a single-file candidate/publisher workflow. There is no common Artifact Bundle abstraction today.

## 3. Goals

1. One generic Artifact Bundle model for file trees, immutable snapshots, target scope, submission mode, baseline, diff, review, and publication.
2. Skill and Knowledge become artifact kinds handled by the same lifecycle.
3. merge is the server-enforced default: add submitted new paths, overwrite submitted existing paths, preserve omitted paths.
4. replace remains available only when explicitly selected: the submitted tree becomes the complete desired content of the selected directory scope.
5. Preview, approval, and both Git providers consume the same final snapshot and canonical diff.
6. Approval is bound to the target scope hash and target revision; any target change before publication blocks publication and requires re-review.
7. Kind-specific validation and metadata remain in adapters.
8. Preserve repository authorization, namespace/collection routing, Knowledge relations, and PR/MR approval workflow.

## 4. Non-goals

- Historical Candidate migration or complex backward-compatibility layers.
- A general plugin framework or arbitrary third-party artifact kinds.
- A separate per-file deletion API. Directory-scoped removals use explicit replace with the complete desired tree.
- Automatic target-path changes based on similarity. Explicit or already-approved relation resolution remains authoritative.
- Redesigning repository configuration, tenant authorization, or unrelated PR/MR reconciliation.

## 5. Chosen Architecture: Shared Core with Kind Adapters

    Skill submission ----> Skill adapter ----\
                                               \
    Knowledge submission -> Knowledge adapter ---> Artifact Bundle Service
                                                    | normalize files and paths
                                                    | resolve target scope
                                                    | read baseline
                                                    | merge / replace
                                                    | immutable final snapshot
                                                    | canonical tree diff + hash
                                                    | review + stale check
                                                    v
                                           Artifact Bundle Repository
                                                    |
                                                    v
                                           Artifact Bundle Publisher
                                              /              \
                                          GitHub            GitLab

### 5.1 Shared Artifact Bundle model

Conceptual record fields:

- id, revision, kind: "skill" | "knowledge".
- repository and applicable namespace/collection scope.
- targetRoot: repository-relative path selected for this artifact.
- targetKind: "file" | "directory".
- submissionMode: "merge" | "replace"; omitted input is normalized to merge on the server.
- snapshotId, snapshotSha256: immutable complete final tree, not merely the submitted overlay.
- targetRevision, targetScopeSha256: baseline observed when the final snapshot was produced/submitted.
- lifecycle status, submitter, reviewer, review metadata, publication metadata, and timestamps.

A bundle file retains relative path, bytes (text or base64), SHA-256, size, and supported mode. A single-file Knowledge document is a file-scoped bundle whose sole payload maps to the exact target file. Its replace operation can affect only that file. A multi-file Knowledge bundle is directory-scoped. Replacing one Knowledge document must never delete sibling documents in knowledge/. For file scope, the snapshot uses one stable internal entry and the publisher maps it to targetRoot; the parent directory is not the replacement scope.

Generalize and reuse the existing Skill snapshot/hash/diff primitives where their semantics are correct. Do not create a second tree-hashing or diff implementation.

### 5.2 Kind adapters

**Skill adapter**

- Resolves namespace, collection, and Skill target root.
- Validates the resulting complete tree using existing Skill validation (SKILL.md, metadata, directory structure, and validation rules).
- Keeps collection-specific checks here. A collection is a directory-scoped bundle containing multiple Skill directories, not a separate lifecycle engine.

**Knowledge adapter**

- Converts the existing Knowledge submission payload into bundle files. Initially the current payload produces one Markdown file; the bundle input supports multiple files.
- Applies current Knowledge submission-spec validation to the submitted Knowledge document before creating the bundle.
- Resolves suggestedPath and existing updates/supersedes relation targets to a deterministic target scope and relative file path. Relation metadata remains domain metadata.
- Validates Knowledge-specific Markdown requirements. Never run Knowledge through Skill validation.

Adapters produce normalized bundle inputs and validation results. They do not own snapshots, diff algorithms, lifecycle state transitions, or provider-specific publication logic.

### 5.3 Merge and Replace semantics

Both kinds use the same semantics within their declared target scope:

| Target scope | Mode | Behavior |
|---|---|---|
| File | merge (default) | Create or overwrite only the exact target file. |
| File | replace (explicit) | Replace only the exact target file; sibling paths are out of scope. |
| Directory | merge (default) | Start with the current directory; add new submitted paths; overwrite submitted existing paths; preserve every omitted path. |
| Directory | replace (explicit) | Final directory contains exactly submitted paths; omitted existing paths inside that directory are deleted. |

The service reads the complete target scope before creating the snapshot. If it cannot read the full scope, it rejects submission; it must never fall back to replace or treat an incomplete read as an empty scope.

The snapshot stores the complete final tree after applying the selected mode. Review and publishers never reconstruct the tree from the original partial submission. Omitted files are never interpreted as deletions in merge mode. There is no separate deletion list; explicit replace is the only submission-level way to remove omitted paths in a directory-scoped artifact.

### 5.4 Preview, Diff, and Snapshot

- Calculate one canonical tree hash from normalized relative paths, file modes, and file bytes.
- Calculate one tree diff between baseline and final snapshot: added, modified, deleted, unchanged.
- Text files may show line hunks; binary files show file-level operations and hashes without lossy decoding.
- In merge mode, omitted files are unchanged and cannot appear as deletions.
- In directory replace mode, omitted files appear as deletions.
- The same immutable snapshot and diff are shown in admin preview/review and consumed by both publishers.

### 5.5 Review and stale protection

At submission, persist target revision and targetScopeSha256 used to construct the final snapshot. At approval, persist the baseline hash and diff hash shown to the reviewer. Immediately before publication, read the target scope again and compare it with the approved baseline.

If the target scope changed, publication is blocked and the artifact enters the existing stale-review state (or its shared equivalent). It must be previewed and reviewed again. Do not automatically rebase an approved snapshot onto changed content.

Hash only the selected target scope, not the entire repository. For file scope, hash the exact target file, including an explicit absent-file state. For directory scope, hash the complete directory tree. Retain target revision for audit and provider consistency.

### 5.6 GitHub and GitLab publication

Both providers receive the same before tree, final snapshot, and canonical diff.

- GitHub applies file-level add/update/delete operations derived from the diff. It must not recursively delete and recreate the root for merge.
- GitLab actions are generated from the same diff. In merge mode, no omitted file may generate a delete action.
- Directory replace may delete only paths present in the baseline and absent from the final snapshot.
- File-scoped Knowledge publication touches only the exact target file for either mode.
- Publication metadata reports the same logical counts and expected final tree hash for either provider.
- Preserve the existing PR/MR lifecycle and reconciliation behavior; provider API mechanics stay behind provider adapters.

### 5.7 Existing workflow integration

- Skill MCP and admin submission/preview routes call the Skill adapter and shared Artifact Bundle service.
- Knowledge MCP, manual candidate, gap/feedback, and admin review flows call the Knowledge adapter and shared service.
- Knowledge relation/auto-relation resolution remains in the Knowledge adapter/application boundary. It determines the target but cannot bypass bundle baseline, snapshot, or review.
- Skill namespace and collection routing remains in the Skill adapter.
- Admin UI presents common bundle fields (kind, target, mode, file tree, diff, status) and kind-specific metadata separately.
- Do not add a new get_*_bundle tool solely for this unification. Adapt existing submission inputs and workflow entry points in place.

## 6. Data and Storage Boundaries

The Artifact Bundle repository owns generic bundle records and snapshots. Kind-specific metadata may remain in typed metadata fields or existing domain records, but each new submission has one authoritative lifecycle record. Do not maintain parallel Knowledge Candidate and Artifact Bundle lifecycle states for the same new submission.

No historical record migration is required. New submissions use the unified model. Existing historical candidates remain readable as historical records but are not converted in bulk. Avoid a general compatibility subsystem; retain only minimal read behavior required by current UI/history.

## 7. Acceptance Criteria

1. A Skill bundle submitted with only a new nested file defaults to merge; all old files remain byte-identical and mode-identical; diff shows only the addition.
2. A Knowledge bundle submitted with one new Markdown file defaults to merge; existing files outside its exact file target remain.
3. A Knowledge bundle can contain multiple files and is reviewed/published as one immutable snapshot.
4. Explicit replace of a file-scoped Knowledge artifact cannot delete sibling documents.
5. Explicit replace of a directory-scoped bundle deletes only omitted paths inside that selected directory.
6. Submitting an existing path in merge replaces only that path; other paths remain.
7. Omitting mode always means merge, enforced by server normalization rather than tool text alone.
8. Binary files and executable modes are preserved for files carried forward from the baseline.
9. An unreadable/partial target scope causes submission to fail closed.
10. A target-scope change after approval blocks publication and requires re-review.
11. GitHub and GitLab consume the same final snapshot and logical diff; merge emits no deletion for omitted paths.
12. Skill-specific validation and Knowledge-specific submission validation both remain enforced.
13. Knowledge relation targets and Skill namespace/collection routing continue to resolve to intended repository paths.
14. Admin preview displays the exact final tree/diff that will be published.

## 8. Implementation Boundaries and Suggested Sequence

Implement in independently testable slices:

1. **Shared bundle core:** generic types, file/directory target scope, normalization, target read, merge/replace, canonical hash/diff, immutable snapshots, baseline capture, stale-review primitives. Add focused unit tests first.
2. **Skill adapter migration:** route Skill submission/preview/review/publish through the shared core; retain Skill validation and namespace/collection behavior. Verify default merge and explicit replace for Skill and collection directory roots.
3. **Knowledge adapter migration:** adapt Knowledge document submission to a file-scoped one-file bundle; preserve submission-spec validation, relation target resolution, candidate entry points, and review semantics. Add directory-scoped multi-file Knowledge bundle input without a second lifecycle.
4. **Provider convergence:** make GitHub and GitLab consume one shared final-tree diff and apply identical logical operations. Test both provider action plans.
5. **Admin/MCP integration:** expose submission_mode with server default merge; render kind, target, final tree, and diff consistently; retain kind-specific metadata and existing user workflows.
6. **End-to-end verification:** test Skill and Knowledge merge/replace, stale review, binary/mode preservation, relations, file-scope sibling safety, and GitHub/GitLab parity; run typecheck, relevant tests, and build.

## 9. Implementation Decisions to Confirm During Planning

- Generalize the existing skill_bundle_* SQLite tables in place or introduce neutral artifact_bundle_* tables for new records. Choose the smallest schema change that gives each new submission one authoritative lifecycle record; do not migrate historical rows.
- Map current Knowledge CandidateStatus to shared lifecycle statuses while preserving admin behavior and avoiding two competing state machines.
- Prefer thin GitHub/GitLab provider adapters around one shared file-action plan unless existing publisher contracts make a direct shared interface smaller.
- Implement targetKind file/directory consistently in baseline reads, snapshots, diff, stale checks, and both providers. Keep current single-file Knowledge targets at their exact .md path; never widen their replacement scope to the parent knowledge/ directory.
