import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  CandidateDetectionRecord,
  ClientEventRecord,
  FeedbackRecord,
  KnowledgeCandidate,
  KnowledgeGapManagement,
  McpCallRecord,
} from "../observability.js";
import type { SqliteObservabilityRepository } from "./sqlite-observability-repository.js";

type Counts = { valid: number; invalid: number };
export interface JsonlImportResult {
  clientEvents: Counts;
  mcpCalls: Counts;
  candidateDetections: Counts;
  feedback: Counts;
  knowledgeCandidates: Counts;
  knowledgeGapManagement: Counts;
}
async function filesFor(dir: string, base: string) {
  try {
    return (await readdir(dir))
      .filter((n) => n === base || n.startsWith(base + ".archive."))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
async function importKind<T>(files: string[], write: (row: T) => Promise<void>): Promise<Counts> {
  let valid = 0,
    invalid = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let row: T;
      try {
        row = JSON.parse(raw) as T;
      } catch {
        invalid++;
        continue;
      }
      await write(row);
      valid++;
    }
  }
  return { valid, invalid };
}
export async function importObservabilityJsonl(
  dir: string,
  repo: SqliteObservabilityRepository,
): Promise<JsonlImportResult> {
  const clientEvents = await importKind<ClientEventRecord>(await filesFor(dir, "client-events.jsonl"), (r) =>
    repo.recordClientEvent(r),
  );
  const mcpCalls = await importKind<McpCallRecord>(await filesFor(dir, "mcp-calls.jsonl"), (r) =>
    repo.recordMcpCall(r),
  );
  const candidateDetections = await importKind<CandidateDetectionRecord>(
    await filesFor(dir, "candidate-detections.jsonl"),
    (r) => repo.recordCandidateDetection(r),
  );
  const feedback = await importKind<FeedbackRecord>(await filesFor(dir, "feedback.jsonl"), (r) =>
    repo.recordFeedback(r),
  );
  const knowledgeCandidates = await importKind<KnowledgeCandidate>(
    await filesFor(dir, "knowledge-candidates.jsonl"),
    (r) => repo.recordKnowledgeCandidate(r),
  );
  const knowledgeGapManagement = await importKind<KnowledgeGapManagement>(
    await filesFor(dir, "knowledge-gap-management.jsonl"),
    (r) => repo.recordKnowledgeGapManagement(r),
  );
  await repo.rebuildSessions();
  return { clientEvents, mcpCalls, candidateDetections, feedback, knowledgeCandidates, knowledgeGapManagement };
}
