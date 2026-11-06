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

import { evaluateShadowAdmission } from "../src/auto-candidate/admission.js";
import type { CandidateDetectionRecord } from "../src/observability.js";

function projectedDetection(input: {
  ts: string;
  actorId?: string;
  sessionId?: string;
  turnId?: string;
  repositoryId?: string;
  policyVersion?: number;
}): CandidateDetectionRecord {
  return {
    id: "det-" + Math.random(),
    ts: input.ts,
    detector: "stop-evidence-v3",
    actorId: input.actorId ?? "u-admit",
    tenantId: "t-admit",
    sessionId: input.sessionId ?? "s-prior",
    ...(input.turnId ? { turnId: input.turnId } : {}),
    outcome: "shadow",
    reason: "shadow-create",
    evidenceCount: 1,
    policyVersion: input.policyVersion ?? 1,
    mode: "shadow",
    score: 90,
    repositoryId: input.repositoryId,
    projectedAction: "create",
  };
}

const createEligible = {
  score: 90,
  hardGates: {
    assistantResult: true,
    meaningfulActivity: true,
    verification: true,
    lowValue: true,
    reusableResult: true,
  },
  scoreSignals: [],
  eligibleForShadow: true,
  eligibleForCreateProjection: true,
  reason: "score-meets-create-threshold",
};

test("shadow admission enforces per-session and user quotas from prior v3 projected creates", () => {
  const policy = defaultAutoCandidatePolicy();
  const now = "2026-11-06T08:00:00.000Z";

  const sameSession = evaluateShadowAdmission({
    actorId: "u-admit",
    tenantId: "t-admit",
    sessionId: "s-current",
    turnId: "turn-2",
    repositoryId: "repo-a",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: [
      projectedDetection({
        ts: "2026-11-06T07:59:00.000Z",
        sessionId: "s-current",
        turnId: "turn-1",
        repositoryId: "repo-a",
      }),
    ],
  });
  assert.equal(sameSession.allowed, false);
  assert.equal(sameSession.reason, "session-limit");

  const userHour = evaluateShadowAdmission({
    actorId: "u-admit",
    tenantId: "t-admit",
    sessionId: "s-new",
    turnId: "turn-new",
    repositoryId: "repo-a",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: [
      projectedDetection({ ts: "2026-11-06T07:20:00.000Z", sessionId: "s1", repositoryId: "repo-b" }),
      projectedDetection({ ts: "2026-11-06T07:40:00.000Z", sessionId: "s2", repositoryId: "repo-c" }),
    ],
  });
  assert.equal(userHour.allowed, false);
  assert.equal(userHour.reason, "user-hour-limit");
});

test("shadow admission enforces repository and global safety ceilings", () => {
  const policy = defaultAutoCandidatePolicy();
  const now = "2026-11-06T08:00:00.000Z";
  const repoRows = Array.from({ length: 5 }, (_, index) =>
    projectedDetection({
      ts: `2026-11-06T07:${10 + index}:00.000Z`,
      actorId: `user-${index}`,
      sessionId: `repo-session-${index}`,
      repositoryId: "repo-hot",
    }),
  );
  const repo = evaluateShadowAdmission({
    actorId: "new-user",
    tenantId: "t-admit",
    sessionId: "new-session",
    turnId: "new-turn",
    repositoryId: "repo-hot",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: repoRows,
  });
  assert.equal(repo.reason, "repository-hour-limit");

  const globalRows = Array.from({ length: 10 }, (_, index) =>
    projectedDetection({
      ts: `2026-11-06T07:${10 + index}:00.000Z`,
      actorId: `global-user-${index}`,
      sessionId: `global-session-${index}`,
      repositoryId: `repo-${index}`,
    }),
  );
  const global = evaluateShadowAdmission({
    actorId: "fresh-user",
    tenantId: "t-admit",
    sessionId: "fresh-session",
    turnId: "fresh-turn",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: globalRows,
  });
  assert.equal(global.reason, "global-hour-limit");
});

