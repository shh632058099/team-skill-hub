export interface VerificationPolicyStep {
  id: string;
  type: string;
  argv: string[];
  timeoutMs: number;
  evidenceType: string;
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
