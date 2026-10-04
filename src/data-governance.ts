export type DataClassification =
  | "metadata"
  | "engineering-evidence"
  | "knowledge-candidate"
  | "source-code"
  | "customer-data"
  | "sensitive-credential"
  | "personal-data"
  | "aggregate-metrics"
  | "audit";

export interface DataGovernanceRule {
  classification: DataClassification;
  collect: boolean;
  persist: boolean;
  retentionDays: number;
  access: "internal" | "restricted" | "admin";
  audited: boolean;
}

export const DATA_GOVERNANCE_POLICY: Readonly<Record<DataClassification, DataGovernanceRule>> = {
  metadata: { classification: "metadata", collect: true, persist: true, retentionDays: 30, access: "internal", audited: false },
  "engineering-evidence": { classification: "engineering-evidence", collect: true, persist: true, retentionDays: 90, access: "restricted", audited: true },
  "knowledge-candidate": { classification: "knowledge-candidate", collect: true, persist: true, retentionDays: 365, access: "restricted", audited: true },
  "source-code": { classification: "source-code", collect: false, persist: false, retentionDays: 0, access: "restricted", audited: true },
  "customer-data": { classification: "customer-data", collect: false, persist: false, retentionDays: 0, access: "restricted", audited: true },
  "sensitive-credential": { classification: "sensitive-credential", collect: false, persist: false, retentionDays: 0, access: "admin", audited: true },
  "personal-data": { classification: "personal-data", collect: false, persist: false, retentionDays: 0, access: "restricted", audited: true },
  "aggregate-metrics": { classification: "aggregate-metrics", collect: true, persist: true, retentionDays: 365, access: "internal", audited: false },
  audit: { classification: "audit", collect: true, persist: true, retentionDays: 365, access: "admin", audited: true }
};

const OBSERVABILITY_FILE_CLASSIFICATION: Record<string, DataClassification> = {
  "client-events.jsonl": "metadata",
  "mcp-calls.jsonl": "metadata",
  "candidate-detections.jsonl": "engineering-evidence",
  "feedback.jsonl": "audit",
  "knowledge-candidates.jsonl": "knowledge-candidate"
};

export function governanceRuleForObservabilityFile(fileName: string): DataGovernanceRule {
  const classification = OBSERVABILITY_FILE_CLASSIFICATION[fileName] ?? "metadata";
  return DATA_GOVERNANCE_POLICY[classification];
}

export function listDataGovernanceRules(): DataGovernanceRule[] {
  return Object.values(DATA_GOVERNANCE_POLICY).map((rule) => ({ ...rule }));
}
