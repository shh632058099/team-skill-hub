import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkChangeRequestState = "pending" | "creating" | "created" | "blocked";

export interface WorkChangeRequestRecord {
  changeRequestId: string;
  workItemId: string;
  workAttemptId: string;
  publicationId: string;
  ownerWorkerId: string;
  repositoryIdentity: string;
  repositoryUrl: string;
  headBranch: string;
  headCommit: string;
  baseBranch: string;
  title: string;
  body: string;
  idempotencyKey: string;
  credentialGrantRef: string;
  state: WorkChangeRequestState;
  provider: string | null;
  externalId: string | null;
  url: string | null;
  retryCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  operationFencing: number;
  createdAt: number;
  updatedAt: number;
}

export type CreateWorkChangeRequestInput = Omit<
  WorkChangeRequestRecord,
  | "changeRequestId"
  | "state"
  | "provider"
  | "externalId"
  | "url"
  | "retryCount"
  | "nextAttemptAt"
  | "lastErrorCode"
  | "operationFencing"
  | "createdAt"
  | "updatedAt"
>;

export interface ChangeRequestOperationLease {
  changeRequestId: string;
  ownerWorkerId: string;
  fencing: number;
  repositoryIdentity: string;
  repositoryUrl: string;
  headBranch: string;
  headCommit: string;
  baseBranch: string;
  title: string;
  body: string;
  idempotencyKey: string;
  credentialGrantRef: string;
}

export type ChangeRequestOperationResult =
  | {
      success: true;
      provider: string;
      externalId: string;
      url: string;
      headCommit: string;
      baseBranch: string;
    }
  | {
      success: false;
      errorCode: string;
    };

type Row = Record<string, unknown>;

function requiredText(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error("INVALID_CHANGE_REQUEST");
  return normalized;
}

