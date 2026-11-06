export type AutoCandidateMode = "shadow" | "active";
export type EvidenceCategory =
  "test" | "build" | "package" | "lint" | "static-analysis" | "device-test" | "git-change" | "other";

export interface AutoCandidatePolicy {
  schemaVersion: 1;
  policyVersion: number;
  enabled: boolean;
  mode: AutoCandidateMode;
  thresholds: {
    shadowScore: number;
    createScore: number;
    duplicateSimilarity: number;
  };
  requirements: {
    requireVerification: boolean;
  };
  limits: {
    perSession: number;
    perUserPerHour: number;
    perUserPerDay: number;
    perRepositoryPerHour: number;
    perRepositoryPerDay: number;
    globalPerHour: number;
    globalPerDay: number;
  };
  cooldown: {
    sameRepositoryMinutes: number;
  };
}

export interface CandidateEvidenceItem {
  category: EvidenceCategory;
  sourceTool: string;
  success?: boolean;
  exitCode?: number;
  counts?: { run?: number; passed?: number; failed?: number };
  status?: string;
}

export interface CandidateEvidence {
  sessionId: string;
  actorId: string;
  tenantId: string;
  repositoryId?: string;
  assistantResult: string;
  engineeringActions: {
    editCount: number;
    writeCount: number;
    patchCount: number;
    meaningfulBashCount: number;
  };
  verification: {
    strongTest: boolean;
    deviceTest: boolean;
    buildOrPackage: boolean;
    any: boolean;
  };
  resultSignals: {
    rootCause: boolean;
    verifiedFix: boolean;
    workaround: boolean;
    reusableConstraint: boolean;
    lowValueOnly: boolean;
    analysisOnly: boolean;
  };
  evidence: CandidateEvidenceItem[];
}

export interface ScoreSignal {
  id: string;
  delta: number;
  reason: string;
}

export interface EligibilityResult {
  score: number;
  hardGates: Record<string, boolean>;
  scoreSignals: ScoreSignal[];
  eligibleForShadow: boolean;
  eligibleForCreateProjection: boolean;
  reason: string;
}

export interface AdmissionResult {
  allowed: boolean;
  reason: string;
  projectedAction: "skip" | "create" | "aggregate";
}
