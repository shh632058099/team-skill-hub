# Controlled Git Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend verified write-enabled Work into a controlled, revision-bound Git publication lifecycle that prepares one deterministic commit, requires explicit push approval, and pushes only a deterministic work branch without exposing Git credentials to the Agent.

**Architecture:** Publication is a durable side-effect phase owned by WorkOrchestrator and attached to a WorkAttempt. The Workspace owner Worker performs local commit preparation and push through platform-controlled Git code; Agent runtime remains limited to workspace editing. Publication Artifact and Approval bind the exact commit before push. PR/MR provider adapters are not implemented; only a provider-neutral interface is introduced.

**Tech Stack:** TypeScript, Node.js, SQLite, gRPC, Docker, Git CLI via argv-only child processes, node:test.

**Spec:** `docs/superpowers/specs/2026-11-10-controlled-git-publication-design.md`

**Highest-level spec:** `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`

## Global Constraints

- 2026-11-09 Work Orchestration spec is authoritative if any later document conflicts.
- workspace-write does not imply publication permission.
- Agent never receives publication credentials.
- Agent cannot choose remote, refspec, branch prefix, credential, commit SHA, or protected/default branch target.
- Publication policy and repository identity are pinned to the WorkAttempt.
- Local commit is prepared only from the exact current verified Workspace revision.
- Push requires explicit `publish_work_branch` Approval for the exact Publication Artifact.
- No force push, delete ref, wildcard refspec, merge, tag, submodule/LFS publication, GitHub adapter, or GitLab adapter.
- Push target is a deterministic platform-generated work branch.
- Existing Workflows without publication config remain unchanged.
- Existing ExpertTask API remains backward compatible.

## Review Focus

1. **Remote-ref race/conflict:** if remote branch changes between approval and push, publication must fail closed rather than force-overwrite.
2. **Workspace changed after commit preparation:** any new Workspace content must stale/block the prepared artifact and approval.
3. **Git content filters/autocrlf:** staging must not silently transform reviewed content; unsupported clean filters fail closed.
4. **Crash after remote push before DB update:** reconciliation must detect remote ref == approved commit and converge to pushed idempotently.
5. **Credential leakage:** credential material must never enter task result, Work events, Agent env, MCP detail, or normal logs.

---

### Task 1: Repository publication policy and pinning

**Files:**
- Modify: `src/expert-platform/expert-store.ts`
- Modify: `src/expert-platform/expert-dispatch-service.ts`
- Modify: `src/expert-platform/task-store.ts`
- Test: `tests/expert-platform-expert-store.test.ts`
- Test: `tests/expert-platform-dispatch-service.test.ts`
- Test: `tests/expert-platform-task-store.test.ts`

**Interfaces:**
- Adds `RepositoryPublicationPolicy`.
- Extends `ExpertSourceRepository` with optional `publicationPolicy`.
- Pinned dispatch/deployment snapshot carries exact publication policy version/content.
- Existing repositories without policy remain valid but cannot publish.

- [ ] **Step 1: Write failing store/dispatch tests**
  - valid policy requires version >=1, explicit permissions, safe branchPrefix, `allowForcePush=false`, `allowDeleteRef=false`.
  - repository with no policy remains valid.
  - invalid policy/ref prefix/permission is rejected.
  - dispatch snapshot pins publication policy and is unaffected by later Deployment edits.
  - credentialRef remains reference-only; no secret is copied into snapshot.

- [ ] **Step 2: Run RED**
  - Run focused expert-store/dispatch/task-store tests.

- [ ] **Step 3: Implement schema validation and immutable snapshot pinning**

- [ ] **Step 4: Run GREEN + build**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(git): pin repository publication policy"`

### Task 2: Durable WorkPublication store/state machine

**Files:**
- Create: `src/expert-platform/work-publication-store.ts`
- Test: `tests/expert-platform-work-publication-store.test.ts`

**Interfaces:**
- Produces `WorkPublicationRecord`.
- Produces `createPublication(...)`, `getPublication(...)`, `listPublications(...)`, `transitionPublication(...)`.
- States: `preparing|prepared|approved|pushing|pushed|blocked|failed|cancelled`.
- One active publication per WorkAttempt/repository.

