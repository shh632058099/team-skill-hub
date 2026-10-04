import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EvaluationRunStore,
  evaluateGate,
  loadEvaluationSnapshot,
  runEvaluationSuite,
  scanEvaluationSuites
} from "../src/evaluation.js";

async function makeEvaluationRepo(options: { breakPrompt?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-"));
  const review = path.join(root, "ota", "review");
  await mkdir(review, { recursive: true });
  await writeFile(
    path.join(review, "SKILL.md"),
    `---
schema_version: 1
name: ota-code-review
description: Review OTA APIs and call chains.
metadata:
  audience: [developer]
  domain: [ota]
  category: [code-review]
  keywords: [ota, api, review, call-chain]
  visibility: [internal]
  maturity: stable
  owner: ota-team
  priority: 90
---
# Review
Always report deletion risk.
`
  );
  await writeFile(
    path.join(review, "PROMPT.md"),
    `---
schema_version: 1
name: ota-code-review-prompt
description: OTA code review prompt.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [ota, api, review]
  category: [code-review]
  owner: ota-team
---
# Prompt
${options.breakPrompt ? "Review OTA." : "Review OTA and report deletion risk as Low, Medium, or High."}
`
  );
  await writeFile(
    path.join(root, "ota", "AGENT.yaml"),
    `schema_version: 1
name: ota-expert
description: OTA expert.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [ota, debugging, review]
  owner: ota-team
skills: [ota-code-review]
prompts: [ota-code-review-prompt]
tools: [git]
`
  );
  await writeFile(
    path.join(root, "ota", "EVALUATION.yaml"),
    `schema_version: 1
id: ota-regression
description: OTA golden regression.
cases:
  - id: skill-route
    target: skill
    operation: resolve
    query: OTA API review
    expect:
      selected: ota-code-review
  - id: prompt-contract
    target: prompt
    operation: get
    name: ota-code-review-prompt
    expect:
      contains:
        - deletion risk as Low, Medium, or High
  - id: agent-bindings
    target: agent
    operation: get
    name: ota-expert
    expect:
      skills: [ota-code-review]
      prompts: [ota-code-review-prompt]
      tools: [git]
`
  );
  return root;
}

test("evaluation suite passes deterministic golden cases", async () => {
  const root = await makeEvaluationRepo();
  const snapshot = await loadEvaluationSnapshot(root, "rd-skills", "candidate");
  assert.equal(snapshot.suites.length, 1);
  const result = runEvaluationSuite(snapshot, snapshot.suites[0]!);
  assert.equal(result.total, 3);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.passRate, 1);
});

test("baseline comparison detects candidate regression", async () => {
  const baselineRoot = await makeEvaluationRepo();
  const candidateRoot = await makeEvaluationRepo({ breakPrompt: true });
  const baseline = await loadEvaluationSnapshot(baselineRoot, "rd-skills", "baseline");
  const candidate = await loadEvaluationSnapshot(candidateRoot, "rd-skills", "candidate");
  const suite = candidate.suites[0]!;
  const baselineResult = runEvaluationSuite(baseline, suite);
  const candidateResult = runEvaluationSuite(candidate, suite, baselineResult);
  assert.equal(baselineResult.passed, 3);
  assert.equal(candidateResult.passed, 2);
  assert.equal(candidateResult.regression, true);
  assert.equal(candidateResult.baselineRevision, "baseline");
});

test("baseline comparison treats removed passing cases as regression", async () => {
  const root = await makeEvaluationRepo();
  const baseline = await loadEvaluationSnapshot(root, "rd-skills", "baseline");
  const candidate = await loadEvaluationSnapshot(root, "rd-skills", "candidate");
  const baselineSuite = baseline.suites[0]!;
  const candidateSuite = {
    ...candidate.suites[0]!,
    cases: candidate.suites[0]!.cases.slice(0, 2)
  };
  const baselineResult = runEvaluationSuite(baseline, baselineSuite);
  const candidateResult = runEvaluationSuite(candidate, candidateSuite, baselineResult);
  assert.equal(candidateResult.regression, true);
  assert.deepEqual(candidateResult.removedBaselineCases, ["agent-bindings"]);
});

