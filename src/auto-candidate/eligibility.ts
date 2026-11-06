import type { AutoCandidatePolicy, CandidateEvidence, EligibilityResult, ScoreSignal } from "./types.js";

function scoreSignal(signals: ScoreSignal[], id: string, delta: number, reason: string): void {
  signals.push({ id, delta, reason });
}

export function evaluateCandidateEligibility(
  evidence: CandidateEvidence,
  policy: AutoCandidatePolicy,
): EligibilityResult {
  const meaningfulActivity =
    evidence.engineeringActions.editCount +
      evidence.engineeringActions.writeCount +
      evidence.engineeringActions.patchCount +
      evidence.engineeringActions.meaningfulBashCount >
    0;

  const hardGates: Record<string, boolean> = {
    assistantResult: Boolean(evidence.assistantResult.trim()),
    meaningfulActivity,
    verification: !policy.requirements.requireVerification || evidence.verification.any,
    lowValue: !evidence.resultSignals.lowValueOnly,
    reusableResult: true,
  };

  const fail = (reason: string): EligibilityResult => ({
    score: 0,
    hardGates,
    scoreSignals: [],
    eligibleForShadow: false,
    eligibleForCreateProjection: false,
    reason,
  });

  if (!hardGates.assistantResult) return fail("missing-assistant-result");
  if (!hardGates.meaningfulActivity) return fail("no-meaningful-activity");
  if (!hardGates.verification) return fail("verification-required");
  if (!hardGates.lowValue) return fail("low-value-only");

  const scoreSignals: ScoreSignal[] = [];
  if (evidence.resultSignals.rootCause) scoreSignal(scoreSignals, "root-cause", 25, "explicit root cause");
  if (evidence.resultSignals.verifiedFix) scoreSignal(scoreSignals, "verified-fix", 25, "verified fix");
  if (evidence.verification.strongTest) scoreSignal(scoreSignals, "passing-test", 20, "passing test verification");
  if (evidence.verification.deviceTest) scoreSignal(scoreSignals, "device-test", 25, "device/SLT verification");
  if (evidence.verification.buildOrPackage)
    scoreSignal(scoreSignals, "build-package", 10, "successful build/package verification");
  if (
    evidence.engineeringActions.editCount +
      evidence.engineeringActions.writeCount +
      evidence.engineeringActions.patchCount >
    0
  ) {
    scoreSignal(scoreSignals, "engineering-change", 10, "meaningful edit/write/patch");
  }
  if (evidence.resultSignals.reusableConstraint)
    scoreSignal(scoreSignals, "reusable-constraint", 10, "reusable applicability/constraint");
  if (evidence.resultSignals.workaround) scoreSignal(scoreSignals, "workaround", 10, "verified workaround");
  if (!evidence.verification.any) scoreSignal(scoreSignals, "no-verification", -35, "no verification");
  if (evidence.resultSignals.analysisOnly) scoreSignal(scoreSignals, "analysis-only", -30, "analysis/search only");
  if (evidence.resultSignals.lowValueOnly) scoreSignal(scoreSignals, "low-value-only", -40, "low-value-only work");

  const score = Math.max(
    0,
    Math.min(
      100,
      scoreSignals.reduce((sum, item) => sum + item.delta, 0),
    ),
  );
  const eligibleForShadow = score >= policy.thresholds.shadowScore;
  const eligibleForCreateProjection = score >= policy.thresholds.createScore;

  return {
    score,
    hardGates,
    scoreSignals,
    eligibleForShadow,
    eligibleForCreateProjection,
    reason: eligibleForShadow
      ? eligibleForCreateProjection
        ? "score-meets-create-threshold"
        : "score-meets-shadow-threshold"
      : "score-below-shadow-threshold",
  };
}
