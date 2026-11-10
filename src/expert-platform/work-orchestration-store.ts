import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { normalizeVerificationPolicy, type VerificationPolicyStep } from "./verification-policy.js";
import { resolveRuntimeProfilePolicy, type RuntimeProfileId } from "./runtime-profile-policy.js";
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
    requiredRuntimeProfile?: RuntimeProfileId;
    workspace: {
      strategy: "isolated";
      reuseOnContinuation: boolean;
      cleanup: "on_terminal" | "retain";
    };
  };
  validation: { requiredEvidence: string[]; required: VerificationPolicyStep[] };
  review: { humanReview: boolean };
  publication?: { required: boolean; mode: "work_branch" };
  completion: {
    require: Array<
      | "latest_work_attempt_succeeded"
      | "required_evidence_passed"
      | "no_unresolved_blocker"
      | "review_accepted"
      | "required_approvals_approved"
      | "publication_succeeded"
    >;
    requiredApprovals?: Array<
      | { scope: "work_completion"; subjectType: "workspace_revision" }
      | { scope: "publish_work_branch"; subjectType: "publication_artifact" }
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
  deduplicationReason?: "idempotency_key" | "source_identity";
}

export interface WorkOrchestrationClaim {
  workItemId: string;
  ownerId: string;
  epoch: number;
  leaseUntil: number;
  claimedAt: number;
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
  ownerWorkerId: string | null;
  path: string | null;
  repositoryUrl: string | null;
  branch: string | null;
  baseCommit: string | null;
  state: "ready" | "in_use" | "retained" | "cleaning" | "removed" | "failed";
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
  validation: { requiredEvidence: ["expert_result"], required: [] },
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
        "  work_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
        "  owner_worker_id TEXT,",
        "  path TEXT,",
        "  repository_url TEXT,",
        "  branch TEXT,",
        "  base_commit TEXT,",
        "  state TEXT NOT NULL CHECK(state IN ('ready','in_use','retained','cleaning','removed','failed')),",
        "  cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('on_terminal','retain')),",
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
    const workColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>).map((column) => column.name),
    );
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
    const attemptColumns = new Set(
      (this.db.prepare("PRAGMA table_info(work_attempts)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    if (!attemptColumns.has("review_context")) this.db.exec("ALTER TABLE work_attempts ADD COLUMN review_context TEXT");
    if (!attemptColumns.has("what_should_change"))
      this.db.exec("ALTER TABLE work_attempts ADD COLUMN what_should_change TEXT");
    if (!attemptColumns.has("created_by")) this.db.exec("ALTER TABLE work_attempts ADD COLUMN created_by TEXT");
    this.migrateWorkspaceSchema();
    this.ensureWorkspaceCleanupSchema();
  }

  private migrateWorkspaceSchema(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_workspaces'").get() as
      { sql?: string } | undefined;
    const sql = row?.sql ?? "";
    if (sql.includes("'cleaning'") && sql.includes("'retain'")) return;
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        [
          "CREATE TABLE work_workspaces_v2 (",
          " workspace_id TEXT PRIMARY KEY,",
          " workspace_key TEXT NOT NULL UNIQUE,",
          " work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,",
          " work_attempt_id TEXT NOT NULL UNIQUE REFERENCES work_attempts(work_attempt_id) ON DELETE CASCADE,",
          " owner_worker_id TEXT, path TEXT, repository_url TEXT, branch TEXT, base_commit TEXT,",
          " state TEXT NOT NULL CHECK(state IN ('ready','in_use','retained','cleaning','removed','failed')),",
          " cleanup_policy TEXT NOT NULL CHECK(cleanup_policy IN ('on_terminal','retain')),",
          " created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL",
          ");",
          "INSERT INTO work_workspaces_v2 SELECT workspace_id,workspace_key,work_item_id,work_attempt_id,owner_worker_id,path,repository_url,branch,base_commit,state,cleanup_policy,created_at,last_used_at FROM work_workspaces;",
          "DROP TABLE work_workspaces;",
          "ALTER TABLE work_workspaces_v2 RENAME TO work_workspaces;",
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
    this.db
      .prepare("INSERT OR IGNORE INTO work_workflows(workflow_id,version,definition_json,created_at) VALUES(?,?,?,?)")
      .run(DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_VERSION, JSON.stringify(DEFAULT_WORKFLOW), Date.now());
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
    const publication = (definition as { publication?: unknown }).publication;
    if (publication !== undefined) {
      if (
        !publication ||
        typeof publication !== "object" ||
        Array.isArray(publication) ||
        typeof (publication as { required?: unknown }).required !== "boolean" ||
        (publication as { mode?: unknown }).mode !== "work_branch"
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
      definition.publication = {
        required: (publication as { required: boolean }).required,
        mode: "work_branch",
      };
    }
    const requiredRuntimeProfile = definition.execution?.requiredRuntimeProfile;
    if (requiredRuntimeProfile !== undefined) {
      try {
        resolveRuntimeProfilePolicy(requiredRuntimeProfile);
      } catch {
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
    if (definition.publication?.required) {
      if (!requireApproval) throw new Error("INVALID_WORKFLOW");
      if (
        !requiredApprovals.some(
          (item) => item.scope === "publish_work_branch" && item.subjectType === "publication_artifact",
        )
      ) {
        throw new Error("INVALID_WORKFLOW");
      }
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
          "UPDATE work_items SET orchestration_owner_id=?,orchestration_lease_until=?,orchestration_claimed_at=?,orchestration_epoch=? WHERE work_item_id=? AND orchestration_epoch=? AND (orchestration_owner_id IS NULL OR orchestration_lease_until IS NULL OR orchestration_lease_until<=? OR orchestration_owner_id=?)",
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
    input: { repositoryUrl?: string; branch?: string; baseCommit?: string; cleanupPolicy?: "on_terminal" | "retain" },
    now = Date.now(),
  ): WorkspaceRecord {
    const attempt = this.getWorkAttempt(workAttemptId);
    const cleanupPolicy = input.cleanupPolicy ?? "on_terminal";
    if (attempt.workItemId !== workItemId) throw new Error("WORKSPACE_ATTEMPT_MISMATCH");
    const existing = this.db.prepare("SELECT * FROM work_workspaces WHERE work_attempt_id=?").get(workAttemptId) as
      Row | undefined;
    if (existing) {
      if (
        (existing.repository_url ?? null) !== (input.repositoryUrl?.trim() || null) ||
        (existing.branch ?? null) !== (input.branch?.trim() || null) ||
        (existing.base_commit ?? null) !== (input.baseCommit?.trim() || null) ||
        String(existing.cleanup_policy) !== cleanupPolicy
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
          "INSERT INTO work_workspaces(workspace_id,workspace_key,work_item_id,work_attempt_id,repository_url,branch,base_commit,state,cleanup_policy,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,'ready',?,?,?)",
        )
        .run(
          workspaceId,
          workspaceKey,
          workItemId,
          workAttemptId,
          input.repositoryUrl?.trim() || null,
          input.branch?.trim() || null,
          input.baseCommit?.trim() || null,
          cleanupPolicy,
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
      const publicationMatch =
        type === "publication" ? /^publication:([0-9a-f-]{36}):([a-f0-9]{40,64})$/i.exec(subjectRevision) : null;
      const publication = publicationMatch
        ? (this.db
            .prepare(
              "SELECT publication_id,commit_sha,state,source_subject_revision,artifact_ref FROM work_publications WHERE publication_id=? AND work_item_id=?",
            )
            .get(publicationMatch[1]!, workItemId) as Row | undefined)
        : undefined;
      if (
        !publication ||
        publication.state !== "pushed" ||
        String(publication.commit_sha ?? "").toLowerCase() !== publicationMatch![2]!.toLowerCase() ||
        String(publication.source_subject_revision ?? "") !== work.currentSubjectRevision ||
        String(publication.artifact_ref ?? "") !== (input.artifactRef?.trim() || "")
      ) {
        throw new Error("STALE_WORK_SUBJECT");
      }
    }

    const existing = this.db
      .prepare(
        "SELECT * FROM work_evidence WHERE work_item_id=? AND work_attempt_id=? AND type=? AND source=? AND subject_revision=? AND task_id IS ? AND run_id IS ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(
        workItemId,
        input.workAttemptId,
        type,
        input.source,
        subjectRevision,
        input.taskId?.trim() || null,
        input.runId?.trim() || null,
      ) as Row | undefined;
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
          ? (this.db
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
    metadata: { resumeCondition?: string; blockedByType?: string; blockedByRef?: string } = {},
  ): WorkItemRecord {
    const blockedReason = requiredText(reason, 200);
    const resumeCondition = requiredText(metadata.resumeCondition ?? "manual", 500);
    const blockedByType = optionalText(metadata.blockedByType, 200);
    const blockedByRef = optionalText(metadata.blockedByRef, 500);
    if (!blockedReason || !resumeCondition) throw new Error("INVALID_BLOCK_REASON");
    const changed = this.db
      .prepare(
        "UPDATE work_items SET status='blocked',blocked_reason=?,blocked_context=?,blocked_at=?,resume_condition=?,blocked_by_type=?,blocked_by_ref=?,next_action_type=NULL,next_action_at=NULL,next_action_context=NULL,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND principal_id=? AND scope=? AND state_revision=?",
      )
      .run(
        blockedReason,
        context,
        now,
        resumeCondition,
        blockedByType,
        blockedByRef,
        now,
        workItemId,
        principalId,
        scope,
        expectedRevision,
      );
    if (changed.changes !== 1) {
      this.getWork(workItemId, principalId, scope);
      throw new Error("STALE_WORK_REVISION");
    }
    this.event(
      workItemId,
      this.getWorkInternal(workItemId).activeWorkAttemptId,
      "work.blocked",
      JSON.stringify({ reason: blockedReason, resumeCondition, blockedByType, blockedByRef }),
      now,
    );
    return this.getWork(workItemId, principalId, scope);
  }

  resumeBlockedWork(
    workItemId: string,
    principalId: string,
    scope: string,
    expectedRevision: number,
    nextStatus: "queued" | "running",
    now = Date.now(),
  ): WorkItemRecord {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1 ||
      !["queued", "running"].includes(nextStatus)
    ) {
      throw new Error("INVALID_WORK_RESUME");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWork(workItemId, principalId, scope);
      if (current.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
      if (current.status !== "blocked") throw new Error("WORK_NOT_BLOCKED");
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
  ): WorkItemRecord {
    if (actionType !== null && !requiredText(actionType, 100)) throw new Error("INVALID_NEXT_ACTION");
    const normalizedContext = context === null ? null : requiredText(context, 500);
    if (context !== null && !normalizedContext) throw new Error("INVALID_NEXT_ACTION");
    if (dueAt !== null && !Number.isFinite(dueAt)) throw new Error("INVALID_NEXT_ACTION");
    const changed = this.db
      .prepare(
        "UPDATE work_items SET next_action_type=?,next_action_at=?,next_action_context=?,state_revision=state_revision+1,updated_at=? WHERE work_item_id=? AND state_revision=?",
      )
      .run(actionType, dueAt, actionType === null ? null : normalizedContext, now, workItemId, expectedRevision);
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
