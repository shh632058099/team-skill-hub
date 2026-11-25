import type { WorkflowDefinition } from "./work-orchestration-store.js";
import { stableDigest, type DagObligation, type DagPredicate } from "./work-dag.js";

export type WorkRequirementSource = "user" | "source";
export type WorkRequirementStrength = "required" | "preferred";

export interface WorkRequirement {
  id: string;
  source: WorkRequirementSource;
  strength: WorkRequirementStrength;
  condition: DagPredicate;
  satisfaction: DagPredicate;
}

export interface UnresolvedWorkRequirement {
  id: string;
  source: WorkRequirementSource;
  strength: WorkRequirementStrength;
  text: string;
  reason: string;
}

export interface RequirementSnapshot {
  workItemId: string;
  revision: number;
  resolverIdentity: string;
  resolverVersion: string;
  originalRequest: string;
  originalRequestDigest: string;
  requirements: WorkRequirement[];
  unresolved: UnresolvedWorkRequirement[];
  policyObligations: DagObligation[];
  policyContextRef: string;
  policyContextDigest: string;
  policyRef: string;
  policyDigest: string;
  effectiveDigest: string;
  createdAt: number;
}

export type RequirementUpdateImpactKind = "compatible_stricter" | "semantics_changed" | "execution_contract_changed";

export interface RequirementUpdateImpact {
  kinds: RequirementUpdateImpactKind[];
  changedRequirementIds: string[];
  addedRequiredObligationIds: string[];
  removedRequiredObligationIds: string[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

function validateRequirementPredicate(predicate: DagPredicate): void {
  if (!predicate || typeof predicate !== "object") throw new Error("INVALID_WORK_REQUIREMENT");
  switch (predicate.kind) {
    case "always":
    case "no_blocker":
      return;
    case "fact":
      if (
        ID.test(predicate.key) &&
        (predicate.equals === null ||
          typeof predicate.equals === "string" ||
          typeof predicate.equals === "boolean" ||
          (typeof predicate.equals === "number" && Number.isFinite(predicate.equals)))
      ) {
        return;
      }
      break;
    case "evidence":
    case "artifact":
      if (ID.test(predicate.type)) return;
      break;
    case "subject":
      if (predicate.revision.trim()) return;
      break;
    case "node_result":
      // Work requirements cannot bind to a planner-created logical node.
      break;
  }
  throw new Error("INVALID_WORK_REQUIREMENT");
}

export function requirementPredicateSummary(predicate: DagPredicate): string {
  switch (predicate.kind) {
    case "always":
      return "always";
    case "resource_active":
      return "resource_active";
    case "fact":
      return "fact:" + predicate.key + "=" + JSON.stringify(predicate.equals);
    case "evidence":
      return "evidence:" + predicate.type;
    case "artifact":
      return "artifact:" + predicate.type;
    case "subject":
      return "subject:" + predicate.revision;
    case "no_blocker":
      return "no_blocker";
    case "node_result":
      return "node_result:" + predicate.nodeId + "=" + predicate.state;
  }
}

export function requirementCurrentSemantics(snapshot: RequirementSnapshot): string[] {
  const requirementLines = snapshot.requirements.map(
    (requirement) =>
      requirement.strength +
      " requirement " +
      requirement.id +
      ": when " +
      requirementPredicateSummary(requirement.condition) +
      " satisfy " +
      requirementPredicateSummary(requirement.satisfaction),
  );
  const unresolvedLines = snapshot.unresolved.map(
    (requirement) =>
      requirement.strength +
      " unresolved " +
      requirement.id +
      ": " +
      requirement.text +
      " (" +
      requirement.reason +
      ")",
  );
  return [...requirementLines, ...unresolvedLines];
}

export function requirementRoutingProblems(snapshot: RequirementSnapshot): string[] {
  const current = requirementCurrentSemantics(snapshot);
  if (current.length === 0) return [snapshot.originalRequest];
  const primary = current.join("\n");
  return primary === snapshot.originalRequest ? [primary] : [primary, snapshot.originalRequest];
}

export function resolveRequirementRouting<T>(snapshot: RequirementSnapshot, resolve: (problem: string) => T): T {
  const problems = requirementRoutingProblems(snapshot);
  for (let index = 0; index < problems.length; index++) {
    try {
      return resolve(problems[index]!);
    } catch (error) {
      const mayFallback =
        index + 1 < problems.length && error instanceof Error && error.message === "EXPERT_UNAVAILABLE";
      if (!mayFallback) throw error;
    }
  }
  throw new Error("EXPERT_UNAVAILABLE");
}

export function requirementPromptContext(snapshot: RequirementSnapshot): string {
  const current = requirementCurrentSemantics(snapshot);
  return [
    "RequirementSnapshot revision: " + snapshot.revision,
    "Original request: " + snapshot.originalRequest,
    "Current requirements:",
    ...(current.length > 0 ? current.map((line) => "- " + line) : ["- none beyond original request"]),
  ].join("\n");
}

export function normalizeWorkRequirements(value: readonly WorkRequirement[]): WorkRequirement[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("INVALID_WORK_REQUIREMENT");
  const ids = new Set<string>();
  return value.map((raw) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !ID.test(raw.id) ||
      (raw.source !== "user" && raw.source !== "source") ||
      (raw.strength !== "required" && raw.strength !== "preferred")
    ) {
      throw new Error("INVALID_WORK_REQUIREMENT");
    }
    if (ids.has(raw.id)) throw new Error("DUPLICATE_WORK_REQUIREMENT");
    ids.add(raw.id);
    validateRequirementPredicate(raw.condition);
    validateRequirementPredicate(raw.satisfaction);
    return structuredClone(raw);
  });
}

