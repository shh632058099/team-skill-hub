import { normalizeKnowledgeCandidateSummary } from "./knowledge-summary.js";
import type { KnowledgeSectionId, KnowledgeSubmissionSpec } from "./knowledge-submission-spec.js";
import { KnowledgeSubmissionSpecStore } from "./knowledge-submission-spec.js";

export type KnowledgeContentMode = "structured" | "verbatim";

export interface KnowledgeSubmissionSpecView {
  spec_version: number;
  schema_version: number;
  rules: KnowledgeSubmissionSpec;
  template: string;
  instruction: string;
}

export interface KnowledgeSubmissionDraft {
  title: string;
  problem: string;
  rootCause: string;
  solution: string;
  verification: string;
  applicability: string;
  constraints: string;
}

export interface NormalizedKnowledgeSubmission {
  title: string;
  content: string;
  contentMode: KnowledgeContentMode;
  submittedSpecVersion?: number;
  appliedSpecVersion: number;
  schemaVersion: number;
}

export class KnowledgeSpecOutdatedError extends Error {
  readonly code = "KNOWLEDGE_SPEC_OUTDATED" as const;
  constructor(
    readonly submittedSpecVersion: number,
    readonly currentSpecVersion: number,
    readonly reason: string,
  ) {
    super(
      `KNOWLEDGE_SPEC_OUTDATED: submitted spec v${submittedSpecVersion} no longer satisfies current spec v${currentSpecVersion} (${reason}). Call get_knowledge_submission_spec and retry.`,
    );
    this.name = "KnowledgeSpecOutdatedError";
  }
}

const DRAFT_FIELD_BY_ID: Record<KnowledgeSectionId, keyof KnowledgeSubmissionDraft> = {
  problem: "problem",
  root_cause: "rootCause",
  solution: "solution",
  verification: "verification",
  applicability: "applicability",
  constraints: "constraints",
};
const PLACEHOLDERS = new Set(["unknown", "n/a", "na", "none", "tbd", "todo", "未知", "不详", "待确认"]);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().normalize("NFKC").toLowerCase());
}

export class KnowledgeSubmissionService {
  constructor(private readonly store: KnowledgeSubmissionSpecStore) {}

  async currentSpec(): Promise<KnowledgeSubmissionSpecView> {
    const spec = await this.store.loadCurrent();
    return {
      spec_version: spec.spec_version,
      schema_version: spec.schema_version,
      rules: spec,
      template: this.template(spec),
      instruction: `Create durable, verified team Knowledge using this specification. content_mode defaults to structured: use the template and satisfy every required section. Use content_mode=verbatim when the user explicitly asks to preserve the original Markdown/file content without structural rewriting. Verbatim content is still subject to platform safety redaction. Submit with spec_version=${spec.spec_version}. Never include secrets, credentials, customer-sensitive data, or unverified speculation.`,
    };
  }

  private template(spec: KnowledgeSubmissionSpec): string {
    const lines = ["# Title"];
    for (const section of spec.sections) {
      lines.push("", `## ${section.heading}`, section.description ? `<${section.description}>` : "<content>");
    }
    return lines.join("\n");
  }

  async normalize(input: {
    title: string;
    content: string;
    submittedSpecVersion?: number;
    contentMode?: KnowledgeContentMode;
  }): Promise<NormalizedKnowledgeSubmission> {
    const spec = await this.store.loadCurrent();
    const submitted = input.submittedSpecVersion;
    if (submitted !== undefined && (!Number.isInteger(submitted) || submitted < 1 || submitted > spec.spec_version)) {
      throw new Error(`Unknown knowledge submission spec version: ${String(submitted)}`);
    }
    const contentMode = input.contentMode ?? "structured";
    if (contentMode === "verbatim") {
      const title = input.title.trim();
      const reason =
        !title || isPlaceholder(title)
          ? "missing-title"
          : input.content.length > spec.content.max_chars
            ? "too-long"
            : !input.content.trim()
              ? "empty"
              : undefined;
      if (reason) {
        if (submitted !== undefined && submitted < spec.spec_version) {
          throw new KnowledgeSpecOutdatedError(submitted, spec.spec_version, reason);
        }
        throw new Error(`Knowledge candidate content does not satisfy current submission spec: ${reason}`);
      }
      return {
        title: title.slice(0, spec.title.max_chars),
        content: input.content,
        contentMode,
        ...(submitted !== undefined ? { submittedSpecVersion: submitted } : {}),
        appliedSpecVersion: spec.spec_version,
        schemaVersion: spec.schema_version,
      };
    }
    const normalized = normalizeKnowledgeCandidateSummary(input.content, spec);
    if (!normalized.ok) {
      if (submitted !== undefined && submitted < spec.spec_version) {
        throw new KnowledgeSpecOutdatedError(submitted, spec.spec_version, normalized.reason);
      }
      throw new Error(`Knowledge candidate content does not satisfy current submission spec: ${normalized.reason}`);
    }
    return {
      title: normalized.title,
      content: normalized.content,
      contentMode,
      ...(submitted !== undefined ? { submittedSpecVersion: submitted } : {}),
      appliedSpecVersion: spec.spec_version,
      schemaVersion: spec.schema_version,
    };
  }

  async buildFromStructuredDraft(draft: KnowledgeSubmissionDraft): Promise<NormalizedKnowledgeSubmission> {
    const spec = await this.store.loadCurrent();
    if (!draft.title.trim() || isPlaceholder(draft.title)) throw new Error("missing-required-knowledge-field: title");
    const lines = [`# ${draft.title.trim()}`];
    for (const section of spec.sections) {
      const field = DRAFT_FIELD_BY_ID[section.id];
      const value = String(draft[field] ?? "").trim();
      if (section.required && (!value || isPlaceholder(value)))
        throw new Error(`missing-required-knowledge-field: ${section.id}`);
      if (!value) continue;
      lines.push("", `## ${section.heading}`, value);
    }
    return await this.normalize({ title: draft.title, content: lines.join("\n") });
  }
}
