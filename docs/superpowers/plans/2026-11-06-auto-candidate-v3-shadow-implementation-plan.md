# Auto Candidate v3 Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `stop-evidence-v3` as a shadow-only automatic candidate detector that scores engineering sessions, simulates admission/quotas, exposes explainable decisions in Admin, and never creates an automatic Candidate in Phase 1.

**Architecture:** Keep the existing Stop hook/event pipeline, but move eligibility and admission logic into focused `src/auto-candidate/*` modules. Normalize client evidence first, evaluate deterministic hard gates and score second, then run a virtual admission ledger from prior v3 detections. Persist the complete shadow decision into existing candidate detection storage and expose runtime-configurable policy via a versioned JSON store modeled after `KnowledgeSubmissionSpecStore`.

**Tech Stack:** TypeScript, Node.js 24, Fastify, SQLite-backed observability JSON records, shell/PowerShell client hooks, built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-06-auto-candidate-v3-design.md`

## Global Constraints

- Phase 1 is shadow-only: no model calls and no automatic Knowledge Candidate creation.
- Detector id is exactly `stop-evidence-v3`.
- Default policy mode is `shadow`.
- Default thresholds: `shadowScore=60`, `createScore=80`, `duplicateSimilarity=0.84`.
- Default limits: perSession=1, perUserPerHour=2, perUserPerDay=5, perRepositoryPerHour=5, perRepositoryPerDay=20, globalPerHour=10, globalPerDay=50.
- Raw Bash command text must not be persisted in automatic-candidate evidence.
- Existing manual/MCP Candidate flows and v2 historical records must remain readable.
- Existing SQL schema stays unchanged in Phase 1; richer fields live in `record_json`.
- Invalid/missing policy must fail closed to conservative shadow behavior.
- Preserve unrelated `docker-compose.wsl2-override.yml`.

## Review Focus

1. A Stop with no repository context must still respect user/global quotas and must not crash repository admission.
2. Policy changes during an active quota window must not retroactively rewrite prior shadow detections; dashboard metrics must remain grouped by `policyVersion`.
3. Unknown client tools or malformed evidence must never be promoted to strong verification.
4. Repeated Stop events for the same session/turn must not consume projected quota twice.
5. Client-side command categorization must never leak raw Bash command text into the Hub payload or detection record.

---

### Task 1: Define v3 policy, evidence, eligibility, and admission types

**Files:**
- Create: `src/auto-candidate/types.ts`
- Create: `src/auto-candidate/policy-store.ts`
- Create: `tests/auto-candidate-policy.test.ts`

**Interfaces:**
- Produces:
  - `AutoCandidatePolicy`
  - `CandidateEvidence`
  - `EligibilityResult`
  - `AdmissionResult`
  - `ScoreSignal`
  - `defaultAutoCandidatePolicy(): AutoCandidatePolicy`
  - `validateAutoCandidatePolicy(input: unknown): AutoCandidatePolicy`
  - `AutoCandidatePolicyStore.loadCurrent(): Promise<AutoCandidatePolicy>`
  - `AutoCandidatePolicyStore.saveNext(input: AutoCandidatePolicy): Promise<AutoCandidatePolicy>`
  - `AutoCandidatePolicyStore.history(): Promise<AutoCandidatePolicy[]>`
  - `AutoCandidatePolicyStore.rollbackTo(version: number): Promise<AutoCandidatePolicy>`

- [ ] **Step 1: Write failing tests for policy defaults and validation**

Assert exact default values from Global Constraints, invalid thresholds/negative quotas rejection, and `mode: "shadow"`.

- [ ] **Step 2: Run tests and confirm RED**

Run:
`node --import tsx --test tests/auto-candidate-policy.test.ts`

Expected: FAIL because policy module/store does not exist.

- [ ] **Step 3: Implement `types.ts` and policy validation/store**

Follow `KnowledgeSubmissionSpecStore` conventions:
- `<data-dir>/config/auto-candidate-policy/current.json`
- `history/vN.json`
- atomic temp + rename
- immutable history
- serialized mutation queue
- strict validation

- [ ] **Step 4: Add failure-mode tests**

Cover missing file -> built-in default, corrupt JSON -> throws/fails closed, concurrent save serialization, rollback version history.

- [ ] **Step 5: Run tests and verify GREEN**

Run:
`node --import tsx --test tests/auto-candidate-policy.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

