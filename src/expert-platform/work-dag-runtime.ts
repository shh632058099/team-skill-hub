import { stableDigest, type DagGraph, type DagScalar, type DagState } from "./work-dag.js";
import type { PlannerFrozenInput } from "./work-dag-policy.js";

export interface WorkDagRevisionRecord {
  workItemId: string;
  revision: number;
  parentRevision: number | null;
  attemptId: string | null;
  plannerIdentity: string;
  plannerVersion: string;
  validatorVersion: string;
  policyRevision: string;
  requirementSnapshotRevision: number;
  reasonCode: string;
  plannerInputDigest: string;
  graph: DagGraph;
  semanticDigest: string;
  createdAt: number;
}

export type WorkDagProposalStatus = "proposed" | "accepted" | "rejected" | "stale" | "noop";
export interface WorkDagProposalRecord {
  proposalId: string;
  workItemId: string;
  parentRevision: number;
  expectedWorkRevision: number;
  expectedRequirementRevision: number;
  attemptId: string | null;
  plannerIdentity: string;
  plannerVersion: string;
  validatorVersion: string;
  plannerInputDigest: string;
  reasonCode: string;
  graph: DagGraph;
  status: WorkDagProposalStatus;
  decisionCodes: string[];
  acceptedRevision: number | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface WorkDagNodeExecutionRecord {
  nodeExecutionId: string;
  workItemId: string;
  nodeId: string;
  createdDagRevision: number;
  generation: number;
  state: DagState;
  fence: number;
  idempotencyKey: string;
  subjectRevision: string | null;
  resourceIdentity: string | null;
  claimOwner: string | null;
  claimLeaseUntil: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  result: DagNodeResult | null;
  externalRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DagNodeFactOutput {
  key: string;
  value: DagScalar;
}
export interface DagNodeArtifactOutput {
  artifactId: string;
  type: string;
  ref: string;
  subjectRevision: string | null;
}
export interface DagNodeEvidenceOutput {
  evidenceId?: string;
  type: string;
  passed: boolean;
  subjectRevision: string | null;
  verifierIdentity: string;
  artifactRef?: string;
}
export interface DagNodeResult {
  status: "succeeded" | "failed" | "external_outcome_unknown";
  summary?: string;
  facts?: DagNodeFactOutput[];
  artifacts?: DagNodeArtifactOutput[];
  evidence?: DagNodeEvidenceOutput[];
  externalRef?: string;
}
export interface WorkDagFactRecord {
  factId: string;
  workItemId: string;
  key: string;
  value: DagScalar;
  subjectRevision: string | null;
  sourceExecutionId: string;
  createdAt: number;
}
export interface WorkDagEvidenceRecord {
  evidenceId: string;
  workItemId: string;
  type: string;
  passed: boolean;
  subjectRevision: string | null;
  verifierIdentity: string;
  artifactRef: string | null;
  sourceExecutionId: string;
  requirementSemanticsDigest: string;
  createdAt: number;
}

export interface WorkDagArtifactRecord {
  artifactId: string;
  workItemId: string;
  type: string;
  ref: string;
  subjectRevision: string | null;
  sourceExecutionId: string;
  createdAt: number;
}
export type WorkDagWaitState = "waiting" | "signaled" | "expired" | "cancelled";
export interface WorkDagWaitRecord {
  waitId: string;
  workItemId: string;
  nodeExecutionId: string;
  correlationKey: string;
  capability: string;
  state: WorkDagWaitState;
  expiresAt: number | null;
  signalEventId: string | null;
  signalDigest: string | null;
  signalPayload: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface WorkDagLateResultRecord {
  lateResultId: number;
  workItemId: string;
  nodeExecutionId: string;
  nodeId: string;
  ownerId: string;
  fence: number;
  currentState: WorkDagNodeExecutionRecord["state"];
  currentFence: number;
  disposition: "rejected_terminal_conflict" | "rejected_stale_claim" | "rejected_cas_race";
  result: DagNodeResult;
  resultDigest: string;
  createdAt: number;
}

export interface WorkDagReplanRequestRecord {
  requestId: string;
  workItemId: string;
  requestedBy: string;
  reason: string;
  state: "pending" | "consumed";
  proposalId: string | null;
  createdAt: number;
  consumedAt: number | null;
}

export interface WorkDagDecisionRecord {
  decisionId: number;
  workItemId: string;
  workStateRevision: number;
  dagRevision: number;
  requirementRevision: number;
  subjectRevision: string | null;
  action: string;
  nodeId: string | null;
  reasonCode: string;
  requirementIds: string[];
  policyRef: string;
  idempotencyRef: string | null;
  resultRef: string | null;
  createdAt: number;
}

export interface WorkDagPlannerInput {
  frozen: PlannerFrozenInput;
  digest: string;
  currentGraph: DagGraph | null;
  obligations: Array<{ id: string; condition: unknown; satisfaction: unknown }>;
}

export function graphSemanticDigest(graph: DagGraph): string {
  return stableDigest({
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => {
      const left = a.from + "\u0000" + a.to;
      const right = b.from + "\u0000" + b.to;
      return left.localeCompare(right);
    }),
  });
}

export function resultDigest(result: DagNodeResult): string {
  return stableDigest(result);
}
