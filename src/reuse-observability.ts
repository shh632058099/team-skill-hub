/** Bounded result metadata only: never persist full Skill/Knowledge content. */
export interface ReuseObservation {
  event: "hit" | "miss" | "load";
  resultCount?: number;
  topScore?: number;
  assets: Array<{ repository: string; path: string; title?: string; score?: number }>;
}

const searchTools = new Set([
  "discover",
  "search_skills",
  "search_knowledge",
  "resolve_skill",
  "skill_search",
  "knowledge_search",
]);
const loadTools = new Set(["get_skill", "get_knowledge", "get_skill_resource"]);
const trim = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");

export function observeReuse(
  tool: string,
  result: unknown,
  options: { knowledgeMatchMinScore?: number } = {},
): ReuseObservation | undefined {
  if (!searchTools.has(tool) && !loadTools.has(tool)) return undefined;
  if (!result || typeof result !== "object") return undefined;
  const value = result as Record<string, unknown>;
  if (loadTools.has(tool)) {
    const repository = trim(value.repository);
    const path = trim(value.path || value.relativePath || value.name);
    if (!repository || !path) return undefined;
    return { event: "load", assets: [{ repository, path, title: trim(value.title || value.name) || undefined }] };
  }
  const items = Array.isArray(value.results)
    ? value.results
    : tool === "discover"
      ? [
          ...(Array.isArray(value.skills) ? value.skills : []),
          ...(Array.isArray(value.knowledge) ? value.knowledge : []),
        ]
      : Array.isArray(value.alternatives)
        ? value.alternatives
        : [];
  const selected = value.selected_skill && typeof value.selected_skill === "object" ? value.selected_skill : undefined;
  const ranked = selected ? [selected, ...items] : items;
  const assets = ranked.slice(0, 5).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const repository = trim(r.repository || r.repositoryId);
    const path = trim(r.path || r.relativePath || r.name);
    if (!repository || !path) return [];
    return [
      {
        repository,
        path,
        title: trim(r.title || r.name) || undefined,
        ...(typeof r.score === "number" && Number.isFinite(r.score) ? { score: r.score } : {}),
      },
    ];
  });
  const resultCount =
    tool === "resolve_skill" || tool === "discover"
      ? value.selected_skill || ranked.length
        ? ranked.length
        : 0
      : ranked.length;
  const topScore = assets[0]?.score;
  const meetsThreshold =
    tool !== "search_knowledge" ||
    options.knowledgeMatchMinScore === undefined ||
    (topScore !== undefined && topScore >= options.knowledgeMatchMinScore);
  return {
    event: resultCount > 0 && meetsThreshold ? "hit" : "miss",
    resultCount,
    ...(assets[0]?.score !== undefined ? { topScore: assets[0].score } : {}),
    assets,
  };
}
