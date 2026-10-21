import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
};
export type Claim = { taskId: string; runId: string; workerId: string; fencing: number; problem: string };
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
    this.ensureTaskColumn("expert_id", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureTaskColumn("repository_id", "TEXT");
    this.ensureTaskColumn(
      "selection_mode",
      "TEXT NOT NULL DEFAULT 'explicit' CHECK (selection_mode IN ('explicit','auto'))",
    );
    this.ensureTaskColumn("schema_version", "INTEGER NOT NULL DEFAULT 1");
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
      return { taskId, runId, workerId, fencing, problem: String(row.problem) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(claim: Claim, result: string, now = Date.now()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE expert_tasks SET status='succeeded',result=?,lease_until=NULL WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
        )
        .run(result, claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
      if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
      this.db.prepare("UPDATE expert_runs SET status='succeeded' WHERE run_id=?").run(claim.runId);
      this.event(claim.taskId, claim.runId, "succeeded");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renew(claim: Claim, now = Date.now(), leaseMs = 30_000): void {
    if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("INVALID_REQUEST");
    }
    const changed = this.db
      .prepare(
        "UPDATE expert_tasks SET lease_until=? WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
      )
      .run(now + leaseMs, claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
    if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
  }

  fail(claim: Claim, reason: string, now = Date.now()): void {
    if (!reason.trim()) throw new Error("INVALID_REQUEST");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE expert_tasks SET status='failed',result=?,lease_until=NULL WHERE task_id=? AND run_id=? AND worker_id=? AND fencing=? AND status='running' AND lease_until>=?",
        )
        .run(reason, claim.taskId, claim.runId, claim.workerId, claim.fencing, now);
      if (changed.changes !== 1) throw new Error("STALE_ATTEMPT");
      this.db.prepare("UPDATE expert_runs SET status='failed' WHERE run_id=?").run(claim.runId);
      this.event(claim.taskId, claim.runId, "failed");
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
    const changed = this.db
      .prepare(
        "UPDATE expert_tasks SET status='cancelled' WHERE task_id=? AND principal_id=? AND scope=? AND status='queued'",
      )
      .run(taskId, principalId, scope);
    if (changed.changes === 1) this.event(taskId, null, "cancelled");
    return this.get(taskId, principalId, scope);
  }

  close(): void {
    this.db.close();
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
    };
  }
}
