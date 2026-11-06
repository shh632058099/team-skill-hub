import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEngineeringEvidence } from "../src/client-events.js";

test("engineering evidence honors bounded semantic command category", () => {
  const testEvidence = normalizeEngineeringEvidence("Bash", {
    command_category: "test",
    exit_code: 0,
    success: true,
  });
  assert.equal(testEvidence?.type, "test");
  assert.equal(testEvidence?.success, true);

  const buildEvidence = normalizeEngineeringEvidence("Bash", {
    command_category: "build",
    exit_code: 0,
    success: true,
  });
  assert.equal(buildEvidence?.type, "build");
});

test("unknown command category does not become strong verification", () => {
  const evidence = normalizeEngineeringEvidence("Bash", {
    command_category: "definitely-not-supported",
    exit_code: 0,
    success: true,
  });
  assert.equal(evidence?.type, "tool");
});

import { collectCandidateEvidence } from "../src/auto-candidate/evidence.js";

test("collector treats Read/Grep-only activity as analysis, not engineering modification", () => {
  const evidence = collectCandidateEvidence({
    assistantResult: "只读分析发现一个可能原因。",
    timeline: [
      {
        kind: "event",
        event: {
          event: "PostToolUse",
          actorId: "u1",
          tenantId: "t1",
          sessionId: "s1",
          metadata: {
            tool_name: "Read",
            engineering_evidence: {
              type: "tool",
              sourceTool: "Read",
              success: true,
              exitCode: 0,
            },
          },
        },
      },
    ],
  });
  assert.equal(evidence.engineeringActions.editCount, 0);
  assert.equal(evidence.engineeringActions.meaningfulBashCount, 0);
  assert.equal(evidence.resultSignals.analysisOnly, true);
  assert.equal(evidence.verification.any, false);
});

test("collector accepts missing repository and recognizes build/test verification", () => {
  const evidence = collectCandidateEvidence({
    assistantResult: "根因已确认，修复完成并验证。",
    timeline: [
      {
        kind: "event",
        event: {
          event: "PostToolUse",
          actorId: "u1",
          tenantId: "t1",
          sessionId: "s2",
          metadata: {
            tool_name: "Edit",
            engineering_evidence: { type: "git_change", sourceTool: "Edit", success: true },
          },
        },
      },
      {
        kind: "event",
        event: {
          event: "PostToolUse",
          actorId: "u1",
          tenantId: "t1",
          sessionId: "s2",
          metadata: {
            tool_name: "Bash",
            engineering_evidence: {
              type: "test",
              sourceTool: "Bash",
              success: true,
              exitCode: 0,
              counts: { passed: 12, failed: 0 },
            },
          },
        },
      },
    ],
  });
  assert.equal(evidence.repositoryId, undefined);
  assert.equal(evidence.engineeringActions.editCount, 1);
  assert.equal(evidence.verification.strongTest, true);
  assert.equal(evidence.resultSignals.rootCause, true);
  assert.equal(evidence.resultSignals.verifiedFix, true);
});

import { evaluateCandidateEligibility } from "../src/auto-candidate/eligibility.js";
import { defaultAutoCandidatePolicy } from "../src/auto-candidate/policy-store.js";
import type { CandidateEvidence } from "../src/auto-candidate/types.js";

function baseEvidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    sessionId: "s-score",
    actorId: "u-score",
    tenantId: "t-score",
    assistantResult: "根因已确认，已修复并完成验证，适用范围明确。",
    engineeringActions: { editCount: 1, writeCount: 0, patchCount: 0, meaningfulBashCount: 1 },
    verification: { strongTest: true, deviceTest: false, buildOrPackage: false, any: true },
    resultSignals: {
      rootCause: true,
      verifiedFix: true,
      workaround: false,
      reusableConstraint: true,
      lowValueOnly: false,
      analysisOnly: false,
    },
    evidence: [],
    ...overrides,
  };
}

