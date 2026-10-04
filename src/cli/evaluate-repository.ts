import path from "node:path";
import {
  evaluateGate,
  loadEvaluationSnapshot,
  runEvaluationSuite,
  type EvaluationGateThresholds
} from "../evaluation.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function ratioArg(name: string): number | undefined {
  const value = arg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(name + " must be a number between 0 and 1");
  }
  return parsed;
}

const repositoryPath = arg("--path");
if (!repositoryPath) {
  console.error(
    "Usage: npm run evaluate:repo -- --path <repo> [--id <id>] [--suite <suite>] [--baseline-path <repo>] [--revision <label>] [--baseline-revision <label>] [--min-pass-rate 0..1] [--warn-pass-rate 0..1] [--min-hit-at-1 0..1] [--warn-hit-at-1 0..1] [--min-hit-at-3 0..1] [--warn-hit-at-3 0..1] [--min-hit-at-5 0..1] [--warn-hit-at-5 0..1] [--min-mrr 0..1] [--warn-mrr 0..1]"
  );
  process.exit(2);
}

const repositoryId = arg("--id") ?? path.basename(path.resolve(repositoryPath));
const revision = arg("--revision") ?? "candidate";
const baselinePath = arg("--baseline-path");
const baselineRevision = arg("--baseline-revision") ?? "baseline";
const suiteFilter = arg("--suite");
const thresholds: EvaluationGateThresholds = {
  minPassRate: ratioArg("--min-pass-rate"),
  warnPassRate: ratioArg("--warn-pass-rate"),
  minHitAt1: ratioArg("--min-hit-at-1"),
  warnHitAt1: ratioArg("--warn-hit-at-1"),
  minHitAt3: ratioArg("--min-hit-at-3"),
  warnHitAt3: ratioArg("--warn-hit-at-3"),
  minHitAt5: ratioArg("--min-hit-at-5"),
  warnHitAt5: ratioArg("--warn-hit-at-5"),
  minMrr: ratioArg("--min-mrr"),
  warnMrr: ratioArg("--warn-mrr")
};

try {
  const candidate = await loadEvaluationSnapshot(
    path.resolve(repositoryPath),
    repositoryId,
    revision
  );
  const selectedSuites = suiteFilter
    ? candidate.suites.filter((suite) => suite.id === suiteFilter)
    : candidate.suites;
  if (selectedSuites.length === 0) {
    throw new Error(
      suiteFilter
        ? `Evaluation suite not found: ${suiteFilter}`
        : "Repository contains no EVALUATION.yaml"
    );
  }

  const baseline = baselinePath
    ? await loadEvaluationSnapshot(path.resolve(baselinePath), repositoryId, baselineRevision)
    : undefined;
  const results = selectedSuites.map((suite) => {
    const baselineSuite = baseline?.suites.find((item) => item.id === suite.id);
    const baselineRun = baselineSuite ? runEvaluationSuite(baseline!, baselineSuite) : undefined;
    return runEvaluationSuite(candidate, suite, baselineRun);
  });
  const missingBaselineSuites = baseline
    ? baseline.suites
        .filter((suite) => !candidate.suites.some((candidateSuite) => candidateSuite.id === suite.id))
        .map((suite) => suite.id)
    : [];
  const total = results.reduce((sum, result) => sum + result.total, 0);
  const passed = results.reduce((sum, result) => sum + result.passed, 0);
  const failed = results.reduce((sum, result) => sum + result.failed, 0);
  const regressions = results.filter((result) => result.regression).length;
  const gate = evaluateGate(results, thresholds, missingBaselineSuites);
  const output = {
    ok: gate.ok,
    repository: repositoryId,
    revision,
    baselineRevision: baseline ? baselineRevision : undefined,
    missingBaselineSuites,
    gate,
    suites: results,
    summary: {
      suites: results.length,
      total,
      passed,
      failed,
      regressions
      ,missingBaselineSuites: missingBaselineSuites.length
    }
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exit(1);
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        repository: repositoryId,
        error: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
}