export function normalizeUnresolvedWorkRequirements(
  value: readonly UnresolvedWorkRequirement[],
): UnresolvedWorkRequirement[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("INVALID_WORK_REQUIREMENT");
  const ids = new Set<string>();
  return value.map((raw) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !ID.test(raw.id) ||
      (raw.source !== "user" && raw.source !== "source") ||
      (raw.strength !== "required" && raw.strength !== "preferred") ||
      typeof raw.text !== "string" ||
      !raw.text.trim() ||
      raw.text.length > 10_000 ||
      typeof raw.reason !== "string" ||
      !ID.test(raw.reason)
    ) {
      throw new Error("INVALID_WORK_REQUIREMENT");
    }
    if (ids.has(raw.id)) throw new Error("DUPLICATE_WORK_REQUIREMENT");
    ids.add(raw.id);
    return { ...structuredClone(raw), text: raw.text.trim() };
  });
}

export function normalizePinnedPolicyObligations(value: readonly DagObligation[]): DagObligation[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("INVALID_POLICY_OBLIGATION");
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || !ID.test(raw.id) || ids.has(raw.id)) {
      throw new Error("INVALID_POLICY_OBLIGATION");
    }
    if (
      raw.resource !== undefined &&
      raw.resource !== null &&
      (typeof raw.resource !== "string" || !raw.resource.trim())
    ) {
      throw new Error("INVALID_POLICY_OBLIGATION");
    }
    const validate = (predicate: DagPredicate) => {
      if (predicate.kind === "resource_active") return;
      validateRequirementPredicate(predicate);
    };
    validate(raw.condition);
    validate(raw.satisfaction);
    ids.add(raw.id);
    return structuredClone(raw);
  });
}

export function policyObligations(workflow: WorkflowDefinition): DagObligation[] {
  const obligations: DagObligation[] = [];
  const conditionalChange = workflow.change?.mode === "conditional_code_change";
  const changedCondition: DagPredicate = { kind: "fact", key: "workspace.changed", equals: true };
  const add = (id: string, satisfaction: DagPredicate, condition: DagPredicate = { kind: "always" }) => {
    if (!obligations.some((item) => item.id === id)) {
      obligations.push({ id, condition, satisfaction });
    }
  };
  for (const evidenceType of workflow.validation.requiredEvidence) {
    add(
      "policy:evidence:" + evidenceType,
      { kind: "evidence", type: evidenceType },
      conditionalChange ? changedCondition : { kind: "always" },
    );
  }
  for (const gate of workflow.completion.require) {
    switch (gate) {
      case "required_evidence_passed":
        break;
      case "latest_work_attempt_succeeded":
        add("policy:latest_work_attempt_succeeded", {
          kind: "fact",
          key: "attempt.latest_succeeded",
          equals: true,
        });
        break;
      case "no_unresolved_blocker":
        add("policy:no_unresolved_blocker", { kind: "no_blocker" });
        break;
      case "review_accepted":
        add("policy:review_accepted", { kind: "fact", key: "review.accepted", equals: true });
        break;
      case "required_approvals_approved":
        add(
          "policy:required_approvals_approved",
          {
            kind: "fact",
            key: "approval.required_approved",
            equals: true,
          },
          conditionalChange ? changedCondition : { kind: "always" },
        );
        break;
      case "publication_succeeded":
        add(
          "policy:publication_succeeded",
          { kind: "fact", key: "publication.succeeded", equals: true },
          conditionalChange ? changedCondition : { kind: "always" },
        );
        break;
      case "change_request_created":
        add(
          "policy:change_request_created",
          { kind: "fact", key: "change_request.created", equals: true },
          conditionalChange ? changedCondition : { kind: "always" },
        );
        break;
    }
  }
  return obligations;
}

