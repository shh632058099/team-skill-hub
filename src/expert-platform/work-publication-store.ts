import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WorkPublicationState =
  "preparing" | "prepared" | "approved" | "pushing" | "pushed" | "blocked" | "failed" | "cancelled";

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
  pushRefspec: string;
  ownerWorkerId: string;
  commitTimestamp: number;
  commitAuthorName: string;
  commitAuthorEmail: string;
  commitMessage: string;
  preparedAt: number | null;
  approvedAt: number | null;
  pushedAt: number | null;
  lastErrorCode: string | null;
  lastErrorContext: string | null;
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
  | "preparedAt"
  | "approvedAt"
  | "pushedAt"
  | "lastErrorCode"
  | "lastErrorContext"
  | "createdAt"
  | "updatedAt"
>;

export type PublicationTransitionPatch = Partial<
  Pick<
    WorkPublicationRecord,
    | "commitSha"
    | "treeSha"
    | "artifactRef"
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
        "  push_refspec TEXT NOT NULL,",
        "  owner_worker_id TEXT NOT NULL,",
        "  commit_timestamp INTEGER NOT NULL,",
        "  commit_author_name TEXT NOT NULL,",
        "  commit_author_email TEXT NOT NULL,",
        "  commit_message TEXT NOT NULL,",
        "  prepared_at INTEGER,",
        "  approved_at INTEGER,",
        "  pushed_at INTEGER,",
        "  last_error_code TEXT,",
        "  last_error_context TEXT,",
        "  created_at INTEGER NOT NULL,",
        "  updated_at INTEGER NOT NULL,",
        "  UNIQUE(work_attempt_id, repository_id)",
        ");",
        "CREATE INDEX IF NOT EXISTS idx_work_publication_item ON work_publications(work_item_id, created_at);",
        "CREATE INDEX IF NOT EXISTS idx_work_publication_state ON work_publications(state, updated_at);",
      ].join("\n"),
    );
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
      pushRefspec: requiredText(input.pushRefspec, 700),
      ownerWorkerId: requiredText(input.ownerWorkerId, 200),
      commitAuthorName: requiredText(input.commitAuthorName, 200),
      commitAuthorEmail: requiredText(input.commitAuthorEmail, 320),
      commitMessage: requiredText(input.commitMessage, 20_000),
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
        current.pushRefspec === normalized.pushRefspec &&
        current.ownerWorkerId === normalized.ownerWorkerId &&
        current.commitTimestamp === normalized.commitTimestamp &&
        current.commitAuthorName === normalized.commitAuthorName &&
        current.commitAuthorEmail === normalized.commitAuthorEmail &&
        current.commitMessage === normalized.commitMessage;
      if (!immutableMatches) throw new Error("PUBLICATION_IDEMPOTENCY_CONFLICT");
      return current;
    }

    const publicationId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO work_publications(" +
          "publication_id,work_item_id,work_attempt_id,workspace_id,state,source_subject_revision,base_commit," +
          "repository_id,repository_identity_revision,publication_policy_revision,branch_name,commit_sha,tree_sha," +
          "artifact_ref,push_remote_name,push_refspec,owner_worker_id,commit_timestamp,commit_author_name," +
          "commit_author_email,commit_message,prepared_at,approved_at,pushed_at,last_error_code,last_error_context," +
          "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        null,
        null,
        null,
        null,
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
      "preparedAt",
      "approvedAt",
      "pushedAt",
      "lastErrorCode",
      "lastErrorContext",
    ]);
    if (Object.keys(patch).some((key) => !allowedKeys.has(key))) throw new Error("PUBLICATION_IDENTITY_IMMUTABLE");

    const merged = { ...current, ...patch };
    if (nextState === "prepared" && (!merged.commitSha || !merged.treeSha || !merged.artifactRef))
      throw new Error("INVALID_PUBLICATION_TRANSITION");
    const preparedAt = nextState === "prepared" ? (merged.preparedAt ?? now) : merged.preparedAt;
    const approvedAt = nextState === "approved" ? (merged.approvedAt ?? now) : merged.approvedAt;
    const pushedAt = nextState === "pushed" ? (merged.pushedAt ?? now) : merged.pushedAt;

    this.db
      .prepare(
        "UPDATE work_publications SET state=?,commit_sha=?,tree_sha=?,artifact_ref=?,prepared_at=?,approved_at=?," +
          "pushed_at=?,last_error_code=?,last_error_context=?,updated_at=? WHERE publication_id=?",
      )
      .run(
        nextState,
        merged.commitSha,
        merged.treeSha,
        merged.artifactRef,
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
      pushRefspec: String(row.push_refspec),
      ownerWorkerId: String(row.owner_worker_id),
      commitTimestamp: Number(row.commit_timestamp),
      commitAuthorName: String(row.commit_author_name),
      commitAuthorEmail: String(row.commit_author_email),
      commitMessage: String(row.commit_message),
      preparedAt: row.prepared_at == null ? null : Number(row.prepared_at),
      approvedAt: row.approved_at == null ? null : Number(row.approved_at),
      pushedAt: row.pushed_at == null ? null : Number(row.pushed_at),
      lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
      lastErrorContext: row.last_error_context == null ? null : String(row.last_error_context),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
