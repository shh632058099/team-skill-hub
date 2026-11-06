import type { CandidateDetectionRecord } from "../observability.js";
import type { AdmissionResult, AutoCandidatePolicy, EligibilityResult } from "./types.js";

function millis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function uniqueProjectedCreates(rows: CandidateDetectionRecord[]): CandidateDetectionRecord[] {
  const seen = new Set<string>();
  const result: CandidateDetectionRecord[] = [];
  for (const row of [...rows].sort((a, b) => millis(a.ts) - millis(b.ts))) {
    if (row.detector !== "stop-evidence-v3" || row.projectedAction !== "create") continue;
    const key = [row.tenantId, row.actorId, row.sessionId, row.turnId ?? ""].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

export function evaluateShadowAdmission(input: {
  actorId: string;
  tenantId: string;
  sessionId: string;
  turnId?: string;
  repositoryId?: string;
  eligibility: EligibilityResult;
  policy: AutoCandidatePolicy;
  now: string;
  recentDetections: CandidateDetectionRecord[];
}): AdmissionResult {
  if (!input.eligibility.eligibleForCreateProjection) {
    return { allowed: false, reason: "below-create-threshold", projectedAction: "skip" };
  }

  const now = millis(input.now);
  const hourAgo = now - 60 * 60 * 1000;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const rows = uniqueProjectedCreates(input.recentDetections);

  const sameSession = rows.filter(
    (row) => row.actorId === input.actorId && row.tenantId === input.tenantId && row.sessionId === input.sessionId,
  ).length;
  if (sameSession >= input.policy.limits.perSession) {
    return { allowed: false, reason: "session-limit", projectedAction: "skip" };
  }

  if (input.repositoryId) {
    const cooldownMs = input.policy.cooldown.sameRepositoryMinutes * 60 * 1000;
    const cooling = rows.some(
      (row) => row.repositoryId === input.repositoryId && millis(row.ts) <= now && millis(row.ts) >= now - cooldownMs,
    );
    if (cooling) {
      return { allowed: false, reason: "repository-cooldown", projectedAction: "skip" };
    }
  }

  const userRows = rows.filter((row) => row.actorId === input.actorId && row.tenantId === input.tenantId);
  if (userRows.filter((row) => millis(row.ts) >= hourAgo).length >= input.policy.limits.perUserPerHour) {
    return { allowed: false, reason: "user-hour-limit", projectedAction: "skip" };
  }
  if (userRows.filter((row) => millis(row.ts) >= dayAgo).length >= input.policy.limits.perUserPerDay) {
    return { allowed: false, reason: "user-day-limit", projectedAction: "skip" };
  }

  if (input.repositoryId) {
    const repositoryRows = rows.filter((row) => row.repositoryId === input.repositoryId);
    if (repositoryRows.filter((row) => millis(row.ts) >= hourAgo).length >= input.policy.limits.perRepositoryPerHour) {
      return { allowed: false, reason: "repository-hour-limit", projectedAction: "skip" };
    }
    if (repositoryRows.filter((row) => millis(row.ts) >= dayAgo).length >= input.policy.limits.perRepositoryPerDay) {
      return { allowed: false, reason: "repository-day-limit", projectedAction: "skip" };
    }
  }

  if (rows.filter((row) => millis(row.ts) >= hourAgo).length >= input.policy.limits.globalPerHour) {
    return { allowed: false, reason: "global-hour-limit", projectedAction: "skip" };
  }
  if (rows.filter((row) => millis(row.ts) >= dayAgo).length >= input.policy.limits.globalPerDay) {
    return { allowed: false, reason: "global-day-limit", projectedAction: "skip" };
  }

  return { allowed: true, reason: "admitted", projectedAction: "create" };
}