export function effectiveObligations(
  workflow: WorkflowDefinition,
  requirements: readonly WorkRequirement[],
  unresolved: readonly UnresolvedWorkRequirement[] = [],
  pinnedPolicyObligations: readonly DagObligation[] = [],
): DagObligation[] {
  const result = policyObligations(workflow);
  const ids = new Set(result.map((item) => item.id));
  const add = (obligation: DagObligation) => {
    if (ids.has(obligation.id)) throw new Error("WORK_REQUIREMENT_POLICY_ID_CONFLICT");
    ids.add(obligation.id);
    result.push(structuredClone(obligation));
  };
  for (const obligation of normalizePinnedPolicyObligations(pinnedPolicyObligations)) add(obligation);
  for (const requirement of requirements) {
    if (requirement.strength !== "required") continue;
    add({
      id: requirement.id,
      condition: structuredClone(requirement.condition),
      satisfaction: structuredClone(requirement.satisfaction),
    });
  }
  for (const requirement of unresolved) {
    if (requirement.strength !== "required") continue;
    add({
      id: requirement.id,
      condition: { kind: "always" },
      satisfaction: { kind: "fact", key: "requirement.resolved." + requirement.id, equals: true },
    });
  }
  return result;
}

function obligationSemanticDigest(obligation: DagObligation): string {
  return stableDigest({
    condition: obligation.condition,
    satisfaction: obligation.satisfaction,
    resource: obligation.resource ?? null,
  });
}

export function classifyRequirementUpdateImpact(
  workflow: WorkflowDefinition,
  previousRequirements: readonly WorkRequirement[],
  nextRequirements: readonly WorkRequirement[],
  previousUnresolved: readonly UnresolvedWorkRequirement[] = [],
  nextUnresolved: readonly UnresolvedWorkRequirement[] = previousUnresolved,
  pinnedPolicyObligations: readonly DagObligation[] = [],
): RequirementUpdateImpact {
  const previousById = new Map<string, WorkRequirement | UnresolvedWorkRequirement>([
    ...previousRequirements.map((item) => [item.id, item] as const),
    ...previousUnresolved.map((item) => [item.id, item] as const),
  ]);
  const nextById = new Map<string, WorkRequirement | UnresolvedWorkRequirement>([
    ...nextRequirements.map((item) => [item.id, item] as const),
    ...nextUnresolved.map((item) => [item.id, item] as const),
  ]);
  const changedRequirementIds = [...new Set([...previousById.keys(), ...nextById.keys()])]
    .filter((id) => {
      const previous = previousById.get(id);
      const next = nextById.get(id);
      if (!previous || !next) return true;
      return stableDigest(previous) !== stableDigest(next);
    })
    .sort();

  const previousObligations = effectiveObligations(
    workflow,
    previousRequirements,
    previousUnresolved,
    pinnedPolicyObligations,
  );
  const nextObligations = effectiveObligations(workflow, nextRequirements, nextUnresolved, pinnedPolicyObligations);
  const previousSemantics = new Set(previousObligations.map(obligationSemanticDigest));
  const nextSemantics = new Set(nextObligations.map(obligationSemanticDigest));
  const addedRequiredObligationIds = nextObligations
    .filter((item) => !previousSemantics.has(obligationSemanticDigest(item)))
    .map((item) => item.id)
    .sort();
  const removedRequiredObligationIds = previousObligations
    .filter((item) => !nextSemantics.has(obligationSemanticDigest(item)))
    .map((item) => item.id)
    .sort();

  const kinds: RequirementUpdateImpactKind[] = [];
  if (
    changedRequirementIds.some((id) => previousById.has(id) || !nextById.has(id)) ||
    removedRequiredObligationIds.length > 0
  ) {
    kinds.push("semantics_changed");
  }
  if (addedRequiredObligationIds.length > 0) kinds.push("execution_contract_changed");
  if (kinds.length === 0) kinds.push("compatible_stricter");

  return {
    kinds,
    changedRequirementIds,
    addedRequiredObligationIds,
    removedRequiredObligationIds,
  };
}
export function policyIdentity(
  workflowId: string,
  workflowVersion: number,
  workflow: WorkflowDefinition,
): {
  policyRef: string;
  policyDigest: string;
} {
  return {
    policyRef: workflowId + "@" + workflowVersion,
    policyDigest: stableDigest(workflow),
  };
}

export function evidenceRequirementSemanticsDigest(
  workflow: WorkflowDefinition,
  requirements: readonly WorkRequirement[],
  evidenceType: string,
  pinnedPolicyObligations: readonly DagObligation[] = [],
  policyContextDigest = "",
): string {
  return stableDigest({
    policyContextDigest,
    obligations: effectiveObligations(workflow, requirements, [], pinnedPolicyObligations)
      .filter((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === evidenceType)
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export function effectiveRequirementDigest(
  workflowId: string,
  workflowVersion: number,
  workflow: WorkflowDefinition,
  requirements: readonly WorkRequirement[],
  unresolved: readonly UnresolvedWorkRequirement[] = [],
  originalRequestDigest = "",
  policyContextDigest = "",
  pinnedPolicyObligations: readonly DagObligation[] = [],
): string {
  const policy = policyIdentity(workflowId, workflowVersion, workflow);
  return stableDigest({
    policyRef: policy.policyRef,
    policyDigest: policy.policyDigest,
    originalRequestDigest,
    policyContextDigest,
    obligations: effectiveObligations(workflow, requirements, unresolved, pinnedPolicyObligations),
  });
}