export class WorkChangeRequestStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(
      [
        "CREATE TABLE IF NOT EXISTS work_change_requests (",
        "  change_request_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL,",
        "  work_attempt_id TEXT NOT NULL,",
        "  publication_id TEXT NOT NULL UNIQUE,",
        "  owner_worker_id TEXT NOT NULL,",
        "  repository_identity TEXT NOT NULL,",
        "  repository_url TEXT NOT NULL,",
        "  head_branch TEXT NOT NULL,",
        "  head_commit TEXT NOT NULL,",
        "  base_branch TEXT NOT NULL,",
        "  title TEXT NOT NULL,",
        "  body TEXT NOT NULL,",
        "  idempotency_key TEXT NOT NULL,",
        "  credential_grant_ref TEXT NOT NULL,",
        "  state TEXT NOT NULL CHECK(state IN ('pending','creating','created','blocked')),",
        "  provider TEXT,",
        "  external_id TEXT,",
        "  url TEXT,",
        "  retry_count INTEGER NOT NULL DEFAULT 0,",
        "  next_attempt_at INTEGER,",
        "  last_error_code TEXT,",
        "  operation_fencing INTEGER NOT NULL DEFAULT 0,",
        "  operation_lease_until INTEGER,",
        "  operation_claimed_worker_id TEXT,",
        "  created_at INTEGER NOT NULL,",
        "  updated_at INTEGER NOT NULL",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_change_request_item ON work_change_requests(work_item_id, created_at);",
        "CREATE INDEX IF NOT EXISTS idx_work_change_request_claim ON work_change_requests(owner_worker_id, state, next_attempt_at, created_at);",
      ].join("\n"),
    );
  }

  close(): void {
    this.db.close();
  }

  createOrReuse(input: CreateWorkChangeRequestInput, now = Date.now()): WorkChangeRequestRecord {
    const normalized = {
      ...input,
      workItemId: requiredText(input.workItemId, 200),
      workAttemptId: requiredText(input.workAttemptId, 200),
      publicationId: requiredText(input.publicationId, 200),
      ownerWorkerId: requiredText(input.ownerWorkerId, 200),
      repositoryIdentity: requiredText(input.repositoryIdentity, 500),
      repositoryUrl: requiredText(input.repositoryUrl, 2000),
      headBranch: requiredText(input.headBranch, 300),
      headCommit: requiredText(input.headCommit, 128).toLowerCase(),
      baseBranch: requiredText(input.baseBranch, 300),
      title: requiredText(input.title, 500),
      body: requiredText(input.body, 20_000),
      idempotencyKey: requiredText(input.idempotencyKey, 500),
      credentialGrantRef: requiredText(input.credentialGrantRef, 200),
    };
    if (!/^[a-f0-9]{40,64}$/.test(normalized.headCommit)) throw new Error("INVALID_CHANGE_REQUEST");

    const existing = this.db
      .prepare("SELECT * FROM work_change_requests WHERE publication_id=?")
      .get(normalized.publicationId) as Row | undefined;
    if (existing) {
      const current = this.fromRow(existing);
      const matches =
        current.workItemId === normalized.workItemId &&
        current.workAttemptId === normalized.workAttemptId &&
        current.ownerWorkerId === normalized.ownerWorkerId &&
        current.repositoryIdentity === normalized.repositoryIdentity &&
        current.repositoryUrl === normalized.repositoryUrl &&
        current.headBranch === normalized.headBranch &&
        current.headCommit === normalized.headCommit &&
        current.baseBranch === normalized.baseBranch &&
        current.title === normalized.title &&
        current.body === normalized.body &&
        current.idempotencyKey === normalized.idempotencyKey &&
        current.credentialGrantRef === normalized.credentialGrantRef;
      if (!matches) throw new Error("CHANGE_REQUEST_IDEMPOTENCY_CONFLICT");
      return current;
    }

    const changeRequestId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO work_change_requests(" +
          "change_request_id,work_item_id,work_attempt_id,publication_id,owner_worker_id,repository_identity,repository_url," +
          "head_branch,head_commit,base_branch,title,body,idempotency_key,credential_grant_ref,state,provider,external_id,url," +
          "retry_count,next_attempt_at,last_error_code,operation_fencing,operation_lease_until,operation_claimed_worker_id,created_at,updated_at" +
          ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        changeRequestId,
        normalized.workItemId,
        normalized.workAttemptId,
        normalized.publicationId,
        normalized.ownerWorkerId,
        normalized.repositoryIdentity,
        normalized.repositoryUrl,
        normalized.headBranch,
        normalized.headCommit,
        normalized.baseBranch,
        normalized.title,
        normalized.body,
        normalized.idempotencyKey,
        normalized.credentialGrantRef,
        "pending",
        null,
        null,
        null,
        0,
        null,
        null,
        0,
        null,
        null,
        now,
        now,
      );
    return this.get(changeRequestId);
  }

  get(changeRequestId: string): WorkChangeRequestRecord {
    const row = this.db
      .prepare("SELECT * FROM work_change_requests WHERE change_request_id=?")
      .get(requiredText(changeRequestId, 200)) as Row | undefined;
    if (!row) throw new Error("CHANGE_REQUEST_NOT_FOUND");
    return this.fromRow(row);
  }

  getByPublication(publicationId: string): WorkChangeRequestRecord | null {
    const row = this.db
      .prepare("SELECT * FROM work_change_requests WHERE publication_id=?")
      .get(requiredText(publicationId, 200)) as Row | undefined;
    return row ? this.fromRow(row) : null;
  }

  listForWork(workItemId: string): WorkChangeRequestRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_change_requests WHERE work_item_id=? ORDER BY created_at,change_request_id")
        .all(requiredText(workItemId, 200)) as Row[]
    ).map((row) => this.fromRow(row));
  }

  cancelForWork(
    workItemId: string,
    now = Date.now(),
  ): {
    cancelledChangeRequestIds: string[];
    outcomeUnknownChangeRequestIds: string[];
  } {
    const id = requiredText(workItemId, 200);
    if (!Number.isFinite(now)) throw new Error("INVALID_CHANGE_REQUEST");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM work_change_requests WHERE work_item_id=? AND state IN ('pending','creating') ORDER BY created_at,change_request_id",
        )
        .all(id) as Row[];
      const cancelledChangeRequestIds: string[] = [];
      const outcomeUnknownChangeRequestIds: string[] = [];

      for (const row of rows) {
        const current = this.fromRow(row);
        const fencing = Number(row.operation_fencing ?? 0) + 1;
        const unknown = current.state === "creating";
        const changed = this.db
          .prepare(
            "UPDATE work_change_requests SET state='blocked',last_error_code=?,operation_fencing=?,operation_lease_until=NULL,operation_claimed_worker_id=NULL,next_attempt_at=NULL,updated_at=? WHERE change_request_id=? AND operation_fencing=? AND state=?",
          )
          .run(
            unknown ? "WORK_CANCELLED_OUTCOME_UNKNOWN" : "WORK_CANCELLED",
            fencing,
            now,
            current.changeRequestId,
            Number(row.operation_fencing ?? 0),
            current.state,
          );
        if (changed.changes !== 1) throw new Error("STALE_CHANGE_REQUEST_OPERATION");
        if (unknown) outcomeUnknownChangeRequestIds.push(current.changeRequestId);
        else cancelledChangeRequestIds.push(current.changeRequestId);
      }

      this.db.exec("COMMIT");
      return { cancelledChangeRequestIds, outcomeUnknownChangeRequestIds };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claim(workerId: string, now = Date.now(), leaseMs = 30_000): ChangeRequestOperationLease | null {
    const owner = requiredText(workerId, 200);
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_CHANGE_REQUEST_LEASE");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM work_change_requests WHERE owner_worker_id=? AND state IN ('pending','creating') " +
            "AND (operation_lease_until IS NULL OR operation_lease_until<?) " +
            "AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,change_request_id LIMIT 1",
        )
        .get(owner, now, now) as Row | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const current = this.fromRow(row);
      const previousFencing = Number(row.operation_fencing ?? 0);
      const fencing = previousFencing + 1;
      const changed = this.db
        .prepare(
          "UPDATE work_change_requests SET state='creating',operation_fencing=?,operation_lease_until=?,operation_claimed_worker_id=?,updated_at=? " +
            "WHERE change_request_id=? AND owner_worker_id=? AND operation_fencing=?",
        )
        .run(fencing, now + leaseMs, owner, now, current.changeRequestId, owner, previousFencing);
      if (changed.changes !== 1) throw new Error("STALE_CHANGE_REQUEST_OPERATION");
      const claimed = this.get(current.changeRequestId);
      this.db.exec("COMMIT");
      return {
        changeRequestId: claimed.changeRequestId,
        ownerWorkerId: owner,
        fencing,
        repositoryIdentity: claimed.repositoryIdentity,
        repositoryUrl: claimed.repositoryUrl,
        headBranch: claimed.headBranch,
        headCommit: claimed.headCommit,
        baseBranch: claimed.baseBranch,
        title: claimed.title,
        body: claimed.body,
        idempotencyKey: claimed.idempotencyKey,
        credentialGrantRef: claimed.credentialGrantRef,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  complete(
    claim: ChangeRequestOperationLease,
    result: ChangeRequestOperationResult,
    now = Date.now(),
  ): WorkChangeRequestRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM work_change_requests WHERE change_request_id=?")
        .get(claim.changeRequestId) as Row | undefined;
      if (!row) throw new Error("CHANGE_REQUEST_NOT_FOUND");
      const current = this.fromRow(row);
      if (
        current.ownerWorkerId !== claim.ownerWorkerId ||
        current.state !== "creating" ||
        Number(row.operation_fencing ?? 0) !== claim.fencing ||
        String(row.operation_claimed_worker_id ?? "") !== claim.ownerWorkerId ||
        Number(row.operation_lease_until ?? 0) < now
      ) {
        throw new Error("STALE_CHANGE_REQUEST_OPERATION");
      }

      let state: WorkChangeRequestState;
      let provider: string | null = current.provider;
      let externalId: string | null = current.externalId;
      let url: string | null = current.url;
      let retryCount = current.retryCount;
      let nextAttemptAt: number | null = null;
      let lastErrorCode: string | null = null;

      if (result.success) {
        if (result.headCommit.toLowerCase() !== current.headCommit.toLowerCase()) {
          throw new Error("CHANGE_REQUEST_HEAD_MISMATCH");
        }
        if (result.baseBranch !== current.baseBranch) throw new Error("CHANGE_REQUEST_BASE_MISMATCH");
        provider = requiredText(result.provider, 100);
        externalId = requiredText(result.externalId, 200);
        url = requiredText(result.url, 2000);
        state = "created";
      } else {
        lastErrorCode = requiredText(result.errorCode, 100);
        if (lastErrorCode === "CHANGE_REQUEST_CREATE_FAILED") {
          retryCount += 1;
          if (retryCount < 3) {
            state = "pending";
            nextAttemptAt = now + (retryCount === 1 ? 1_000 : 5_000);
          } else {
            state = "blocked";
          }
        } else {
          state = "blocked";
        }
      }

      const changed = this.db
        .prepare(
          "UPDATE work_change_requests SET state=?,provider=?,external_id=?,url=?,retry_count=?,next_attempt_at=?,last_error_code=?," +
            "operation_lease_until=NULL,operation_claimed_worker_id=NULL,updated_at=? " +
            "WHERE change_request_id=? AND operation_fencing=? AND operation_claimed_worker_id=?",
        )
        .run(
          state,
          provider,
          externalId,
          url,
          retryCount,
          nextAttemptAt,
          lastErrorCode,
          now,
          claim.changeRequestId,
          claim.fencing,
          claim.ownerWorkerId,
        );
      if (changed.changes !== 1) throw new Error("STALE_CHANGE_REQUEST_OPERATION");
      this.db.exec("COMMIT");
      return this.get(claim.changeRequestId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private fromRow(row: Row): WorkChangeRequestRecord {
    return {
      changeRequestId: String(row.change_request_id),
      workItemId: String(row.work_item_id),
      workAttemptId: String(row.work_attempt_id),
      publicationId: String(row.publication_id),
      ownerWorkerId: String(row.owner_worker_id),
      repositoryIdentity: String(row.repository_identity),
      repositoryUrl: String(row.repository_url),
      headBranch: String(row.head_branch),
      headCommit: String(row.head_commit),
      baseBranch: String(row.base_branch),
      title: String(row.title),
      body: String(row.body),
      idempotencyKey: String(row.idempotency_key),
      credentialGrantRef: String(row.credential_grant_ref),
      state: String(row.state) as WorkChangeRequestState,
      provider: row.provider == null ? null : String(row.provider),
      externalId: row.external_id == null ? null : String(row.external_id),
      url: row.url == null ? null : String(row.url),
      retryCount: Number(row.retry_count ?? 0),
      nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
      lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
      operationFencing: Number(row.operation_fencing ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
