import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import YAML from "yaml";
import type {
  KnowledgeApplicability,
  KnowledgeApplicabilityContext,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeLifecycleMetadata,
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

function splitMarkdownSections(content: string): string[] {
  const lines = content.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) sections.push(value);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*`{3}/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && /^#{1,6}\s+\S/.test(line) && current.some((item) => item.trim())) {
      flush();
    }
    current.push(line);
  }
  flush();
  return sections;
}

function splitMarkdownBlocks(content: string): string[] {
  const lines = content.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced: string[] | undefined;
  let table: string[] | undefined;
  const flushCurrent = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  const flushTable = () => {
    const value = table?.join("\n").trim();
    if (value) blocks.push(value);
    table = undefined;
  };
  const isFence = (line: string) => /^\s*\x60{3}/.test(line);
  const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);

  for (const line of lines) {
    if (fenced) {
      fenced.push(line);
      if (isFence(line) && fenced.length > 1) {
        blocks.push(fenced.join("\n").trim());
        fenced = undefined;
      }
      continue;
    }
    if (isFence(line)) {
      flushCurrent();
      flushTable();
      fenced = [line];
      continue;
    }
    if (isTableLine(line)) {
      flushCurrent();
      table ??= [];
      table.push(line);
      continue;
    }
    if (table) flushTable();
    if (!line.trim()) {
      flushCurrent();
      continue;
    }
    current.push(line);
  }
  if (fenced?.length) blocks.push(fenced.join("\n").trim());
  flushTable();
  flushCurrent();
  return blocks.filter(Boolean);
}

function chunkParagraphs(content: string, chunkSizeChars: number, chunkOverlapChars: number): string[] {
  const paragraphs = splitMarkdownBlocks(content);
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

function chunkText(content: string, chunkSizeChars: number, chunkOverlapChars: number): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const sections = splitMarkdownSections(normalized);
  if (sections.length <= 1) return chunkParagraphs(normalized, chunkSizeChars, chunkOverlapChars);
  return sections.flatMap((section) => {
    const heading = section.match(/^(#{1,6}\s+[^\n]+)\n+([\s\S]*)$/);
    if (!heading) return chunkParagraphs(section, chunkSizeChars, chunkOverlapChars);
    const headingText = heading[1]!.trim();
    const body = heading[2]!.trim();
    if (!body) return [headingText];
    const bodySize = Math.max(80, chunkSizeChars - headingText.length - 2);
    return chunkParagraphs(body, bodySize, Math.min(chunkOverlapChars, Math.max(0, bodySize - 1)))
      .map((item) => `${headingText}\n\n${item}`);
  }).filter(Boolean);
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

function lifecycleString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function lifecycleReviewCycleDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const normalized = String(value).trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(?:d|day|days)?$/);
  if (!match) return undefined;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : undefined;
}

function lifecycleStringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : String(value).split(",");
  const normalized = values
    .map((item) => lifecycleString(item))
    .filter((item): item is string => Boolean(item));
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function parseKnowledgeApplicability(value: unknown): KnowledgeApplicability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: KnowledgeApplicability = {
    product: lifecycleStringList(raw.product),
    branch: lifecycleStringList(raw.branch),
    firmwareVersion: lifecycleStringList(raw.firmware_version ?? raw.firmwareVersion),
    yoctoRelease: lifecycleStringList(raw.yocto_release ?? raw.yoctoRelease),
    kernelVersion: lifecycleStringList(raw.kernel_version ?? raw.kernelVersion),
    apiVersion: lifecycleStringList(raw.api_version ?? raw.apiVersion),
    hardwareRevision: lifecycleStringList(raw.hardware_revision ?? raw.hardwareRevision),
    variant: lifecycleStringList(raw.variant ?? raw.customer_variant ?? raw.customerVariant)
  };
  return Object.values(result).some(Boolean) ? result : undefined;
}

function parseMarkdownKnowledge(content: string): {
  content: string;
  metadata?: KnowledgeLifecycleMetadata;
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { content };
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { content };
  try {
    const raw = YAML.parse(match[1] ?? "") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { content: content.slice(match[0].length) };
    const statusValue = lifecycleString(raw.status);
    const status =
      statusValue && ["draft", "active", "deprecated", "superseded", "expired", "archived"].includes(statusValue)
        ? (statusValue as KnowledgeLifecycleMetadata["status"])
        : undefined;
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map((item) => lifecycleString(item)).filter((item): item is string => Boolean(item))
      : lifecycleString(raw.tags)
        ? lifecycleString(raw.tags)!.split(",").map((item) => item.trim()).filter(Boolean)
        : undefined;
    return {
      content: content.slice(match[0].length),
      metadata: {
        owner: lifecycleString(raw.owner),
        status,
        tags: tags?.length ? tags : undefined,
        createdAt: lifecycleString(raw.created_at ?? raw.createdAt),
        updatedAt: lifecycleString(raw.updated_at ?? raw.updatedAt),
        validFrom: lifecycleString(raw.valid_from ?? raw.validFrom),
        validUntil: lifecycleString(raw.valid_until ?? raw.validUntil),
        source: lifecycleString(raw.source),
        supersedes: lifecycleString(raw.supersedes),
        reviewCycleDays: lifecycleReviewCycleDays(
          raw.review_cycle_days ?? raw.reviewCycleDays ?? raw.review_cycle ?? raw.reviewCycle
        ),
        applicability: parseKnowledgeApplicability(raw.applicability)
      }
    };
  } catch {
    return { content };
  }
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
    let metadata: KnowledgeLifecycleMetadata | undefined;
    try {
      content = await extractKnowledgeText(file);
      if (path.extname(file).toLowerCase() === ".md") {
        const parsed = parseMarkdownKnowledge(content);
        content = parsed.content;
        metadata = parsed.metadata;
      }
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
      chunkOverlapChars: config.chunkOverlapChars,
      metadata
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
        content,
        metadata: document.metadata
      });
    }
  }
  return chunks;
}

export interface KnowledgeLifecycleIssue {
  repositoryId: string;
  path: string;
  title: string;
  owner?: string;
  status?: KnowledgeLifecycleMetadata["status"];
  validUntil?: string;
  lastReviewedAt?: string;
  reviewCycleDays?: number;
  reviewDueAt?: string;
  kind:
    | "expired"
    | "deprecated"
    | "superseded"
    | "archived"
    | "draft"
    | "missing-owner"
    | "invalid-valid-until"
    | "invalid-updated-at"
    | "review-overdue";
  message: string;
}

export function auditKnowledgeLifecycle(
  documents: KnowledgeDocument[],
  now = new Date()
): KnowledgeLifecycleIssue[] {
  const issues: KnowledgeLifecycleIssue[] = [];
  for (const document of documents) {
    const metadata = document.metadata;
    const base = {
      repositoryId: document.repositoryId,
      path: document.relativePath,
      title: document.title,
      owner: metadata?.owner,
      status: metadata?.status,
      validUntil: metadata?.validUntil,
      lastReviewedAt: metadata?.updatedAt ?? metadata?.createdAt,
      reviewCycleDays: metadata?.reviewCycleDays,
      reviewDueAt:
        metadata?.reviewCycleDays && (metadata.updatedAt || metadata.createdAt)
          ? (() => {
              const reviewedAt = Date.parse(metadata.updatedAt ?? metadata.createdAt!);
              return Number.isFinite(reviewedAt)
                ? new Date(reviewedAt + metadata.reviewCycleDays * 24 * 60 * 60 * 1000).toISOString()
                : undefined;
            })()
          : undefined
    };
    if (!metadata?.owner) {
      issues.push({ ...base, kind: "missing-owner", message: "Knowledge has no owner." });
    }
    if (metadata?.status === "draft") {
      issues.push({ ...base, kind: "draft", message: "Knowledge is still marked draft." });
    } else if (metadata?.status === "deprecated") {
      issues.push({ ...base, kind: "deprecated", message: "Knowledge is marked deprecated." });
    } else if (metadata?.status === "superseded") {
      issues.push({ ...base, kind: "superseded", message: "Knowledge is marked superseded." });
    } else if (metadata?.status === "expired") {
      issues.push({ ...base, kind: "expired", message: "Knowledge is marked expired." });
    } else if (metadata?.status === "archived") {
      issues.push({ ...base, kind: "archived", message: "Knowledge is marked archived." });
    }
    if (metadata?.reviewCycleDays && (metadata.updatedAt || metadata.createdAt)) {
      const reviewedAtRaw = metadata.updatedAt ?? metadata.createdAt!;
      const reviewedAt = new Date(reviewedAtRaw);
      if (Number.isNaN(reviewedAt.getTime())) {
        issues.push({
          ...base,
          kind: "invalid-updated-at",
          message: "Knowledge updated_at/created_at is not a valid date for review-cycle calculation."
        });
      } else {
        const dueAt = reviewedAt.getTime() + metadata.reviewCycleDays * 24 * 60 * 60 * 1000;
        if (dueAt < now.getTime()) {
          issues.push({
            ...base,
            kind: "review-overdue",
            message: `Knowledge review is overdue (cycle ${metadata.reviewCycleDays} days, last reviewed ${reviewedAtRaw}).`
          });
        }
      }
    }
    if (metadata?.validUntil) {
      const validUntil = new Date(metadata.validUntil);
      if (Number.isNaN(validUntil.getTime())) {
        issues.push({
          ...base,
          kind: "invalid-valid-until",
          message: "Knowledge valid_until is not a valid date."
        });
      } else if (validUntil.getTime() < now.getTime()) {
        issues.push({
          ...base,
          kind: "expired",
          message: `Knowledge expired at ${metadata.validUntil}.`
        });
      }
    }
  }
  const severity: Record<KnowledgeLifecycleIssue["kind"], number> = {
    expired: 0,
    deprecated: 1,
    superseded: 2,
    archived: 3,
    "invalid-valid-until": 4,
    "invalid-updated-at": 5,
    "review-overdue": 6,
    draft: 7,
    "missing-owner": 8
  };
  return issues.sort(
    (a, b) =>
      severity[a.kind] - severity[b.kind] ||
      a.repositoryId.localeCompare(b.repositoryId) ||
      a.path.localeCompare(b.path)
  );
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

function applicabilityPatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + escaped + "$", "i").test(value.trim());
}

export function knowledgeApplicabilityMatches(
  applicability: KnowledgeApplicability | undefined,
  context: KnowledgeApplicabilityContext | undefined
): boolean {
  if (!applicability || !context) return true;
  const checks: Array<[string[] | undefined, string | undefined]> = [
    [applicability.product, context.product],
    [applicability.branch, context.branch],
    [applicability.firmwareVersion, context.firmwareVersion],
    [applicability.yoctoRelease, context.yoctoRelease],
    [applicability.kernelVersion, context.kernelVersion],
    [applicability.apiVersion, context.apiVersion],
    [applicability.hardwareRevision, context.hardwareRevision],
    [applicability.variant, context.variant]
  ];
  return checks.every(([patterns, value]) => {
    if (!patterns?.length || !value) return true;
    return patterns.some((pattern) => applicabilityPatternMatches(pattern, value));
  });
}

export class KnowledgeIndex {
  private readonly db = new DatabaseSync(":memory:");
  private chunks = new Map<string, KnowledgeChunk>();

  constructor() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        chunk_key UNINDEXED,
        repository_id UNINDEXED,
        lifecycle_status UNINDEXED,
        path,
        title,
        content,
        tokenize='unicode61'
      );
    `);
  }

  storageStats(): {
    chunkCount: number;
    sqlitePageCount: number;
    sqlitePageSize: number;
    sqliteApproxBytes: number;
  } {
    const pageCountRow = this.db.prepare("PRAGMA page_count").get() as { page_count?: number };
    const pageSizeRow = this.db.prepare("PRAGMA page_size").get() as { page_size?: number };
    const sqlitePageCount = Number(pageCountRow.page_count ?? 0);
    const sqlitePageSize = Number(pageSizeRow.page_size ?? 0);
    return {
      chunkCount: this.chunks.size,
      sqlitePageCount,
      sqlitePageSize,
      sqliteApproxBytes: sqlitePageCount * sqlitePageSize
    };
  }

  rebuild(chunks: KnowledgeChunk[]): void {
    this.chunks = new Map(chunks.map((chunk) => [chunk.key, chunk]));
    this.db.exec("DELETE FROM knowledge_fts");
    const insert = this.db.prepare(
      "INSERT INTO knowledge_fts(chunk_key,repository_id,lifecycle_status,path,title,content) VALUES(?,?,?,?,?,?)"
    );
    for (const chunk of chunks) {
      insert.run(
        chunk.key,
        chunk.repositoryId,
        chunk.metadata?.status ?? "",
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
    requestedRepositories?: string[],
    applicabilityContext?: KnowledgeApplicabilityContext
  ): KnowledgeSearchResult[] {
    const allowed = new Set(
      requestedRepositories?.length
        ? requestedRepositories.filter((id) => allowedRepositoryIds.includes(id))
        : allowedRepositoryIds
    );
    if (allowed.size === 0) return [];
    const terms = queryTerms(query);
    const ftsCandidates = new Map<string, number>();

    if (terms.length > 0) {
      const ftsTerms = terms.filter((term) => term.length >= 2).slice(0, 24);
      if (ftsTerms.length > 0) {
        const match = ftsTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
        try {
          const repositoryIds = [...allowed];
          const placeholders = repositoryIds.map(() => "?").join(",");
          const rows = this.db
            .prepare(
              `SELECT chunk_key, bm25(knowledge_fts) AS rank
               FROM knowledge_fts
               WHERE knowledge_fts MATCH ?
                 AND repository_id IN (${placeholders})
                 AND lifecycle_status NOT IN ('deprecated','superseded','expired','archived')
               LIMIT ?`
            )
            .all(match, ...repositoryIds, Math.max(limit * 8, 40)) as Array<{
              chunk_key: string;
              rank: number;
            }>;
          for (const row of rows) {
            ftsCandidates.set(row.chunk_key, 1 / (1 + Math.abs(row.rank)));
          }
        } catch {
          // Manual scoring remains the fallback.
        }
      }
    }

    const now = new Date();
    const results: KnowledgeSearchResult[] = [];
    for (const chunk of this.chunks.values()) {
      if (!allowed.has(chunk.repositoryId)) continue;
      const lifecycle = chunk.metadata;
      if (
        lifecycle?.status === "deprecated" ||
        lifecycle?.status === "superseded" ||
        lifecycle?.status === "expired" ||
        lifecycle?.status === "archived"
      ) continue;
      if (lifecycle?.validFrom) {
        const validFrom = new Date(lifecycle.validFrom);
        if (!Number.isNaN(validFrom.getTime()) && validFrom.getTime() > now.getTime()) continue;
      }
      if (lifecycle?.validUntil) {
        const validUntil = new Date(lifecycle.validUntil);
        if (!Number.isNaN(validUntil.getTime()) && validUntil.getTime() < now.getTime()) continue;
      }
      if (!knowledgeApplicabilityMatches(lifecycle?.applicability, applicabilityContext)) continue;
      const title = chunk.title.toLowerCase();
      const filePath = chunk.relativePath.toLowerCase();
      const content = chunk.content.toLowerCase();
      const tags = (lifecycle?.tags ?? []).join(" ").toLowerCase();
      const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, " ");
      let score = 0;
      const reasons: string[] = [];
      let titleScore = 0;
      let pathScore = 0;
      let contentScore = 0;
      let tagScore = 0;
      for (const term of terms) {
        if (title.includes(term)) titleScore += 4;
        if (filePath.includes(term)) pathScore += 2;
        if (content.includes(term)) contentScore += term.length >= 2 ? 1.5 : 0.25;
        if (tags.includes(term)) tagScore += 3;
      }
      score += titleScore + pathScore + contentScore + tagScore;
      if (titleScore > 0) reasons.push(`title+${titleScore.toFixed(2)}`);
      if (pathScore > 0) reasons.push(`path+${pathScore.toFixed(2)}`);
      if (contentScore > 0) reasons.push(`content+${contentScore.toFixed(2)}`);
      if (tagScore > 0) reasons.push(`tags+${tagScore.toFixed(2)}`);
      if (normalizedQuery.length >= 4) {
        if (title.includes(normalizedQuery)) {
          score += 8;
          reasons.push("exact-title-phrase+8.00");
        } else if (content.includes(normalizedQuery)) {
          score += 4;
          reasons.push("exact-content-phrase+4.00");
        }
      }
      const ftsScore = (ftsCandidates.get(chunk.key) ?? 0) * 2;
      score += ftsScore;
      if (ftsScore > 0) reasons.push(`fts+${ftsScore.toFixed(2)}`);
      if (lifecycle?.status === "draft") {
        score *= 0.5;
        reasons.push("draft penalty×0.50");
      }
      if (score <= 0) continue;
      results.push({
        chunk,
        score,
        reason: `${reasons.join("; ")}${lifecycle?.applicability && applicabilityContext ? "; applicability matched" : ""}; score=${score.toFixed(2)}`
      });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
