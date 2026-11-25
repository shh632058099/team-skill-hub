import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { normalizeVerificationPolicy, type VerificationPolicyStep } from "./verification-policy.js";
import { resolveRuntimeProfilePolicy, type RuntimeProfileId } from "./runtime-profile-policy.js";
import { DatabaseSync } from "node:sqlite";
import type { ShadowDagProjection } from "./work-dag-shadow.js";
import { resolveWorkIntentDeterministically } from "./work-requirement-resolver.js";
import {
  policyContextObligations,
  workDagPolicyContextRef,
  workflowOnlyDagPolicyContext,
  type WorkDagPolicyContext,
} from "./work-dag-policy-context.js";
import {
  executionKey,
  completion,
  evaluatePredicate,
  expandResourceEvidenceObligations,
  readyNodes,
  subjectForResource,
  stableDigest,
  type DagContext,
  type DagExecution,
  type DagGraph,
  type DagNode,
  type DagObligation,
} from "./work-dag.js";
import {
  plannerInputDigest,
  WORK_DAG_POLICY_VALIDATOR_VERSION,
  validateDagProposal,
  detectPlanDeadlock,
  type PlannerFrozenInput,
} from "./work-dag-policy.js";
import {
  graphSemanticDigest,
  resultDigest,
  type DagNodeResult,
  type WorkDagArtifactRecord,
  type WorkDagDecisionRecord,
  type WorkDagFactRecord,
  type WorkDagLateResultRecord,
  type WorkDagEvidenceRecord,
  type WorkDagNodeExecutionRecord,
  type WorkDagPlannerInput,
  type WorkDagProposalRecord,
  type WorkDagReplanRequestRecord,
  type WorkDagWaitRecord,
  type WorkDagRevisionRecord,
} from "./work-dag-runtime.js";
import {
  effectiveObligations,
  classifyRequirementUpdateImpact,
  evidenceRequirementSemanticsDigest,
  effectiveRequirementDigest,
  normalizeWorkRequirements,
  normalizePinnedPolicyObligations,
  normalizeUnresolvedWorkRequirements,
  policyIdentity,
  type RequirementSnapshot,
  type RequirementUpdateImpact,
  type UnresolvedWorkRequirement,
  type WorkRequirement,
} from "./work-dag-requirements.js";

export type WorkStatus =
  "queued" | "running" | "blocked" | "waiting_review" | "rework" | "completed" | "failed" | "cancelled";

export type WorkAttemptReason = "initial" | "human_rework" | "review_rework" | "policy_replan";
export type WorkAttemptStatus = "active" | "succeeded" | "failed" | "cancelled";

export type WorkEvidenceStatus = "pending" | "passed" | "failed" | "unknown";
export type WorkEvidenceSource =
  "agent_reported" | "worker_verified" | "ci_verified" | "human_verified" | "external_verified";
export type ReviewDecision = "accepted" | "rework" | "rejected";
export type ApprovalDecision = "approved" | "rejected";

export interface WorkflowDefinition {
  lifecycle: {
    attempt: { maxWorkAttempts: number; maxReworks: number };
    continuation: { maxTurnsPerRun: number };
    retry: {
      failure: {
        enabled: boolean;
        maxRunsPerWorkAttempt: number;
        initialBackoffMs: number;
        maxBackoffMs: number;
      };
    };
    blocked: { timeoutPolicy: "manual" };
  };
  execution: {
    requiredRuntimeProfile?: RuntimeProfileId;
    workspace: {
      strategy: "isolated";
      reuseOnContinuation: boolean;
      cleanup: "on_terminal" | "retain";
    };
  };
  validation: { requiredEvidence: string[]; required: VerificationPolicyStep[] };
  review: { required: boolean; reviewerExpertId?: string };
  change?: { mode: "readonly" | "code_change" | "conditional_code_change"; delivery?: "merge_request" };
  selection?: { summary: string; useWhen: string[]; notWhen: string[] };
  source?: { terminal: { active: "cancel"; waitingReview: "retain_review" } };
  publication?: { required: boolean; mode: "work_branch"; approvalRequired?: boolean };
  planning?: {
    maxReplans: number;
    replanPolicy: Array<
      | "always_after_agent_turn"
      | "on_new_information"
      | "on_failure"
      | "on_review_rework"
      | "on_blocker_resolution"
      | "on_user_update"
      | "manual"
    >;
  };
  completion: {
    require: Array<
      | "latest_work_attempt_succeeded"
      | "required_evidence_passed"
      | "no_unresolved_blocker"
      | "review_accepted"
      | "required_approvals_approved"
      | "publication_succeeded"
      | "change_request_created"
    >;
    requiredApprovals?: Array<
      | { scope: "work_completion"; subjectType: "workspace_revision" }
      | { scope: "publish_work_branch"; subjectType: "publication_artifact" }
    >;
  };
  graph: { mode: "single-node" | "dynamic-dag" };
}

export interface WorkflowDefinitionRecord {
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  createdAt: number;
}

export interface SelectableWorkflowRecord {
  workflowId: string;
  version: number;
  changeMode: "readonly" | "code_change" | "conditional_code_change" | null;
  delivery: "merge_request" | null;
  summary: string;
  useWhen: string[];
  notWhen: string[];
  selectionConfigured: boolean;
}

export interface WorkSubmission {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceType: string;
  sourceScope?: string;
  sourceRef?: string;
  sourceUrl?: string;
  sourceRequestId?: string;
  sourceRequestSlot?: string;
  title: string;
  description: string;
  workflowId?: string;
  priority?: number;
  expertId?: string;
  deploymentId?: string;
  repositoryId?: string;
  requirementsDigest?: string;
}

export type WorkOrchestrationEngine = "legacy-single-node" | "dynamic-dag";

export interface WorkItemRecord {
  workItemId: string;
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceType: string;
  sourceScope: string | null;
  sourceRef: string | null;
  sourceUrl: string | null;
  sourceRequestId: string | null;
  sourceRequestSlot: string | null;
  title: string;
  description: string;
  status: WorkStatus;
  stateRevision: number;
  workflowId: string;
  workflowVersion: number;
  orchestrationEngine: WorkOrchestrationEngine;
  currentRequirementRevision: number;
  currentDagRevision: number;
  activeWorkAttemptId: string | null;
  orchestrationEpoch: number;
  orchestrationOwnerId: string | null;
  orchestrationLeaseUntil: number | null;
  orchestrationClaimedAt: number | null;
  priority: number | null;
  nextActionType: string | null;
  nextActionAt: number | null;
  nextActionContext: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  currentSubjectRevision: string | null;
  requestedExpertId: string | null;
  requestedDeploymentId: string | null;
  repositoryId: string | null;
  blockedReason: string | null;
  blockedContext: string | null;
  blockedAt: number | null;
  resumeCondition: string | null;
  blockedByType: string | null;
  blockedByRef: string | null;
  reusedExistingWork?: boolean;
  deduplicationReason?: "idempotency_key" | "same_source_request" | "source_identity";
}

export interface WorkOrchestrationClaim {
  workItemId: string;
  ownerId: string;
  epoch: number;
  leaseUntil: number;
  claimedAt: number;
}

export interface WorkOrchestrationFence {
  ownerId: string;
  epoch: number;
  now: number;
}

export interface WorkReworkRequest {
  reason: Exclude<WorkAttemptReason, "initial">;
  originWorkAttemptId: string;
  reviewContext?: string;
  whatShouldChange?: string;
  createdBy: string;
}

export interface CreateWorkAttemptInput {
  reason: WorkAttemptReason;
  expertId: string;
  deploymentId: string;
  deploymentConfigVersion: number;
  parentWorkAttemptId?: string;
  reviewContext?: string;
  whatShouldChange?: string;
  createdBy?: string;
  dispatchBinding?: Record<string, unknown>;
}

export interface WorkAttemptRecord {
  workAttemptId: string;
  workItemId: string;
  sequence: number;
  reason: WorkAttemptReason;
  status: WorkAttemptStatus;
  expertId: string;
  deploymentId: string;
  deploymentConfigVersion: number;
  workflowId: string;
  workflowVersion: number;
  workspaceId: string | null;
  taskId: string | null;
  reviewTaskId: string | null;
  runCount: number;
  parentWorkAttemptId: string | null;
  originWorkAttemptId: string | null;
  reviewContext: string | null;
  whatShouldChange: string | null;
  createdBy: string | null;
  startedAt: number;
  finishedAt: number | null;
  dispatchBinding: Record<string, unknown> | null;
}

export interface WorkspaceRecord {
  workspaceId: string;
  workspaceKey: string;
  workItemId: string;
  workAttemptId: string;
  resourceKey: string;
  repositoryId: string | null;
  ownerWorkerId: string | null;
  path: string | null;
  repositoryUrl: string | null;
  branch: string | null;
  baseCommit: string | null;
  state: "allocating" | "ready" | "in_use" | "retained" | "cleaning" | "removed" | "failed";
  cleanupPolicy: "on_terminal" | "retain";
  createdAt: number;
  lastUsedAt: number;
}

export interface WorkspaceCleanupClaim {
  workspaceId: string;
  workspaceKey: string;
  ownerWorkerId: string;
  fencing: number;
}

export interface WorkEvidenceRecord {
  evidenceId: string;
  workItemId: string;
  workAttemptId: string;
  resourceKey: string;
  repositoryId: string | null;
  taskId: string | null;
  runId: string | null;
  type: string;
  status: WorkEvidenceStatus;
  source: WorkEvidenceSource;
  summary: string | null;
  artifactRef: string | null;
  subjectRevision: string;
  environmentIdentity: string | null;
  verifierIdentity: string | null;
  stale: boolean;
  createdAt: number;
}

export interface ReviewDecisionRecord {
  reviewDecisionId: string;
  workItemId: string;
  subjectRevision: string;
  decision: ReviewDecision;
  reason: string | null;
  actorPrincipalId: string;
  createdAt: number;
}

export interface WorkApprovalRecord {
  approvalId: string;
  workItemId: string;
  workAttemptId: string | null;
  actor: string;
  role: string;
  approvalScope: string;
  subjectType: string;
  subjectRevision: string;
  decision: ApprovalDecision;
  stale: boolean;
  createdAt: number;
}

export interface WorkSourceObservationInput {
  workItemId: string;
  sourceType: string;
  sourceScope: string;
  sourceRef: string;
  state: "active" | "terminal";
  detail?: string;
  fingerprint: string;
  observedAt: number;
}

export interface WorkSourceObservationRecord extends Omit<WorkSourceObservationInput, "detail"> {
  observationId: string;
  detail: string | null;
  reconciliationAction: "cancel" | "retain_review" | "noop" | null;
  reconciledAt: number | null;
  createdAt: number;
}

export interface CompletionGateResult {
  ready: boolean;
  missing: string[];
  workflowId: string;
  workflowVersion: number;
  subjectRevision: string | null;
}

export interface WorkEventRecord {
  eventId: number;
  workItemId: string;
  workAttemptId: string | null;
  eventType: string;
  details: Record<string, unknown> | null;
  createdAt: number;
}

type Row = Record<string, unknown>;

const DEFAULT_WORKFLOW_ID = "code-fix-default";
const DEFAULT_WORKFLOW_VERSION = 1;
const DEFAULT_WORKFLOW: WorkflowDefinition = {
  lifecycle: {
    attempt: { maxWorkAttempts: 5, maxReworks: 3 },
    continuation: { maxTurnsPerRun: 20 },
    retry: {
      failure: {
        enabled: true,
        maxRunsPerWorkAttempt: 3,
        initialBackoffMs: 1_000,
        maxBackoffMs: 30_000,
      },
    },
    blocked: { timeoutPolicy: "manual" },
  },
  execution: {
    workspace: {
      strategy: "isolated",
      reuseOnContinuation: true,
      cleanup: "on_terminal",
    },
  },
  validation: { requiredEvidence: ["expert_result"], required: [] },
  review: { required: true },
  completion: {
    require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker", "review_accepted"],
  },
  graph: { mode: "single-node" },
};

function presetWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    ...structuredClone(DEFAULT_WORKFLOW),
    ...overrides,
    lifecycle: { ...structuredClone(DEFAULT_WORKFLOW.lifecycle), ...(overrides.lifecycle ?? {}) },
    execution: { ...structuredClone(DEFAULT_WORKFLOW.execution), ...(overrides.execution ?? {}) },
    validation: { ...structuredClone(DEFAULT_WORKFLOW.validation), ...(overrides.validation ?? {}) },
    review: { ...structuredClone(DEFAULT_WORKFLOW.review), ...(overrides.review ?? {}) },
    completion: { ...structuredClone(DEFAULT_WORKFLOW.completion), ...(overrides.completion ?? {}) },
    graph: { ...structuredClone(DEFAULT_WORKFLOW.graph), ...(overrides.graph ?? {}) },
  };
}

function codeChangePreset(selection?: NonNullable<WorkflowDefinition["selection"]>): WorkflowDefinition {
  return presetWorkflow({
    ...(selection ? { selection } : {}),
    change: { mode: "code_change", delivery: "merge_request" },
    validation: { requiredEvidence: ["expert_result", "build", "unit_test"], required: [] },
    review: { required: true },
    publication: { required: true, mode: "work_branch", approvalRequired: false },
    completion: {
      require: [
        "latest_work_attempt_succeeded",
        "required_evidence_passed",
        "no_unresolved_blocker",
        "review_accepted",
        "publication_succeeded",
        "change_request_created",
      ],
    },
  });
}

function dynamicCodeChangePreset(selection?: NonNullable<WorkflowDefinition["selection"]>): WorkflowDefinition {
  return {
    ...codeChangePreset(selection),
    planning: {
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
    },
    graph: { mode: "dynamic-dag" },
  };
}

function readonlyPreset(selection?: NonNullable<WorkflowDefinition["selection"]>): WorkflowDefinition {
  return presetWorkflow({
    ...(selection ? { selection } : {}),
    change: { mode: "readonly" },
    lifecycle: { ...DEFAULT_WORKFLOW.lifecycle, attempt: { maxWorkAttempts: 3, maxReworks: 2 } },
    review: { required: false },
    completion: {
      require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker"],
    },
  });
}

function conditionalReviewFixPreset(selection?: NonNullable<WorkflowDefinition["selection"]>): WorkflowDefinition {
  return presetWorkflow({
    ...(selection ? { selection } : {}),
    change: { mode: "conditional_code_change" },
    validation: { requiredEvidence: ["build", "unit_test"], required: [] },
    review: { required: true },
    publication: { required: false, mode: "work_branch", approvalRequired: false },
    completion: {
      require: [
        "latest_work_attempt_succeeded",
        "required_evidence_passed",
        "no_unresolved_blocker",
        "review_accepted",
      ],
    },
    planning: {
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
    },
    graph: { mode: "dynamic-dag" },
  });
}

const PLATFORM_PRESET_WORKFLOWS: ReadonlyArray<readonly [string, number, WorkflowDefinition]> = [
  [
    "investigation",
    1,
    presetWorkflow({ lifecycle: { ...DEFAULT_WORKFLOW.lifecycle, attempt: { maxWorkAttempts: 3, maxReworks: 2 } } }),
  ],
  [
    "code-review",
    1,
    presetWorkflow({ lifecycle: { ...DEFAULT_WORKFLOW.lifecycle, attempt: { maxWorkAttempts: 3, maxReworks: 2 } } }),
  ],
  ["bug-fix", 1, presetWorkflow()],
  ["feature-change", 1, presetWorkflow()],
  ["refactor", 1, presetWorkflow()],
  ["test-improvement", 1, presetWorkflow()],
  ["build-fix", 1, presetWorkflow()],
  [
    "release-change",
    1,
    presetWorkflow({
      publication: { required: true, mode: "work_branch" },
      completion: {
        require: [
          "latest_work_attempt_succeeded",
          "required_evidence_passed",
          "no_unresolved_blocker",
          "review_accepted",
          "required_approvals_approved",
          "publication_succeeded",
        ],
        requiredApprovals: [{ scope: "publish_work_branch", subjectType: "publication_artifact" }],
      },
    }),
  ],
  [
    "investigation",
    2,
    presetWorkflow({
      change: { mode: "readonly" },
      lifecycle: { ...DEFAULT_WORKFLOW.lifecycle, attempt: { maxWorkAttempts: 3, maxReworks: 2 } },
    }),
  ],
  [
    "code-review",
    2,
    presetWorkflow({
      change: { mode: "readonly" },
      lifecycle: { ...DEFAULT_WORKFLOW.lifecycle, attempt: { maxWorkAttempts: 3, maxReworks: 2 } },
    }),
  ],
  ["investigation", 3, readonlyPreset()],
  ["code-review", 3, readonlyPreset()],
  ["bug-fix", 2, codeChangePreset()],
  ["feature-change", 2, codeChangePreset()],
  ["refactor", 2, codeChangePreset()],
  ["test-improvement", 2, codeChangePreset()],
  ["build-fix", 2, codeChangePreset()],
  ["release-change", 2, codeChangePreset()],
  [
    "investigation",
    4,
    readonlyPreset({
      summary: "Readonly analysis, search, statistics, diagnosis, or code inspection.",
      useWhen: [
        "the primary requested outcome is to understand, inspect, search, diagnose, or measure without modifying repository files",
      ],
      notWhen: ["the user asks to modify repository files or deliver a code change"],
    }),
  ],
  [
    "code-review",
    4,
    readonlyPreset({
      summary: "Readonly code review that produces findings without modifying repository files.",
      useWhen: ["the primary requested outcome is review findings, risks, or maintainability feedback without edits"],
      notWhen: ["the user asks to fix findings or otherwise modify repository files"],
    }),
  ],
  [
    "review-fix-verify",
    1,
    conditionalReviewFixPreset({
      summary:
        "Review code first. Only if review finds a blocking issue, fix it, then build/test to verify and review the repaired result.",
      useWhen: [
        "review code first, fix blocking findings if any, then verify the repaired result",
        "review一下，有问题就修，修完验证",
        "review, fix if needed, then verify",
      ],
      notWhen: [
        "the user requests readonly review findings and explicitly forbids fixes",
        "the primary outcome is a known bug fix or feature implementation rather than review-first conditional repair",
      ],
    }),
  ],
  [
    "bug-fix",
    3,
    codeChangePreset({
      summary: "Fix incorrect existing runtime or business behavior.",
      useWhen: [
        "broken existing functionality, regressions, crashes, or incorrect behavior are the primary requested outcome",
      ],
      notWhen: [
        "the primary requested outcome is a new feature, test-only improvement, build-system repair, or release change",
      ],
    }),
  ],
  [
    "feature-change",
    3,
    codeChangePreset({
      summary: "Implement new or changed externally observable behavior.",
      useWhen: [
        "a new feature, requirement, API behavior, or externally observable behavior is the primary requested outcome",
      ],
      notWhen: ["the primary requested outcome is only refactoring, tests, buildability, or release preparation"],
    }),
  ],
  [
    "refactor",
    3,
    codeChangePreset({
      summary: "Restructure existing code without an intended behavior change.",
      useWhen: [
        "code structure, maintainability, or organization is the primary requested outcome and behavior should stay stable",
      ],
      notWhen: ["the user primarily requests a bug fix, new behavior, test change, build repair, or release change"],
    }),
  ],
  [
    "test-improvement",
    3,
    codeChangePreset({
      summary: "Add, fix, or improve tests when the tests themselves are the primary deliverable.",
      useWhen: ["test coverage, test cases, or test infrastructure are the primary requested outcome"],
      notWhen: ["tests are secondary work supporting a bug fix or feature change"],
    }),
  ],
  [
    "build-fix",
    3,
    codeChangePreset({
      summary: "Restore compilation, linking, or CI buildability when buildability itself is the primary deliverable.",
      useWhen: ["build, link, toolchain, or CI buildability repair is the primary requested outcome"],
      notWhen: ["a feature or bug task merely happens to encounter a build failure during verification"],
    }),
  ],
  [
    "release-change",
    3,
    codeChangePreset({
      summary: "Change versioning, packaging, release, or publishing behavior.",
      useWhen: ["versioning, packaging, release preparation, or publishing is the primary requested outcome"],
      notWhen: ["release activity is only a downstream consequence of another primary code-change task"],
    }),
  ],
  [
    "bug-fix",
    4,
    dynamicCodeChangePreset({
      summary: "Fix incorrect existing runtime or business behavior.",
      useWhen: [
        "broken existing functionality, regressions, crashes, or incorrect behavior are the primary requested outcome",
      ],
      notWhen: [
        "the primary requested outcome is a new feature, test-only improvement, build-system repair, or release change",
      ],
    }),
  ],
  [
    "feature-change",
    4,
    dynamicCodeChangePreset({
      summary: "Implement new or changed externally observable behavior.",
      useWhen: [
        "a new feature, requirement, API behavior, or externally observable behavior is the primary requested outcome",
      ],
      notWhen: ["the primary requested outcome is only refactoring, tests, buildability, or release preparation"],
    }),
  ],
  [
    "refactor",
    4,
    dynamicCodeChangePreset({
      summary: "Restructure existing code without an intended behavior change.",
      useWhen: [
        "code structure, maintainability, or organization is the primary requested outcome and behavior should stay stable",
      ],
      notWhen: ["the user primarily requests a bug fix, new behavior, test change, build repair, or release change"],
    }),
  ],
  [
    "test-improvement",
    4,
    dynamicCodeChangePreset({
      summary: "Add, fix, or improve tests when the tests themselves are the primary deliverable.",
      useWhen: ["test coverage, test cases, or test infrastructure are the primary requested outcome"],
      notWhen: ["tests are secondary work supporting a bug fix or feature change"],
    }),
  ],
  [
    "build-fix",
    4,
    dynamicCodeChangePreset({
      summary: "Restore compilation, linking, or CI buildability when buildability itself is the primary deliverable.",
      useWhen: ["build, link, toolchain, or CI buildability repair is the primary requested outcome"],
      notWhen: ["a feature or bug task merely happens to encounter a build failure during verification"],
    }),
  ],
  [
    "release-change",
    4,
    dynamicCodeChangePreset({
      summary: "Change versioning, packaging, release, or publishing behavior.",
      useWhen: ["versioning, packaging, release preparation, or publishing is the primary requested outcome"],
      notWhen: ["release activity is only a downstream consequence of another primary code-change task"],
    }),
  ],
];
const WORK_STATUSES = new Set<WorkStatus>([
  "queued",
  "running",
  "blocked",
  "waiting_review",
  "rework",
  "completed",
  "failed",
  "cancelled",
]);
const TERMINAL_WORK_STATUSES = new Set<WorkStatus>(["completed", "failed", "cancelled"]);

function requiredText(value: string | undefined, max: number): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function optionalText(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new Error("INVALID_WORK_REQUEST");
  return normalized;
}

function requestDigest(input: WorkSubmission, workflowId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceType: input.sourceType.trim(),
        sourceScope: input.sourceScope?.trim() || null,
        sourceRef: input.sourceRef?.trim() || null,
        sourceUrl: input.sourceUrl?.trim() || null,
        title: input.title.trim(),
        description: input.description.trim(),
        workflowId,
        priority: input.priority ?? null,
        expertId: input.expertId?.trim() || null,
        deploymentId: input.deploymentId?.trim() || null,
        repositoryId: input.repositoryId?.trim() || null,
        requirementsDigest: input.requirementsDigest?.trim() || null,
      }),
    )
    .digest("hex");
}

