# Controlled Git Publication Design

> Date: 2026-11-10
> Status: Proposed
> Scope: Team Skill Hub Expert Platform / Work Orchestration
> Highest-level specification: `docs/superpowers/specs/2026-11-09-work-orchestration-design.md`
> Security/Repository constraints: `docs/superpowers/specs/2026-10-19-expert-platform-design.md`
> Depends on: `docs/superpowers/specs/2026-11-10-write-enabled-work-design.md`

## 1. Intent

Extend a verified write-enabled WorkAttempt into a controlled Git publication lifecycle without giving the Agent Git credentials or unrestricted repository side-effect permissions.

Target lifecycle:

```
Agent edits isolated Workspace
        |
        v
Verification + ReviewDecision
        |
        v
prepare publication
  create deterministic work branch locally
  create one controlled commit locally
  produce Publication Artifact
        |
        v
Approval(publish_work_branch, exact commit/artifact)
        |
        v
Controlled Publication Executor
  revalidate pinned repository policy
  push only approved work-branch refspec
        |
        v
Publication Evidence
        |
        v
Completion Gate
```

This package implements **local commit preparation + push of a work branch + publication artifact/evidence**.

It defines a provider-neutral PR/MR creation contract for later use, but does **not** implement GitHub/GitLab adapters and does **not** merge.

## 2. Governing constraints

The design is subordinate to the 2026-11-09 Work Orchestration specification.

The following existing decisions remain mandatory:

- WorkItem owns the durable business lifecycle.
- WorkAttempt owns the solution attempt and Workspace.
- Workspace is a first-class object and remains pinned to the WorkAttempt.
- Evidence must bind the exact verified subject and becomes stale when that subject changes.
- ReviewDecision, Approval and TaskFeedback are separate concepts.
- Approval must bind an explicit revision / Artifact.
- Completion Gate cannot treat Agent success as sufficient evidence.
- Existing ExpertTask APIs remain backward compatible.

The 2026-10-19 Expert Platform design additionally requires:

- source-code repositories use a security boundary distinct from Skill/Knowledge repositories;
- Deployment-to-repository authorization controls branch/push/PR capabilities;
- repository identity, remote URL, base commit, policy revision and credential use are pinned;
- Git credentials never enter model prompts, Agent env, Workspace files or ordinary logs;
- push/PR is revalidated by controlled platform code;
- Expert automation may create branches, commits, push work branches and create PRs when authorized;
- protected-branch merge is not an Expert permission.

## 3. Goals

1. Create a local Git commit from the exact verified Workspace revision using platform-controlled Git operations.
2. Produce a durable, auditable Publication Artifact before any remote side effect.
3. Require explicit human Approval for the exact commit/artifact before push.
4. Push only a deterministic, policy-approved work branch.
5. Make push retry idempotent and fail closed on remote ref conflict.
6. Keep Git credentials outside Agent execution.
7. Pin repository/publication policy to the WorkAttempt so hot configuration changes do not silently change an in-flight Work.
8. Record publication outcome as Evidence usable by Completion Gate.
9. Keep PR/MR creation provider-neutral in the domain model so future GitHub/GitLab adapters do not change Work semantics.
10. Preserve read-only and non-publication workflows unchanged.

## 4. Non-goals

This package does not implement:

- GitHub Pull Request API calls;
- GitLab Merge Request API calls;
- Jira integration;
- automatic merge;
- force push;
- push to default/protected branches;
- rebase or merge of upstream changes;
- cross-repository WorkAttempt mutation;
- Agent-visible Git credentials;
- arbitrary Agent Git commands;
- branch deletion;
- tag publication;
- submodule/LFS publication;
- fork publication.

Those require later provider/security work.

## 5. Approaches considered

### A. Agent performs commit and push

Rejected.

It would require exposing Git identity/credentials or a powerful Git tool directly to model-controlled execution. Ref validation, idempotency, protected-branch policy and audit would become difficult to guarantee.

### B. Worker Controlled Publication Executor — selected for first implementation

The Worker already owns the physical Workspace. Platform code, not the Agent, prepares the commit and performs an approved push.

Pros:

