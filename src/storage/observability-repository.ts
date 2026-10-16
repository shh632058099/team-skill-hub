import type { CandidateDetectionRecord, ClientEventRecord, McpCallRecord } from "../observability.js";
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface ListQuery {
  limit?: number;
  cursor?: string;
}
export interface SessionIdentity {
  tenantId: string;
  actorId: string;
  sessionId: string;
}
export interface SessionSummary extends SessionIdentity {
  client: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  callCount: number;
  failedCallCount: number;
  evidenceCount: number;
  tools: string[];
  events: string[];
  repositoryId?: string;
  runtimeVersion?: string;
  hookSchemaVersion?: number;
  hasMcp: boolean;
  hasEvidence: boolean;
  hasReuse: boolean;
  ended: boolean;
  status: "ACTIVE" | "ENDED" | "FAILED";
}
export interface ObservabilityRepository {
  recordClientEvent(record: ClientEventRecord): Promise<void>;
  recordMcpCall(record: McpCallRecord): Promise<void>;
  recordCandidateDetection(record: CandidateDetectionRecord): Promise<void>;
  getClientEvent(id: string): Promise<ClientEventRecord | undefined>;
  getMcpCall(id: string): Promise<McpCallRecord | undefined>;
  listClientEvents(query?: ListQuery): Promise<Page<ClientEventRecord>>;
  listMcpCalls(query?: ListQuery): Promise<Page<McpCallRecord>>;
  getSession(identity: SessionIdentity): Promise<SessionSummary | undefined>;
  listSessions(query?: ListQuery): Promise<Page<SessionSummary>>;
  rebuildSessions(identities?: SessionIdentity[]): Promise<void>;
}
