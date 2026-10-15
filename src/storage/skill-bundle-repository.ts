import type { SkillHubDatabase } from "./database.js";
import type { SkillBundleImport, SkillBundleSnapshot } from "../skill-bundles.js";

const parse = <T>(value: string): T => JSON.parse(value) as T;
const toMs = (value: string): number => {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`invalid timestamp: ${value}`);
  return result;
};

export class SqliteSkillBundleRepository {
  constructor(readonly database: SkillHubDatabase) {}

  saveSnapshot(snapshot: SkillBundleSnapshot): SkillBundleSnapshot {
    const existing = this.database.raw.prepare("SELECT id FROM skill_bundle_snapshot WHERE sha256=?").get(snapshot.sha256) as { id?: string } | undefined;
    if (existing?.id) return this.getSnapshot(existing.id)!;
    try {
      this.database.transaction(() => {
        this.database.raw.prepare("INSERT INTO skill_bundle_snapshot(id,sha256,created_at,file_count,total_bytes,skills_json) VALUES(?,?,?,?,?,?)")
          .run(snapshot.id, snapshot.sha256, toMs(snapshot.createdAt), snapshot.fileCount, snapshot.totalBytes, JSON.stringify(snapshot.skills));
        const insert = this.database.raw.prepare("INSERT INTO skill_bundle_file(snapshot_id,path,mode,sha256,size_bytes,content,encoding) VALUES(?,?,?,?,?,?,?)");
        for (const file of snapshot.files) insert.run(snapshot.id, file.path, file.mode, file.sha256, file.sizeBytes, file.content ?? file.contentBase64 ?? "", file.content !== undefined ? "utf8" : "base64");
      });
      return snapshot;
    } catch (error) {
      const concurrent = this.database.raw.prepare("SELECT id FROM skill_bundle_snapshot WHERE sha256=?").get(snapshot.sha256) as { id?: string } | undefined;
      if (concurrent?.id) return this.getSnapshot(concurrent.id)!;
      throw error;
    }
  }

  getSnapshot(id: string): SkillBundleSnapshot | undefined {
    const row = this.database.raw.prepare("SELECT * FROM skill_bundle_snapshot WHERE id=?").get(id) as any;
    if (!row) return undefined;
    const files = (this.database.raw.prepare("SELECT path,mode,sha256,size_bytes,content,encoding FROM skill_bundle_file WHERE snapshot_id=? ORDER BY path").all(id) as any[])
      .map((file) => ({
        path: String(file.path),
        mode: file.mode as "0644" | "0755",
        sha256: String(file.sha256),
        sizeBytes: Number(file.size_bytes),
        ...(String(file.encoding ?? "utf8") === "base64" ? { contentBase64: String(file.content) } : { content: String(file.content) })
      }));
    return {
      id: String(row.id),
      sha256: String(row.sha256),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      fileCount: Number(row.file_count),
      totalBytes: Number(row.total_bytes),
      skills: parse(row.skills_json),
      files
    };
  }

