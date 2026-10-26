import assert from "node:assert/strict";
import test from "node:test";

import type { KnowledgeCandidate } from "../src/observability.js";
import type { SkillBundleImport } from "../src/skill-bundles.js";
import {
  collectReviewItemsBounded,
  filterReviewItems,
  paginateReviewItems,
  projectCandidateReviewItem,
  projectSkillBundleReviewItem,
  sortReviewItems,
  summarizeReviewItems,
  type ReviewItem,
} from "../src/review-center.js";

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    id: "kc_one",
    ts: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    actorId: "alice",
    tenantId: "rd",
    title: "Candidate title",
    content: "body",
    sourceType: "manual",
    suggestedType: "knowledge",
    repository: "rd-knowledges",
    status: "pending",
    ...overrides,
  };
}

function bundle(overrides: Partial<SkillBundleImport> = {}): SkillBundleImport {
  return {
    id: "sbi_one",
    revision: 1,
    namespace: "superpowers",
    importType: "collection",
    replacementRoot: "skills/superpowers",
    collection: "rd-skills",
    repository: "rd-skills",
    sourceType: "mcp",
    snapshotId: "sbs_one",
    snapshotSha256: "sha",
    status: "pending",
    submitter: "bob",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

test("candidate projection distinguishes knowledge and legacy skill", () => {
  const knowledge = projectCandidateReviewItem(
    candidate({
      publication: {
        provider: "github",
        projectPath: "rd/k",
        branch: "b",
        targetBranch: "main",
        filePath: "docs/k.md",
        action: "create",
        mergeRequestIid: 1,
        mergeRequestUrl: "https://example.com/pr/1",
        publishedAt: "2026-10-15T00:00:00.000Z",
      },
    }),
  );
  assert.equal(knowledge.kind, "candidate");
  assert.equal(knowledge.contentType, "knowledge");
  assert.equal(knowledge.title, "Candidate title");
  assert.equal(knowledge.repository, "rd-knowledges");
  assert.equal(knowledge.operationHint, "preview");
  const linked = projectCandidateReviewItem(
    candidate({
      knowledgeRelation: {
        type: "updates",
        target: {
          repositoryId: "rd-knowledges",
          key: "rd-knowledges:knowledge/existing.md",
          path: "knowledge/existing.md",
          title: "Existing",
        },
      },
    }),
  );
  assert.equal(linked.operationHint, "update");
  const suggested = projectCandidateReviewItem(
    candidate({
      relationHint: {
        type: "updates",
        target: {
          repositoryId: "rd-knowledges",
          key: "rd-knowledges:knowledge/existing.md",
          path: "knowledge/existing.md",
          title: "Existing",
        },
        reason: "similar content",
        confidence: "medium",
      },
    }),
  );
  assert.equal(suggested.operationHint, "suggested");
  assert.equal(knowledge.submitter, "alice");
  assert.equal(knowledge.publication?.mergeRequestUrl, "https://example.com/pr/1");

  const skill = projectCandidateReviewItem(
    candidate({ id: "kc_skill", suggestedType: "skill", skillCollection: "rd-skills", repository: "rd-skills" }),
  );
  assert.equal(skill.contentType, "legacy-skill");
  assert.equal(skill.skillCollection, "rd-skills");
});

test("skill bundle projection distinguishes skill and collection", () => {
  const collection = projectSkillBundleReviewItem(bundle(), { skillCount: 14, fileCount: 65, totalBytes: 376682 });
  assert.equal(collection.kind, "skill-bundle");
  assert.equal(collection.contentType, "skill-bundle-collection");
  assert.equal(collection.title, "superpowers");
  assert.equal(collection.repository, "rd-skills");
  assert.equal(collection.submitter, "bob");
  assert.equal(collection.namespace, "superpowers");
  assert.equal(collection.importType, "collection");
  assert.equal(collection.operationHint, "preview");
  assert.equal(collection.skillCount, 14);
  assert.equal(collection.fileCount, 65);

  const skill = projectSkillBundleReviewItem(
    bundle({ id: "sbi_skill", importType: "skill", skillPath: "tdd", replacementRoot: "skills/superpowers/tdd" }),
  );
  assert.equal(skill.contentType, "skill-bundle-skill");
  assert.equal(skill.importType, "skill");
});

test("review projection preserves original status and normalized status group", () => {
  const candidateItem = projectCandidateReviewItem(candidate({ status: "deleting" }));
  assert.equal(candidateItem.status, "deleting");
  assert.equal(candidateItem.statusGroup, "deleting");

  const bundleItem = projectSkillBundleReviewItem(bundle({ status: "review_stale" }));
  assert.equal(bundleItem.status, "review_stale");
  assert.equal(bundleItem.statusGroup, "review_stale");
});

test("mixed review items filter by kind content type status repository and namespace", () => {
  const items: ReviewItem[] = [
    projectCandidateReviewItem(candidate({ id: "kc_k", title: "Knowledge A" })),
    projectCandidateReviewItem(
      candidate({
        id: "kc_s",
        title: "Skill A",
        suggestedType: "skill",
        skillCollection: "rd-skills",
        repository: "rd-skills",
      }),
    ),
    projectSkillBundleReviewItem(bundle({ id: "sbi_c", namespace: "superpowers", status: "pending" })),
    projectSkillBundleReviewItem(
      bundle({
        id: "sbi_s",
        namespace: "ota",
        importType: "skill",
        skillPath: "design",
        replacementRoot: "skills/ota/design",
        status: "approved",
      }),
    ),
  ];
  assert.deepEqual(
    filterReviewItems(items, { kind: "candidate" }).map((x) => x.id),
    ["kc_k", "kc_s"],
  );
  assert.deepEqual(
    filterReviewItems(items, { type: "legacy-skill" }).map((x) => x.id),
    ["kc_s"],
  );
  assert.deepEqual(
    filterReviewItems(items, { status: "approved" }).map((x) => x.id),
    ["sbi_s"],
  );
  assert.deepEqual(
    filterReviewItems(items, { repository: "rd-skills" }).map((x) => x.id),
    ["kc_s", "sbi_c", "sbi_s"],
  );
  assert.deepEqual(
    filterReviewItems(items, { namespace: "superpowers" }).map((x) => x.id),
    ["sbi_c"],
  );
});

test("review items sort by updatedAt desc then kind then id", () => {
  const rows: ReviewItem[] = [
    projectSkillBundleReviewItem(bundle({ id: "sbi_b", updatedAt: "2026-10-15T01:00:00.000Z" })),
    projectCandidateReviewItem(candidate({ id: "kc_b", updatedAt: "2026-10-15T01:00:00.000Z" })),
    projectCandidateReviewItem(candidate({ id: "kc_a", updatedAt: "2026-10-15T01:00:00.000Z" })),
    projectSkillBundleReviewItem(bundle({ id: "sbi_new", updatedAt: "2026-10-15T02:00:00.000Z" })),
  ];
  assert.deepEqual(
    sortReviewItems(rows).map((x) => x.id),
    ["sbi_new", "kc_a", "kc_b", "sbi_b"],
  );
});

test("unknown filter value does not widen results", () => {
  const items = [projectCandidateReviewItem(candidate()), projectSkillBundleReviewItem(bundle())];
  assert.deepEqual(filterReviewItems(items, { kind: "mystery" as any }), []);
  assert.deepEqual(filterReviewItems(items, { type: "mystery" as any }), []);
  assert.deepEqual(filterReviewItems(items, { status: "mystery" }), []);
});

test("review paging over interleaved rows has no duplicates or skips", () => {
  const items: ReviewItem[] = Array.from({ length: 6 }, (_, i) =>
    i % 2 === 0
      ? projectCandidateReviewItem(candidate({ id: `kc_${i}`, updatedAt: `2026-10-15T0${6 - i}:00:00.000Z` }))
      : projectSkillBundleReviewItem(bundle({ id: `sbi_${i}`, updatedAt: `2026-10-15T0${6 - i}:00:00.000Z` })),
  );
  const sorted = sortReviewItems(items);
  const first = paginateReviewItems(sorted, { limit: "2" });
  const second = paginateReviewItems(sorted, { limit: "2", cursor: "2" });
  const third = paginateReviewItems(sorted, { limit: "2", cursor: "4" });
  assert.deepEqual(
    first.items.map((x) => x.id),
    sorted.slice(0, 2).map((x) => x.id),
  );
  assert.deepEqual(
    second.items.map((x) => x.id),
    sorted.slice(2, 4).map((x) => x.id),
  );
  assert.deepEqual(
    third.items.map((x) => x.id),
    sorted.slice(4, 6).map((x) => x.id),
  );
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((x) => x.id)).size, 6);
  assert.equal(first.page.previousCursor, undefined);
  assert.equal(first.page.nextCursor, "2");
  assert.equal(third.page.nextCursor, undefined);
  assert.equal(third.page.previousCursor, "2");
});

