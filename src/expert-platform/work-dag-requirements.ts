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

export interface RequirementSnapshot {
  workItemId: string;
  revision: number;
  resolverVersion: string;
  requirements: WorkRequirement[];
  policyRef: string;
  policyDigest: string;
  effectiveDigest: string;
  createdAt: number;
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
): DagObligation[] {
  const result = policyObligations(workflow);
  const ids = new Set(result.map((item) => item.id));
  for (const requirement of requirements) {
    if (requirement.strength !== "required") continue;
    if (ids.has(requirement.id)) throw new Error("WORK_REQUIREMENT_POLICY_ID_CONFLICT");
    ids.add(requirement.id);
    result.push({
      id: requirement.id,
      condition: structuredClone(requirement.condition),
      satisfaction: structuredClone(requirement.satisfaction),
    });
  }
  return result;
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
): string {
  return stableDigest(
    effectiveObligations(workflow, requirements)
      .filter((item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === evidenceType)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function effectiveRequirementDigest(
  workflowId: string,
  workflowVersion: number,
  workflow: WorkflowDefinition,
  requirements: readonly WorkRequirement[],
): string {
  const policy = policyIdentity(workflowId, workflowVersion, workflow);
  return stableDigest({
    policyRef: policy.policyRef,
    policyDigest: policy.policyDigest,
    obligations: effectiveObligations(workflow, requirements),
  });
}
