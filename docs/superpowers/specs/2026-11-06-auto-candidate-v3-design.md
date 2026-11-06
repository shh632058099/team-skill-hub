# Auto Candidate v3 Design

## Intent

Replace the current `stop-evidence-v2` detector, whose production behavior is dominated by final-response markdown parsing, with a two-stage detector that first decides whether a completed engineering session is worth retaining and only later generates a Knowledge draft.

Current production evidence:
- 229 candidate detections, 0 created.
- 221/229 skipped as `summary-format-missing-title`.
- Existing Stop capture is healthy.
- Existing session evidence collection is active, but strong passing-test evidence is effectively absent.
- Therefore the failure is primarily detector design, not trigger delivery.

## Goals

- Do not require the assistant's final response to already be a Knowledge template.
- Use deterministic, explainable eligibility scoring for the first version.
- Prevent candidate floods in multi-user deployments with hard gates, quotas, deduplication and cooldown.
- Make every decision observable: score, signal breakdown, policy version, thresholds and admission reason.
- Roll out in shadow mode first; no Candidate creation in phase 1.
- Reuse existing Candidate persistence/review/publish/auto-relation paths when active mode is enabled later.

## Non-goals

- Phase 1 does not call a model to generate Knowledge drafts.
- Phase 1 does not create automatic Knowledge Candidates.
- Phase 1 does not auto-tune thresholds.
- Phase 1 does not replace manual/MCP Knowledge Candidate submission.
- Phase 1 does not introduce a new SQL table unless later evidence shows JSON-backed detection records are insufficient.

## Approaches considered

### A. Relax v2 markdown parsing
Smallest code change, but keeps final-response formatting as the primary eligibility signal. Rejected because production data already proves that this coupling is the main failure mode.

### B. Eligibility first, draft second
Selected. Stop gathers session evidence, evaluates deterministic eligibility, passes admission control, and only then would a later phase generate a structured Knowledge draft.

### C. Force clients to emit a hidden structured Knowledge summary
Keeps server logic simpler but tightly couples behavior to Codex/Claude hooks and client upgrades. Rejected because the server should own Knowledge policy and both clients must behave consistently.

## Architecture

Phase 1:

```text
Stop
  -> Session Evidence Collector
  -> Hard Gates
  -> Eligibility Score
  -> Admission Control
  -> shadow decision record only
```

Future active phase:

```text
Stop
  -> Evidence Collector
  -> Eligibility
  -> Admission
  -> Draft Generator
  -> Draft Quality Gate
  -> Pending Candidate merge/create
  -> Existing review/publish/auto-relation pipeline
```

## Module boundaries

Create:

- `src/auto-candidate/types.ts`
  - `AutoCandidatePolicy`
  - `CandidateEvidence`
  - `EligibilityResult`
  - `AdmissionResult`
  - score signal types

- `src/auto-candidate/evidence.ts`
  - Builds normalized `CandidateEvidence` from the existing client session timeline.
  - Knows about engineering actions, tests/builds/device validation, repository context and assistant conclusion signals.
  - Does not decide whether to create a Candidate.

- `src/auto-candidate/eligibility.ts`
  - Pure deterministic evaluator.
  - Applies hard gates and returns a 0-100 score plus explainable positive/negative signals.
  - No persistence, no quotas, no Candidate creation.

- `src/auto-candidate/admission.ts`
  - Applies per-session, per-user, per-repository and global quotas.
  - Applies pending-candidate duplicate/aggregation checks and cooldown.
  - Returns allow/deny/shadow outcome and explicit reason.

- `src/auto-candidate/policy-store.ts`
  - Runtime-configurable versioned policy store under `<data-dir>/config/auto-candidate-policy/`.
  - Follow the existing `KnowledgeSubmissionSpecStore` pattern: validation, atomic write, immutable history, serialized mutation queue.
  - This avoids environment-variable-only policy and supports live Admin tuning.

Modify:

- `src/application.ts`
  - Keep the Stop event registration.
  - Replace the large inline v2 detector path with orchestration of collector/evaluator/admission.
  - Phase 1 always records shadow decisions and never persists an automatic Candidate.
  - Keep v2 available only as historical detector data; do not run both detectors against one Stop unless explicitly enabled for comparison.

- `src/client-events.ts`
  - Improve normalized engineering evidence semantics.
  - Separate test/build/device-test from generic tool success.

- `src/claude-code-adapter.ts`
  - Produce evidence compatible with Codex hook semantics.

- `scripts/team-skill-hub-hook.sh`
- `scripts/team-skill-hub-hook.ps1`
  - Record enough bounded metadata to identify command category and successful validation without persisting raw sensitive commands.
  - Preserve redaction.

- `src/observability.ts`
  - Extend `CandidateDetectionRecord` with detector version, policy version, mode, score, thresholds, hard-gate results, signal breakdown and admission result.
  - Future active Candidate automation metadata may carry the same policy/score snapshot.

- `src/server.ts`
  - Admin policy GET/PUT/history/rollback endpoints.
  - Existing candidate detection endpoints expose richer records without changing storage schema.