test("eligibility scoring uses deterministic starting weights and clamps to 100", () => {
  const result = evaluateCandidateEligibility(baseEvidence(), defaultAutoCandidatePolicy());
  assert.equal(result.score, 90);
  assert.deepEqual(
    result.scoreSignals.map((item) => [item.id, item.delta]),
    [
      ["root-cause", 25],
      ["verified-fix", 25],
      ["passing-test", 20],
      ["engineering-change", 10],
      ["reusable-constraint", 10],
    ],
  );
  assert.equal(result.eligibleForShadow, true);
  assert.equal(result.eligibleForCreateProjection, true);

  const maxed = evaluateCandidateEligibility(
    baseEvidence({
      verification: { strongTest: true, deviceTest: true, buildOrPackage: true, any: true },
      resultSignals: {
        rootCause: true,
        verifiedFix: true,
        workaround: true,
        reusableConstraint: true,
        lowValueOnly: false,
        analysisOnly: false,
      },
    }),
    defaultAutoCandidatePolicy(),
  );
  assert.equal(maxed.score, 100);
});

test("eligibility hard gates reject missing result, activity, verification, and low-value-only work", () => {
  const policy = defaultAutoCandidatePolicy();

  assert.equal(
    evaluateCandidateEligibility(baseEvidence({ assistantResult: "   " }), policy).reason,
    "missing-assistant-result",
  );

  assert.equal(
    evaluateCandidateEligibility(
      baseEvidence({
        engineeringActions: { editCount: 0, writeCount: 0, patchCount: 0, meaningfulBashCount: 0 },
        resultSignals: {
          rootCause: true,
          verifiedFix: false,
          workaround: false,
          reusableConstraint: false,
          lowValueOnly: false,
          analysisOnly: true,
        },
      }),
      policy,
    ).reason,
    "no-meaningful-activity",
  );

  assert.equal(
    evaluateCandidateEligibility(
      baseEvidence({ verification: { strongTest: false, deviceTest: false, buildOrPackage: false, any: false } }),
      policy,
    ).reason,
    "verification-required",
  );

  assert.equal(
    evaluateCandidateEligibility(
      baseEvidence({
        resultSignals: {
          rootCause: false,
          verifiedFix: false,
          workaround: false,
          reusableConstraint: false,
          lowValueOnly: true,
          analysisOnly: false,
        },
      }),
      policy,
    ).reason,
    "low-value-only",
  );
});

test("missing reusable-result keyword is not a hard gate", () => {
  const evidence = baseEvidence({
    resultSignals: {
      rootCause: false,
      verifiedFix: false,
      workaround: false,
      reusableConstraint: false,
      lowValueOnly: false,
      analysisOnly: false,
    },
  });
  const result = evaluateCandidateEligibility(evidence, defaultAutoCandidatePolicy());
  assert.equal(result.hardGates.reusableResult, true);
  assert.notEqual(result.reason, "missing-reusable-result");
});

test("eligibility respects shadow and create thresholds", () => {
  const base = defaultAutoCandidatePolicy();
  const score70Policy = {
    ...base,
    thresholds: { ...base.thresholds, shadowScore: 60, createScore: 80 },
  };
  const result = evaluateCandidateEligibility(
    baseEvidence({
      resultSignals: {
        rootCause: true,
        verifiedFix: false,
        workaround: false,
        reusableConstraint: true,
        lowValueOnly: false,
        analysisOnly: false,
      },
      engineeringActions: { editCount: 1, writeCount: 0, patchCount: 0, meaningfulBashCount: 1 },
      verification: { strongTest: true, deviceTest: false, buildOrPackage: false, any: true },
    }),
    score70Policy,
  );
  assert.equal(result.score, 65);
  assert.equal(result.eligibleForShadow, true);
  assert.equal(result.eligibleForCreateProjection, false);

  const below = evaluateCandidateEligibility(
    baseEvidence({
      resultSignals: {
        rootCause: false,
        verifiedFix: false,
        workaround: false,
        reusableConstraint: true,
        lowValueOnly: false,
        analysisOnly: false,
      },
      engineeringActions: { editCount: 1, writeCount: 0, patchCount: 0, meaningfulBashCount: 0 },
      verification: { strongTest: true, deviceTest: false, buildOrPackage: false, any: true },
    }),
    score70Policy,
  );
  assert.equal(below.score, 40);
  assert.equal(below.eligibleForShadow, false);
  assert.equal(below.reason, "score-below-shadow-threshold");
});
