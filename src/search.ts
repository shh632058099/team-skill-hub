import { DatabaseSync } from "node:sqlite";
import type {
  SearchFilters,
  SearchResult,
  Skill,
  SkillCandidateReranker,
  SkillRoutingStrategy,
  SkillSearchBackend
} from "./types.js";

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter(Boolean);
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

function manualScore(skill: Skill, query: string): number {
  const q = query.toLowerCase();
  const terms = tokenize(q);
  const haystacks = {
    name: skill.name.toLowerCase(),
    description: skill.description.toLowerCase(),
    keywords: skill.metadata.keywords.join(" ").toLowerCase(),
    domain: skill.metadata.domain.join(" ").toLowerCase(),
    category: skill.metadata.category.join(" ").toLowerCase()
  };
  let score = 0;
  for (const term of terms) {
    if (haystacks.name.includes(term)) score += 4;
    if (haystacks.keywords.includes(term)) score += 3;
    if (haystacks.domain.includes(term)) score += 2;
    if (haystacks.category.includes(term)) score += 2;
    if (haystacks.description.includes(term)) score += 1;
  }
  if (score <= 0) return 0;
  score += skill.metadata.priority / 100;
  if (skill.metadata.maturity === "stable") score += 0.5;
  return score;
}

export class SqliteFtsSearchBackend implements SkillSearchBackend {
  private readonly db = new DatabaseSync(":memory:");
  private skills = new Map<string, Skill>();

  constructor() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
        skill_key UNINDEXED,
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
      "INSERT INTO skill_fts(skill_key,name,description,keywords,domain,category) VALUES(?,?,?,?,?,?)"
    );
    for (const skill of skills) {
      insert.run(
        skill.key,
        skill.name,
        skill.description,
        skill.metadata.keywords.join(" "),
        skill.metadata.domain.join(" "),
        skill.metadata.category.join(" ")
      );
    }
  }

  search(query: string, filters: SearchFilters, limit: number): SearchResult[] {
    const candidates = new Map<string, number>();
    const terms = tokenize(query);
    if (terms.length > 0) {
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      try {
        const rows = this.db
          .prepare("SELECT skill_key, bm25(skill_fts) AS rank FROM skill_fts WHERE skill_fts MATCH ? LIMIT ?")
          .all(match, Math.max(limit * 5, 20)) as Array<{ skill_key: string; rank: number }>;
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
      const score = manual + fts * 2;
      if (score <= 0) continue;
      results.push({
        skill,
        score,
        reason: `matched name/metadata/description; score=${score.toFixed(2)}`
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
