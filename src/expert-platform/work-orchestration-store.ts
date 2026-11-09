import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkStatus =
  "queued" | "running" | "blocked" | "waiting_review" | "rework" | "completed" | "failed" | "cancelled";

export type WorkAttemptReason = "initial" | "human_rework" | "review_rework" | "policy_replan";
export type WorkAttemptStatus = "active" | "succeeded" | "failed" | "cancelled";

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
  reusedExistingWork?: boolean;
  deduplicationReason?: "idempotency_key" | "source_identity";
}

export interface CreateWorkAttemptInput {
  reason: WorkAttemptReason;
  expertId: string;
  deploymentId: string;
  deploymentConfigVersion: number;
  parentWorkAttemptId?: string;
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
            "title,description,status,state_revision,workflow_id,workflow_version,orchestration_epoch,priority,created_at,updated_at",
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',1,?,?,1,?,?,?)",
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
            "workflow_id,workflow_version,parent_work_attempt_id,started_at",
            ") VALUES(?,?,?,?,'active',?,?,?,?,?,?,?)",
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
    };
  }
}