- [ ] **Step 1: Write failing persistence/state-transition tests**
  - survives close/reopen.
  - invalid transition rejected.
  - duplicate create for same attempt/revision is idempotent.
  - different source revision cannot reuse prepared publication.
  - branch/publication IDs are immutable once persisted.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement SQLite store + indexes/events metadata**

- [ ] **Step 4: Run GREEN + build**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): add durable git publication state"`

### Task 3: Deterministic branch and commit metadata

**Files:**
- Create: `src/expert-platform/publication-policy.ts`
- Test: `tests/expert-platform-publication-policy.test.ts`

**Interfaces:**
- `buildWorkBranchName(prefix, workItemId, attemptSequence): string`.
- `buildPublicationCommitMetadata(input): { authorName; authorEmail; message; timestamp }`.
- `validatePublicationBranch(...)`.

- [ ] **Step 1: Write failing tests**
  - branch format is deterministic and safe.
  - invalid prefix/protected/default branch rejected.
  - no caller-supplied arbitrary branch.
  - same publication metadata yields identical commit identity inputs.
  - commit message includes Work-Item, Work-Attempt, Workspace-Revision and strips control characters.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement pure policy helpers**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(git): add deterministic publication metadata"`

### Task 4: Controlled local commit preparation

**Files:**
- Create: `src/expert-platform/git-publication-executor.ts`
- Test: `tests/expert-platform-git-publication-executor.test.ts`
- Modify: `src/expert-platform/repository-workspace.ts`

**Interfaces:**
- `prepareGitPublication(input): Promise<PreparedGitPublication>`.
- Input includes exact workspacePath, sourceSubjectRevision, expectedContentRevision, baseCommit, branchName, persisted commit metadata, pinned repository identity/policy.
- Output includes commitSha, treeSha, branchName.

- [ ] **Step 1: Write failing bare/local Git fixture tests**
  - exact verified Workspace mutation becomes one local commit on deterministic branch.
  - same metadata/content retry yields same commit SHA.
  - base mismatch rejects.
  - changed Workspace revision rejects.
  - unexpected extra remote rejects.
  - default/protected branch rejects.
  - Agent-visible Workspace permissions remain unchanged; publication code alone may modify .git.

- [ ] **Step 2: Add Review Focus test: unsupported clean filter**
  - repository path with active custom clean filter fails `PUBLICATION_CONTENT_FILTER_UNSUPPORTED`.

- [ ] **Step 3: Add content-equivalence test**
  - post-commit tree/change set must match approved WorkspaceChangeSummary; mismatch fails `PUBLICATION_CONTENT_MISMATCH`.

- [ ] **Step 4: Run RED**

- [ ] **Step 5: Implement argv-only Git operations**
  - fixed `core.autocrlf=false`, `core.safecrlf=true`, controlled empty hooks path.
  - no shell.
  - no remote side effect.

- [ ] **Step 6: Run GREEN + build**

- [ ] **Step 7: Commit**
  - `git commit -m "feat(git): prepare controlled work commits"`

### Task 5: Publication Artifact and revision binding

**Files:**
- Modify: `src/expert-platform/work-publication-store.ts`
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/expert-platform-work-publication-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Adds `PublicationArtifact` metadata to publication record or dedicated table.
- Artifact subject: `publication:<publicationId>:<commitSha>`.
- Records `artifact` Evidence bound to source `workspace:<digest>`.

- [ ] **Step 1: Write failing artifact tests**
  - prepared publication records immutable commit/tree/source revision.
  - artifact Evidence uses `artifactRef=publication:<id>`.
  - changing Work current workspace revision makes prepared publication stale/blocked.
  - old artifact cannot be approved for a new workspace revision.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement artifact creation and source-revision revalidation**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): bind publication artifacts to workspace revisions"`

