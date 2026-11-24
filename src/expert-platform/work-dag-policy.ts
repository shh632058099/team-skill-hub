import type { WorkflowDefinition } from "./work-orchestration-store.js";
import { stableDigest, validateGraph, type DagGraph, type DagObligation } from "./work-dag.js";
export const WORK_DAG_POLICY_VALIDATOR_VERSION = "work-dag-policy@1";

export type DagPlanValidationCode =
  | "PLAN_INVALID_GRAPH"
  | "PLAN_MISSING_REQUIRED_EVIDENCE_PATH"
  | "PLAN_FORBIDDEN_NODE_TYPE"
  | "PLAN_WORKSPACE_WRITE_NOT_ALLOWED"
  | "PLAN_PARALLEL_WRITE_CONFLICT"
  | "PLAN_PUBLICATION_WITHOUT_REVIEW"
  | "PLAN_PUBLICATION_PATH_MISSING"
  | "PLAN_PUBLICATION_WITHOUT_APPROVAL"
  | "PLAN_APPROVAL_WITHOUT_PREPARED_PUBLICATION"
  | "PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION"
  | "PLAN_INVALID_SUBJECT_BINDING"
  | "PLAN_REPLAN_LIMIT_REACHED";

export interface DagPlanValidation {
  accepted: boolean;
  codes: DagPlanValidationCode[];
}

export interface DagPlanValidationOptions {
  outstandingOnly?: boolean;
}

const ALLOWED_KINDS = new Set(["agent", "verification", "review", "approval", "publication", "change_request", "wait"]);

function ancestors(graph: DagGraph, nodeId: string): Set<string> {
  const result = new Set<string>();
  const pending = graph.edges.filter((e) => e.to === nodeId).map((e) => e.from);
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const edge of graph.edges) if (edge.to === id) pending.push(edge.from);
  }
  return result;
}

