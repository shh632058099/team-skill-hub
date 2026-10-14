import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [{ version: 1, name: "observability-foundation", sql: `
CREATE TABLE client_events(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,event TEXT NOT NULL,repository_id TEXT,record_json TEXT NOT NULL);
CREATE INDEX idx_client_events_ts ON client_events(ts DESC,id DESC);
CREATE INDEX idx_client_events_session ON client_events(tenant_id,actor_id,session_id,ts,id);
CREATE INDEX idx_client_events_actor_ts ON client_events(tenant_id,actor_id,ts DESC,id DESC);
CREATE INDEX idx_client_events_event_ts ON client_events(event,ts DESC,id DESC);
CREATE INDEX idx_client_events_repository_ts ON client_events(repository_id,ts DESC,id DESC);
CREATE TABLE mcp_calls(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,session_id TEXT,trace_id TEXT NOT NULL,tool TEXT NOT NULL,success INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX idx_mcp_calls_ts ON mcp_calls(ts DESC,id DESC);
CREATE INDEX idx_mcp_calls_session ON mcp_calls(tenant_id,actor_id,session_id,ts,id);
CREATE INDEX idx_mcp_calls_actor_ts ON mcp_calls(tenant_id,actor_id,ts DESC,id DESC);
CREATE INDEX idx_mcp_calls_tool_ts ON mcp_calls(tool,ts DESC,id DESC);
CREATE INDEX idx_mcp_calls_success_ts ON mcp_calls(success,ts DESC,id DESC);
CREATE INDEX idx_mcp_calls_trace ON mcp_calls(trace_id,ts,id);
CREATE TABLE candidate_detections(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,outcome TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX idx_candidate_detections_ts ON candidate_detections(ts DESC,id DESC);
CREATE INDEX idx_candidate_detections_session ON candidate_detections(tenant_id,actor_id,session_id,ts,id);
CREATE INDEX idx_candidate_detections_outcome_ts ON candidate_detections(outcome,ts DESC,id DESC);
CREATE TABLE sessions(tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,session_id TEXT NOT NULL,client TEXT NOT NULL DEFAULT 'unknown',started_at INTEGER NOT NULL,last_activity_at INTEGER NOT NULL,last_event_ts INTEGER,last_event_name TEXT,repository_id TEXT,runtime_version TEXT,hook_schema_version INTEGER,event_count INTEGER NOT NULL DEFAULT 0,call_count INTEGER NOT NULL DEFAULT 0,failed_call_count INTEGER NOT NULL DEFAULT 0,evidence_count INTEGER NOT NULL DEFAULT 0,has_mcp INTEGER NOT NULL DEFAULT 0,has_evidence INTEGER NOT NULL DEFAULT 0,has_reuse INTEGER NOT NULL DEFAULT 0,tools_json TEXT NOT NULL DEFAULT '[]',events_json TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'ACTIVE',PRIMARY KEY(tenant_id,actor_id,session_id));
CREATE INDEX idx_sessions_activity ON sessions(last_activity_at DESC,session_id DESC);
CREATE INDEX idx_sessions_actor_activity ON sessions(tenant_id,actor_id,last_activity_at DESC);
CREATE INDEX idx_sessions_repository_activity ON sessions(repository_id,last_activity_at DESC);
CREATE INDEX idx_sessions_status_activity ON sessions(status,last_activity_at DESC);
` }, { version: 2, name: "workflow-state", sql: `
CREATE TABLE feedback(
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  rating TEXT NOT NULL,
  target_type TEXT NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX idx_feedback_ts ON feedback(ts DESC,id DESC);
CREATE INDEX idx_feedback_rating_ts ON feedback(rating,ts DESC,id DESC);
CREATE TABLE candidate_history(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  repository TEXT,
  record_json TEXT NOT NULL,
  UNIQUE(candidate_id,updated_at,record_json)
);
CREATE INDEX idx_candidate_history_candidate ON candidate_history(candidate_id,updated_at DESC,seq DESC);
CREATE INDEX idx_candidate_history_status ON candidate_history(status,updated_at DESC,seq DESC);
CREATE TABLE knowledge_gap_management_history(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  gap_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(gap_key,updated_at,record_json)
);
CREATE INDEX idx_gap_management_latest ON knowledge_gap_management_history(gap_key,updated_at DESC,seq DESC);
CREATE INDEX idx_gap_management_status ON knowledge_gap_management_history(status,updated_at DESC,seq DESC);
` }] as const;

export class SkillHubDatabase {
  readonly raw: DatabaseSync;
  constructor(readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.raw = new DatabaseSync(filePath);
    try {
      this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      this.migrate();
    } catch (error) {
      try { this.raw.close(); } catch {}
      throw error;
    }
  }
  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)");
    const rows = this.raw.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all() as Array<{version:number|bigint;name:string}>;
    const supported = new Map<number, string>(MIGRATIONS.map((migration) => [migration.version, migration.name]));
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    for (const row of rows) {
      const version = Number(row.version);
      if (version > latestVersion || !supported.has(version)) throw new Error("Database schema version " + version + " is unsupported; latest supported version is " + latestVersion);
      if (supported.get(version) !== row.name) throw new Error("Database schema migration " + version + " metadata mismatch");
    }
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) if (!applied.has(migration.version)) this.transaction(()=>{ this.raw.exec(migration.sql); this.raw.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)").run(migration.version,migration.name,Date.now()); });
  }
  transaction<T>(fn:()=>T):T { this.raw.exec("BEGIN IMMEDIATE"); try { const value=fn(); this.raw.exec("COMMIT"); return value; } catch(error) { try{this.raw.exec("ROLLBACK");}catch{} throw error; } }
  pragmaValue(name:"journal_mode"|"synchronous"|"busy_timeout"|"foreign_keys"):string|number|bigint|undefined { const row=this.raw.prepare(`PRAGMA ${name}`).get() as Record<string,string|number|bigint>|undefined; return row?Object.values(row)[0]:undefined; }
  quickCheck():boolean { const row=this.raw.prepare("PRAGMA quick_check").get() as Record<string,string>|undefined; return Boolean(row&&Object.values(row)[0]==="ok"); }
  writableCheck():boolean { try{this.raw.exec("BEGIN IMMEDIATE");this.raw.exec("ROLLBACK");return true}catch{try{this.raw.exec("ROLLBACK")}catch{}return false} }
  close():void { this.raw.close(); }
}
export function openSkillHubDatabase(filePath:string):SkillHubDatabase { return new SkillHubDatabase(filePath); }