  createImport(record: SkillBundleImport): SkillBundleImport {
    if (!this.getSnapshot(record.snapshotId)) throw new Error("Skill Bundle snapshot not found");
    const stored = { ...record, revision: 0 };
    this.database.transaction(() => {
      this.database.raw.prepare("INSERT INTO skill_bundle_import(id,updated_at,status,repository,namespace,import_type,skill_path,replacement_root,snapshot_id,snapshot_sha256,submission_principal,submission_key,request_semantics_sha256,revision,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(stored.id, toMs(stored.updatedAt), stored.status, stored.repository, stored.namespace, stored.importType, stored.skillPath ?? null, stored.replacementRoot, stored.snapshotId, stored.snapshotSha256, stored.submitter ?? null, stored.submissionKey ?? null, stored.requestSemanticsSha256 ?? null, stored.revision, JSON.stringify(stored));
      this.insertHistory(stored);
    });
    return stored;
  }

  updateImport(record: SkillBundleImport): SkillBundleImport {
    const expectedRevision = record.revision;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("Skill Bundle import revision is invalid");
    const next = { ...record, revision: expectedRevision + 1 };
    this.database.transaction(() => {
      const result = this.database.raw.prepare("UPDATE skill_bundle_import SET updated_at=?,status=?,repository=?,namespace=?,import_type=?,skill_path=?,replacement_root=?,snapshot_id=?,snapshot_sha256=?,submission_principal=?,submission_key=?,request_semantics_sha256=?,revision=?,record_json=? WHERE id=? AND revision=?")
        .run(toMs(next.updatedAt), next.status, next.repository, next.namespace, next.importType, next.skillPath ?? null, next.replacementRoot, next.snapshotId, next.snapshotSha256, next.submitter ?? null, next.submissionKey ?? null, next.requestSemanticsSha256 ?? null, next.revision, JSON.stringify(next), next.id, expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Skill Bundle import state conflict");
      this.insertHistory(next);
    });
    return next;
  }

  private insertHistory(record: SkillBundleImport): void {
    this.database.raw.prepare("INSERT OR IGNORE INTO skill_bundle_import_history(import_id,updated_at,status,snapshot_id,snapshot_sha256,revision,record_json) VALUES(?,?,?,?,?,?,?)")
      .run(record.id, toMs(record.updatedAt), record.status, record.snapshotId, record.snapshotSha256, record.revision, JSON.stringify(record));
  }

  getImport(id: string): SkillBundleImport | undefined {
    const row = this.database.raw.prepare("SELECT revision,record_json FROM skill_bundle_import WHERE id=?").get(id) as any;
    return row ? { ...parse<SkillBundleImport>(row.record_json), revision: Number(row.revision) } : undefined;
  }

  getImportHistory(id: string): SkillBundleImport[] {
    return (this.database.raw.prepare("SELECT revision,record_json FROM skill_bundle_import_history WHERE import_id=? ORDER BY updated_at,seq").all(id) as any[])
      .map((row) => ({ ...parse<SkillBundleImport>(row.record_json), revision: Number(row.revision) }));
  }

  listImports(limit = 200): SkillBundleImport[] {
    const n = Math.max(1, Math.min(limit, 1000));
    return (this.database.raw.prepare("SELECT revision,record_json FROM skill_bundle_import ORDER BY updated_at DESC,id DESC LIMIT ?").all(n) as any[])
      .map((row) => ({ ...parse<SkillBundleImport>(row.record_json), revision: Number(row.revision) }));
  }

  listImportsPage(query: {
    limit?: string | number;
    cursor?: string | number;
    q?: string;
    status?: string;
    repository?: string;
    namespace?: string;
    importType?: string;
    sourceType?: string;
    reviewer?: string;
    submitter?: string;
  }) {
    const parsedLimit = Number(query.limit ?? 20);
    const limit = Math.max(1, Math.min(Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 20, 100));
    const parsedCursor = Number(query.cursor ?? 0);
    const offset = Number.isFinite(parsedCursor) && parsedCursor > 0 ? Math.floor(parsedCursor) : 0;
    const where: string[] = [];
    const params: Array<string | number> = [];
    const addExact = (column: string, value?: string) => {
      if (!value) return;
      where.push(`${column}=?`);
      params.push(value);
    };
    addExact("status", query.status);
    addExact("repository", query.repository);
    addExact("namespace", query.namespace);
    addExact("import_type", query.importType);
    addExact("submission_principal", query.submitter);
    if (query.sourceType) { where.push("json_extract(record_json,'$.sourceType')=?"); params.push(query.sourceType); }
    if (query.reviewer) { where.push("json_extract(record_json,'$.review.reviewer')=?"); params.push(query.reviewer); }
    const q = query.q?.trim().toLowerCase();
    if (q) {
      where.push("lower(id || ' ' || namespace || ' ' || import_type || ' ' || coalesce(skill_path,'') || ' ' || replacement_root || ' ' || status || ' ' || repository || ' ' || coalesce(submission_principal,'') || ' ' || record_json) LIKE ?");
      params.push(`%${q}%`);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const totalRow = this.database.raw.prepare(`SELECT count(*) AS total FROM skill_bundle_import${clause}`).get(...params) as { total: number | bigint };
    const rows = this.database.raw.prepare(`SELECT revision,record_json FROM skill_bundle_import${clause} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
    const total = Number(totalRow.total);
    return {
      items: rows.map((row) => ({ ...parse<SkillBundleImport>(row.record_json), revision: Number(row.revision) })),
      total,
      limit,
      cursor: String(offset),
      nextCursor: offset + limit < total ? String(offset + limit) : undefined,
      previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined
    };
  }

  findBySubmissionKey(principal: string, key: string): SkillBundleImport | undefined {
    const row = this.database.raw.prepare("SELECT revision,record_json FROM skill_bundle_import WHERE submission_principal=? AND submission_key=?").get(principal, key) as any;
    return row ? { ...parse<SkillBundleImport>(row.record_json), revision: Number(row.revision) } : undefined;
  }
}
