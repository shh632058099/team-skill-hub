import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceChangeSummary } from "./workspace-change-summary.js";

export type WorkPublicationState =
  "preparing" | "prepared" | "approved" | "pushing" | "pushed" | "blocked" | "failed" | "cancelled";

export interface PublicationExecutionSnapshot {
  workspacePath: string;
  workspacePermissionModel?: "shared-gid-v1" | "single-uid-v2";
  workspaceOwnerUid?: number | null;
  workspaceOwnerGid?: number | null;
  repositoryUrl: string;
  defaultBranch: string;
  branchPrefix: string;
  protectedBranches: string[];
  allowedPushRemote: "origin";
  credentialRef?: string;
  expectedContentRevision: string;
  approvedChangeSummary: WorkspaceChangeSummary;
}

export interface PublicationOperationLease {
  publicationId: string;
  ownerWorkerId: string;
  operation: "prepare" | "push";
  fencing: number;
  workspaceId: string;
  branchName: string;
  sourceSubjectRevision: string;
  baseCommit: string;
  commitSha: string | null;
  treeSha: string | null;
  artifactRef: string | null;
  pushRefspec: string | null;
  commitTimestamp: number;
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitMessage: string;
  executionSnapshot: PublicationExecutionSnapshot | null;
}

export type PublicationOperationResult =
  | {
      success: true;
      commitSha?: string;
      treeSha?: string;
      artifactRef?: string;
      pushRefspec?: string;
    }
  | {
      success: false;
      errorCode: string;
      errorContext?: string;
    };