- simplest path from the existing WorkAttempt Workspace;
- no source transfer;
- credentials remain outside model context;
- deterministic branch/ref validation is straightforward;
- publication can be retried on the Workspace owner.

Cons:

- publication execution initially depends on the Workspace owner Worker;
- long-term credential/policy logic should move behind a Broker boundary.

### C. Dedicated Hub Git Broker

Long-term target, not required in this package.

The interfaces in this design deliberately separate Publication Request/Policy/Executor from Agent runtime so the Worker implementation can later become a Broker without changing WorkItem semantics.

## 6. Core model

Add a durable publication object:

```ts
type WorkPublication = {
  publicationId: string;
  workItemId: string;
  workAttemptId: string;
  workspaceId: string;

  state:
    | "preparing"
    | "prepared"
    | "approved"
    | "pushing"
    | "pushed"
    | "blocked"
    | "failed"
    | "cancelled";

  sourceSubjectRevision: string; // workspace:<digest>
  baseCommit: string;

  repositoryId: string;
  repositoryIdentityRevision: number | null;
  publicationPolicyRevision: number;

  branchName: string;
  commitSha: string | null;
  treeSha: string | null;

  artifactRef: string | null;

  pushRemoteName: "origin";
  pushRefspec: string;

  ownerWorkerId: string;

  preparedAt: number | null;
  approvedAt: number | null;
  pushedAt: number | null;

  lastErrorCode: string | null;
  lastErrorContext: string | null;

  createdAt: number;
  updatedAt: number;
};
```

Publication is not a second Task system. It is a durable side-effect phase attached to one WorkAttempt.

Relationship:

```
WorkItem
  |
  +-- WorkAttempt
        |
        +-- Workspace
        +-- ExpertTask / Runs / Turns
        +-- Evidence
        +-- ReviewDecision
        +-- Publication
              |
              +-- Publication Artifact
              +-- Approval
              +-- Publication Evidence
```

A WorkAttempt has at most one active publication for one repository in this package.

## 7. Publication policy

Publication capability is **not** derived from Runtime Profile.

`workspace-write` means only that an Agent may mutate its isolated Workspace. It does not imply branch/commit/push rights.

Introduce a pinned repository publication policy associated with the Deployment-to-repository binding:

```ts
type RepositoryPublicationPolicy = {
  version: number;

  permissions: Array<
    | "prepare-commit"
    | "push-work-branch"
    | "create-change-request"
  >;

  branchPrefix: string;       // e.g. "skillhub/work/"
  protectedBranches: string[];
  allowedPushRemote: "origin";

  credentialRef?: string;

  allowForcePush: false;
  allowDeleteRef: false;
};
```

Initial implementation requires:

```
prepare-commit
push-work-branch
```

`create-change-request` is stored/reserved for future provider adapters.

The policy is pinned into the WorkAttempt dispatch/publication snapshot. Runtime configuration changes affect only new WorkAttempts, except an explicit security revocation may block new publication side effects.

### Current repository schema bridge

The current implementation stores source repository entries within ExpertDeployment. This package may extend the deployment repository binding representation to carry publication policy, but it must preserve the semantic boundary from the 2026-10-19 spec:

- repository identity/credential metadata and publication authorization are separate concepts;
- repository presence alone never grants push permission;
- later migration to a first-class SourceRepository Registry must not require changing WorkPublication or WorkOrchestrator semantics.

## 8. Deterministic work branch

The branch is generated by platform code, never by the Agent.

Recommended format:

```
<branchPrefix><workItemShort>-a<attemptSequence>
```

Example:

```
skillhub/work/b74d243f-a1
```

Rules:

- ASCII safe branch characters only;
- branch prefix comes only from pinned policy;
- Work ID and attempt sequence come from durable Work state;
- caller cannot supply an arbitrary full ref;
- target must be under `refs/heads/<branchPrefix>`;
- target may not equal the default branch or any configured protected branch;
- `git check-ref-format --branch` must pass;
- no delete refspec;
- no force marker `+`.

The branch name is persisted before commit preparation and reused across retries.

## 9. Prepare publication: local commit only

