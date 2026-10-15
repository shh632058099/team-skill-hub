import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const KNOWLEDGE_SUBMISSION_SPEC_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_SECTION_IDS = [
  "problem",
  "root_cause",
  "solution",
  "verification",
  "applicability",
  "constraints"
] as const;
export type KnowledgeSectionId = (typeof KNOWLEDGE_SECTION_IDS)[number];

export interface KnowledgeSubmissionSectionSpec {
  id: KnowledgeSectionId;
  heading: string;
  required: boolean;
  description?: string;
}

export interface KnowledgeSubmissionSpec {
  schema_version: typeof KNOWLEDGE_SUBMISSION_SPEC_SCHEMA_VERSION;
  spec_version: number;
  title: {
    max_chars: number;
    recommended_min_chars: number;
    recommended_max_chars: number;
  };
  content: {
    max_chars: number;
    format: "markdown";
  };
  sections: KnowledgeSubmissionSectionSpec[];
  requirements: {
    durable: boolean;
    verified: boolean;
    reject_speculation: boolean;
    reject_secrets: boolean;
    reject_customer_sensitive_data: boolean;
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function defaultKnowledgeSubmissionSpec(): KnowledgeSubmissionSpec {
  return {
    schema_version: 1,
    spec_version: 1,
    title: {
      max_chars: 160,
      recommended_min_chars: 20,
      recommended_max_chars: 80
    },
    content: {
      max_chars: 50_000,
      format: "markdown"
    },
    sections: [
      { id: "problem", heading: "问题", required: true, description: "描述需要解决的问题或观察到的现象" },
      { id: "root_cause", heading: "根因", required: true, description: "说明已验证的根本原因" },
      { id: "solution", heading: "解决方案", required: true, description: "说明最终有效的处理方案" },
      { id: "verification", heading: "验证结果", required: true, description: "记录测试、日志或其他验证证据" },
      { id: "applicability", heading: "适用范围", required: true },
      { id: "constraints", heading: "约束/限制", required: true }
    ],
    requirements: {
      durable: true,
      verified: true,
      reject_speculation: true,
      reject_secrets: true,
      reject_customer_sensitive_data: true
    }
  };
}

function fail(reason: string): never {
  throw new Error(`Invalid knowledge submission spec: ${reason}`);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) fail(`${name} must be a positive integer`);
  return Number(value);
}

export function validateKnowledgeSubmissionSpec(value: unknown): KnowledgeSubmissionSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("root must be an object");
  const raw = value as Record<string, any>;
  if (raw.schema_version !== KNOWLEDGE_SUBMISSION_SPEC_SCHEMA_VERSION) fail("unsupported schema_version");
  const specVersion = positiveInteger(raw.spec_version, "spec_version");
  if (!raw.title || typeof raw.title !== "object") fail("title is required");
  if (!raw.content || typeof raw.content !== "object") fail("content is required");
  const maxTitle = positiveInteger(raw.title.max_chars, "title.max_chars");
  if (maxTitle > 200) fail("title.max_chars must not exceed 200");
  const recommendedMin = positiveInteger(raw.title.recommended_min_chars, "title.recommended_min_chars");
  const recommendedMax = positiveInteger(raw.title.recommended_max_chars, "title.recommended_max_chars");
  if (recommendedMin > recommendedMax || recommendedMax > maxTitle) fail("title recommendations must fit max_chars");
  const maxContent = positiveInteger(raw.content.max_chars, "content.max_chars");
  if (maxContent > 50_000) fail("content.max_chars must not exceed 50000");
  if (raw.content.format !== "markdown") fail("content.format must be markdown");
  if (!Array.isArray(raw.sections) || raw.sections.length !== KNOWLEDGE_SECTION_IDS.length) fail("sections must contain the supported section ids exactly once");
  const seen = new Set<string>();
  const sections: KnowledgeSubmissionSectionSpec[] = raw.sections.map((section: any) => {
    if (!section || typeof section !== "object") fail("section must be an object");
    if (!KNOWLEDGE_SECTION_IDS.includes(section.id)) fail(`unsupported section id ${String(section.id)}`);
    if (seen.has(section.id)) fail(`duplicate section id ${section.id}`);
    seen.add(section.id);
    if (typeof section.heading !== "string" || !section.heading.trim()) fail(`section ${section.id} requires heading`);
    if (typeof section.required !== "boolean") fail(`section ${section.id} requires boolean required`);
    if (section.description !== undefined && typeof section.description !== "string") fail(`section ${section.id} description must be text`);
    return {
      id: section.id,
      heading: section.heading.trim(),
      required: section.required,
      ...(section.description?.trim() ? { description: section.description.trim() } : {})
    };
  });
  for (const id of KNOWLEDGE_SECTION_IDS) if (!seen.has(id)) fail(`missing section id ${id}`);
  if (!raw.requirements || typeof raw.requirements !== "object") fail("requirements are required");
  const requirementNames = ["durable", "verified", "reject_speculation", "reject_secrets", "reject_customer_sensitive_data"] as const;
  const requirements = {} as KnowledgeSubmissionSpec["requirements"];
  for (const name of requirementNames) {
    if (typeof raw.requirements[name] !== "boolean") fail(`requirements.${name} must be boolean`);
    requirements[name] = raw.requirements[name];
  }
  return {
    schema_version: 1,
    spec_version: specVersion,
    title: {
      max_chars: maxTitle,
      recommended_min_chars: recommendedMin,
      recommended_max_chars: recommendedMax
    },
    content: { max_chars: maxContent, format: "markdown" },
    sections,
    requirements
  };
}