export interface WorkPublicationRecord {
  publicationId: string;
  workItemId: string;
  workAttemptId: string;
  workspaceId: string;
  state: WorkPublicationState;
  sourceSubjectRevision: string;
  baseCommit: string;
  repositoryId: string;
  repositoryIdentityRevision: number | null;
  publicationPolicyRevision: number;
  branchName: string;
  commitSha: string | null;
  treeSha: string | null;
  artifactRef: string | null;
  pushRemoteName: "origin";
  pushRefspec: string | null;
  ownerWorkerId: string;
  commitTimestamp: number;
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitMessage: string;
  executionSnapshot: PublicationExecutionSnapshot | null;
  preparedAt: number | null;
  approvedAt: number | null;
  pushedAt: number | null;
  lastErrorCode: string | null;
  lastErrorContext: string | null;
  retryCount: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicationArtifact {
  artifactId: string;
  kind: "git_commit";
  workItemId: string;
  workAttemptId: string;
  publicationId: string;
  sourceSubjectRevision: string;
  repositoryId: string;
  baseCommit: string;
  branchName: string;
  commitSha: string;
  treeSha: string;
  publicationPolicyRevision: number;
  createdAt: number;
}

export type CreatePublicationInput = Omit<
  WorkPublicationRecord,
  | "publicationId"
  | "state"
  | "commitSha"
  | "treeSha"
  | "artifactRef"
  | "pushRefspec"
  | "executionSnapshot"
  | "preparedAt"
  | "approvedAt"
  | "pushedAt"
  | "lastErrorCode"
  | "lastErrorContext"
  | "retryCount"
  | "nextAttemptAt"
  | "createdAt"
  | "updatedAt"
> & { pushRefspec?: string; executionSnapshot?: PublicationExecutionSnapshot };

export type PublicationTransitionPatch = Partial<
  Pick<
    WorkPublicationRecord,
    | "commitSha"
    | "treeSha"
    | "artifactRef"
    | "pushRefspec"
    | "preparedAt"
    | "approvedAt"
    | "pushedAt"
    | "lastErrorCode"
    | "lastErrorContext"
  >
>;

type Row = Record<string, unknown>;

const TRANSITIONS: Record<WorkPublicationState, ReadonlySet<WorkPublicationState>> = {
  preparing: new Set(["prepared", "blocked", "failed", "cancelled"]),
  prepared: new Set(["approved", "blocked", "cancelled"]),
  approved: new Set(["pushing", "blocked", "cancelled"]),
  pushing: new Set(["pushed", "blocked", "failed"]),
  pushed: new Set(),
  blocked: new Set(["preparing", "approved", "cancelled"]),
  failed: new Set(),
  cancelled: new Set(),
};

function requiredText(value: string, max: number): string {
  const result = value.trim();
  if (!result || result.length > max) throw new Error("INVALID_PUBLICATION");
  return result;
}

export class WorkPublicationStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(
      [
        "CREATE TABLE IF NOT EXISTS work_publications (",
        "  publication_id TEXT PRIMARY KEY,",
        "  work_item_id TEXT NOT NULL,",
        "  work_attempt_id TEXT NOT NULL,",
        "  workspace_id TEXT NOT NULL,",
        "  state TEXT NOT NULL CHECK(state IN ('preparing','prepared','approved','pushing','pushed','blocked','failed','cancelled')),",
        "  source_subject_revision TEXT NOT NULL,",
        "  base_commit TEXT NOT NULL,",
        "  repository_id TEXT NOT NULL,",
        "  repository_identity_revision INTEGER,",
        "  publication_policy_revision INTEGER NOT NULL,",
        "  branch_name TEXT NOT NULL,",
        "  commit_sha TEXT,",
        "  tree_sha TEXT,",
        "  artifact_ref TEXT,",
        "  push_remote_name TEXT NOT NULL CHECK(push_remote_name='origin'),",
        "  push_refspec TEXT,",
        "  owner_worker_id TEXT NOT NULL,",
        "  commit_timestamp INTEGER NOT NULL,",
        "  commit_author_name TEXT NOT NULL,",
        "  commit_author_email TEXT NOT NULL,",
        "  commit_message TEXT NOT NULL,",
        "  execution_snapshot_json TEXT,",
        "  prepared_at INTEGER,",
        "  approved_at INTEGER,",
        "  pushed_at INTEGER,",
        "  last_error_code TEXT,",
        "  last_error_context TEXT,",
        "  operation_fencing INTEGER NOT NULL DEFAULT 0,",
        "  operation_lease_until INTEGER,",
        "  operation_claimed_worker_id TEXT,",
        "  retry_count INTEGER NOT NULL DEFAULT 0,",
        "  next_attempt_at INTEGER,",
        "  created_at INTEGER NOT NULL,",
        "  updated_at INTEGER NOT NULL,",
        "  UNIQUE(work_attempt_id, repository_id)",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_publication_item ON work_publications(work_item_id, created_at);",
        "CREATE INDEX IF NOT EXISTS idx_work_publication_state ON work_publications(state, updated_at);",
      ].join("\n"),
    );
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(work_publications)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const additions: Array<[string, string]> = [
      ["execution_snapshot_json", "TEXT"],
      ["operation_fencing", "INTEGER NOT NULL DEFAULT 0"],
      ["operation_lease_until", "INTEGER"],
      ["operation_claimed_worker_id", "TEXT"],
      ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
      ["next_attempt_at", "INTEGER"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec("ALTER TABLE work_publications ADD COLUMN " + name + " " + definition);
    }
    const pushInfo = (
      this.db.prepare("PRAGMA table_info(work_publications)").all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((row) => row.name === "push_refspec");
    if (pushInfo?.notnull === 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(
          [
            "ALTER TABLE work_publications RENAME TO work_publications_legacy;",
            "CREATE TABLE work_publications (",
            "  publication_id TEXT PRIMARY KEY,",
            "  work_item_id TEXT NOT NULL,",
            "  work_attempt_id TEXT NOT NULL,",
            "  workspace_id TEXT NOT NULL,",
            "  state TEXT NOT NULL CHECK(state IN ('preparing','prepared','approved','pushing','pushed','blocked','failed','cancelled')),",
            "  source_subject_revision TEXT NOT NULL,",
            "  base_commit TEXT NOT NULL,",
            "  repository_id TEXT NOT NULL,",
            "  repository_identity_revision INTEGER,",
            "  publication_policy_revision INTEGER NOT NULL,",
            "  branch_name TEXT NOT NULL,",
            "  commit_sha TEXT,",
            "  tree_sha TEXT,",
            "  artifact_ref TEXT,",
            "  push_remote_name TEXT NOT NULL CHECK(push_remote_name='origin'),",
            "  push_refspec TEXT,",
            "  owner_worker_id TEXT NOT NULL,",
            "  commit_timestamp INTEGER NOT NULL,",
            "  commit_author_name TEXT NOT NULL,",
            "  commit_author_email TEXT NOT NULL,",
            "  commit_message TEXT NOT NULL,",
            "  execution_snapshot_json TEXT,",
            "  prepared_at INTEGER,",
            "  approved_at INTEGER,",
            "  pushed_at INTEGER,",
            "  last_error_code TEXT,",
            "  last_error_context TEXT,",
            "  operation_fencing INTEGER NOT NULL DEFAULT 0,",
            "  operation_lease_until INTEGER,",
            "  operation_claimed_worker_id TEXT,",
            "  retry_count INTEGER NOT NULL DEFAULT 0,",
            "  next_attempt_at INTEGER,",
            "  created_at INTEGER NOT NULL,",
            "  updated_at INTEGER NOT NULL,",
            "  UNIQUE(work_attempt_id, repository_id)",
            ");",
            "INSERT INTO work_publications(",
            " publication_id,work_item_id,work_attempt_id,workspace_id,state,source_subject_revision,base_commit,",
            " repository_id,repository_identity_revision,publication_policy_revision,branch_name,commit_sha,tree_sha,",
            " artifact_ref,push_remote_name,push_refspec,owner_worker_id,commit_timestamp,commit_author_name,",
            " commit_author_email,commit_message,execution_snapshot_json,prepared_at,approved_at,pushed_at,",
            " last_error_code,last_error_context,operation_fencing,operation_lease_until,operation_claimed_worker_id,retry_count,next_attempt_at,created_at,updated_at",
            ") SELECT publication_id,work_item_id,work_attempt_id,workspace_id,state,source_subject_revision,base_commit,",
            " repository_id,repository_identity_revision,publication_policy_revision,branch_name,commit_sha,tree_sha,",
            " artifact_ref,push_remote_name,push_refspec,owner_worker_id,commit_timestamp,commit_author_name,",
            " commit_author_email,commit_message,execution_snapshot_json,prepared_at,approved_at,pushed_at,",
            " last_error_code,last_error_context,operation_fencing,operation_lease_until,operation_claimed_worker_id,retry_count,next_attempt_at,created_at,updated_at",
            " FROM work_publications_legacy;",
            "DROP TABLE work_publications_legacy;",
            "CREATE INDEX IF NOT EXISTS idx_work_publication_item ON work_publications(work_item_id, created_at);",
            "CREATE INDEX IF NOT EXISTS idx_work_publication_state ON work_publications(state, updated_at);",
          ].join("\n"),
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  createOrReusePublication(input: CreatePublicationInput, now = Date.now()): WorkPublicationRecord {
    const normalized = {
      ...input,
      workItemId: requiredText(input.workItemId, 200),
      workAttemptId: requiredText(input.workAttemptId, 200),
      workspaceId: requiredText(input.workspaceId, 200),
      sourceSubjectRevision: requiredText(input.sourceSubjectRevision, 500),
      baseCommit: requiredText(input.baseCommit, 128),
      repositoryId: requiredText(input.repositoryId, 200),
      branchName: requiredText(input.branchName, 300),
      pushRefspec: input.pushRefspec === undefined ? null : requiredText(input.pushRefspec, 700),
      ownerWorkerId: requiredText(input.ownerWorkerId, 200),
      commitAuthorName: requiredText(input.commitAuthorName, 200),
      commitAuthorEmail: requiredText(input.commitAuthorEmail, 320),
      commitMessage: requiredText(input.commitMessage, 20_000),
      executionSnapshot: input.executionSnapshot ?? null,
    };
    if (
      !Number.isSafeInteger(normalized.publicationPolicyRevision) ||
      normalized.publicationPolicyRevision < 1 ||
      (normalized.repositoryIdentityRevision !== null &&
        (!Number.isSafeInteger(normalized.repositoryIdentityRevision) || normalized.repositoryIdentityRevision < 1)) ||
      normalized.pushRemoteName !== "origin" ||
      !Number.isSafeInteger(normalized.commitTimestamp) ||
      normalized.commitTimestamp <= 0
    ) {
      throw new Error("INVALID_PUBLICATION");
    }

    const existing = this.db
      .prepare("SELECT * FROM work_publications WHERE work_attempt_id=? AND repository_id=?")
      .get(normalized.workAttemptId, normalized.repositoryId) as Row | undefined;
    if (existing) {
      const current = this.fromRow(existing);
      if (current.sourceSubjectRevision !== normalized.sourceSubjectRevision)
        throw new Error("PUBLICATION_SOURCE_REVISION_CONFLICT");
      const immutableMatches =
        current.workItemId === normalized.workItemId &&
        current.workspaceId === normalized.workspaceId &&
        current.baseCommit === normalized.baseCommit &&
        current.repositoryIdentityRevision === normalized.repositoryIdentityRevision &&
        current.publicationPolicyRevision === normalized.publicationPolicyRevision &&
        current.branchName === normalized.branchName &&
        current.pushRemoteName === normalized.pushRemoteName &&
        (normalized.pushRefspec === null || current.pushRefspec === normalized.pushRefspec) &&
        current.ownerWorkerId === normalized.ownerWorkerId &&
        current.commitTimestamp === normalized.commitTimestamp &&
        current.commitAuthorName === normalized.commitAuthorName &&
        current.commitAuthorEmail === normalized.commitAuthorEmail &&
        current.commitMessage === normalized.commitMessage;
      const existingSnapshot = current.executionSnapshot ? JSON.stringify(current.executionSnapshot) : null;
      const inputSnapshot = normalized.executionSnapshot ? JSON.stringify(normalized.executionSnapshot) : null;
      const fullImmutableMatches = immutableMatches && existingSnapshot === inputSnapshot;
      if (!fullImmutableMatches) throw new Error("PUBLICATION_IDEMPOTENCY_CONFLICT");
      return current;
    }

    const publicationId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO work_publications(" +
          "publication_id,work_item_id,work_attempt_id,workspace_id,state,source_subject_revision,base_commit," +
          "repository_id,repository_identity_revision,publication_policy_revision,branch_name,commit_sha,tree_sha," +
          "artifact_ref,push_remote_name,push_refspec,owner_worker_id,commit_timestamp,commit_author_name," +
          "commit_author_email,commit_message,execution_snapshot_json,prepared_at,approved_at,pushed_at,last_error_code,last_error_context," +
          "operation_fencing,operation_lease_until,operation_claimed_worker_id,retry_count,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        publicationId,
        normalized.workItemId,
        normalized.workAttemptId,
        normalized.workspaceId,
        "preparing",
        normalized.sourceSubjectRevision,
        normalized.baseCommit,
        normalized.repositoryId,
        normalized.repositoryIdentityRevision,
        normalized.publicationPolicyRevision,
        normalized.branchName,
        null,
        null,
        null,
        "origin",
        normalized.pushRefspec,
        normalized.ownerWorkerId,
        normalized.commitTimestamp,
        normalized.commitAuthorName,
        normalized.commitAuthorEmail,
        normalized.commitMessage,
        normalized.executionSnapshot ? JSON.stringify(normalized.executionSnapshot) : null,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        0,
        null,
        now,
        now,
      );
    return this.getPublication(publicationId);
  }

  getPublication(publicationId: string): WorkPublicationRecord {
    const row = this.db.prepare("SELECT * FROM work_publications WHERE publication_id=?").get(publicationId) as
      Row | undefined;
    if (!row) throw new Error("PUBLICATION_NOT_FOUND");
    return this.fromRow(row);
  }

  listPublications(workItemId: string): WorkPublicationRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM work_publications WHERE work_item_id=? ORDER BY created_at,publication_id")
        .all(workItemId) as Row[]
    ).map((row) => this.fromRow(row));
  }

  cancelForWork(
    workItemId: string,
    now = Date.now(),
  ): {
    cancelledPublicationIds: string[];
    outcomeUnknownPublicationIds: string[];
  } {
    const id = requiredText(workItemId, 200);
    if (!Number.isFinite(now)) throw new Error("INVALID_PUBLICATION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM work_publications WHERE work_item_id=? AND state IN ('preparing','prepared','approved','pushing','blocked') ORDER BY created_at,publication_id",
        )
        .all(id) as Row[];
      const cancelledPublicationIds: string[] = [];
      const outcomeUnknownPublicationIds: string[] = [];

      for (const row of rows) {
        const current = this.fromRow(row);
        const fencing = Number(row.operation_fencing ?? 0) + 1;
        if (current.state === "pushing") {
          const changed = this.db
            .prepare(
              "UPDATE work_publications SET state='failed',last_error_code='WORK_CANCELLED_OUTCOME_UNKNOWN',last_error_context='Publication push was in flight when Work was cancelled; reconcile remote outcome manually.',operation_fencing=?,operation_lease_until=NULL,operation_claimed_worker_id=NULL,next_attempt_at=NULL,updated_at=? WHERE publication_id=? AND operation_fencing=? AND state='pushing'",
            )
            .run(fencing, now, current.publicationId, Number(row.operation_fencing ?? 0));
          if (changed.changes !== 1) throw new Error("STALE_PUBLICATION_OPERATION");
          outcomeUnknownPublicationIds.push(current.publicationId);
          continue;
        }

        const changed = this.db
          .prepare(
            "UPDATE work_publications SET state='cancelled',last_error_code='WORK_CANCELLED',last_error_context=NULL,operation_fencing=?,operation_lease_until=NULL,operation_claimed_worker_id=NULL,next_attempt_at=NULL,updated_at=? WHERE publication_id=? AND operation_fencing=? AND state IN ('preparing','prepared','approved','blocked')",
          )
          .run(fencing, now, current.publicationId, Number(row.operation_fencing ?? 0));
        if (changed.changes !== 1) throw new Error("STALE_PUBLICATION_OPERATION");
        cancelledPublicationIds.push(current.publicationId);
      }

      this.db.exec("COMMIT");
      return { cancelledPublicationIds, outcomeUnknownPublicationIds };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  transitionPublication(
    publicationId: string,
    nextState: WorkPublicationState,
    patch: PublicationTransitionPatch | Record<string, unknown> = {},
    now = Date.now(),
  ): WorkPublicationRecord {
    const current = this.getPublication(publicationId);
    if (!TRANSITIONS[current.state].has(nextState)) throw new Error("INVALID_PUBLICATION_TRANSITION");
    const allowedKeys = new Set([
      "commitSha",
      "treeSha",
      "artifactRef",
      "pushRefspec",
      "preparedAt",
      "approvedAt",
      "pushedAt",
      "lastErrorCode",
      "lastErrorContext",
    ]);
    if (Object.keys(patch).some((key) => !allowedKeys.has(key))) throw new Error("PUBLICATION_IDENTITY_IMMUTABLE");

    const merged = { ...current, ...patch };
    if (
      "pushRefspec" in patch &&
      (nextState !== "prepared" || current.pushRefspec !== null) &&
      patch.pushRefspec !== current.pushRefspec
    ) {
      throw new Error("PUBLICATION_IDENTITY_IMMUTABLE");
    }
    if (
      nextState === "prepared" &&
      (!merged.commitSha || !merged.treeSha || !merged.artifactRef || !merged.pushRefspec)
    )
      throw new Error("INVALID_PUBLICATION_TRANSITION");
    const preparedAt = nextState === "prepared" ? (merged.preparedAt ?? now) : merged.preparedAt;
    const approvedAt = nextState === "approved" ? (merged.approvedAt ?? now) : merged.approvedAt;
    const pushedAt = nextState === "pushed" ? (merged.pushedAt ?? now) : merged.pushedAt;

    this.db
      .prepare(
        "UPDATE work_publications SET state=?,commit_sha=?,tree_sha=?,artifact_ref=?,push_refspec=?,prepared_at=?,approved_at=?," +
          "pushed_at=?,last_error_code=?,last_error_context=?,updated_at=? WHERE publication_id=?",
      )
      .run(
        nextState,
        merged.commitSha,
        merged.treeSha,
        merged.artifactRef,
        merged.pushRefspec,
        preparedAt,
        approvedAt,
        pushedAt,
        merged.lastErrorCode,
        merged.lastErrorContext,
        now,
        publicationId,
      );
    return this.getPublication(publicationId);
  }

  claimPublicationOperation(workerId: string, now = Date.now(), leaseMs = 30_000): PublicationOperationLease | null {
    const owner = requiredText(workerId, 200);
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_PUBLICATION_LEASE");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM work_publications WHERE owner_worker_id=? " +
            "AND state IN ('preparing','approved','pushing') " +
            "AND (operation_lease_until IS NULL OR operation_lease_until<?) " +
            "AND (next_attempt_at IS NULL OR next_attempt_at<=?) " +
            "ORDER BY created_at,publication_id LIMIT 1",
        )
        .get(owner, now, now) as Row | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const publication = this.fromRow(row);
      if (!publication.executionSnapshot) throw new Error("PUBLICATION_EXECUTION_SNAPSHOT_MISSING");
      const operation = publication.state === "preparing" ? "prepare" : "push";
      const fencing = Number(row.operation_fencing ?? 0) + 1;
      const nextState = operation === "push" ? "pushing" : "preparing";
      const changed = this.db
        .prepare(
          "UPDATE work_publications SET state=?,operation_fencing=?,operation_lease_until=?,operation_claimed_worker_id=?,updated_at=? " +
            "WHERE publication_id=? AND owner_worker_id=? AND operation_fencing=?",
        )
        .run(
          nextState,
          fencing,
          now + leaseMs,
          owner,
          now,
          publication.publicationId,
          owner,
          Number(row.operation_fencing ?? 0),
        );
      if (changed.changes !== 1) throw new Error("STALE_PUBLICATION_OPERATION");
      const current = this.getPublication(publication.publicationId);
      this.db.exec("COMMIT");
      return {
        publicationId: current.publicationId,
        ownerWorkerId: owner,
        operation,
        fencing,
        workspaceId: current.workspaceId,
        branchName: current.branchName,
        sourceSubjectRevision: current.sourceSubjectRevision,
        baseCommit: current.baseCommit,
        commitSha: current.commitSha,
        treeSha: current.treeSha,
        artifactRef: current.artifactRef,
        pushRefspec: current.pushRefspec,
        commitTimestamp: current.commitTimestamp,
        commitAuthorName: current.commitAuthorName,
        commitAuthorEmail: current.commitAuthorEmail,
        commitMessage: current.commitMessage,
        executionSnapshot: current.executionSnapshot,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completePublicationOperation(
    claim: PublicationOperationLease,
    result: PublicationOperationResult,
    now = Date.now(),
  ): WorkPublicationRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM work_publications WHERE publication_id=?").get(claim.publicationId) as
        Row | undefined;
      if (!row) throw new Error("PUBLICATION_NOT_FOUND");
      const current = this.fromRow(row);
      const expectedState: WorkPublicationState = claim.operation === "prepare" ? "preparing" : "pushing";
      if (
        current.ownerWorkerId !== claim.ownerWorkerId ||
        current.state !== expectedState ||
        Number(row.operation_fencing ?? 0) !== claim.fencing ||
        String(row.operation_claimed_worker_id ?? "") !== claim.ownerWorkerId ||
        Number(row.operation_lease_until ?? 0) < now
      ) {
        throw new Error("STALE_PUBLICATION_OPERATION");
      }
      let nextState: WorkPublicationState;
      let commitSha = current.commitSha;
      let treeSha = current.treeSha;
      let artifactRef = current.artifactRef;
      let pushRefspec = current.pushRefspec;
      let preparedAt = current.preparedAt;
      let pushedAt = current.pushedAt;
      let lastErrorCode: string | null = null;
      let lastErrorContext: string | null = null;
      let retryCount = Number(row.retry_count ?? 0);
      let nextAttemptAt: number | null = null;
      if (!result.success) {
        lastErrorCode = requiredText(result.errorCode, 100);
        lastErrorContext = result.errorContext?.trim().slice(0, 1000) || null;
        if (claim.operation === "push" && lastErrorCode === "PUBLICATION_PUSH_FAILED") {
          retryCount += 1;
          if (retryCount < 3) {
            const backoffMs = retryCount === 1 ? 1_000 : 5_000;
            nextState = "approved";
            nextAttemptAt = now + backoffMs;
          } else {
            nextState = "blocked";
          }
        } else {
          nextState = "blocked";
        }
      } else if (claim.operation === "prepare") {
        commitSha = requiredText(result.commitSha ?? "", 128);
        treeSha = requiredText(result.treeSha ?? "", 128);
        artifactRef = requiredText(result.artifactRef ?? "", 500);
        pushRefspec = requiredText(result.pushRefspec ?? "", 700);
        nextState = "prepared";
        preparedAt = now;
      } else {
        if (!current.commitSha || !current.pushRefspec) throw new Error("PUBLICATION_ARTIFACT_NOT_PREPARED");
        nextState = "pushed";
        pushedAt = now;
      }
      this.db
        .prepare(
          "UPDATE work_publications SET state=?,commit_sha=?,tree_sha=?,artifact_ref=?,push_refspec=?,prepared_at=?,pushed_at=?," +
            "last_error_code=?,last_error_context=?,retry_count=?,next_attempt_at=?,operation_lease_until=NULL,operation_claimed_worker_id=NULL,updated_at=? " +
            "WHERE publication_id=? AND operation_fencing=? AND operation_claimed_worker_id=?",
        )
        .run(
          nextState,
          commitSha,
          treeSha,
          artifactRef,
          pushRefspec,
          preparedAt,
          pushedAt,
          lastErrorCode,
          lastErrorContext,
          retryCount,
          nextAttemptAt,
          now,
          claim.publicationId,
          claim.fencing,
          claim.ownerWorkerId,
        );
      this.db.exec("COMMIT");
      return this.getPublication(claim.publicationId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPublicationArtifact(publicationId: string): PublicationArtifact | null {
    const publication = this.getPublication(publicationId);
    if (!publication.commitSha || !publication.treeSha || !publication.artifactRef || !publication.preparedAt)
      return null;
    return {
      artifactId: publication.artifactRef,
      kind: "git_commit",
      workItemId: publication.workItemId,
      workAttemptId: publication.workAttemptId,
      publicationId: publication.publicationId,
      sourceSubjectRevision: publication.sourceSubjectRevision,
      repositoryId: publication.repositoryId,
      baseCommit: publication.baseCommit,
      branchName: publication.branchName,
      commitSha: publication.commitSha,
      treeSha: publication.treeSha,
      publicationPolicyRevision: publication.publicationPolicyRevision,
      createdAt: publication.preparedAt,
    };
  }

  private fromRow(row: Row): WorkPublicationRecord {
    return {
      publicationId: String(row.publication_id),
      workItemId: String(row.work_item_id),
      workAttemptId: String(row.work_attempt_id),
      workspaceId: String(row.workspace_id),
      state: String(row.state) as WorkPublicationState,
      sourceSubjectRevision: String(row.source_subject_revision),
      baseCommit: String(row.base_commit),
      repositoryId: String(row.repository_id),
      repositoryIdentityRevision:
        row.repository_identity_revision == null ? null : Number(row.repository_identity_revision),
      publicationPolicyRevision: Number(row.publication_policy_revision),
      branchName: String(row.branch_name),
      commitSha: row.commit_sha == null ? null : String(row.commit_sha),
      treeSha: row.tree_sha == null ? null : String(row.tree_sha),
      artifactRef: row.artifact_ref == null ? null : String(row.artifact_ref),
      pushRemoteName: "origin",
      pushRefspec: row.push_refspec == null ? null : String(row.push_refspec),
      ownerWorkerId: String(row.owner_worker_id),
      commitTimestamp: Number(row.commit_timestamp),
      commitAuthorName: String(row.commit_author_name),
      commitAuthorEmail: String(row.commit_author_email),
      commitMessage: String(row.commit_message),
      executionSnapshot: row.execution_snapshot_json
        ? (JSON.parse(String(row.execution_snapshot_json)) as PublicationExecutionSnapshot)
        : null,
      preparedAt: row.prepared_at == null ? null : Number(row.prepared_at),
      approvedAt: row.approved_at == null ? null : Number(row.approved_at),
      pushedAt: row.pushed_at == null ? null : Number(row.pushed_at),
      lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
      lastErrorContext: row.last_error_context == null ? null : String(row.last_error_context),
      retryCount: Number(row.retry_count ?? 0),
      nextAttemptAt: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
