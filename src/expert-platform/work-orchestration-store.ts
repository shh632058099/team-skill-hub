import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    workspace: {
      strategy: "isolated";
      reuseOnContinuation: boolean;
      cleanup: "on_terminal";
    };
  };
  validation: { requiredEvidence: string[] };
  review: { humanReview: boolean };
  completion: {
    require: Array<
      "latest_work_attempt_succeeded" | "required_evidence_passed" | "no_unresolved_blocker" | "review_accepted"
    >;
  };
  graph: { mode: "single-node" };
}

export interface WorkflowDefinitionRecord {
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  createdAt: number;
}

export interface WorkSubmission {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceType: string;
  sourceScope?: string;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  description: string;
  workflowId?: string;
  priority?: number;
  expertId?: string;
  deploymentId?: string;
  repositoryId?: string;
}

export interface WorkItemRecord {
  workItemId: string;
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceType: string;
  sourceScope: string | null;
  sourceRef: string | null;
  sourceUrl: string | null;
  title: string;
  description: string;
  status: WorkStatus;
  stateRevision: number;
  workflowId: string;
  workflowVersion: number;
  activeWorkAttemptId: string | null;
  orchestrationEpoch: number;
  priority: number | null;
  nextActionType: string | null;
  nextActionAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  currentSubjectRevision: string | null;
  requestedExpertId: string | null;
  requestedDeploymentId: string | null;
  repositoryId: string | null;
  blockedReason: string | null;
  blockedContext: string | null;
  reusedExistingWork?: boolean;
  deduplicationReason?: "idempotency_key" | "source_identity";
}

export interface CreateWorkAttemptInput {
  reason: WorkAttemptReason;
  expertId: string;
  deploymentId: string;
  deploymentConfigVersion: number;
  parentWorkAttemptId?: string;
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
  runCount: number;
  parentWorkAttemptId: string | null;
  startedAt: number;
  finishedAt: number | null;
  dispatchBinding: Record<string, unknown> | null;
}

export interface WorkspaceRecord {
  workspaceId: string;
  workspaceKey: string;
  workItemId: string;
  workAttemptId: string;
  ownerWorkerId: string | null;
  path: string | null;
  repositoryUrl: string | null;
  branch: string | null;
  baseCommit: string | null;
  state: "ready" | "in_use" | "retained" | "removed" | "failed";
  cleanupPolicy: "on_terminal";
  createdAt: number;
  lastUsedAt: number;
}