test("shadow ledger ignores non-v3/non-create rows and does not double-count repeated session turn", () => {
  const policy = defaultAutoCandidatePolicy();
  const now = "2026-11-06T08:00:00.000Z";
  const repeated = projectedDetection({
    ts: "2026-11-06T07:30:00.000Z",
    sessionId: "same",
    turnId: "turn-1",
    repositoryId: "repo-a",
  });
  const ignored = { ...repeated, id: "legacy", detector: "stop-evidence-v2", projectedAction: undefined };
  const duplicate = { ...repeated, id: "dup", ts: "2026-11-06T07:31:00.000Z" };

  const result = evaluateShadowAdmission({
    actorId: "u-admit",
    tenantId: "t-admit",
    sessionId: "new-session",
    turnId: "new-turn",
    repositoryId: undefined,
    eligibility: createEligible,
    policy,
    now,
    recentDetections: [repeated, duplicate, ignored],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.projectedAction, "create");
});

test("shadow admission skips when eligibility did not reach create projection", () => {
  const result = evaluateShadowAdmission({
    actorId: "u",
    tenantId: "t",
    sessionId: "s",
    turnId: "turn",
    eligibility: { ...createEligible, score: 65, eligibleForCreateProjection: false },
    policy: defaultAutoCandidatePolicy(),
    now: "2026-11-06T08:00:00.000Z",
    recentDetections: [],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "below-create-threshold");
  assert.equal(result.projectedAction, "skip");
});

test("shadow admission enforces daily user repository and global ceilings", () => {
  const policy = defaultAutoCandidatePolicy();
  const now = "2026-11-06T08:00:00.000Z";

  const userDayRows = Array.from({ length: 5 }, (_, index) =>
    projectedDetection({
      ts: `2026-11-05T${20 + Math.floor(index / 2)}:${String(index * 7).padStart(2, "0")}:00.000Z`,
      sessionId: `user-day-${index}`,
      repositoryId: `repo-user-day-${index}`,
    }),
  );
  const userDay = evaluateShadowAdmission({
    actorId: "u-admit",
    tenantId: "t-admit",
    sessionId: "user-day-new",
    turnId: "turn-user-day",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: userDayRows,
  });
  assert.equal(userDay.reason, "user-day-limit");

  const repositoryDayRows = Array.from({ length: 20 }, (_, index) =>
    projectedDetection({
      ts: `2026-11-05T${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${String((index * 3) % 60).padStart(2, "0")}:00.000Z`,
      actorId: `repo-day-user-${index}`,
      sessionId: `repo-day-session-${index}`,
      repositoryId: "repo-day-hot",
    }),
  );
  const repositoryDay = evaluateShadowAdmission({
    actorId: "repo-day-new-user",
    tenantId: "t-admit",
    sessionId: "repo-day-new-session",
    turnId: "repo-day-new-turn",
    repositoryId: "repo-day-hot",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: repositoryDayRows,
  });
  assert.equal(repositoryDay.reason, "repository-day-limit");

  const globalDayRows = Array.from({ length: 50 }, (_, index) =>
    projectedDetection({
      ts: `2026-11-05T${String(9 + Math.floor(index / 5)).padStart(2, "0")}:${String(index % 5).padStart(2, "0")}:00.000Z`,
      actorId: `global-day-user-${index}`,
      sessionId: `global-day-session-${index}`,
      repositoryId: `global-day-repo-${index}`,
    }),
  );
  const globalDay = evaluateShadowAdmission({
    actorId: "global-day-new-user",
    tenantId: "t-admit",
    sessionId: "global-day-new-session",
    turnId: "global-day-new-turn",
    eligibility: createEligible,
    policy,
    now,
    recentDetections: globalDayRows,
  });
  assert.equal(globalDay.reason, "global-day-limit");
});

test("shadow admission applies same-repository cooldown before quotas", () => {
  const policy = defaultAutoCandidatePolicy();
  const result = evaluateShadowAdmission({
    actorId: "cooldown-user-new",
    tenantId: "t-admit",
    sessionId: "cooldown-new-session",
    turnId: "cooldown-new-turn",
    repositoryId: "repo-cooldown",
    eligibility: createEligible,
    policy,
    now: "2026-11-06T08:00:00.000Z",
    recentDetections: [
      projectedDetection({
        ts: "2026-11-06T07:58:00.000Z",
        actorId: "cooldown-other-user",
        sessionId: "cooldown-prior-session",
        repositoryId: "repo-cooldown",
      }),
    ],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "repository-cooldown");
});
test("collector recognizes common Chinese verified-fix wording from ordinary final response", () => {
  const evidence = collectCandidateEvidence({
    assistantResult:
      "根因已确认：恢复流程遗漏完整性检查。问题已经修复并完成回归测试，该约束必须用于后续 OTA 恢复流程。",
    timeline: [],
  });
  assert.equal(evidence.resultSignals.rootCause, true);
  assert.equal(evidence.resultSignals.verifiedFix, true);
  assert.equal(evidence.resultSignals.reusableConstraint, true);
});

test("collector marks explicit formatting-only result low value even when headings mention root cause and solution", () => {
  const evidence = collectCandidateEvidence({
    assistantResult: "# 仅格式化代码\n## 根因\n格式规则不一致。\n## 解决方案\n统一排版。\n## 验证\n测试通过。",
    timeline: [
      {
        kind: "event",
        event: {
          event: "PostToolUse",
          actorId: "u-low",
          tenantId: "t-low",
          sessionId: "s-low",
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
  assert.equal(evidence.resultSignals.lowValueOnly, true);
});

test("command-category-only evidence survives normalization for Codex PostToolUse", () => {
  const evidence = normalizeEngineeringEvidence("Bash", {
    command_category: "test",
  });
  assert.equal(evidence?.type, "test");
  assert.equal(evidence?.commandCategory, "test");
});

import { inferCandidateProjectRepository } from "../src/auto-candidate/evidence.js";

test("repository inference ignores knowledge lookup MCP repositories", () => {
  const timeline = [
    {
      kind: "event" as const,
      event: {
        event: "SessionStart",
        actorId: "u",
        tenantId: "t",
        sessionId: "s",
        metadata: {},
      },
    },
    {
      kind: "mcp-call" as const,
      call: {
        success: true,
        args: { repository: "rd-skills" },
      },
    },
  ];
  assert.equal(inferCandidateProjectRepository(timeline, new Set(["rd-skills"])), undefined);
});

test("repository inference trusts configured SessionStart project context", () => {
  const timeline = [
    {
      kind: "event" as const,
      event: {
        event: "SessionStart",
        actorId: "u",
        tenantId: "t",
        sessionId: "s",
        metadata: { project_context: { repositoryId: "rd-skills" } },
      },
    },
    {
      kind: "mcp-call" as const,
      call: {
        success: true,
        args: { repository: "other-repo" },
      },
    },
  ];
  assert.equal(inferCandidateProjectRepository(timeline, new Set(["rd-skills", "other-repo"])), "rd-skills");
});
