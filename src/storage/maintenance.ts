import { stat } from "node:fs/promises";
import { governanceRuleForObservabilityFile } from "../data-governance.js";
import type { SkillHubDatabase } from "./database.js";
import type { SqliteObservabilityRepository } from "./sqlite-observability-repository.js";

type RetentionOptions = { retentionDays?: number; batchSize?: number; now?: number };
type SessionIdentity = { tenantId: string; actorId: string; sessionId: string };

export async function cleanupObservabilityRetention(
  database: SkillHubDatabase,
  repo: SqliteObservabilityRepository,
  options: RetentionOptions = {},
) {
  const now = options.now ?? Date.now();
  const batch = Math.max(1, options.batchSize ?? 5000);
  const days = (file: string) =>
    Math.max(1, options.retentionDays ?? governanceRuleForObservabilityFile(file).retentionDays);
  const cutoff = (file: string) => now - days(file) * 86400000;
  const result = database.transaction(() => {
    const remove = (table: string, column: string, before: number) => {
      let total = 0;
      for (;;) {
        const r = database.raw
          .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`)
          .run(before, batch);
        const n = Number(r.changes);
        total += n;
        if (n < batch) break;
      }
      return total;
    };
    const affected = new Map<string, SessionIdentity>();
    const collect = (table: string, before: number) => {
      for (const row of database.raw
        .prepare(`SELECT DISTINCT tenant_id,actor_id,session_id FROM ${table} WHERE ts < ? AND session_id IS NOT NULL`)
        .all(before) as Array<{ tenant_id: string; actor_id: string; session_id: string }>) {
        const item = { tenantId: row.tenant_id, actorId: row.actor_id, sessionId: row.session_id };
        affected.set(item.tenantId + "\0" + item.actorId + "\0" + item.sessionId, item);
      }
    };
    const eventCutoff = cutoff("client-events.jsonl"),
      callCutoff = cutoff("mcp-calls.jsonl");
    collect("client_events", eventCutoff);
    collect("mcp_calls", callCutoff);
    const clientEventsDeleted = remove("client_events", "ts", eventCutoff),
      mcpCallsDeleted = remove("mcp_calls", "ts", callCutoff);
    const candidateDetectionsDeleted = remove("candidate_detections", "ts", cutoff("candidate-detections.jsonl"));
    const feedbackDeleted = remove("feedback", "ts", cutoff("feedback.jsonl"));
    const candidateHistoryDeleted = remove("candidate_history", "updated_at", cutoff("knowledge-candidates.jsonl"));
    const knowledgeGapManagementHistoryDeleted = remove(
      "knowledge_gap_management_history",
      "updated_at",
      cutoff("knowledge-gap-management.jsonl"),
    );
    if ((clientEventsDeleted || mcpCallsDeleted) && affected.size) repo.rebuildSessionsSync([...affected.values()]);
    return {
      clientEventsDeleted,
      mcpCallsDeleted,
      candidateDetectionsDeleted,
      feedbackDeleted,
      candidateHistoryDeleted,
      knowledgeGapManagementHistoryDeleted,
    };
  });
  database.raw.exec("PRAGMA wal_checkpoint(PASSIVE)");
  return result;
}

async function fileSize(file: string) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}
export async function observabilityStorageMetrics(database: SkillHubDatabase) {
  const count = (t: string) => Number((database.raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as any).n);
  const mainDatabaseBytes = await fileSize(database.filePath),
    walBytes = await fileSize(database.filePath + "-wal"),
    shmBytes = await fileSize(database.filePath + "-shm");
  return {
    databaseBytes: mainDatabaseBytes + walBytes + shmBytes,
    mainDatabaseBytes,
    walBytes,
    shmBytes,
    clientEvents: count("client_events"),
    mcpCalls: count("mcp_calls"),
    candidateDetections: count("candidate_detections"),
    sessions: count("sessions"),
    feedback: count("feedback"),
    candidateHistory: count("candidate_history"),
    knowledgeCandidates: Number(
      (database.raw.prepare("SELECT count(DISTINCT candidate_id) n FROM candidate_history").get() as any).n,
    ),
    knowledgeGapManagementHistory: count("knowledge_gap_management_history"),
    knowledgeGapsManaged: Number(
      (database.raw.prepare("SELECT count(DISTINCT gap_key) n FROM knowledge_gap_management_history").get() as any).n,
    ),
    quickCheck: database.quickCheck(),
    journalMode: String(database.pragmaValue("journal_mode")),
  };
}
