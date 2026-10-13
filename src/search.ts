import { DatabaseSync } from "node:sqlite";
import type {
  SearchFilters,
  SearchResult,
  Skill,
  SkillCandidateReranker,
  SkillRoutingStrategy,
  SkillSearchBackend
} from "./types.js";

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
  "使用", "实现", "问题", "相关", "如何", "怎么", "帮我", "当前", "项目", "配置", "规则", "的", "和", "与"
]);

function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const terms = new Set<string>();
  const add = (value: string) => {
    const token = value.trim();
    if (!token || SEARCH_STOP_WORDS.has(token)) return;
    if (token.includes("-") || token.includes("_")) {
      for (const part of token.split(/[-_]+/)) add(part);
    }
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length >= 2) {
      terms.add(token);
      for (let i = 0; i < token.length - 1; i += 1) {
        const bigram = token.slice(i, i + 2);
        if (!SEARCH_STOP_WORDS.has(bigram)) terms.add(bigram);
      }
      return;
    }
    if (token.length >= 2) terms.add(token);
  };
  for (const token of raw) add(token);
  return [...terms];
}

function matchesFilters(skill: Skill, filters: SearchFilters): boolean {
  if (filters.repositories?.length && !filters.repositories.includes(skill.repositoryId)) return false;
  if (filters.domain && !skill.metadata.domain.includes(filters.domain)) return false;
  if (filters.category && !skill.metadata.category.includes(filters.category)) return false;
  if (filters.audience && !skill.metadata.audience.includes(filters.audience)) return false;
  if (filters.maturity && skill.metadata.maturity !== filters.maturity) return false;
  if (filters.client && skill.metadata.compatibility[filters.client] === false) return false;
  return true;
}

function manualScore(skill: Skill, query: string): { score: number; coverage: number } {
  const q = query.toLowerCase();
  const terms = tokenize(q);
  if (terms.length === 0) return { score: 0, coverage: 0 };
  const tokenSets = {
    name: new Set(tokenize(skill.name)),
    description: new Set(tokenize(skill.description)),
    keywords: new Set(tokenize(skill.metadata.keywords.join(" "))),
    domain: new Set(tokenize(skill.metadata.domain.join(" "))),
    category: new Set(tokenize(skill.metadata.category.join(" ")))
  };
  let score = 0;
  const matched = new Set<string>();
  for (const term of terms) {
    let hit = false;
    if (tokenSets.name.has(term)) { score += 4; hit = true; }
    if (tokenSets.keywords.has(term)) { score += 3; hit = true; }
    if (tokenSets.domain.has(term)) { score += 2; hit = true; }
    if (tokenSets.category.has(term)) { score += 2; hit = true; }
    if (tokenSets.description.has(term)) { score += 1; hit = true; }
    if (hit) matched.add(term);
  }
  const normalizedName = skill.name.toLowerCase().replace(/[-_]+/g, " ");
  if (normalizedName.length >= 4 && q.includes(normalizedName)) score += 8;
  for (const keyword of skill.metadata.keywords) {
    const normalized = keyword.toLowerCase().trim().replace(/[-_]+/g, " ");
    if (normalized.length >= 3 && !SEARCH_STOP_WORDS.has(normalized) && q.includes(normalized)) score += 6;
  }
  if (score <= 0) return { score: 0, coverage: 0 };
  const coverage = matched.size / terms.length;
  score *= 0.4 + coverage * 0.6;
  score += skill.metadata.priority / 100;
  if (skill.metadata.maturity === "stable") score += 0.5;
  return { score, coverage };
}

export class SqliteFtsSearchBackend implements SkillSearchBackend {
  private readonly db = new DatabaseSync(":memory:");
  private skills = new Map<string, Skill>();

  constructor() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
        skill_key UNINDEXED,
        repository_id UNINDEXED,
        name,
        description,
        keywords,
        domain,
        category,
        tokenize='unicode61'
      );
    `);
  }

  rebuild(skills: Skill[]): void {
    this.skills = new Map(skills.map((skill) => [skill.key, skill]));
    this.db.exec("DELETE FROM skill_fts");
    const insert = this.db.prepare(
      "INSERT INTO skill_fts(skill_key,repository_id,name,description,keywords,domain,category) VALUES(?,?,?,?,?,?,?)"
    );
    for (const skill of skills) {
      insert.run(
        skill.key,
        skill.repositoryId,
        skill.name,
        skill.description,
        skill.metadata.keywords.join(" "),
        skill.metadata.domain.join(" "),
        skill.metadata.category.join(" ")
      );
    }
  }

  search(query: string, filters: SearchFilters, limit: number): SearchResult[] {
    if (filters.repositories !== undefined && filters.repositories.length === 0) return [];
    const candidates = new Map<string, number>();
    const terms = tokenize(query);
    if (terms.length > 0) {
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      try {
        const repositories = filters.repositories;
        const rows = repositories
          ? (this.db
              .prepare(
                `SELECT skill_key, bm25(skill_fts) AS rank
                 FROM skill_fts
                 WHERE skill_fts MATCH ?
                   AND repository_id IN (${repositories.map(() => "?").join(",")})
                 LIMIT ?`
              )
              .all(match, ...repositories, Math.max(limit * 5, 20)) as Array<{
              skill_key: string;
              rank: number;
            }>)
          : (this.db
              .prepare("SELECT skill_key, bm25(skill_fts) AS rank FROM skill_fts WHERE skill_fts MATCH ? LIMIT ?")
              .all(match, Math.max(limit * 5, 20)) as Array<{ skill_key: string; rank: number }>);
        for (const row of rows) candidates.set(row.skill_key, 1 / (1 + Math.abs(row.rank)));
      } catch {
        // Manual scoring below is the safe fallback.
      }
    }

    const results: SearchResult[] = [];
    for (const skill of this.skills.values()) {
      if (!matchesFilters(skill, filters)) continue;
      const manual = manualScore(skill, query);
      const fts = candidates.get(skill.key) ?? 0;
      const score = manual.score + (manual.coverage > 0 ? fts * 2 : 0);
      if (score <= 0 || manual.coverage <= 0) continue;
      results.push({
        skill,
        score,
        coverage: manual.coverage,
        reason: `matched exact tokens/phrases; coverage=${manual.coverage.toFixed(2)}; score=${score.toFixed(2)}`
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}

export class PassThroughCandidateReranker implements SkillCandidateReranker {
  rerank(_query: string, candidates: SearchResult[], limit: number): SearchResult[] {
    return candidates.slice(0, limit);
  }
}

export class HybridRoutingStrategy implements SkillRoutingStrategy {
  constructor(
    private readonly backend: SkillSearchBackend,
    private readonly reranker: SkillCandidateReranker = new PassThroughCandidateReranker()
  ) {}

  resolve(query: string, filters: SearchFilters, limit: number): SearchResult[] {
    const candidates = this.backend.search(query, filters, Math.max(limit * 3, limit));
    return this.reranker.rerank(query, candidates, limit);
  }
}

export class SearchRoutingStrategy {
  constructor(private readonly backend: SkillSearchBackend) {}
  resolve(query: string, filters: SearchFilters, limit: number): SearchResult[] {
    return this.backend.search(query, filters, limit);
  }
}