Prepare is a controlled platform operation with **no remote side effect**.

Preconditions:

- WorkAttempt is the active/latest eligible attempt;
- Workspace state is ready/retained and owned by the executing Worker;
- current subject is exactly `workspace:<contentRevision>`;
- required Verification Evidence for that revision is current and passed;
- ReviewDecision is `accepted` for that exact workspace revision;
- repository policy allows `prepare-commit`;
- Workspace change summary is non-empty;
- no stale/rejected publication exists for the current revision.

Procedure:

1. Recompute Workspace content revision.
2. Require exact equality with Work current subject revision.
3. Verify Workspace base commit equals the pinned base commit.
4. Revalidate origin remote identity against pinned repository snapshot.
5. Reject unexpected extra remotes.
6. Reject submodule/LFS publication unless explicitly supported later.
7. Create/reset only the deterministic local work branch to the pinned base commit.
8. Stage only repository content from the current Workspace.
9. Create one platform-controlled commit.
10. Record commit SHA and tree SHA.
11. Verify the commit tree exactly represents the approved Workspace content.
12. Create the Publication Artifact.
13. Transition publication `preparing -> prepared`.

### Content-preserving Git policy

The first implementation must not silently transform reviewed Workspace bytes while staging. Publication runs with platform-controlled Git configuration:

```
core.autocrlf=false
core.safecrlf=true
core.hooksPath=<empty controlled directory>
credential.helper=<disabled except controlled publication credential path>
```

Before staging, inspect attributes/config relevant to clean/smudge conversion. If a tracked or added path resolves to an unsupported `filter` clean/smudge rule, fail closed with `PUBLICATION_CONTENT_FILTER_UNSUPPORTED`.

After commit:

- `git status --porcelain=v1 --untracked-files=all` must show no content delta relative to the prepared commit other than platform-internal ignored metadata;
- the set of committed paths must equal the approved Workspace change set;
- deletion/addition/modification status must match the approved WorkspaceChangeSummary;
- if this equivalence cannot be demonstrated, publication becomes blocked and no push is permitted.

This keeps the Publication Artifact tied to the content that was actually reviewed rather than relying on Git conversion defaults.

The Agent never invokes these operations.

### Git metadata

The Publication Executor may write `.git` metadata; Agent containers may not.

The publication phase runs outside the Agent sandbox under Worker-controlled code.

## 10. Deterministic commit identity and retry

Commit preparation must be idempotent.

Persist publication metadata **before** invoking Git:

```
publicationId
branchName
commitAuthor
commitMessage
commitTimestamp
sourceSubjectRevision
baseCommit
```

Use platform-owned commit identity, for example:

```
Team Skill Hub <team-skill-hub@local.invalid>
```

Commit message is sanitized and deterministic:

```
<Work title>

Work-Item: <workItemId>
Work-Attempt: <workAttemptId>
Workspace-Revision: <workspace digest>
```

The persisted `commitTimestamp` is reused on retries via Git author/committer date so repeated preparation against unchanged content produces the same commit SHA.

If a prepared commit already exists:

- same source subject + same tree + same commit SHA -> idempotent success;
- different current workspace revision -> publication is stale/blocked and a new preparation is required;
- existing branch pointing elsewhere -> fail closed.

## 11. Publication Artifact

A prepared commit produces a durable Artifact envelope.

Initial Artifact may be stored as structured metadata in the Work runtime DB; it does not require copying repository contents.

```ts
type PublicationArtifact = {
  artifactId: string;
  kind: "git_commit";
  workItemId: string;
  workAttemptId: string;
  publicationId: string;

  sourceSubjectRevision: string; // workspace:<digest>
  repositoryId: string;
  baseCommit: string;

  branchName: string;
  commitSha: string;
  treeSha: string;

  publicationPolicyRevision: number;
  createdAt: number;
};
```

Evidence records:

```
type = artifact
status = passed
source = worker_verified
artifact_ref = publication:<publicationId>
subject_revision = workspace:<digest>
```

The Artifact proves which commit was prepared from which verified Workspace revision.

## 12. Approval for push

Add a new platform-defined approval scope:

```
publish_work_branch
```

