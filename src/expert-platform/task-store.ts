import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExpertModelConfig, RepositoryPublicationPolicy, RepositoryVerificationPolicy } from "./expert-store.js";
import {
  normalizeVerificationEvidenceResults,
  normalizeVerificationPolicy,
  type VerificationEvidenceResult,
  type VerificationPolicyStep,
} from "./verification-policy.js";
import { normalizeWorkspaceChangeSummary, type WorkspaceChangeSummary } from "./workspace-change-summary.js";

type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ExpertTaskFeedbackDisposition = "adopted" | "partially_adopted" | "not_adopted";
export type ExpertTaskFeedback = {
  taskId: string;
  disposition: ExpertTaskFeedbackDisposition;
  reason: string | null;
  needsRework: boolean | null;
  updatedAt: number;
};
export type ExpertTaskFeedbackInput = {
  disposition: ExpertTaskFeedbackDisposition;
  reason?: string;
  needsRework?: boolean;
};
export type DeploymentTaskSnapshot = {
  deploymentId: string;
  configVersion: number;
  runtimeProfile: string;
  repository: {
    id: string;
    url: string;
    branch: string;
    credentialRef?: string;
    gitProxyUrl?: string;
    publicationPolicy?: RepositoryPublicationPolicy;
    verificationPolicy?: RepositoryVerificationPolicy;
  } | null;
  executor: { backend: "claude" | "codex"; modelConfig: ExpertModelConfig };
  mcp?: {
    profileRef?: string;
    urlOverride?: string;
    credentialRef: string;
    allowedTools: string[];
    required: boolean;
  };
};

export type TaskExecutionKind = "agent" | "verification";

export type Submission = {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceSessionId?: string;
  sourceClient?: string;
  sourceRequestId?: string;
  problem: string;
  expertId?: string;
  repositoryId?: string;
  selectionMode?: "explicit" | "auto";
  deploymentId?: string;
  sourceRequestSlot?: string;
  schemaVersion?: number;
  deploymentSnapshot?: DeploymentTaskSnapshot;
  workItemId?: string;
  workAttemptId?: string;
  workflowId?: string;
  workflowVersion?: number;
  workspaceKey?: string;
  validationSnapshot?: VerificationPolicyStep[];
  executionKind?: TaskExecutionKind;
};
export type TaskRecord = {
  taskId: string;
  idempotencyKey: string;
  status: TaskStatus;
  result: string | null;
  expertId: string;
  repositoryId: string | null;
  selectionMode: "explicit" | "auto";
  schemaVersion: number;
  executionKind: TaskExecutionKind;
  deploymentId?: string | null;
  deploymentConfigVersion?: number | null;
  deploymentSnapshot?: DeploymentTaskSnapshot | null;
  sourceSessionId?: string | null;
  sourceClient?: string | null;
  sourceRequestId?: string | null;
  repositoryUrl?: string | null;
  repositoryBranch?: string | null;
  commitSha?: string | null;
  cancellationRequested?: boolean;
  workItemId: string | null;
  workAttemptId: string | null;
  workflowId: string | null;
  workflowVersion: number | null;
  workspaceKey: string | null;
  validationSnapshot: VerificationPolicyStep[];
  verificationResults: VerificationEvidenceResult[];
  workspaceChangeSummary: WorkspaceChangeSummary | null;
  requiredWorkerId: string | null;
  continuationCount: number;
  continuationReason: string | null;
  executionRef: string | null;
  executionReservationRef: string | null;
  runtimeSessionId: string | null;
  runId: string | null;
  /** True when this submission reused a task created by an earlier submission. */
  reusedExistingTask?: boolean;
  deduplicationReason?: "idempotency_key" | "same_source_request" | "same_active_session_task";
  /** Oldest queued/running task for this authenticated client session, including this task. */
  activeSessionTaskId?: string;
  activeSessionTaskStatus?: TaskStatus;
};
export type TaskSourceMetadata = { repositoryUrl?: string; repositoryBranch?: string; commitSha?: string };

export type TaskRunTurnRecord = {
  taskId: string;
  runId: string;
  turnIndex: number;
  status: "running" | "succeeded" | "failed";
  startSequence: number | null;
  finishSequence: number | null;
  startedAt: number;
  finishedAt: number | null;
};

