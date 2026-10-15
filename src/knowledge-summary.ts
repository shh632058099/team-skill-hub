import { defaultKnowledgeSubmissionSpec, type KnowledgeSectionId, type KnowledgeSubmissionSpec } from "./knowledge-submission-spec.js";

export const KNOWLEDGE_SUMMARY_SCHEMA_VERSION = 1 as const;
export const MAX_KNOWLEDGE_SUMMARY_CHARS = 50_000;
export const MAX_KNOWLEDGE_TITLE_CHARS = 160;

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

const SECTION_ORDER: KnowledgeSummarySection[] = ["problem", "rootCause", "solution", "verification", "applicability", "constraints"];
const SPEC_ID_BY_SECTION: Record<KnowledgeSummarySection, KnowledgeSectionId> = {
  problem: "problem",
  rootCause: "root_cause",
  solution: "solution",
  verification: "verification",
  applicability: "applicability",
  constraints: "constraints"
};
const SECTION_BY_SPEC_ID: Record<KnowledgeSectionId, KnowledgeSummarySection> = {
  problem: "problem",
  root_cause: "rootCause",
  solution: "solution",
  verification: "verification",
  applicability: "applicability",
  constraints: "constraints"
};

const SECTION_ALIASES: Record<KnowledgeSummarySection, string[]> = {
  problem: ["问题", "problem", "issue"],
  rootCause: ["根因", "原因", "root cause", "root-cause", "cause"],
  solution: ["解决方案", "修复方案", "solution", "fix", "resolution"],
  verification: ["验证结果", "验证", "测试结果", "verification", "validation", "evidence"],
  applicability: ["适用范围", "适用场景", "applicability", "scope"],
  constraints: ["约束/限制", "约束", "限制", "constraints", "limitations", "constraints/limitations"]
};

function normalizeHeading(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[：:]/g, "").replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();
}

function sectionForHeading(value: string, spec: KnowledgeSubmissionSpec): KnowledgeSummarySection | undefined {
  const normalized = normalizeHeading(value);
  return SECTION_ORDER.find((section) => {
    const specHeading = spec.sections.find((item) => item.id === SPEC_ID_BY_SECTION[section])?.heading;
    return [specHeading, ...SECTION_ALIASES[section]].filter(Boolean).some((alias) => normalizeHeading(alias!) === normalized);
  });
}

function invalid(reason: string): KnowledgeSummaryParseResult { return { ok: false, reason }; }

export function parseKnowledgeSummary(input: unknown, spec: KnowledgeSubmissionSpec = defaultKnowledgeSubmissionSpec()): KnowledgeSummaryParseResult {
  if (typeof input !== "string") return invalid("not-text");
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) return invalid("empty");
  if (text.length > spec.content.max_chars) return invalid("too-long");

  let title = "";
  let current: KnowledgeSummarySection | undefined;
  const sections: Partial<Record<KnowledgeSummarySection, string[]>> = {};
  for (const line of text.split("\n")) {
    const titleMatch = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (titleMatch && !title) { title = titleMatch[1]!.trim(); current = undefined; continue; }
    const sectionMatch = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (sectionMatch) {
      current = sectionForHeading(sectionMatch[1]!, spec);
      if (current && !sections[current]) sections[current] = [];
      continue;
    }
    if (current) sections[current]!.push(line);
  }
  if (!title) return invalid("missing-title");
  const values = {} as Record<KnowledgeSummarySection, string>;
  for (const section of SECTION_ORDER) {
    const value = (sections[section] ?? []).join("\n").trim();
    const required = spec.sections.find((item) => item.id === SPEC_ID_BY_SECTION[section])?.required ?? true;
    if (required && !value) return invalid(`missing-${section}`);
    values[section] = value;
  }
  const titleValue = title.slice(0, spec.title.max_chars);
  const markdown: string[] = [`# ${titleValue}`];
  for (const sectionSpec of spec.sections) {
    const section = SECTION_BY_SPEC_ID[sectionSpec.id];
    const value = values[section];
    if (!value && !sectionSpec.required) continue;
    markdown.push("", `## ${sectionSpec.heading}`, value);
  }
  return {
    ok: true,
    summary: { schemaVersion: KNOWLEDGE_SUMMARY_SCHEMA_VERSION, title: titleValue, ...values, markdown: markdown.join("\n") }
  };
}

export function normalizeKnowledgeCandidateSummary(input: string, spec: KnowledgeSubmissionSpec = defaultKnowledgeSubmissionSpec()):
  | { ok: true; title: string; content: string }
  | { ok: false; reason: string } {
  const parsed = parseKnowledgeSummary(input, spec);
  if (!parsed.ok) return parsed;
  return { ok: true, title: parsed.summary.title, content: parsed.summary.markdown };
}
