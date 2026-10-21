import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkerRegistration, WorkerStatus } from "./worker-registry.js";

type Row = { id: string; capabilities_json: string; status: WorkerStatus };

export class PersistentWorkerRegistry {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS expert_workers (
        id TEXT PRIMARY KEY,
        capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
        credential_hash TEXT
      );
    `);
  }

  enroll(id: string, capabilities: string[]): WorkerRegistration {
    if (!id.trim() || capabilities.length === 0 || capabilities.some((capability) => !capability.trim())) {
      throw new Error("INVALID_WORKER");
    }
    if (this.db.prepare("SELECT 1 FROM expert_workers WHERE id=?").get(id)) {
      throw new Error("WORKER_ALREADY_EXISTS");
    }
    const unique = [...new Set(capabilities)];
    this.db
      .prepare("INSERT INTO expert_workers(id,capabilities_json,status) VALUES(?,?,'pending')")
      .run(id, JSON.stringify(unique));
    return { id, capabilities: unique, status: "pending" };
  }

  approve(id: string): void {
    const worker = this.get(id);
    if (worker.status === "revoked") throw new Error("WORKER_REVOKED");
    this.db.prepare("UPDATE expert_workers SET status='active' WHERE id=?").run(id);
  }

  revoke(id: string): void {
    this.get(id);
    this.db.prepare("UPDATE expert_workers SET status='revoked' WHERE id=?").run(id);
  }

  get(id: string): WorkerRegistration {
    const row = this.db.prepare("SELECT id,capabilities_json,status FROM expert_workers WHERE id=?").get(id) as
      Row | undefined;
    if (!row) throw new Error("WORKER_NOT_FOUND");
    const capabilities = JSON.parse(row.capabilities_json) as unknown;
    if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string")) {
      throw new Error("WORKER_RECORD_INVALID");
    }
    return { id: row.id, capabilities, status: row.status };
  }

  isAuthorized(id: string, capability: string): boolean {
    try {
      const worker = this.get(id);
      return worker.status === "active" && worker.capabilities.includes(capability);
    } catch (error) {
      if (error instanceof Error && error.message === "WORKER_NOT_FOUND") return false;
      throw error;
    }
  }

  issueCredential(id: string): string {
    const worker = this.get(id);
    if (worker.status !== "active") throw new Error("WORKER_NOT_ACTIVE");
    const token = `ewc_${randomBytes(32).toString("base64url")}`;
    const digest = this.hashCredential(token);
    this.db.prepare("UPDATE expert_workers SET credential_hash=? WHERE id=?").run(digest, id);
    return token;
  }

  authenticate(id: string, token: string): boolean {
    if (!id.trim() || !token.trim()) return false;
    const row = this.db.prepare("SELECT status,credential_hash FROM expert_workers WHERE id=?").get(id) as
      { status: WorkerStatus; credential_hash: string | null } | undefined;
    if (!row || row.status !== "active" || !row.credential_hash) return false;
    const supplied = Buffer.from(this.hashCredential(token), "hex");
    const expected = Buffer.from(row.credential_hash, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private hashCredential(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  close(): void {
    this.db.close();
  }
}
