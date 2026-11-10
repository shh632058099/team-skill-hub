export interface VerificationPolicyStep {
  id: string;
  type: string;
  argv: string[];
  timeoutMs: number;
  evidenceType: string;
}

export interface VerificationRunResult {
  stepId: string;
  type: string;
  evidenceType: string;
  status: "passed" | "failed";
  exitCode: number | null;
  durationMs: number;
  errorCode: string | null;
}

export interface VerificationEvidenceResult extends VerificationRunResult {
  subjectRevision: string;
  environmentIdentity: string;
  verifierIdentity: string;
}

export function normalizeVerificationEvidenceResults(value: unknown): VerificationEvidenceResult[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("INVALID_VERIFICATION_RESULTS");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_VERIFICATION_RESULTS");
    const record = raw as Record<string, unknown>;
    const stepId = typeof record.stepId === "string" ? record.stepId.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    const evidenceType = typeof record.evidenceType === "string" ? record.evidenceType.trim() : "";
    const status = record.status;
    const exitCode = record.exitCode == null ? null : Number(record.exitCode);
    const durationMs = Number(record.durationMs);
    const errorCode = record.errorCode == null ? null : String(record.errorCode).trim();
    const subjectRevision = typeof record.subjectRevision === "string" ? record.subjectRevision.trim() : "";
    const environmentIdentity = typeof record.environmentIdentity === "string" ? record.environmentIdentity.trim() : "";
    const verifierIdentity = typeof record.verifierIdentity === "string" ? record.verifierIdentity.trim() : "";
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(stepId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(type) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(evidenceType) ||
      (status !== "passed" && status !== "failed") ||
      (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < -1 || exitCode > 255)) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      durationMs > 86_400_000 ||
      (errorCode !== null && !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode)) ||
      !/^[a-f0-9]{40,64}$/i.test(subjectRevision) ||
      !environmentIdentity ||
      environmentIdentity.length > 500 ||
      !verifierIdentity ||
      verifierIdentity.length > 500 ||
      seen.has(stepId)
    ) {
      throw new Error("INVALID_VERIFICATION_RESULTS");
    }
    seen.add(stepId);
    return {
      stepId,
      type,
      evidenceType,
      status,
      exitCode,
      durationMs,
      errorCode,
      subjectRevision,
      environmentIdentity,
      verifierIdentity,
    };
  });
}

export function normalizeVerificationPolicy(value: unknown): VerificationPolicyStep[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("INVALID_VERIFICATION_POLICY");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_VERIFICATION_POLICY");
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    const evidenceType = typeof record.evidenceType === "string" ? record.evidenceType.trim() : "";
    const timeoutMs = Number(record.timeoutMs);
    const argv = record.argv;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(type) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(evidenceType) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 3_600_000 ||
      !Array.isArray(argv) ||
      argv.length < 1 ||
      argv.length > 64 ||
      argv.some((part) => typeof part !== "string" || !part.trim() || part.length > 2_000) ||
      seen.has(id)
    ) {
      throw new Error("INVALID_VERIFICATION_POLICY");
    }
    seen.add(id);
    return {
      id,
      type,
      evidenceType,
      timeoutMs,
      argv: argv.map((part) => String(part)),
    };
  });
}