and subject type:

```
publication_artifact
```

Approval binds:

```
publicationId
commitSha
source workspace revision
repository identity
branchName
publication policy revision
```

At the WorkApproval storage boundary, the subject revision is represented as a stable publication subject:

```
publication:<publicationId>:<commitSha>
```

The publication record itself carries the source Workspace revision and policy details.

Rules:

- approval is explicit human/admin/developer authorization;
- Worker/Agent cannot self-approve;
- Approval for `work_completion` does not automatically authorize push;
- A publication-enabled Workflow should normally require `publish_work_branch` Approval rather than requiring both `work_completion` and `publish_work_branch`. `work_completion` remains optional and is required only when the Workflow explicitly lists both approval scopes.
- Approval for `publish_work_branch` does not authorize merge;
- commit/artifact changes invalidate the approval;
- publication policy revision changes after approval require revalidation; a security revocation blocks push.

## 13. Controlled push

Push is the first remote side effect in this lifecycle.

Before every push attempt, revalidate:

1. publication state is `approved` or retryable `pushing`;
2. exact Approval exists for the publication artifact;
3. Work/Attempt/Workspace/publication identities still match;
4. commit SHA exists locally and tree matches Artifact;
5. repository remote URL/identity matches pinned snapshot;
6. publication policy still permits `push-work-branch`;
7. target ref is the persisted deterministic branch;
8. target is not protected/default branch;
9. credentialRef is from pinned repository publication policy;
10. credential material is available only to the controlled Git process.

Push command semantics:

```
git push origin <commitSha>:refs/heads/<branchName>
```

No force push.
No wildcard refspec.
No caller-supplied remote.
No credential helper from repository config.
No Git hooks.

### Credential isolation

Credential/token/private key must not appear in:

- Agent environment;
- prompt;
- Workspace tracked/untracked files;
- Work result text;
- normal events/logs;
- MCP payloads.

Credential use follows the existing Worker credential-ref mechanism or a narrow publication credential provider. The interface must be compatible with later Git Broker delegation.

## 14. Push idempotency and conflict handling

Before push, query remote ref using controlled Git.

Cases:

### Remote ref absent

Perform normal push.

### Remote ref already equals `commitSha`

Treat as idempotent success.

### Remote ref points to another commit

Fail closed:

```
PUBLICATION_REF_CONFLICT
```

Do not force update it.

### Network/provider failure

Keep publication retryable with durable backoff.

The publication state machine makes a process crash after a successful remote push recoverable: reconciliation checks the remote ref and converges to `pushed`.

## 15. Publication Evidence and Completion Gate

Successful push records Evidence:

```
type = publication
status = passed
source = worker_verified
artifact_ref = publication:<publicationId>
subject_revision = publication:<publicationId>:<commitSha>
```

Add a structural Workflow completion requirement:

```ts
publication?: {
  required: boolean;
  mode: "work_branch";
}
```

and Completion Gate token:

```
publication_succeeded
```

For publication-enabled Work, recommended gate:

```
latest_work_attempt_succeeded
required_evidence_passed
no_unresolved_blocker
review_accepted
required_approvals_approved
publication_succeeded
```

The corresponding `requiredApprovals` entry is normally:

```
scope = publish_work_branch
subjectType = publication_artifact
```

A separate `work_completion` approval is not implied. A Workflow may explicitly require both scopes, in which case both exact, non-stale approvals are required.

Important ordering:

- Workspace review/verification makes publication preparation eligible.
- Publication Artifact is prepared.
- Push Approval approves the exact Artifact.
- Push occurs.
- Work completes only after publication success when the Workflow requires publication.

A workflow that does not require publication keeps current behavior unchanged.

## 16. WorkItem state semantics

Do not introduce a parallel top-level Task system.

The WorkItem may remain in `waiting_review` while waiting for publication Approval.

During remote side-effect execution:

```
waiting_review
  -> running (publication side effect)
  -> completed
```

or:

```
running
  -> blocked(publication_*)
```

Publication internal state captures finer detail; WorkItem status remains the coarse lifecycle from the 2026-11-09 spec.

## 17. Reconciliation and crash recovery