export interface WorkEvidenceRecord {
  evidenceId: string;
  workItemId: string;
  workAttemptId: string;
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
  actor: string;
  role: string;
  approvalScope: string;
  subjectType: string;
  subjectRevision: string;
  decision: ApprovalDecision;
  stale: boolean;
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
  validation: { requiredEvidence: ["expert_result"] },
  review: { humanReview: true },
  completion: {
    require: ["latest_work_attempt_succeeded", "required_evidence_passed", "no_unresolved_blocker", "review_accepted"],
  },
  graph: { mode: "single-node" },
};

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
        "  title TEXT NOT NULL,",
        "  description TEXT NOT NULL,",
        "  status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','waiting_review','rework','completed','failed','cancelled')),",
        "  state_revision INTEGER NOT NULL DEFAULT 1,",
        "  workflow_id TEXT NOT NULL,",
        "  workflow_version INTEGER NOT NULL,",
        "  active_work_attempt_id TEXT,",
        "  orchestration_epoch INTEGER NOT NULL DEFAULT 1,",
        "  priority INTEGER,",
        "  next_action_type TEXT,",
        "  next_action_at INTEGER,",
        "  created_at INTEGER NOT NULL,",
        "  updated_at INTEGER NOT NULL,",
        "  completed_at INTEGER,",
        "  current_subject_revision TEXT,",
        "  requested_expert_id TEXT,",
        "  requested_deployment_id TEXT,",
        "  repository_id TEXT,",
        "  blocked_reason TEXT,",
        "  blocked_context TEXT,",
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
        "  run_count INTEGER NOT NULL DEFAULT 0,",
        "  parent_work_attempt_id TEXT,",
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
        "  work_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        "  owner_worker_id TEXT,",
        "  path TEXT,",
        "  repository_url TEXT,",
        "  branch TEXT,",
        "  base_commit TEXT,",
        "  state TEXT NOT NULL CHECK(state IN ('ready','in_use','retained','removed','failed')),",
        "  cleanup_policy TEXT NOT NULL CHECK(cleanup_policy='on_terminal'),",
        "  created_at INTEGER NOT NULL,",
        "  last_used_at INTEGER NOT NULL",
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
        "CREATE TABLE IF NOT EXISTS work_approvals (",
        "  approval_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
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
      ].join("\n"),
    );
    this.ensureDefaultWorkflow();
  }

  private ensureDefaultWorkflow(): void {
    this.db
      .prepare("INSERT OR IGNORE INTO work_workflows(workflow_id,version,definition_json,created_at) VALUES(?,?,?,?)")
      .run(DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_VERSION, JSON.stringify(DEFAULT_WORKFLOW), Date.now());
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
      definition: JSON.parse(String(row.definition_json)) as WorkflowDefinition,
      createdAt: Number(row.created_at),
    };
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
    if (!principalId || !scope || !idempotencyKey || !sourceType || !title || !description || !Number.isFinite(now)) {
      throw new Error("INVALID_WORK_REQUEST");
    }
    if ((sourceScope === null) !== (sourceRef === null)) throw new Error("INVALID_WORK_SOURCE_IDENTITY");
    if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) throw new Error("INVALID_WORK_REQUEST");
    const workflow = this.getWorkflow(input.workflowId?.trim() || DEFAULT_WORKFLOW_ID);
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
            "work_item_id,principal_id,scope,idempotency_key,request_digest,source_type,source_scope,source_ref,source_url,",
            "title,description,status,state_revision,workflow_id,workflow_version,orchestration_epoch,priority,requested_expert_id,requested_deployment_id,repository_id,created_at,updated_at",
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',1,?,?,1,?,?,?,?,?,?)",
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

  transitionWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    status: WorkStatus,
    now = Date.now(),
  ): WorkItemRecord {
    if (!WORK_STATUSES.has(status) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("INVALID_WORK_TRANSITION");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(workItemId, principalId, scope);
      if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
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

  createWorkAttempt(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    input: CreateWorkAttemptInput,
    now = Date.now(),
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

      const workAttemptId = randomUUID();
      this.db
        .prepare(
          [
            "INSERT INTO work_attempts(",
            "work_attempt_id,work_item_id,sequence,reason,status,expert_id,deployment_id,deployment_config_version,",
            "workflow_id,workflow_version,parent_work_attempt_id,started_at,dispatch_binding_json",
            ") VALUES(?,?,?,?,'active',?,?,?,?,?,?,?,?)",
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
        JSON.stringify({ sequence, reason: input.reason }),
        now,
      );
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
    const row = this.db.prepare("SELECT * FROM work_attempts WHERE task_id=?").get(taskId) as Row | undefined;
    return row ? this.fromAttemptRow(row) : null;
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

  ensureWorkspace(
    workItemId: string,
    workAttemptId: string,
    input: { repositoryUrl?: string; branch?: string; baseCommit?: string },
    now = Date.now(),
  ): WorkspaceRecord {
    const attempt = this.getWorkAttempt(workAttemptId);
    if (attempt.workItemId !== workItemId) throw new Error("WORKSPACE_ATTEMPT_MISMATCH");
    const existing = this.db.prepare("SELECT * FROM work_workspaces WHERE work_attempt_id=?").get(workAttemptId) as
      Row | undefined;
    if (existing) {
      if (
        (existing.repository_url ?? null) !== (input.repositoryUrl?.trim() || null) ||
        (existing.branch ?? null) !== (input.branch?.trim() || null) ||
        (existing.base_commit ?? null) !== (input.baseCommit?.trim() || null)
      ) {
        throw new Error("WORKSPACE_IDENTITY_CONFLICT");
      }
      return this.fromWorkspaceRow(existing);
    }

    const workspaceId = randomUUID();
    const workspaceKey = "work-" + workItemId.toLowerCase() + "-a" + String(attempt.sequence);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO work_workspaces(workspace_id,workspace_key,work_item_id,work_attempt_id,repository_url,branch,base_commit,state,cleanup_policy,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,'ready','on_terminal',?,?)",
        )
        .run(
          workspaceId,
          workspaceKey,
          workItemId,
          workAttemptId,
          input.repositoryUrl?.trim() || null,
          input.branch?.trim() || null,
          input.baseCommit?.trim() || null,
          now,
          now,
        );
      this.db
        .prepare("UPDATE work_attempts SET workspace_id=? WHERE work_attempt_id=? AND work_item_id=?")
        .run(workspaceId, workAttemptId, workItemId);
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
  ): WorkspaceRecord {
    const normalizedWorker = requiredText(workerId, 200);
    if (!normalizedWorker || !path.isAbsolute(workspacePath) || workspacePath === path.parse(workspacePath).root) {
      throw new Error("INVALID_WORKSPACE_OWNER");
    }
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
          "UPDATE work_workspaces SET owner_worker_id=?,path=?,state='ready',last_used_at=? WHERE workspace_id=?",
        )
        .run(normalizedWorker, workspacePath, now, workspaceId);
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

  setCurrentSubjectRevision(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    subjectRevision: string,
    now = Date.now(),
  ): WorkItemRecord {
    const revision = requiredText(subjectRevision, 500);
    if (!revision) throw new Error("INVALID_WORK_SUBJECT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
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
      this.db
        .prepare("UPDATE work_evidence SET stale=1 WHERE work_item_id=? AND subject_revision<>? AND stale=0")
        .run(workItemId, revision);
      this.db
        .prepare("UPDATE work_approvals SET stale=1 WHERE work_item_id=? AND subject_revision<>? AND stale=0")
        .run(workItemId, revision);
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
    const work = this.getWork(workItemId, principalId, scope);
    const attempt = this.getWorkAttempt(input.workAttemptId);
    if (attempt.workItemId !== workItemId) throw new Error("EVIDENCE_ATTEMPT_MISMATCH");
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
    if (!work.currentSubjectRevision || work.currentSubjectRevision !== subjectRevision) {
      throw new Error("STALE_WORK_SUBJECT");
    }

    const existing = this.db
      .prepare(
        "SELECT * FROM work_evidence WHERE work_item_id=? AND work_attempt_id=? AND type=? AND source=? AND subject_revision=? AND task_id IS ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(workItemId, input.workAttemptId, type, input.source, subjectRevision, input.taskId?.trim() || null) as
      Row | undefined;
    if (existing) return this.fromEvidenceRow(existing);
    const evidenceId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO work_evidence(evidence_id,work_item_id,work_attempt_id,task_id,run_id,type,status,source,summary,artifact_ref,subject_revision,environment_identity,verifier_identity,stale,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
      )
      .run(
        evidenceId,
        workItemId,
        input.workAttemptId,
        input.taskId?.trim() || null,
        input.runId?.trim() || null,
        type,
        input.status,
        input.source,
        input.summary?.trim() || null,
        input.artifactRef?.trim() || null,
        subjectRevision,
        input.environmentIdentity?.trim() || null,
        input.verifierIdentity?.trim() || null,
        now,
      );
    this.event(workItemId, input.workAttemptId, "evidence.recorded", JSON.stringify({ evidenceId, type }), now);
    const row = this.db.prepare("SELECT * FROM work_evidence WHERE evidence_id=?").get(evidenceId) as Row;
    return this.fromEvidenceRow(row);
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
    input: { expectedRevision: number; subjectRevision: string; decision: ReviewDecision; reason?: string },
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
          principalId,
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
    if (
      !actor ||
      !role ||
      !approvalScope ||
      !subjectType ||
      !subjectRevision ||
      !["approved", "rejected"].includes(input.decision)
    ) {
      throw new Error("INVALID_WORK_APPROVAL");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== input.expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (work.currentSubjectRevision !== subjectRevision) throw new Error("STALE_WORK_SUBJECT");
      const approvalId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO work_approvals(approval_id,work_item_id,actor,role,approval_scope,subject_type,subject_revision,decision,stale,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)",
        )
        .run(approvalId, workItemId, actor, role, approvalScope, subjectType, subjectRevision, input.decision, now);
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
  ): WorkItemRecord {
    if (!["succeeded", "failed", "cancelled"].includes(attemptStatus) || !WORK_STATUSES.has(nextWorkStatus)) {
      throw new Error("INVALID_WORK_ATTEMPT_FINISH");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const work = this.getWork(workItemId, principalId, scope);
      if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (work.activeWorkAttemptId !== workAttemptId) throw new Error("STALE_WORK_ATTEMPT");
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
      const row = this.db.prepare("SELECT * FROM work_items WHERE work_item_id=?").get(workItemId) as Row;
      this.db.exec("COMMIT");
      return this.fromWorkRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      for (const requiredType of workflow.definition.validation.requiredEvidence) {
        const evidence = work.currentSubjectRevision
          ? (this.db
              .prepare(
                "SELECT evidence_id FROM work_evidence WHERE work_item_id=? AND type=? AND status='passed' AND stale=0 AND subject_revision=? AND source<>'agent_reported' ORDER BY created_at DESC LIMIT 1",
              )
              .get(workItemId, requiredType, work.currentSubjectRevision) as Row | undefined)
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
  ): WorkItemRecord {
    const blockedReason = requiredText(reason, 200);
    if (!blockedReason) throw new Error("INVALID_BLOCK_REASON");
    const changed = this.db
      .prepare(
        "UPDATE work_items SET status='blocked',blocked_reason=?,blocked_context=?,next_action_type=NULL,next_action_at=NULL,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=?",
      )
      .run(blockedReason, context, now, workItemId, principalId, scope, expectedRevision);
    if (changed.changes !== 1) {
      this.getWork(workItemId, principalId, scope);
      throw new Error("STALE_WORK_REVISION");
    }
    this.event(
      workItemId,
      this.getWorkInternal(workItemId).activeWorkAttemptId,
      "work.blocked",
      JSON.stringify({ reason: blockedReason }),
      now,
    );
    return this.getWork(workItemId, principalId, scope);
  }

  scheduleNextAction(
    workItemId: string,
    expectedRevision: number,
    actionType: string | null,
    dueAt: number | null,
    now = Date.now(),
  ): WorkItemRecord {
    if (actionType !== null && !requiredText(actionType, 100)) throw new Error("INVALID_NEXT_ACTION");
    if (dueAt !== null && !Number.isFinite(dueAt)) throw new Error("INVALID_NEXT_ACTION");
    const changed = this.db
      .prepare(
        "UPDATE work_items SET next_action_type=?,next_action_at=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
      )
      .run(actionType, dueAt, now, workItemId, expectedRevision);
    if (changed.changes !== 1) throw new Error("STALE_WORK_REVISION");
    return this.getWorkInternal(workItemId);
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

  close(): void {
    this.db.close();
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

  private fromWorkspaceRow(row: Row): WorkspaceRecord {
    return {
      workspaceId: String(row.workspace_id),
      workspaceKey: String(row.workspace_key),
      workItemId: String(row.work_item_id),
      workAttemptId: String(row.work_attempt_id),
      ownerWorkerId: row.owner_worker_id == null ? null : String(row.owner_worker_id),
      path: row.path == null ? null : String(row.path),
      repositoryUrl: row.repository_url == null ? null : String(row.repository_url),
      branch: row.branch == null ? null : String(row.branch),
      baseCommit: row.base_commit == null ? null : String(row.base_commit),
      state: String(row.state) as WorkspaceRecord["state"],
      cleanupPolicy: "on_terminal",
      createdAt: Number(row.created_at),
      lastUsedAt: Number(row.last_used_at),
    };
  }

  private fromEvidenceRow(row: Row): WorkEvidenceRecord {
    return {
      evidenceId: String(row.evidence_id),
      workItemId: String(row.work_item_id),
      workAttemptId: String(row.work_attempt_id),
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

  private fromApprovalRow(row: Row): WorkApprovalRecord {
    return {
      approvalId: String(row.approval_id),
      workItemId: String(row.work_item_id),
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
      title: String(row.title),
      description: String(row.description),
      status: String(row.status) as WorkStatus,
      stateRevision: Number(row.state_revision),
      workflowId: String(row.workflow_id),
      workflowVersion: Number(row.workflow_version),
      activeWorkAttemptId: row.active_work_attempt_id == null ? null : String(row.active_work_attempt_id),
      orchestrationEpoch: Number(row.orchestration_epoch),
      priority: row.priority == null ? null : Number(row.priority),
      nextActionType: row.next_action_type == null ? null : String(row.next_action_type),
      nextActionAt: row.next_action_at == null ? null : Number(row.next_action_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      currentSubjectRevision: row.current_subject_revision == null ? null : String(row.current_subject_revision),
      requestedExpertId: row.requested_expert_id == null ? null : String(row.requested_expert_id),
      requestedDeploymentId: row.requested_deployment_id == null ? null : String(row.requested_deployment_id),
      repositoryId: row.repository_id == null ? null : String(row.repository_id),
      blockedReason: row.blocked_reason == null ? null : String(row.blocked_reason),
      blockedContext: row.blocked_context == null ? null : String(row.blocked_context),
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
      runCount: Number(row.run_count),
      parentWorkAttemptId: row.parent_work_attempt_id == null ? null : String(row.parent_work_attempt_id),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
      dispatchBinding: row.dispatch_binding_json
        ? (JSON.parse(String(row.dispatch_binding_json)) as Record<string, unknown>)
        : null,
    };
  }
}
