import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSearchResult,
  KnowledgeSourceConfig
} from "./types.js";

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeSourceConfig = {
  enabled: true,
  include: ["**/*.md", "**/*.txt", "**/*.pdf", "**/*.docx"],
  exclude: [],
  maxDocumentBytes: 2 * 1024 * 1024,
  chunkSizeChars: 1400,
  chunkOverlapChars: 180
};

export function normalizeKnowledgeConfig(
  config?: Partial<KnowledgeSourceConfig>
): KnowledgeSourceConfig {
  const chunkSizeChars = Math.max(200, Number(config?.chunkSizeChars ?? DEFAULT_KNOWLEDGE_CONFIG.chunkSizeChars));
  const chunkOverlapChars = Math.max(
    0,
    Math.min(
      chunkSizeChars - 1,
      Number(config?.chunkOverlapChars ?? DEFAULT_KNOWLEDGE_CONFIG.chunkOverlapChars)
    )
  );
  return {
    enabled: config?.enabled ?? DEFAULT_KNOWLEDGE_CONFIG.enabled,
    include: config?.include?.length ? [...config.include] : [...DEFAULT_KNOWLEDGE_CONFIG.include],
    exclude: [...(config?.exclude ?? DEFAULT_KNOWLEDGE_CONFIG.exclude)],
    maxDocumentBytes: Math.max(
      1024,
      Number(config?.maxDocumentBytes ?? DEFAULT_KNOWLEDGE_CONFIG.maxDocumentBytes)
    ),
    chunkSizeChars,
    chunkOverlapChars
  };
}
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "data", "revisions"]);
const SKIP_FILES = new Set(["SKILL.md", "PROMPT.md", "AGENT.yaml", "AGENT.yml", "EVALUATION.yaml", "EVALUATION.yml"]);

function titleFromContent(relativePath: string, content: string): string {
  if (relativePath.toLowerCase().endsWith(".md")) {
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) return heading;
  }
  return path.basename(relativePath, path.extname(relativePath));
}

function chunkText(content: string, chunkSizeChars: number, chunkOverlapChars: number): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > chunkSizeChars * 2) {
      pushCurrent();
      let offset = 0;
      while (offset < paragraph.length) {
        const end = Math.min(paragraph.length, offset + chunkSizeChars);
        chunks.push(paragraph.slice(offset, end).trim());
        if (end >= paragraph.length) break;
        offset = Math.max(offset + 1, end - chunkOverlapChars);
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > chunkSizeChars && current) pushCurrent();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  pushCurrent();
  return chunks.filter(Boolean);
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(source + "$");
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}
async function walkKnowledgeFiles(root: string, config: KnowledgeSourceConfig): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (![".md", ".txt", ".pdf", ".docx"].includes(ext)) continue;
      const relativePath = path.relative(root, full).replaceAll("\\", "/");
      if (!matchesAny(relativePath, config.include)) continue;
      if (config.exclude.length > 0 && matchesAny(relativePath, config.exclude)) continue;
      const info = await stat(full);
      if (info.size > config.maxDocumentBytes) continue;
      files.push(full);
    }
  }
  await visit(root);
  return files.sort();
}

async function extractKnowledgeText(file: string): Promise<string> {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".md" || extension === ".txt") {
    return await readFile(file, "utf8");
  }

  const buffer = await readFile(file);
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  return "";
}

export async function scanKnowledge(
  root: string,
  repositoryId: string,
  revision: string,
  sourceConfig?: Partial<KnowledgeSourceConfig>
): Promise<KnowledgeDocument[]> {
  const config = normalizeKnowledgeConfig(sourceConfig);
  if (!config.enabled) return [];
  const documents: KnowledgeDocument[] = [];
  for (const file of await walkKnowledgeFiles(root, config)) {
    const relativePath = path.relative(root, file).replaceAll("\\", "/");
    let content: string;
    try {
      content = await extractKnowledgeText(file);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "knowledge.document.skipped",
          repository: repositoryId,
          path: relativePath,
          error: error instanceof Error ? error.message : String(error)
        })
      );
      continue;
    }
    const chunks = chunkText(content, config.chunkSizeChars, config.chunkOverlapChars);
    if (chunks.length === 0) continue;
    documents.push({
      key: `${repositoryId}:${relativePath}`,
      repositoryId,
      revision,
      relativePath,
      title: titleFromContent(relativePath, content),
      content,
      chunkCount: chunks.length,
      chunkSizeChars: config.chunkSizeChars,
      chunkOverlapChars: config.chunkOverlapChars
    });
  }
  return documents;
}