`git add src/auto-candidate/types.ts src/auto-candidate/policy-store.ts tests/auto-candidate-policy.test.ts && git commit -m "feat(auto-candidate): add v3 policy model"`

---

### Task 2: Normalize client engineering evidence consistently

**Files:**
- Create: `src/auto-candidate/evidence.ts`
- Modify: `src/client-events.ts`
- Modify: `src/claude-code-adapter.ts`
- Modify: `scripts/team-skill-hub-hook.sh`
- Modify: `scripts/team-skill-hub-hook.ps1`
- Modify: `tests/codex-hook-script.test.ts`
- Modify or extend: Claude adapter tests
- Create or extend: `tests/auto-candidate-v3.test.ts`

**Interfaces:**
- Consumes: `CandidateEvidence` types from Task 1.
- Produces:
  - `collectCandidateEvidence(input: { timeline: SessionTimelineItem[]; assistantResult: string; repositoryId?: string }): CandidateEvidence`
  - normalized evidence with bounded `category: "test" | "build" | "package" | "lint" | "static-analysis" | "device-test" | "git-change" | "other"`

- [ ] **Step 1: Write failing hook tests for local command classification**

For representative commands such as `npm test`, `pytest`, `ctest`, `cmake --build`, `bitbake`, assert payload includes only category/success/exit/count metadata and does not include raw command text.

- [ ] **Step 2: Write failing server normalization tests**

Assert:
- unknown tool + generic success remains generic/weak
- passing test counts become strong test evidence
- successful build becomes build verification
- Read/Grep never become engineering modification
- Bash alone is not a modification unless category indicates a meaningful action

- [ ] **Step 3: Run focused tests and confirm RED**

Run:
`node --import tsx --test tests/codex-hook-script.test.ts tests/auto-candidate-v3.test.ts`

Expected: FAIL on missing category/evidence behavior.

- [ ] **Step 4: Implement bounded client categorization and server normalization**

Inspect command locally in hooks, emit category only. Keep redaction and existing payload shape backward-compatible.

- [ ] **Step 5: Implement `collectCandidateEvidence(...)`**

Aggregate:
- engineering actions
- verification strength
- repository context
- assistant result presence
- reusable-result keyword signals
- low-value-only signals

- [ ] **Step 6: Add review-focus tests**