export type Claim = {
  taskId: string;
  runId: string;
  workerId: string;
  fencing: number;
  problem: string;
  executionKind?: TaskExecutionKind;
  repositoryId?: string | null;
  repositoryUrl?: string;
  repositoryBranch?: string;
  repositoryCredentialRef?: string;
  repositoryGitProxyUrl?: string;
  modelConfig?: ExpertModelConfig;
  deploymentSnapshot?: DeploymentTaskSnapshot;
  workspaceKey?: string | null;
  validationSnapshot?: VerificationPolicyStep[];
  runtimeSessionId?: string | null;
};
type Row = Record<string, unknown>;
export class ExpertTaskStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS expert_tasks (
        task_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        problem TEXT NOT NULL,
        execution_kind TEXT NOT NULL DEFAULT 'agent' CHECK (execution_kind IN ('agent','verification')),
        source_session_id TEXT,
        source_client TEXT,
        expert_id TEXT NOT NULL DEFAULT 'legacy',
        repository_id TEXT,
        selection_mode TEXT NOT NULL DEFAULT 'explicit' CHECK (selection_mode IN ('explicit','auto')),
        schema_version INTEGER NOT NULL DEFAULT 1,
        repository_url TEXT,
        repository_branch TEXT,
        commit_sha TEXT,
        cancellation_requested INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        result TEXT,
        run_id TEXT,
        worker_id TEXT,
        lease_until INTEGER,
        fencing INTEGER NOT NULL DEFAULT 0,
        UNIQUE(principal_id, scope, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS expert_task_feedback (
        task_id TEXT PRIMARY KEY REFERENCES expert_tasks(task_id),
        disposition TEXT NOT NULL CHECK (disposition IN ('adopted','partially_adopted','not_adopted')),
        reason TEXT,
        needs_rework INTEGER CHECK (needs_rework IN (0,1) OR needs_rework IS NULL),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expert_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES expert_tasks(task_id),
        worker_id TEXT NOT NULL,
        fencing INTEGER NOT NULL,
        status TEXT NOT NULL,
        problem TEXT
      );
      CREATE TABLE IF NOT EXISTS expert_run_turns (
        run_id TEXT NOT NULL REFERENCES expert_runs(run_id),
        task_id TEXT NOT NULL REFERENCES expert_tasks(task_id),
        turn_index INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
        start_sequence INTEGER,
        finish_sequence INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        PRIMARY KEY(run_id,turn_index)
      );
      CREATE TABLE IF NOT EXISTS expert_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES expert_tasks(task_id),
        run_id TEXT,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.ensureEventColumn("details", "TEXT");
    this.ensureEventColumn("source_sequence", "INTEGER");
    this.ensureEventColumn("tool_code", "TEXT");
    this.ensureEventColumn("count", "INTEGER");
    this.ensureTaskColumn("expert_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureTaskColumn(
      "execution_kind",
      "TEXT NOT NULL DEFAULT 'agent' CHECK (execution_kind IN ('agent','verification'))",
    );
    this.ensureTaskColumn("repository_id", "TEXT");
    this.ensureTaskColumn(
      "selection_mode",
      "TEXT NOT NULL DEFAULT 'explicit' CHECK (selection_mode IN ('explicit','auto'))",
    );
    this.ensureTaskColumn("schema_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureTaskColumn("repository_url", "TEXT");
    this.ensureTaskColumn("repository_branch", "TEXT");
    this.ensureTaskColumn("commit_sha", "TEXT");
    this.ensureTaskColumn("cancellation_requested", "INTEGER NOT NULL DEFAULT 0");
    this.ensureTaskColumn("source_session_id", "TEXT");
    this.ensureTaskColumn("source_client", "TEXT");
    this.ensureTaskColumn("source_request_id", "TEXT");
    this.ensureTaskColumn("source_request_slot", "TEXT");
    this.ensureTaskColumn("deployment_id", "TEXT");
    this.ensureTaskColumn("deployment_config_version", "INTEGER");
    this.ensureTaskColumn("deployment_snapshot_json", "TEXT");
    this.ensureTaskColumn("created_at", "INTEGER");
    this.ensureTaskColumn("work_item_id", "TEXT");
    this.ensureTaskColumn("work_attempt_id", "TEXT");
    this.ensureTaskColumn("workflow_id", "TEXT");
    this.ensureTaskColumn("workflow_version", "INTEGER");
    this.ensureTaskColumn("workspace_key", "TEXT");
    this.ensureTaskColumn("validation_snapshot_json", "TEXT");
    this.ensureTaskColumn("verification_results_json", "TEXT");
    this.ensureTaskColumn("workspace_change_summary_json", "TEXT");
    this.ensureTaskColumn("required_worker_id", "TEXT");
    this.ensureTaskColumn("continuation_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureTaskColumn("continuation_reason", "TEXT");
    this.ensureTaskColumn("runtime_session_id", "TEXT");
    this.ensureTaskColumn("execution_problem", "TEXT");
    this.ensureTaskColumn("execution_ref", "TEXT");
    this.ensureTaskColumn("execution_reservation_ref", "TEXT");
    this.db.exec(
      "UPDATE expert_tasks SET execution_reservation_ref=execution_ref WHERE execution_reservation_ref IS NULL AND execution_ref IS NOT NULL",
    );
    this.ensureRunColumn("problem", "TEXT");
    this.db.exec(
      `UPDATE expert_runs
       SET problem=(
         SELECT CASE
           WHEN task.continuation_reason IS NULL
             THEN COALESCE(task.execution_problem,task.problem)
           ELSE COALESCE(task.execution_problem,task.problem) || char(10) || char(10) || 'Continuation context:' || char(10) || task.continuation_reason
         END
         FROM expert_tasks AS task
         WHERE task.run_id=expert_runs.run_id AND task.status<>'queued'
       )
       WHERE problem IS NULL
         AND EXISTS (
           SELECT 1 FROM expert_tasks AS task
           WHERE task.run_id=expert_runs.run_id AND task.status<>'queued'
         )`,
    );
    // Older tasks already have a queued lifecycle event created at submission time.
    // Backfill from that event so the new history column remains useful after upgrade.
    this.db.exec(
      `UPDATE expert_tasks SET created_at=(SELECT MIN(created_at) FROM expert_events WHERE expert_events.task_id=expert_tasks.task_id) WHERE created_at IS NULL`,
    );
    // Enforce the per-task retention policy for databases upgraded from older versions.
    this.db.exec(`DELETE FROM expert_events WHERE event_id NOT IN (
      SELECT event_id FROM expert_events AS recent
      WHERE recent.task_id=expert_events.task_id ORDER BY event_id DESC LIMIT 1000
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_expert_task_run ON expert_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_expert_run_turn_task ON expert_run_turns(task_id,run_id,turn_index);
      CREATE INDEX IF NOT EXISTS idx_expert_event_task ON expert_events(task_id,event_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_expert_event_run_seq ON expert_events(run_id,source_sequence) WHERE source_sequence IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_expert_task_status ON expert_tasks(status,expert_id);
      CREATE INDEX IF NOT EXISTS idx_expert_task_source_request ON expert_tasks(principal_id,scope,source_client,source_session_id,source_request_id,source_request_slot,status);
      CREATE INDEX IF NOT EXISTS idx_expert_task_created_at ON expert_tasks(created_at DESC);`);
  }

  findActiveSourceRequest(
    input: Pick<
      Submission,
      | "principalId"
      | "scope"
      | "sourceClient"
      | "sourceSessionId"
      | "sourceRequestId"
      | "repositoryId"
      | "sourceRequestSlot"
    >,
  ): TaskRecord | null {
    const sourceSessionId = input.sourceSessionId?.trim();
    const sourceClient = input.sourceClient?.trim();
    const sourceRequestId = input.sourceRequestId?.trim();
    if (!sourceSessionId || !sourceClient || !sourceRequestId || !/^srq_[a-f0-9]{64}$/.test(sourceRequestId))
      return null;
    const sourceRequestSlot = input.sourceRequestSlot ?? JSON.stringify(["auto", input.repositoryId ?? null]);
    const row = this.db
      .prepare(
        `SELECT * FROM expert_tasks
       WHERE principal_id=? AND scope=? AND source_client=? AND source_session_id=?
         AND source_request_id=? AND source_request_slot=?
         AND status IN ('queued','running') ORDER BY rowid LIMIT 1`,
      )
      .get(input.principalId, input.scope, sourceClient, sourceSessionId, sourceRequestId, sourceRequestSlot) as
      Row | undefined;
    if (!row) return null;
    const active = this.db
      .prepare(
        `SELECT task_id,status FROM expert_tasks
       WHERE principal_id=? AND scope=? AND source_client=? AND source_session_id=?
         AND status IN ('queued','running')
       ORDER BY CASE WHEN created_at IS NULL THEN 1 ELSE 0 END, created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(input.principalId, input.scope, sourceClient, sourceSessionId) as
      { task_id: string; status: TaskStatus } | undefined;
    return {
      ...this.fromRow(row),
      reusedExistingTask: true,
      deduplicationReason: "same_source_request",
      ...(active ? { activeSessionTaskId: String(active.task_id), activeSessionTaskStatus: active.status } : {}),
    };
  }

  submit(input: Submission): TaskRecord {
    if (!input.problem.trim() || !input.principalId.trim() || !input.scope.trim() || !input.idempotencyKey.trim()) {
      throw new Error("INVALID_REQUEST");
    }
    const sourceSessionId = input.sourceSessionId?.trim() || null;
    const sourceClient = input.sourceClient?.trim() || null;
    const sourceRequestId = input.sourceRequestId?.trim() || null;
    if (sourceRequestId && (!/^srq_[a-f0-9]{64}$/.test(sourceRequestId) || !sourceSessionId || !sourceClient))
      throw new Error("INVALID_SOURCE_REQUEST_ID");
    if (
      (sourceSessionId && (sourceSessionId.length > 200 || !sourceClient || sourceClient.length > 200)) ||
      (!sourceSessionId && sourceClient && sourceClient.length > 200)
    )
      throw new Error("INVALID_REQUEST");
    const expertId = input.expertId?.trim() || "legacy";
    const repositoryId = input.repositoryId?.trim() || null;
    const selectionMode = input.selectionMode ?? "explicit";
    const schemaVersion = input.schemaVersion ?? (input.deploymentSnapshot ? 2 : 1);
    const executionKind = input.executionKind ?? "agent";
    const snapshot = input.deploymentSnapshot;
    const sourceRequestSlot =
      input.sourceRequestSlot ??
      (selectionMode === "auto"
        ? JSON.stringify(["auto", repositoryId ?? null])
        : JSON.stringify([expertId, repositoryId, snapshot?.deploymentId ?? input.deploymentId ?? null]));
    if (
      snapshot &&
      (!snapshot.deploymentId ||
        !Number.isSafeInteger(snapshot.configVersion) ||
        snapshot.configVersion < 1 ||
        !snapshot.executor ||
        !snapshot.repository ||
        snapshot.repository.id !== repositoryId ||
        schemaVersion !== 2)
    )
      throw new Error("INVALID_DEPLOYMENT_SNAPSHOT");
    if (!snapshot && schemaVersion === 2) throw new Error("INVALID_DEPLOYMENT_SNAPSHOT");
    if (
      (selectionMode !== "explicit" && selectionMode !== "auto") ||
      (executionKind !== "agent" && executionKind !== "verification") ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion <= 0
    ) {
      throw new Error("INVALID_REQUEST");
    }
    const workLinkValues = [input.workItemId, input.workAttemptId, input.workflowId, input.workflowVersion];
    if (input.workspaceKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.workspaceKey)) {
      throw new Error("INVALID_WORKSPACE_KEY");
    }
    const validationSnapshot = normalizeVerificationPolicy(input.validationSnapshot);
    if (
      workLinkValues.some((value) => value !== undefined) &&
      (!input.workItemId?.trim() ||
        !input.workAttemptId?.trim() ||
        !input.workflowId?.trim() ||
        !Number.isSafeInteger(input.workflowVersion) ||
        Number(input.workflowVersion) < 1)
    ) {
      throw new Error("INVALID_WORK_LINK");
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          problem: input.problem,
          expertId,
          repositoryId,
          selectionMode,
          schemaVersion,
          executionKind,
          workItemId: input.workItemId?.trim() || null,
          workAttemptId: input.workAttemptId?.trim() || null,
          workflowId: input.workflowId?.trim() || null,
          workflowVersion: input.workflowVersion ?? null,
          workspaceKey: input.workspaceKey?.trim() || null,
          validationSnapshot,
          ...(snapshot
            ? {
                deploymentId: snapshot.deploymentId,
                deploymentConfigVersion: snapshot.configVersion,
                deploymentSnapshot: snapshot,
              }
            : {}),
        }),
      )
      .digest("hex");
    const taskId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const activeSessionTask = (): Pick<TaskRecord, "activeSessionTaskId" | "activeSessionTaskStatus"> => {
        if (!sourceSessionId) return {};
        const active = this.db
          .prepare(
            `SELECT task_id,status FROM expert_tasks
             WHERE principal_id=? AND scope=? AND source_client=? AND source_session_id=?
               AND status IN ('queued','running')
             ORDER BY CASE WHEN created_at IS NULL THEN 1 ELSE 0 END, created_at ASC, rowid ASC LIMIT 1`,
          )
          .get(input.principalId, input.scope, sourceClient, sourceSessionId) as
          { task_id: string; status: TaskStatus } | undefined;
        return active ? { activeSessionTaskId: String(active.task_id), activeSessionTaskStatus: active.status } : {};
      };
      const existing = this.db
        .prepare("SELECT * FROM expert_tasks WHERE principal_id=? AND scope=? AND idempotency_key=?")
        .get(input.principalId, input.scope, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.request_digest !== digest) throw new Error("IDEMPOTENCY_CONFLICT");
        const record = this.fromRow(existing);
        const sessionTask = activeSessionTask();
        this.db.exec("COMMIT");
        return {
          ...record,
          reusedExistingTask: true,
          deduplicationReason: "idempotency_key",
          ...sessionTask,
        };
      }
      // A trusted source request ID identifies one native user turn. Reuse only
      // the same delegation slot while it is active; auto-routing is one slot,
      // while explicit expert/repository/deployment requests remain independent.
      if (sourceSessionId && sourceRequestId) {
        const duplicate = this.db
          .prepare(
            `SELECT * FROM expert_tasks
             WHERE principal_id=? AND scope=? AND source_client=? AND source_session_id=?
               AND source_request_id=? AND source_request_slot=?
               AND status IN ('queued','running') ORDER BY rowid LIMIT 1`,
          )
          .get(input.principalId, input.scope, sourceClient, sourceSessionId, sourceRequestId, sourceRequestSlot) as
          Row | undefined;
        if (duplicate) {
          const record = this.fromRow(duplicate);
          const sessionTask = activeSessionTask();
          this.db.exec("COMMIT");
          return { ...record, reusedExistingTask: true, deduplicationReason: "same_source_request", ...sessionTask };
        }
      }
      // Legacy fallback for clients without a trusted source request ID.
      if (sourceSessionId) {
        const duplicate = this.db
          .prepare(
            `SELECT * FROM expert_tasks
          WHERE principal_id=? AND scope=? AND source_client=? AND source_session_id=?
            AND expert_id=? AND repository_id IS ? AND problem=? AND request_digest=?
            AND status IN ('queued','running') ORDER BY rowid LIMIT 1`,
          )
          .get(
            input.principalId,
            input.scope,
            sourceClient,
            sourceSessionId,
            expertId,
            repositoryId,
            input.problem.trim(),
            digest,
          ) as Row | undefined;
        if (duplicate) {
          const record = this.fromRow(duplicate);
          const sessionTask = activeSessionTask();
          this.db.exec("COMMIT");
          return {
            ...record,
            reusedExistingTask: true,
            deduplicationReason: "same_active_session_task",
            ...sessionTask,
          };
        }
      }
      this.db
        .prepare(
          "INSERT INTO expert_tasks(task_id,principal_id,scope,idempotency_key,request_digest,problem,execution_kind,expert_id,repository_id,selection_mode,schema_version,source_session_id,source_client,source_request_id,source_request_slot,deployment_id,deployment_config_version,deployment_snapshot_json,work_item_id,work_attempt_id,workflow_id,workflow_version,workspace_key,validation_snapshot_json,created_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued')",
        )
        .run(
          taskId,
          input.principalId,
          input.scope,
          input.idempotencyKey,
          digest,
          input.problem.trim(),
          executionKind,
          expertId,
          repositoryId,
          selectionMode,
          schemaVersion,
          sourceSessionId,
          sourceClient,
          sourceRequestId,
          sourceRequestId ? sourceRequestSlot : null,
          snapshot?.deploymentId ?? input.deploymentId ?? null,
          snapshot?.configVersion ?? null,
          snapshot ? JSON.stringify(snapshot) : null,
          input.workItemId?.trim() || null,
          input.workAttemptId?.trim() || null,
          input.workflowId?.trim() || null,
          input.workflowVersion ?? null,
          input.workspaceKey?.trim() || null,
          JSON.stringify(validationSnapshot),
          Date.now(),
        );
      this.event(taskId, null, "queued");
      const sessionTask = activeSessionTask();
      this.db.exec("COMMIT");
      return {
        taskId,
        idempotencyKey: input.idempotencyKey,
        status: "queued",
        result: null,
        expertId,
        repositoryId,
        selectionMode,
        schemaVersion,
        executionKind,
        ...(snapshot
          ? {
              deploymentId: snapshot.deploymentId,
              deploymentConfigVersion: snapshot.configVersion,
              deploymentSnapshot: snapshot,
            }
          : input.deploymentId
            ? { deploymentId: input.deploymentId }
            : {}),
        sourceSessionId,
        sourceClient,
        sourceRequestId,
        workItemId: input.workItemId?.trim() || null,
        workAttemptId: input.workAttemptId?.trim() || null,
        workflowId: input.workflowId?.trim() || null,
        workflowVersion: input.workflowVersion ?? null,
        workspaceKey: input.workspaceKey?.trim() || null,
        validationSnapshot,
        verificationResults: [],
        workspaceChangeSummary: null,
        requiredWorkerId: null,
        reusedExistingTask: false,
        continuationCount: 0,
        continuationReason: null,
        executionRef: null,
        executionReservationRef: null,
        runtimeSessionId: null,
        runId: null,
        ...sessionTask,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claim(
    workerId: string,
    now = Date.now(),
    leaseMs = 30_000,
    expertId?: string,
    compatibility?: { backend?: "claude" | "codex"; runtimeProfiles: string[] },
  ): Claim | null {
    if (!workerId || !Number.isFinite(now) || leaseMs <= 0) throw new Error("INVALID_REQUEST");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const profiles = compatibility?.runtimeProfiles ?? [];
      const supportsV2 =
        compatibility?.backend !== undefined &&
        ["claude", "codex"].includes(compatibility.backend) &&
        profiles.length > 0 &&
        profiles.every((profile) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(profile));
      const compatibilitySql = supportsV2
        ? `AND (t.schema_version < 2 OR
            (t.schema_version = 2 AND
              json_extract(t.deployment_snapshot_json,'$.executor.backend') = ? AND
              json_extract(t.deployment_snapshot_json,'$.runtimeProfile') IN (${profiles.map(() => "?").join(",")})))`
        : "AND t.schema_version < 2";
      const compatibilityArgs = supportsV2 ? [compatibility!.backend!, ...profiles] : [];
      const row = expertId
        ? (this.db
            .prepare(
              `SELECT * FROM expert_tasks AS t WHERE expert_id=? AND (status='queued' OR (status='running' AND lease_until < ?))
                AND (t.required_worker_id IS NULL OR t.required_worker_id=?)
                ${compatibilitySql}
                AND NOT EXISTS (SELECT 1 FROM expert_tasks AS earlier
                  WHERE t.source_session_id IS NOT NULL AND earlier.rowid < t.rowid
                    AND earlier.scope=t.scope AND earlier.principal_id=t.principal_id
                    AND earlier.source_client=t.source_client AND earlier.source_session_id=t.source_session_id
                    AND earlier.expert_id=t.expert_id AND earlier.status IN ('queued','running'))
                ORDER BY t.rowid LIMIT 1`,
            )
            .get(expertId, now, workerId, ...compatibilityArgs) as Row | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM expert_tasks AS t WHERE (status='queued' OR (status='running' AND lease_until < ?))
                AND (t.required_worker_id IS NULL OR t.required_worker_id=?)
                ${compatibilitySql}
                AND NOT EXISTS (SELECT 1 FROM expert_tasks AS earlier
                  WHERE t.source_session_id IS NOT NULL AND earlier.rowid < t.rowid
                    AND earlier.scope=t.scope AND earlier.principal_id=t.principal_id
                    AND earlier.source_client=t.source_client AND earlier.source_session_id=t.source_session_id
                    AND earlier.expert_id=t.expert_id AND earlier.status IN ('queued','running'))
                ORDER BY t.rowid LIMIT 1`,
            )
            .get(now, workerId, ...compatibilityArgs) as Row | undefined);
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const taskId = String(row.task_id);
      // A task may be reclaimed only after its lease expires. Close the previous
      // run in the same transaction so run history cannot leave it looking active.
      if (row.status === "running" && row.run_id != null) {
        const expiredRunId = String(row.run_id);
        this.db
          .prepare("UPDATE expert_runs SET status='expired' WHERE run_id=? AND status='running'")
          .run(expiredRunId);
        this.event(taskId, expiredRunId, "lease_expired");
      }
      const runId = randomUUID();
      const fencing = Number(row.fencing) + 1;
      const executionProblem = row.execution_problem == null ? String(row.problem) : String(row.execution_problem);
      const claimProblem =
        row.continuation_reason == null
          ? executionProblem
          : executionProblem + "\n\nContinuation context:\n" + String(row.continuation_reason);
      this.db
        .prepare(
          "UPDATE expert_tasks SET status='running',run_id=?,worker_id=?,lease_until=?,fencing=? WHERE task_id=?",
        )
        .run(runId, workerId, now + leaseMs, fencing, taskId);
      this.db
        .prepare(
          "INSERT INTO expert_runs(run_id,task_id,worker_id,fencing,status,problem) VALUES (?,?,?,?,'running',?)",
        )
        .run(runId, taskId, workerId, fencing, claimProblem);
      this.event(taskId, runId, "running");
      this.db.exec("COMMIT");
      return {
        taskId,
        runId,
        workerId,
        fencing,
        problem: claimProblem,
        executionKind: (row.execution_kind ?? "agent") as TaskExecutionKind,
        repositoryId: row.repository_id == null ? null : String(row.repository_id),
        workspaceKey: row.workspace_key == null ? null : String(row.workspace_key),
        validationSnapshot: normalizeVerificationPolicy(
          row.validation_snapshot_json ? JSON.parse(String(row.validation_snapshot_json)) : [],
        ),
        runtimeSessionId: row.runtime_session_id == null ? null : String(row.runtime_session_id),
        ...(row.deployment_snapshot_json
          ? { deploymentSnapshot: JSON.parse(String(row.deployment_snapshot_json)) as DeploymentTaskSnapshot }
          : {}),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(
    claim: Claim,
    result: string,
    now = Date.now(),
    sourceMetadata?: TaskSourceMetadata,
    verificationResultsInput?: VerificationEvidenceResult[],
    workspaceChangeSummaryInput?: WorkspaceChangeSummary,
    runtimeSessionIdInput?: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const source = sourceMetadata ?? parseSourceMetadata(result) ?? undefined;
      const verificationResults = normalizeVerificationEvidenceResults(verificationResultsInput);
      const workspaceChangeSummary =
        workspaceChangeSummaryInput === undefined ? null : normalizeWorkspaceChangeSummary(workspaceChangeSummaryInput);
      const runtimeSessionId =
        runtimeSessionIdInput === undefined
          ? null
          : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(runtimeSessionIdInput.trim())
            ? runtimeSessionIdInput.trim()
            : (() => {
                throw new Error("INVALID_RUNTIME_SESSION_ID");
              })();
      const currentSession = this.db
        .prepare(
          "SELECT runtime_session_id FROM expert_tasks WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running'",
        )
        .get(claim.taskId, claim.runId, claim.workerId, claim.fencing) as Row | undefined;
      if (!currentSession) throw new Error("STALE_ATTEMPT");
      if (
        runtimeSessionId &&
        currentSession.runtime_session_id != null &&
        String(currentSession.runtime_session_id) !== runtimeSessionId
      ) {
        throw new Error("RUNTIME_SESSION_MISMATCH");
      }
      if (workspaceChangeSummary && (!source?.commitSha || workspaceChangeSummary.baseCommit !== source.commitSha)) {
        throw new Error("WORKSPACE_CHANGE_BASE_MISMATCH");
      }
      const expectedVerificationSubject = workspaceChangeSummary
        ? `workspace:${workspaceChangeSummary.contentRevision}`
        : source?.commitSha;
      if (
        verificationResults.length > 0 &&
        (!expectedVerificationSubject ||
          verificationResults.some((item) => item.subjectRevision !== expectedVerificationSubject))
      ) {
        throw new Error("VERIFICATION_SUBJECT_MISMATCH");
      }
      const changed = this.db
        .prepare(
          "UPDATE expert_tasks SET status='succeeded',result=?,repository_url=COALESCE(?,repository_url),repository_branch=COALESCE(?,repository_branch),commit_sha=COALESCE(?,commit_sha),verification_results_json=?,workspace_change_summary_json=?,runtime_session_id=COALESCE(?,runtime_session_id),lease_until=NULL WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND cancellation_requested=0 AND lease_until>=?",
        )
        .run(
          result,
          source?.repositoryUrl ?? null,
          source?.repositoryBranch ?? null,
          source?.commitSha ?? null,
          JSON.stringify(verificationResults),
          workspaceChangeSummary ? JSON.stringify(workspaceChangeSummary) : null,
          runtimeSessionId,
          claim.taskId,
          claim.runId,
          claim.workerId,
          claim.fencing,
          now,
        );
      if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
      this.db.prepare("UPDATE expert_runs SET status='succeeded' WHERE run_id=?").run(claim.runId);
      this.closeActiveRunTurn(claim.runId, "succeeded", now);
      this.event(claim.taskId, claim.runId, "succeeded");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renew(claim: Claim, now = Date.now(), leaseMs = 30_000): boolean {
    if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("INVALID_REQUEST");
    }
    const changed = this.db
      .prepare(
        "UPDATE expert_tasks SET lease_until=? WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
      )
      .run(now + leaseMs, claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
    if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
    return this.cancellationRequested(claim);
  }

  fail(claim: Claim, reason: string, now = Date.now()): void {
    if (!reason.trim()) throw new Error("INVALID_REQUEST");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT cancellation_requested FROM expert_tasks WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running'",
        )
        .get(claim.taskId, claim.runId, claim.workerId, claim.fencing) as Row | undefined;
      const terminalStatus =
        reason === "TASK_CANCELLED" && Number(current?.cancellation_requested ?? 0) === 1 ? "cancelled" : "failed";
      const changed = this.db
        .prepare(
          "UPDATE expert_tasks SET status=?,result=?,lease_until=NULL WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
        )
        .run(terminalStatus, reason, claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
      if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
      this.db.prepare("UPDATE expert_runs SET status=? WHERE run_id=?").run(terminalStatus, claim.runId);
      this.closeActiveRunTurn(claim.runId, "failed", now);
      this.event(claim.taskId, claim.runId, terminalStatus);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reserveExecutionRef(taskId: string, executionRef: string, expectedReservationRef: string | null): TaskRecord | null {
    const normalizedExecutionRef = executionRef.trim();
    if (!normalizedExecutionRef) throw new Error("INVALID_EXECUTION_REF");
    const expected = expectedReservationRef?.trim() || null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row | undefined;
      if (!row) throw new Error("TASK_NOT_FOUND");
      const current = row.execution_reservation_ref == null ? null : String(row.execution_reservation_ref);
      if (current === normalizedExecutionRef) {
        this.db.exec("COMMIT");
        return this.fromRow(row);
      }
      if (current !== expected || (row.status !== "succeeded" && row.status !== "failed")) {
        this.db.exec("COMMIT");
        return null;
      }
      const changed =
        expected === null
          ? this.db
              .prepare(
                "UPDATE expert_tasks SET execution_reservation_ref=? WHERE task_id=? AND execution_reservation_ref IS NULL AND status IN ('succeeded','failed')",
              )
              .run(normalizedExecutionRef, taskId)
          : this.db
              .prepare(
                "UPDATE expert_tasks SET execution_reservation_ref=? WHERE task_id=? AND execution_reservation_ref=? AND status IN ('succeeded','failed')",
              )
              .run(normalizedExecutionRef, taskId, expected);
      if (changed.changes !== 1) {
        this.db.exec("COMMIT");
        return null;
      }
      const updated = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row;
      this.db.exec("COMMIT");
      return this.fromRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requeueForRetry(
    taskId: string,
    expectedWorkAttemptId: string,
    reason: string,
    now = Date.now(),
    problem?: string,
    executionRef?: string,
  ): TaskRecord {
    const workAttemptId = expectedWorkAttemptId.trim();
    if (!workAttemptId || !reason.trim()) throw new Error("INVALID_REQUEST");
    const normalizedProblem = problem?.trim() || null;
    const normalizedExecutionRef = executionRef?.trim() || null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row | undefined;
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.work_attempt_id == null || String(row.work_attempt_id) !== workAttemptId) {
        throw new Error("STALE_WORK_ATTEMPT");
      }
      if (row.status !== "failed") throw new Error("TASK_RETRY_NOT_ALLOWED");
      this.db
        .prepare(
          "UPDATE expert_tasks SET status='queued',result=NULL,run_id=NULL,worker_id=NULL,lease_until=NULL,cancellation_requested=0,execution_problem=COALESCE(?,execution_problem),execution_ref=COALESCE(?,execution_ref),execution_reservation_ref=COALESCE(?,execution_reservation_ref) WHERE task_id=? AND status='failed' AND work_attempt_id=?",
        )
        .run(normalizedProblem, normalizedExecutionRef, normalizedExecutionRef, taskId, workAttemptId);
      this.event(taskId, null, "retry_queued");
      const updated = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row;
      this.db.exec("COMMIT");
      return this.fromRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  scheduleContinuation(
    taskId: string,
    expectedRunId: string,
    reason: string,
    now = Date.now(),
    requiredWorkerId?: string,
    problem?: string,
    executionRef?: string,
  ): TaskRecord {
    const runId = expectedRunId.trim();
    if (!runId || !reason.trim()) throw new Error("INVALID_REQUEST");
    const normalizedWorker = requiredWorkerId?.trim() || null;
    const normalizedProblem = problem?.trim() || null;
    const normalizedExecutionRef = executionRef?.trim() || null;
    if (normalizedWorker && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(normalizedWorker)) {
      throw new Error("INVALID_WORKER");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row | undefined;
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.status !== "succeeded") throw new Error("TASK_CONTINUATION_NOT_ALLOWED");
      if (row.run_id == null || String(row.run_id) !== runId) throw new Error("STALE_RUN");
      const changed = this.db
        .prepare(
          "UPDATE expert_tasks SET status='queued',result=NULL,worker_id=NULL,lease_until=NULL,cancellation_requested=0,continuation_count=continuation_count+1,continuation_reason=?,required_worker_id=?,execution_problem=COALESCE(?,execution_problem),execution_ref=COALESCE(?,execution_ref),execution_reservation_ref=COALESCE(?,execution_reservation_ref) WHERE task_id=? AND status='succeeded' AND run_id=?",
        )
        .run(
          reason.trim().slice(0, 200),
          normalizedWorker,
          normalizedProblem,
          normalizedExecutionRef,
          normalizedExecutionRef,
          taskId,
          runId,
        );
      if (changed.changes !== 1) throw new Error("TASK_CONTINUATION_NOT_ALLOWED");
      this.event(taskId, runId, "continuation_queued");
      const updated = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row;
      this.db.exec("COMMIT");
      return this.fromRow(updated);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requireWorker(taskId: string, workerId: string): TaskRecord {
    const normalizedWorker = workerId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(normalizedWorker)) throw new Error("INVALID_WORKER");
    const changed = this.db
      .prepare("UPDATE expert_tasks SET required_worker_id=? WHERE task_id=? AND status='queued'")
      .run(normalizedWorker, taskId);
    if (changed.changes !== 1) throw new Error("TASK_WORKER_AFFINITY_NOT_ALLOWED");
    const row = this.db.prepare("SELECT * FROM expert_tasks WHERE task_id=?").get(taskId) as Row;
    return this.fromRow(row);
  }

  runCount(taskId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM expert_runs WHERE task_id=?").get(taskId) as { n: number };
    return Number(row.n);
  }

  getByIdempotency(principalId: string, scope: string, idempotencyKey: string): TaskRecord | null {
    const key = idempotencyKey.trim();
    if (!principalId.trim() || !scope.trim() || !key) throw new Error("INVALID_REQUEST");
    const row = this.db
      .prepare("SELECT * FROM expert_tasks WHERE principal_id=? AND scope=? AND idempotency_key=?")
      .get(principalId, scope, key) as Row | undefined;
    return row ? this.fromRow(row) : null;
  }

  get(taskId: string, principalId: string, scope: string): TaskRecord {
    const row = this.db
      .prepare("SELECT * FROM expert_tasks WHERE task_id=? AND principal_id=? AND scope=?")
      .get(taskId, principalId, scope) as Row | undefined;
    if (!row) throw new Error("TASK_NOT_FOUND_OR_FORBIDDEN");
    return this.fromRow(row);
  }

  getFeedback(taskId: string, principalId: string, scope: string): ExpertTaskFeedback | null {
    this.get(taskId, principalId, scope);
    const row = this.db
      .prepare("SELECT task_id,disposition,reason,needs_rework,updated_at FROM expert_task_feedback WHERE task_id=?")
      .get(taskId) as Row | undefined;
    return row ? this.feedbackFromRow(row) : null;
  }

  submitFeedback(
    taskId: string,
    principalId: string,
    scope: string,
    input: ExpertTaskFeedbackInput,
    now = Date.now(),
  ): ExpertTaskFeedback {
    if (!["adopted", "partially_adopted", "not_adopted"].includes(input.disposition))
      throw new Error("INVALID_FEEDBACK_DISPOSITION");
    const reason = input.reason?.trim() || null;
    if (reason && reason.length > 4000) throw new Error("INVALID_FEEDBACK_REASON");
    if (input.needsRework !== undefined && typeof input.needsRework !== "boolean")
      throw new Error("INVALID_FEEDBACK_REWORK");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.db
        .prepare("SELECT status FROM expert_tasks WHERE task_id=? AND principal_id=? AND scope=?")
        .get(taskId, principalId, scope) as { status: string } | undefined;
      if (!task) throw new Error("TASK_NOT_FOUND_OR_FORBIDDEN");
      if (task.status !== "succeeded") throw new Error("TASK_FEEDBACK_NOT_ALLOWED");
      this.db
        .prepare(
          `INSERT INTO expert_task_feedback(task_id,disposition,reason,needs_rework,updated_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(task_id) DO UPDATE SET disposition=excluded.disposition,reason=excluded.reason,needs_rework=excluded.needs_rework,updated_at=excluded.updated_at`,
        )
        .run(
          taskId,
          input.disposition,
          reason,
          input.needsRework === undefined ? null : input.needsRework ? 1 : 0,
          now,
        );
      const row = this.db
        .prepare("SELECT task_id,disposition,reason,needs_rework,updated_at FROM expert_task_feedback WHERE task_id=?")
        .get(taskId) as Row;
      this.db.exec("COMMIT");
      return this.feedbackFromRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancel(taskId: string, principalId: string, scope: string): TaskRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT status,run_id FROM expert_tasks WHERE task_id=? AND principal_id=? AND scope=?")
        .get(taskId, principalId, scope) as Row | undefined;
      if (!row) throw new Error("TASK_NOT_FOUND_OR_FORBIDDEN");
      if (row.status === "queued") {
        this.db.prepare("UPDATE expert_tasks SET status='cancelled' WHERE task_id=? AND status='queued'").run(taskId);
        this.event(taskId, null, "cancelled");
      } else if (row.status === "running") {
        const changed = this.db
          .prepare(
            "UPDATE expert_tasks SET cancellation_requested=1 WHERE task_id=? AND status='running' AND cancellation_requested=0",
          )
          .run(taskId);
        if (changed.changes === 1)
          this.event(taskId, row.run_id == null ? null : String(row.run_id), "cancellation_requested");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(taskId, principalId, scope);
  }

  /** Admin stop: queued tasks become cancelled; running tasks are signalled to their Worker. */
  adminStopTask(taskId: string): "cancelled" | "cancellation_requested" | "already_requested" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT status,run_id,cancellation_requested FROM expert_tasks WHERE task_id=?")
        .get(taskId) as { status: string; run_id: string | null; cancellation_requested: number } | undefined;
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.status !== "queued" && row.status !== "running") throw new Error("TASK_NOT_ACTIVE");
      let outcome: "cancelled" | "cancellation_requested" | "already_requested";
      if (row.status === "queued") {
        this.db.prepare("UPDATE expert_tasks SET status='cancelled' WHERE task_id=?").run(taskId);
        this.event(taskId, null, "cancelled");
        outcome = "cancelled";
      } else if (row.cancellation_requested) {
        outcome = "already_requested";
      } else {
        this.db.prepare("UPDATE expert_tasks SET cancellation_requested=1 WHERE task_id=?").run(taskId);
        this.event(taskId, row.run_id, "cancellation_requested");
        outcome = "cancellation_requested";
      }
      this.db.exec("COMMIT");
      return outcome;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Admin hard-delete: only terminal tasks, including their event/run history. */
  adminDeleteTask(taskId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status FROM expert_tasks WHERE task_id=?").get(taskId) as
        { status: string } | undefined;
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (!["succeeded", "failed", "cancelled"].includes(row.status)) throw new Error("TASK_NOT_TERMINAL");
      this.db.prepare("DELETE FROM expert_task_feedback WHERE task_id=?").run(taskId);
      this.db.prepare("DELETE FROM expert_events WHERE task_id=?").run(taskId);
      this.db.prepare("DELETE FROM expert_runs WHERE task_id=?").run(taskId);
      this.db.prepare("DELETE FROM expert_tasks WHERE task_id=?").run(taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cancellationRequested(claim: Claim): boolean {
    const row = this.db
      .prepare(
        "SELECT cancellation_requested FROM expert_tasks WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running'",
      )
      .get(claim.taskId, claim.runId, claim.workerId, claim.fencing) as Row | undefined;
    if (!row) throw new Error("STALE_ATTEMPT");
    return Number(row.cancellation_requested) === 1;
  }

  close(): void {
    this.db.close();
  }

  /** Admin-only: bounded, parameterized task index with no result-body disclosure. */
  adminTasks(
    query: { limit?: number; offset?: number; status?: string; expertId?: string; workerId?: string; q?: string } = {},
  ) {
    const limit = Number.isFinite(query.limit) ? Math.min(100, Math.max(1, Math.floor(query.limit!))) : 20;
    const offset = Number.isFinite(query.offset) ? Math.min(100000, Math.max(0, Math.floor(query.offset!))) : 0;
    const where: string[] = [];
    const args: string[] = [];
    if (query.status) {
      where.push("status=?");
      args.push(query.status);
    }
    if (query.expertId) {
      where.push("expert_id=?");
      args.push(query.expertId);
    }
    if (query.workerId) {
      where.push("worker_id=?");
      args.push(query.workerId);
    }
    if (query.q) {
      where.push("(task_id LIKE ? OR expert_id LIKE ? OR repository_id LIKE ?)");
      args.push(...Array(3).fill(`%${query.q.slice(0, 100).replace(/[%_]/g, "")}%`));
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = Number(
      (this.db.prepare("SELECT count(*) n FROM expert_tasks" + clause).get(...args) as { n: number }).n,
    );
    const rows = this.db
      .prepare(
        `SELECT task_id,principal_id,scope,expert_id,repository_id,selection_mode,status,run_id,worker_id,fencing,repository_url,repository_branch,commit_sha,created_at FROM expert_tasks${clause} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return { total, limit, offset, tasks: rows };
  }

  adminTaskDetail(taskId: string, query: { limit?: number; offset?: number } = {}) {
    const limit = Number.isFinite(query.limit) ? Math.min(100, Math.max(1, Math.floor(query.limit!))) : 50;
    const offset = Number.isFinite(query.offset) ? Math.min(1000 - limit, Math.max(0, Math.floor(query.offset!))) : 0;
    const task = this.db
      .prepare(
        "SELECT task_id,principal_id,scope,source_client,source_session_id,problem,expert_id,repository_id,selection_mode,status,result,run_id,worker_id,fencing,repository_url,repository_branch,commit_sha,deployment_id,deployment_config_version,deployment_snapshot_json,created_at,cancellation_requested,work_item_id FROM expert_tasks WHERE task_id=?",
      )
      .get(taskId);
    if (!task) return null;
    const feedbackRow = this.db
      .prepare("SELECT task_id,disposition,reason,needs_rework,updated_at FROM expert_task_feedback WHERE task_id=?")
      .get(taskId) as Row | undefined;
    const runs = this.db
      .prepare("SELECT run_id,task_id,worker_id,fencing,status,problem FROM expert_runs WHERE task_id=? ORDER BY rowid")
      .all(taskId);
    const total = Number(
      (this.db.prepare("SELECT count(*) AS n FROM expert_events WHERE task_id=?").get(taskId) as { n: number }).n,
    );
    const events = this.db
      .prepare(
        "SELECT event_id,task_id,run_id,event_type,details,created_at,tool_code,count FROM expert_events WHERE task_id=? ORDER BY event_id DESC LIMIT ? OFFSET ?",
      )
      .all(taskId, limit, offset);
    return {
      task,
      feedback: feedbackRow ? this.feedbackFromRow(feedbackRow) : null,
      runs,
      events,
      eventsPage: { total, limit, offset, hasNewer: offset > 0, hasOlder: offset + events.length < total },
    };
  }

  adminFeedbackMetrics() {
    const rows = this.db
      .prepare(
        `SELECT t.expert_id,t.deployment_id,t.deployment_config_version,
          COUNT(*) AS successful,
          SUM(CASE WHEN f.task_id IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
          SUM(CASE WHEN f.task_id IS NULL THEN 1 ELSE 0 END) AS unreviewed,
          SUM(CASE WHEN f.disposition='adopted' THEN 1 ELSE 0 END) AS adopted,
          SUM(CASE WHEN f.disposition='partially_adopted' THEN 1 ELSE 0 END) AS partially_adopted,
          SUM(CASE WHEN f.disposition='not_adopted' THEN 1 ELSE 0 END) AS not_adopted,
          SUM(CASE WHEN f.needs_rework=1 THEN 1 ELSE 0 END) AS rework
         FROM expert_tasks t LEFT JOIN expert_task_feedback f ON f.task_id=t.task_id
         WHERE t.status='succeeded'
         GROUP BY t.expert_id,t.deployment_id,t.deployment_config_version
         ORDER BY t.expert_id,t.deployment_id,t.deployment_config_version`,
      )
      .all() as Row[];
    return rows.map((row) => {
      const reviewed = Number(row.reviewed ?? 0);
      const adopted = Number(row.adopted ?? 0);
      const partiallyAdopted = Number(row.partially_adopted ?? 0);
      return {
        expertId: String(row.expert_id ?? "legacy"),
        deploymentId: row.deployment_id == null ? "unknown" : String(row.deployment_id),
        deploymentConfigVersion:
          row.deployment_config_version == null ? "unknown" : Number(row.deployment_config_version),
        successful: Number(row.successful ?? 0),
        reviewed,
        unreviewed: Number(row.unreviewed ?? 0),
        adopted,
        partiallyAdopted,
        notAdopted: Number(row.not_adopted ?? 0),
        rework: Number(row.rework ?? 0),
        adoptionRate: reviewed === 0 ? null : (adopted + partiallyAdopted) / reviewed,
      };
    });
  }

  /** Existing status contract plus concise observed activity and session queue reason. */
  getStatusWithActivity(taskId: string, principalId: string, scope: string) {
    const task = this.get(taskId, principalId, scope);
    const last = this.db
      .prepare(`SELECT event_type,created_at FROM expert_events WHERE task_id=? ORDER BY event_id DESC LIMIT 1`)
      .get(taskId) as { event_type: string; created_at: number } | undefined;
    const current = this.db
      .prepare(
        `SELECT run_id,rowid,expert_id,source_client,source_session_id,principal_id,scope FROM expert_tasks WHERE task_id=?`,
      )
      .get(taskId) as Row;
    let queueReason: "session_predecessor" | "unknown" | null = null;
    if (task.status === "queued") {
      const earlier = this.db
        .prepare(
          `SELECT 1 FROM expert_tasks WHERE rowid<? AND scope=? AND principal_id=?
        AND expert_id=? AND source_client=? AND source_session_id=?
        AND status IN ('queued','running') LIMIT 1`,
        )
        .get(
          Number(current.rowid),
          String(current.scope),
          String(current.principal_id),
          String(current.expert_id),
          current.source_client == null ? null : String(current.source_client),
          current.source_session_id == null ? null : String(current.source_session_id),
        );
      queueReason = earlier && current.source_session_id ? "session_predecessor" : "unknown";
    }
    return {
      ...task,
      currentRunId: current.run_id ?? null,
      lastStage: last?.event_type ?? null,
      lastActivityAt: last?.created_at ?? null,
      queueReason,
    };
  }

  /** Authenticated owner-scoped, monotonic event cursor. */
  ownerEvents(taskId: string, principalId: string, scope: string, afterEventId = 0, limit = 50) {
    if (
      !Number.isSafeInteger(afterEventId) ||
      afterEventId < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("INVALID_EVENT_CURSOR");
    const task = this.get(taskId, principalId, scope);
    const rows = this.db
      .prepare(
        `SELECT event_id,run_id,event_type,details,tool_code,count,created_at
      FROM expert_events WHERE task_id=? AND event_id>? ORDER BY event_id LIMIT ?`,
      )
      .all(taskId, afterEventId, limit + 1) as Row[];
    const selected = rows.slice(0, limit);
    return {
      taskId,
      status: task.status,
      terminal: ["succeeded", "failed", "cancelled"].includes(task.status),
      currentRunId: ((this.db.prepare("SELECT run_id FROM expert_tasks WHERE task_id=?").get(taskId) as Row | undefined)
        ?.run_id ?? null) as string | null,
      events: selected.map((row) => ({
        eventId: Number(row.event_id),
        runId: row.run_id == null ? null : String(row.run_id),
        type: String(row.event_type),
        details: row.details == null ? "" : String(row.details),
        tool: row.tool_code == null ? null : String(row.tool_code),
        count: row.count == null ? null : Number(row.count),
        timestampMs: Number(row.created_at),
      })),
      nextEventId: selected.length ? Number(selected[selected.length - 1]!.event_id) : afterEventId,
      hasMore: rows.length > limit,
    };
  }

  listByWorkAttempt(workAttemptId: string, principalId: string, scope: string): TaskRecord[] {
    const attempt = workAttemptId.trim();
    if (!attempt) throw new Error("INVALID_WORK_ATTEMPT");
    return (
      this.db
        .prepare("SELECT * FROM expert_tasks WHERE work_attempt_id=? AND principal_id=? AND scope=? ORDER BY rowid")
        .all(attempt, principalId, scope) as Row[]
    ).map((row) => this.fromRow(row));
  }

  reservedAgentTurnsForWorkAttempt(workAttemptId: string, principalId: string, scope: string): number {
    return this.listByWorkAttempt(workAttemptId, principalId, scope)
      .filter((task) => task.executionKind === "agent")
      .reduce((total, task) => {
        const observedTurns = this.listRunTurns(task.taskId, principalId, scope).length;
        const scheduledTurns = task.continuationCount + 1;
        const queuedRetryReservation = task.status === "queued" && observedTurns >= scheduledTurns ? 1 : 0;
        return total + Math.max(scheduledTurns, observedTurns + queuedRetryReservation);
      }, 0);
  }

  listRunTurns(taskId: string, principalId: string, scope: string): TaskRunTurnRecord[] {
    this.get(taskId, principalId, scope);
    return (
      this.db
        .prepare(
          "SELECT task_id,run_id,turn_index,status,start_sequence,finish_sequence,started_at,finished_at FROM expert_run_turns WHERE task_id=? ORDER BY rowid",
        )
        .all(taskId) as Row[]
    ).map((row) => ({
      taskId: String(row.task_id),
      runId: String(row.run_id),
      turnIndex: Number(row.turn_index),
      status: String(row.status) as TaskRunTurnRecord["status"],
      startSequence: row.start_sequence == null ? null : Number(row.start_sequence),
      finishSequence: row.finish_sequence == null ? null : Number(row.finish_sequence),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    }));
  }

  private updateRunTurnFromActivity(claim: Claim, stage: string, sourceSequence: number, now: number): void {
    if (stage === "model.started") {
      const active = this.db
        .prepare("SELECT 1 FROM expert_run_turns WHERE run_id=? AND status='running' LIMIT 1")
        .get(claim.runId);
      if (active) return;
      const next = this.db
        .prepare("SELECT COALESCE(MAX(turn_index),0)+1 AS n FROM expert_run_turns WHERE run_id=?")
        .get(claim.runId) as { n: number };
      this.db
        .prepare(
          "INSERT INTO expert_run_turns(run_id,task_id,turn_index,status,start_sequence,started_at) VALUES(?,?,?,'running',?,?)",
        )
        .run(claim.runId, claim.taskId, Number(next.n), sourceSequence, now);
      return;
    }
    if (stage === "model.completed" || stage === "model.failed") {
      this.db
        .prepare(
          "UPDATE expert_run_turns SET status=?,finish_sequence=?,finished_at=? WHERE run_id=? AND status='running'",
        )
        .run(stage === "model.completed" ? "succeeded" : "failed", sourceSequence, now, claim.runId);
    }
  }

  private closeActiveRunTurn(runId: string, status: "succeeded" | "failed", now: number): void {
    this.db
      .prepare(
        "UPDATE expert_run_turns SET status=?,finished_at=COALESCE(finished_at,?) WHERE run_id=? AND status='running'",
      )
      .run(status, now, runId);
  }

  /** Best-effort bounded activity recording; legacy lifecycle stages remain unchanged. */
  recordActivity(
    claim: Claim,
    stage: string,
    sourceSequence: number,
    toolCode = "",
    count = 0,
    now = Date.now(),
  ): void {
    if (
      !(["model.started", "model.active", "model.completed", "model.failed", "tool.activity"] as string[]).includes(
        stage,
      ) ||
      !Number.isSafeInteger(sourceSequence) ||
      sourceSequence < 1 ||
      !["", "Read", "Glob", "Grep", "other"].includes(toolCode) ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > 100 ||
      (stage === "tool.activity" ? !toolCode || count < 1 : toolCode !== "" || count !== 0)
    )
      throw new Error("INVALID_ACTIVITY_EVENT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT 1 FROM expert_tasks WHERE task_id=? AND run_id=? AND worker_id=?
        AND fencing=? AND status='running' AND lease_until>=?`,
        )
        .get(claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
      if (!row) throw new Error("STALE_ATTEMPT");
      const prior = this.db
        .prepare(`SELECT event_type,tool_code,count FROM expert_events WHERE run_id=? AND source_sequence=?`)
        .get(claim.runId, sourceSequence) as Row | undefined;
      if (prior) {
        if (prior.event_type !== stage || (prior.tool_code ?? "") !== toolCode || Number(prior.count ?? 0) !== count)
          throw new Error("PROGRESS_SEQUENCE_CONFLICT");
      } else {
        const used = this.db
          .prepare(`SELECT count(*) AS n FROM expert_events WHERE run_id=? AND source_sequence IS NOT NULL`)
          .get(claim.runId) as { n: number };
        if (used.n < 150)
          this.db
            .prepare(
              `INSERT INTO expert_events(task_id,run_id,event_type,details,source_sequence,tool_code,count,created_at)
          VALUES(?,?,?,'',?,?,?,?)`,
            )
            .run(claim.taskId, claim.runId, stage, sourceSequence, toolCode || null, count || null, now);
        this.updateRunTurnFromActivity(claim, stage, sourceSequence, now);
        this.trimTaskEvents(claim.taskId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertActiveClaim(claim: Claim, now = Date.now()): void {
    const row = this.db
      .prepare(
        "SELECT 1 FROM expert_tasks WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
      )
      .get(claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
    if (!row) throw new Error("STALE_ATTEMPT");
  }

  /** Accept stage metadata only for the active claimed attempt; no raw model output. */
  recordStage(claim: Claim, stage: string, details = "", now = Date.now()) {
    // Accept only structured stage names and diagnostic codes. Never persist raw log text.
    if (
      !/^(repository|container|codex|claude|execution)\.(started|completed|failed)$/.test(stage) ||
      (details !== "" && !/^[A-Z][A-Z0-9_]{0,79}$/.test(details))
    )
      throw new Error("INVALID_STAGE_EVENT");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT 1 FROM expert_tasks WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
        )
        .get(claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
      if (!row) throw new Error("STALE_ATTEMPT");
      const count = Number(
        (
          this.db
            .prepare("SELECT count(*) n FROM expert_events WHERE task_id=? AND run_id=?")
            .get(claim.taskId, claim.runId) as { n: number }
        ).n,
      );
      if (count >= 200) throw new Error("EVENT_LIMIT_REACHED");
      const safeDetails = details;
      this.db
        .prepare("INSERT INTO expert_events(task_id,run_id,event_type,details,created_at) VALUES(?,?,?,?,?)")
        .run(claim.taskId, claim.runId, stage, safeDetails, now);
      this.trimTaskEvents(claim.taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureEventColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(expert_events)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name))
      this.db.exec(`ALTER TABLE expert_events ADD COLUMN ${name} ${definition}`);
  }

  private ensureTaskColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(expert_tasks)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE expert_tasks ADD COLUMN ${name} ${definition}`);
  }

  private ensureRunColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(expert_runs)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE expert_runs ADD COLUMN ${name} ${definition}`);
  }

  private trimTaskEvents(taskId: string): void {
    this.db
      .prepare(
        `DELETE FROM expert_events WHERE task_id=? AND event_id NOT IN (
      SELECT event_id FROM expert_events WHERE task_id=? ORDER BY event_id DESC LIMIT 1000
    )`,
      )
      .run(taskId, taskId);
  }

  private event(taskId: string, runId: string | null, kind: string): void {
    this.db
      .prepare("INSERT INTO expert_events(task_id,run_id,event_type,created_at) VALUES(?,?,?,?)")
      .run(taskId, runId, kind, Date.now());
    this.trimTaskEvents(taskId);
  }

  private feedbackFromRow(row: Row): ExpertTaskFeedback {
    return {
      taskId: String(row.task_id),
      disposition: row.disposition as ExpertTaskFeedbackDisposition,
      reason: row.reason == null ? null : String(row.reason),
      needsRework: row.needs_rework == null ? null : Number(row.needs_rework) === 1,
      updatedAt: Number(row.updated_at),
    };
  }

  private fromRow(row: Row): TaskRecord {
    return {
      taskId: String(row.task_id),
      idempotencyKey: String(row.idempotency_key),
      status: row.status as TaskStatus,
      result: row.result == null ? null : String(row.result),
      expertId: String(row.expert_id ?? "legacy"),
      repositoryId: row.repository_id == null ? null : String(row.repository_id),
      selectionMode: (row.selection_mode ?? "explicit") as "explicit" | "auto",
      schemaVersion: Number(row.schema_version ?? 1),
      executionKind: (row.execution_kind ?? "agent") as TaskExecutionKind,
      ...(row.deployment_id
        ? {
            deploymentId: String(row.deployment_id),
            ...(row.deployment_config_version != null
              ? { deploymentConfigVersion: Number(row.deployment_config_version) }
              : {}),
            deploymentSnapshot: row.deployment_snapshot_json
              ? (JSON.parse(String(row.deployment_snapshot_json)) as DeploymentTaskSnapshot)
              : null,
          }
        : {}),
      sourceSessionId: row.source_session_id == null ? null : String(row.source_session_id),
      sourceClient: row.source_client == null ? null : String(row.source_client),
      sourceRequestId: row.source_request_id == null ? null : String(row.source_request_id),
      repositoryUrl: row.repository_url == null ? null : String(row.repository_url),
      repositoryBranch: row.repository_branch == null ? null : String(row.repository_branch),
      commitSha: row.commit_sha == null ? null : String(row.commit_sha),
      cancellationRequested: Number(row.cancellation_requested ?? 0) === 1,
      workItemId: row.work_item_id == null ? null : String(row.work_item_id),
      workAttemptId: row.work_attempt_id == null ? null : String(row.work_attempt_id),
      workflowId: row.workflow_id == null ? null : String(row.workflow_id),
      workflowVersion: row.workflow_version == null ? null : Number(row.workflow_version),
      workspaceKey: row.workspace_key == null ? null : String(row.workspace_key),
      validationSnapshot: normalizeVerificationPolicy(
        row.validation_snapshot_json ? JSON.parse(String(row.validation_snapshot_json)) : [],
      ),
      verificationResults: normalizeVerificationEvidenceResults(
        row.verification_results_json ? JSON.parse(String(row.verification_results_json)) : [],
      ),
      workspaceChangeSummary: row.workspace_change_summary_json
        ? normalizeWorkspaceChangeSummary(JSON.parse(String(row.workspace_change_summary_json)))
        : null,
      requiredWorkerId: row.required_worker_id == null ? null : String(row.required_worker_id),
      continuationCount: Number(row.continuation_count ?? 0),
      continuationReason: row.continuation_reason == null ? null : String(row.continuation_reason),
      executionRef: row.execution_ref == null ? null : String(row.execution_ref),
      executionReservationRef: row.execution_reservation_ref == null ? null : String(row.execution_reservation_ref),
      runtimeSessionId: row.runtime_session_id == null ? null : String(row.runtime_session_id),
      runId: row.run_id == null ? null : String(row.run_id),
    };
  }
}

function parseSourceMetadata(
  result: string,
): { repositoryUrl: string; repositoryBranch: string; commitSha: string } | null {
  const match = result.match(
    /^Source repository: (https?:\/\/[^\s]+)\r?\nBranch: ([^\r\n]+)\r?\nCommit: ([a-f0-9]{40})\r?\n/m,
  );
  if (!match) return null;
  return { repositoryUrl: match[1]!, repositoryBranch: match[2]!, commitSha: match[3]! };
}