- `src/admin-ui.ts`
  - Auto Candidate v3 settings and score/decision detail.
  - Show shadow distribution and projected creation counts.

Tests:
- `tests/auto-candidate-v3.test.ts` for pure eligibility/admission logic.
- Extend `tests/client-events-e2e.test.ts` for Stop -> shadow detection.
- Extend hook/adapter tests for normalized evidence.

## Evidence model

Engineering actions:
- `Edit`, `Write`, `apply_patch` are strong modification actions.
- `Bash` alone is not a modification signal; classify its semantic category first.
- Read/Grep/search-only sessions do not count as engineering modification.

Verification strengths:
- Strong: passing test command, device/SLT validation, explicit test counts with failed=0.
- Medium: successful build/package/static-analysis validation.
- Weak: read/grep/git status/diff alone.

The collector must preserve source tool, category, success, exit code, counts where available, and bounded status metadata.

## Hard gates

Default phase-1 requirements:
- Must have a reusable engineering result signal: root cause, verified fix, reusable workaround or reusable constraint.
- Must have meaningful engineering action OR a verified diagnostic result.
- Must have verification evidence; pure analysis without verification is shadow-skipped by default.
- Must not be obviously low-value formatting/rename-only work.
- Must have a repository context when repository-scoped quotas/dedup are required; missing repository does not crash the detector and is recorded explicitly.

Hard-gate failure produces a detection record and no score-based admission.

## Initial score model

Score is 0-100 and deterministic.

Suggested starting weights:
- explicit root cause: +25
- verified fix: +25
- strong passing test: +20
- device/SLT verification: +25
- successful build/package verification: +10
- meaningful Edit/Write/apply_patch: +10
- reusable applicability/constraint signal: +10
- verified workaround: +10
- no verification: -35
- analysis/search only: -30
- formatting/rename-only: -40
- near duplicate: admission-stage decision, not score penalty

Score is clamped to 0-100.

## Thresholds and modes

Default policy:

```json
{
  "schemaVersion": 1,
  "policyVersion": 1,
  "enabled": true,
  "mode": "shadow",
  "thresholds": {
    "shadowScore": 60,
    "createScore": 80,
    "duplicateSimilarity": 0.84
  },
  "requirements": {
    "requireReusableResult": true,
    "requireVerification": true
  },
  "limits": {
    "perSession": 1,
    "perUserPerHour": 2,
    "perUserPerDay": 5,
    "perRepositoryPerDay": 20,
    "globalPerHour": 30
  },
  "cooldown": {
    "sameRepositoryMinutes": 5
  }
}
```

Semantics:
- score < 60: skipped
- 60 <= score < 80: shadow-eligible, never create
- score >= 80: projected-create in shadow mode; active mode may proceed to draft generation
- all quota/duplicate checks are still evaluated in shadow mode so projected load is realistic

## Admission control

Admission is separate from eligibility.

Order:
1. per-session maximum
2. exact duplicate
3. near duplicate / pending-topic aggregation
4. same-repository cooldown
5. per-user/hour
6. per-user/day
7. per-repository/day
8. global/hour

A denied admission always records its reason. In shadow mode it records what would have happened without mutating Candidates.

For future active mode, a near match to an existing pending Candidate should attach evidence/session references rather than create another Candidate.

## Policy storage

Use the existing versioned-store pattern rather than environment variables:
- `<data-dir>/config/auto-candidate-policy/current.json`
- `<data-dir>/config/auto-candidate-policy/history/vN.json`

Requirements:
- strict validation
- atomic writes
- immutable version history
- serialized mutation
- rollback
- policy snapshot/version written into each detection record

Admin changes take effect for new Stop events without container restart.

## Observability

Each v3 detection record should contain:
- detector: `stop-evidence-v3`
- mode
- policyVersion
- score
- shadowScore/createScore
- hardGates
- scoreSignals: [{ id, delta, reason }]
- admission outcome/reason
- repository
- evidenceCount
- projectedAction: skip | shadow | create | aggregate

Dashboard metrics:
- Stop count
- hard-gate pass rate
- score buckets: <60, 60-79, 80+
- projected creates/day
- duplicate/aggregate projections
- quota rejections
- per-user and per-repository projected rates

This is required before active mode.

## Rollout

### Phase 1: shadow only
- v3 runs on live Stop events.
- no model calls.
- no automatic Candidate mutations.
- Admin can tune policy.
- collect enough live traffic to compare projected Candidate volume and signal quality.

### Phase 2: active admission + draft generation
Only after policy approval:
- enable Draft Generator after admission.
- model transforms evidence + assistant result into strict structured fields.
- model does not decide eligibility.
- validate draft with existing Knowledge submission rules.
- merge/aggregate into pending Candidate when applicable.

### Phase 3: threshold recommendation
Use human review outcomes to recommend score threshold changes. Never auto-apply threshold changes.

## Failure handling

