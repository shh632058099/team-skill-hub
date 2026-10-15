import type { KnowledgeCandidate } from "./observability.js";
import type { SkillBundleImport } from "./skill-bundles.js";

export type ReviewItemKind = "candidate" | "skill-bundle";
export type ReviewContentType = "knowledge" | "legacy-skill" | "skill-bundle-skill" | "skill-bundle-collection";
export type ReviewStatusGroup =
  | "pending"
  | "approved"
  | "publishing"
  | "rejected"
  | "publish_failed"
  | "published"
  | "deleting"
  | "delete_failed"
  | "deleted"
  | "review_stale"
  | "published_drifted";

export interface ReviewPublicationSummary {
  provider?: string;
  mergeRequestIid?: number;
  mergeRequestUrl?: string;
  mergeRequestState?: string;
}

export interface ReviewItem {
  kind: ReviewItemKind;
  id: string;
  title: string;
  contentType: ReviewContentType;
  status: string;
  statusGroup: ReviewStatusGroup;
  sourceType?: string;
  repository?: string;
  namespace?: string;
  skillCollection?: string;
  importType?: "skill" | "collection";
  submitter?: string;
  reviewer?: string;
  updatedAt: string;
  skillCount?: number;
  fileCount?: number;
  totalBytes?: number;
  publication?: ReviewPublicationSummary;
}

export interface ReviewItemsQuery {
  q?: string;
  status?: string;
  kind?: string;
  type?: string;
  repository?: string;
  sourceType?: string;
  reviewer?: string;
  submitter?: string;
  namespace?: string;
  skillCollection?: string;
  importType?: string;
  limit?: string | number;
  cursor?: string | number;
}

export interface ReviewPage {
  total: number;
  limit: number;
  cursor: string;
  nextCursor?: string;
  previousCursor?: string;
}

export interface SkillBundleSnapshotSummary {
  skillCount?: number;
  fileCount?: number;
  totalBytes?: number;
}

export const REVIEW_STATUS_GROUPS: ReviewStatusGroup[] = [
  "pending",
  "approved",
  "publishing",
  "rejected",
  "publish_failed",
  "published",
  "deleting",
  "delete_failed",
  "deleted",
  "review_stale",
  "published_drifted",
];

const REVIEW_KINDS = new Set<ReviewItemKind>(["candidate", "skill-bundle"]);
const REVIEW_CONTENT_TYPES = new Set<ReviewContentType>(["knowledge", "legacy-skill", "skill-bundle-skill", "skill-bundle-collection"]);
const REVIEW_STATUS_SET = new Set<string>(REVIEW_STATUS_GROUPS);

function statusGroup(status: string): ReviewStatusGroup {
  if (!REVIEW_STATUS_SET.has(status)) throw new Error(`Unsupported review status: ${status}`);
  return status as ReviewStatusGroup;
}

export function projectCandidateReviewItem(candidate: KnowledgeCandidate): ReviewItem {
  return {
    kind: "candidate",
    id: candidate.id,
    title: candidate.title,
    contentType: candidate.suggestedType === "skill" ? "legacy-skill" : "knowledge",
    status: candidate.status,
    statusGroup: statusGroup(candidate.status),
    sourceType: candidate.sourceType,
    repository: candidate.repository,
    skillCollection: candidate.skillCollection,
    submitter: candidate.actorId,
    reviewer: candidate.reviewer,
    updatedAt: candidate.updatedAt,
    publication: candidate.publication ? {
      provider: candidate.publication.provider,
      mergeRequestIid: candidate.publication.mergeRequestIid,
      mergeRequestUrl: candidate.publication.mergeRequestUrl,
      mergeRequestState: candidate.publication.mergeRequestState,
    } : undefined,
  };
}

export function projectSkillBundleReviewItem(record: SkillBundleImport, snapshotSummary: SkillBundleSnapshotSummary = {}): ReviewItem {
  const publication = record.publication?.kind === "pull-request" ? record.publication : undefined;
  return {
    kind: "skill-bundle",
    id: record.id,
    title: record.namespace,
    contentType: record.importType === "collection" ? "skill-bundle-collection" : "skill-bundle-skill",
    status: record.status,
    statusGroup: statusGroup(record.status),
    sourceType: record.sourceType,
    repository: record.repository,
    namespace: record.namespace,
    skillCollection: record.collection,
    importType: record.importType,
    submitter: record.submitter,
    reviewer: record.review?.reviewer,
    updatedAt: record.updatedAt,
    skillCount: snapshotSummary.skillCount,
    fileCount: snapshotSummary.fileCount,
    totalBytes: snapshotSummary.totalBytes,
    publication: publication ? {
      provider: publication.provider,
      mergeRequestIid: publication.mergeRequestIid,
      mergeRequestUrl: publication.mergeRequestUrl,
      mergeRequestState: publication.mergeRequestState,
    } : undefined,
  };
}

export function filterReviewItems(items: ReviewItem[], query: ReviewItemsQuery): ReviewItem[] {
  if (query.kind && !REVIEW_KINDS.has(query.kind as ReviewItemKind)) return [];
  if (query.type && !REVIEW_CONTENT_TYPES.has(query.type as ReviewContentType)) return [];
  if (query.status && !REVIEW_STATUS_SET.has(query.status)) return [];
  if (query.importType && query.importType !== "skill" && query.importType !== "collection") return [];
  const needle = query.q?.trim().toLowerCase();
  return items.filter((item) => {
    if (query.kind && item.kind !== query.kind) return false;
    if (query.type && item.contentType !== query.type) return false;
    if (query.status && item.statusGroup !== query.status) return false;
    if (query.repository && item.repository !== query.repository) return false;
    if (query.sourceType && item.sourceType !== query.sourceType) return false;
    if (query.reviewer && item.reviewer !== query.reviewer) return false;
    if (query.submitter && item.submitter !== query.submitter) return false;
    if (query.namespace && item.namespace !== query.namespace) return false;
    if (query.skillCollection && item.skillCollection !== query.skillCollection) return false;
    if (query.importType && item.importType !== query.importType) return false;
    if (needle) {
      const searchable = [item.id, item.title, item.status, item.sourceType, item.repository, item.namespace, item.skillCollection, item.submitter, item.reviewer, item.importType]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(needle)) return false;
    }
    return true;
  });
}

export function sortReviewItems(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
  );
}

export function normalizeReviewLimit(value: ReviewItemsQuery["limit"]): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 20);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? Math.floor(parsed) : 20, 100));
}

export function normalizeReviewOffset(value: ReviewItemsQuery["cursor"]): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function paginateReviewItems(items: ReviewItem[], query: ReviewItemsQuery): { items: ReviewItem[]; page: ReviewPage } {
  const limit = normalizeReviewLimit(query.limit);
  const offset = normalizeReviewOffset(query.cursor);
  const pageItems = items.slice(offset, offset + limit);
  return {
    items: pageItems,
    page: {
      total: items.length,
      limit,
      cursor: String(offset),
      nextCursor: offset + limit < items.length ? String(offset + limit) : undefined,
      previousCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
    },
  };
}

export function summarizeReviewItems(items: ReviewItem[]): { counts: Record<ReviewStatusGroup, number>; total: number } {
  const counts = Object.fromEntries(REVIEW_STATUS_GROUPS.map((status) => [status, 0])) as Record<ReviewStatusGroup, number>;
  for (const item of items) counts[item.statusGroup] += 1;
  return { counts, total: items.length };
}
