import type { WorkflowDefinition } from "./work-orchestration-store.js";
import { parseApprovalRequirementFactKey } from "./work-dag-requirements.js";
import {
  canonicalResourceIdentity,
  stableDigest,
  validateGraph,
  type DagGraph,
  type DagObligation,
} from "./work-dag.js";
import type { WorkDagPolicyContext } from "./work-dag-policy-context.js";
export const WORK_DAG_POLICY_VALIDATOR_VERSION = "work-dag-policy@1";

export const DEFAULT_WORK_DAG_PLANNING_POLICY: NonNullable<WorkflowDefinition["planning"]> = {
  maxReplans: 12,
  replanPolicy: [
    "always_after_agent_turn",
    "on_new_information",
    "on_failure",
    "on_review_rework",
    "on_blocker_resolution",
    "on_user_update",
    "manual",
  ],
};

export type DagPlanValidationCode =
  | "PLAN_INVALID_GRAPH"
  | "PLAN_MISSING_REQUIRED_EVIDENCE_PATH"
  | "PLAN_MISSING_REQUIRED_OBLIGATION_PATH"
  | "PLAN_FORBIDDEN_NODE_TYPE"
  | "PLAN_WORKSPACE_WRITE_NOT_ALLOWED"
  | "PLAN_PARALLEL_WRITE_CONFLICT"
  | "PLAN_PUBLICATION_WITHOUT_REVIEW"
  | "PLAN_PUBLICATION_PATH_MISSING"
  | "PLAN_PUBLICATION_WITHOUT_APPROVAL"
  | "PLAN_APPROVAL_WITHOUT_PREPARED_PUBLICATION"
  | "PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION"
  | "PLAN_INVALID_SUBJECT_BINDING"
  | "PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE"
  | "PLAN_EXECUTOR_BEHAVIOR_MISMATCH"
  | "PLAN_REPOSITORY_CAPABILITY_UNAVAILABLE"
  | "PLAN_POLICY_CONTEXT_DRIFT"
  | "PLAN_REPLAN_LIMIT_REACHED"
  | "PLAN_REWORK_LIMIT_REACHED"
  | "PLAN_CONTINUATION_LIMIT_REACHED";

export interface DagPlanValidation {
  accepted: boolean;
  codes: DagPlanValidationCode[];
}

export interface DagPlanValidationOptions {
  outstandingOnly?: boolean;
  policyContext?: WorkDagPolicyContext;
  reasonCode?: string;
}

const ALLOWED_KINDS = new Set([
  "agent",
  "verification",
  "review",
  "approval",
  "publication",
  "change_request",
  "wait",
  "external_action",
]);

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

