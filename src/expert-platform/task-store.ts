import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExpertModelConfig } from "./expert-store.js";

type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type Submission = {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  problem: string;
  expertId?: string;
  repositoryId?: string;
  selectionMode?: "explicit" | "auto";
  schemaVersion?: number;
};
export type TaskRecord = {
  taskId: string;
  status: TaskStatus;
  result: string | null;
  expertId: string;
  repositoryId: string | null;
  selectionMode: "explicit" | "auto";
  schemaVersion: number;
  repositoryUrl?: string | null;
  repositoryBranch?: string | null;
  commitSha?: string | null;
  cancellationRequested?: boolean;
};
export type TaskSourceMetadata = { repositoryUrl?: string; repositoryBranch?: string; commitSha?: string };

export type Claim = {
  taskId: string;
  runId: string;
  workerId: string;
  fencing: number;
  problem: string;
  repositoryId?: string | null;
  repositoryUrl?: string;
  repositoryBranch?: string;
  repositoryCredentialRef?: string;
  repositoryGitProxyUrl?: string;
  modelConfig?: ExpertModelConfig;
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
      CREATE TABLE IF NOT EXISTS expert_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES expert_tasks(task_id),
        worker_id TEXT NOT NULL,
        fencing INTEGER NOT NULL,
        status TEXT NOT NULL
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
    this.ensureTaskColumn("expert_id", "TEXT NOT NULL DEFAULT 'legacy'");
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
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_expert_task_run ON expert_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_expert_event_task ON expert_events(task_id,event_id);
      CREATE INDEX IF NOT EXISTS idx_expert_task_status ON expert_tasks(status,expert_id);`);
  }

  submit(input: Submission): TaskRecord {
    if (!input.problem.trim() || !input.principalId.trim() || !input.scope.trim() || !input.idempotencyKey.trim()) {
      throw new Error("INVALID_REQUEST");
    }
    const expertId = input.expertId?.trim() || "legacy";
    const repositoryId = input.repositoryId?.trim() || null;
    const selectionMode = input.selectionMode ?? "explicit";
    const schemaVersion = input.schemaVersion ?? 1;
    if (
      (selectionMode !== "explicit" && selectionMode !== "auto") ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion <= 0
    ) {
      throw new Error("INVALID_REQUEST");
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          problem: input.problem,
          expertId,
          repositoryId,
          selectionMode,
          schemaVersion,
        }),
      )
      .digest("hex");
    const taskId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM expert_tasks WHERE principal_id=? AND scope=? AND idempotency_key=?")
        .get(input.principalId, input.scope, input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.request_digest !== digest) throw new Error("IDEMPOTENCY_CONFLICT");
        this.db.exec("COMMIT");
        return this.fromRow(existing);
      }
      this.db
        .prepare(
          "INSERT INTO expert_tasks(task_id,principal_id,scope,idempotency_key,request_digest,problem,expert_id,repository_id,selection_mode,schema_version,status) VALUES (?,?,?,?,?,?,?,?,?,?,'queued')",
        )
        .run(
          taskId,
          input.principalId,
          input.scope,
          input.idempotencyKey,
          digest,
          input.problem,
          expertId,
          repositoryId,
          selectionMode,
          schemaVersion,
        );
      this.event(taskId, null, "queued");
      this.db.exec("COMMIT");
      return {
        taskId,
        status: "queued",
        result: null,
        expertId,
        repositoryId,
        selectionMode,
        schemaVersion,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claim(workerId: string, now = Date.now(), leaseMs = 30_000, expertId?: string): Claim | null {
    if (!workerId || !Number.isFinite(now) || leaseMs <= 0) throw new Error("INVALID_REQUEST");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = expertId
        ? (this.db
            .prepare(
              "SELECT * FROM expert_tasks WHERE expert_id=? AND (status='queued' OR (status='running' AND lease_until < ?)) ORDER BY rowid LIMIT 1",
            )
            .get(expertId, now) as Row | undefined)
        : (this.db
            .prepare(
              "SELECT * FROM expert_tasks WHERE status='queued' OR (status='running' AND lease_until < ?) ORDER BY rowid LIMIT 1",
            )
            .get(now) as Row | undefined);
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
      this.db
        .prepare(
          "UPDATE expert_tasks SET status='running',run_id=?,worker_id=?,lease_until=?,fencing=? WHERE task_id=?",
        )
        .run(runId, workerId, now + leaseMs, fencing, taskId);
      this.db
        .prepare("INSERT INTO expert_runs(run_id,task_id,worker_id,fencing,status) VALUES (?,?,?,?,'running')")
        .run(runId, taskId, workerId, fencing);
      this.event(taskId, runId, "running");
      this.db.exec("COMMIT");
      return {
        taskId,
        runId,
        workerId,
        fencing,
        problem: String(row.problem),
        repositoryId: row.repository_id == null ? null : String(row.repository_id),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(claim: Claim, result: string, now = Date.now(), sourceMetadata?: TaskSourceMetadata): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const source = sourceMetadata ?? parseSourceMetadata(result) ?? undefined;
      const changed = this.db
        .prepare(
          "UPDATE expert_tasks SET status='succeeded',result=?,repository_url=COALESCE(?,repository_url),repository_branch=COALESCE(?,repository_branch),commit_sha=COALESCE(?,commit_sha),lease_until=NULL WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND cancellation_requested=0 AND lease_until>=?",
        )
        .run(
          result,
          source?.repositoryUrl ?? null,
          source?.repositoryBranch ?? null,
          source?.commitSha ?? null,
          claim.taskId,
          claim.runId,
          claim.workerId,
          claim.fencing,
          now,
        );
      if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
      this.db.prepare("UPDATE expert_runs SET status='succeeded' WHERE run_id=?").run(claim.runId);
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
      this.event(claim.taskId, claim.runId, terminalStatus);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(taskId: string, principalId: string, scope: string): TaskRecord {
    const row = this.db
      .prepare("SELECT * FROM expert_tasks WHERE task_id=? AND principal_id=? AND scope=?")
      .get(taskId, principalId, scope) as Row | undefined;
    if (!row) throw new Error("TASK_NOT_FOUND_OR_FORBIDDEN");
    return this.fromRow(row);
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
        `SELECT task_id,principal_id,scope,expert_id,repository_id,selection_mode,status,run_id,worker_id,fencing,repository_url,repository_branch,commit_sha FROM expert_tasks${clause} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    return { total, limit, offset, tasks: rows };
  }

  adminTaskDetail(taskId: string) {
    const task = this.db
      .prepare(
        "SELECT task_id,principal_id,scope,problem,expert_id,repository_id,selection_mode,status,result,run_id,worker_id,fencing,repository_url,repository_branch,commit_sha,cancellation_requested FROM expert_tasks WHERE task_id=?",
      )
      .get(taskId);
    if (!task) return null;
    const runs = this.db
      .prepare("SELECT run_id,task_id,worker_id,fencing,status FROM expert_runs WHERE task_id=? ORDER BY rowid")
      .all(taskId);
    const events = this.db
      .prepare(
        "SELECT event_id,task_id,run_id,event_type,details,created_at FROM expert_events WHERE task_id=? ORDER BY event_id LIMIT 1000",
      )
      .all(taskId);
    return { task, runs, events };
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

  private event(taskId: string, runId: string | null, kind: string): void {
    this.db
      .prepare("INSERT INTO expert_events(task_id,run_id,event_type,created_at) VALUES(?,?,?,?)")
      .run(taskId, runId, kind, Date.now());
  }

  private fromRow(row: Row): TaskRecord {
    return {
      taskId: String(row.task_id),
      status: row.status as TaskStatus,
      result: row.result == null ? null : String(row.result),
      expertId: String(row.expert_id ?? "legacy"),
      repositoryId: row.repository_id == null ? null : String(row.repository_id),
      selectionMode: (row.selection_mode ?? "explicit") as "explicit" | "auto",
      schemaVersion: Number(row.schema_version ?? 1),
      repositoryUrl: row.repository_url == null ? null : String(row.repository_url),
      repositoryBranch: row.repository_branch == null ? null : String(row.repository_branch),
      commitSha: row.commit_sha == null ? null : String(row.commit_sha),
      cancellationRequested: Number(row.cancellation_requested ?? 0) === 1,
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