test("knowledge retrieval evaluation reports Hit@1/3/5 and MRR regression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-eval-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(
    path.join(docs, "doc-a.md"),
    "# Recovery Checkpoint\n\nUnique phrase: amber checkpoint resume state machine.\n",
    "utf8"
  );
  await writeFile(
    path.join(docs, "doc-b.md"),
    "# Watchdog Timing\n\nUnique phrase: delta capacitor watchdog timing rule.\n",
    "utf8"
  );
  await writeFile(
    path.join(docs, "doc-c.md"),
    "# CVE Policy\n\nUnique phrase: cobalt six month CVE remediation policy.\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "EVALUATION.yaml"),
    `schema_version: 1
id: knowledge-retrieval
description: Knowledge retrieval regression.
cases:
  - id: recovery
    target: knowledge
    operation: search
    query: amber checkpoint resume state machine
    expect:
      selected: docs/doc-a.md
  - id: watchdog
    target: knowledge
    operation: search
    query: delta capacitor watchdog timing rule
    expect:
      selected: docs/doc-b.md
  - id: cve
    target: knowledge
    operation: search
    query: cobalt six month CVE remediation policy
    expect:
      selected: docs/doc-c.md
`,
    "utf8"
  );

  const baseline = await loadEvaluationSnapshot(root, "rd-skills", "baseline");
  const baselineResult = runEvaluationSuite(baseline, baseline.suites[0]!);
  assert.deepEqual(baselineResult.retrievalMetrics, {
    cases: 3,
    hitAt1: 1,
    hitAt3: 1,
    hitAt5: 1,
    mrr: 1
  });

  await writeFile(
    path.join(docs, "doc-b.md"),
    "# Unrelated Note\n\nGeneric maintenance note about storage cleanup and UI preferences.\n",
    "utf8"
  );
  const candidate = await loadEvaluationSnapshot(root, "rd-skills", "candidate");
  const candidateResult = runEvaluationSuite(candidate, candidate.suites[0]!, baselineResult);
  assert.equal(candidateResult.retrievalMetrics?.cases, 3);
  assert.equal(candidateResult.retrievalMetrics?.hitAt1, 2 / 3);
  assert.equal(candidateResult.retrievalMetrics?.hitAt3, 2 / 3);
  assert.equal(candidateResult.retrievalMetrics?.hitAt5, 2 / 3);
  assert.equal(candidateResult.retrievalMetrics?.mrr, 2 / 3);
  assert.equal(candidateResult.regression, true);
  assert.deepEqual(candidateResult.baselineRetrievalMetrics, baselineResult.retrievalMetrics);
});

test("evaluation gate supports blocking and warning thresholds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-gate-"));
  const docs = path.join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "a.md"), "# A\n\nalpha unique retrieval phrase\n", "utf8");
  await writeFile(path.join(docs, "b.md"), "# B\n\nbeta unique retrieval phrase\n", "utf8");
  await writeFile(
    path.join(root, "EVALUATION.yaml"),
    `schema_version: 1
id: gate
description: Gate thresholds.
cases:
  - id: a
    target: knowledge
    operation: search
    query: alpha unique retrieval phrase
    expect:
      selected: docs/a.md
  - id: b
    target: knowledge
    operation: search
    query: beta unique retrieval phrase
    expect:
      selected: docs/b.md
`,
    "utf8"
  );
  const snapshot = await loadEvaluationSnapshot(root, "rd-skills", "candidate");
  const result = runEvaluationSuite(snapshot, snapshot.suites[0]!);
  const passing = evaluateGate([result], {
    minPassRate: 1,
    minHitAt1: 0.9,
    warnMrr: 1
  });
  assert.equal(passing.ok, true);
  assert.equal(passing.blockingReasons.length, 0);

  const degraded = {
    ...result,
    retrievalMetrics: {
      ...result.retrievalMetrics!,
      hitAt1: 0.8,
      mrr: 0.85
    }
  };
  const blocked = evaluateGate([degraded], {
    minPassRate: 1,
    minHitAt1: 0.9
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.blockingReasons.join("\n"), /hitAt1/);

  const warned = evaluateGate([degraded], { warnHitAt1: 0.9 });
  assert.equal(warned.ok, true);
  assert.match(warned.warnings.join("\n"), /hitAt1/);

  const regression = { ...result, regression: true };
  const regressed = evaluateGate([regression], { minPassRate: 0 });
  assert.equal(regressed.ok, false);
  assert.match(regressed.blockingReasons.join("\n"), /baseline regression/);
});

test("evaluation run store persists and filters results", async () => {
  const root = await makeEvaluationRepo();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-eval-store-"));
  const snapshot = await loadEvaluationSnapshot(root, "rd-skills", "r1");
  const result = runEvaluationSuite(snapshot, snapshot.suites[0]!);
  const store = new EvaluationRunStore(dataDir);
  await store.append(result);
  assert.equal((await store.list(10, "rd-skills", "ota-regression")).length, 1);
  assert.equal((await store.get(result.runId))?.runId, result.runId);
});

test("evaluation suite parser rejects duplicate case ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-eval-invalid-"));
  await writeFile(
    path.join(root, "EVALUATION.yaml"),
    `schema_version: 1
id: invalid
description: Invalid suite.
cases:
  - id: duplicate
    target: skill
    operation: get
    name: a
    expect: {}
  - id: duplicate
    target: skill
    operation: get
    name: b
    expect: {}
`
  );
  await assert.rejects(() => scanEvaluationSuites(root, "rd-skills"), /duplicate or missing case id/);
});