Publication is reconciled by WorkOrchestrator just like other durable Work state.

Reconciliation cases:

- `preparing`: inspect local branch/commit; resume or converge.
- `prepared`: wait for Approval.
- `approved`: schedule push on Workspace owner Worker.
- `pushing`: check remote ref before retrying.
- `pushed`: ensure publication Evidence exists, then re-evaluate Completion Gate.
- owner Worker unavailable: `blocked(workspace_unavailable)`.
- Workspace missing: fail closed; do not reconstruct publication from guessed content.

No remote side effect occurs from a purely in-memory transition.

## 18. Worker affinity

Initial publication requires the physical Workspace and local prepared commit, so it is owner-affine:

```
publication.owner_worker_id == workspace.owner_worker_id
```

Do not silently move publication to another Worker.

This matches the 2026-11-09 first-stage Workspace rule.

Future Artifact checkpoint/rehydration can remove this affinity without changing publication domain objects.

## 19. Provider-neutral change request contract

Define the interface now, but do not implement a provider adapter in this package:

```ts
interface ChangeRequestProvider {
  create(input: {
    repositoryIdentity: string;
    headBranch: string;
    headCommit: string;
    baseBranch: string;
    title: string;
    body: string;
    idempotencyKey: string;
    credentialGrantRef: string;
  }): Promise<{
    provider: string;
    externalId: string;
    url: string;
    headCommit: string;
    baseBranch: string;
  }>;
}
```

The provider must not receive arbitrary repository URL/ref values from the Agent; all values derive from pinned publication policy/artifact.

Future adapters:

- GitHub Pull Request;
- GitLab Merge Request.

They consume a successfully pushed Publication Artifact.

No generic provider implementation is required now.

## 20. Merge boundary

Merge is explicitly outside this package.

Neither Agent, Worker Publication Executor nor future PR/MR creator receives protected-branch merge authority.

Future merge flow must have its own:

- CI Evidence;
- current PR/MR head SHA;
- code-owner/human Review;
- merge-specific Approval;
- protected branch/provider policy;
- stale-on-head-change behavior.

A `publish_work_branch` Approval can never satisfy a future merge gate.

## 21. MCP API

### Existing submit_work

No `push=true` caller flag.

Publication behavior comes from the selected Workflow and pinned repository publication policy.

### prepare_work_publication

Prefer Orchestrator-driven automatic preparation once workspace Review/Verification prerequisites pass.

If an explicit MCP action is exposed, it may only request reconciliation/preparation; it may not supply branch names, commit SHAs, remote URLs or credential refs.

### approve_work

Extend platform-defined Approval schema with:

```
approvalScope = publish_work_branch
subjectType = publication_artifact
subjectRevision = publication:<publicationId>:<commitSha>
```

Actor/role remain authenticated principal-derived.

### get_work / wait_work

Expose:

- publication state;
- source Workspace revision;
- branch name;
- commit SHA;
- tree SHA;
- artifact ref;
- approval state;
- push result/error;
- future change-request summary.

Never expose credentials.

## 22. Admin UI

Work detail adds a Publication section:

- state;
- repository ID;
- policy revision;
- source Workspace revision;
- branch name;
- commit SHA/tree SHA;
- artifact;
- Approval;
- push attempts/outcome;
- future PR/MR link.

Admin should make the distinction visible:

```
Workspace accepted
Commit prepared
Push approval pending
Branch pushed
```

No merge button in this package.

## 23. Error/blocker semantics

Deterministic blockers include:

```
PUBLICATION_NOT_ALLOWED
PUBLICATION_POLICY_MISSING
PUBLICATION_POLICY_CHANGED
PUBLICATION_SOURCE_STALE
PUBLICATION_WORKSPACE_UNAVAILABLE
PUBLICATION_REPOSITORY_MISMATCH
PUBLICATION_BASE_MISMATCH
PUBLICATION_BRANCH_INVALID
PUBLICATION_REF_CONFLICT
PUBLICATION_APPROVAL_REQUIRED
PUBLICATION_APPROVAL_STALE
PUBLICATION_CREDENTIAL_UNAVAILABLE
PUBLICATION_UNSUPPORTED_REPOSITORY_FEATURE
PUBLICATION_CONTENT_FILTER_UNSUPPORTED
PUBLICATION_CONTENT_MISMATCH
```