export class WorkOrchestrationStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      [
        "PRAGMA journal_mode=WAL;",
        "PRAGMA foreign_keys=ON;",
        "CREATE TABLE IF NOT EXISTS work_workflows (",
        "  workflow_id TEXT NOT NULL,",
        "  version INTEGER NOT NULL,",
        "  definition_json TEXT NOT NULL,",
        "  created_at INTEGER NOT NULL,",
        "  PRIMARY KEY(workflow_id,version)",
        ");",
        "CREATE TABLE IF NOT EXISTS work_repository_workflow_defaults (",
        "  repository_id TEXT PRIMARY KEY,",
        "  workflow_id TEXT NOT NULL,",
        "  updated_at INTEGER NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS work_items (",
        "  work_item_id TEXT PRIMARY KEY,",
        "  principal_id TEXT NOT NULL,",
        "  scope TEXT NOT NULL,",
        "  idempotency_key TEXT NOT NULL,",
        "  request_digest TEXT NOT NULL,",
        "  source_type TEXT NOT NULL,",
        "  source_scope TEXT,",
        "  source_ref TEXT,",
        "  source_url TEXT,",
        "  source_request_id TEXT,",
        "  source_request_slot TEXT,",
        "  title TEXT NOT NULL,",
        "  description TEXT NOT NULL,",
        "  status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','waiting_review','rework','completed','failed','cancelled')),",
        "  state_revision INTEGER NOT NULL DEFAULT 1,",
        "  workflow_id TEXT NOT NULL,",
        "  workflow_version INTEGER NOT NULL,",
        "  orchestration_engine TEXT NOT NULL DEFAULT 'legacy-single-node' CHECK(orchestration_engine IN ('legacy-single-node','dynamic-dag')),",
        "  current_requirement_revision INTEGER NOT NULL DEFAULT 0,",
        "  current_dag_revision INTEGER NOT NULL DEFAULT 0,",
        "  active_work_attempt_id TEXT,",
        "  orchestration_epoch INTEGER NOT NULL DEFAULT 1,",
        "  orchestration_owner_id TEXT,",
        "  orchestration_lease_until INTEGER,",
        "  orchestration_claimed_at INTEGER,",
        "  priority INTEGER,",
        "  next_action_type TEXT,",
        "  next_action_at INTEGER,",
        "  next_action_context TEXT,",
        "  created_at INTEGER NOT NULL,",
        "  updated_at INTEGER NOT NULL,",
        "  completed_at INTEGER,",
        "  current_subject_revision TEXT,",
        "  requested_expert_id TEXT,",
        "  requested_deployment_id TEXT,",
        "  repository_id TEXT,",
        "  blocked_reason TEXT,",
        "  blocked_context TEXT,",
        "  blocked_at INTEGER,",
        "  resume_condition TEXT,",
        "  blocked_by_type TEXT,",
        "  blocked_by_ref TEXT,",
        "  UNIQUE(principal_id,scope,idempotency_key)",
        ");",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_source_identity",
        "  ON work_items(principal_id,scope,source_type,source_scope,source_ref)",
        "  WHERE source_scope IS NOT NULL AND source_ref IS NOT NULL;",
        "CREATE INDEX IF NOT EXISTS idx_work_status_due ON work_items(status,next_action_at);",

        "CREATE TABLE IF NOT EXISTS work_attempts (",
        "  work_attempt_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  sequence INTEGER NOT NULL,",
        "  reason TEXT NOT NULL CHECK(reason IN ('initial','human_rework','review_rework','policy_replan')),",
        "  status TEXT NOT NULL CHECK(status IN ('active','succeeded','failed','cancelled')),",
        "  expert_id TEXT NOT NULL,",
        "  deployment_id TEXT NOT NULL,",
        "  deployment_config_version INTEGER NOT NULL,",
        "  workflow_id TEXT NOT NULL,",
        "  workflow_version INTEGER NOT NULL,",
        "  workspace_id TEXT,",
        "  task_id TEXT,",
        "  review_task_id TEXT,",
        "  run_count INTEGER NOT NULL DEFAULT 0,",
        "  parent_work_attempt_id TEXT,",
        "  review_context TEXT,",
        "  what_should_change TEXT,",
        "  created_by TEXT,",
        "  started_at INTEGER NOT NULL,",
        "  finished_at INTEGER,",
        "  dispatch_binding_json TEXT,",
        "  UNIQUE(work_item_id,sequence)",
        ");",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_active_attempt",
        "  ON work_attempts(work_item_id) WHERE status='active';",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_work_attempt_task",
        "  ON work_attempts(task_id) WHERE task_id IS NOT NULL;",
        "CREATE TABLE IF NOT EXISTS work_events (",
        "  event_id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  work_attempt_id TEXT,",
        "  event_type TEXT NOT NULL,",
        "  details TEXT,",
        "  created_at INTEGER NOT NULL",
        ");",

        "CREATE TABLE IF NOT EXISTS work_workspaces (",
        "  workspace_id TEXT PRIMARY KEY,",
        "  workspace_key TEXT NOT NULL UNIQUE,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        "  resource_key TEXT NOT NULL DEFAULT 'workspace',",
        "  repository_id TEXT,",
        "  owner_worker_id TEXT,",
        "  path TEXT,",
        "  repository_url TEXT,",
        "  branch TEXT,",
        "  base_commit TEXT,",
        "  state TEXT NOT NULL CHECK(state IN ('allocating','ready','in_use','retained','cleaning','removed','failed')),",
        "  cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('on_terminal','retain')),",
        "  created_at INTEGER NOT NULL,",
        "  last_used_at INTEGER NOT NULL,",
        "  UNIQUE(work_attempt_id,resource_key)",
        ");",
        "CREATE TABLE IF NOT EXISTS work_evidence (",
        "  evidence_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        "  task_id TEXT,",
        "  run_id TEXT,",
        "  type TEXT NOT NULL,",
        "  status TEXT NOT NULL CHECK(status IN ('pending','passed','failed','unknown')),",
        "  source TEXT NOT NULL CHECK(source IN ('agent_reported','worker_verified','ci_verified','human_verified','external_verified')),",
        "  summary TEXT,",
        "  artifact_ref TEXT,",
        "  subject_revision TEXT NOT NULL,",
        "  environment_identity TEXT,",
        "  verifier_identity TEXT,",
        "  stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),",
        "  created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_evidence_item ON work_evidence(work_item_id,type,stale);",
        "CREATE TABLE IF NOT EXISTS work_review_decisions (",
        "  review_decision_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  subject_revision TEXT NOT NULL,",
        "  decision TEXT NOT NULL CHECK(decision IN ('accepted','rework','rejected')),",
        "  reason TEXT,",
        "  actor_principal_id TEXT NOT NULL,",
        "  created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_review_item ON work_review_decisions(work_item_id,created_at);",
        "CREATE TABLE IF NOT EXISTS work_source_observations (",
        "  observation_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  source_type TEXT NOT NULL, source_scope TEXT NOT NULL, source_ref TEXT NOT NULL,",
        "  state TEXT NOT NULL CHECK(state IN ('active','terminal')), detail TEXT, fingerprint TEXT NOT NULL,",
        "  reconciliation_action TEXT CHECK(reconciliation_action IN ('cancel','retain_review','noop')), reconciled_at INTEGER,",
        "  observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL,",
        "  UNIQUE(work_item_id,fingerprint)",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_source_observation_item ON work_source_observations(work_item_id,observed_at);",
        "CREATE TABLE IF NOT EXISTS work_source_controls (",
        "  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  token_hash TEXT NOT NULL,",
        "  rotated_at INTEGER NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS work_source_control_tokens (",
        "  token_hash TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_source_control_tokens_item ON work_source_control_tokens(work_item_id,created_at DESC);",
        "CREATE TABLE IF NOT EXISTS work_approvals (",
        "  approval_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  work_attempt_id TEXT,",
        "  actor TEXT NOT NULL,",
        "  role TEXT NOT NULL,",
        "  approval_scope TEXT NOT NULL,",
        "  subject_type TEXT NOT NULL,",
        "  subject_revision TEXT NOT NULL,",
        "  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),",
        "  stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),",
        "  created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_approval_item ON work_approvals(work_item_id,stale);",
        "CREATE INDEX IF NOT EXISTS idx_work_event_item ON work_events(work_item_id,event_id);",
        "CREATE TABLE IF NOT EXISTS work_shadow_dags (",
        "  work_item_id TEXT PRIMARY KEY REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  state_revision INTEGER NOT NULL,",
        "  source_digest TEXT NOT NULL,",
        "  semantic_digest TEXT NOT NULL,",
        "  projection_json TEXT NOT NULL,",
        "  updated_at INTEGER NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS work_requirement_snapshots (",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  revision INTEGER NOT NULL,",
        "  resolver_identity TEXT NOT NULL DEFAULT 'legacy-snapshot',",
        "  resolver_version TEXT NOT NULL,",
        "  original_request TEXT NOT NULL DEFAULT '',",
        "  original_request_digest TEXT NOT NULL DEFAULT '',",
        "  requirements_json TEXT NOT NULL,",
        "  unresolved_json TEXT NOT NULL DEFAULT '[]',",
        "  policy_obligations_json TEXT NOT NULL DEFAULT '[]',",
        "  policy_context_ref TEXT NOT NULL DEFAULT '',",
        "  policy_context_digest TEXT NOT NULL DEFAULT '',",
        "  policy_ref TEXT NOT NULL,",
        "  policy_digest TEXT NOT NULL,",
        "  effective_digest TEXT NOT NULL,",
        "  created_at INTEGER NOT NULL,",
        "  PRIMARY KEY(work_item_id,revision)",
        ");",
        "CREATE TABLE IF NOT EXISTS work_dag_revisions (",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  revision INTEGER NOT NULL, parent_revision INTEGER, attempt_id TEXT,",
        "  planner_identity TEXT NOT NULL, planner_version TEXT NOT NULL, validator_version TEXT NOT NULL DEFAULT 'work-dag-policy@1', policy_revision TEXT NOT NULL,",
        "  requirement_revision INTEGER NOT NULL, reason_code TEXT NOT NULL, planner_input_digest TEXT NOT NULL,",
        "  graph_json TEXT NOT NULL, semantic_digest TEXT NOT NULL, created_at INTEGER NOT NULL,",
        "  PRIMARY KEY(work_item_id,revision)",
        ");",
        "CREATE TABLE IF NOT EXISTS work_dag_proposals (",
        "  proposal_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  parent_revision INTEGER NOT NULL, expected_work_revision INTEGER NOT NULL, expected_requirement_revision INTEGER NOT NULL,",
        "  attempt_id TEXT, planner_identity TEXT NOT NULL, planner_version TEXT NOT NULL, validator_version TEXT NOT NULL DEFAULT 'work-dag-policy@1', planner_input_digest TEXT NOT NULL,",
        "  reason_code TEXT NOT NULL, graph_json TEXT NOT NULL,",
        "  status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected','stale','noop')),",
        "  decision_codes_json TEXT NOT NULL, accepted_revision INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_proposal_item ON work_dag_proposals(work_item_id,created_at);",
        "CREATE TABLE IF NOT EXISTS work_dag_replan_requests (",
        "  request_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  requested_by TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','consumed')),",
        "  proposal_id TEXT, created_at INTEGER NOT NULL, consumed_at INTEGER",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_replan_request_item ON work_dag_replan_requests(work_item_id,state,created_at);",
        "CREATE TABLE IF NOT EXISTS work_dag_executions (",
        "  node_execution_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  node_id TEXT NOT NULL, created_dag_revision INTEGER NOT NULL, bound_requirement_revision INTEGER, generation INTEGER NOT NULL,",
        "  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','succeeded','failed','cancelled','superseded','external_outcome_unknown')),",
        "  fence INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT NOT NULL UNIQUE, subject_revision TEXT, resource_identity TEXT,",
        "  claim_owner TEXT, claim_lease_until INTEGER, started_at INTEGER, finished_at INTEGER, result_json TEXT, result_digest TEXT, external_ref TEXT,",
        "  superseded_by_node_id TEXT, superseded_dag_revision INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,",
        "  UNIQUE(work_item_id,node_id,generation)",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_execution_item ON work_dag_executions(work_item_id,node_id,generation);",
        "CREATE TABLE IF NOT EXISTS work_dag_late_results (",
        "  late_result_id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  node_execution_id TEXT NOT NULL, node_id TEXT NOT NULL, owner_id TEXT NOT NULL, fence INTEGER NOT NULL,",
        "  current_state TEXT NOT NULL, current_fence INTEGER NOT NULL, disposition TEXT NOT NULL,",
        "  result_json TEXT NOT NULL, result_digest TEXT NOT NULL, created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_late_result_item ON work_dag_late_results(work_item_id,late_result_id);",
        "CREATE TABLE IF NOT EXISTS work_dag_facts (",
        "  fact_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  fact_key TEXT NOT NULL, value_json TEXT NOT NULL, subject_revision TEXT, resource_identity TEXT, source_execution_id TEXT NOT NULL, created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_fact_item ON work_dag_facts(work_item_id,fact_key,created_at);",
        "CREATE TABLE IF NOT EXISTS work_dag_evidence (",
        "  evidence_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  evidence_type TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)), subject_revision TEXT, resource_identity TEXT,",
        "  verifier_identity TEXT NOT NULL, artifact_ref TEXT, source_execution_id TEXT NOT NULL, requirement_semantics_digest TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_evidence_item ON work_dag_evidence(work_item_id,evidence_type,created_at);",
        "CREATE TABLE IF NOT EXISTS work_dag_artifacts (",
        "  artifact_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  artifact_type TEXT NOT NULL, artifact_ref TEXT NOT NULL, subject_revision TEXT, resource_identity TEXT, source_execution_id TEXT NOT NULL, created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_artifact_item ON work_dag_artifacts(work_item_id,artifact_type,created_at);",
        "CREATE TABLE IF NOT EXISTS work_dag_resource_subjects (",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE, resource_identity TEXT NOT NULL,",
        "  subject_revision TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(work_item_id,resource_identity)",
        ");",
        "CREATE TABLE IF NOT EXISTS work_dag_decisions (",
        "  decision_id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  work_state_revision INTEGER NOT NULL, dag_revision INTEGER NOT NULL, requirement_revision INTEGER NOT NULL,",
        "  subject_revision TEXT, action TEXT NOT NULL, node_id TEXT, reason_code TEXT NOT NULL, requirement_ids_json TEXT NOT NULL,",
        "  policy_ref TEXT NOT NULL, idempotency_ref TEXT, result_ref TEXT, created_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_decision_item ON work_dag_decisions(work_item_id,decision_id);",
        "CREATE TABLE IF NOT EXISTS work_dag_supersessions (",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  node_id TEXT NOT NULL, dag_revision INTEGER NOT NULL, superseded_by_node_id TEXT, reason_code TEXT NOT NULL, created_at INTEGER NOT NULL,",
        "  PRIMARY KEY(work_item_id,node_id,dag_revision)",
        ");",
        "CREATE TABLE IF NOT EXISTS work_dag_waits (",
        "  wait_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
        "  node_execution_id TEXT NOT NULL UNIQUE, correlation_key TEXT NOT NULL UNIQUE, capability TEXT NOT NULL,",
        "  state TEXT NOT NULL CHECK(state IN ('waiting','signaled','expired','cancelled')), expires_at INTEGER,",
        "  signal_event_id TEXT, signal_digest TEXT, signal_payload_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_dag_wait_item ON work_dag_waits(work_item_id,state);",
        "CREATE TABLE IF NOT EXISTS work_dag_wait_events (",
        "  event_id TEXT PRIMARY KEY, correlation_key TEXT NOT NULL, payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL,",
        "  disposition TEXT NOT NULL, created_at INTEGER NOT NULL",
        ");",
      ].join("\n"),
    );
    this.ensureDefaultWorkflow();
    this.db.exec(
      "INSERT OR IGNORE INTO work_source_control_tokens(token_hash,work_item_id,created_at,expires_at) " +
        "SELECT token_hash,work_item_id,rotated_at,rotated_at+2592000000 FROM work_source_controls",
    );
    const workColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!workColumns.has("current_requirement_revision")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN current_requirement_revision INTEGER NOT NULL DEFAULT 0");
    }
    if (!workColumns.has("current_dag_revision")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN current_dag_revision INTEGER NOT NULL DEFAULT 0");
    }
    if (!workColumns.has("orchestration_engine")) {
      this.db.exec(
        "ALTER TABLE work_items ADD COLUMN orchestration_engine TEXT NOT NULL DEFAULT 'legacy-single-node' CHECK(orchestration_engine IN ('legacy-single-node','dynamic-dag'))",
      );
    }
    const requirementSnapshotColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_requirement_snapshots)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!requirementSnapshotColumns.has("resolver_identity")) {
      this.db.exec(
        "ALTER TABLE work_requirement_snapshots ADD COLUMN resolver_identity TEXT NOT NULL DEFAULT 'legacy-snapshot'",
      );
    }
    if (!requirementSnapshotColumns.has("original_request")) {
      this.db.exec("ALTER TABLE work_requirement_snapshots ADD COLUMN original_request TEXT NOT NULL DEFAULT ''");
    }
    if (!requirementSnapshotColumns.has("original_request_digest")) {
      this.db.exec(
        "ALTER TABLE work_requirement_snapshots ADD COLUMN original_request_digest TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!requirementSnapshotColumns.has("unresolved_json")) {
      this.db.exec("ALTER TABLE work_requirement_snapshots ADD COLUMN unresolved_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!requirementSnapshotColumns.has("policy_obligations_json")) {
      this.db.exec(
        "ALTER TABLE work_requirement_snapshots ADD COLUMN policy_obligations_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!requirementSnapshotColumns.has("policy_context_ref")) {
      this.db.exec("ALTER TABLE work_requirement_snapshots ADD COLUMN policy_context_ref TEXT NOT NULL DEFAULT ''");
    }
    if (!requirementSnapshotColumns.has("policy_context_digest")) {
      this.db.exec("ALTER TABLE work_requirement_snapshots ADD COLUMN policy_context_digest TEXT NOT NULL DEFAULT ''");
    }
    const legacyRequirementRows = this.db
      .prepare(
        "SELECT s.work_item_id,s.revision,s.original_request,s.original_request_digest,w.description FROM work_requirement_snapshots s JOIN work_items w ON w.work_item_id=s.work_item_id",
      )
      .all() as Array<{
      work_item_id: string;
      revision: number;
      original_request: string;
      original_request_digest: string;
      description: string;
    }>;
    for (const row of legacyRequirementRows) {
      if (row.original_request && row.original_request_digest) continue;
      const originalRequest = row.original_request || row.description || "";
      this.db
        .prepare(
          "UPDATE work_requirement_snapshots SET original_request=?,original_request_digest=? WHERE work_item_id=? AND revision=?",
        )
        .run(originalRequest, stableDigest(originalRequest), row.work_item_id, row.revision);
    }

    const dagExecutionColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_dag_executions)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!dagExecutionColumns.has("external_ref")) {
      this.db.exec("ALTER TABLE work_dag_executions ADD COLUMN external_ref TEXT");
    }
    if (!dagExecutionColumns.has("bound_requirement_revision")) {
      this.db.exec("ALTER TABLE work_dag_executions ADD COLUMN bound_requirement_revision INTEGER");
    }
    const dagRevisionColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_dag_revisions)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!dagRevisionColumns.has("validator_version")) {
      this.db.exec(
        "ALTER TABLE work_dag_revisions ADD COLUMN validator_version TEXT NOT NULL DEFAULT 'work-dag-policy@1'",
      );
    }
    const dagProposalColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_dag_proposals)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!dagProposalColumns.has("validator_version")) {
      this.db.exec(
        "ALTER TABLE work_dag_proposals ADD COLUMN validator_version TEXT NOT NULL DEFAULT 'work-dag-policy@1'",
      );
    }
    const dagFactColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_dag_facts)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!dagFactColumns.has("resource_identity")) {
      this.db.exec("ALTER TABLE work_dag_facts ADD COLUMN resource_identity TEXT");
    }
    const dagEvidenceColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_dag_evidence)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!dagEvidenceColumns.has("requirement_semantics_digest")) {
      this.db.exec("ALTER TABLE work_dag_evidence ADD COLUMN requirement_semantics_digest TEXT NOT NULL DEFAULT ''");
    }
    if (!dagEvidenceColumns.has("resource_identity")) {
      this.db.exec("ALTER TABLE work_dag_evidence ADD COLUMN resource_identity TEXT");
    }
    const dagArtifactColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_dag_artifacts)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!dagArtifactColumns.has("resource_identity")) {
      this.db.exec("ALTER TABLE work_dag_artifacts ADD COLUMN resource_identity TEXT");
    }
    if (!workColumns.has("next_action_context")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN next_action_context TEXT");
    }
    if (!workColumns.has("orchestration_owner_id")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN orchestration_owner_id TEXT");
    }
    if (!workColumns.has("orchestration_lease_until")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN orchestration_lease_until INTEGER");
    }
    if (!workColumns.has("orchestration_claimed_at")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN orchestration_claimed_at INTEGER");
    }
    if (!workColumns.has("blocked_at")) this.db.exec("ALTER TABLE work_items ADD COLUMN blocked_at INTEGER");
    if (!workColumns.has("resume_condition")) this.db.exec("ALTER TABLE work_items ADD COLUMN resume_condition TEXT");
    if (!workColumns.has("blocked_by_type")) this.db.exec("ALTER TABLE work_items ADD COLUMN blocked_by_type TEXT");
    if (!workColumns.has("blocked_by_ref")) this.db.exec("ALTER TABLE work_items ADD COLUMN blocked_by_ref TEXT");
    if (!workColumns.has("source_request_id")) this.db.exec("ALTER TABLE work_items ADD COLUMN source_request_id TEXT");
    if (!workColumns.has("source_request_slot"))
      this.db.exec("ALTER TABLE work_items ADD COLUMN source_request_slot TEXT");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_work_source_request ON work_items(principal_id,scope,source_type,source_scope,source_request_id,source_request_slot,status)",
    );
    const attemptColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_attempts)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!attemptColumns.has("review_context")) this.db.exec("ALTER TABLE work_attempts ADD COLUMN review_context TEXT");
    if (!attemptColumns.has("what_should_change"))
      this.db.exec("ALTER TABLE work_attempts ADD COLUMN what_should_change TEXT");
    if (!attemptColumns.has("created_by")) this.db.exec("ALTER TABLE work_attempts ADD COLUMN created_by TEXT");
    if (!attemptColumns.has("review_task_id")) this.db.exec("ALTER TABLE work_attempts ADD COLUMN review_task_id TEXT");
    const approvalColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_approvals)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!approvalColumns.has("work_attempt_id"))
      this.db.exec("ALTER TABLE work_approvals ADD COLUMN work_attempt_id TEXT");
    this.migrateWorkspaceSchema();
    this.ensureWorkspaceCleanupSchema();
  }

  private migrateWorkspaceSchema(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_workspaces'").get() as
      { sql?: string } | undefined;
    const sql = row?.sql ?? "";
    const current =
      sql.includes("'allocating'") &&
      sql.includes("'cleaning'") &&
      sql.includes("'retain'") &&
      sql.includes("resource_key") &&
      sql.includes("UNIQUE(work_attempt_id,resource_key)");
    if (current) {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_work_workspace_attempt_resource ON work_workspaces(work_attempt_id,resource_key)",
      );
      return;
    }
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(
        (this.db.prepare("PRAGMA table_info(work_workspaces)").all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      const resourceExpr = columns.has("resource_key") ? "resource_key" : "'workspace'";
      const repositoryExpr = columns.has("repository_id")
        ? "repository_id"
        : "(SELECT repository_id FROM work_items WHERE work_items.work_item_id=work_workspaces.work_item_id)";
      this.db.exec(
        [
          "CREATE TABLE work_workspaces_v3 (",
          " workspace_id TEXT PRIMARY KEY,",
          " workspace_key TEXT NOT NULL UNIQUE,",
          " work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
          " work_attempt_id TEXT NOT NULL REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
          " resource_key TEXT NOT NULL DEFAULT 'workspace', repository_id TEXT,",
          " owner_worker_id TEXT, path TEXT, repository_url TEXT, branch TEXT, base_commit TEXT,",
          " state TEXT NOT NULL CHECK(state IN ('allocating','ready','in_use','retained','cleaning','removed','failed')),",
          " cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('on_terminal','retain')),",
          " created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,",
          " UNIQUE(work_attempt_id,resource_key)",
          ");",
          "INSERT INTO work_workspaces_v3(workspace_id,workspace_key,work_item_id,work_attempt_id,resource_key,repository_id,owner_worker_id,path,repository_url,branch,base_commit,state,cleanup_policy,created_at,last_used_at) " +
            "SELECT workspace_id,workspace_key,work_item_id,work_attempt_id," +
            resourceExpr +
            "," +
            repositoryExpr +
            ",owner_worker_id,path,repository_url,branch,base_commit,state,cleanup_policy,created_at,last_used_at FROM work_workspaces;",
          "DROP TABLE work_workspaces;",
          "ALTER TABLE work_workspaces_v3 RENAME TO work_workspaces;",
          "CREATE INDEX IF NOT EXISTS idx_work_workspace_attempt_resource ON work_workspaces(work_attempt_id,resource_key);",
        ].join("\n"),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
  }
  private ensureWorkspaceCleanupSchema(): void {
    this.db.exec(
      [
        "CREATE TABLE IF NOT EXISTS work_workspace_cleanup_requests (",
        " workspace_id TEXT PRIMARY KEY REFERENCES work_workspaces(workspace_id) ON DELETE CASCADE,",
        " workspace_key TEXT NOT NULL,",
        " owner_worker_id TEXT NOT NULL,",
        " status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),",
        " lease_until INTEGER,",
        " fencing INTEGER NOT NULL DEFAULT 0,",
        " error_code TEXT,",
        " created_at INTEGER NOT NULL,",
        " updated_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_workspace_cleanup_claim ON work_workspace_cleanup_requests(owner_worker_id,status,lease_until);",
      ].join("\n"),
    );
  }

  private ensureDefaultWorkflow(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO work_workflows(workflow_id,version,definition_json,created_at) VALUES(?,?,?,?)",
    );
    const now = Date.now();
    insert.run(DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_VERSION, JSON.stringify(DEFAULT_WORKFLOW), now);
    for (const [workflowId, version, definition] of PLATFORM_PRESET_WORKFLOWS) {
      insert.run(workflowId, version, JSON.stringify(this.normalizeWorkflowDefinition(definition)), now);
    }
  }
  private normalizeWorkflowDefinition(value: unknown): WorkflowDefinition {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_WORKFLOW");
    const definition = structuredClone(value) as WorkflowDefinition;
    if (
      !definition.validation ||
      !Array.isArray(definition.validation.requiredEvidence) ||
      definition.validation.requiredEvidence.some(
        (type) => typeof type !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(type),
      )
    ) {
      throw new Error("INVALID_WORKFLOW");
    }
    definition.validation.required = normalizeVerificationPolicy(
      (definition.validation as { required?: unknown }).required,
    );

    const rawChange = (definition as { change?: unknown }).change;
    if (rawChange !== undefined) {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) throw new Error("INVALID_WORKFLOW");
      const mode = (rawChange as { mode?: unknown }).mode;
      const delivery = (rawChange as { delivery?: unknown }).delivery;
      if (mode !== "readonly" && mode !== "code_change" && mode !== "conditional_code_change")
        throw new Error("INVALID_WORKFLOW");
      if (delivery !== undefined && delivery !== "merge_request") throw new Error("INVALID_WORKFLOW");
      if (mode === "readonly" && delivery !== undefined) throw new Error("INVALID_WORKFLOW");
      definition.change = { mode, ...(delivery ? { delivery } : {}) };
    }

    const rawSelection = (definition as { selection?: unknown }).selection;
    if (rawSelection !== undefined) {
      if (!rawSelection || typeof rawSelection !== "object" || Array.isArray(rawSelection)) {
        throw new Error("INVALID_WORKFLOW");
      }
      const summary = (rawSelection as { summary?: unknown }).summary;
      const useWhen = (rawSelection as { useWhen?: unknown }).useWhen;
      const notWhen = (rawSelection as { notWhen?: unknown }).notWhen;
      const normalizeSelectionList = (value: unknown): string[] => {
        if (!Array.isArray(value) || value.length > 20) throw new Error("INVALID_WORKFLOW");
        return value.map((item) => {
          if (typeof item !== "string") throw new Error("INVALID_WORKFLOW");
          const normalized = item.trim();
          if (!normalized || normalized.length > 500) throw new Error("INVALID_WORKFLOW");
          return normalized;
        });
      };
      if (typeof summary !== "string") throw new Error("INVALID_WORKFLOW");
      const normalizedSummary = summary.trim();
      if (!normalizedSummary || normalizedSummary.length > 500) throw new Error("INVALID_WORKFLOW");
      definition.selection = {
        summary: normalizedSummary,
        useWhen: normalizeSelectionList(useWhen),
        notWhen: normalizeSelectionList(notWhen),
      };
    }

    if (definition.validation.required.some((step) => step.evidenceType === "integration_test")) {
      definition.validation.requiredEvidence = [
        ...new Set([...definition.validation.requiredEvidence, "integration_test"]),
      ];
    }

    const source = (definition as { source?: unknown }).source;
    if (source !== undefined) {
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("INVALID_WORKFLOW");
      const terminal = (source as { terminal?: unknown }).terminal;
      if (
        !terminal ||
        typeof terminal !== "object" ||
        Array.isArray(terminal) ||
        (terminal as { active?: unknown }).active !== "cancel" ||
        (terminal as { waitingReview?: unknown }).waitingReview !== "retain_review"
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
      definition.source = { terminal: { active: "cancel", waitingReview: "retain_review" } };
    }

    const rawPlanning = (definition as { planning?: unknown }).planning;
    if (rawPlanning !== undefined) {
      if (!rawPlanning || typeof rawPlanning !== "object" || Array.isArray(rawPlanning)) {
        throw new Error("INVALID_WORKFLOW");
      }
      const maxReplans = (rawPlanning as { maxReplans?: unknown }).maxReplans;
      const replanPolicy = (rawPlanning as { replanPolicy?: unknown }).replanPolicy;
      const allowed = new Set([
        "always_after_agent_turn",
        "on_new_information",
        "on_failure",
        "on_review_rework",
        "on_blocker_resolution",
        "on_user_update",
        "manual",
      ]);
      if (
        !Number.isSafeInteger(maxReplans) ||
        Number(maxReplans) < 1 ||
        Number(maxReplans) > 100 ||
        !Array.isArray(replanPolicy) ||
        replanPolicy.length > 20 ||
        replanPolicy.some((item) => typeof item !== "string" || !allowed.has(item))
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
      definition.planning = {
        maxReplans: Number(maxReplans),
        replanPolicy: [...new Set(replanPolicy)] as NonNullable<WorkflowDefinition["planning"]>["replanPolicy"],
      };
    }

    const graphMode = (definition as { graph?: { mode?: unknown } }).graph?.mode;
    if (graphMode !== "single-node" && graphMode !== "dynamic-dag") throw new Error("INVALID_WORKFLOW");
    definition.graph = { mode: graphMode };

    const rawReview = (definition as { review?: unknown }).review;
    if (!rawReview || typeof rawReview !== "object" || Array.isArray(rawReview)) throw new Error("INVALID_WORKFLOW");
    const legacyHumanReview = (rawReview as { humanReview?: unknown }).humanReview;
    const reviewRequired =
      typeof (rawReview as { required?: unknown }).required === "boolean"
        ? (rawReview as { required: boolean }).required
        : typeof legacyHumanReview === "boolean"
          ? legacyHumanReview
          : true;
    const reviewerExpertId =
      typeof (rawReview as { reviewerExpertId?: unknown }).reviewerExpertId === "string"
        ? (rawReview as { reviewerExpertId: string }).reviewerExpertId.trim()
        : "";
    if (reviewerExpertId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(reviewerExpertId)) {
      throw new Error("INVALID_WORKFLOW");
    }
    definition.review = { required: reviewRequired, ...(reviewerExpertId ? { reviewerExpertId } : {}) };
    if (reviewerExpertId && !reviewRequired) throw new Error("INVALID_WORKFLOW");
    if (!reviewRequired && definition.completion?.require?.includes("review_accepted")) {
      throw new Error("INVALID_WORKFLOW");
    }

    const publication = (definition as { publication?: unknown }).publication;
    if (publication !== undefined) {
      if (
        !publication ||
        typeof publication !== "object" ||
        Array.isArray(publication) ||
        typeof (publication as { required?: unknown }).required !== "boolean" ||
        (publication as { mode?: unknown }).mode !== "work_branch" ||
        ((publication as { approvalRequired?: unknown }).approvalRequired !== undefined &&
          typeof (publication as { approvalRequired?: unknown }).approvalRequired !== "boolean")
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
      definition.publication = {
        required: (publication as { required: boolean }).required,
        mode: "work_branch",
        approvalRequired: (publication as { approvalRequired?: boolean }).approvalRequired ?? true,
      };
    }

    const requiredRuntimeProfile = definition.execution?.requiredRuntimeProfile;
    if (requiredRuntimeProfile !== undefined) {
      let runtimePolicy;
      try {
        runtimePolicy = resolveRuntimeProfilePolicy(requiredRuntimeProfile);
      } catch {
        throw new Error("INVALID_WORKFLOW");
      }
      if (
        ((definition.change?.mode === "code_change" || definition.change?.mode === "conditional_code_change") &&
          runtimePolicy.workspaceAccess !== "read-write") ||
        (definition.change?.mode === "readonly" && runtimePolicy.workspaceAccess !== "read-only")
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
    }
    if (definition.change?.mode === "code_change" || definition.change?.mode === "conditional_code_change") {
      for (const evidenceType of ["build", "unit_test"]) {
        if (!definition.validation.requiredEvidence.includes(evidenceType)) throw new Error("INVALID_WORKFLOW");
      }
      if (!definition.review.required || !definition.completion.require.includes("review_accepted")) {
        throw new Error("INVALID_WORKFLOW");
      }
      const conditional = definition.change.mode === "conditional_code_change";

      const mergeRequestDelivery = definition.change.delivery === "merge_request";
      if (!conditional && !mergeRequestDelivery) throw new Error("INVALID_WORKFLOW");
      if (mergeRequestDelivery) {
        if (!definition.publication?.required || definition.publication.mode !== "work_branch") {
          throw new Error("INVALID_WORKFLOW");
        }
        if (!definition.completion.require.includes("publication_succeeded")) throw new Error("INVALID_WORKFLOW");
        if (!definition.completion.require.includes("change_request_created")) throw new Error("INVALID_WORKFLOW");
      } else if (
        definition.publication?.required ||
        definition.completion.require.includes("publication_succeeded") ||
        definition.completion.require.includes("change_request_created")
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
    }
    const requireApproval = definition.completion?.require?.includes("required_approvals_approved") ?? false;
    const rawApprovals = (definition.completion as { requiredApprovals?: unknown } | undefined)?.requiredApprovals;
    if (rawApprovals !== undefined && !Array.isArray(rawApprovals)) throw new Error("INVALID_WORKFLOW");
    const requiredApprovals = Array.isArray(rawApprovals) ? rawApprovals : [];
    if (
      requiredApprovals.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          !(
            ((item as { scope?: unknown }).scope === "work_completion" &&
              (item as { subjectType?: unknown }).subjectType === "workspace_revision") ||
            ((item as { scope?: unknown }).scope === "publish_work_branch" &&
              (item as { subjectType?: unknown }).subjectType === "publication_artifact")
          ),
      )
    ) {
      throw new Error("INVALID_WORKFLOW");
    }
    if (requireApproval && requiredApprovals.length === 0) throw new Error("INVALID_WORKFLOW");
    if (!requireApproval && requiredApprovals.length > 0) throw new Error("INVALID_WORKFLOW");

    const requirePublication = definition.completion?.require?.includes("publication_succeeded") ?? false;
    if (requirePublication !== (definition.publication?.required === true)) throw new Error("INVALID_WORKFLOW");
    if (definition.publication?.required && definition.publication.approvalRequired !== false) {
      if (!requireApproval) throw new Error("INVALID_WORKFLOW");
      if (
        !requiredApprovals.some(
          (item) => item.scope === "publish_work_branch" && item.subjectType === "publication_artifact",
        )
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
    }
    if (
      definition.publication?.approvalRequired === false &&
      requiredApprovals.some(
        (item) => item.scope === "publish_work_branch" && item.subjectType === "publication_artifact",
      )
    ) {
      throw new Error("INVALID_WORKFLOW");
    }

    if (requiredApprovals.length > 0) {
      definition.completion.requiredApprovals = requiredApprovals as NonNullable<
        WorkflowDefinition["completion"]["requiredApprovals"]
      >;
    } else {
      delete definition.completion.requiredApprovals;
    }
    return definition;
  }
  putWorkflow(
    workflowId: string,
    version: number,
    definition: WorkflowDefinition,
    now = Date.now(),
  ): WorkflowDefinitionRecord {
    const id = requiredText(workflowId, 200);
    if (!id || !Number.isSafeInteger(version) || version < 1 || !Number.isFinite(now))
      throw new Error("INVALID_WORKFLOW");
    const normalized = this.normalizeWorkflowDefinition(definition);
    const encoded = JSON.stringify(normalized);
    const existing = this.db
      .prepare("SELECT * FROM work_workflows WHERE workflow_id=? AND version=?")
      .get(id, version) as Row | undefined;
    if (existing) {
      if (String(existing.definition_json) !== encoded) throw new Error("WORKFLOW_VERSION_CONFLICT");
      return {
        workflowId: id,
        version,
        definition: normalized,
        createdAt: Number(existing.created_at),
      };
    }
    this.db
      .prepare("INSERT INTO work_workflows(workflow_id,version,definition_json,created_at) VALUES(?,?,?,?)")
      .run(id, version, encoded, now);
    return { workflowId: id, version, definition: normalized, createdAt: now };
  }

  getWorkflow(workflowId: string, version?: number): WorkflowDefinitionRecord {
    const id = requiredText(workflowId, 200);
    if (!id) throw new Error("INVALID_WORKFLOW");
    const row =
      version === undefined
        ? (this.db.prepare("SELECT * FROM work_workflows WHERE workflow_id=? ORDER BY version DESC LIMIT 1").get(id) as
            Row | undefined)
        : (this.db.prepare("SELECT * FROM work_workflows WHERE workflow_id=? AND version=?").get(id, version) as
            Row | undefined);
    if (!row) throw new Error("WORKFLOW_NOT_FOUND");
    return {
      workflowId: String(row.workflow_id),
      version: Number(row.version),
      definition: this.normalizeWorkflowDefinition(JSON.parse(String(row.definition_json))),
      createdAt: Number(row.created_at),
    };
  }

  listWorkflows(): WorkflowDefinitionRecord[] {
    return (this.db.prepare("SELECT * FROM work_workflows ORDER BY workflow_id,version DESC").all() as Row[]).map(
      (row) => ({
        workflowId: String(row.workflow_id),
        version: Number(row.version),
        definition: this.normalizeWorkflowDefinition(JSON.parse(String(row.definition_json))),
        createdAt: Number(row.created_at),
      }),
    );
  }

  listSelectableWorkflows(): SelectableWorkflowRecord[] {
    const rows = this.db
      .prepare(
        [
          "SELECT w.* FROM work_workflows w",
          "JOIN (SELECT workflow_id, MAX(version) AS version FROM work_workflows WHERE workflow_id<>? GROUP BY workflow_id) latest",
          "ON latest.workflow_id=w.workflow_id AND latest.version=w.version",
          "ORDER BY w.workflow_id",
        ].join(" "),
      )
      .all(DEFAULT_WORKFLOW_ID) as Row[];
    return rows.map((row) => {
      const workflowId = String(row.workflow_id);
      const definition = this.normalizeWorkflowDefinition(JSON.parse(String(row.definition_json)));
      const selection = definition.selection;
      return {
        workflowId,
        version: Number(row.version),
        changeMode: definition.change?.mode ?? null,
        delivery: definition.change?.delivery ?? null,
        summary: selection?.summary ?? `Workflow ${workflowId} has no selection metadata configured.`,
        useWhen: selection ? [...selection.useWhen] : [],
        notWhen: selection ? [...selection.notWhen] : [],
        selectionConfigured: Boolean(selection),
      };
    });
  }

  putRepositoryWorkflowDefault(repositoryId: string, workflowId: string, now = Date.now()): void {
    const repository = requiredText(repositoryId, 200);
    const workflow = requiredText(workflowId, 200);
    if (!repository || !workflow || !Number.isFinite(now)) throw new Error("INVALID_REPOSITORY_WORKFLOW_DEFAULT");
    this.getWorkflow(workflow);
    this.db
      .prepare(
        "INSERT INTO work_repository_workflow_defaults(repository_id,workflow_id,updated_at) VALUES(?,?,?) ON CONFLICT(repository_id) DO UPDATE SET workflow_id=excluded.workflow_id,updated_at=excluded.updated_at",
      )
      .run(repository, workflow, now);
  }

  deleteRepositoryWorkflowDefault(repositoryId: string): void {
    const repository = requiredText(repositoryId, 200);
    if (!repository) throw new Error("INVALID_REPOSITORY_WORKFLOW_DEFAULT");
    this.db.prepare("DELETE FROM work_repository_workflow_defaults WHERE repository_id=?").run(repository);
  }

  getRepositoryWorkflowDefault(repositoryId: string): string | null {
    const repository = requiredText(repositoryId, 200);
    if (!repository) throw new Error("INVALID_REPOSITORY_WORKFLOW_DEFAULT");
    const row = this.db
      .prepare("SELECT workflow_id FROM work_repository_workflow_defaults WHERE repository_id=?")
      .get(repository) as { workflow_id?: string } | undefined;
    return row?.workflow_id ? String(row.workflow_id) : null;
  }

  listRepositoryWorkflowDefaults(): Array<{ repositoryId: string; workflowId: string; updatedAt: number }> {
    return (
      this.db
        .prepare(
          "SELECT repository_id,workflow_id,updated_at FROM work_repository_workflow_defaults ORDER BY repository_id",
        )
        .all() as Array<{
        repository_id: string;
        workflow_id: string;
        updated_at: number;
      }>
    ).map((row) => ({ repositoryId: row.repository_id, workflowId: row.workflow_id, updatedAt: row.updated_at }));
  }

  issueSourceControlTokenHash(
    workItemId: string,
    tokenHash: string,
    now = Date.now(),
    ttlMs = 30 * 24 * 60 * 60 * 1000,
    maxActive = 4,
  ): void {
    const id = requiredText(workItemId, 100);
    const hash = requiredText(tokenHash, 64);
    if (
      !id ||
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !Number.isFinite(now) ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isSafeInteger(maxActive) ||
      maxActive < 1
    )
      throw new Error("INVALID_SOURCE_CONTROL_TOKEN");
    const work = this.getWorkInternal(id);
    const expiresAt = now + ttlMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM work_source_control_tokens WHERE work_item_id=? AND expires_at<=?").run(id, now);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO work_source_control_tokens(token_hash,work_item_id,created_at,expires_at) VALUES(?,?,?,?)",
        )
        .run(hash, id, now, expiresAt);
      const stale = this.db
        .prepare(
          "SELECT token_hash FROM work_source_control_tokens WHERE work_item_id=? ORDER BY created_at DESC, token_hash DESC LIMIT -1 OFFSET ?",
        )
        .all(id, maxActive) as Array<{ token_hash: string }>;
      const remove = this.db.prepare("DELETE FROM work_source_control_tokens WHERE token_hash=?");
      for (const row of stale) remove.run(row.token_hash);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    this.event(
      id,
      work.activeWorkAttemptId,
      "source.control_issued",
      JSON.stringify({ workItemId: id, expiresAt }),
      now,
    );
  }

  hasSourceControlTokenHash(workItemId: string, tokenHash: string, now = Date.now()): boolean {
    const id = requiredText(workItemId, 100);
    const hash = requiredText(tokenHash, 64);
    if (!id || !hash || !/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(now)) return false;
    this.db.prepare("DELETE FROM work_source_control_tokens WHERE work_item_id=? AND expires_at<=?").run(id, now);
    const row = this.db
      .prepare("SELECT 1 AS ok FROM work_source_control_tokens WHERE work_item_id=? AND token_hash=? AND expires_at>?")
      .get(id, hash, now) as Row | undefined;
    return row !== undefined;
  }

  recordSourceObservation(input: WorkSourceObservationInput, now = Date.now()): WorkSourceObservationRecord {
    const workItemId = requiredText(input.workItemId, 100);
    const sourceType = requiredText(input.sourceType, 100);
    const sourceScope = requiredText(input.sourceScope, 500);
    const sourceRef = requiredText(input.sourceRef, 500);
    const fingerprint = requiredText(input.fingerprint, 128);
    const detail = optionalText(input.detail, 4000);
    if (
      !workItemId ||
      !sourceType ||
      !sourceScope ||
      !sourceRef ||
      !fingerprint ||
      !["active", "terminal"].includes(input.state) ||
      !Number.isFinite(input.observedAt)
    )
      throw new Error("INVALID_SOURCE_OBSERVATION");
    const work = this.getWorkInternal(workItemId);
    if (work.sourceType !== sourceType || work.sourceScope !== sourceScope || work.sourceRef !== sourceRef)
      throw new Error("SOURCE_OBSERVATION_WORK_MISMATCH");
    const existing = this.db
      .prepare("SELECT * FROM work_source_observations WHERE work_item_id=? AND fingerprint=?")
      .get(workItemId, fingerprint) as Row | undefined;
    if (existing) return this.fromSourceObservationRow(existing);
    const observationId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO work_source_observations(observation_id,work_item_id,source_type,source_scope,source_ref,state,detail,fingerprint,reconciliation_action,reconciled_at,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,?)",
      )
      .run(
        observationId,
        workItemId,
        sourceType,
        sourceScope,
        sourceRef,
        input.state,
        detail,
        fingerprint,
        input.observedAt,
        now,
      );
    this.event(
      workItemId,
      work.activeWorkAttemptId,
      "source.observed",
      JSON.stringify({ observationId, sourceType, sourceScope, sourceRef, state: input.state }),
      now,
    );
    return this.getSourceObservation(observationId);
  }

  getSourceObservation(observationId: string): WorkSourceObservationRecord {
    const id = requiredText(observationId, 100);
    if (!id) throw new Error("INVALID_SOURCE_OBSERVATION");
    const row = this.db.prepare("SELECT * FROM work_source_observations WHERE observation_id=?").get(id) as
      Row | undefined;
    if (!row) throw new Error("SOURCE_OBSERVATION_NOT_FOUND");
    return this.fromSourceObservationRow(row);
  }

  listSourceObservations(workItemId: string): WorkSourceObservationRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_source_observations WHERE work_item_id=? ORDER BY observed_at,created_at")
        .all(workItemId) as Row[]
    ).map((row) => this.fromSourceObservationRow(row));
  }

  markSourceObservationReconciled(
    observationId: string,
    action: "cancel" | "retain_review" | "noop",
    now = Date.now(),
  ): WorkSourceObservationRecord {
    const current = this.getSourceObservation(observationId);
    if (current.reconciledAt !== null) return current;
    this.db
      .prepare(
        "UPDATE work_source_observations SET reconciliation_action=?,reconciled_at=? WHERE observation_id=? AND reconciled_at IS NULL",
      )
      .run(action, now, observationId);
    const updated = this.getSourceObservation(observationId);
    this.event(
      updated.workItemId,
      null,
      "source.reconciled",
      JSON.stringify({ observationId, state: updated.state, action }),
      now,
    );
    return updated;
  }

  createOrReuseWork(input: WorkSubmission, now = Date.now()): WorkItemRecord {
    const principalId = requiredText(input.principalId, 200);
    const scope = requiredText(input.scope, 200);
    const idempotencyKey = requiredText(input.idempotencyKey, 300);
    const sourceType = requiredText(input.sourceType, 100);
    const title = requiredText(input.title, 500);
    const description = requiredText(input.description, 20_000);
    const sourceScope = optionalText(input.sourceScope, 500);
    const sourceRef = optionalText(input.sourceRef, 500);
    const sourceUrl = optionalText(input.sourceUrl, 2_000);
    const sourceRequestId = optionalText(input.sourceRequestId, 100);
    const sourceRequestSlot = optionalText(input.sourceRequestSlot, 1_000);
    if (!principalId || !scope || !idempotencyKey || !sourceType || !title || !description || !Number.isFinite(now)) {
      throw new Error("INVALID_WORK_REQUEST");
    }
    if ((sourceScope === null) !== (sourceRef === null)) throw new Error("INVALID_WORK_SOURCE_IDENTITY");
    if ((sourceRequestId === null) !== (sourceRequestSlot === null)) throw new Error("INVALID_WORK_SOURCE_REQUEST");
    if (sourceRequestId !== null && !/^srq_[a-f0-9]{64}$/.test(sourceRequestId))
      throw new Error("INVALID_WORK_SOURCE_REQUEST");
    if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) throw new Error("INVALID_WORK_REQUEST");
    const repositoryDefault = input.repositoryId?.trim()
      ? this.getRepositoryWorkflowDefault(input.repositoryId.trim())
      : null;
    const workflow = this.getWorkflow(input.workflowId?.trim() || repositoryDefault || DEFAULT_WORKFLOW_ID);
    const digest = requestDigest(input, workflow.workflowId);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM work_items WHERE principal_id=? AND scope=? AND idempotency_key=?")
        .get(principalId, scope, idempotencyKey) as Row | undefined;
      if (existing) {
        if (String(existing.request_digest) !== digest) throw new Error("WORK_IDEMPOTENCY_CONFLICT");
        this.db.exec("COMMIT");
        return {
          ...this.fromWorkRow(existing),
          reusedExistingWork: true,
          deduplicationReason: "idempotency_key",
        };
      }

      if (sourceScope && sourceRequestId && sourceRequestSlot) {
        const requestExisting = this.db
          .prepare(
            `SELECT * FROM work_items
             WHERE principal_id=? AND scope=? AND source_type=? AND source_scope=?
               AND source_request_id=? AND source_request_slot=?
               AND status NOT IN ('completed','failed','cancelled')
             ORDER BY created_at ASC, rowid ASC LIMIT 1`,
          )
          .get(principalId, scope, sourceType, sourceScope, sourceRequestId, sourceRequestSlot) as Row | undefined;
        if (requestExisting) {
          this.db.exec("COMMIT");
          return {
            ...this.fromWorkRow(requestExisting),
            reusedExistingWork: true,
            deduplicationReason: "same_source_request",
          };
        }
      }

      if (sourceScope && sourceRef) {
        const sourceExisting = this.db
          .prepare(
            "SELECT * FROM work_items WHERE principal_id=? AND scope=? AND source_type=? AND source_scope=? AND source_ref=?",
          )
          .get(principalId, scope, sourceType, sourceScope, sourceRef) as Row | undefined;
        if (sourceExisting) {
          this.db.exec("COMMIT");
          return {
            ...this.fromWorkRow(sourceExisting),
            reusedExistingWork: true,
            deduplicationReason: "source_identity",
          };
        }
      }

      const workItemId = randomUUID();
      this.db
        .prepare(
          [
            "INSERT INTO work_items(",
            "work_item_id,principal_id,scope,idempotency_key,request_digest,source_type,source_scope,source_ref,source_url,source_request_id,source_request_slot," +
              "title,description,status,state_revision,workflow_id,workflow_version,orchestration_engine,orchestration_epoch,priority,requested_expert_id,requested_deployment_id,repository_id,created_at,updated_at",
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',1,?,?,'dynamic-dag',1,?,?,?,?,?,?)",
          ].join(" "),
        )
        .run(
          workItemId,
          principalId,
          scope,
          idempotencyKey,
          digest,
          sourceType,
          sourceScope,
          sourceRef,
          sourceUrl,
          sourceRequestId,
          sourceRequestSlot,
          title,
          description,
          workflow.workflowId,
          workflow.version,
          input.priority ?? null,
          input.expertId?.trim() || null,
          input.deploymentId?.trim() || null,
          input.repositoryId?.trim() || null,
          now,
          now,
        );
      this.event(workItemId, null, "work.created", JSON.stringify({ sourceType }), now);
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return { ...this.fromWorkRow(row), reusedExistingWork: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWork(workItemId: string, principalId: string, scope: string): WorkItemRecord {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE work_item_id=? AND principal_id=? AND scope=?")
      .get(workItemId, principalId, scope) as Row | undefined;
    if (!row) throw new Error("WORK_NOT_FOUND_OR_FORBIDDEN");
    return this.fromWorkRow(row);
  }

  getWorkInternal(workItemId: string): WorkItemRecord {
    const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row | undefined;
    if (!row) throw new Error("WORK_NOT_FOUND");
    return this.fromWorkRow(row);
  }

  claimWorkForOrchestration(
    workItemId: string,
    ownerId: string,
    now = Date.now(),
    leaseMs = 30_000,
  ): WorkOrchestrationClaim {
    const owner = requiredText(ownerId, 200);
    if (!owner || !Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("INVALID_ORCHESTRATION_CLAIM");
    }
    const leaseUntil = now + leaseMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row | undefined;
      if (!row) throw new Error("WORK_NOT_FOUND");
      const work = this.fromWorkRow(row);
      if (TERMINAL_WORK_STATUSES.has(work.status)) throw new Error("WORK_ALREADY_TERMINAL");
      if (
        work.orchestrationOwnerId &&
        work.orchestrationOwnerId !== owner &&
        work.orchestrationLeaseUntil !== null &&
        work.orchestrationLeaseUntil > now
      ) {
        throw new Error("WORK_ORCHESTRATION_CLAIMED");
      }
      if (
        work.orchestrationOwnerId === owner &&
        work.orchestrationLeaseUntil !== null &&
        work.orchestrationLeaseUntil > now
      ) {
        this.db
          .prepare(
            "UPDATE work_items SET orchestration_lease_until=?,orchestration_claimed_at=? WHERE work_item_id=? AND orchestration_owner_id=? AND orchestration_epoch=?",
          )
          .run(leaseUntil, now, workItemId, owner, work.orchestrationEpoch);
        this.db.exec("COMMIT");
        return {
          workItemId,
          ownerId: owner,
          epoch: work.orchestrationEpoch,
          leaseUntil,
          claimedAt: now,
        };
      }
      const nextEpoch = work.orchestrationEpoch + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_items SET orchestration_owner_id=?,orchestration_lease_until=?,orchestration_claimed_at=?,orchestration_epoch=?,state_revision=state_revision+CASE WHEN orchestration_owner_id IS NULL THEN 0 ELSE 1 END WHERE work_item_id=? AND orchestration_epoch=? AND (orchestration_owner_id IS NULL OR orchestration_lease_until IS NULL OR orchestration_lease_until<=? OR orchestration_owner_id=?)",
        )
        .run(owner, leaseUntil, now, nextEpoch, workItemId, work.orchestrationEpoch, now, owner);
      if (changed.changes !== 1) throw new Error("WORK_ORCHESTRATION_CLAIMED");
      this.db.exec("COMMIT");
      return { workItemId, ownerId: owner, epoch: nextEpoch, leaseUntil, claimedAt: now };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertWorkOrchestrationClaim(workItemId: string, ownerId: string, epoch: number, now = Date.now()): void {
    const owner = requiredText(ownerId, 200);
    if (!owner || !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isFinite(now)) {
      throw new Error("INVALID_ORCHESTRATION_CLAIM");
    }
    const row = this.db
      .prepare(
        "SELECT orchestration_owner_id,orchestration_epoch,orchestration_lease_until FROM work_items WHERE work_item_id=?",
      )
      .get(workItemId) as Row | undefined;
    if (!row) throw new Error("WORK_NOT_FOUND");
    if (
      row.orchestration_owner_id !== owner ||
      Number(row.orchestration_epoch) !== epoch ||
      row.orchestration_lease_until == null ||
      Number(row.orchestration_lease_until) <= now
    ) {
      throw new Error("STALE_ORCHESTRATION_CLAIM");
    }
  }

  releaseWorkOrchestrationClaim(workItemId: string, ownerId: string, epoch: number, now = Date.now()): void {
    this.assertWorkOrchestrationClaim(workItemId, ownerId, epoch, now);
    const changed = this.db
      .prepare(
        "UPDATE work_items SET orchestration_owner_id=NULL,orchestration_lease_until=NULL,orchestration_claimed_at=NULL WHERE work_item_id=? AND orchestration_owner_id=? AND orchestration_epoch=?",
      )
      .run(workItemId, ownerId, epoch);
    if (changed.changes !== 1) throw new Error("STALE_ORCHESTRATION_CLAIM");
  }

  transitionWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    status: WorkStatus,
    now = Date.now(),
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
    if (!WORK_STATUSES.has(status) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("INVALID_WORK_TRANSITION");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(workItemId, principalId, scope);
      if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      this.assertWorkOrchestrationFence(current, fence);
      if (TERMINAL_WORK_STATUSES.has(current.status) && current.status !== status) {
        throw new Error("WORK_ALREADY_TERMINAL");
      }
      const changed = this.db
        .prepare(
          "UPDATE work_items SET status=?,state_revision=state_revision+1,updated_at=?,completed_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(status, now, TERMINAL_WORK_STATUSES.has(status) ? now : null, workItemId, expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(workItemId, current.activeWorkAttemptId, "work." + status, null, now);
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requestRework(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    input: WorkReworkRequest,
    now = Date.now(),
  ): WorkItemRecord {
    const originWorkAttemptId = requiredText(input.originWorkAttemptId, 200);
    const createdBy = requiredText(input.createdBy, 200);
    if (
      !originWorkAttemptId ||
      !createdBy ||
      !["human_rework", "review_rework", "policy_replan"].includes(input.reason)
    ) {
      throw new Error("INVALID_REWORK_REQUEST");
    }
    const payload = JSON.stringify({
      reason: input.reason,
      originWorkAttemptId,
      reviewContext: optionalText(input.reviewContext, 4000),
      whatShouldChange: optionalText(input.whatShouldChange, 4000),
      createdBy,
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (work.status !== "waiting_review") throw new Error("WORK_REWORK_NOT_ALLOWED");
      const origin = this.getWorkAttempt(originWorkAttemptId);
      if (origin.workItemId !== workItemId) throw new Error("INVALID_REWORK_REQUEST");
      const changed = this.db
        .prepare(
          "UPDATE work_items SET status='rework',next_action_type='rework',next_action_at=?,next_action_context=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=? AND status='waiting_review'",
        )
        .run(now, payload, now, workItemId, principalId, scope, expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(
        workItemId,
        null,
        "work.rework",
        JSON.stringify({ reason: input.reason, originWorkAttemptId, createdBy }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createWorkAttempt(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    input: CreateWorkAttemptInput,
    now = Date.now(),
    fence?: WorkOrchestrationFence,
  ): WorkAttemptRecord {
    const expertId = requiredText(input.expertId, 200);
    const deploymentId = requiredText(input.deploymentId, 200);
    if (
      !expertId ||
      !deploymentId ||
      !Number.isSafeInteger(input.deploymentConfigVersion) ||
      input.deploymentConfigVersion < 1 ||
      !["initial", "human_rework", "review_rework", "policy_replan"].includes(input.reason)
    ) {
      throw new Error("INVALID_WORK_ATTEMPT");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      this.assertWorkOrchestrationFence(work, fence);
      if (TERMINAL_WORK_STATUSES.has(work.status)) throw new Error("WORK_ALREADY_TERMINAL");
      const active = this.db
        .prepare("SELECT work_attempt_id FROM work_attempts WHERE work_item_id=? AND status='active'")
        .get(workItemId) as Row | undefined;
      if (active) throw new Error("ACTIVE_WORK_ATTEMPT_EXISTS");
      const workflow = this.getWorkflow(work.workflowId, work.workflowVersion);
      const sequenceRow = this.db
        .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS n FROM work_attempts WHERE work_item_id=?")
        .get(workItemId) as { n: number };
      const sequence = Number(sequenceRow.n);
      if (sequence > workflow.definition.lifecycle.attempt.maxWorkAttempts) {
        throw new Error("WORK_ATTEMPT_LIMIT_REACHED");
      }
      if (input.reason === "human_rework" || input.reason === "review_rework") {
        const reworkRow = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM work_attempts WHERE work_item_id=? AND reason IN ('human_rework','review_rework')",
          )
          .get(workItemId) as { n: number };
        if (Number(reworkRow.n) >= workflow.definition.lifecycle.attempt.maxReworks) {
          throw new Error("WORK_REWORK_LIMIT_REACHED");
        }
      }

      const staleEvidence = this.db
        .prepare("UPDATE work_evidence SET stale=1 WHERE work_item_id=? AND stale=0")
        .run(workItemId);
      const staleApprovals = this.db
        .prepare(
          "UPDATE work_approvals SET stale=1 WHERE work_item_id=? AND approval_scope='work_completion' AND stale=0",
        )
        .run(workItemId);
      if (staleEvidence.changes > 0) {
        this.event(
          workItemId,
          null,
          "evidence.staled",
          JSON.stringify({ count: staleEvidence.changes, reason: "new_work_attempt" }),
          now,
        );
      }
      if (staleApprovals.changes > 0) {
        this.event(
          workItemId,
          null,
          "approval.invalidated",
          JSON.stringify({ count: staleApprovals.changes, reason: "new_work_attempt" }),
          now,
        );
      }

      const workAttemptId = randomUUID();
      this.db
        .prepare(
          [
            "INSERT INTO work_attempts(",
            "work_attempt_id,work_item_id,sequence,reason,status,expert_id,deployment_id,deployment_config_version,",
            "workflow_id,workflow_version,parent_work_attempt_id,review_context,what_should_change,created_by,started_at,dispatch_binding_json",
            ") VALUES(?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?)",
          ].join(" "),
        )
        .run(
          workAttemptId,
          workItemId,
          sequence,
          input.reason,
          expertId,
          deploymentId,
          input.deploymentConfigVersion,
          workflow.workflowId,
          workflow.version,
          input.parentWorkAttemptId?.trim() || null,
          optionalText(input.reviewContext, 4000),
          optionalText(input.whatShouldChange, 4000),
          optionalText(input.createdBy, 200),
          now,
          input.dispatchBinding ? JSON.stringify(input.dispatchBinding) : null,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET active_work_attempt_id=?,status='running',state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(workAttemptId, now, workItemId, expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(
        workItemId,
        workAttemptId,
        "work_attempt.created",
        JSON.stringify({
          sequence,
          reason: input.reason,
          originWorkAttemptId: input.parentWorkAttemptId?.trim() || null,
          createdBy: optionalText(input.createdBy, 200),
        }),
        now,
      );
      if (input.reason === "human_rework" || input.reason === "review_rework") {
        this.event(
          workItemId,
          workAttemptId,
          "rework.started",
          JSON.stringify({
            reason: input.reason,
            originWorkAttemptId: input.parentWorkAttemptId?.trim() || null,
            createdBy: optionalText(input.createdBy, 200),
          }),
          now,
        );
      }
      const row = this.db.prepare("SELECT * FROM work_attempts WHERE work_attempt_id=?").get(workAttemptId) as Row;
      this.db.exec("COMMIT");
      return this.fromAttemptRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkAttempt(workAttemptId: string): WorkAttemptRecord {
    const row = this.db.prepare("SELECT * FROM work_attempts WHERE work_attempt_id=?").get(workAttemptId) as
      Row | undefined;
    if (!row) throw new Error("WORK_ATTEMPT_NOT_FOUND");
    return this.fromAttemptRow(row);
  }

  bindAttemptDispatch(
    workAttemptId: string,
    binding: Record<string, unknown>,
    expectedConfigVersion: number,
  ): WorkAttemptRecord {
    const current = this.getWorkAttempt(workAttemptId);
    if (current.deploymentConfigVersion !== expectedConfigVersion) throw new Error("STALE_DEPLOYMENT_CONFIG");
    if (current.dispatchBinding) return current;
    this.db
      .prepare(
        "UPDATE work_attempts SET dispatch_binding_json=? WHERE work_attempt_id=? AND dispatch_binding_json IS NULL",
      )
      .run(JSON.stringify(binding), workAttemptId);
    return this.getWorkAttempt(workAttemptId);
  }

  getAttemptByTask(taskId: string): WorkAttemptRecord | null {
    const direct = this.db
      .prepare("SELECT * FROM work_attempts WHERE task_id=? OR review_task_id=?")
      .get(taskId, taskId) as Row | undefined;
    if (direct) return this.fromAttemptRow(direct);
    const hasExpertTasks = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='expert_tasks'")
      .get() as Row | undefined;
    if (!hasExpertTasks) return null;
    const linked = this.db
      .prepare(
        "SELECT a.* FROM work_attempts AS a JOIN expert_tasks AS t ON t.work_attempt_id=a.work_attempt_id WHERE t.task_id=? LIMIT 1",
      )
      .get(taskId) as Row | undefined;
    return linked ? this.fromAttemptRow(linked) : null;
  }
  getActiveAttempt(workItemId: string): WorkAttemptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM work_attempts WHERE work_item_id=? AND status='active'")
      .get(workItemId) as Row | undefined;
    return row ? this.fromAttemptRow(row) : null;
  }

  listAttempts(workItemId: string): WorkAttemptRecord[] {
    return (
      this.db.prepare("SELECT * FROM work_attempts WHERE work_item_id=? ORDER BY sequence").all(workItemId) as Row[]
    ).map((row) => this.fromAttemptRow(row));
  }

  linkAttemptTask(workAttemptId: string, taskId: string): WorkAttemptRecord {
    const normalizedTaskId = requiredText(taskId, 200);
    if (!normalizedTaskId) throw new Error("INVALID_TASK_LINK");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWorkAttempt(workAttemptId);
      if (current.taskId && current.taskId !== normalizedTaskId) throw new Error("WORK_ATTEMPT_TASK_CONFLICT");
      this.db
        .prepare("UPDATE work_attempts SET task_id=COALESCE(task_id,?) WHERE work_attempt_id=?")
        .run(normalizedTaskId, workAttemptId);
      const row = this.db.prepare("SELECT * FROM work_attempts WHERE work_attempt_id=?").get(workAttemptId) as Row;
      this.db.exec("COMMIT");
      return this.fromAttemptRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  linkAttemptReviewTask(workAttemptId: string, taskId: string): WorkAttemptRecord {
    const normalizedTaskId = requiredText(taskId, 200);
    if (!normalizedTaskId) throw new Error("INVALID_TASK_LINK");
    const current = this.getWorkAttempt(workAttemptId);
    if (current.reviewTaskId && current.reviewTaskId !== normalizedTaskId)
      throw new Error("WORK_ATTEMPT_REVIEW_TASK_CONFLICT");
    this.db
      .prepare("UPDATE work_attempts SET review_task_id=COALESCE(review_task_id,?) WHERE work_attempt_id=?")
      .run(normalizedTaskId, workAttemptId);
    return this.getWorkAttempt(workAttemptId);
  }

  ensureWorkspace(
    workItemId: string,
    workAttemptId: string,
    input: {
      resourceKey?: string;
      repositoryId?: string;
      repositoryUrl?: string;
      branch?: string;
      baseCommit?: string;
      cleanupPolicy?: "on_terminal" | "retain";
    },
    now = Date.now(),
  ): WorkspaceRecord {
    const attempt = this.getWorkAttempt(workAttemptId);
    const cleanupPolicy = input.cleanupPolicy ?? "on_terminal";
    const resourceKey = requiredText(input.resourceKey ?? "workspace", 200);
    if (!resourceKey) throw new Error("INVALID_WORKSPACE_RESOURCE");
    const work = this.getWorkInternal(workItemId);
    const repositoryId =
      optionalText(input.repositoryId, 200) ??
      (resourceKey.startsWith("repo:")
        ? requiredText(resourceKey.slice("repo:".length), 200)
        : resourceKey === "workspace"
          ? work.repositoryId
          : null);
    if (attempt.workItemId !== workItemId) throw new Error("WORKSPACE_ATTEMPT_MISMATCH");
    const existing = this.db
      .prepare("SELECT * FROM work_workspaces WHERE work_attempt_id=? AND resource_key=?")
      .get(workAttemptId, resourceKey) as Row | undefined;
    if (existing) {
      if (
        (existing.repository_id ?? null) !== repositoryId ||
        (existing.repository_url ?? null) !== (input.repositoryUrl?.trim() || null) ||
        (existing.branch ?? null) !== (input.branch?.trim() || null) ||
        (input.baseCommit !== undefined && (existing.base_commit ?? null) !== (input.baseCommit.trim() || null)) ||
        String(existing.cleanup_policy) !== cleanupPolicy
      ) {
        throw new Error("WORKSPACE_IDENTITY_CONFLICT");
      }
      return this.fromWorkspaceRow(existing);
    }

    const workspaceId = randomUUID();
    const workspaceKey =
      resourceKey === "workspace"
        ? "work-" + workItemId.toLowerCase() + "-a" + String(attempt.sequence)
        : "work-" +
          workItemId.toLowerCase() +
          "-a" +
          String(attempt.sequence) +
          "-r" +
          stableDigest(resourceKey).slice(0, 12);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO work_workspaces(workspace_id,workspace_key,work_item_id,work_attempt_id,resource_key,repository_id,repository_url,branch,base_commit,state,cleanup_policy,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?,'allocating',?,?,?)",
        )
        .run(
          workspaceId,
          workspaceKey,
          workItemId,
          workAttemptId,
          resourceKey,
          repositoryId,
          input.repositoryUrl?.trim() || null,
          input.branch?.trim() || null,
          input.baseCommit?.trim() || null,
          cleanupPolicy,
          now,
          now,
        );
      if (resourceKey === "workspace") {
        this.db
          .prepare(
            "UPDATE work_attempts SET workspace_id=COALESCE(workspace_id,?) WHERE work_attempt_id=? AND work_item_id=?",
          )
          .run(workspaceId, workAttemptId, workItemId);
      }
      const row = this.db.prepare("SELECT * FROM work_workspaces WHERE workspace_id=?").get(workspaceId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkspaceRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkspaceForResource(workAttemptId: string, resourceKey = "workspace"): WorkspaceRecord | null {
    const resource = requiredText(resourceKey, 200);
    if (!resource) throw new Error("INVALID_WORKSPACE_RESOURCE");
    const row = this.db
      .prepare("SELECT * FROM work_workspaces WHERE work_attempt_id=? AND resource_key=?")
      .get(workAttemptId, resource) as Row | undefined;
    return row ? this.fromWorkspaceRow(row) : null;
  }

  getWorkspaceByKey(workspaceKey: string): WorkspaceRecord {
    const key = requiredText(workspaceKey, 200);
    if (!key) throw new Error("INVALID_WORKSPACE_KEY");
    const row = this.db.prepare("SELECT * FROM work_workspaces WHERE workspace_key=?").get(key) as Row | undefined;
    if (!row) throw new Error("WORKSPACE_NOT_FOUND");
    return this.fromWorkspaceRow(row);
  }
  requestTerminalWorkspaceCleanup(workItemId: string, now = Date.now()): WorkspaceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM work_workspaces WHERE work_item_id=? ORDER BY created_at")
      .all(workItemId) as Row[];
    const result: WorkspaceRecord[] = [];
    for (const row of rows) {
      const workspace = this.fromWorkspaceRow(row);
      if (workspace.state === "removed") {
        result.push(workspace);
        continue;
      }
      if (workspace.cleanupPolicy === "retain") {
        this.db
          .prepare("UPDATE work_workspaces SET state='retained',last_used_at=? WHERE workspace_id=?")
          .run(now, workspace.workspaceId);
      } else if (workspace.ownerWorkerId && workspace.path) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db
            .prepare(
              "INSERT INTO work_workspace_cleanup_requests(workspace_id,workspace_key,owner_worker_id,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(workspace_id) DO UPDATE SET owner_worker_id=excluded.owner_worker_id,status=CASE WHEN work_workspace_cleanup_requests.status='succeeded' THEN 'succeeded' ELSE 'pending' END,lease_until=NULL,error_code=NULL,updated_at=excluded.updated_at",
            )
            .run(workspace.workspaceId, workspace.workspaceKey, workspace.ownerWorkerId, now, now);
          this.db
            .prepare(
              "UPDATE work_workspaces SET state=CASE WHEN state='removed' THEN 'removed' ELSE 'cleaning' END,last_used_at=? WHERE workspace_id=?",
            )
            .run(now, workspace.workspaceId);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } else {
        this.db
          .prepare("UPDATE work_workspaces SET state='failed',last_used_at=? WHERE workspace_id=?")
          .run(now, workspace.workspaceId);
      }
      result.push(this.getWorkspace(workspace.workspaceId));
    }
    return result;
  }

  claimWorkspaceCleanup(workerId: string, now = Date.now(), leaseMs = 30_000): WorkspaceCleanupClaim | null {
    const normalizedWorker = requiredText(workerId, 200);
    if (!normalizedWorker || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_WORKSPACE_CLEANUP");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM work_workspace_cleanup_requests WHERE owner_worker_id=? AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1",
        )
        .get(normalizedWorker, now) as Row | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const fencing = Number(row.fencing) + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_workspace_cleanup_requests SET status='running',lease_until=?,fencing=?,updated_at=? WHERE workspace_id=? AND owner_worker_id=? AND fencing=?",
        )
        .run(now + leaseMs, fencing, now, String(row.workspace_id), normalizedWorker, Number(row.fencing));
      if (changed.changes !== 1) throw new Error("STALE_WORKSPACE_CLEANUP");
      this.db.exec("COMMIT");
      return {
        workspaceId: String(row.workspace_id),
        workspaceKey: String(row.workspace_key),
        ownerWorkerId: normalizedWorker,
        fencing,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeWorkspaceCleanup(
    workspaceId: string,
    workerId: string,
    fencing: number,
    success: boolean,
    errorCode: string | null,
    now = Date.now(),
  ): WorkspaceRecord {
    const normalizedWorker = requiredText(workerId, 200);
    const normalizedError = errorCode?.trim() || null;
    if (!normalizedWorker || !Number.isSafeInteger(fencing) || fencing < 1)
      throw new Error("INVALID_WORKSPACE_CLEANUP");
    if (normalizedError && !/^[A-Z][A-Z0-9_]{0,79}$/.test(normalizedError))
      throw new Error("INVALID_WORKSPACE_CLEANUP");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE work_workspace_cleanup_requests SET status=?,lease_until=NULL,error_code=?,updated_at=? WHERE workspace_id=? AND owner_worker_id=? AND fencing=? AND status='running'",
        )
        .run(
          success ? "succeeded" : "failed",
          success ? null : (normalizedError ?? "WORKSPACE_CLEANUP_FAILED"),
          now,
          workspaceId,
          normalizedWorker,
          fencing,
        );
      if (changed.changes !== 1) throw new Error("STALE_WORKSPACE_CLEANUP");
      this.db
        .prepare("UPDATE work_workspaces SET state=?,last_used_at=? WHERE workspace_id=?")
        .run(success ? "removed" : "failed", now, workspaceId);
      const row = this.db.prepare("SELECT * FROM work_workspaces WHERE workspace_id=?").get(workspaceId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkspaceRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assignWorkspaceOwner(
    workspaceId: string,
    workerId: string,
    workspacePath: string,
    now = Date.now(),
    baseCommit?: string,
  ): WorkspaceRecord {
    const normalizedWorker = requiredText(workerId, 200);
    if (!normalizedWorker || !path.isAbsolute(workspacePath) || workspacePath === path.parse(workspacePath).root) {
      throw new Error("INVALID_WORKSPACE_OWNER");
    }
    const normalizedCommit = baseCommit?.trim() || null;
    if (normalizedCommit && !/^[a-f0-9]{40,64}$/i.test(normalizedCommit)) throw new Error("INVALID_WORKSPACE_COMMIT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM work_workspaces WHERE workspace_id=?").get(workspaceId) as
        Row | undefined;
      if (!current) throw new Error("WORKSPACE_NOT_FOUND");
      if (current.owner_worker_id && String(current.owner_worker_id) !== normalizedWorker) {
        throw new Error("WORKSPACE_OWNER_CONFLICT");
      }
      this.db
        .prepare(
          "UPDATE work_workspaces SET owner_worker_id=?,path=?,base_commit=COALESCE(?,base_commit),state='ready',last_used_at=? WHERE workspace_id=?",
        )
        .run(normalizedWorker, workspacePath, normalizedCommit, now, workspaceId);
      const row = this.db.prepare("SELECT * FROM work_workspaces WHERE workspace_id=?").get(workspaceId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkspaceRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getWorkspace(workspaceId: string): WorkspaceRecord {
    const row = this.db.prepare("SELECT * FROM work_workspaces WHERE workspace_id=?").get(workspaceId) as
      Row | undefined;
    if (!row) throw new Error("WORKSPACE_NOT_FOUND");
    return this.fromWorkspaceRow(row);
  }

  listDagResourceSubjects(workItemId: string): Record<string, string> {
    const rows = this.db
      .prepare(
        "SELECT resource_identity,subject_revision FROM work_dag_resource_subjects WHERE work_item_id=? ORDER BY resource_identity",
      )
      .all(workItemId) as Array<{ resource_identity: string; subject_revision: string }>;
    return Object.fromEntries(rows.map((row) => [row.resource_identity, row.subject_revision]));
  }

  setDagResourceSubject(
    workItemId: string,
    resourceIdentity: string,
    subjectRevision: string,
    now = Date.now(),
  ): WorkItemRecord {
    const resource = requiredText(resourceIdentity, 500);
    const subject = requiredText(subjectRevision, 500);
    if (!resource || !subject) throw new Error("INVALID_DAG_RESOURCE_SUBJECT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWorkInternal(workItemId);
      const existing = this.db
        .prepare("SELECT subject_revision FROM work_dag_resource_subjects WHERE work_item_id=? AND resource_identity=?")
        .get(workItemId, resource) as { subject_revision?: string } | undefined;
      if (existing?.subject_revision === subject) {
        this.db.exec("COMMIT");
        return work;
      }
      this.db
        .prepare(
          "INSERT INTO work_dag_resource_subjects(work_item_id,resource_identity,subject_revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(work_item_id,resource_identity) DO UPDATE SET subject_revision=excluded.subject_revision,updated_at=excluded.updated_at",
        )
        .run(workItemId, resource, subject, now);
      const resourceSubjects = this.listDagResourceSubjects(workItemId);
      const composite = "resources:" + stableDigest(resourceSubjects);
      const changed = this.db
        .prepare(
          "UPDATE work_items SET current_subject_revision=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(composite, now, workItemId, work.stateRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.db
        .prepare("UPDATE work_evidence SET stale=1 WHERE work_item_id=? AND subject_revision<>? AND stale=0")
        .run(workItemId, composite);
      this.db
        .prepare("UPDATE work_approvals SET stale=1 WHERE work_item_id=? AND subject_revision<>? AND stale=0")
        .run(workItemId, composite);
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "work.resource_subject_changed",
        JSON.stringify({ resourceIdentity: resource, subjectRevision: subject, compositeSubjectRevision: composite }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setCurrentSubjectRevision(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    subjectRevision: string,
    now = Date.now(),
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
    const revision = requiredText(subjectRevision, 500);
    if (!revision) throw new Error("INVALID_WORK_SUBJECT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      this.assertWorkOrchestrationFence(work, fence);
      if (work.currentSubjectRevision === revision) {
        this.db.exec("COMMIT");
        return work;
      }
      const changed = this.db
        .prepare(
          "UPDATE work_items SET current_subject_revision=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(revision, now, workItemId, expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const staleEvidence = this.db
        .prepare("UPDATE work_evidence SET stale=1 WHERE work_item_id=? AND subject_revision<>? AND stale=0")
        .run(workItemId, revision);
      const staleApprovals = this.db
        .prepare("UPDATE work_approvals SET stale=1 WHERE work_item_id=? AND subject_revision<>? AND stale=0")
        .run(workItemId, revision);
      if (staleEvidence.changes > 0) {
        this.event(
          workItemId,
          work.activeWorkAttemptId,
          "evidence.staled",
          JSON.stringify({ count: staleEvidence.changes, subjectRevision: revision }),
          now,
        );
      }
      if (staleApprovals.changes > 0) {
        this.event(
          workItemId,
          work.activeWorkAttemptId,
          "approval.invalidated",
          JSON.stringify({ count: staleApprovals.changes, subjectRevision: revision }),
          now,
        );
      }
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "work.subject_changed",
        JSON.stringify({ subjectRevision: revision }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordEvidence(
    workItemId: string,
    principalId: string,
    scope: string,
    input: {
      workAttemptId: string;
      taskId?: string;
      runId?: string;
      type: string;
      status: WorkEvidenceStatus;
      source: WorkEvidenceSource;
      summary?: string;
      artifactRef?: string;
      subjectRevision: string;
      environmentIdentity?: string;
      verifierIdentity?: string;
    },
    now = Date.now(),
  ): WorkEvidenceRecord {
    const type = requiredText(input.type, 200);
    const subjectRevision = requiredText(input.subjectRevision, 500);
    if (
      !type ||
      !subjectRevision ||
      !["pending", "passed", "failed", "unknown"].includes(input.status) ||
      !["agent_reported", "worker_verified", "ci_verified", "human_verified", "external_verified"].includes(
        input.source,
      )
    ) {
      throw new Error("INVALID_WORK_EVIDENCE");
    }

    const taskId = input.taskId?.trim() || null;
    const runId = input.runId?.trim() || null;
    const summary = input.summary?.trim() || null;
    const artifactRef = input.artifactRef?.trim() || null;
    const environmentIdentity = input.environmentIdentity?.trim() || null;
    const verifierIdentity = input.verifierIdentity?.trim() || null;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      const attempt = this.getWorkAttempt(input.workAttemptId);
      if (attempt.workItemId !== workItemId) throw new Error("EVIDENCE_ATTEMPT_MISMATCH");

      if (!work.currentSubjectRevision || work.currentSubjectRevision !== subjectRevision) {
        const publicationBound = type === "publication" || type === "pull_request";
        const publicationMatch = publicationBound
          ? /^publication:([0-9a-f-]{36}):([a-f0-9]{40,64})$/i.exec(subjectRevision)
          : null;
        const publication = publicationMatch
          ? (this.db
              .prepare(
                "SELECT publication_id,commit_sha,state,source_subject_revision,artifact_ref FROM work_publications WHERE publication_id=? AND work_item_id=?",
              )
              .get(publicationMatch[1]!, workItemId) as Row | undefined)
          : undefined;
        const artifactBindingValid =
          type === "publication"
            ? String(publication?.artifact_ref ?? "") === artifactRef
            : type === "pull_request"
              ? Boolean(artifactRef)
              : false;
        if (
          !publication ||
          publication.state !== "pushed" ||
          String(publication.commit_sha ?? "").toLowerCase() !== publicationMatch![2]!.toLowerCase() ||
          String(publication.source_subject_revision ?? "") !== work.currentSubjectRevision ||
          !artifactBindingValid
        ) {
          throw new Error("STALE_WORK_SUBJECT");
        }
      }
      const existing = this.db
        .prepare(
          "SELECT * FROM work_evidence WHERE work_item_id=? AND work_attempt_id=? AND type=? AND source=? AND subject_revision=? AND task_id IS ? AND run_id IS ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(workItemId, input.workAttemptId, type, input.source, subjectRevision, taskId, runId) as Row | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return this.fromEvidenceRow(existing);
      }

      let staleCount = 0;
      if (input.source !== "agent_reported") {
        const stale = this.db
          .prepare(
            "UPDATE work_evidence SET stale=1 WHERE work_item_id=? AND work_attempt_id=? AND type=? AND subject_revision=? AND source<>'agent_reported' AND stale=0",
          )
          .run(workItemId, input.workAttemptId, type, subjectRevision);
        staleCount = Number(stale.changes);
      }

      const evidenceId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_evidence(evidence_id,work_item_id,work_attempt_id,task_id,run_id,type,status,source,summary,artifact_ref,subject_revision,environment_identity,verifier_identity,stale,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
        )
        .run(
          evidenceId,
          workItemId,
          input.workAttemptId,
          taskId,
          runId,
          type,
          input.status,
          input.source,
          summary,
          artifactRef,
          subjectRevision,
          environmentIdentity,
          verifierIdentity,
          now,
        );
      if (staleCount > 0) {
        this.event(
          workItemId,
          input.workAttemptId,
          "evidence.staled",
          JSON.stringify({
            count: staleCount,
            reason: "verification_binding_superseded",
            type,
            subjectRevision,
          }),
          now,
        );
      }
      this.event(workItemId, input.workAttemptId, "evidence.recorded", JSON.stringify({ evidenceId, type }), now);
      const row = this.db.prepare("SELECT * FROM work_evidence WHERE evidence_id=?").get(evidenceId) as Row;
      this.db.exec("COMMIT");
      return this.fromEvidenceRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  listEvidence(workItemId: string): WorkEvidenceRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_evidence WHERE work_item_id=? ORDER BY created_at,evidence_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromEvidenceRow(row));
  }

  submitReviewDecision(
    workItemId: string,
    principalId: string,
    scope: string,
    input: {
      expectedRevision: number;
      subjectRevision: string;
      decision: ReviewDecision;
      reason?: string;
      actorPrincipalId?: string;
    },
    now = Date.now(),
  ): ReviewDecisionRecord {
    const subjectRevision = requiredText(input.subjectRevision, 500);
    if (!subjectRevision || !["accepted", "rework", "rejected"].includes(input.decision)) {
      throw new Error("INVALID_REVIEW_DECISION");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== input.expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (work.currentSubjectRevision !== subjectRevision) throw new Error("STALE_WORK_SUBJECT");
      const reviewDecisionId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_review_decisions(review_decision_id,work_item_id,subject_revision,decision,reason,actor_principal_id,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          reviewDecisionId,
          workItemId,
          subjectRevision,
          input.decision,
          input.reason?.trim() || null,
          requiredText(input.actorPrincipalId, 200) || principalId,
          now,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, workItemId, input.expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "review.decided",
        JSON.stringify({ reviewDecisionId, decision: input.decision }),
        now,
      );
      const row = this.db
        .prepare("SELECT * FROM work_review_decisions WHERE review_decision_id=?")
        .get(reviewDecisionId) as Row;
      this.db.exec("COMMIT");
      return this.fromReviewRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordApproval(
    workItemId: string,
    principalId: string,
    scope: string,
    input: {
      expectedRevision: number;
      actor: string;
      role: string;
      approvalScope: string;
      subjectType: string;
      subjectRevision: string;
      decision: ApprovalDecision;
    },
    now = Date.now(),
  ): WorkApprovalRecord {
    const actor = requiredText(input.actor, 200);
    const role = requiredText(input.role, 200);
    const approvalScope = requiredText(input.approvalScope, 200);
    const subjectType = requiredText(input.subjectType, 200);
    const subjectRevision = requiredText(input.subjectRevision, 500);
    const validPair =
      (approvalScope === "work_completion" && subjectType === "workspace_revision") ||
      (approvalScope === "publish_work_branch" && subjectType === "publication_artifact");
    if (
      !actor ||
      !role ||
      !approvalScope ||
      !subjectType ||
      !subjectRevision ||
      !validPair ||
      !["approved", "rejected"].includes(input.decision)
    ) {
      throw new Error("INVALID_WORK_APPROVAL");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== input.expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (approvalScope === "work_completion" && work.currentSubjectRevision !== subjectRevision)
        throw new Error("STALE_WORK_SUBJECT");
      const latestSucceededAttempt =
        approvalScope === "work_completion"
          ? (this.db
              .prepare(
                "SELECT work_attempt_id FROM work_attempts WHERE work_item_id=? AND status='succeeded' ORDER BY sequence DESC LIMIT 1",
              )
              .get(workItemId) as Row | undefined)
          : undefined;
      if (approvalScope === "work_completion" && !latestSucceededAttempt)
        throw new Error("WORK_APPROVAL_ATTEMPT_REQUIRED");
      const approvalId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_approvals(approval_id,work_item_id,work_attempt_id,actor,role,approval_scope,subject_type,subject_revision,decision,stale,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?)",
        )
        .run(
          approvalId,
          workItemId,
          latestSucceededAttempt?.work_attempt_id == null ? null : String(latestSucceededAttempt.work_attempt_id),
          actor,
          role,
          approvalScope,
          subjectType,
          subjectRevision,
          input.decision,
          now,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, workItemId, input.expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const row = this.db.prepare("SELECT * FROM work_approvals WHERE approval_id=?").get(approvalId) as Row;
      this.db.exec("COMMIT");
      return this.fromApprovalRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishWorkAttempt(
    workItemId: string,
    workAttemptId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    attemptStatus: Exclude<WorkAttemptStatus, "active">,
    nextWorkStatus: WorkStatus,
    now = Date.now(),
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
    if (!["succeeded", "failed", "cancelled"].includes(attemptStatus) || !WORK_STATUSES.has(nextWorkStatus)) {
      throw new Error("INVALID_WORK_ATTEMPT_FINISH");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (work.activeWorkAttemptId !== workAttemptId) throw new Error("STALE_WORK_ATTEMPT");
      this.assertWorkOrchestrationFence(work, fence);
      const changedAttempt = this.db
        .prepare(
          "UPDATE work_attempts SET status=?,finished_at=? WHERE work_attempt_id=? AND work_item_id=? AND status='active'",
        )
        .run(attemptStatus, now, workAttemptId, workItemId);
      if (changedAttempt.changes !== 1) throw new Error("STALE_WORK_ATTEMPT");
      const changedWork = this.db
        .prepare(
          "UPDATE work_items SET status=?,active_work_attempt_id=NULL,state_revision=state_revision+1,updated_at=?,completed_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(
          nextWorkStatus,
          now,
          TERMINAL_WORK_STATUSES.has(nextWorkStatus) ? now : null,
          workItemId,
          expectedRevision,
        );
      if (changedWork.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(workItemId, workAttemptId, "work_attempt." + attemptStatus, null, now);
      if (nextWorkStatus === "waiting_review") {
        this.event(
          workItemId,
          workAttemptId,
          "review.requested",
          JSON.stringify({ subjectRevision: work.currentSubjectRevision }),
          now,
        );
      }
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getEffectiveRequiredEvidence(workItemId: string): string[] {
    const work = this.getWorkInternal(workItemId);
    const workflow = this.getWorkflow(work.workflowId, work.workflowVersion);
    const required = new Set(workflow.definition.validation.requiredEvidence);
    const latestAttempt = this.db
      .prepare("SELECT task_id FROM work_attempts WHERE work_item_id=? ORDER BY sequence DESC LIMIT 1")
      .get(workItemId) as { task_id?: string | null } | undefined;
    if (latestAttempt?.task_id) {
      const taskTable = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expert_tasks'")
        .get() as { name?: string } | undefined;
      if (taskTable) {
        const task = this.db
          .prepare("SELECT validation_snapshot_json FROM expert_tasks WHERE task_id=?")
          .get(latestAttempt.task_id) as { validation_snapshot_json?: string | null } | undefined;
        const steps = normalizeVerificationPolicy(
          task?.validation_snapshot_json ? JSON.parse(task.validation_snapshot_json) : [],
        );
        for (const step of steps) required.add(step.evidenceType);
      }
    }
    return [...required];
  }

  evaluateCompletionGate(workItemId: string, principalId: string, scope: string): CompletionGateResult {
    const work = this.getWork(workItemId, principalId, scope);
    const workflow = this.getWorkflow(work.workflowId, work.workflowVersion);
    const latestAttempt = this.db
      .prepare("SELECT * FROM work_attempts WHERE work_item_id=? ORDER BY sequence DESC LIMIT 1")
      .get(workItemId) as Row | undefined;
    const missing: string[] = [];
    if (workflow.definition.completion.require.includes("latest_work_attempt_succeeded")) {
      if (!latestAttempt || latestAttempt.status !== "succeeded") missing.push("latest_work_attempt_succeeded");
    }
    if (workflow.definition.completion.require.includes("required_evidence_passed")) {
      for (const requiredType of this.getEffectiveRequiredEvidence(workItemId)) {
        const evidence = work.currentSubjectRevision
          ? (this.db
              .prepare(
                "SELECT evidence_id FROM work_evidence WHERE work_item_id=? AND work_attempt_id=? AND type=? AND status='passed' AND stale=0 AND subject_revision=? AND source<>'agent_reported' ORDER BY created_at DESC LIMIT 1",
              )
              .get(
                workItemId,
                String(latestAttempt?.work_attempt_id ?? ""),
                requiredType,
                work.currentSubjectRevision,
              ) as Row | undefined)
          : undefined;
        if (!evidence) missing.push("required_evidence:" + requiredType);
      }
    }
    if (workflow.definition.completion.require.includes("no_unresolved_blocker") && work.status === "blocked") {
      missing.push("no_unresolved_blocker");
    }
    if (workflow.definition.completion.require.includes("review_accepted")) {
      const review = work.currentSubjectRevision
        ? (this.db
            .prepare(
              "SELECT decision FROM work_review_decisions WHERE work_item_id=? AND subject_revision=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(workItemId, work.currentSubjectRevision) as Row | undefined)
        : undefined;
      if (!review || review.decision !== "accepted") missing.push("review_accepted");
    }
    if (workflow.definition.completion.require.includes("required_approvals_approved")) {
      for (const required of workflow.definition.completion.requiredApprovals ?? []) {
        let requiredSubject = work.currentSubjectRevision;
        if (required.scope === "publish_work_branch" && required.subjectType === "publication_artifact") {
          const publication = work.currentSubjectRevision
            ? (this.db
                .prepare(
                  "SELECT publication_id,commit_sha FROM work_publications WHERE work_item_id=? AND source_subject_revision=? AND commit_sha IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
                )
                .get(workItemId, work.currentSubjectRevision) as Row | undefined)
            : undefined;
          requiredSubject =
            publication?.publication_id && publication.commit_sha
              ? "publication:" + String(publication.publication_id) + ":" + String(publication.commit_sha)
              : null;
        }
        const approval = requiredSubject
          ? required.scope === "work_completion"
            ? (this.db
                .prepare(
                  "SELECT decision FROM work_approvals WHERE work_item_id=? AND work_attempt_id=? AND approval_scope=? AND subject_type=? AND subject_revision=? AND stale=0 ORDER BY created_at DESC,rowid DESC LIMIT 1",
                )
                .get(
                  workItemId,
                  String(latestAttempt?.work_attempt_id ?? ""),
                  required.scope,
                  required.subjectType,
                  requiredSubject,
                ) as Row | undefined)
            : (this.db
                .prepare(
                  "SELECT decision FROM work_approvals WHERE work_item_id=? AND approval_scope=? AND subject_type=? AND subject_revision=? AND stale=0 ORDER BY created_at DESC,rowid DESC LIMIT 1",
                )
                .get(workItemId, required.scope, required.subjectType, requiredSubject) as Row | undefined)
          : undefined;
        if (!approval || approval.decision !== "approved") {
          missing.push("required_approval:" + required.scope);
        }
      }
    }
    if (workflow.definition.completion.require.includes("publication_succeeded")) {
      const publication = work.currentSubjectRevision
        ? (this.db
            .prepare(
              "SELECT publication_id,commit_sha,artifact_ref FROM work_publications WHERE work_item_id=? AND source_subject_revision=? AND state='pushed' AND commit_sha IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(workItemId, work.currentSubjectRevision) as Row | undefined)
        : undefined;
      const publicationSubject =
        publication?.publication_id && publication.commit_sha
          ? "publication:" + String(publication.publication_id) + ":" + String(publication.commit_sha)
          : null;
      const evidence = publicationSubject
        ? (this.db
            .prepare(
              "SELECT evidence_id FROM work_evidence WHERE work_item_id=? AND type='publication' AND status='passed' AND source='worker_verified' AND stale=0 AND subject_revision=? AND artifact_ref=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(workItemId, publicationSubject, String(publication!.artifact_ref ?? "")) as Row | undefined)
        : undefined;
      if (!publication || !evidence) missing.push("publication_succeeded");
    }
    if (workflow.definition.completion.require.includes("change_request_created")) {
      const publication = work.currentSubjectRevision
        ? (this.db
            .prepare(
              "SELECT publication_id,commit_sha FROM work_publications WHERE work_item_id=? AND source_subject_revision=? AND state='pushed' AND commit_sha IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(workItemId, work.currentSubjectRevision) as Row | undefined)
        : undefined;
      const publicationSubject =
        publication?.publication_id && publication.commit_sha
          ? "publication:" + String(publication.publication_id) + ":" + String(publication.commit_sha)
          : null;
      const changeRequestEvidence = publicationSubject
        ? (this.db
            .prepare(
              "SELECT evidence_id FROM work_evidence WHERE work_item_id=? AND type='pull_request' AND status='passed' AND stale=0 AND subject_revision=? AND source<>'agent_reported' ORDER BY created_at DESC,rowid DESC LIMIT 1",
            )
            .get(workItemId, publicationSubject) as Row | undefined)
        : undefined;
      if (!changeRequestEvidence) missing.push("change_request_created");
    }
    return {
      ready: missing.length === 0,
      missing,
      workflowId: workflow.workflowId,
      workflowVersion: workflow.version,
      subjectRevision: work.currentSubjectRevision,
    };
  }

  blockWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    reason: string,
    context: string | null,
    now = Date.now(),
    metadata: {
      resumeCondition?: string;
      blockedByType?: string;
      blockedByRef?: string;
      preserveNextAction?: boolean;
    } = {},
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
    const blockedReason = requiredText(reason, 200);
    const resumeCondition = requiredText(metadata.resumeCondition ?? "manual", 500);
    const blockedByType = optionalText(metadata.blockedByType, 200);
    const blockedByRef = optionalText(metadata.blockedByRef, 500);
    if (!blockedReason || !resumeCondition) throw new Error("INVALID_BLOCK_REASON");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(workItemId, principalId, scope);
      if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      this.assertWorkOrchestrationFence(current, fence);
      const changed = this.db
        .prepare(
          "UPDATE work_items SET status='blocked',blocked_reason=?,blocked_context=?,blocked_at=?,resume_condition=?,blocked_by_type=?,blocked_by_ref=?,next_action_type=CASE WHEN ?=1 THEN next_action_type ELSE NULL END,next_action_at=NULL,next_action_context=CASE WHEN ?=1 THEN next_action_context ELSE NULL END,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=?",
        )
        .run(
          blockedReason,
          context,
          now,
          resumeCondition,
          blockedByType,
          blockedByRef,
          metadata.preserveNextAction === true ? 1 : 0,
          metadata.preserveNextAction === true ? 1 : 0,
          now,
          workItemId,
          principalId,
          scope,
          expectedRevision,
        );
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(
        workItemId,
        current.activeWorkAttemptId,
        "work.blocked",
        JSON.stringify({
          reason: blockedReason,
          resumeCondition,
          blockedByType,
          blockedByRef,
          preservedNextAction: metadata.preserveNextAction === true,
        }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resumeBlockedWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    nextStatus: "queued" | "running" | "rework",
    now = Date.now(),
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      !["queued", "running", "rework"].includes(nextStatus)
    ) {
      throw new Error("INVALID_WORK_RESUME");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(workItemId, principalId, scope);
      if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (current.status !== "blocked") throw new Error("WORK_NOT_BLOCKED");
      this.assertWorkOrchestrationFence(current, fence);
      const changed = this.db
        .prepare(
          "UPDATE work_items SET status=?,blocked_reason=NULL,blocked_context=NULL,blocked_at=NULL,resume_condition=NULL,blocked_by_type=NULL,blocked_by_ref=NULL,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=? AND status='blocked'",
        )
        .run(nextStatus, now, workItemId, principalId, scope, expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.event(
        workItemId,
        current.activeWorkAttemptId,
        "work.resumed",
        JSON.stringify({
          previousReason: current.blockedReason,
          previousBlockedByType: current.blockedByType,
          previousBlockedByRef: current.blockedByRef,
        }),
        now,
      );
      if (current.orchestrationEngine === "dynamic-dag") {
        this.db
          .prepare(
            "INSERT INTO work_dag_facts(fact_id,work_item_id,fact_key,value_json,subject_revision,resource_identity,source_execution_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            workItemId,
            "blocker.resolved",
            JSON.stringify(true),
            null,
            null,
            "control:resume:" + (current.stateRevision + 1),
            now,
          );
      }
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  scheduleNextAction(
    workItemId: string,
    expectedRevision: number,
    actionType: string | null,
    dueAt: number | null,
    now = Date.now(),
    context: string | null = null,
    fence?: WorkOrchestrationFence,
  ): WorkItemRecord {
    if (actionType !== null && !requiredText(actionType, 100)) throw new Error("INVALID_NEXT_ACTION");
    const contextLimit = actionType === "rework" ? 10_000 : 500;
    const normalizedContext = context === null ? null : requiredText(context, contextLimit);
    if (context !== null && !normalizedContext) throw new Error("INVALID_NEXT_ACTION");
    if (dueAt !== null && !Number.isFinite(dueAt)) throw new Error("INVALID_NEXT_ACTION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWorkInternal(workItemId);
      if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      this.assertWorkOrchestrationFence(current, fence);
      const changed = this.db
        .prepare(
          "UPDATE work_items SET next_action_type=?,next_action_at=?,next_action_context=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(actionType, dueAt, actionType === null ? null : normalizedContext, now, workItemId, expectedRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const updatedRow = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      const updated = this.fromWorkRow(updatedRow);
      if (actionType === "failure_retry") {
        this.event(
          workItemId,
          updated.activeWorkAttemptId,
          "run.retry_scheduled",
          JSON.stringify({ dueAt, reason: normalizedContext }),
          now,
        );
      }
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordRunContinued(
    workItemId: string,
    workAttemptId: string,
    taskId: string,
    previousRunId: string,
    reason: string,
    now = Date.now(),
  ): void {
    const attempt = this.getWorkAttempt(workAttemptId);
    if (attempt.workItemId !== workItemId || attempt.taskId !== taskId) throw new Error("WORK_ATTEMPT_TASK_MISMATCH");
    const boundedReason = requiredText(reason, 500);
    const boundedRunId = requiredText(previousRunId, 200);
    if (!boundedReason || !boundedRunId) throw new Error("INVALID_RUN_CONTINUATION_EVENT");
    this.event(
      workItemId,
      workAttemptId,
      "run.continued",
      JSON.stringify({ taskId, previousRunId: boundedRunId, reason: boundedReason }),
      now,
    );
  }

  listDueWorkIds(now = Date.now(), limit = 100): string[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (
      this.db
        .prepare(
          "SELECT work_item_id FROM work_items WHERE status NOT IN ('completed','failed','cancelled') AND next_action_at IS NOT NULL AND next_action_at<=? ORDER BY next_action_at LIMIT ?",
        )
        .all(now, boundedLimit) as Row[]
    ).map((row) => String(row.work_item_id));
  }

  listReconciliationWorkIds(now = Date.now(), limit = 100): string[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const hasPublicationTable = Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_publications'").get(),
    );
    const waitingReviewClause = hasPublicationTable ? "OR status='waiting_review'" : "";
    return (
      this.db
        .prepare(
          [
            "SELECT work_item_id FROM work_items",
            "WHERE status NOT IN ('completed','failed','cancelled')",
            "AND (",
            "status IN ('queued','rework')",
            "OR (status='running' AND (next_action_at IS NULL OR next_action_at<=?))",
            "OR (status='blocked' AND next_action_at IS NOT NULL AND next_action_at<=?)",
            waitingReviewClause,
            ")",
            "ORDER BY CASE WHEN next_action_at IS NULL THEN 0 ELSE 1 END, COALESCE(next_action_at,updated_at), updated_at",
            "LIMIT ?",
          ]
            .filter(Boolean)
            .join(" "),
        )
        .all(now, now, boundedLimit) as Row[]
    ).map((row) => String(row.work_item_id));
  }
  listPendingSourceObservationIdsForWork(workItemId: string, limit = 100): string[] {
    const id = requiredText(workItemId, 100);
    if (!id) throw new Error("INVALID_WORK_ITEM_ID");
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (
      this.db
        .prepare(
          "SELECT observation_id FROM work_source_observations WHERE work_item_id=? AND reconciled_at IS NULL ORDER BY observed_at,created_at,observation_id LIMIT ?",
        )
        .all(id, boundedLimit) as Row[]
    ).map((row) => String(row.observation_id));
  }

  listPendingSourceObservationIds(limit = 100): string[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return (
      this.db
        .prepare(
          "SELECT observation_id FROM work_source_observations WHERE reconciled_at IS NULL ORDER BY observed_at,created_at,observation_id LIMIT ?",
        )
        .all(boundedLimit) as Row[]
    ).map((row) => String(row.observation_id));
  }

  listEvents(workItemId: string, afterEventId = 0, limit = 100): { events: WorkEventRecord[]; nextEventId: number } {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(
        "SELECT event_id,work_item_id,work_attempt_id,event_type,details,created_at FROM work_events WHERE work_item_id=? AND event_id>? ORDER BY event_id LIMIT ?",
      )
      .all(workItemId, Math.max(0, Math.floor(afterEventId)), boundedLimit) as Row[];
    const events = rows.map((row) => ({
      eventId: Number(row.event_id),
      workItemId: String(row.work_item_id),
      workAttemptId: row.work_attempt_id == null ? null : String(row.work_attempt_id),
      eventType: String(row.event_type),
      details: row.details ? (JSON.parse(String(row.details)) as Record<string, unknown>) : null,
      createdAt: Number(row.created_at),
    }));
    return {
      events,
      nextEventId: events.at(-1)?.eventId ?? Math.max(0, Math.floor(afterEventId)),
    };
  }

  adminListWorkItems(input: { limit?: number; offset?: number; status?: WorkStatus; q?: string } = {}): {
    items: WorkItemRecord[];
    total: number;
    limit: number;
    offset: number;
  } {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.status) {
      if (!WORK_STATUSES.has(input.status)) throw new Error("INVALID_WORK_STATUS");
      where.push("status=?");
      params.push(input.status);
    }
    const q = input.q?.trim();
    if (q) {
      where.push(
        "(work_item_id LIKE ? OR title LIKE ? OR source_ref LIKE ? OR requested_expert_id LIKE ? OR requested_deployment_id LIKE ?)",
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalRow = this.db.prepare("SELECT COUNT(*) AS total FROM work_items" + clause).get(...params) as {
      total: number;
    };
    const rows = this.db
      .prepare("SELECT * FROM work_items" + clause + " ORDER BY updated_at DESC, work_item_id LIMIT ? OFFSET ?")
      .all(...params, limit, offset) as Row[];
    return {
      items: rows.map((row) => this.fromWorkRow(row)),
      total: Number(totalRow.total),
      limit,
      offset,
    };
  }

  listWorkspaces(workItemId: string): WorkspaceRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_workspaces WHERE work_item_id=? ORDER BY created_at,workspace_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromWorkspaceRow(row));
  }

  listReviewDecisions(workItemId: string): ReviewDecisionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_review_decisions WHERE work_item_id=? ORDER BY created_at,review_decision_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromReviewRow(row));
  }

  listApprovals(workItemId: string): WorkApprovalRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_approvals WHERE work_item_id=? ORDER BY created_at,approval_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromApprovalRow(row));
  }

  getRequirementSnapshot(workItemId: string, revision?: number): RequirementSnapshot {
    const row =
      revision === undefined
        ? (this.db
            .prepare("SELECT * FROM work_requirement_snapshots WHERE work_item_id=? ORDER BY revision DESC LIMIT 1")
            .get(workItemId) as Row | undefined)
        : (this.db
            .prepare("SELECT * FROM work_requirement_snapshots WHERE work_item_id=? AND revision=?")
            .get(workItemId, revision) as Row | undefined);
    if (!row) throw new Error("REQUIREMENT_SNAPSHOT_NOT_FOUND");
    return this.fromRequirementSnapshotRow(row);
  }

  listRequirementSnapshots(workItemId: string): RequirementSnapshot[] {
    return (
      this.db
        .prepare("SELECT * FROM work_requirement_snapshots WHERE work_item_id=? ORDER BY revision")
        .all(workItemId) as Row[]
    ).map((row) => this.fromRequirementSnapshotRow(row));
  }

  ensureRequirementSnapshot(workItemId: string, now = Date.now(), resolverVersion?: string): RequirementSnapshot {
    const existingWork = this.getWorkInternal(workItemId);
    if (existingWork.currentRequirementRevision > 0) {
      return this.getRequirementSnapshot(workItemId, existingWork.currentRequirementRevision);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWorkInternal(workItemId);
      if (work.currentRequirementRevision > 0) {
        const existing = this.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
        this.db.exec("COMMIT");
        return existing;
      }
      const workflow = this.getWorkflow(work.workflowId, work.workflowVersion);
      const resolved = resolveWorkIntentDeterministically(work.description);
      const requirements = normalizeWorkRequirements(resolved.requirements);
      const unresolved = normalizeUnresolvedWorkRequirements(resolved.unresolved);
      const policy = policyIdentity(workflow.workflowId, workflow.version, workflow.definition);
      const policyContext = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);
      const snapshot: RequirementSnapshot = {
        workItemId,
        revision: 1,
        resolverIdentity: resolved.resolverIdentity,
        resolverVersion: resolverVersion ?? resolved.resolverVersion,
        originalRequest: resolved.originalRequest,
        originalRequestDigest: resolved.originalRequestDigest,
        requirements,
        unresolved,
        policyObligations: [],
        policyContextRef: workDagPolicyContextRef(policyContext),
        policyContextDigest: policyContext.digest,
        policyRef: policy.policyRef,
        policyDigest: policy.policyDigest,
        effectiveDigest: effectiveRequirementDigest(
          workflow.workflowId,
          workflow.version,
          workflow.definition,
          requirements,
          unresolved,
          resolved.originalRequestDigest,
          policyContext.digest,
          [],
        ),
        createdAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO work_requirement_snapshots(work_item_id,revision,resolver_identity,resolver_version,original_request,original_request_digest,requirements_json,unresolved_json,policy_obligations_json,policy_context_ref,policy_context_digest,policy_ref,policy_digest,effective_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          workItemId,
          snapshot.revision,
          snapshot.resolverIdentity,
          snapshot.resolverVersion,
          snapshot.originalRequest,
          snapshot.originalRequestDigest,
          JSON.stringify(snapshot.requirements),
          JSON.stringify(snapshot.unresolved),
          JSON.stringify(snapshot.policyObligations),
          snapshot.policyContextRef,
          snapshot.policyContextDigest,
          snapshot.policyRef,
          snapshot.policyDigest,
          snapshot.effectiveDigest,
          now,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET current_requirement_revision=1 WHERE work_item_id=? AND current_requirement_revision=0",
        )
        .run(workItemId);
      if (changed.changes !== 1) throw new Error("STALE_REQUIREMENT_REVISION");
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "requirement.snapshot_created",
        JSON.stringify({
          revision: 1,
          resolverIdentity: snapshot.resolverIdentity,
          unresolved: snapshot.unresolved.map((item) => item.id),
          effectiveDigest: snapshot.effectiveDigest,
        }),
        now,
      );
      this.db.exec("COMMIT");
      return snapshot;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  updateRequirementSnapshot(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedWorkRevision: number,
    expectedRequirementRevision: number,
    requirements: readonly WorkRequirement[],
    resolverVersion = "typed-v1",
    now = Date.now(),
    unresolvedRequirements?: readonly UnresolvedWorkRequirement[],
  ): { work: WorkItemRecord; snapshot: RequirementSnapshot; impact: RequirementUpdateImpact } {
    const normalized = normalizeWorkRequirements(requirements);
    if (this.getWorkInternal(workItemId).currentRequirementRevision === 0) {
      this.ensureRequirementSnapshot(workItemId, now, resolverVersion);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(workItemId, principalId, scope);
      if (TERMINAL_WORK_STATUSES.has(current.status)) {
        throw new Error("WORK_ALREADY_TERMINAL");
      }
      if (current.stateRevision !== expectedWorkRevision) throw new Error("STALE_WORK_REVISION");
      if (current.currentRequirementRevision !== expectedRequirementRevision) {
        throw new Error("STALE_REQUIREMENT_REVISION");
      }
      const workflow = this.getWorkflow(current.workflowId, current.workflowVersion);
      const previous = this.getRequirementSnapshot(workItemId, expectedRequirementRevision);
      const unresolved =
        unresolvedRequirements === undefined
          ? previous.unresolved
          : normalizeUnresolvedWorkRequirements(unresolvedRequirements);
      const impact = classifyRequirementUpdateImpact(
        workflow.definition,
        previous.requirements,
        normalized,
        previous.unresolved,
        unresolved,
        previous.policyObligations,
      );
      effectiveObligations(workflow.definition, normalized, unresolved, previous.policyObligations);
      const policy = policyIdentity(workflow.workflowId, workflow.version, workflow.definition);
      const nextRevision = expectedRequirementRevision + 1;
      const snapshot: RequirementSnapshot = {
        workItemId,
        revision: nextRevision,
        resolverIdentity: previous.resolverIdentity,
        resolverVersion,
        originalRequest: previous.originalRequest,
        originalRequestDigest: previous.originalRequestDigest,
        requirements: normalized,
        unresolved,
        policyObligations: previous.policyObligations,
        policyContextRef: previous.policyContextRef,
        policyContextDigest: previous.policyContextDigest,
        policyRef: policy.policyRef,
        policyDigest: policy.policyDigest,
        effectiveDigest: effectiveRequirementDigest(
          workflow.workflowId,
          workflow.version,
          workflow.definition,
          normalized,
          unresolved,
          previous.originalRequestDigest,
          previous.policyContextDigest,
          previous.policyObligations,
        ),
        createdAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO work_requirement_snapshots(work_item_id,revision,resolver_identity,resolver_version,original_request,original_request_digest,requirements_json,unresolved_json,policy_obligations_json,policy_context_ref,policy_context_digest,policy_ref,policy_digest,effective_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          workItemId,
          nextRevision,
          snapshot.resolverIdentity,
          resolverVersion,
          snapshot.originalRequest,
          snapshot.originalRequestDigest,
          JSON.stringify(normalized),
          JSON.stringify(snapshot.unresolved),
          JSON.stringify(snapshot.policyObligations),
          snapshot.policyContextRef,
          snapshot.policyContextDigest,
          snapshot.policyRef,
          snapshot.policyDigest,
          snapshot.effectiveDigest,
          now,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET current_requirement_revision=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=? AND current_requirement_revision=?",
        )
        .run(nextRevision, now, workItemId, principalId, scope, expectedWorkRevision, expectedRequirementRevision);
      if (changed.changes !== 1) throw new Error("STALE_REQUIREMENT_REVISION");
      this.event(
        workItemId,
        current.activeWorkAttemptId,
        "requirement.updated",
        JSON.stringify({
          previousRevision: expectedRequirementRevision,
          revision: nextRevision,
          effectiveDigest: snapshot.effectiveDigest,
          impactKinds: impact.kinds,
          changedRequirementIds: impact.changedRequirementIds,
          addedRequiredObligationIds: impact.addedRequiredObligationIds,
          removedRequiredObligationIds: impact.removedRequiredObligationIds,
        }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return { work: this.fromWorkRow(row), snapshot, impact };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindRequirementPolicyContext(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedWorkRevision: number,
    expectedRequirementRevision: number,
    policyContext: WorkDagPolicyContext,
    now = Date.now(),
  ): { work: WorkItemRecord; snapshot: RequirementSnapshot } {
    const current = this.getWork(workItemId, principalId, scope);
    if (current.stateRevision !== expectedWorkRevision) throw new Error("STALE_WORK_REVISION");
    if (current.currentRequirementRevision !== expectedRequirementRevision) {
      throw new Error("STALE_REQUIREMENT_REVISION");
    }
    const previous = this.getRequirementSnapshot(workItemId, expectedRequirementRevision);
    if (previous.policyContextDigest === policyContext.digest) return { work: current, snapshot: previous };
    if (current.activeWorkAttemptId) {
      if (previous.policyContextDigest) throw new Error("REQUIREMENT_POLICY_CONTEXT_DRIFT");
      const activeAttempt = this.getWorkAttempt(current.activeWorkAttemptId);
      const deployment = policyContext.deployment;
      if (
        !deployment ||
        deployment.deploymentId !== activeAttempt.deploymentId ||
        deployment.configVersion !== activeAttempt.deploymentConfigVersion ||
        deployment.expertId !== activeAttempt.expertId
      ) {
        throw new Error("REQUIREMENT_POLICY_CONTEXT_DRIFT");
      }
    }
    const workflow = this.getWorkflow(current.workflowId, current.workflowVersion);
    const nextRevision = previous.revision + 1;
    const policyContextRef = workDagPolicyContextRef(policyContext);
    const pinnedPolicyObligations = policyContextObligations(workflow.definition, policyContext);
    const effectiveDigest = effectiveRequirementDigest(
      workflow.workflowId,
      workflow.version,
      workflow.definition,
      previous.requirements,
      previous.unresolved,
      previous.originalRequestDigest,
      policyContext.digest,
      pinnedPolicyObligations,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE work_items SET current_requirement_revision=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=? AND current_requirement_revision=?",
        )
        .run(nextRevision, now, workItemId, principalId, scope, expectedWorkRevision, expectedRequirementRevision);
      if (changed.changes !== 1) throw new Error("STALE_REQUIREMENT_REVISION");
      this.db
        .prepare(
          "INSERT INTO work_requirement_snapshots(work_item_id,revision,resolver_identity,resolver_version,original_request,original_request_digest,requirements_json,unresolved_json,policy_obligations_json,policy_context_ref,policy_context_digest,policy_ref,policy_digest,effective_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          workItemId,
          nextRevision,
          previous.resolverIdentity,
          previous.resolverVersion,
          previous.originalRequest,
          previous.originalRequestDigest,
          JSON.stringify(previous.requirements),
          JSON.stringify(previous.unresolved),
          JSON.stringify(pinnedPolicyObligations),
          policyContextRef,
          policyContext.digest,
          previous.policyRef,
          previous.policyDigest,
          effectiveDigest,
          now,
        );
      this.event(
        workItemId,
        current.activeWorkAttemptId,
        "requirement.policy_context_bound",
        JSON.stringify({
          previousRevision: previous.revision,
          revision: nextRevision,
          policyContextRef,
          policyContextDigest: policyContext.digest,
        }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      const snapshot = this.getRequirementSnapshot(workItemId, nextRevision);
      this.db.exec("COMMIT");
      return { work: this.fromWorkRow(row), snapshot };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getDagObligationsForRequirementRevision(workItemId: string, requirementRevision: number): DagObligation[] {
    const work = this.getWorkInternal(workItemId);
    const snapshot = this.getRequirementSnapshot(workItemId, requirementRevision);
    const workflow = this.getWorkflow(work.workflowId, work.workflowVersion);
    const identity = policyIdentity(workflow.workflowId, workflow.version, workflow.definition);
    if (snapshot.policyRef !== identity.policyRef || snapshot.policyDigest !== identity.policyDigest) {
      throw new Error("REQUIREMENT_POLICY_BINDING_MISMATCH");
    }
    return effectiveObligations(
      workflow.definition,
      snapshot.requirements,
      snapshot.unresolved,
      snapshot.policyObligations,
    );
  }

  getEffectiveDagObligations(workItemId: string): DagObligation[] {
    let work = this.getWorkInternal(workItemId);
    if (work.currentRequirementRevision === 0) {
      this.ensureRequirementSnapshot(workItemId);
      work = this.getWorkInternal(workItemId);
    }
    return this.getDagObligationsForRequirementRevision(workItemId, work.currentRequirementRevision);
  }

  getDagRevision(workItemId: string, revision?: number): WorkDagRevisionRecord {
    const row =
      revision === undefined
        ? (this.db
            .prepare("SELECT * FROM work_dag_revisions WHERE work_item_id=? ORDER BY revision DESC LIMIT 1")
            .get(workItemId) as Row | undefined)
        : (this.db
            .prepare("SELECT * FROM work_dag_revisions WHERE work_item_id=? AND revision=?")
            .get(workItemId, revision) as Row | undefined);
    if (!row) throw new Error("DAG_REVISION_NOT_FOUND");
    return this.fromDagRevisionRow(row);
  }

  listDagRevisions(workItemId: string): WorkDagRevisionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_revisions WHERE work_item_id=? ORDER BY revision")
        .all(workItemId) as Row[]
    ).map((row) => this.fromDagRevisionRow(row));
  }

  listDagProposals(workItemId: string): WorkDagProposalRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_proposals WHERE work_item_id=? ORDER BY created_at,proposal_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromDagProposalRow(row));
  }

  listDagReplanRequests(workItemId: string): WorkDagReplanRequestRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_replan_requests WHERE work_item_id=? ORDER BY created_at,request_id")
        .all(workItemId) as Row[]
    ).map((row) => ({
      requestId: String(row.request_id),
      workItemId: String(row.work_item_id),
      requestedBy: String(row.requested_by),
      reason: String(row.reason),
      state: String(row.state) as WorkDagReplanRequestRecord["state"],
      proposalId: row.proposal_id == null ? null : String(row.proposal_id),
      createdAt: Number(row.created_at),
      consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
    }));
  }

  requestDagReplan(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedWorkRevision: number,
    reason: string,
    now = Date.now(),
  ): WorkDagReplanRequestRecord {
    const normalizedReason = requiredText(reason, 2_000);
    if (!normalizedReason) throw new Error("INVALID_DAG_REPLAN_REQUEST");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedWorkRevision) throw new Error("STALE_WORK_REVISION");
      if (TERMINAL_WORK_STATUSES.has(work.status)) throw new Error("WORK_ALREADY_TERMINAL");
      if (work.orchestrationEngine !== "dynamic-dag") {
        throw new Error("WORK_REPLAN_REQUIRES_DYNAMIC_DAG");
      }
      const existing = this.db
        .prepare(
          "SELECT * FROM work_dag_replan_requests WHERE work_item_id=? AND state='pending' ORDER BY created_at,request_id LIMIT 1",
        )
        .get(workItemId) as Row | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return this.fromDagReplanRequestRow(existing);
      }
      const requestId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_dag_replan_requests(request_id,work_item_id,requested_by,reason,state,proposal_id,created_at,consumed_at) VALUES(?,?,?,?,'pending',NULL,?,NULL)",
        )
        .run(requestId, workItemId, principalId, normalizedReason, now);
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "dag.replan_requested",
        JSON.stringify({ requestId, requestedBy: principalId, reason: normalizedReason }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_dag_replan_requests WHERE request_id=?").get(requestId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagReplanRequestRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consumeDagReplanRequest(requestId: string, proposalId: string | null, now = Date.now()): WorkDagReplanRequestRecord {
    const changed = this.db
      .prepare(
        "UPDATE work_dag_replan_requests SET state='consumed',proposal_id=?,consumed_at=? WHERE request_id=? AND state='pending'",
      )
      .run(proposalId, now, requestId);
    if (changed.changes !== 1) throw new Error("DAG_REPLAN_REQUEST_NOT_PENDING");
    const row = this.db.prepare("SELECT * FROM work_dag_replan_requests WHERE request_id=?").get(requestId) as Row;
    return this.fromDagReplanRequestRow(row);
  }

  listDagExecutions(workItemId: string): WorkDagNodeExecutionRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM work_dag_executions WHERE work_item_id=? ORDER BY created_dag_revision,node_id,generation",
        )
        .all(workItemId) as Row[]
    ).map((row) => this.fromDagExecutionRow(row));
  }

  listDagLateResults(workItemId: string): WorkDagLateResultRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_late_results WHERE work_item_id=? ORDER BY late_result_id")
        .all(workItemId) as Row[]
    ).map((row) => ({
      lateResultId: Number(row.late_result_id),
      workItemId: String(row.work_item_id),
      nodeExecutionId: String(row.node_execution_id),
      nodeId: String(row.node_id),
      ownerId: String(row.owner_id),
      fence: Number(row.fence),
      currentState: String(row.current_state) as WorkDagLateResultRecord["currentState"],
      currentFence: Number(row.current_fence),
      disposition: String(row.disposition) as WorkDagLateResultRecord["disposition"],
      result: JSON.parse(String(row.result_json)) as DagNodeResult,
      resultDigest: String(row.result_digest),
      createdAt: Number(row.created_at),
    }));
  }

  listDagFacts(workItemId: string): WorkDagFactRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_facts WHERE work_item_id=? ORDER BY created_at,fact_id")
        .all(workItemId) as Row[]
    ).map((row) => ({
      factId: String(row.fact_id),
      workItemId: String(row.work_item_id),
      key: String(row.fact_key),
      value: JSON.parse(String(row.value_json)) as WorkDagFactRecord["value"],
      subjectRevision: row.subject_revision == null ? null : String(row.subject_revision),
      resourceIdentity: row.resource_identity == null ? null : String(row.resource_identity),
      sourceExecutionId: String(row.source_execution_id),
      createdAt: Number(row.created_at),
    }));
  }

  listDagEvidence(workItemId: string): WorkDagEvidenceRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_evidence WHERE work_item_id=? ORDER BY created_at,evidence_id")
        .all(workItemId) as Row[]
    ).map((row) => ({
      evidenceId: String(row.evidence_id),
      workItemId: String(row.work_item_id),
      type: String(row.evidence_type),
      passed: Number(row.passed) === 1,
      subjectRevision: row.subject_revision == null ? null : String(row.subject_revision),
      resourceIdentity: row.resource_identity == null ? null : String(row.resource_identity),
      verifierIdentity: String(row.verifier_identity),
      artifactRef: row.artifact_ref == null ? null : String(row.artifact_ref),
      sourceExecutionId: String(row.source_execution_id),
      requirementSemanticsDigest: String(row.requirement_semantics_digest ?? ""),
      createdAt: Number(row.created_at),
    }));
  }

  listDagArtifacts(workItemId: string): WorkDagArtifactRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_artifacts WHERE work_item_id=? ORDER BY created_at,artifact_id")
        .all(workItemId) as Row[]
    ).map((row) => ({
      artifactId: String(row.artifact_id),
      workItemId: String(row.work_item_id),
      type: String(row.artifact_type),
      ref: String(row.artifact_ref),
      subjectRevision: row.subject_revision == null ? null : String(row.subject_revision),
      resourceIdentity: row.resource_identity == null ? null : String(row.resource_identity),
      sourceExecutionId: String(row.source_execution_id),
      createdAt: Number(row.created_at),
    }));
  }

  listDagDecisions(workItemId: string): WorkDagDecisionRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_decisions WHERE work_item_id=? ORDER BY decision_id")
        .all(workItemId) as Row[]
    ).map((row) => ({
      decisionId: Number(row.decision_id),
      workItemId: String(row.work_item_id),
      workStateRevision: Number(row.work_state_revision),
      dagRevision: Number(row.dag_revision),
      requirementRevision: Number(row.requirement_revision),
      subjectRevision: row.subject_revision == null ? null : String(row.subject_revision),
      action: String(row.action),
      nodeId: row.node_id == null ? null : String(row.node_id),
      reasonCode: String(row.reason_code),
      requirementIds: JSON.parse(String(row.requirement_ids_json)) as string[],
      policyRef: String(row.policy_ref),
      idempotencyRef: row.idempotency_ref == null ? null : String(row.idempotency_ref),
      resultRef: row.result_ref == null ? null : String(row.result_ref),
      createdAt: Number(row.created_at),
    }));
  }

  getDagContext(workItemId: string): DagContext {
    const work = this.getWorkInternal(workItemId);
    const requirementSnapshot =
      work.currentRequirementRevision > 0
        ? this.getRequirementSnapshot(workItemId, work.currentRequirementRevision)
        : null;
    const requirementWorkflow = requirementSnapshot ? this.getWorkflow(work.workflowId, work.workflowVersion) : null;
    const resourceSubjects = this.listDagResourceSubjects(workItemId);
    const primaryResource = work.repositoryId ? "repo:" + work.repositoryId : null;
    const factRecords = this.listDagFacts(workItemId);
    const factContext: DagContext = {
      subject: work.currentSubjectRevision,
      primaryResource,
      resourceSubjects,
      facts: {},
      evidence: [],
      artifacts: [],
      blockers: [],
      cancelled: false,
    };
    const facts: Record<string, WorkDagFactRecord["value"]> = {};
    for (const fact of factRecords) {
      const currentSubject = subjectForResource(factContext, fact.resourceIdentity);
      if (fact.subjectRevision === null || fact.subjectRevision === currentSubject) facts[fact.key] = fact.value;
    }

    const gate = this.evaluateCompletionGate(workItemId, work.principalId, work.scope);
    facts["attempt.latest_succeeded"] = !gate.missing.includes("latest_work_attempt_succeeded");
    facts["review.accepted"] = !gate.missing.includes("review_accepted");
    facts["approval.required_approved"] = !gate.missing.some((item) => item.startsWith("required_approval:"));
    facts["publication.succeeded"] = !gate.missing.includes("publication_succeeded");
    facts["change_request.created"] = !gate.missing.includes("change_request_created");

    return {
      subject: work.currentSubjectRevision,
      primaryResource,
      resourceSubjects,
      facts,
      factRecords: factRecords.map((fact) => ({
        key: fact.key,
        value: fact.value,
        subject: fact.subjectRevision,
        resource: fact.resourceIdentity,
        createdAt: fact.createdAt,
      })),
      evidence: [
        ...this.listEvidence(workItemId).map((evidence) => ({
          type: evidence.type,
          subject: evidence.subjectRevision,
          passed: evidence.status === "passed" && evidence.source !== "agent_reported",
          stale: evidence.stale,
          createdAt: evidence.createdAt,
        })),
        ...this.listDagEvidence(workItemId).map((evidence) => ({
          type: evidence.type,
          subject: evidence.subjectRevision,
          resource: evidence.resourceIdentity,
          passed: evidence.passed,
          stale:
            (evidence.subjectRevision !== null &&
              evidence.subjectRevision !==
                subjectForResource(
                  {
                    subject: work.currentSubjectRevision,
                    primaryResource: work.repositoryId ? "repo:" + work.repositoryId : null,
                    resourceSubjects: this.listDagResourceSubjects(workItemId),
                    facts: {},
                    evidence: [],
                    artifacts: [],
                    blockers: [],
                    cancelled: false,
                  },
                  evidence.resourceIdentity,
                )) ||
            !requirementSnapshot ||
            !requirementWorkflow ||
            evidence.requirementSemanticsDigest !==
              evidenceRequirementSemanticsDigest(
                requirementWorkflow.definition,
                requirementSnapshot.requirements,
                evidence.type,
                requirementSnapshot.policyObligations,
                requirementSnapshot.policyContextDigest,
              ),
          createdAt: evidence.createdAt,
        })),
      ],
      artifacts: this.listDagArtifacts(workItemId).map((artifact) => ({
        type: artifact.type,
        subject: artifact.subjectRevision,
        resource: artifact.resourceIdentity,
      })),
      blockers: work.status === "blocked" ? [work.blockedReason ?? "work.blocked"] : [],
      cancelled: work.status === "cancelled",
    };
  }

  getDagPlannerInput(workItemId: string): WorkDagPlannerInput {
    let work = this.getWorkInternal(workItemId);
    if (work.currentRequirementRevision === 0) {
      this.ensureRequirementSnapshot(workItemId);
      work = this.getWorkInternal(workItemId);
    }
    const snapshot = this.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
    const attempts = this.listAttempts(workItemId);
    const latestAttempt = attempts.at(-1) ?? null;
    const context = this.getDagContext(workItemId);
    const frozen: PlannerFrozenInput = {
      workRevision: work.stateRevision,
      dagRevision: work.currentDagRevision,
      requirementRevision: work.currentRequirementRevision,
      policyIdentity: snapshot.policyRef + ":" + snapshot.policyDigest + ":" + snapshot.policyContextDigest,
      deploymentIdentity: latestAttempt
        ? latestAttempt.deploymentId + "@" + latestAttempt.deploymentConfigVersion
        : null,
      subjectRevision: work.currentSubjectRevision,
      factsDigest: stableDigest({
        facts: context.facts,
        blockers: context.blockers,
        cancelled: context.cancelled,
        artifacts: this.listDagArtifacts(workItemId),
      }),
      evidenceDigest: stableDigest({
        legacy: this.listEvidence(workItemId).map((item) => ({
          id: item.evidenceId,
          type: item.type,
          status: item.status,
          subject: item.subjectRevision,
          stale: item.stale,
          source: item.source,
          artifact: item.artifactRef,
        })),
        dag: this.listDagEvidence(workItemId),
      }),
      executionDigest: stableDigest(
        this.listDagExecutions(workItemId).map((execution) => ({
          nodeExecutionId: execution.nodeExecutionId,
          nodeId: execution.nodeId,
          generation: execution.generation,
          state: execution.state,
          fence: execution.fence,
          externalRef: execution.externalRef,
          result: execution.result,
        })),
      ),
    };
    return {
      frozen,
      digest: plannerInputDigest(frozen),
      currentGraph: work.currentDagRevision > 0 ? this.getDagRevision(workItemId, work.currentDagRevision).graph : null,
      obligations: this.getEffectiveDagObligations(workItemId),
    };
  }

  submitDagProposal(
    input: {
      workItemId: string;
      principalId: string;
      scope: string;
      expectedWorkRevision: number;
      expectedDagRevision: number;
      expectedRequirementRevision: number;
      attemptId?: string | null;
      plannerIdentity: string;
      plannerVersion: string;
      plannerInputDigest: string;
      reasonCode: string;
      graph: DagGraph;
      policyContext?: WorkDagPolicyContext;
    },
    now = Date.now(),
  ): WorkDagProposalRecord {
    const plannerIdentity = requiredText(input.plannerIdentity, 200);
    const plannerVersion = requiredText(input.plannerVersion, 200);
    const reasonCode = requiredText(input.reasonCode, 200);
    if (!plannerIdentity || !plannerVersion || !reasonCode) throw new Error("INVALID_DAG_PROPOSAL");
    const proposalId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(input.workItemId, input.principalId, input.scope);
      const currentInput = this.getDagPlannerInput(input.workItemId);
      this.db
        .prepare(
          "INSERT INTO work_dag_proposals(proposal_id,work_item_id,parent_revision,expected_work_revision,expected_requirement_revision,attempt_id,planner_identity,planner_version,validator_version,planner_input_digest,reason_code,graph_json,status,decision_codes_json,accepted_revision,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'proposed','[]',NULL,?,NULL)",
        )
        .run(
          proposalId,
          input.workItemId,
          input.expectedDagRevision,
          input.expectedWorkRevision,
          input.expectedRequirementRevision,
          input.attemptId ?? null,
          plannerIdentity,
          plannerVersion,
          WORK_DAG_POLICY_VALIDATOR_VERSION,
          input.plannerInputDigest,
          reasonCode,
          JSON.stringify(input.graph),
          now,
        );

      const finish = (
        status: WorkDagProposalRecord["status"],
        codes: string[],
        acceptedRevision: number | null,
      ): WorkDagProposalRecord => {
        this.db
          .prepare(
            "UPDATE work_dag_proposals SET status=?,decision_codes_json=?,accepted_revision=?,decided_at=? WHERE proposal_id=?",
          )
          .run(status, JSON.stringify(codes), acceptedRevision, now, proposalId);
        const row = this.db.prepare("SELECT * FROM work_dag_proposals WHERE proposal_id=?").get(proposalId) as Row;
        this.db.exec("COMMIT");
        return this.fromDagProposalRow(row);
      };

      if (
        current.stateRevision !== input.expectedWorkRevision ||
        current.currentDagRevision !== input.expectedDagRevision ||
        current.currentRequirementRevision !== input.expectedRequirementRevision ||
        currentInput.digest !== input.plannerInputDigest
      ) {
        return finish("stale", ["PLAN_STALE_INPUT"], null);
      }

      const workflow = this.getWorkflow(current.workflowId, current.workflowVersion);
      const snapshot = this.getRequirementSnapshot(input.workItemId, current.currentRequirementRevision);
      const policyContext =
        input.policyContext ?? workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition);

      const dagContext = this.getDagContext(input.workItemId);
      const obligations = expandResourceEvidenceObligations(
        this.getEffectiveDagObligations(input.workItemId),
        input.graph,
        Object.keys(dagContext.resourceSubjects ?? {}),
      );
      const dagExecutions: DagExecution[] = this.listDagExecutions(input.workItemId).map((execution) => ({
        nodeId: execution.nodeId,
        generation: execution.generation,
        state: execution.state,
        fence: execution.fence,
        key: execution.idempotencyKey,
      }));
      const outstandingObligations = obligations.filter((obligation) => {
        const condition = evaluatePredicate(obligation.condition, dagContext, dagExecutions, obligation.resource);
        if (condition !== true) return false;
        return evaluatePredicate(obligation.satisfaction, dagContext, dagExecutions, obligation.resource) !== true;
      });
      const validationCodes: string[] = [];
      if (current.orchestrationEngine !== "dynamic-dag") validationCodes.push("PLAN_DYNAMIC_DAG_NOT_ENABLED");
      if (current.activeWorkAttemptId && !snapshot.policyContextDigest) {
        validationCodes.push("PLAN_POLICY_CONTEXT_DRIFT");
      } else if (snapshot.policyContextDigest && snapshot.policyContextDigest !== policyContext.digest) {
        validationCodes.push("PLAN_POLICY_CONTEXT_DRIFT");
      }
      validationCodes.push(
        ...validateDagProposal(input.graph, workflow.definition, outstandingObligations, {
          outstandingOnly: true,
          policyContext,
          reasonCode,
        }).codes,
      );
      const subjectBoundKinds = new Set(["verification", "review", "publication", "approval", "change_request"]);
      for (const node of input.graph.nodes) {
        if (
          (node.subject !== null && node.subject !== subjectForResource(dagContext, node.resource)) ||
          (subjectBoundKinds.has(node.kind) &&
            subjectForResource(dagContext, node.resource) !== null &&
            node.subject !== subjectForResource(dagContext, node.resource))
        ) {
          validationCodes.push("PLAN_INVALID_SUBJECT_BINDING");
        }
      }

      const previous =
        current.currentDagRevision > 0 ? this.getDagRevision(input.workItemId, current.currentDagRevision) : null;
      const previousNodes = new Map(previous?.graph.nodes.map((node) => [node.id, node]) ?? []);
      const proposedNodes = new Map(input.graph.nodes.map((node) => [node.id, node]));
      const executions = this.listDagExecutions(input.workItemId);
      const latestExecution = new Map<string, WorkDagNodeExecutionRecord>();
      for (const execution of executions) {
        const old = latestExecution.get(execution.nodeId);
        if (!old || old.generation < execution.generation) latestExecution.set(execution.nodeId, execution);
      }

      for (const [id, node] of proposedNodes) {
        const previousNode = previousNodes.get(id);
        if (previousNode && stableDigest(previousNode) !== stableDigest(node)) {
          validationCodes.push("PLAN_LOGICAL_NODE_REDEFINED");
        } else if (!previousNode && executions.some((execution) => execution.nodeId === id)) {
          validationCodes.push("PLAN_LOGICAL_NODE_REUSED");
        }
      }
      for (const [id, previousNode] of previousNodes) {
        if (proposedNodes.has(id)) continue;
        const execution = latestExecution.get(id);
        const wait =
          execution?.state === "running" && previousNode.kind === "wait"
            ? this.getDagWaitByExecution(execution.nodeExecutionId)
            : null;
        const cancellableRunningWait =
          previousNode.kind === "wait" && execution?.state === "running" && wait?.state === "waiting";
        if (
          execution &&
          (execution.state === "claimed" ||
            execution.state === "external_outcome_unknown" ||
            (execution.state === "running" && !cancellableRunningWait))
        ) {
          validationCodes.push("PLAN_RUNNING_NODE_SUPERSESSION");
        }
      }
      const uniqueCodes = [...new Set(validationCodes)];
      if (uniqueCodes.length > 0) return finish("rejected", uniqueCodes, null);

      const semanticDigest = graphSemanticDigest(input.graph);
      const policyRevision = snapshot.policyRef + ":" + snapshot.policyDigest + ":" + snapshot.policyContextDigest;
      if (previous?.semanticDigest === semanticDigest && previous.policyRevision === policyRevision) {
        return finish("noop", [], null);
      }

      const nextRevision = current.currentDagRevision + 1;
      this.db
        .prepare(
          "INSERT INTO work_dag_revisions(work_item_id,revision,parent_revision,attempt_id,planner_identity,planner_version,validator_version,policy_revision,requirement_revision,reason_code,planner_input_digest,graph_json,semantic_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.workItemId,
          nextRevision,
          current.currentDagRevision > 0 ? current.currentDagRevision : null,
          input.attemptId ?? current.activeWorkAttemptId,
          plannerIdentity,
          plannerVersion,
          WORK_DAG_POLICY_VALIDATOR_VERSION,
          policyRevision,
          current.currentRequirementRevision,
          reasonCode,
          input.plannerInputDigest,
          JSON.stringify(input.graph),
          semanticDigest,
          now,
        );

      const newNodes = input.graph.nodes.filter((node) => !previousNodes.has(node.id));
      const supersededBy = newNodes.length === 1 ? newNodes[0]!.id : null;
      for (const [id] of previousNodes) {
        if (proposedNodes.has(id)) continue;
        const execution = latestExecution.get(id);
        this.db
          .prepare(
            "INSERT INTO work_dag_supersessions(work_item_id,node_id,dag_revision,superseded_by_node_id,reason_code,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(input.workItemId, id, nextRevision, supersededBy, reasonCode, now);
        if (execution?.state === "pending") {
          this.db
            .prepare(
              "UPDATE work_dag_executions SET state='superseded',finished_at=?,superseded_by_node_id=?,superseded_dag_revision=?,updated_at=? WHERE node_execution_id=? AND state='pending'",
            )
            .run(now, supersededBy, nextRevision, now, execution.nodeExecutionId);
        }
        if (execution?.state === "running" && previousNodes.get(id)?.kind === "wait") {
          const wait = this.getDagWaitByExecution(execution.nodeExecutionId);
          if (wait?.state === "waiting") {
            const changedExecution = this.db
              .prepare(
                "UPDATE work_dag_executions SET state='superseded',fence=fence+1,claim_owner=NULL,claim_lease_until=NULL,finished_at=?,superseded_by_node_id=?,superseded_dag_revision=?,updated_at=? WHERE node_execution_id=? AND state='running'",
              )
              .run(now, supersededBy, nextRevision, now, execution.nodeExecutionId);
            if (changedExecution.changes !== 1) throw new Error("STALE_DAG_INSTALL");
            this.db
              .prepare("UPDATE work_dag_waits SET state='cancelled',updated_at=? WHERE wait_id=? AND state='waiting'")
              .run(now, wait.waitId);
          }
        }
      }

      for (const node of newNodes) {
        const generation = 1;
        const idempotencyKey = executionKey(input.workItemId, node, generation);
        this.db
          .prepare(
            "INSERT INTO work_dag_executions(node_execution_id,work_item_id,node_id,created_dag_revision,generation,state,fence,idempotency_key,subject_revision,resource_identity,claim_owner,claim_lease_until,started_at,finished_at,result_json,result_digest,superseded_by_node_id,superseded_dag_revision,created_at,updated_at) VALUES(?,?,?,?,?,'pending',0,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?)",
          )
          .run(
            randomUUID(),
            input.workItemId,
            node.id,
            nextRevision,
            generation,
            idempotencyKey,
            node.subject,
            node.resource,
            now,
            now,
          );
      }

      const changed = this.db
        .prepare(
          "UPDATE work_items SET current_dag_revision=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=? AND current_dag_revision=? AND current_requirement_revision=?",
        )
        .run(
          nextRevision,
          now,
          input.workItemId,
          input.principalId,
          input.scope,
          input.expectedWorkRevision,
          input.expectedDagRevision,
          input.expectedRequirementRevision,
        );
      if (changed.changes !== 1) throw new Error("STALE_DAG_INSTALL");

      this.db
        .prepare(
          "UPDATE work_dag_proposals SET status='accepted',decision_codes_json='[]',accepted_revision=?,decided_at=? WHERE proposal_id=?",
        )
        .run(nextRevision, now, proposalId);
      this.recordDagDecisionInternal(
        input.workItemId,
        input.expectedWorkRevision + 1,
        nextRevision,
        input.expectedRequirementRevision,
        current.currentSubjectRevision,
        "plan.accepted",
        null,
        reasonCode,
        obligations.map((item) => item.id),
        snapshot.policyRef,
        null,
        "proposal:" + proposalId,
        now,
      );
      this.event(
        input.workItemId,
        input.attemptId ?? current.activeWorkAttemptId,
        "dag.revision_accepted",
        JSON.stringify({ revision: nextRevision, parentRevision: current.currentDagRevision, reasonCode, proposalId }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_dag_proposals WHERE proposal_id=?").get(proposalId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagProposalRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimDagNode(
    workItemId: string,
    principalId: string,
    scope: string,
    nodeId: string,
    ownerId: string,
    expectedWorkRevision: number,
    expectedDagRevision: number,
    now = Date.now(),
    leaseMs = 30_000,
  ): WorkDagNodeExecutionRecord {
    const owner = requiredText(ownerId, 200);
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_DAG_CLAIM");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedWorkRevision || work.currentDagRevision !== expectedDagRevision) {
        throw new Error("STALE_DAG_CLAIM");
      }
      if (TERMINAL_WORK_STATUSES.has(work.status) || work.status === "blocked") throw new Error("DAG_NODE_NOT_READY");
      const revision = this.getDagRevision(workItemId, expectedDagRevision);
      if (revision.requirementSnapshotRevision !== work.currentRequirementRevision) {
        const revalidated = this.db
          .prepare(
            "SELECT 1 FROM work_dag_proposals WHERE work_item_id=? AND parent_revision=? AND expected_requirement_revision=? AND reason_code='user_update' AND status='noop' LIMIT 1",
          )
          .get(workItemId, expectedDagRevision, work.currentRequirementRevision);
        if (!revalidated) throw new Error("STALE_DAG_CLAIM");
      }
      const node = revision.graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error("DAG_NODE_NOT_FOUND");
      const executions = this.listDagExecutions(workItemId);
      const dagExecutions: DagExecution[] = executions.map((execution) => ({
        nodeId: execution.nodeId,
        generation: execution.generation,
        state: execution.state,
        fence: execution.fence,
        key: execution.idempotencyKey,
      }));
      const ready = readyNodes(revision.graph, dagExecutions, this.getDagContext(workItemId));
      if (!ready.some((candidate) => candidate.id === nodeId)) {
        const currentExecution = executions
          .filter((execution) => execution.nodeId === nodeId)
          .sort((a, b) => b.generation - a.generation)[0];
        if (currentExecution && currentExecution.state !== "pending") throw new Error("DAG_NODE_NOT_PENDING");
        throw new Error("DAG_NODE_NOT_READY");
      }
      const execution = executions
        .filter((candidate) => candidate.nodeId === nodeId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (!execution || execution.state !== "pending") throw new Error("DAG_NODE_NOT_PENDING");
      const nextFence = execution.fence + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET state='claimed',fence=?,claim_owner=?,claim_lease_until=?,bound_requirement_revision=?,updated_at=? WHERE node_execution_id=? AND state='pending' AND fence=?",
        )
        .run(
          nextFence,
          owner,
          now + leaseMs,
          work.currentRequirementRevision,
          now,
          execution.nodeExecutionId,
          execution.fence,
        );
      if (changed.changes !== 1) throw new Error("DAG_NODE_NOT_PENDING");
      const snapshot = this.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
      this.recordDagDecisionInternal(
        workItemId,
        work.stateRevision,
        work.currentDagRevision,
        work.currentRequirementRevision,
        work.currentSubjectRevision,
        "node.claimed",
        nodeId,
        "ready",
        this.getEffectiveDagObligations(workItemId).map((item) => item.id),
        snapshot.policyRef,
        execution.idempotencyKey,
        null,
        now,
      );
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(execution.nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimDagExecutionForStartRecovery(
    nodeExecutionId: string,
    ownerId: string,
    now = Date.now(),
    leaseMs = 30_000,
  ): WorkDagNodeExecutionRecord | null {
    const owner = requiredText(ownerId, 200);
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_DAG_CLAIM");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row | undefined;
      if (!row) throw new Error("DAG_EXECUTION_NOT_FOUND");
      const current = this.fromDagExecutionRow(row);
      if (current.state !== "claimed") {
        this.db.exec("COMMIT");
        return null;
      }
      if (current.claimOwner !== owner && current.claimLeaseUntil !== null && current.claimLeaseUntil > now) {
        this.db.exec("COMMIT");
        return null;
      }
      const nextFence = current.claimOwner === owner ? current.fence : current.fence + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET claim_owner=?,claim_lease_until=?,fence=?,updated_at=? WHERE node_execution_id=? AND state='claimed' AND fence=? AND (claim_owner=? OR claim_lease_until IS NULL OR claim_lease_until<=?)",
        )
        .run(owner, now + leaseMs, nextFence, now, nodeExecutionId, current.fence, owner, now);
      if (changed.changes !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      const updated = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  startDagNodeExecution(
    nodeExecutionId: string,
    ownerId: string,
    fence: number,
    now = Date.now(),
  ): WorkDagNodeExecutionRecord {
    const owner = requiredText(ownerId, 200);
    if (!owner) throw new Error("INVALID_DAG_CLAIM");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row | undefined;
      if (!row) throw new Error("DAG_EXECUTION_NOT_FOUND");
      const execution = this.fromDagExecutionRow(row);
      if (execution.state === "running" && execution.claimOwner === owner && execution.fence === fence) {
        this.db.exec("COMMIT");
        return execution;
      }
      if (
        execution.state !== "claimed" ||
        execution.claimOwner !== owner ||
        execution.fence !== fence ||
        execution.claimLeaseUntil === null ||
        execution.claimLeaseUntil <= now
      ) {
        throw new Error("STALE_DAG_EXECUTION_CLAIM");
      }
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET state='running',started_at=COALESCE(started_at,?),updated_at=? WHERE node_execution_id=? AND state='claimed' AND claim_owner=? AND fence=?",
        )
        .run(now, now, nodeExecutionId, owner, fence);
      if (changed.changes !== 1) throw new Error("STALE_DAG_EXECUTION_CLAIM");
      const updated = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setDagExecutionExternalRef(
    nodeExecutionId: string,
    ownerId: string,
    fence: number,
    externalRef: string,
    now = Date.now(),
  ): WorkDagNodeExecutionRecord {
    const owner = requiredText(ownerId, 200);
    const ref = requiredText(externalRef, 2_000);
    if (!owner || !ref) throw new Error("INVALID_DAG_EXTERNAL_REF");
    const changed = this.db
      .prepare(
        "UPDATE work_dag_executions SET external_ref=?,updated_at=? WHERE node_execution_id=? AND state IN ('claimed','running') AND claim_owner=? AND fence=? AND (external_ref IS NULL OR external_ref=?)",
      )
      .run(ref, now, nodeExecutionId, owner, fence, ref);
    if (changed.changes !== 1) throw new Error("STALE_DAG_EXECUTION_CLAIM");
    const row = this.db
      .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
      .get(nodeExecutionId) as Row;
    return this.fromDagExecutionRow(row);
  }

  claimDagExecutionForReconciliation(
    nodeExecutionId: string,
    ownerId: string,
    now = Date.now(),
    leaseMs = 30_000,
  ): WorkDagNodeExecutionRecord | null {
    const owner = requiredText(ownerId, 200);
    if (!owner || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_DAG_CLAIM");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row | undefined;
      if (!row) throw new Error("DAG_EXECUTION_NOT_FOUND");
      const current = this.fromDagExecutionRow(row);
      if (current.state !== "running" || current.externalRef === null) {
        this.db.exec("COMMIT");
        return null;
      }
      if (current.claimOwner !== owner && current.claimLeaseUntil !== null && current.claimLeaseUntil > now) {
        this.db.exec("COMMIT");
        return null;
      }
      const nextFence = current.claimOwner === owner ? current.fence : current.fence + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET claim_owner=?,claim_lease_until=?,fence=?,updated_at=? WHERE node_execution_id=? AND state='running' AND external_ref IS NOT NULL AND fence=? AND (claim_owner=? OR claim_lease_until IS NULL OR claim_lease_until<=?)",
        )
        .run(owner, now + leaseMs, nextFence, now, nodeExecutionId, current.fence, owner, now);
      if (changed.changes !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      const updated = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markDagExecutionOutcomeUnknown(
    nodeExecutionId: string,
    externalRef: string,
    reason: string,
    now = Date.now(),
  ): WorkDagNodeExecutionRecord {
    const ref = requiredText(externalRef, 2_000);
    const summary = requiredText(reason, 2_000);
    if (!ref || !summary) throw new Error("INVALID_DAG_RESULT");
    const result: DagNodeResult = {
      status: "external_outcome_unknown",
      summary,
      externalRef: ref,
    };
    const digest = resultDigest(result);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row | undefined;
      if (!row) throw new Error("DAG_EXECUTION_NOT_FOUND");
      const execution = this.fromDagExecutionRow(row);
      if (execution.state === "external_outcome_unknown") {
        if (String(row.result_digest ?? "") !== digest) throw new Error("DAG_RESULT_CONFLICT");
        this.db.exec("COMMIT");
        return execution;
      }
      if (execution.state !== "running" && execution.state !== "claimed") {
        throw new Error("DAG_EXECUTION_NOT_RUNNING");
      }

      const nextFence = execution.fence + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET state='external_outcome_unknown',fence=?,claim_owner=NULL,claim_lease_until=NULL,finished_at=?,result_json=?,result_digest=?,external_ref=?,updated_at=? WHERE node_execution_id=? AND state IN ('claimed','running') AND fence=?",
        )
        .run(nextFence, now, JSON.stringify(result), digest, ref, now, nodeExecutionId, execution.fence);
      if (changed.changes !== 1) throw new Error("STALE_DAG_EXECUTION_CLAIM");

      const work = this.getWorkInternal(execution.workItemId);
      const workChanged = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, execution.workItemId, work.stateRevision);
      if (workChanged.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const executionDagRevision = this.getDagRevision(execution.workItemId, execution.createdDagRevision);
      const executionRequirementRevision =
        execution.boundRequirementRevision ?? executionDagRevision.requirementSnapshotRevision;
      const snapshot = this.getRequirementSnapshot(execution.workItemId, executionRequirementRevision);
      this.recordDagDecisionInternal(
        execution.workItemId,
        work.stateRevision + 1,
        execution.createdDagRevision,
        executionRequirementRevision,
        work.currentSubjectRevision,
        "node.outcome_unknown",
        execution.nodeId,
        "external_outcome_unknown",
        this.getDagObligationsForRequirementRevision(execution.workItemId, executionRequirementRevision).map(
          (item) => item.id,
        ),
        snapshot.policyRef,
        execution.idempotencyKey,
        digest,
        now,
      );
      this.event(
        execution.workItemId,
        work.activeWorkAttemptId,
        "dag.node_outcome_unknown",
        JSON.stringify({
          nodeId: execution.nodeId,
          nodeExecutionId,
          externalRef: ref,
          digest,
        }),
        now,
      );
      const updated = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private recordDagLateResultInternal(
    execution: WorkDagNodeExecutionRecord,
    ownerId: string,
    fence: number,
    result: DagNodeResult,
    digest: string,
    disposition: WorkDagLateResultRecord["disposition"],
    now: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO work_dag_late_results(work_item_id,node_execution_id,node_id,owner_id,fence,current_state,current_fence,disposition,result_json,result_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        execution.workItemId,
        execution.nodeExecutionId,
        execution.nodeId,
        ownerId,
        fence,
        execution.state,
        execution.fence,
        disposition,
        JSON.stringify(result),
        digest,
        now,
      );
  }

  reconcileDagNodeResult(
    nodeExecutionId: string,
    ownerId: string,
    fence: number,
    result: DagNodeResult,
    now = Date.now(),
  ): WorkDagNodeExecutionRecord {
    const owner = requiredText(ownerId, 200);
    if (!owner || !["succeeded", "failed", "external_outcome_unknown"].includes(result.status)) {
      throw new Error("INVALID_DAG_RESULT");
    }
    const facts = result.facts ?? [];
    const artifacts = result.artifacts ?? [];
    const evidence = result.evidence ?? [];
    if (facts.length > 100 || artifacts.length > 100 || evidence.length > 100) throw new Error("INVALID_DAG_RESULT");
    const factKeys = new Set<string>();
    for (const fact of facts) {
      if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(fact.key) || factKeys.has(fact.key)) {
        throw new Error("INVALID_DAG_RESULT");
      }
      factKeys.add(fact.key);
    }
    const artifactIds = new Set<string>();
    for (const artifact of artifacts) {
      if (!artifact.artifactId || !artifact.type || !artifact.ref || artifactIds.has(artifact.artifactId)) {
        throw new Error("INVALID_DAG_RESULT");
      }
      artifactIds.add(artifact.artifactId);
    }
    const evidenceIds = new Set<string>();
    for (const item of evidence) {
      const id = item.evidenceId?.trim() || "";
      if (
        !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(item.type) ||
        !item.verifierIdentity?.trim() ||
        (id && evidenceIds.has(id))
      ) {
        throw new Error("INVALID_DAG_RESULT");
      }
      if (id) evidenceIds.add(id);
    }
    const digest = resultDigest(result);
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row | undefined;
      if (!row) throw new Error("DAG_EXECUTION_NOT_FOUND");
      const execution = this.fromDagExecutionRow(row);
      if (["succeeded", "failed", "external_outcome_unknown"].includes(execution.state)) {
        if (String(row.result_digest ?? "") === digest) {
          this.db.exec("COMMIT");
          committed = true;
          return execution;
        }
        this.recordDagLateResultInternal(execution, owner, fence, result, digest, "rejected_terminal_conflict", now);
        this.db.exec("COMMIT");
        committed = true;
        throw new Error("DAG_RESULT_CONFLICT");
      }
      if (
        (execution.state !== "claimed" && execution.state !== "running") ||
        execution.claimOwner !== owner ||
        execution.fence !== fence
      ) {
        this.recordDagLateResultInternal(execution, owner, fence, result, digest, "rejected_stale_claim", now);
        this.db.exec("COMMIT");
        committed = true;
        throw new Error("STALE_DAG_EXECUTION_CLAIM");
      }
      const claimDagRevision = this.getDagRevision(execution.workItemId, execution.createdDagRevision);
      const claimNode = claimDagRevision.graph.nodes.find((node) => node.id === execution.nodeId);
      if (!claimNode) throw new Error("DAG_NODE_NOT_FOUND");
      const assertOutputBinding = (resourceIdentity: string | null | undefined, subjectRevision: string | null) => {
        const outputResource = resourceIdentity ?? execution.resourceIdentity;
        if (outputResource !== execution.resourceIdentity) throw new Error("DAG_RESULT_RESOURCE_MISMATCH");
        const subjectPreserving = claimNode.kind === "verification" || claimNode.kind === "review";
        if (subjectPreserving && execution.subjectRevision !== null && subjectRevision !== execution.subjectRevision) {
          throw new Error("DAG_RESULT_SUBJECT_MISMATCH");
        }
      };
      for (const artifact of artifacts) assertOutputBinding(artifact.resourceIdentity, artifact.subjectRevision);
      for (const item of evidence) assertOutputBinding(item.resourceIdentity, item.subjectRevision);
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET state=?,finished_at=?,result_json=?,result_digest=?,updated_at=? WHERE node_execution_id=? AND state IN ('claimed','running') AND claim_owner=? AND fence=?",
        )
        .run(result.status, now, JSON.stringify(result), digest, now, nodeExecutionId, owner, fence);
      if (changed.changes !== 1) {
        const latest = this.fromDagExecutionRow(
          this.db.prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?").get(nodeExecutionId) as Row,
        );
        this.recordDagLateResultInternal(latest, owner, fence, result, digest, "rejected_cas_race", now);
        this.db.exec("COMMIT");
        committed = true;
        throw new Error("STALE_DAG_EXECUTION_CLAIM");
      }

      for (const fact of facts) {
        this.db
          .prepare(
            "INSERT INTO work_dag_facts(fact_id,work_item_id,fact_key,value_json,subject_revision,resource_identity,source_execution_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            execution.workItemId,
            fact.key,
            JSON.stringify(fact.value),
            execution.subjectRevision,
            execution.resourceIdentity,
            nodeExecutionId,
            now,
          );
      }
      for (const artifact of artifacts) {
        this.db
          .prepare(
            "INSERT INTO work_dag_artifacts(artifact_id,work_item_id,artifact_type,artifact_ref,subject_revision,resource_identity,source_execution_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            artifact.artifactId,
            execution.workItemId,
            artifact.type,
            artifact.ref,
            artifact.subjectRevision,
            artifact.resourceIdentity ?? execution.resourceIdentity,
            nodeExecutionId,
            now,
          );
      }
      const work = this.getWorkInternal(execution.workItemId);
      const executionDagRevision = this.getDagRevision(execution.workItemId, execution.createdDagRevision);
      const executionRequirementRevision =
        execution.boundRequirementRevision ?? executionDagRevision.requirementSnapshotRevision;
      const requirementSnapshot = this.getRequirementSnapshot(execution.workItemId, executionRequirementRevision);
      const requirementWorkflow = this.getWorkflow(work.workflowId, work.workflowVersion);
      for (const item of evidence) {
        this.db
          .prepare(
            "INSERT INTO work_dag_evidence(evidence_id,work_item_id,evidence_type,passed,subject_revision,resource_identity,verifier_identity,artifact_ref,source_execution_id,requirement_semantics_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            item.evidenceId?.trim() || randomUUID(),
            execution.workItemId,
            item.type,
            item.passed ? 1 : 0,
            item.subjectRevision,
            item.resourceIdentity ?? execution.resourceIdentity,
            item.verifierIdentity.trim(),
            item.artifactRef?.trim() || null,
            nodeExecutionId,
            evidenceRequirementSemanticsDigest(
              requirementWorkflow.definition,
              requirementSnapshot.requirements,
              item.type,
              requirementSnapshot.policyObligations,
              requirementSnapshot.policyContextDigest,
            ),
            now,
          );
      }

      const workChanged = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, execution.workItemId, work.stateRevision);
      if (workChanged.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const snapshot = requirementSnapshot;
      this.recordDagDecisionInternal(
        execution.workItemId,
        work.stateRevision + 1,
        execution.createdDagRevision,
        executionRequirementRevision,
        work.currentSubjectRevision,
        "node.result",
        execution.nodeId,
        result.status,
        this.getDagObligationsForRequirementRevision(execution.workItemId, executionRequirementRevision).map(
          (item) => item.id,
        ),
        snapshot.policyRef,
        execution.idempotencyKey,
        digest,
        now,
      );
      this.event(
        execution.workItemId,
        null,
        "dag.node_result",
        JSON.stringify({ nodeId: execution.nodeId, nodeExecutionId, status: result.status, digest }),
        now,
      );
      const updated = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      committed = true;
      return this.fromDagExecutionRow(updated);
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resolveUnknownDagExecution(
    nodeExecutionId: string,
    state: "succeeded" | "failed",
    reason: string,
    now = Date.now(),
    expectedWorkRevision?: number,
  ): WorkDagNodeExecutionRecord {
    const normalizedReason = requiredText(reason, 2_000);
    if (!normalizedReason) throw new Error("INVALID_DAG_RESULT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row | undefined;
      if (!row) throw new Error("DAG_EXECUTION_NOT_FOUND");
      const execution = this.fromDagExecutionRow(row);
      if (execution.state !== "external_outcome_unknown") throw new Error("DAG_EXECUTION_NOT_UNKNOWN");
      const work = this.getWorkInternal(execution.workItemId);
      if (expectedWorkRevision !== undefined && work.stateRevision !== expectedWorkRevision) {
        throw new Error("STALE_WORK_REVISION");
      }
      const previous = execution.result;
      const resolved: DagNodeResult = {
        status: state,
        summary: normalizedReason,
        ...(previous?.externalRef ? { externalRef: previous.externalRef } : {}),
      };
      const digest = resultDigest(resolved);
      const changed = this.db
        .prepare(
          "UPDATE work_dag_executions SET state=?,result_json=?,result_digest=?,finished_at=?,updated_at=? WHERE node_execution_id=? AND state='external_outcome_unknown'",
        )
        .run(state, JSON.stringify(resolved), digest, now, now, nodeExecutionId);
      if (changed.changes !== 1) throw new Error("DAG_EXECUTION_NOT_UNKNOWN");
      const workChanged = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, execution.workItemId, work.stateRevision);
      if (workChanged.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const snapshot = this.getRequirementSnapshot(execution.workItemId, work.currentRequirementRevision);
      this.recordDagDecisionInternal(
        execution.workItemId,
        work.stateRevision + 1,
        work.currentDagRevision,
        work.currentRequirementRevision,
        work.currentSubjectRevision,
        "node.unknown_resolved",
        execution.nodeId,
        state,
        this.getEffectiveDagObligations(execution.workItemId).map((item) => item.id),
        snapshot.policyRef,
        execution.idempotencyKey,
        digest,
        now,
      );
      const updated = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordDagPlannerFailure(
    workItemId: string,
    plannerIdentity: string,
    plannerVersion: string,
    reasonCode: string,
    inputDigest: string,
    errorCode: string,
    now = Date.now(),
  ): void {
    const identity = requiredText(plannerIdentity, 200);
    const version = requiredText(plannerVersion, 200);
    const reason = requiredText(reasonCode, 200);
    const error = requiredText(errorCode, 100);
    if (!identity || !version || !reason || !error) throw new Error("INVALID_PLANNER_FAILURE");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWorkInternal(workItemId);
      if (work.currentRequirementRevision === 0) throw new Error("REQUIREMENT_SNAPSHOT_NOT_FOUND");
      const snapshot = this.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
      const factId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_dag_facts(fact_id,work_item_id,fact_key,value_json,subject_revision,resource_identity,source_execution_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          factId,
          workItemId,
          "planner.failure",
          JSON.stringify({
            plannerIdentity: identity,
            plannerVersion: version,
            reasonCode: reason,
            errorCode: error,
            inputDigest,
          }),
          null,
          null,
          "planner:" + factId,
          now,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, workItemId, work.stateRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      this.recordDagDecisionInternal(
        workItemId,
        work.stateRevision + 1,
        work.currentDagRevision,
        work.currentRequirementRevision,
        work.currentSubjectRevision,
        "planner.failed",
        null,
        error,
        this.getEffectiveDagObligations(workItemId).map((item) => item.id),
        snapshot.policyRef,
        null,
        inputDigest,
        now,
      );
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "dag.planner_failed",
        JSON.stringify({ plannerIdentity: identity, plannerVersion: version, reasonCode: reason, errorCode: error }),
        now,
      );
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  getDagWaitByExecution(nodeExecutionId: string): WorkDagWaitRecord | null {
    const row = this.db.prepare("SELECT * FROM work_dag_waits WHERE node_execution_id=?").get(nodeExecutionId) as
      Row | undefined;
    return row ? this.fromDagWaitRow(row) : null;
  }

  listDagWaits(workItemId: string): WorkDagWaitRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_dag_waits WHERE work_item_id=? ORDER BY created_at,wait_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromDagWaitRow(row));
  }

  ensureDagWait(
    nodeExecutionId: string,
    capability: string,
    correlationKey: string,
    expiresAt: number | null,
    now = Date.now(),
  ): WorkDagWaitRecord {
    const cap = requiredText(capability, 200);
    const correlation = requiredText(correlationKey, 500);
    if (!cap || !correlation || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))) {
      throw new Error("INVALID_DAG_WAIT");
    }
    const executionRow = this.db
      .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
      .get(nodeExecutionId) as Row | undefined;
    if (!executionRow) throw new Error("DAG_EXECUTION_NOT_FOUND");
    const execution = this.fromDagExecutionRow(executionRow);
    if (execution.state !== "running") throw new Error("DAG_WAIT_EXECUTION_NOT_RUNNING");
    const existing = this.getDagWaitByExecution(nodeExecutionId);
    if (existing) {
      if (existing.capability !== cap || existing.correlationKey !== correlation || existing.expiresAt !== expiresAt) {
        throw new Error("DAG_WAIT_IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }
    const waitId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO work_dag_waits(wait_id,work_item_id,node_execution_id,correlation_key,capability,state,expires_at,signal_event_id,signal_digest,signal_payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'waiting',?,NULL,NULL,NULL,?,?)",
      )
      .run(waitId, execution.workItemId, nodeExecutionId, correlation, cap, expiresAt, now, now);
    const row = this.db.prepare("SELECT * FROM work_dag_waits WHERE wait_id=?").get(waitId) as Row;
    return this.fromDagWaitRow(row);
  }

  signalDagWait(correlationKey: string, payload: unknown, eventId: string, now = Date.now()): WorkDagWaitRecord {
    const correlation = requiredText(correlationKey, 500);
    const event = requiredText(eventId, 300);
    if (!correlation || !event) throw new Error("INVALID_DAG_WAIT_SIGNAL");
    const payloadJson = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(payloadJson, "utf8") > 64 * 1024) throw new Error("INVALID_DAG_WAIT_SIGNAL");
    const digest = stableDigest(payload ?? null);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.db
        .prepare("SELECT correlation_key,payload_digest FROM work_dag_wait_events WHERE event_id=?")
        .get(event) as { correlation_key?: string; payload_digest?: string } | undefined;
      const row = this.db
        .prepare(
          "SELECT * FROM work_dag_waits WHERE correlation_key=? ORDER BY CASE state WHEN 'waiting' THEN 0 ELSE 1 END,created_at DESC LIMIT 1",
        )
        .get(correlation) as Row | undefined;
      if (!row) throw new Error("DAG_WAIT_NOT_FOUND");
      if (replay) {
        if (replay.correlation_key !== correlation || replay.payload_digest !== digest)
          throw new Error("DAG_WAIT_SIGNAL_CONFLICT");
        this.db.exec("COMMIT");
        return this.fromDagWaitRow(row);
      }
      const wait = this.fromDagWaitRow(row);
      const executionRow = this.db
        .prepare("SELECT state FROM work_dag_executions WHERE node_execution_id=?")
        .get(wait.nodeExecutionId) as { state?: string } | undefined;
      const work = this.getWorkInternal(wait.workItemId);
      const canSignal =
        wait.state === "waiting" && executionRow?.state === "running" && !TERMINAL_WORK_STATUSES.has(work.status);
      this.db
        .prepare(
          "INSERT INTO work_dag_wait_events(event_id,correlation_key,payload_digest,payload_json,disposition,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(event, correlation, digest, payloadJson, canSignal ? "accepted" : "late_ignored", now);
      if (canSignal) {
        this.db
          .prepare(
            "UPDATE work_dag_waits SET state='signaled',signal_event_id=?,signal_digest=?,signal_payload_json=?,updated_at=? WHERE wait_id=? AND state='waiting'",
          )
          .run(event, digest, payloadJson, now, wait.waitId);
      }
      const updated = this.db.prepare("SELECT * FROM work_dag_waits WHERE wait_id=?").get(wait.waitId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagWaitRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  expireDagWait(waitId: string, now = Date.now()): WorkDagWaitRecord {
    const row = this.db.prepare("SELECT * FROM work_dag_waits WHERE wait_id=?").get(waitId) as Row | undefined;
    if (!row) throw new Error("DAG_WAIT_NOT_FOUND");
    const wait = this.fromDagWaitRow(row);
    if (wait.state === "waiting" && wait.expiresAt !== null && wait.expiresAt <= now) {
      this.db
        .prepare("UPDATE work_dag_waits SET state='expired',updated_at=? WHERE wait_id=? AND state='waiting'")
        .run(now, waitId);
    }
    const updated = this.db.prepare("SELECT * FROM work_dag_waits WHERE wait_id=?").get(waitId) as Row;
    return this.fromDagWaitRow(updated);
  }

  cancelDagWaits(workItemId: string, now = Date.now()): number {
    const result = this.db
      .prepare("UPDATE work_dag_waits SET state='cancelled',updated_at=? WHERE work_item_id=? AND state='waiting'")
      .run(now, workItemId);
    return Number(result.changes);
  }

  evaluateDagCompletion(workItemId: string): {
    ready: boolean;
    deadlocked: boolean;
    missing: string[];
    readyNodeIds: string[];
    runningNodeIds: string[];
    waitingNodeIds: string[];
  } {
    const work = this.getWorkInternal(workItemId);
    let obligations = this.getEffectiveDagObligations(workItemId);
    if (work.currentDagRevision < 1) {
      const missing = [
        ...(work.status === "cancelled" ? ["WORK_CANCELLED"] : []),
        ...obligations.map((item) => item.id),
      ];
      return {
        ready: false,
        deadlocked: work.status !== "cancelled" && missing.length > 0,
        missing,
        readyNodeIds: [],
        runningNodeIds: [],
        waitingNodeIds: [],
      };
    }

    const revision = this.getDagRevision(workItemId, work.currentDagRevision);
    const nodeIds = new Set(revision.graph.nodes.map((node) => node.id));
    const context = this.getDagContext(workItemId);
    obligations = expandResourceEvidenceObligations(
      obligations,
      revision.graph,
      Object.keys(context.resourceSubjects ?? {}),
    );
    const latestByNode = new Map<string, WorkDagNodeExecutionRecord>();
    for (const execution of this.listDagExecutions(workItemId)) {
      if (!nodeIds.has(execution.nodeId)) continue;
      const old = latestByNode.get(execution.nodeId);
      if (!old || old.generation < execution.generation) latestByNode.set(execution.nodeId, execution);
    }
    const executions: DagExecution[] = [...latestByNode.values()].map((execution) => ({
      nodeId: execution.nodeId,
      generation: execution.generation,
      state: execution.state,
      fence: execution.fence,
      key: execution.idempotencyKey,
    }));
    const core = completion(obligations, executions, context);
    const missing = [...core.missing];
    const activeAttempt = this.getActiveAttempt(workItemId);
    if (activeAttempt) missing.push("ACTIVE_WORK_ATTEMPT:" + activeAttempt.workAttemptId);

    const ready = readyNodes(revision.graph, executions, context).map((node) => node.id);
    const running = [...latestByNode.values()]
      .filter((execution) => execution.state === "claimed" || execution.state === "running")
      .map((execution) => execution.nodeId);
    const waiting = revision.graph.nodes
      .filter((node) => {
        if (node.kind !== "wait") return false;
        const state = latestByNode.get(node.id)?.state;
        return state === "pending" || state === "claimed" || state === "running";
      })
      .map((node) => node.id);
    const outstanding = missing.filter((item) => item !== "WORK_CANCELLED" && !item.startsWith("ACTIVE_WORK_ATTEMPT:"));
    const deadlocked =
      work.status !== "cancelled" &&
      detectPlanDeadlock({
        outstandingObligations: outstanding,
        ready,
        running,
        waiting,
      });
    if (deadlocked && !missing.includes("PLAN_DEADLOCK")) missing.push("PLAN_DEADLOCK");
    return {
      ready: core.ready && !activeAttempt && !deadlocked,
      deadlocked,
      missing,
      readyNodeIds: ready,
      runningNodeIds: running,
      waitingNodeIds: waiting,
    };
  }

  completeDagWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedWorkRevision: number,
    expectedDagRevision: number,
    expectedRequirementRevision: number,
    expectedSubjectRevision: string | null,
    now = Date.now(),
  ): WorkItemRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (
        work.stateRevision !== expectedWorkRevision ||
        work.currentDagRevision !== expectedDagRevision ||
        work.currentRequirementRevision !== expectedRequirementRevision ||
        work.currentSubjectRevision !== expectedSubjectRevision
      ) {
        throw new Error("STALE_DAG_COMPLETION");
      }
      if (work.status === "cancelled") throw new Error("DAG_COMPLETION_NOT_READY");
      if (TERMINAL_WORK_STATUSES.has(work.status)) {
        if (work.status === "completed") {
          this.db.exec("COMMIT");
          return work;
        }
        throw new Error("DAG_COMPLETION_NOT_READY");
      }
      const evaluation = this.evaluateDagCompletion(workItemId);
      if (!evaluation.ready) throw new Error("DAG_COMPLETION_NOT_READY");
      const changed = this.db
        .prepare(
          "UPDATE work_items SET status='completed',completed_at=?,next_action_type=NULL,next_action_at=NULL,next_action_context=NULL,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=? AND current_dag_revision=? AND current_requirement_revision=? AND ((current_subject_revision IS NULL AND ? IS NULL) OR current_subject_revision=?)",
        )
        .run(
          now,
          now,
          workItemId,
          principalId,
          scope,
          expectedWorkRevision,
          expectedDagRevision,
          expectedRequirementRevision,
          expectedSubjectRevision,
          expectedSubjectRevision,
        );
      if (changed.changes !== 1) throw new Error("STALE_DAG_COMPLETION");
      const snapshot = this.getRequirementSnapshot(workItemId, expectedRequirementRevision);
      this.recordDagDecisionInternal(
        workItemId,
        expectedWorkRevision + 1,
        expectedDagRevision,
        expectedRequirementRevision,
        expectedSubjectRevision,
        "work.completed",
        null,
        "requirements_satisfied",
        this.getEffectiveDagObligations(workItemId).map((item) => item.id),
        snapshot.policyRef,
        null,
        null,
        now,
      );
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "dag.work_completed",
        JSON.stringify({
          dagRevision: expectedDagRevision,
          requirementRevision: expectedRequirementRevision,
          subjectRevision: expectedSubjectRevision,
        }),
        now,
      );
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  retryDagNode(workItemId: string, nodeId: string, reason: string, now = Date.now()): WorkDagNodeExecutionRecord {
    const normalizedReason = requiredText(reason, 500);
    if (!normalizedReason) throw new Error("INVALID_DAG_RETRY");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWorkInternal(workItemId);
      if (TERMINAL_WORK_STATUSES.has(work.status) || work.currentDagRevision < 1) {
        throw new Error("DAG_RETRY_NOT_ALLOWED");
      }
      const workflow = this.getWorkflow(work.workflowId, work.workflowVersion);
      if (!workflow.definition.lifecycle.retry.failure.enabled) throw new Error("DAG_RETRY_NOT_ALLOWED");
      const revision = this.getDagRevision(workItemId, work.currentDagRevision);
      const node = revision.graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error("DAG_NODE_NOT_FOUND");
      const previous = this.listDagExecutions(workItemId)
        .filter((execution) => execution.nodeId === nodeId)
        .sort((a, b) => b.generation - a.generation)[0];
      if (!previous || previous.state !== "failed") throw new Error("DAG_RETRY_NOT_ALLOWED");
      const nextGeneration = previous.generation + 1;
      if (nextGeneration > workflow.definition.lifecycle.retry.failure.maxRunsPerWorkAttempt) {
        throw new Error("DAG_RETRY_LIMIT_REACHED");
      }
      const idempotencyKey = executionKey(workItemId, node, nextGeneration);
      const nodeExecutionId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_dag_executions(node_execution_id,work_item_id,node_id,created_dag_revision,generation,state,fence,idempotency_key,subject_revision,resource_identity,claim_owner,claim_lease_until,started_at,finished_at,result_json,result_digest,superseded_by_node_id,superseded_dag_revision,created_at,updated_at) VALUES(?,?,?,?,?,'pending',0,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?)",
        )
        .run(
          nodeExecutionId,
          workItemId,
          nodeId,
          work.currentDagRevision,
          nextGeneration,
          idempotencyKey,
          node.subject,
          node.resource,
          now,
          now,
        );
      const changed = this.db
        .prepare(
          "UPDATE work_items SET state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
        )
        .run(now, workItemId, work.stateRevision);
      if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
      const snapshot = this.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
      this.recordDagDecisionInternal(
        workItemId,
        work.stateRevision + 1,
        work.currentDagRevision,
        work.currentRequirementRevision,
        work.currentSubjectRevision,
        "node.retry_created",
        nodeId,
        normalizedReason,
        this.getEffectiveDagObligations(workItemId).map((item) => item.id),
        snapshot.policyRef,
        idempotencyKey,
        "previous:" + previous.nodeExecutionId,
        now,
      );
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "dag.node_retry_created",
        JSON.stringify({ nodeId, generation: nextGeneration, reason: normalizedReason }),
        now,
      );
      const row = this.db
        .prepare("SELECT * FROM work_dag_executions WHERE node_execution_id=?")
        .get(nodeExecutionId) as Row;
      this.db.exec("COMMIT");
      return this.fromDagExecutionRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancelDagExecutions(workItemId: string, now = Date.now()): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWorkInternal(workItemId);
      if (work.status !== "cancelled") throw new Error("WORK_NOT_CANCELLED");
      const current = this.listDagExecutions(workItemId).filter((execution) =>
        ["pending", "claimed", "running"].includes(execution.state),
      );
      for (const execution of current) {
        this.db
          .prepare(
            "UPDATE work_dag_executions SET state='cancelled',fence=fence+1,claim_owner=NULL,claim_lease_until=NULL,finished_at=?,updated_at=? WHERE node_execution_id=? AND state IN ('pending','claimed','running')",
          )
          .run(now, now, execution.nodeExecutionId);
      }
      if (current.length > 0 && work.currentRequirementRevision > 0) {
        const snapshot = this.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
        for (const execution of current) {
          this.recordDagDecisionInternal(
            workItemId,
            work.stateRevision,
            work.currentDagRevision,
            work.currentRequirementRevision,
            work.currentSubjectRevision,
            "node.cancelled",
            execution.nodeId,
            "work_cancelled",
            this.getEffectiveDagObligations(workItemId).map((item) => item.id),
            snapshot.policyRef,
            execution.idempotencyKey,
            null,
            now,
          );
        }
      }
      this.event(
        workItemId,
        work.activeWorkAttemptId,
        "dag.executions_cancelled",
        JSON.stringify({ count: current.length }),
        now,
      );
      this.db.exec("COMMIT");
      return current.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getShadowDag(workItemId: string): ShadowDagProjection | null {
    const row = this.db.prepare("SELECT projection_json FROM work_shadow_dags WHERE work_item_id=?").get(workItemId) as
      { projection_json?: string } | undefined;
    if (!row?.projection_json) return null;
    try {
      return JSON.parse(row.projection_json) as ShadowDagProjection;
    } catch {
      return null;
    }
  }

  saveShadowDag(projection: ShadowDagProjection, now = Date.now()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.db
        .prepare("SELECT state_revision FROM work_items WHERE work_item_id=?")
        .get(projection.workItemId) as { state_revision?: number } | undefined;
      if (!work || Number(work.state_revision) !== projection.stateRevision) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          "INSERT INTO work_shadow_dags(work_item_id,state_revision,source_digest,semantic_digest,projection_json,updated_at) " +
            "VALUES(?,?,?,?,?,?) ON CONFLICT(work_item_id) DO UPDATE SET " +
            "state_revision=excluded.state_revision,source_digest=excluded.source_digest," +
            "semantic_digest=excluded.semantic_digest,projection_json=excluded.projection_json,updated_at=excluded.updated_at",
        )
        .run(
          projection.workItemId,
          projection.stateRevision,
          projection.sourceDigest,
          projection.semanticDigest,
          JSON.stringify(projection),
          now,
        );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }

  private assertWorkOrchestrationFence(work: WorkItemRecord, fence?: WorkOrchestrationFence): void {
    if (!fence) return;
    if (
      work.orchestrationOwnerId !== fence.ownerId ||
      work.orchestrationEpoch !== fence.epoch ||
      work.orchestrationLeaseUntil === null ||
      work.orchestrationLeaseUntil <= fence.now
    ) {
      throw new Error("STALE_ORCHESTRATION_CLAIM");
    }
  }

  private recordDagDecisionInternal(
    workItemId: string,
    workStateRevision: number,
    dagRevision: number,
    requirementRevision: number,
    subjectRevision: string | null,
    action: string,
    nodeId: string | null,
    reasonCode: string,
    requirementIds: string[],
    policyRef: string,
    idempotencyRef: string | null,
    resultRef: string | null,
    now: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO work_dag_decisions(work_item_id,work_state_revision,dag_revision,requirement_revision,subject_revision,action,node_id,reason_code,requirement_ids_json,policy_ref,idempotency_ref,result_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        workItemId,
        workStateRevision,
        dagRevision,
        requirementRevision,
        subjectRevision,
        action,
        nodeId,
        reasonCode,
        JSON.stringify(requirementIds),
        policyRef,
        idempotencyRef,
        resultRef,
        now,
      );
  }

  private event(
    workItemId: string,
    workAttemptId: string | null,
    eventType: string,
    details: string | null,
    now: number,
  ): void {
    this.db
      .prepare("INSERT INTO work_events(work_item_id,work_attempt_id,event_type,details,created_at) VALUES(?,?,?,?,?)")
      .run(workItemId, workAttemptId, eventType, details, now);
  }

  private fromDagReplanRequestRow(row: Row): WorkDagReplanRequestRecord {
    return {
      requestId: String(row.request_id),
      workItemId: String(row.work_item_id),
      requestedBy: String(row.requested_by),
      reason: String(row.reason),
      state: String(row.state) as WorkDagReplanRequestRecord["state"],
      proposalId: row.proposal_id == null ? null : String(row.proposal_id),
      createdAt: Number(row.created_at),
      consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
    };
  }

  private fromDagWaitRow(row: Row): WorkDagWaitRecord {
    return {
      waitId: String(row.wait_id),
      workItemId: String(row.work_item_id),
      nodeExecutionId: String(row.node_execution_id),
      correlationKey: String(row.correlation_key),
      capability: String(row.capability),
      state: String(row.state) as WorkDagWaitRecord["state"],
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      signalEventId: row.signal_event_id == null ? null : String(row.signal_event_id),
      signalDigest: row.signal_digest == null ? null : String(row.signal_digest),
      signalPayload: row.signal_payload_json == null ? null : JSON.parse(String(row.signal_payload_json)),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private fromDagRevisionRow(row: Row): WorkDagRevisionRecord {
    return {
      workItemId: String(row.work_item_id),
      revision: Number(row.revision),
      parentRevision: row.parent_revision == null ? null : Number(row.parent_revision),
      attemptId: row.attempt_id == null ? null : String(row.attempt_id),
      plannerIdentity: String(row.planner_identity),
      plannerVersion: String(row.planner_version),
      validatorVersion: String(row.validator_version ?? "work-dag-policy@1"),
      policyRevision: String(row.policy_revision),
      requirementSnapshotRevision: Number(row.requirement_revision),
      reasonCode: String(row.reason_code),
      plannerInputDigest: String(row.planner_input_digest),
      graph: JSON.parse(String(row.graph_json)) as DagGraph,
      semanticDigest: String(row.semantic_digest),
      createdAt: Number(row.created_at),
    };
  }

  private fromDagProposalRow(row: Row): WorkDagProposalRecord {
    return {
      proposalId: String(row.proposal_id),
      workItemId: String(row.work_item_id),
      parentRevision: Number(row.parent_revision),
      expectedWorkRevision: Number(row.expected_work_revision),
      expectedRequirementRevision: Number(row.expected_requirement_revision),
      attemptId: row.attempt_id == null ? null : String(row.attempt_id),
      plannerIdentity: String(row.planner_identity),
      plannerVersion: String(row.planner_version),
      validatorVersion: String(row.validator_version ?? "work-dag-policy@1"),
      plannerInputDigest: String(row.planner_input_digest),
      reasonCode: String(row.reason_code),
      graph: JSON.parse(String(row.graph_json)) as DagGraph,
      status: String(row.status) as WorkDagProposalRecord["status"],
      decisionCodes: JSON.parse(String(row.decision_codes_json)) as string[],
      acceptedRevision: row.accepted_revision == null ? null : Number(row.accepted_revision),
      createdAt: Number(row.created_at),
      decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    };
  }

  private fromDagExecutionRow(row: Row): WorkDagNodeExecutionRecord {
    return {
      nodeExecutionId: String(row.node_execution_id),
      workItemId: String(row.work_item_id),
      nodeId: String(row.node_id),
      createdDagRevision: Number(row.created_dag_revision),
      boundRequirementRevision: row.bound_requirement_revision == null ? null : Number(row.bound_requirement_revision),
      generation: Number(row.generation),
      state: String(row.state) as WorkDagNodeExecutionRecord["state"],
      fence: Number(row.fence),
      idempotencyKey: String(row.idempotency_key),
      subjectRevision: row.subject_revision == null ? null : String(row.subject_revision),
      resourceIdentity: row.resource_identity == null ? null : String(row.resource_identity),
      claimOwner: row.claim_owner == null ? null : String(row.claim_owner),
      claimLeaseUntil: row.claim_lease_until == null ? null : Number(row.claim_lease_until),
      startedAt: row.started_at == null ? null : Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
      result: row.result_json == null ? null : (JSON.parse(String(row.result_json)) as DagNodeResult),
      externalRef: row.external_ref == null ? null : String(row.external_ref),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private fromWorkspaceRow(row: Row): WorkspaceRecord {
    return {
      workspaceId: String(row.workspace_id),
      workspaceKey: String(row.workspace_key),
      workItemId: String(row.work_item_id),
      workAttemptId: String(row.work_attempt_id),
      resourceKey: String(row.resource_key ?? "workspace"),
      repositoryId: row.repository_id == null ? null : String(row.repository_id),
      ownerWorkerId: row.owner_worker_id == null ? null : String(row.owner_worker_id),
      path: row.path == null ? null : String(row.path),
      repositoryUrl: row.repository_url == null ? null : String(row.repository_url),
      branch: row.branch == null ? null : String(row.branch),
      baseCommit: row.base_commit == null ? null : String(row.base_commit),
      state: String(row.state) as WorkspaceRecord["state"],
      cleanupPolicy: String(row.cleanup_policy) as WorkspaceRecord["cleanupPolicy"],
      createdAt: Number(row.created_at),
      lastUsedAt: Number(row.last_used_at),
    };
  }

  private fromEvidenceRow(row: Row): WorkEvidenceRecord {
    return {
      evidenceId: String(row.evidence_id),
      workItemId: String(row.work_item_id),
      workAttemptId: String(row.work_attempt_id),
      resourceKey: String(row.resource_key ?? "workspace"),
      repositoryId: row.repository_id == null ? null : String(row.repository_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      runId: row.run_id == null ? null : String(row.run_id),
      type: String(row.type),
      status: String(row.status) as WorkEvidenceStatus,
      source: String(row.source) as WorkEvidenceSource,
      summary: row.summary == null ? null : String(row.summary),
      artifactRef: row.artifact_ref == null ? null : String(row.artifact_ref),
      subjectRevision: String(row.subject_revision),
      environmentIdentity: row.environment_identity == null ? null : String(row.environment_identity),
      verifierIdentity: row.verifier_identity == null ? null : String(row.verifier_identity),
      stale: Number(row.stale) === 1,
      createdAt: Number(row.created_at),
    };
  }

  private fromReviewRow(row: Row): ReviewDecisionRecord {
    return {
      reviewDecisionId: String(row.review_decision_id),
      workItemId: String(row.work_item_id),
      subjectRevision: String(row.subject_revision),
      decision: String(row.decision) as ReviewDecision,
      reason: row.reason == null ? null : String(row.reason),
      actorPrincipalId: String(row.actor_principal_id),
      createdAt: Number(row.created_at),
    };
  }

  private fromSourceObservationRow(row: Row): WorkSourceObservationRecord {
    return {
      observationId: String(row.observation_id),
      workItemId: String(row.work_item_id),
      sourceType: String(row.source_type),
      sourceScope: String(row.source_scope),
      sourceRef: String(row.source_ref),
      state: String(row.state) as WorkSourceObservationRecord["state"],
      detail: row.detail == null ? null : String(row.detail),
      fingerprint: String(row.fingerprint),
      reconciliationAction:
        row.reconciliation_action == null
          ? null
          : (String(row.reconciliation_action) as WorkSourceObservationRecord["reconciliationAction"]),
      reconciledAt: row.reconciled_at == null ? null : Number(row.reconciled_at),
      observedAt: Number(row.observed_at),
      createdAt: Number(row.created_at),
    };
  }

  private fromApprovalRow(row: Row): WorkApprovalRecord {
    return {
      approvalId: String(row.approval_id),
      workItemId: String(row.work_item_id),
      workAttemptId: row.work_attempt_id == null ? null : String(row.work_attempt_id),
      actor: String(row.actor),
      role: String(row.role),
      approvalScope: String(row.approval_scope),
      subjectType: String(row.subject_type),
      subjectRevision: String(row.subject_revision),
      decision: String(row.decision) as ApprovalDecision,
      stale: Number(row.stale) === 1,
      createdAt: Number(row.created_at),
    };
  }
  private fromRequirementSnapshotRow(row: Row): RequirementSnapshot {
    return {
      workItemId: String(row.work_item_id),
      revision: Number(row.revision),
      resolverIdentity: String(row.resolver_identity ?? "legacy-snapshot"),
      resolverVersion: String(row.resolver_version),
      originalRequest: String(row.original_request ?? ""),
      originalRequestDigest: String(row.original_request_digest ?? ""),
      requirements: normalizeWorkRequirements(JSON.parse(String(row.requirements_json)) as WorkRequirement[]),
      unresolved: normalizeUnresolvedWorkRequirements(
        JSON.parse(String(row.unresolved_json ?? "[]")) as ReturnType<typeof normalizeUnresolvedWorkRequirements>,
      ),
      policyObligations: normalizePinnedPolicyObligations(
        JSON.parse(String(row.policy_obligations_json ?? "[]")) as DagObligation[],
      ),
      policyContextRef: String(row.policy_context_ref ?? ""),
      policyContextDigest: String(row.policy_context_digest ?? ""),
      policyRef: String(row.policy_ref),
      policyDigest: String(row.policy_digest),
      effectiveDigest: String(row.effective_digest),
      createdAt: Number(row.created_at),
    };
  }
  private fromWorkRow(row: Row): WorkItemRecord {
    return {
      workItemId: String(row.work_item_id),
      principalId: String(row.principal_id),
      scope: String(row.scope),
      idempotencyKey: String(row.idempotency_key),
      sourceType: String(row.source_type),
      sourceScope: row.source_scope == null ? null : String(row.source_scope),
      sourceRef: row.source_ref == null ? null : String(row.source_ref),
      sourceUrl: row.source_url == null ? null : String(row.source_url),
      sourceRequestId: row.source_request_id == null ? null : String(row.source_request_id),
      sourceRequestSlot: row.source_request_slot == null ? null : String(row.source_request_slot),
      title: String(row.title),
      description: String(row.description),
      status: String(row.status) as WorkStatus,
      stateRevision: Number(row.state_revision),
      workflowId: String(row.workflow_id),
      workflowVersion: Number(row.workflow_version),
      orchestrationEngine: String(row.orchestration_engine) as WorkOrchestrationEngine,
      currentRequirementRevision: Number(row.current_requirement_revision ?? 0),
      currentDagRevision: Number(row.current_dag_revision ?? 0),
      activeWorkAttemptId: row.active_work_attempt_id == null ? null : String(row.active_work_attempt_id),
      orchestrationEpoch: Number(row.orchestration_epoch),
      orchestrationOwnerId: row.orchestration_owner_id == null ? null : String(row.orchestration_owner_id),
      orchestrationLeaseUntil: row.orchestration_lease_until == null ? null : Number(row.orchestration_lease_until),
      orchestrationClaimedAt: row.orchestration_claimed_at == null ? null : Number(row.orchestration_claimed_at),
      priority: row.priority == null ? null : Number(row.priority),
      nextActionType: row.next_action_type == null ? null : String(row.next_action_type),
      nextActionAt: row.next_action_at == null ? null : Number(row.next_action_at),
      nextActionContext: row.next_action_context == null ? null : String(row.next_action_context),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      currentSubjectRevision: row.current_subject_revision == null ? null : String(row.current_subject_revision),
      requestedExpertId: row.requested_expert_id == null ? null : String(row.requested_expert_id),
      requestedDeploymentId: row.requested_deployment_id == null ? null : String(row.requested_deployment_id),
      repositoryId: row.repository_id == null ? null : String(row.repository_id),
      blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
      blockedContext: row.blocked_context == null ? null : String(row.blocked_context),
      blockedAt: row.blocked_at == null ? null : Number(row.blocked_at),
      resumeCondition: row.resume_condition == null ? null : String(row.resume_condition),
      blockedByType: row.blocked_by_type == null ? null : String(row.blocked_by_type),
      blockedByRef: row.blocked_by_ref == null ? null : String(row.blocked_by_ref),
    };
  }

  private fromAttemptRow(row: Row): WorkAttemptRecord {
    return {
      workAttemptId: String(row.work_attempt_id),
      workItemId: String(row.work_item_id),
      sequence: Number(row.sequence),
      reason: String(row.reason) as WorkAttemptReason,
      status: String(row.status) as WorkAttemptStatus,
      expertId: String(row.expert_id),
      deploymentId: String(row.deployment_id),
      deploymentConfigVersion: Number(row.deployment_config_version),
      workflowId: String(row.workflow_id),
      workflowVersion: Number(row.workflow_version),
      workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      reviewTaskId: row.review_task_id == null ? null : String(row.review_task_id),
      runCount: Number(row.run_count),
      parentWorkAttemptId: row.parent_work_attempt_id == null ? null : String(row.parent_work_attempt_id),
      originWorkAttemptId: row.parent_work_attempt_id == null ? null : String(row.parent_work_attempt_id),
      reviewContext: row.review_context == null ? null : String(row.review_context),
      whatShouldChange: row.what_should_change == null ? null : String(row.what_should_change),
      createdBy: row.created_by == null ? null : String(row.created_by),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
      dispatchBinding: row.dispatch_binding_json
        ? (JSON.parse(String(row.dispatch_binding_json)) as Record<string, unknown>)
        : null,
    };
  }
}