function hasEvidenceProducer(graph: DagGraph, type: string): boolean {
  return graph.nodes.some(
    (node) =>
      (node.kind === "verification" && node.capability === type) ||
      (node.kind === "agent" && type === "expert_result") ||
      node.requirements.some((requirement) => requirement.kind === "evidence" && requirement.type === type),
  );
}
export function validateDagProposal(
  graph: DagGraph,
  workflow: WorkflowDefinition,
  obligations: readonly DagObligation[],
  options: DagPlanValidationOptions = {},
): DagPlanValidation {
  const codes = new Set<DagPlanValidationCode>();
  try {
    validateGraph(graph);
  } catch {
    codes.add("PLAN_INVALID_GRAPH");
    return { accepted: false, codes: [...codes] };
  }

  if (graph.nodes.some((node) => !ALLOWED_KINDS.has(node.kind))) codes.add("PLAN_FORBIDDEN_NODE_TYPE");
  if (workflow.change?.mode === "readonly" && graph.nodes.some((node) => node.mutates)) {
    codes.add("PLAN_WORKSPACE_WRITE_NOT_ALLOWED");
  }
  if (
    (workflow.change?.mode === "code_change" || workflow.change?.mode === "conditional_code_change") &&
    graph.nodes.some((node) => node.kind === "agent" && (!node.mutates || node.resource !== "workspace"))
  ) {
    codes.add("PLAN_WORKSPACE_WRITE_NOT_ALLOWED");
  }
  const mutating = graph.nodes.filter((node) => node.mutates);
  for (let leftIndex = 0; leftIndex < mutating.length; leftIndex++) {
    const left = mutating[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < mutating.length; rightIndex++) {
      const right = mutating[rightIndex]!;
      if (left.resource !== right.resource) continue;
      const leftUpstream = ancestors(graph, left.id);
      const rightUpstream = ancestors(graph, right.id);
      if (!leftUpstream.has(right.id) && !rightUpstream.has(left.id)) {
        codes.add("PLAN_PARALLEL_WRITE_CONFLICT");
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.subject !== null && !node.subject.trim()) codes.add("PLAN_INVALID_SUBJECT_BINDING");
  }

  const deferredAfterAgent =
    graph.nodes.some((node) => node.kind === "agent") &&
    workflow.planning?.replanPolicy.includes("always_after_agent_turn") === true;

  const requiredEvidence = new Set(options.outstandingOnly ? [] : workflow.validation.requiredEvidence);
  for (const obligation of obligations) {
    if (obligation.satisfaction.kind === "evidence") {
      requiredEvidence.add(obligation.satisfaction.type);
    }
  }
  const hasOutstandingFact = (key: string) =>
    obligations.some(
      (obligation) =>
        obligation.satisfaction.kind === "fact" &&
        obligation.satisfaction.key === key &&
        obligation.satisfaction.equals === true,
    );
  const requiresReview = options.outstandingOnly ? hasOutstandingFact("review.accepted") : workflow.review.required;
  const requiresPublication = options.outstandingOnly
    ? hasOutstandingFact("publication.succeeded")
    : workflow.publication?.required === true;
  const requiresChangeRequest = options.outstandingOnly
    ? hasOutstandingFact("change_request.created")
    : workflow.completion.require.includes("change_request_created");
  const requiresApprovalFact = options.outstandingOnly
    ? hasOutstandingFact("approval.required_approved")
    : workflow.completion.require.includes("required_approvals_approved");
  for (const type of requiredEvidence) {
    if (!hasEvidenceProducer(graph, type) && !deferredAfterAgent) codes.add("PLAN_MISSING_REQUIRED_EVIDENCE_PATH");
  }

  const reviewIds = new Set(graph.nodes.filter((node) => node.kind === "review").map((node) => node.id));
  const prepareIds = new Set(
    graph.nodes.filter((node) => node.kind === "publication" && node.capability === "prepare").map((node) => node.id),
  );
  const pushIds = new Set(
    graph.nodes.filter((node) => node.kind === "publication" && node.capability === "push").map((node) => node.id),
  );
  const publishApprovalIds = new Set(
    graph.nodes
      .filter((node) => node.kind === "approval" && node.capability === "publish_work_branch")
      .map((node) => node.id),
  );

  for (const publication of graph.nodes.filter((node) => node.kind === "publication")) {
    const upstream = ancestors(graph, publication.id);
    if (requiresReview && ![...reviewIds].some((id) => upstream.has(id))) {
      codes.add("PLAN_PUBLICATION_WITHOUT_REVIEW");
    }
    if (publication.capability === "push" && ![...prepareIds].some((id) => upstream.has(id))) {
      codes.add("PLAN_PUBLICATION_PATH_MISSING");
    }
  }

  const requiresPublishApproval =
    requiresApprovalFact &&
    workflow.completion.requiredApprovals?.some(
      (approval) => approval.scope === "publish_work_branch" && approval.subjectType === "publication_artifact",
    ) === true;
  if (requiresPublishApproval) {
    if (publishApprovalIds.size === 0 && !deferredAfterAgent) {
      codes.add("PLAN_PUBLICATION_WITHOUT_APPROVAL");
    }
    for (const approvalId of publishApprovalIds) {
      const upstream = ancestors(graph, approvalId);
      if (![...prepareIds].some((id) => upstream.has(id))) {
        codes.add("PLAN_APPROVAL_WITHOUT_PREPARED_PUBLICATION");
      }
    }
    for (const pushId of pushIds) {
      const upstream = ancestors(graph, pushId);
      if (![...publishApprovalIds].some((id) => upstream.has(id))) {
        codes.add("PLAN_PUBLICATION_WITHOUT_APPROVAL");
      }
    }
  }

  const requiresWorkCompletionApproval =
    requiresApprovalFact &&
    workflow.completion.requiredApprovals?.some(
      (approval) => approval.scope === "work_completion" && approval.subjectType === "workspace_revision",
    ) === true;
  if (
    requiresWorkCompletionApproval &&
    !graph.nodes.some((node) => node.kind === "approval" && node.capability === "work_completion") &&
    !deferredAfterAgent
  ) {
    codes.add("PLAN_PUBLICATION_WITHOUT_APPROVAL");
  }

  if (requiresPublication && pushIds.size === 0 && !deferredAfterAgent) {
    codes.add("PLAN_PUBLICATION_PATH_MISSING");
  }

  for (const request of graph.nodes.filter((node) => node.kind === "change_request")) {
    const upstream = ancestors(graph, request.id);
    if (![...pushIds].some((id) => upstream.has(id))) {
      codes.add("PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION");
    }
  }
  if (requiresChangeRequest && !graph.nodes.some((node) => node.kind === "change_request") && !deferredAfterAgent) {
    codes.add("PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION");
  }
  const ordered: DagPlanValidationCode[] = [
    "PLAN_INVALID_GRAPH",
    "PLAN_FORBIDDEN_NODE_TYPE",
    "PLAN_WORKSPACE_WRITE_NOT_ALLOWED",
    "PLAN_PARALLEL_WRITE_CONFLICT",
    "PLAN_MISSING_REQUIRED_EVIDENCE_PATH",
    "PLAN_INVALID_SUBJECT_BINDING",
    "PLAN_PUBLICATION_WITHOUT_REVIEW",
    "PLAN_PUBLICATION_PATH_MISSING",
    "PLAN_APPROVAL_WITHOUT_PREPARED_PUBLICATION",
    "PLAN_PUBLICATION_WITHOUT_APPROVAL",
    "PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION",
    "PLAN_REPLAN_LIMIT_REACHED",
  ];
  const result = ordered.filter((code) => codes.has(code));
  return { accepted: result.length === 0, codes: result };
}

export interface PlannerFrozenInput {
  workRevision: number;
  dagRevision: number;
  requirementRevision: number;
  policyIdentity: string;
  deploymentIdentity: string | null;
  subjectRevision: string | null;
  factsDigest: string;
  evidenceDigest: string;
  executionDigest: string;
}

export function plannerInputDigest(input: PlannerFrozenInput): string {
  return stableDigest(input);
}

export type ReplanReason =
  | "new_information"
  | "verification_failure"
  | "executor_retry"
  | "pending_plan_change"
  | "review_rework"
  | "human_rework"
  | "policy_incompatible"
  | "workspace_incompatible";

export function classifyReplanBoundary(reason: ReplanReason): "same_attempt" | "new_attempt" {
  switch (reason) {
    case "review_rework":
    case "human_rework":
    case "policy_incompatible":
    case "workspace_incompatible":
      return "new_attempt";
    default:
      return "same_attempt";
  }
}

export function detectPlanDeadlock(input: {
  outstandingObligations: readonly string[];
  ready: readonly string[];
  running: readonly string[];
  waiting: readonly string[];
}): boolean {
  return (
    input.outstandingObligations.length > 0 &&
    input.ready.length === 0 &&
    input.running.length === 0 &&
    input.waiting.length === 0
  );
}