function hasEvidenceProducer(graph: DagGraph, type: string, resource?: string | null): boolean {
  return graph.nodes.some(
    (node) =>
      (resource == null || node.resource === resource) &&
      ((node.kind === "verification" && node.capability === type) ||
        (node.kind === "agent" && type === "expert_result") ||
        (node.kind === "publication" && node.capability === "push" && type === "publication")),
  );
}
function knownObligationProducer(graph: DagGraph, obligation: DagObligation): { known: boolean; produced: boolean } {
  const resourceMatches = (node: DagGraph["nodes"][number]) =>
    obligation.resource == null || node.resource === obligation.resource;
  const has = (predicate: (node: DagGraph["nodes"][number]) => boolean) =>
    graph.nodes.some((node) => resourceMatches(node) && predicate(node));

  switch (obligation.satisfaction.kind) {
    case "evidence":
      return { known: true, produced: hasEvidenceProducer(graph, obligation.satisfaction.type, obligation.resource) };
    case "artifact":
      if (obligation.satisfaction.type === "git_commit") {
        return { known: true, produced: has((node) => node.kind === "publication" && node.capability === "prepare") };
      }
      if (obligation.satisfaction.type === "change_request") {
        return { known: true, produced: has((node) => node.kind === "change_request" && node.capability === "create") };
      }
      return { known: false, produced: false };
    case "fact": {
      const key = obligation.satisfaction.key;
      if (key === "agent.completed") {
        return { known: true, produced: has((node) => node.kind === "agent") };
      }
      if (key === "attempt.latest_succeeded") {
        // Runtime closes the active WorkAttempt after every node in a non-empty
        // accepted revision succeeds and no other completion blocker remains.
        return { known: true, produced: graph.nodes.length > 0 };
      }
      if (key === "workspace.changed") {
        return {
          known: true,
          produced: has((node) => (node.kind === "agent" && node.mutates) || node.kind === "review"),
        };
      }
      if (key === "review.accepted") return { known: true, produced: has((node) => node.kind === "review") };
      if (key === "approval.required_approved") {
        return { known: true, produced: has((node) => node.kind === "approval") };
      }
      const approval = parseApprovalRequirementFactKey(key);
      if (approval) {
        return {
          known: true,
          produced: has((node) => node.kind === "approval" && node.capability === approval.scope),
        };
      }
      if (key === "publication.succeeded") {
        return { known: true, produced: has((node) => node.kind === "publication" && node.capability === "push") };
      }
      if (key === "change_request.created") {
        return { known: true, produced: has((node) => node.kind === "change_request" && node.capability === "create") };
      }
      if (key.startsWith("wait.")) {
        const capability = key.slice("wait.".length);
        return {
          known: capability.length > 0,
          produced: capability.length > 0 && has((node) => node.kind === "wait" && node.capability === capability),
        };
      }
      return { known: false, produced: false };
    }
    case "subject":
      return { known: true, produced: has((node) => node.kind === "agent" && node.mutates) };
    case "resource_active":
      return { known: true, produced: true };
    case "no_blocker":
    case "always":
      return { known: true, produced: true };
    case "node_result": {
      const nodeId = obligation.satisfaction.nodeId;
      return { known: true, produced: graph.nodes.some((node) => node.id === nodeId) };
    }
  }
}
function externalActionPolicy(node: DagGraph["nodes"][number], policyContext: WorkDagPolicyContext | undefined) {
  if (node.kind !== "external_action") return null;
  return policyContext?.externalActionPolicies?.[node.capability] ?? null;
}

function externalResourceMatches(resource: string | null, prefix: string | undefined): boolean {
  if (!prefix) return true;
  if (!resource) return false;
  return resource === prefix || resource.startsWith(prefix.endsWith(":") ? prefix : prefix + ":");
}