export class KnowledgeSubmissionSpecStore {
  private readonly root: string;
  private readonly historyDir: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "config", "knowledge-submission-spec");
    this.historyDir = path.join(this.root, "history");
  }

  private currentFile(): string { return path.join(this.root, "current.json"); }
  private historyFile(version: number): string { return path.join(this.historyDir, `v${version}.json`); }

  private async atomicWrite(file: string, value: KnowledgeSubmissionSpec): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async readSpec(file: string): Promise<KnowledgeSubmissionSpec> {
    return validateKnowledgeSubmissionSpec(JSON.parse(await readFile(file, "utf8")));
  }

  async loadCurrent(): Promise<KnowledgeSubmissionSpec> {
    try {
      return clone(await this.readSpec(this.currentFile()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultKnowledgeSubmissionSpec();
      throw error;
    }
  }

  private async ensureVersionPersisted(spec: KnowledgeSubmissionSpec): Promise<void> {
    const file = this.historyFile(spec.spec_version);
    try {
      const existing = await this.readSpec(file);
      if (JSON.stringify(existing) !== JSON.stringify(spec)) {
        throw new Error(`immutable history version v${spec.spec_version} already exists with different content`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.atomicWrite(file, spec);
    }
  }

  private async writeHistoryImmutable(spec: KnowledgeSubmissionSpec): Promise<void> {
    const file = this.historyFile(spec.spec_version);
    try {
      const existing = await this.readSpec(file);
      if (JSON.stringify(existing) !== JSON.stringify(spec)) {
        throw new Error(`immutable history version v${spec.spec_version} already exists with different content`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.atomicWrite(file, spec);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async saveNext(input: KnowledgeSubmissionSpec): Promise<KnowledgeSubmissionSpec> {
    return await this.enqueue(async () => {
      const current = await this.loadCurrent();
      await this.ensureVersionPersisted(current);
      const validated = validateKnowledgeSubmissionSpec({ ...clone(input), schema_version: 1, spec_version: current.spec_version + 1 });
      await this.writeHistoryImmutable(validated);
      await this.atomicWrite(this.currentFile(), validated);
      return clone(validated);
    });
  }

  async history(): Promise<KnowledgeSubmissionSpec[]> {
    const current = await this.loadCurrent();
    await mkdir(this.historyDir, { recursive: true });
    let names: string[] = [];
    try { names = await readdir(this.historyDir); } catch { names = []; }
    const byVersion = new Map<number, KnowledgeSubmissionSpec>();
    for (const name of names) {
      const match = /^v(\d+)\.json$/.exec(name);
      if (!match) continue;
      const spec = await this.readSpec(path.join(this.historyDir, name));
      byVersion.set(spec.spec_version, spec);
    }
    byVersion.set(current.spec_version, current);
    if (!byVersion.has(1)) byVersion.set(1, defaultKnowledgeSubmissionSpec());
    return [...byVersion.values()].sort((a, b) => b.spec_version - a.spec_version).map(clone);
  }

  async rollbackTo(version: number): Promise<KnowledgeSubmissionSpec> {
    return await this.enqueue(async () => {
      const current = await this.loadCurrent();
      await this.ensureVersionPersisted(current);
      let source: KnowledgeSubmissionSpec;
      if (version === 1) source = defaultKnowledgeSubmissionSpec();
      else source = await this.readSpec(this.historyFile(version));
      const next = validateKnowledgeSubmissionSpec({ ...clone(source), spec_version: current.spec_version + 1 });
      await this.writeHistoryImmutable(next);
      await this.atomicWrite(this.currentFile(), next);
      return clone(next);
    });
  }
}
