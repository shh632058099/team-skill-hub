import { stableDigest } from "./work-dag.js";
import type { UnresolvedWorkRequirement, WorkRequirement } from "./work-dag-requirements.js";

export interface ResolvedWorkIntent {
  resolverIdentity: string;
  resolverVersion: string;
  originalRequest: string;
  originalRequestDigest: string;
  requirements: WorkRequirement[];
  unresolved: UnresolvedWorkRequirement[];
}

const HARD_MARKER = /\b(?:must|required|shall|even\s+if|regardless\s+of)\b|必须|务必|即使|无论/i;
const EXECUTION_MARKER = /\b(?:run|execute|verify|validate|test|build|compile)\b|运行|执行|验证|测试|构建|编译/i;
const EVIDENCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["ctest", /\bctest\b/i],
  ["unit_test", /\bunit[\s_-]*tests?\b|单元测试/i],
  ["integration_test", /\bintegration[\s_-]*tests?\b|集成测试/i],
  ["build", /\b(?:build|compile)\b|构建|编译/i],
];

const EVIDENCE_TERM_PATTERNS: Readonly<Record<string, string>> = {
  ctest: "ctest",
  unit_test: "unit[\\s_-]*tests?|单元测试",
  integration_test: "integration[\\s_-]*tests?|集成测试",
  build: "build|compile|构建|编译",
};

function evidenceIsNegated(clause: string, evidenceType: string): boolean {
  const term = EVIDENCE_TERM_PATTERNS[evidenceType];
  if (!term) return false;
  return [
    new RegExp(
      "\\b(?:must\\s+not|shall\\s+not|do\\s+not|don't|never|mustn't|should\\s+not)\\b.{0,30}(?:" + term + ")",
      "i",
    ),
    new RegExp(
      "\\b(?:no|without|skip|omit|avoid)\\s+(?:(?:run|running|execute|executing|test|testing)\\s+)?(?:" +
        term +
        ")(?:\\b|$)",
      "i",
    ),
    new RegExp("(?:" + term + ").{0,25}\\bnot\\s+(?:required|necessary)\\b", "i"),
    new RegExp("(?:不得|禁止|不要|不应|无需|不需要|不能).{0,20}(?:" + term + ")", "i"),
  ].some((pattern) => pattern.test(clause));
}
function clauses(text: string): string[] {
  return text
    .split(/[.!?。！？;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveWorkIntentDeterministically(originalRequest: string): ResolvedWorkIntent {
  const request = originalRequest.trim();
  const requirements: WorkRequirement[] = [];
  const unresolved: UnresolvedWorkRequirement[] = [];
  const seenEvidence = new Set<string>();
  const seenUnresolved = new Set<string>();
  const addUnresolved = (clause: string, reason: string) => {
    const id = "user:unresolved:" + stableDigest(clause).slice(0, 16);
    if (seenUnresolved.has(id)) return;
    seenUnresolved.add(id);
    unresolved.push({
      id,
      source: "user",
      strength: "required",
      text: clause,
      reason,
    });
  };

  for (const clause of clauses(request)) {
    if (!HARD_MARKER.test(clause)) continue;
    const evidenceMatches = EVIDENCE_PATTERNS.filter(([, pattern]) => pattern.test(clause)).map(([type]) => type);
    const matched = EXECUTION_MARKER.test(clause) ? evidenceMatches : [];
    if (evidenceMatches.some((type) => evidenceIsNegated(clause, type))) {
      addUnresolved(clause, "UNSUPPORTED_NEGATED_REQUIREMENT");
      continue;
    }
    if (matched.length) {
      for (const evidenceType of matched) {
        if (seenEvidence.has(evidenceType)) continue;
        seenEvidence.add(evidenceType);
        requirements.push({
          id: "user:intent:" + evidenceType,
          source: "user",
          strength: "required",
          condition: { kind: "always" },
          satisfaction: { kind: "evidence", type: evidenceType },
        });
      }
      continue;
    }
    addUnresolved(clause, "UNSUPPORTED_TYPED_REQUIREMENT");
  }

  return {
    resolverIdentity: "builtin-intent-resolver",
    resolverVersion: "typed-v6",
    originalRequest: request,
    originalRequestDigest: stableDigest(request),
    requirements,
    unresolved,
  };
}