function effectiveNodeMutates(
  node: DagGraph["nodes"][number],
  policyContext: WorkDagPolicyContext | undefined,
): boolean {
  return externalActionPolicy(node, policyContext)?.mutates ?? node.mutates;
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
  const policyContext = options.policyContext;
  if (policyContext) {
    const organizationKinds = new Set(policyContext.organization.allowedNodeKinds);
    for (const node of graph.nodes) {
      if (!organizationKinds.has(node.kind)) codes.add("PLAN_FORBIDDEN_NODE_TYPE");
      const hasPinnedResourcePolicies = policyContext.resourcePolicies !== undefined;
      const resourcePolicy =
        node.resource?.startsWith("repo:") && hasPinnedResourcePolicies
          ? policyContext.resourcePolicies?.[node.resource]
          : undefined;
      if (node.resource?.startsWith("repo:") && hasPinnedResourcePolicies && !resourcePolicy) {
        codes.add("PLAN_REPOSITORY_CAPABILITY_UNAVAILABLE");
        if (node.kind === "agent" || node.kind === "verification" || node.kind === "review") {
          codes.add("PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE");
        }
        continue;
      }
      const capabilities =
        resourcePolicy?.executorCapabilities[node.kind] ?? policyContext.executorCapabilities[node.kind] ?? [];
      if (!capabilities.includes("*") && !capabilities.includes(node.capability)) {
        codes.add("PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE");
        if (node.kind === "verification" || node.kind === "publication" || node.kind === "change_request") {
          codes.add("PLAN_REPOSITORY_CAPABILITY_UNAVAILABLE");
        }
      }
      if (node.kind === "external_action") {
        const actionPolicy = externalActionPolicy(node, policyContext);
        if (
          !actionPolicy ||
          node.mutates !== actionPolicy.mutates ||
          !externalResourceMatches(node.resource, actionPolicy.resourcePrefix)
        ) {
          codes.add("PLAN_EXECUTOR_BEHAVIOR_MISMATCH");
        }
      }
    }
    if (
      policyContext.routingIssue &&
      graph.nodes.some((node) => node.kind === "agent" || node.kind === "verification" || node.kind === "review")
    ) {
      codes.add("PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE");
    }
    if (policyContext.usage.replansUsed >= policyContext.limits.maxReplans) {
      codes.add("PLAN_REPLAN_LIMIT_REACHED");
    }
    if (options.reasonCode === "review_rework" && policyContext.usage.reworksUsed >= policyContext.limits.maxReworks) {
      codes.add("PLAN_REWORK_LIMIT_REACHED");
    }
    if (
      (options.reasonCode === "verification_failure" || options.reasonCode === "failure") &&
      policyContext.usage.continuationTurns >= policyContext.limits.maxTurnsPerRun
    ) {
      codes.add("PLAN_CONTINUATION_LIMIT_REACHED");
    }
  }
  const dynamicForbidsWorkspaceWrite =
    options.outstandingOnly && policyContext?.executionConstraints?.workspaceMutation === "forbidden";
  const legacyForbidsWorkspaceWrite = !options.outstandingOnly && workflow.change?.mode === "readonly";
  if (
    (dynamicForbidsWorkspaceWrite || legacyForbidsWorkspaceWrite) &&
    graph.nodes.some(
      (node) =>
        node.mutates && (node.resource === "workspace" || node.resource?.startsWith("repo:") || node.kind === "agent"),
    )
  ) {
    codes.add("PLAN_WORKSPACE_WRITE_NOT_ALLOWED");
  }
  if (
    !options.outstandingOnly &&
    (workflow.change?.mode === "code_change" || workflow.change?.mode === "conditional_code_change") &&
    graph.nodes.some(
      (node) =>
        node.kind === "agent" &&
        (!node.mutates || (node.resource !== "workspace" && !node.resource?.startsWith("repo:"))),
    )
  ) {
    codes.add("PLAN_WORKSPACE_WRITE_NOT_ALLOWED");
  }
  const mutating = graph.nodes.filter((node) => effectiveNodeMutates(node, policyContext));
  const primaryResource = policyContext?.repository ? "repo:" + policyContext.repository.repositoryId : null;
  for (let leftIndex = 0; leftIndex < mutating.length; leftIndex++) {
    const left = mutating[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < mutating.length; rightIndex++) {
      const right = mutating[rightIndex]!;
      if (
        canonicalResourceIdentity(left.resource, primaryResource) !==
        canonicalResourceIdentity(right.resource, primaryResource)
      )
        continue;
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

  const effectiveReplanPolicy = workflow.planning?.replanPolicy ?? DEFAULT_WORK_DAG_PLANNING_POLICY.replanPolicy;
  const deferredAfterAgent =
    graph.nodes.some((node) => node.kind === "agent") && effectiveReplanPolicy.includes("always_after_agent_turn");
  const deferredAfterInitialConditionalReview =
    options.outstandingOnly === true &&
    options.reasonCode === "initial" &&
    workflow.change?.mode === "conditional_code_change" &&
    graph.nodes.length === 1 &&
    graph.nodes[0]?.kind === "review" &&
    effectiveReplanPolicy.includes("on_review_rework");
  const deferredAfterReplanBoundary = deferredAfterAgent || deferredAfterInitialConditionalReview;

  const requiredEvidence = new Set(options.outstandingOnly ? [] : workflow.validation.requiredEvidence);
  const requiredEvidenceObligations = obligations.filter((item) => item.satisfaction.kind === "evidence");
  for (const obligation of requiredEvidenceObligations) {
    requiredEvidence.add(obligation.satisfaction.kind === "evidence" ? obligation.satisfaction.type : "");
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
  const outstandingApprovalScopes = new Set(
    obligations
      .filter(
        (obligation) =>
          obligation.satisfaction.kind === "fact" &&
          obligation.satisfaction.equals === true &&
          parseApprovalRequirementFactKey(obligation.satisfaction.key) !== null,
      )
      .map((obligation) =>
        obligation.satisfaction.kind === "fact"
          ? parseApprovalRequirementFactKey(obligation.satisfaction.key)!.scope
          : null,
      )
      .filter((scope): scope is "work_completion" | "publish_work_branch" => scope !== null),
  );
  const requiresApprovalFact = options.outstandingOnly
    ? hasOutstandingFact("approval.required_approved") || outstandingApprovalScopes.size > 0
    : workflow.completion.require.includes("required_approvals_approved");
  for (const type of requiredEvidence) {
    if (!type) continue;
    const resourceBound = requiredEvidenceObligations.filter(
      (item) => item.satisfaction.kind === "evidence" && item.satisfaction.type === type && item.resource != null,
    );
    if (resourceBound.length > 0) {
      for (const obligation of resourceBound) {
        if (!hasEvidenceProducer(graph, type, obligation.resource) && !deferredAfterReplanBoundary) {
          codes.add("PLAN_MISSING_REQUIRED_EVIDENCE_PATH");
        }
      }
    } else if (!hasEvidenceProducer(graph, type) && !deferredAfterReplanBoundary) {
      codes.add("PLAN_MISSING_REQUIRED_EVIDENCE_PATH");
    }
  }

  for (const obligation of obligations) {
    if (obligation.satisfaction.kind === "evidence") continue;
    const producer = knownObligationProducer(graph, obligation);
    if (!producer.known || (!producer.produced && !deferredAfterReplanBoundary)) {
      codes.add("PLAN_MISSING_REQUIRED_OBLIGATION_PATH");
    }
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

  const requiresPublishApproval = options.outstandingOnly
    ? outstandingApprovalScopes.has("publish_work_branch")
    : requiresApprovalFact &&
      workflow.completion.requiredApprovals?.some(
        (approval) => approval.scope === "publish_work_branch" && approval.subjectType === "publication_artifact",
      ) === true;
  if (requiresPublishApproval) {
    if (publishApprovalIds.size === 0 && !deferredAfterReplanBoundary) {
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

  const requiresWorkCompletionApproval = options.outstandingOnly
    ? outstandingApprovalScopes.has("work_completion")
    : requiresApprovalFact &&
      workflow.completion.requiredApprovals?.some(
        (approval) => approval.scope === "work_completion" && approval.subjectType === "workspace_revision",
      ) === true;
  if (
    requiresWorkCompletionApproval &&
    !graph.nodes.some((node) => node.kind === "approval" && node.capability === "work_completion") &&
    !deferredAfterReplanBoundary
  ) {
    codes.add("PLAN_PUBLICATION_WITHOUT_APPROVAL");
  }

  if (requiresPublication && pushIds.size === 0 && !deferredAfterReplanBoundary) {
    codes.add("PLAN_PUBLICATION_PATH_MISSING");
  }

  for (const request of graph.nodes.filter((node) => node.kind === "change_request")) {
    const upstream = ancestors(graph, request.id);
    if (![...pushIds].some((id) => upstream.has(id))) {
      codes.add("PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION");
    }
  }
  if (
    requiresChangeRequest &&
    !graph.nodes.some((node) => node.kind === "change_request") &&
    !deferredAfterReplanBoundary
  ) {
    codes.add("PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION");
  }
  const ordered: DagPlanValidationCode[] = [
    "PLAN_INVALID_GRAPH",
    "PLAN_FORBIDDEN_NODE_TYPE",
    "PLAN_WORKSPACE_WRITE_NOT_ALLOWED",
    "PLAN_PARALLEL_WRITE_CONFLICT",
    "PLAN_MISSING_REQUIRED_EVIDENCE_PATH",
    "PLAN_MISSING_REQUIRED_OBLIGATION_PATH",
    "PLAN_INVALID_SUBJECT_BINDING",
    "PLAN_PUBLICATION_WITHOUT_REVIEW",
    "PLAN_PUBLICATION_PATH_MISSING",
    "PLAN_APPROVAL_WITHOUT_PREPARED_PUBLICATION",
    "PLAN_PUBLICATION_WITHOUT_APPROVAL",
    "PLAN_CHANGE_REQUEST_WITHOUT_PUBLICATION",
    "PLAN_EXECUTOR_CAPABILITY_UNAVAILABLE",
    "PLAN_EXECUTOR_BEHAVIOR_MISMATCH",
    "PLAN_REPOSITORY_CAPABILITY_UNAVAILABLE",
    "PLAN_POLICY_CONTEXT_DRIFT",
    "PLAN_REPLAN_LIMIT_REACHED",
    "PLAN_REWORK_LIMIT_REACHED",
    "PLAN_CONTINUATION_LIMIT_REACHED",
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
