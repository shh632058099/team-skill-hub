# Artifact Bundle Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Make Skill and Knowledge use one Artifact Bundle lifecycle with server-default merge, explicit replace, immutable final snapshots, stale-review protection, and provider-consistent publication.

**Architecture:** Generalize the existing Skill Bundle tree/snapshot/diff/service/publisher into an Artifact Bundle core, then place Skill and Knowledge adapters in front of it. Reuse the existing physical \`skill_bundle_*\` SQLite tables to minimize schema churn; new Knowledge submissions use the Bundle record as the authoritative lifecycle, while existing historical KnowledgeCandidate records stay on the legacy path without migration.

**Tech Stack:** TypeScript 5.9, Node.js >=24, Fastify, Zod, SQLite, node:test, GitHub/GitLab APIs.

**Spec:** \`docs/superpowers/specs/2026-10-31-artifact-bundle-unification-design.md\`

## Global Constraints

- \`merge\` is the server-enforced default for new Skill and Knowledge submissions.
- \`replace\` is explicit and applies only inside the selected target scope.
- File-scoped Knowledge replace can modify only the exact target \`.md\` file and must never delete sibling documents.
- Directory-scoped merge preserves every omitted path.
- The immutable snapshot stores the complete final result, not the submitted overlay.
- Approval and publication use the same baseline hash, snapshot, and canonical diff.
- Target-scope drift after approval yields \`review_stale\`; never auto-rebase an approved snapshot.
- GitHub and GitLab consume the same logical file-action plan.
- Keep Skill validation and Knowledge submission-spec/relation rules in adapters.
- Do not migrate historical Knowledge candidates or build a general compatibility subsystem.

## Review Focus

- Partial directory submission: omitted files must remain byte/mode identical in merge; Task 2 adds regression tests.
- File-scoped Knowledge replace: sibling \`knowledge/*.md\` files must remain untouched; Task 4 adds provider/service tests.
- Concurrent target change after approval: publish must transition to stale without writing; Task 3 adds stale-baseline tests.
- Binary/executable carry-forward: merge must preserve raw bytes and mode without text re-encoding; Task 1 adds core tests.
- Candidate/bundle lifecycle divergence: new Knowledge workflow must use Bundle as authoritative state; Task 5 adds integration tests proving review/publish delegate through the bundle record.

---

## File Structure

**Create**
- \`src/artifact-bundles.ts\` — generic file/snapshot/import/diff types, canonical tree hash, merge/replace planner.
- \`src/artifact-bundle-service.ts\` — generic preview/submit/review/stale/publish orchestration.
- \`src/artifact-bundle-publishing.ts\` — provider-neutral file action plan plus GitHub/GitLab adapters.
- \`src/artifact-bundle-adapters.ts\` — Skill and Knowledge adapters and target-scope normalization.
- \`tests/artifact-bundles.test.ts\` — generic merge/replace/hash/file-scope behavior.
- \`tests/artifact-bundle-service.test.ts\` — lifecycle/snapshot/stale tests.
- \`tests/artifact-bundle-publishing.test.ts\` — provider parity/action-plan tests.

**Modify**
- \`src/skill-bundles.ts\` — reduce to compatibility exports/helpers or Skill-specific validation wrappers.
- \`src/skill-bundle-service.ts\` — compatibility facade delegating to Artifact Bundle service until callers are migrated.
- \`src/skill-bundle-publishing.ts\` — compatibility exports only after provider migration.
- \`src/storage/skill-bundle-repository.ts\` — generalize TypeScript API to Artifact Bundle records while keeping physical table names.
- \`src/application.ts\` — route Skill and new Knowledge workflows through shared lifecycle.
- \`src/knowledge-submission.ts\` — expose Knowledge adapter-normalized bundle payload after spec validation.
- \`src/knowledge-publishing.ts\` — remove direct publication from new workflow; retain historical helpers only where required.
- \`src/observability.ts\` — add optional \`artifactBundleId\` metadata for new Knowledge candidate projections; bundle remains lifecycle authority.
- \`src/mcp.ts\` — add \`submission_mode\`, adapt Knowledge and Skill submission tools to shared service.
- \`src/server.ts\` — align admin Skill/Knowledge preview/import/review routes with shared service.
- \`src/admin-ui.ts\` — render common bundle mode/target/file diff while retaining kind metadata.
- Existing Skill/Knowledge tests listed below — update entrypoint and integration expectations.

---

### Task 1: Build the generic Artifact Bundle tree model and planner

**Files:**
- Create: \`src/artifact-bundles.ts\`
- Create: \`tests/artifact-bundles.test.ts\`
- Reference/modify: \`src/skill-bundles.ts\`

**Interfaces:**
- Produces: \`ArtifactKind = "skill" | "knowledge"\`
- Produces: \`ArtifactTargetKind = "file" | "directory"\`
- Produces: \`ArtifactSubmissionMode = "merge" | "replace"\`
- Produces: \`ArtifactBundleFile\`, \`ArtifactBundleSnapshot\`, \`ArtifactBundleDiff\`
- Produces: \`canonicalArtifactTreeHash(files): string\`
- Produces: \`diffArtifactTrees(before, after): ArtifactBundleDiff\`
- Produces: \`planArtifactFinalTree({ targetKind, mode, before, submitted }): ArtifactBundleFile[]\`

- [ ] **Step 1: Write failing generic planner tests**

Add tests named:
- \`merge_directory_preserves_omitted_files\`
- \`merge_directory_adds_and_overwrites_only_submitted_paths\`
- \`replace_directory_deletes_omitted_files\`
- \`file_scope_merge_and_replace_touch_only_one_entry\`
- \`merge_preserves_binary_bytes_and_execute_mode\`
- \`canonical_hash_is_stable_for_sorted_equivalent_trees\`
- \`case_collisions_and_invalid_paths_are_rejected\`

Assertions must include the original five-file Skill + one-new-file regression: final tree has six files, old hashes/modes unchanged, diff has one addition and zero deletions.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:
\`npm test -- --test-name-pattern="merge_directory|replace_directory|file_scope|canonical_hash" tests/artifact-bundles.test.ts\`

Expected: FAIL because \`src/artifact-bundles.ts\` does not exist.

- [ ] **Step 3: Implement the generic types and planner**

Implement the interfaces above in \`src/artifact-bundles.ts\`. Reuse the current path normalization, byte handling, mode validation, canonical hash, and diff semantics from \`src/skill-bundles.ts\`; the planner must overlay submitted files for merge and use only submitted files for directory replace.

- [ ] **Step 4: Make Skill tree helpers delegate to the generic core**

Keep public Skill-specific validation and \`SKILL.md\` summary logic in \`src/skill-bundles.ts\`, but re-export/translate generic file/hash/diff primitives rather than maintaining two algorithms.

- [ ] **Step 5: Run focused tests**

Run:
\`npm test -- tests/artifact-bundles.test.ts tests/skill-bundles.test.ts\`

Expected: PASS.

- [ ] **Step 6: Commit**

\`git add src/artifact-bundles.ts src/skill-bundles.ts tests/artifact-bundles.test.ts tests/skill-bundles.test.ts && git commit -m "refactor(bundle): add generic artifact tree core"\`

---

### Task 2: Generalize storage and implement shared submit/preview snapshot lifecycle

**Files:**
- Create: \`src/artifact-bundle-service.ts\`
- Modify: \`src/storage/skill-bundle-repository.ts\`
- Modify: \`src/skill-bundle-service.ts\`
- Create: \`tests/artifact-bundle-service.test.ts\`
- Modify: \`tests/skill-bundle-service.test.ts\`
- Modify: \`tests/skill-bundle-storage.test.ts\`

**Interfaces:**
- Produces: \`ArtifactBundleImport\` with \`kind\`, \`targetKind\`, \`targetRoot\`, \`submissionMode\`, \`targetRevision\`, \`targetScopeSha256\`, snapshot/review/publication fields.
- Produces: \`ArtifactBundleService.preview(principal, repository, adapter, input)\`
- Produces: \`ArtifactBundleService.submitDetailed(...)\`
- Consumes: Task 1 planner/hash/diff.
- Storage decision: keep physical \`skill_bundle_*\` tables; store generic fields in \`record_json\`, use existing indexed columns as legacy routing/search columns, and do not migrate historical Knowledge candidates. For new Knowledge rows use \`namespace="knowledge"\`, \`import_type="knowledge"\`, \`skill_path=NULL\`, and \`replacement_root=targetRoot\`; Knowledge snapshots store \`skills_json=[]\`. Skill rows keep their current \`skill|collection\` indexed values.

- [ ] **Step 1: Write failing service/storage tests**

Add tests:
- \`submit_merge_persists_complete_final_snapshot_not_overlay\`
- \`submit_replace_persists_complete_replacement_snapshot\`
- \`preview_merge_shows_no_deletion_for_omitted_files\`
- \`submission_defaults_to_merge_server_side\`
- \`unreadable_baseline_fails_closed\`
- \`repository_round_trips_skill_and_knowledge_bundle_records\`

The first test must start from a target containing \`SKILL.md\`, two references, executable script, and binary asset; submit only a new reference and assert snapshot contains all six files.

- [ ] **Step 2: Run tests and confirm RED**

Run:
\`npm test -- tests/artifact-bundle-service.test.ts tests/skill-bundle-storage.test.ts\`

Expected: FAIL on missing generic service/types.

- [ ] **Step 3: Generalize the repository TypeScript API**

Rename the class API to \`SqliteArtifactBundleRepository\` in-place (keep a compatibility export \`SqliteSkillBundleRepository\` temporarily). Persist generic record JSON using existing physical tables. Map Knowledge rows exactly to \`namespace="knowledge"\`, \`import_type="knowledge"\`, \`skill_path=NULL\`, \`replacement_root=targetRoot\`, and \`skills_json=[]\`. Do not add new physical tables or a database migration unless a failing test proves the current schema cannot represent the generic record.

- [ ] **Step 4: Implement shared preview and submit**

In \`ArtifactBundleService\`:
1. adapter resolves target scope and validates submitted payload;
2. materializer reads the baseline scope;
3. Task 1 planner builds the complete final tree;
4. adapter validates final tree;
5. service computes baseline/final hashes and diff;
6. submit stores the complete immutable snapshot and baseline metadata.

- [ ] **Step 5: Convert \`SkillBundleService\` into a compatibility facade**

Keep existing public methods used by application/server tests, but delegate to \`ArtifactBundleService\` with the Skill adapter. Default single Skill and collection submissions to merge unless explicit replace is passed by the new interface.

- [ ] **Step 6: Run focused Skill regressions**

Run:
\`npm test -- tests/artifact-bundle-service.test.ts tests/skill-bundle-service.test.ts tests/skill-bundle-storage.test.ts tests/skill-bundle-integration.test.ts\`

Expected: PASS, including the omitted-file regression.

- [ ] **Step 7: Commit**

\`git add src/artifact-bundle-service.ts src/storage/skill-bundle-repository.ts src/skill-bundle-service.ts tests/artifact-bundle-service.test.ts tests/skill-bundle-service.test.ts tests/skill-bundle-storage.test.ts tests/skill-bundle-integration.test.ts && git commit -m "feat(bundle): add shared merge snapshot lifecycle"\`

---

### Task 3: Unify review baseline and stale protection

**Files:**
- Modify: \`src/artifact-bundle-service.ts\`
- Modify: \`src/skill-bundle-service.ts\`
- Modify: \`tests/artifact-bundle-service.test.ts\`
- Modify: \`tests/skill-bundle-service.test.ts\`

**Interfaces:**
- Produces: \`review.targetRevision\`, \`review.targetScopeSha256\`, \`review.diffSha256\`
- Produces: \`ensureReviewFresh(...): ArtifactBundleImport\`
- Status contract: stale target -> \`review_stale\`, no publication attempt.

- [ ] **Step 1: Write failing stale-review tests**

Add:
- \`approval_records_the_baseline_shown_in_preview\`
- \`target_change_after_approval_marks_review_stale\`
- \`unchanged_target_scope_remains_publishable_even_if_unrelated_repo_content_changes\`
- \`approved_snapshot_is_not_remerged_against_new_target_content\`

- [ ] **Step 2: Run focused tests and confirm RED**

Run:
\`npm test -- --test-name-pattern="baseline|review_stale|not_remerged" tests/artifact-bundle-service.test.ts\`

Expected: at least the target-scope baseline cases fail.

- [ ] **Step 3: Implement baseline persistence and freshness check**

Persist the submission/preview target scope hash and revision in the import. Approval stores the exact preview diff hash and baseline. \`ensureReviewFresh\` rereads only the selected file/directory scope and marks stale on hash mismatch.

- [ ] **Step 4: Run focused tests**

Run:
\`npm test -- tests/artifact-bundle-service.test.ts tests/skill-bundle-service.test.ts\`

Expected: PASS.

- [ ] **Step 5: Commit**

\`git add src/artifact-bundle-service.ts src/skill-bundle-service.ts tests/artifact-bundle-service.test.ts tests/skill-bundle-service.test.ts && git commit -m "feat(bundle): bind review to target scope baseline"\`

---

### Task 4: Converge GitHub and GitLab publication on one file-action plan

**Files:**
- Create: \`src/artifact-bundle-publishing.ts\`
- Modify: \`src/skill-bundle-publishing.ts\`
- Modify: \`src/knowledge-publishing.ts\`
- Create: \`tests/artifact-bundle-publishing.test.ts\`
- Modify: \`tests/skill-bundle-publishing.test.ts\`
- Modify: \`tests/knowledge-publishing.test.ts\`

**Interfaces:**
- Produces: \`ArtifactFileAction = create | update | delete | chmod\`
- Produces: \`buildArtifactFileActions(before, finalSnapshot, targetKind): ArtifactFileAction[]\`
- Produces: \`ArtifactBundlePublisher.publish(record, snapshot, repository)\`
- Consumes: Task 1 canonical diff and Task 3 approved baseline.

- [ ] **Step 1: Write failing provider-neutral action tests**

Add:
- \`merge_action_plan_has_no_delete_for_omitted_file\`
- \`replace_directory_action_plan_deletes_only_omitted_paths\`
- \`file_scope_replace_has_no_sibling_delete\`
- \`github_and_gitlab_receive_equivalent_logical_actions\`
- \`publisher_rejects_changed_approved_baseline_before_writing\`

- [ ] **Step 2: Run publishing tests and confirm RED**

Run:
\`npm test -- tests/artifact-bundle-publishing.test.ts tests/skill-bundle-publishing.test.ts tests/knowledge-publishing.test.ts\`

Expected: FAIL on missing common action planner/publisher.

- [ ] **Step 3: Implement common action planning**

Build actions from baseline vs final immutable snapshot. For file scope, map the stable internal snapshot entry to the exact \`targetRoot\`. For directory scope, prefix relative paths with \`targetRoot/\`.

- [ ] **Step 4: Move provider mechanics behind the common publisher**

GitHub: remove the merge-path recursive \`replaceRoot\`; apply create/update/delete/chmod to the worktree and stage only target actions.

GitLab: generate API commit actions from the same \`ArtifactFileAction[]\`.

Retain PR/MR creation and reconciliation mechanics.

- [ ] **Step 5: Keep old publisher modules as thin compatibility exports**

Existing Skill/Knowledge callers still compile during migration, but direct new publication must flow through \`ArtifactBundlePublisher\`.

- [ ] **Step 6: Run publishing tests**

Run:
\`npm test -- tests/artifact-bundle-publishing.test.ts tests/skill-bundle-publishing.test.ts tests/knowledge-publishing.test.ts\`

Expected: PASS.

- [ ] **Step 7: Commit**

\`git add src/artifact-bundle-publishing.ts src/skill-bundle-publishing.ts src/knowledge-publishing.ts tests/artifact-bundle-publishing.test.ts tests/skill-bundle-publishing.test.ts tests/knowledge-publishing.test.ts && git commit -m "refactor(bundle): unify provider publication actions"\`

---

### Task 5: Add Skill and Knowledge adapters and make Bundle authoritative for new Knowledge lifecycle

**Files:**
- Create: \`src/artifact-bundle-adapters.ts\`
- Modify: \`src/knowledge-submission.ts\`
- Modify: \`src/application.ts\`
- Modify: \`src/observability.ts\`
- Modify: \`tests/knowledge-submission.test.ts\`
- Modify: \`tests/candidate-diff.test.ts\`
- Modify: \`tests/knowledge-workflow-integration.test.ts\`
- Modify: \`tests/candidate-publishing-routing.test.ts\`

**Interfaces:**
- Produces: \`SkillArtifactAdapter\`
- Produces: \`KnowledgeArtifactAdapter\`
- Knowledge adapter file scope: \`targetKind="file"\`, \`targetRoot=<exact .md path>\`
- Knowledge multi-file scope: \`targetKind="directory"\`, explicit directory target.
- New Knowledge projection metadata: optional \`artifactBundleId\`; for records carrying it, the Bundle record is the lifecycle authority. Candidate status returned to UI/API is projected from the Bundle state; candidate storage retains source/title/relation metadata only for compatibility.

- [ ] **Step 1: Write failing adapter and workflow tests**

Add assertions that:
- current Knowledge spec normalization yields a one-file artifact payload;
- updates/supersedes relation resolves the exact existing \`.md\` file;
- new Knowledge candidate creates one Artifact Bundle lifecycle record and stores its ID as metadata;
- candidate diff is derived from the bundle preview;
- list/detail responses project status/review/publication from the Bundle for new candidates;
- approve/publish operations delegate to the bundle lifecycle and do not invoke the direct Knowledge publisher;
- file-scope replace leaves a sibling Knowledge file untouched;
- multi-file Knowledge uses an explicit directory target.

- [ ] **Step 2: Run Knowledge workflow tests and confirm RED**

Run:
\`npm test -- tests/knowledge-submission.test.ts tests/candidate-diff.test.ts tests/knowledge-workflow-integration.test.ts tests/candidate-publishing-routing.test.ts\`

Expected: FAIL because new Knowledge still uses direct candidate lifecycle/publisher.

- [ ] **Step 3: Implement Skill and Knowledge adapters**

Skill adapter wraps existing normalize/scan/validate behavior.

Knowledge adapter calls \`KnowledgeSubmissionService.normalize()\`, resolves the current target logic from \`resolveKnowledgeCandidatePublishContext\`, and returns a file-scoped bundle for the existing single-document path.

- [ ] **Step 4: Route new Knowledge submission through Artifact Bundle service**

In \`application.ts\`, create the bundle import at submission time and keep relation/source/title metadata needed by existing candidate UI. Store \`artifactBundleId\`; new review/diff/publish methods load and operate on the Bundle. When returning/listing a new candidate, project its status/review/publication from the Bundle record instead of trusting the stored Candidate status. Do not call the direct Knowledge publisher for records with \`artifactBundleId\`.

- [ ] **Step 5: Preserve historical Knowledge behavior without migration**

If a historical candidate has no \`artifactBundleId\`, leave its current legacy behavior unchanged. Do not convert old rows. Keep this branch isolated at the application boundary; all new Knowledge submissions must have an artifact bundle ID.

- [ ] **Step 6: Run Knowledge tests**

Run:
\`npm test -- tests/knowledge-submission.test.ts tests/candidate-diff.test.ts tests/knowledge-workflow-integration.test.ts tests/candidate-publishing-routing.test.ts tests/knowledge-publishing.test.ts\`

Expected: PASS.

- [ ] **Step 7: Commit**

\`git add src/artifact-bundle-adapters.ts src/knowledge-submission.ts src/application.ts src/observability.ts tests/knowledge-submission.test.ts tests/candidate-diff.test.ts tests/knowledge-workflow-integration.test.ts tests/candidate-publishing-routing.test.ts && git commit -m "feat(bundle): route knowledge through artifact lifecycle"\`

---

### Task 6: Align MCP, admin API, and UI with shared Bundle semantics

**Files:**
- Modify: \`src/mcp.ts\`
- Modify: \`src/server.ts\`
- Modify: \`src/admin-ui.ts\`
- Modify: \`tests/knowledge-submission-mcp.test.ts\`
- Modify: \`tests/skill-bundle-entrypoints-e2e.test.ts\`
- Modify: \`tests/skill-bundle-admin-ui.test.ts\`
- Modify: \`tests/knowledge-submission-admin.test.ts\`
- Modify: \`tests/admin-candidate-actions-e2e.test.ts\`

**Interfaces:**
- Skill MCP: add \`submission_mode?: "merge" | "replace"\`, default server-side merge.
- Knowledge MCP: retain current title/content/spec input; add optional \`submission_mode\`, default merge; it creates a file-scoped Artifact Bundle.
- Admin payloads pass the same mode to shared application methods.
- UI shows kind, target scope, mode, target baseline, added/modified/deleted files.

- [ ] **Step 1: Write failing entrypoint tests**

Assert:
- Skill MCP with no mode forwards merge.
- Skill explicit replace forwards replace.
- Knowledge MCP with no mode creates a merge bundle.
- Admin Skill/Knowledge requests use the same mode semantics.
- Tool descriptions no longer instruct callers that every Skill submission must be a complete root unless replace is selected.

- [ ] **Step 2: Run entrypoint tests and confirm RED**

Run:
\`npm test -- tests/knowledge-submission-mcp.test.ts tests/skill-bundle-entrypoints-e2e.test.ts tests/knowledge-submission-admin.test.ts tests/skill-bundle-admin-ui.test.ts\`

Expected: FAIL on missing mode/common bundle fields.

- [ ] **Step 3: Update MCP schemas/descriptions**

Keep \`submit_skill_bundle\` and \`submit_knowledge_candidate\` entrypoint names to avoid unnecessary client churn, but route both to shared Bundle behavior. Update descriptions to explain merge default and explicit replace.

- [ ] **Step 4: Update admin endpoints and UI**

Pass \`submission_mode\` through preview/import/submission handlers. Render common artifact/bundle preview fields and exact deletion list so replace intent is visible before approval.

- [ ] **Step 5: Run entrypoint/UI tests**

Run:
\`npm test -- tests/knowledge-submission-mcp.test.ts tests/skill-bundle-entrypoints-e2e.test.ts tests/knowledge-submission-admin.test.ts tests/skill-bundle-admin-ui.test.ts tests/admin-candidate-actions-e2e.test.ts\`

Expected: PASS.

- [ ] **Step 6: Commit**

\`git add src/mcp.ts src/server.ts src/admin-ui.ts tests/knowledge-submission-mcp.test.ts tests/skill-bundle-entrypoints-e2e.test.ts tests/knowledge-submission-admin.test.ts tests/skill-bundle-admin-ui.test.ts tests/admin-candidate-actions-e2e.test.ts && git commit -m "feat(bundle): expose unified merge and replace workflows"\`

---

### Task 7: End-to-end regression, cleanup, and documentation

**Files:**
- Modify: \`docs/superpowers/specs/2026-10-31-skill-bundle-safe-merge-design.md\` — keep superseded marker only.
- Modify/add tests as required by failures from full suite.
- Modify legacy Skill/Knowledge files only to remove unreachable duplicate logic after all callers migrate.

**Interfaces:**
- Consumes all prior tasks.
- Produces no new public API; this task verifies the unified behavior and removes dead duplicate paths.

- [ ] **Step 1: Run targeted cross-kind acceptance suite**

Run:
\`npm test -- tests/artifact-bundles.test.ts tests/artifact-bundle-service.test.ts tests/artifact-bundle-publishing.test.ts tests/skill-bundle-service.test.ts tests/skill-bundle-publishing.test.ts tests/knowledge-workflow-integration.test.ts tests/knowledge-publishing.test.ts tests/candidate-diff.test.ts\`

Expected: PASS.

- [ ] **Step 2: Run full repository verification**

Run:
\`npm run format:check && npm run lint && npm run build && npm test\`

Expected: all commands PASS.

- [ ] **Step 3: Verify the exact user regression manually in a fixture/local repository**

Create an existing Skill containing five files; submit only one new reference in default mode; preview must show added=1, deleted=0; approved publication result must contain six files.

Also create two sibling Knowledge documents; replace one file-scoped Knowledge artifact and verify the sibling remains unchanged.

- [ ] **Step 4: Review for duplicate lifecycle/publication logic**

Search:
\`grep -R "replaceRoot\\|publishKnowledgeCandidate\\|SkillBundlePublisher\\|KnowledgePublisher" -n src\`

Remove only code paths proven unreachable for new submissions; retain explicit historical read/action compatibility where tests require it.

- [ ] **Step 5: Run final full verification again**

Run:
\`npm run check\`

Expected: PASS.

- [ ] **Step 6: Request whole-branch independent review**

Use Superpowers \`requesting-code-review\` against the complete branch. Fix all Critical/Important findings, rerun affected tests and \`npm run check\`.

- [ ] **Step 7: Commit final cleanup**

\`git add src tests docs/superpowers/specs/2026-10-31-skill-bundle-safe-merge-design.md && git commit -m "refactor(bundle): complete artifact bundle unification"\`