test("review summary includes type-specific states", () => {
  const summary = summarizeReviewItems([
    projectCandidateReviewItem(candidate({ id: "kc_del", status: "deleting" })),
    projectCandidateReviewItem(candidate({ id: "kc_deleted", status: "deleted" })),
    projectSkillBundleReviewItem(bundle({ id: "sbi_stale", status: "review_stale" })),
    projectSkillBundleReviewItem(bundle({ id: "sbi_drift", status: "published_drifted" })),
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.counts.deleting, 1);
  assert.equal(summary.counts.deleted, 1);
  assert.equal(summary.counts.review_stale, 1);
  assert.equal(summary.counts.published_drifted, 1);
});

test("bounded collector fetches beyond one source page for a global window", async () => {
  const candidateRows = [
    candidate({ id: "kc_6", updatedAt: "2026-10-15T06:00:00.000Z" }),
    candidate({ id: "kc_4", updatedAt: "2026-10-15T04:00:00.000Z" }),
    candidate({ id: "kc_2", updatedAt: "2026-10-15T02:00:00.000Z" }),
  ];
  const bundleRows = [
    bundle({ id: "sbi_5", updatedAt: "2026-10-15T05:00:00.000Z" }),
    bundle({ id: "sbi_3", updatedAt: "2026-10-15T03:00:00.000Z" }),
    bundle({ id: "sbi_1", updatedAt: "2026-10-15T01:00:00.000Z" }),
  ];
  let candidateCalls = 0;
  let bundleCalls = 0;
  const items = await collectReviewItemsBounded(
    { limit: "2", cursor: "2" },
    {
      pageSize: 1,
      maxSourceRows: 10,
      fetchCandidates: async (cursor, limit) => {
        candidateCalls += 1;
        const offset = Number(cursor ?? 0);
        const page = candidateRows.slice(offset, offset + limit);
        return {
          items: page,
          total: candidateRows.length,
          nextCursor: offset + limit < candidateRows.length ? String(offset + limit) : undefined,
        };
      },
      fetchBundles: async (cursor, limit) => {
        bundleCalls += 1;
        const offset = Number(cursor ?? 0);
        const page = bundleRows.slice(offset, offset + limit);
        return {
          items: page,
          total: bundleRows.length,
          nextCursor: offset + limit < bundleRows.length ? String(offset + limit) : undefined,
        };
      },
    },
  );
  assert.deepEqual(
    sortReviewItems(items)
      .slice(2, 4)
      .map((item) => item.id),
    ["kc_4", "sbi_3"],
  );
  assert.ok(candidateCalls >= 3, "candidate source must page beyond its first page");
  assert.ok(bundleCalls >= 3, "bundle source must page beyond its first page");
});

test("bounded collector stops after the requested global window and reports source totals", async () => {
  let candidateCalls = 0;
  let bundleCalls = 0;
  const totals = new Map<string, number>();
  const items = await collectReviewItemsBounded(
    { limit: "20" },
    {
      pageSize: 20,
      maxSourceRows: 1000,
      onSourceTotal: (kind, total) => totals.set(kind, total),
      fetchCandidates: async (cursor, limit) => {
        candidateCalls += 1;
        const offset = Number(cursor ?? 0);
        const rows = Array.from({ length: limit }, (_, index) =>
          candidate({
            id: `kc_${offset + index}`,
            updatedAt: new Date(Date.UTC(2026, 9, 15, 23, 59, offset + index)).toISOString(),
          }),
        );
        return { items: rows, total: 5000, nextCursor: String(offset + limit) };
      },
      fetchBundles: async (cursor, limit) => {
        bundleCalls += 1;
        const offset = Number(cursor ?? 0);
        const rows = Array.from({ length: limit }, (_, index) =>
          bundle({
            id: `sbi_${offset + index}`,
            updatedAt: new Date(Date.UTC(2026, 9, 14, 23, 59, offset + index)).toISOString(),
          }),
        );
        return { items: rows, total: 4000, nextCursor: String(offset + limit) };
      },
    },
  );
  assert.equal(items.length, 40, "top-20 globally needs at most 20 rows from each sorted source");
  assert.equal(candidateCalls, 1);
  assert.equal(bundleCalls, 1);
  assert.equal(totals.get("candidate"), 5000);
  assert.equal(totals.get("skill-bundle"), 4000);
  const page = paginateReviewItems(sortReviewItems(items), { limit: "20" }, 9000);
  assert.equal(page.items.length, 20);
  assert.equal(page.page.total, 9000);
  assert.equal(page.page.nextCursor, "20");
});

test("bounded collector fails instead of scanning beyond its source cap", async () => {
  await assert.rejects(
    collectReviewItemsBounded(
      { q: "never-matches", limit: "2" },
      {
        pageSize: 2,
        maxSourceRows: 4,
        fetchCandidates: async (cursor, limit) => {
          const offset = Number(cursor ?? 0);
          const rows = Array.from({ length: limit }, (_, index) =>
            candidate({ id: `kc_${offset + index}`, title: "other" }),
          );
          return { items: rows, total: 100, nextCursor: String(offset + limit) };
        },
        fetchBundles: async () => ({ items: [], total: 0 }),
      },
    ),
    /Admin review query exceeded bounded source scan/,
  );
});
