import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EvaluationRunStore,
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
