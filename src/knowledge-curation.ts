import type { KnowledgeCandidate } from "./observability.js";

export interface CandidateCurationProposal {
  title: string;
  summary: string;
  category?: string;
  suggestedPath?: string;
  suggestedType: "knowledge" | "skill";
  conflictHint?: {
    targetKey?: string;
    reason: string;
  };
}

export interface GapCurationInput {
  key: string;
  query: string;
  occurrences: number;
  source: string;
  members?: string[];
}

export interface GapClusterProposal {
  label: string;
  memberKeys: string[];
  suggestedTitle?: string;
  suggestedPath?: string;
  category?: string;
}

export interface KnowledgeCuratorStatus {
  configured: boolean;
  provider: "http-json";
  urlConfigured: boolean;
  tokenEnv: string;
  tokenConfigured: boolean;
  humanReviewRequired: true;
  directKnowledgeWrite: false;
}

function cleanText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error("Curator proposal missing " + field);
    return undefined;
  }
  if (typeof value !== "string") throw new Error("Curator proposal " + field + " must be a string");
  const cleaned = value.trim();
  if (!cleaned && required) throw new Error("Curator proposal missing " + field);
  if (cleaned.length > max) throw new Error("Curator proposal " + field + " exceeds " + max + " characters");
  return cleaned || undefined;
}

function safeSuggestedPath(value: unknown): string | undefined {
  const path = cleanText(value, "suggestedPath", 240);
  if (!path) return undefined;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("../") || normalized === ".." || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Curator proposal suggestedPath is unsafe");
  }
  if (!/\.(md|txt)$/i.test(normalized)) throw new Error("Curator proposal suggestedPath must end in .md or .txt");
  return normalized;
}

export function validateCandidateCurationProposal(raw: unknown): CandidateCurationProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Curator proposal must be an object");
  const value = raw as Record<string, unknown>;
  const suggestedType = value.suggestedType;
  if (suggestedType !== "knowledge" && suggestedType !== "skill") {
    throw new Error("Curator proposal suggestedType must be knowledge or skill");
  }
  let conflictHint: CandidateCurationProposal["conflictHint"];
  if (value.conflictHint !== undefined && value.conflictHint !== null) {
    if (typeof value.conflictHint !== "object" || Array.isArray(value.conflictHint)) {
      throw new Error("Curator proposal conflictHint must be an object");
    }
    const hint = value.conflictHint as Record<string, unknown>;
    conflictHint = {
      reason: cleanText(hint.reason, "conflictHint.reason", 500, true)!,
      ...(cleanText(hint.targetKey, "conflictHint.targetKey", 240) ? {
        targetKey: cleanText(hint.targetKey, "conflictHint.targetKey", 240)
      } : {})
    };
  }
  return {
    title: cleanText(value.title, "title", 160, true)!,
    summary: cleanText(value.summary, "summary", 4000, true)!,
    ...(cleanText(value.category, "category", 80) ? { category: cleanText(value.category, "category", 80) } : {}),
    ...(safeSuggestedPath(value.suggestedPath) ? { suggestedPath: safeSuggestedPath(value.suggestedPath) } : {}),
    suggestedType,
    ...(conflictHint ? { conflictHint } : {})
  };
}

export function validateGapClusters(raw: unknown, gaps: GapCurationInput[]): GapClusterProposal[] {
  if (!Array.isArray(raw)) throw new Error("Curator gap clusters must be an array");
  const known = new Set(gaps.map((item) => item.key));
  const used = new Set<string>();
  return raw.slice(0, 50).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Curator gap cluster " + index + " must be an object");
    const value = item as Record<string, unknown>;
    if (!Array.isArray(value.memberKeys)) throw new Error("Curator gap cluster memberKeys must be an array");
    const memberKeys = [...new Set(value.memberKeys.filter((key): key is string => typeof key === "string"))];
    if (memberKeys.length < 2) throw new Error("Curator gap cluster must contain at least two members");
    for (const key of memberKeys) {
      if (!known.has(key)) throw new Error("Curator gap cluster references unknown gap " + key);
      if (used.has(key)) throw new Error("Curator gap cluster reuses gap " + key);
      used.add(key);
    }
    return {
      label: cleanText(value.label, "cluster.label", 120, true)!,
      memberKeys,
      ...(cleanText(value.suggestedTitle, "cluster.suggestedTitle", 160) ? { suggestedTitle: cleanText(value.suggestedTitle, "cluster.suggestedTitle", 160) } : {}),
      ...(safeSuggestedPath(value.suggestedPath) ? { suggestedPath: safeSuggestedPath(value.suggestedPath) } : {}),
      ...(cleanText(value.category, "cluster.category", 80) ? { category: cleanText(value.category, "cluster.category", 80) } : {})
    };
  });
}

export class HttpKnowledgeCurator {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  status(): KnowledgeCuratorStatus {
    const url = process.env.KNOWLEDGE_CURATOR_URL?.trim();
    const tokenEnv = process.env.KNOWLEDGE_CURATOR_TOKEN_ENV?.trim() || "KNOWLEDGE_CURATOR_TOKEN";
    return {
      configured: Boolean(url),
      provider: "http-json",
      urlConfigured: Boolean(url),
      tokenEnv,
      tokenConfigured: Boolean(process.env[tokenEnv]),
      humanReviewRequired: true,
      directKnowledgeWrite: false
    };
  }

  private async request(action: "curate_candidate" | "cluster_gaps", input: unknown): Promise<unknown> {
    const url = process.env.KNOWLEDGE_CURATOR_URL?.trim();
    if (!url) throw new Error("Knowledge curator is not configured");
    const tokenEnv = process.env.KNOWLEDGE_CURATOR_TOKEN_ENV?.trim() || "KNOWLEDGE_CURATOR_TOKEN";
    const token = process.env[tokenEnv];
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {})
      },
      body: JSON.stringify({
        schema_version: 1,
        action,
        input,
        constraints: {
          human_review_required: true,
          direct_knowledge_write: false,
          deterministic_guard_required: true
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error("Knowledge curator request failed (" + response.status + "): " + detail.slice(0, 500));
    }
    const body = await response.json() as { schema_version?: number; proposal?: unknown; clusters?: unknown };
    if (body.schema_version !== 1) throw new Error("Knowledge curator response schema_version must be 1");
    return action === "curate_candidate" ? body.proposal : body.clusters;
  }

  async curateCandidate(candidate: KnowledgeCandidate): Promise<CandidateCurationProposal> {
    if (candidate.status !== "pending") throw new Error("Only pending Candidates can receive curator proposals");
    const raw = await this.request("curate_candidate", {
      id: candidate.id,
      title: candidate.title,
      content: candidate.content.slice(0, 12000),
      repository: candidate.repository,
      suggestedPath: candidate.suggestedPath,
      suggestedType: candidate.suggestedType,
      automation: candidate.automation ? {
        classification: candidate.automation.classification,
        reasons: candidate.automation.reasons,
        evidenceCount: candidate.automation.evidenceCount
      } : undefined
    });
    return validateCandidateCurationProposal(raw);
  }

  async clusterGaps(gaps: GapCurationInput[]): Promise<GapClusterProposal[]> {
    const raw = await this.request("cluster_gaps", gaps.slice(0, 200).map((item) => ({
      key: item.key,
      query: item.query.slice(0, 500),
      occurrences: item.occurrences,
      source: item.source,
      members: item.members?.slice(0, 20)
    })));
    return validateGapClusters(raw, gaps);
  }
}