### Task 6: Publication Approval scope

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/mcp.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`

**Interfaces:**
- Extends Approval scope with `publish_work_branch`.
- Extends subject type with `publication_artifact`.
- `approve_work` accepts this platform-owned scope/subject only when exact publication artifact exists.
- Actor/role remains authenticated-principal-derived.

- [ ] **Step 1: Write failing authorization tests**
  - exact publication subject can be approved.
  - `work_completion` approval cannot authorize push.
  - wrong/stale commit/publication ID rejected.
  - Worker readonly principal denied.
  - model cannot supply actor/role.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement approval validation**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): approve exact publication artifacts"`

### Task 7: Credential-isolated controlled push executor

**Files:**
- Extend: `src/expert-platform/git-publication-executor.ts`
- Modify: `src/expert-platform/worker-runtime-config.ts`
- Test: `tests/expert-platform-git-publication-executor.test.ts`
- Test: `tests/expert-platform-worker-runtime-config.test.ts`

**Interfaces:**
- `pushGitPublication(input): Promise<PushResult>`.
- Credential consumed only through pinned `credentialRef` resolved by Worker-side credential provider.
- Push refspec exactly `<commitSha>:refs/heads/<branchName>`.

- [ ] **Step 1: Write failing bare-remote push tests**
  - absent remote ref pushes successfully.
  - same remote SHA returns idempotent success.
  - different remote SHA throws `PUBLICATION_REF_CONFLICT`.
  - no force marker/wildcard/delete ref.
  - remote URL identity mismatch fails.
  - missing credentialRef for a policy requiring publication fails closed.

- [ ] **Step 2: Add credential-leakage test**
  - secret fixture never appears in command argv returned to logs/result, Work event details, or thrown error text.

- [ ] **Step 3: Run RED**

- [ ] **Step 4: Implement controlled remote check + push**
  - disable repository credential helper except the narrow controlled mechanism.
  - no shell.

- [ ] **Step 5: Run GREEN + build**

- [ ] **Step 6: Commit**
  - `git commit -m "feat(git): push approved work branches safely"`

### Task 8: Publication orchestration and owner affinity

**Files:**
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/expert-platform/worker-daemon.ts`
- Modify: `src/expert-platform/remote-worker.ts`
- Modify: `src/expert-platform/proto/expert-worker.proto`
- Modify: `src/expert-platform/grpc-transport.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-worker-daemon.test.ts`
- Test: `tests/expert-platform-grpc-transport.test.ts`

**Interfaces:**
- Orchestrator automatically prepares publication after current workspace Verification + accepted Review when Workflow publication is required.
- Push is scheduled only after exact `publish_work_branch` Approval.
- Publication operation is owner-Worker-affine.

- [ ] **Step 1: Write failing orchestration tests**
  - no publication before Review accepted.
  - prepare runs on workspace owner.
  - prepared waits for push Approval.
  - approval transitions to push scheduling.
  - owner offline blocks `PUBLICATION_WORKSPACE_UNAVAILABLE`.
  - publication never silently moves to another Worker.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement publication command/transport and reconciliation hooks**

- [ ] **Step 4: Run GREEN + existing Work continuation regression tests**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): orchestrate controlled git publication"`

### Task 9: Crash recovery and reconciliation

**Files:**
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/expert-platform/work-publication-store.ts`
- Test: `tests/work-orchestrator.test.ts`
- Test: `tests/expert-platform-work-publication-store.test.ts`

**Interfaces:**
- Reconciles `preparing/prepared/approved/pushing/pushed`.
- Remote truth is checked before retrying a `pushing` state.

- [ ] **Step 1: Write failing restart/recovery tests**
  - crash after local commit recovers prepared artifact.
  - crash after successful remote push but before DB update detects matching remote SHA and converges to pushed.
  - conflicting remote SHA after crash blocks.
  - stale workspace revision after preparation blocks.
  - bounded retry state does not produce duplicate push side effects.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement reconciliation transitions**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): reconcile git publication side effects"`

### Task 10: Publication Evidence and Completion Gate

**Files:**
- Modify: `src/expert-platform/work-orchestration-store.ts`
- Modify: `src/expert-platform/work-orchestrator.ts`
- Test: `tests/work-orchestration-store.test.ts`
- Test: `tests/work-orchestrator.test.ts`