export function chunksForDocuments(documents: KnowledgeDocument[]): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (const document of documents) {
    const config = normalizeKnowledgeConfig({
      chunkSizeChars: document.chunkSizeChars,
      chunkOverlapChars: document.chunkOverlapChars
    });
    for (const [chunkIndex, content] of chunkText(document.content, config.chunkSizeChars, config.chunkOverlapChars).entries()) {
      chunks.push({
        key: `${document.key}#${chunkIndex}`,
        documentKey: document.key,
        repositoryId: document.repositoryId,
        revision: document.revision,
        relativePath: document.relativePath,
        title: document.title,
        chunkIndex,
        content
      });
    }
  }
  return chunks;
}

function queryTerms(query: string): string[] {
  const raw = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const terms = new Set<string>();
  for (const token of raw) {
    terms.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length >= 2) {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms].filter(Boolean);
}

export class KnowledgeIndex {
  private readonly db = new DatabaseSync(":memory:");
  private chunks = new Map<string, KnowledgeChunk>();

  constructor() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        chunk_key UNINDEXED,
        repository_id UNINDEXED,
        path,
        title,
        content,
        tokenize='unicode61'
      );
    `);
  }

  rebuild(chunks: KnowledgeChunk[]): void {
    this.chunks = new Map(chunks.map((chunk) => [chunk.key, chunk]));
    this.db.exec("DELETE FROM knowledge_fts");
    const insert = this.db.prepare(
      "INSERT INTO knowledge_fts(chunk_key,repository_id,path,title,content) VALUES(?,?,?,?,?)"
    );
    for (const chunk of chunks) {
      insert.run(
        chunk.key,
        chunk.repositoryId,
        chunk.relativePath,
        chunk.title,
        chunk.content
      );
    }
  }

  search(
    query: string,
    allowedRepositoryIds: string[],
    limit: number,
    requestedRepositories?: string[]
  ): KnowledgeSearchResult[] {
    const allowed = new Set(
      requestedRepositories?.length
        ? requestedRepositories.filter((id) => allowedRepositoryIds.includes(id))
        : allowedRepositoryIds
    );
    const terms = queryTerms(query);
    const ftsCandidates = new Map<string, number>();

    if (terms.length > 0) {
      const ftsTerms = terms.filter((term) => term.length >= 2).slice(0, 24);
      if (ftsTerms.length > 0) {
        const match = ftsTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
        try {
          const rows = this.db
            .prepare("SELECT chunk_key, bm25(knowledge_fts) AS rank FROM knowledge_fts WHERE knowledge_fts MATCH ? LIMIT ?")
            .all(match, Math.max(limit * 8, 40)) as Array<{ chunk_key: string; rank: number }>;
          for (const row of rows) {
            ftsCandidates.set(row.chunk_key, 1 / (1 + Math.abs(row.rank)));
          }
        } catch {
          // Manual scoring remains the fallback.
        }
      }
    }

    const results: KnowledgeSearchResult[] = [];
    for (const chunk of this.chunks.values()) {
      if (!allowed.has(chunk.repositoryId)) continue;
      const title = chunk.title.toLowerCase();
      const filePath = chunk.relativePath.toLowerCase();
      const content = chunk.content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 4;
        if (filePath.includes(term)) score += 2;
        if (content.includes(term)) score += term.length >= 2 ? 1.5 : 0.25;
      }
      score += (ftsCandidates.get(chunk.key) ?? 0) * 2;
      if (score <= 0) continue;
      results.push({
        chunk,
        score,
        reason: `matched path/title/content; score=${score.toFixed(2)}`
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