Cover malformed evidence, unknown categories, missing repository, no raw command persistence.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:
`node --import tsx --test tests/codex-hook-script.test.ts tests/auto-candidate-v3.test.ts tests/client-events-e2e.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

`git add src/auto-candidate/evidence.ts src/client-events.ts src/claude-code-adapter.ts scripts/team-skill-hub-hook.sh scripts/team-skill-hub-hook.ps1 tests && git commit -m "feat(auto-candidate): normalize v3 engineering evidence"`

---

### Task 3: Implement deterministic eligibility scoring and hard gates

**Files:**
- Create: `src/auto-candidate/eligibility.ts`
- Modify: `tests/auto-candidate-v3.test.ts`

**Interfaces:**
- Consumes: `CandidateEvidence`, `AutoCandidatePolicy`
- Produces:
  - `evaluateCandidateEligibility(evidence: CandidateEvidence, policy: AutoCandidatePolicy): EligibilityResult`

- [ ] **Step 1: Write failing table-driven scoring tests**

Pin exact starting weights:
- root cause +25
- verified fix +25
- passing test +20
- device/SLT +25
- build/package +10
- Edit/Write/apply_patch +10
- applicability/constraint +10
- verified workaround +10
- no verification -35
- analysis/search only -30
- formatting/rename-only -40

Assert score clamps to 0..100.

- [ ] **Step 2: Write failing hard-gate tests**

Assert:
- empty assistant result -> skipped
- no meaningful activity -> skipped
- verification required but absent -> skipped
- explicit low-value-only -> skipped
- reusable keyword missing alone does **not** hard-fail
- score 59 -> skipped
- score 60..79 -> shadow-eligible
- score >=80 -> projected-create before admission

- [ ] **Step 3: Run test and confirm RED**

Run:
`node --import tsx --test tests/auto-candidate-v3.test.ts`

- [ ] **Step 4: Implement pure evaluator**

No persistence and no Candidate access. Return:
- `score`
- `hardGates`
- `scoreSignals`
- `eligibleForShadow`
- `eligibleForCreateProjection`
- `reason`

- [ ] **Step 5: Run test and verify GREEN**

- [ ] **Step 6: Commit**

`git add src/auto-candidate/eligibility.ts tests/auto-candidate-v3.test.ts && git commit -m "feat(auto-candidate): add deterministic v3 scoring"`

---

### Task 4: Implement virtual shadow admission ledger and quotas

**Files:**
- Create: `src/auto-candidate/admission.ts`
- Modify: `src/observability.ts`
- Modify: observability SQLite repository/types if needed for richer detection query
- Modify: `tests/auto-candidate-v3.test.ts`
- Extend: observability tests

**Interfaces:**
- Consumes: `EligibilityResult`, `AutoCandidatePolicy`, prior v3 detection records
- Produces:
  - `evaluateShadowAdmission(input: { principal; sessionId; repositoryId?; eligibility; policy; recentDetections }): AdmissionResult`
  - `CandidateDetectionRecord.outcome: "created" | "skipped" | "shadow"`
  - new optional detection fields: `policyVersion`, `mode`, `score`, `thresholds`, `hardGates`, `scoreSignals`, `repositoryId`, `admission`, `projectedAction`

- [ ] **Step 1: Write failing quota tests**

Cover exact limits:
- same session second projected create denied
- user 3rd/hour denied
- user 6th/day denied
- repo 6th/hour denied
- repo 21st/day denied
- global 11th/hour denied
- global 51st/day denied

- [ ] **Step 2: Add policy-version and dedup tests**

Assert:
- prior detection only consumes virtual quota when detector=v3 and projectedAction=create
- duplicate same session/turn does not consume twice
- policy version remains attached to its original detection
- missing repository still enforces user/global quotas

- [ ] **Step 3: Run tests and confirm RED**

- [ ] **Step 4: Implement admission evaluator and richer detection schema**

Keep phase-1 duplicate behavior conservative:
- exact duplicate may be observed
- near duplicate is observational only
- no shadow-shadow clustering blocker

- [ ] **Step 5: Update existing KPI filtering**

Ensure `shadow` does not count as `skipped` in existing skipped/low-value metrics.

- [ ] **Step 6: Run focused observability and v3 tests**

Expected: PASS.

- [ ] **Step 7: Commit**

`git add src/auto-candidate/admission.ts src/observability.ts tests && git commit -m "feat(auto-candidate): add shadow admission controls"`

---

### Task 5: Wire v3 shadow detector into the Stop pipeline

**Files:**
- Modify: `src/application.ts`
- Modify: `tests/client-events-e2e.test.ts`

**Interfaces:**
- Consumes Tasks 1-4.
- Produces:
  - application-level `detectStopKnowledgeCandidateV3(event: ClientEventRecord): Promise<void>`
  - no automatic Candidate mutation in Phase 1

- [ ] **Step 1: Write failing e2e test for normal non-template final response**

Construct a Stop whose assistant result is ordinary prose, with meaningful engineering action and passing verification. Assert:
- a v3 detection is written
- outcome=`shadow`
- score/threshold/signals/admission present
- projectedAction=`create`
- no automatic Knowledge Candidate is created

- [ ] **Step 2: Write failing e2e skip tests**

Cover empty result, no verification, low-value-only task, score below threshold, duplicate Stop replay.

- [ ] **Step 3: Run e2e and confirm RED**

Run:
`node --import tsx --test tests/client-events-e2e.test.ts`

- [ ] **Step 4: Replace v2 live orchestration with v3 shadow orchestration**

Keep v2 records historical only. Do not run both against the same new Stop by default.

- [ ] **Step 5: Verify repository inference stays intact**

Use existing session project context/MCP inference; missing repository must not fail the detector.

- [ ] **Step 6: Run e2e + full v3 focused suite**

Expected: PASS and zero auto Candidate creation.

- [ ] **Step 7: Commit**

`git add src/application.ts tests/client-events-e2e.test.ts && git commit -m "feat(auto-candidate): run v3 detector in shadow mode"`

---

### Task 6: Add Admin policy APIs and shadow observability UI

**Files:**
- Modify: `src/application.ts`
- Modify: `src/server.ts`
- Modify: `src/admin-ui.ts`
- Create: `tests/auto-candidate-admin.test.ts`
- Modify: `tests/admin-ui-structure.test.ts`
- Modify: `tests/admin-routes.test.ts`

**Interfaces:**
- Produces Admin APIs:
  - `GET /admin/api/auto-candidate-policy`
  - `PUT /admin/api/auto-candidate-policy`
  - `GET /admin/api/auto-candidate-policy/history`
  - `POST /admin/api/auto-candidate-policy/rollback`
  - richer `GET /admin/api/candidate-detections`
  - extend existing `GET /admin/api/auto-candidate-quality` with v3 shadow metrics

- [ ] **Step 1: Write failing policy API tests**

Assert admin auth, current policy, invalid update rejection, version increment, history, rollback.

- [ ] **Step 2: Write failing metrics tests**

Assert v3 dashboard includes:
- Stop count
- hard-gate pass rate
- score buckets <60 / 60-79 / 80+
- projected creates/day
- quota rejection counts
- grouped policyVersion data
- projected create explicitly labeled as upper-bound estimate

- [ ] **Step 3: Write failing Admin UI structure tests**

Assert policy editor fields exist for thresholds/quotas/mode and detection detail exposes score breakdown.

- [ ] **Step 4: Run focused tests and confirm RED**

- [ ] **Step 5: Implement service/server APIs**

Use policy store from Task 1; changes apply to future Stop events without restart.

- [ ] **Step 6: Implement Admin UI**

Keep layout consistent with existing Settings/Observability pages. Do not redesign unrelated Admin UI.

- [ ] **Step 7: Run focused Admin tests and verify GREEN**

Run:
`node --import tsx --test tests/auto-candidate-admin.test.ts tests/admin-ui-structure.test.ts tests/admin-routes.test.ts`

- [ ] **Step 8: Commit**

`git add src/application.ts src/server.ts src/admin-ui.ts tests && git commit -m "feat(auto-candidate): add v3 shadow policy controls"`

---

### Task 7: Full verification and live shadow rollout check

**Files:**
- Modify only if verification exposes a defect.
- Update: `docs/superpowers/specs/2026-11-06-auto-candidate-v3-design.md` only if implementation discovered a material design correction.

**Interfaces:**
- Produces verified Phase-1 deployment behavior.

- [ ] **Step 1: Run static/script validation**

Run:
- `bash -n scripts/team-skill-hub-hook.sh`
- PowerShell syntax/static test through existing test coverage
- `git diff --check`

- [ ] **Step 2: Run focused v3 suites**

Run:
`node --import tsx --test tests/auto-candidate-policy.test.ts tests/auto-candidate-v3.test.ts tests/auto-candidate-admin.test.ts tests/codex-hook-script.test.ts tests/client-events-e2e.test.ts`

Expected: PASS.

- [ ] **Step 3: Run project quality gates**

Run:
- `npm run format:check`
- `npm run lint`
- `npm run build`
- `npm test`

Expected: all PASS.

- [ ] **Step 4: Deploy with existing WSL2 deployment workflow**

Use the repository's existing `deploy-local-wsl2.sh` path. Do not alter unrelated local override files.

- [ ] **Step 5: Verify live policy defaults**

Confirm Admin reports:
- detector v3
- mode shadow
- createScore 80
- global/hour 10
- global/day 50

- [ ] **Step 6: Generate representative live sessions**

Exercise at least:
1. normal prose + code change + successful test
2. read-only analysis
3. code change without verification
4. low-value formatting-only work

Expected:
- no automatic Candidates created
- v3 detection records show explainable scores/outcomes
- first case projects create if score >=80
- others skip/shadow as designed

- [ ] **Step 7: Inspect projected volume**

Query Admin/SQLite and verify shadow quota ledger counts match the detection records and do not double-count repeated Stop events.

- [ ] **Step 8: Request code review**

Use `superpowers:requesting-code-review` against the complete Phase-1 diff.

- [ ] **Step 9: Apply only verified review findings, rerun full verification**

- [ ] **Step 10: Final commit(s) and handoff**

Do not enable active Candidate creation. Document that Phase 2 remains gated on observed shadow quality and projected volume.

## Self-review result

- Spec coverage: all approved Phase-1 requirements map to Tasks 1-7.
- Type consistency: policy/evidence/eligibility/admission interfaces are defined once in Task 1 and consumed by later tasks.
- Review Focus coverage: missing repository, policy-version accounting, malformed evidence, duplicate Stop, and raw-command leakage each have an explicit test owner.
- Scope control: model Draft Generator, active automatic Candidate creation, automatic threshold tuning, and true topic aggregation are explicitly excluded.
- Proportion: plan stays at interfaces/tests/commands level and does not prescribe implementation bodies.