**Interfaces:**
- Workflow gains optional `publication: { required: boolean; mode: "work_branch" }`.
- Completion token `publication_succeeded`.
- Push success records `publication` Evidence with publication subject.

- [ ] **Step 1: Write failing Gate tests**
  - publication-required Workflow cannot complete before push.
  - prepared + approved but not pushed remains incomplete.
  - pushed + current publication Evidence satisfies gate.
  - stale/failed publication Evidence does not satisfy gate.
  - non-publication Workflow behavior unchanged.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement Workflow schema + Gate evaluation + Evidence recording**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(work): gate completion on publication success"`

### Task 11: MCP/Admin publication visibility

**Files:**
- Modify: `src/expert-platform/work-orchestrator.ts`
- Modify: `src/mcp.ts`
- Modify: `src/server.ts`
- Modify: `src/expert-admin-ui.ts`
- Test: `tests/expert-platform-work-mcp-e2e.test.ts`
- Test: `tests/expert-platform-admin-e2e.test.ts`

**Interfaces:**
- `get_work/wait_work` expose publication state, source revision, branch, commit/tree SHA, artifactRef, approval state and push result/error.
- No credential fields.
- Admin displays prepared/approval-pending/pushed progression.

- [ ] **Step 1: Write failing visibility tests**
  - exact publication metadata visible.
  - secrets/credential refs are not exposed.
  - conflict/block reason visible.
  - legacy Work detail remains compatible.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Implement detail/UI**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(admin): show controlled publication state"`

### Task 12: Provider-neutral change request interface

**Files:**
- Create: `src/expert-platform/change-request-provider.ts`
- Test: `tests/expert-platform-change-request-provider.test.ts`

**Interfaces:**
- Exports `ChangeRequestProvider`, `CreateChangeRequestInput`, `ChangeRequestResult`.
- No GitHub/GitLab implementation.

- [ ] **Step 1: Write compile/shape tests**
  - input requires repository identity, pushed head branch/commit, base branch, title/body, idempotency key and credential grant ref.
  - no arbitrary clone URL field.
  - no merge operation.

- [ ] **Step 2: Run RED**

- [ ] **Step 3: Add provider-neutral interface only**

- [ ] **Step 4: Run GREEN**

- [ ] **Step 5: Commit**
  - `git commit -m "feat(git): define change request provider contract"`

### Task 13: Real acceptance and final review

**Files:**
- Modify docs only if live findings require operator guidance.
- Runtime acceptance uses a safe bare remote first; optional real authorized non-protected repository branch only if existing credentials/policy safely permit it.

- [ ] **Step 1: Bare-remote end-to-end acceptance**
  - submit publication-enabled Work.
  - Agent modifies harmless fixture.
  - Verification PASS.
  - Review accepted.
  - local Publication Artifact prepared.
  - exact `publish_work_branch` Approval submitted.
  - branch pushed to bare remote.
  - remote ref == commit SHA.
  - publication Evidence PASS.
  - Work completed.

- [ ] **Step 2: Idempotency acceptance**
  - restart Hub/Worker after remote push and before/around persistence boundary.
  - reconciliation returns same pushed state without a second conflicting side effect.

- [ ] **Step 3: Conflict acceptance**
  - pre-create conflicting remote work branch.
  - publication blocks with `PUBLICATION_REF_CONFLICT`; no force update.

- [ ] **Step 4: Security audit**
  - verify Agent env/events/results contain no publication secret.
  - verify push command has exact one-ref refspec.
  - verify protected/default branch untouched.

- [ ] **Step 5: Optional real repository acceptance**
  - only if an explicitly authorized safe test repository/branch is already available under the pinned policy.
  - no merge.

- [ ] **Step 6: Full gate**
  - `git diff --check && npm run check && npm run build`.
  - expected 0 failures.

- [ ] **Step 7: Whole-package review**
  - review against both 2026-11-09 Work Orchestration spec and 2026-10-19 repository/security constraints.
