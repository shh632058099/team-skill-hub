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
