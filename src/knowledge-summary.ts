export const KNOWLEDGE_SUMMARY_SCHEMA_VERSION = 1 as const;

export type KnowledgeSummarySection =
  | "problem"
  | "rootCause"
  | "solution"
  | "verification"
  | "applicability"
  | "constraints";

export interface KnowledgeSummary {
  schemaVersion: typeof KNOWLEDGE_SUMMARY_SCHEMA_VERSION;
  title: string;
  problem: string;
  rootCause: string;
  solution: string;
  verification: string;
  applicability: string;
  constraints: string;
  markdown: string;
}

export type KnowledgeSummaryParseResult =
  | { ok: true; summary: KnowledgeSummary }
  | { ok: false; reason: string };

const SECTION_ORDER: KnowledgeSummarySection[] = [
  "problem",
  "rootCause",
  "solution",
  "verification",
  "applicability",
  "constraints"
];

const SECTION_ALIASES: Record<KnowledgeSummarySection, string[]> = {
  problem: ["问题", "problem", "issue"],
  rootCause: ["根因", "原因", "root cause", "root-cause", "cause"],
  solution: ["解决方案", "修复方案", "solution", "fix", "resolution"],
  verification: ["验证结果", "验证", "测试结果", "verification", "validation", "evidence"],
  applicability: ["适用范围", "适用场景", "applicability", "scope"],
  constraints: ["约束/限制", "约束", "限制", "constraints", "limitations", "constraints/limitations"]
};

function normalizeHeading(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[：:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionForHeading(value: string): KnowledgeSummarySection | undefined {
  const normalized = normalizeHeading(value);
  return SECTION_ORDER.find((section) =>
    SECTION_ALIASES[section].some((alias) => normalizeHeading(alias) === normalized)
  );
}

function invalid(reason: string): KnowledgeSummaryParseResult {
  return { ok: false, reason };
}

export function parseKnowledgeSummary(input: unknown): KnowledgeSummaryParseResult {
  if (typeof input !== "string") return invalid("not-text");
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) return invalid("empty");
  if (text.length > 4000) return invalid("too-long");

  let title = "";
  let current: KnowledgeSummarySection | undefined;
  const sections: Partial<Record<KnowledgeSummarySection, string[]>> = {};

  for (const line of text.split("\n")) {
    const titleMatch = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (titleMatch && !title) {
      title = titleMatch[1]!.trim();
      current = undefined;
      continue;
    }
    const sectionMatch = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (sectionMatch) {
      current = sectionForHeading(sectionMatch[1]!);
      if (current && !sections[current]) sections[current] = [];
      continue;
    }
    if (current) sections[current]!.push(line);
  }

  if (!title) return invalid("missing-title");
  const values = {} as Record<KnowledgeSummarySection, string>;
  for (const section of SECTION_ORDER) {
    const value = (sections[section] ?? []).join("\n").trim();
    if (!value) return invalid(`missing-${section}`);
    values[section] = value;
  }

  const markdown = [
    `# ${title.slice(0, 160)}`,
    "",
    "## 问题",
    values.problem,
    "",
    "## 根因",
    values.rootCause,
    "",
    "## 解决方案",
    values.solution,
    "",
    "## 验证结果",
    values.verification,
    "",
    "## 适用范围",
    values.applicability,
    "",
    "## 约束/限制",
    values.constraints
  ].join("\n");

  return {
    ok: true,
    summary: {
      schemaVersion: KNOWLEDGE_SUMMARY_SCHEMA_VERSION,
      title: title.slice(0, 160),
      ...values,
      markdown
    }
  };
}

export function normalizeKnowledgeCandidateSummary(input: string):
  | { ok: true; title: string; content: string }
  | { ok: false; reason: string } {
  const parsed = parseKnowledgeSummary(input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    title: parsed.summary.title,
    content: parsed.summary.markdown
  };
}