- Policy file missing: use built-in conservative default policy.
- Invalid policy file: fail closed to shadow/disabled behavior and surface Admin error; never silently use a permissive policy.
- Evidence parser failure: record detector error/insufficient-evidence, do not create.
- Unknown tool/client: retain generic evidence but do not promote it to strong verification.
- Missing repository: record and skip repository quota checks only where safe; must not bypass global/user quotas.
- Duplicate lookup failure: fail closed for active creation.
- Admin policy mutation race: serialized store writes.
- Hook payload changes: adapter tests pin normalized evidence contracts.

## Compatibility

- Existing manual/MCP Candidate workflows remain unchanged.
- Existing v2 detection history stays readable.
- Existing Candidate JSON remains backward-compatible because new fields are optional.
- No SQL schema migration is required for phase 1 because detection details live in `record_json`.
- Existing Admin detection list continues to work; richer detail is additive.

## Builder decisions intentionally left open

- Exact command-category vocabulary for Bash evidence, provided it maps deterministically to test/build/device/other.
- Exact UI layout of the policy editor and score breakdown.
- Whether policy history uses a dedicated shared versioned-store helper or mirrors `KnowledgeSubmissionSpecStore` directly.


## Superpowers design review revisions

The builder review found several points that must be fixed before implementation. The design adopts the following decisions.

### 1. Shadow quota accounting must use detections, not Candidates

Phase 1 creates no Candidates, so quota simulation cannot count Candidate rows. Admission must maintain a virtual ledger derived from prior v3 detection records.

A prior detection consumes projected quota only when:
- detector is `stop-evidence-v3`
- projectedAction is `create`
- it falls inside the applicable time window

The ledger is keyed by actor/session/repository/global dimensions. This makes per-user/repository/global projected volume meaningful in shadow mode.

A policy change does not retroactively rewrite prior decisions. Dashboard reporting must group projected volume by `policyVersion` so threshold changes can be compared cleanly.

### 2. Add a daily global ceiling

The previous `globalPerHour: 30` is too permissive for a multi-user deployment. Initial defaults become:

```json
{
  "limits": {
    "perSession": 1,
    "perUserPerHour": 2,
    "perUserPerDay": 5,
    "perRepositoryPerHour": 5,
    "perRepositoryPerDay": 20,
    "globalPerHour": 10,
    "globalPerDay": 50
  }
}
```

These are safety ceilings, not target generation rates. The create threshold remains the primary quality control.

### 3. Shadow is a first-class detection outcome

Extend detection outcome to:
- `created`
- `skipped`
- `shadow`

Semantics:
- hard-gate failure or score below shadow threshold -> `skipped`
- any decision that would continue under active mode while policy mode is shadow -> `shadow`
- actual persisted automatic Candidate -> `created`

`projectedAction` remains `skip | create | aggregate`. This avoids mixing shadow observations into existing skipped KPI counts.

### 4. Bash semantic classification happens client-side without sending raw commands

Current hooks do not preserve enough command semantics to identify successful tests/builds reliably.

The hook may inspect `tool_input.command` locally, but must send only bounded categories such as:
- `test`
- `build`
- `package`
- `lint`
- `static-analysis`
- `device-test`
- `git-change`
- `other`

Raw Bash command text is not persisted as part of automatic-candidate evidence.

The server still validates/normalizes the category and never trusts a client-provided category as strong evidence without success/exit/test result context.

### 5. Do not make keyword-detected "reusable result" an absolute hard gate in phase 1

Without a model or strict Knowledge template, reliably deciding root-cause/fix/workaround from natural-language final responses is heuristic.

Phase 1 therefore uses reusable-result signals as score contributors, not an absolute gate.

Hard gates for phase 1 are:
- Stop contains a non-empty assistant result.
- The session contains meaningful engineering/diagnostic activity.
- Verification is present when `requireVerification=true`.
- It is not explicitly low-value-only work.

This avoids recreating the v2 zero-trigger problem with a different parser.

### 6. Duplicate/aggregation in phase 1 is deliberately limited

True topic aggregation is more reliable after a structured draft exists.

Phase 1:
- exact duplicate against existing Candidates may use normalized assistant-result text.
- near-duplicate against existing Candidates is observational only.
- shadow-vs-shadow topic clustering does not block admission in the first implementation.

Therefore the phase-1 projected-create metric is intentionally an upper bound. The dashboard must label it accordingly.

Phase 2, after Draft Generator exists, moves near-duplicate and pending-Candidate aggregation into the active admission path using the structured draft.

### 7. Policy-store approach matches the existing codebase

The proposed policy store is consistent with `KnowledgeSubmissionSpecStore`, which already implements:
- `<data-dir>/config/.../current.json`
- immutable version history
- atomic temp-file + rename writes
- serialized mutation queue
- rollback

The v3 policy store should follow this existing pattern rather than introducing a new persistence mechanism.

### 8. Existing SQL schema remains sufficient for phase 1

`candidate_detections.record_json` can carry the new score, signals, hard gates, policy snapshot and projected action.

No schema migration is required provided the `outcome` column is free text as it is today. Existing list/filter/KPI code must explicitly learn the new `shadow` outcome.

## Approval gate

No implementation plan or product-code changes should start until this design is approved.