Transient errors include controlled Git network/provider failures and use bounded retry/backoff.

Authorization/policy/conflict errors never retry indefinitely.

## 24. Security invariants

1. workspace-write does not imply publication permission.
2. Agent never receives Git publication credentials.
3. Agent cannot choose remote, refspec, branch prefix or credential.
4. Branch name is platform-generated and pinned.
5. Base commit is pinned.
6. Repository identity and publication policy revision are pinned.
7. Local commit is created only from the exact current verified Workspace revision.
8. Push requires an Approval for the exact Publication Artifact.
9. Approval for Workspace completion is not Push Approval.
10. Push is non-force and single-ref.
11. Protected/default branch is never a target.
12. Existing conflicting remote branch is never overwritten.
13. Crash recovery checks remote truth before retrying.
14. Git hooks and repository credential helpers cannot expand authority.
15. Publication events/logs never contain secret material.
16. PR/MR creation does not imply merge authority.
17. merge remains a separate future Gate.

## 25. Backward compatibility

- Existing read-only Workflows unchanged.
- Existing workspace-write Workflows without publication config still complete using current Review/Approval Gate.
- Existing ExpertTask API unchanged.
- Existing Runtime Profiles unchanged.
- Existing Deployments without publication policy cannot push and fail closed if selected by a publication-required Workflow.
- Existing repository credential refs remain usable for clone/read according to current semantics; publication use requires explicit publication policy permission.

## 26. Implementation boundary

This package should implement:

1. RepositoryPublicationPolicy schema/pinning.
2. WorkPublication durable store/state machine.
3. deterministic work branch generation.
4. controlled local commit preparation.
5. Publication Artifact.
6. publication-specific Approval scope/subject.
7. controlled credential-isolated push.
8. push idempotency/conflict detection.
9. publication Evidence.
10. publication Completion Gate.
11. reconciliation/restart recovery.
12. MCP/Admin visibility.
13. provider-neutral ChangeRequestProvider interface only.
14. real local/bare-remote acceptance and one real authorized repository acceptance if a safe non-protected test branch is available.

It should not implement concrete GitHub/GitLab provider adapters or merge.

## 27. Acceptance criteria

### Local preparation

- approved workspace content creates exactly one deterministic branch/commit.
- commit tree matches the verified Workspace content.
- retry with unchanged publication metadata produces the same commit SHA.
- Agent cannot write `.git` or perform publication.

### Authorization

- publication-required Workflow with no publication policy blocks.
- policy without `push-work-branch` blocks push.
- no push Approval blocks push.
- stale/wrong artifact Approval blocks push.
- worker/Agent cannot self-approve.

### Push

- push target is only the deterministic work branch.
- push to protected/default branch is impossible.
- force push is impossible.
- absent branch pushes successfully.
- same remote SHA is idempotent success.
- different remote SHA produces `PUBLICATION_REF_CONFLICT`.
- credentials are absent from Agent/env/log payloads.

### Durability

- process restart after local commit preserves prepared publication.
- process restart after remote push but before DB update reconciles remote ref and converges to pushed.
- unavailable owner Worker blocks rather than moving publication.

### Work semantics

- publication Evidence is durable.
- publication-required Workflow does not complete before successful push.
- non-publication Workflow remains unchanged.
- PR/MR provider contract can consume the pushed Artifact without reading Agent state.

## 28. Builder calls

Implementation may choose:

- exact SQLite table/index layout;
- exact sanitized commit message formatting;
- exact branch short-ID length;
- whether Artifact metadata uses a dedicated artifact table now or a publication table plus Evidence `artifactRef`;
- exact bounded retry schedule;
- exact credential adapter shape, provided credentials remain outside Agent/model control.

Implementation may **not** choose:

- force push;
- arbitrary caller branch/ref;
- Agent-held Git credentials;
- merging;
- bypassing exact Artifact Approval;
- reusing `work_completion` Approval as push authorization.
