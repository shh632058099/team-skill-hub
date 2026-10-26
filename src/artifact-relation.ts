import path from "node:path";
import type { KnowledgeDocument, Skill } from "./types.js";

export type ArtifactKind = "knowledge" | "skill";
export interface ArtifactIdentity {
  kind: ArtifactKind;
  repositoryId: string;
  key: string;
  path: string;
  title: string;
}
export type ArtifactRelation =
  { type: "new" } | { type: "updates"; target: ArtifactIdentity; source: "auto" | "manual" };
export type ArtifactMatch = {
  relation?: ArtifactRelation;
  hint?: { target: ArtifactIdentity; confidence: "medium"; reason: string };
  score: number;
};

export const HIGH_CONFIDENCE = 0.92;
export const DUPLICATE_THRESHOLD = 0.78;

export function artifactIdentity(document: KnowledgeDocument | Skill, kind: ArtifactKind): ArtifactIdentity {
  return {
    kind,
    repositoryId: document.repositoryId,
    key: document.key,
    path: document.relativePath,
    title: "title" in document ? document.title : document.name,
  };
}

export function resolveArtifactTarget(
  explicitPath: string | undefined,
  relation: ArtifactRelation | undefined,
  fallback: string,
): string {
  return explicitPath || (relation?.type === "updates" ? relation.target.path : fallback);
}

function slug(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

function tokens(title: string, content: string): Set<string> {
  const normalized = (title + " " + content)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[0-9a-f]{8,}\b/g, " ")
    .replace(/\d+/g, " ");
  const result = new Set<string>();
  for (const token of normalized.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) result.add(token);
  for (const chunk of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let i = 0; i < chunk.length - 1; i++) result.add(chunk.slice(i, i + 2));
  }
  return result;
}

export function artifactSimilarity(aTitle: string, aContent: string, bTitle: string, bContent: string): number {
  const a = tokens(aTitle, aContent);
  const b = tokens(bTitle, bContent);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

export function matchArtifact(
  candidate: { kind: ArtifactKind; repositoryId: string; title: string; content: string },
  published: Array<{ identity: ArtifactIdentity; content: string }>,
): ArtifactMatch {
  const ranked = published
    .filter((p) => p.identity.kind === candidate.kind && p.identity.repositoryId === candidate.repositoryId)
    .map((p) => {
      const score = artifactSimilarity(candidate.title, candidate.content, p.identity.title, p.content);
      const basename = path.posix.basename(p.identity.path, path.posix.extname(p.identity.path));
      const sameTitle = slug(candidate.title) !== "" && slug(candidate.title) === slug(p.identity.title);
      const pathIdentity = slug(candidate.title) !== "" && slug(candidate.title) === slug(basename);
      return { identity: p.identity, score, sameTitle: sameTitle || pathIdentity };
    })
    .sort((a, b) => Number(b.sameTitle) - Number(a.sameTitle) || b.score - a.score);
  const winner = ranked[0];
  if (!winner) return { score: 0 };
  const high = winner.sameTitle || winner.score >= HIGH_CONFIDENCE;
  const conflicting = ranked
    .slice(1)
    .some(
      (p) => (p.sameTitle && winner.sameTitle) || (p.score >= DUPLICATE_THRESHOLD && p.score >= winner.score - 0.05),
    );
  if (high && !conflicting) {
    return { relation: { type: "updates", target: winner.identity, source: "auto" }, score: winner.score };
  }
  if (winner.score >= DUPLICATE_THRESHOLD || winner.sameTitle) {
    return {
      hint: {
        target: winner.identity,
        confidence: "medium",
        reason: conflicting ? "ambiguous published matches" : "similar published content",
      },
      score: winner.score,
    };
  }
  return { score: winner.score };
}
