import type { CandidateEvidence, CandidateEvidenceItem, EvidenceCategory } from "./types.js";

interface TimelineEvent {
  kind: "event";
  event: {
    event: string;
    actorId: string;
    tenantId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
  };
}

interface TimelineCall {
  kind: "mcp-call";
  call: unknown;
}

export type CandidateTimelineItem = TimelineEvent | TimelineCall;

function categoryForType(type: string): EvidenceCategory {
  if (type === "test") return "test";
  if (type === "build") return "build";
  if (type === "package_validation") return "package";
  if (type === "lint") return "lint";
  if (type === "static_analysis") return "static-analysis";
  if (type === "device_test") return "device-test";
  if (type === "git_change") return "git-change";
  return "other";
}

export function collectCandidateEvidence(input: {
  timeline: CandidateTimelineItem[];
  assistantResult: string;
  repositoryId?: string;
}): CandidateEvidence {
  const first = input.timeline.find((item): item is TimelineEvent => item.kind === "event");
  const actorId = first?.event.actorId ?? "";
  const tenantId = first?.event.tenantId ?? "";
  const sessionId = first?.event.sessionId ?? "";
  const actions = { editCount: 0, writeCount: 0, patchCount: 0, meaningfulBashCount: 0 };
  const evidence: CandidateEvidenceItem[] = [];

  for (const item of input.timeline) {
    if (item.kind !== "event" || item.event.event !== "PostToolUse") continue;
    const tool = String(item.event.metadata.tool_name ?? "");
    if (tool === "Edit") actions.editCount += 1;
    if (tool === "Write") actions.writeCount += 1;
    if (tool === "apply_patch") actions.patchCount += 1;

    const raw = item.event.metadata.engineering_evidence;
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, any>;
    const category = categoryForType(String(record.type ?? "tool"));
    if (tool === "Bash" && category !== "other") actions.meaningfulBashCount += 1;
    evidence.push({
      category,
      sourceTool: String(record.sourceTool ?? tool ?? "unknown"),
      ...(typeof record.success === "boolean" ? { success: record.success } : {}),
      ...(typeof record.exitCode === "number" ? { exitCode: record.exitCode } : {}),
      ...(record.counts && typeof record.counts === "object" ? { counts: record.counts } : {}),
      ...(typeof record.status === "string" ? { status: record.status } : {}),
    });
  }

  const text = input.assistantResult.normalize("NFKC");
  const lower = text.toLowerCase();
  const strongTest = evidence.some(
    (item) =>
      item.category === "test" &&
      item.success !== false &&
      ((item.counts?.passed ?? 0) > 0 || (item.exitCode === 0 && item.status !== "failed")),
  );
  const deviceTest = evidence.some((item) => item.category === "device-test" && item.success !== false);
  const buildOrPackage = evidence.some(
    (item) => (item.category === "build" || item.category === "package") && item.success !== false,
  );
  const meaningfulAction =
    actions.editCount + actions.writeCount + actions.patchCount + actions.meaningfulBashCount > 0;

  const rootCause = /root cause|根因|原因是|由于.*导致/i.test(text);
  const verifiedFix = /verified fix|修复完成|已修复|已经修复|fixed|resolved|解决方案/i.test(text);
  const workaround = /workaround|临时方案|绕过/i.test(text);
  const reusableConstraint = /constraint|约束|必须|不得|兼容性/i.test(text);
  const explicitLowValue =
    /format(?:ting)? only|prettier only|lint only|rename only|typo|仅格式化|仅排版|仅重命名|拼写修复/i.test(lower);
  const lowValueOnly = explicitLowValue;
  const analysisOnly = !meaningfulAction && /analysis|分析|只读|read-only|investigat/i.test(lower);

  return {
    sessionId,
    actorId,
    tenantId,
    ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
    assistantResult: input.assistantResult,
    engineeringActions: actions,
    verification: {
      strongTest,
      deviceTest,
      buildOrPackage,
      any: strongTest || deviceTest || buildOrPackage,
    },
    resultSignals: {
      rootCause,
      verifiedFix,
      workaround,
      reusableConstraint,
      lowValueOnly,
      analysisOnly,
    },
    evidence,
  };
}
