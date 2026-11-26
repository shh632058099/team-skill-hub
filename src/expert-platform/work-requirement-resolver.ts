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

interface DeliveryIntent {
  publication: boolean;
  changeRequest: boolean;
  condition: "on_change" | "always";
}

const PUBLICATION_TERM = /\b(?:work\s+branch|working\s+branch|branch)\b|工作分支/i;
const CHANGE_REQUEST_TERM = /\b(?:MR|PR|merge\s+request|pull\s+request)\b|合并请求|拉取请求/i;
const DELIVERY_ACTION =
  /\b(?:create|open|submit|raise|publish|push|send)\b|(?:创建|提交|发起|发布|推送|提)(?=\s*(?:MR|PR|合并请求|拉取请求))/i;
const DELIVERY_DISCUSSION =
  /\b(?:whether|if)\b.{0,40}\b(?:warranted|needed|necessary|appropriate)\b|是否.{0,30}(?:需要|必要|应该|合适)/i;
const DELIVERY_NEGATION =
  /\b(?:do\s+not|don't|must\s+not|shall\s+not|never|without)\b.{0,40}\b(?:create|open|submit|raise|publish|push)\b|(?:不要|不得|禁止|无需|不需要).{0,30}(?:创建|提交|发起|发布|推送|提)/i;
const DELIVERY_UNCONDITIONAL =
  /\balways\b|\bregardless\s+of\b|\beven\s+if\b.{0,50}\b(?:no|without)\b.{0,20}\b(?:code\s+)?changes?\b|无论.{0,30}(?:是否)?(?:有)?(?:代码)?(?:修改|改动)|即使.{0,30}(?:没有|无)(?:代码)?(?:修改|改动)/i;

function resolveDeliveryIntent(clause: string): DeliveryIntent | null {
  const hasPublicationTerm = PUBLICATION_TERM.test(clause);
  const hasChangeRequestTerm = CHANGE_REQUEST_TERM.test(clause);
  if (!hasPublicationTerm && !hasChangeRequestTerm) return null;
  if (DELIVERY_DISCUSSION.test(clause) || DELIVERY_NEGATION.test(clause)) return null;
  if (!DELIVERY_ACTION.test(clause)) return null;

  const changeRequest = hasChangeRequestTerm;
  return {
    publication: hasPublicationTerm || changeRequest,
    changeRequest,
    condition: DELIVERY_UNCONDITIONAL.test(clause) ? "always" : "on_change",
  };
}

function deliveryIntentRequirements(intent: DeliveryIntent): WorkRequirement[] {
  const condition =
    intent.condition === "always"
      ? ({ kind: "always" } as const)
      : ({ kind: "fact", key: "workspace.changed", equals: true } as const);
  const requirements: WorkRequirement[] = [];
  if (intent.publication) {
    requirements.push({
      id: "user:intent:publication",
      source: "user",
      strength: "required",
      condition,
      satisfaction: { kind: "fact", key: "publication.succeeded", equals: true },
    });
  }
  if (intent.changeRequest) {
    requirements.push({
      id: "user:intent:change_request",
      source: "user",
      strength: "required",
      condition,
      satisfaction: { kind: "fact", key: "change_request.created", equals: true },
    });
  }
  return requirements;
}

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
  const seenFacts = new Set<string>();
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
    const deliveryIntent = resolveDeliveryIntent(clause);
    if (deliveryIntent) {
      for (const requirement of deliveryIntentRequirements(deliveryIntent)) {
        if (requirement.satisfaction.kind !== "fact") continue;
        if (seenFacts.has(requirement.satisfaction.key)) continue;
        seenFacts.add(requirement.satisfaction.key);
        requirements.push(requirement);
      }
      continue;
    }

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
    resolverVersion: "typed-v8",
    originalRequest: request,
    originalRequestDigest: stableDigest(request),
    requirements,
    unresolved,
  };
}
