import type { ClientEventRecord, ClientHookEventName } from "./observability.js";

export const CURRENT_HOOK_RUNTIME_VERSION = "1.1.0";
export const CURRENT_HOOK_SCHEMA_VERSION = 1;
export const MIN_SUPPORTED_HOOK_SCHEMA_VERSION = 1;
export const AGENT_ADAPTER_CONTRACT_VERSION = 1;
export const GENERIC_AGENT_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "Stop",
  "SessionEnd"
] as const satisfies readonly ClientHookEventName[];

export interface ClientEventSchemaResolution {
  version: number;
  compatibility: "explicit-current" | "implicit-v1";
}

export function resolveClientEventSchemaVersion(value: unknown): ClientEventSchemaResolution {
  if (value === undefined || value === null) {
    return {
      version: CURRENT_HOOK_SCHEMA_VERSION,
      compatibility: "implicit-v1"
    };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_SUPPORTED_HOOK_SCHEMA_VERSION ||
    value > CURRENT_HOOK_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported client event schema_version ${String(value)}; supported range is ${MIN_SUPPORTED_HOOK_SCHEMA_VERSION}..${CURRENT_HOOK_SCHEMA_VERSION}`
    );
  }
  return {
    version: value,
    compatibility: "explicit-current"
  };
}

export type EngineeringEvidenceType =
  | "test"
  | "build"
  | "lint"
  | "static_analysis"
  | "reproduction"
  | "git_change"
  | "deployment"
  | "device_test"
  | "package_validation"
  | "repository_validation"
  | "tool";

export interface EngineeringEvidence {
  schemaVersion: 1;
  type: EngineeringEvidenceType;
  sourceTool: string;
  success?: boolean;
  exitCode?: number;
  counts?: {
    run?: number;
    passed?: number;
    failed?: number;
  };
  durationMs?: number;
  status?: string;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeEngineeringEvidence(
  toolName: string,
  raw: unknown
): EngineeringEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const run = finiteNumber(record.tests_run);
  const passed = finiteNumber(record.tests_passed);
  const failed = finiteNumber(record.tests_failed);
  const exitCode = finiteNumber(record.exit_code);
  const durationMs = finiteNumber(record.duration_ms);
  const success =
    typeof record.success === "boolean"
      ? record.success
      : exitCode !== undefined
        ? exitCode === 0
        : undefined;
  const status = typeof record.status === "string" ? record.status.slice(0, 80) : undefined;

  let type: EngineeringEvidenceType = "tool";
  if (run !== undefined || passed !== undefined || failed !== undefined) type = "test";
  else if (/test|pytest|ctest/i.test(toolName)) type = "test";
  else if (/build|cmake|make|ninja|bitbake|cargo/i.test(toolName)) type = "build";
  else if (/lint/i.test(toolName)) type = "lint";
  else if (/sonar|static|analy/i.test(toolName)) type = "static_analysis";
  else if (/deploy|release/i.test(toolName)) type = "deployment";
  else if (/device|slt/i.test(toolName)) type = "device_test";
  else if (/git|patch|edit|write/i.test(toolName)) type = "git_change";

  if (
    success === undefined &&
    exitCode === undefined &&
    run === undefined &&
    passed === undefined &&
    failed === undefined &&
    durationMs === undefined &&
    status === undefined
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    type,
    sourceTool: toolName || "unknown",
    ...(success !== undefined ? { success } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(run !== undefined || passed !== undefined || failed !== undefined
      ? {
          counts: {
            ...(run !== undefined ? { run } : {}),
            ...(passed !== undefined ? { passed } : {}),
            ...(failed !== undefined ? { failed } : {})
          }
        }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(status !== undefined ? { status } : {})
  };
}

export const CODEX_HOOK_EVENTS = GENERIC_AGENT_EVENTS;

export interface ClientEventActionContext {
  event: ClientEventRecord;
}

export interface ClientEventAction {
  id: string;
  events: readonly string[];
  run(context: ClientEventActionContext): Promise<void>;
}

export class ClientEventPipeline {
  private readonly actions: ClientEventAction[] = [];

  register(action: ClientEventAction): void {
    if (this.actions.some((item) => item.id === action.id)) {
      throw new Error(`Client event action already registered: ${action.id}`);
    }
    this.actions.push(action);
  }

  listActions(): Array<{ id: string; events: readonly string[] }> {
    return this.actions.map((action) => ({ id: action.id, events: action.events }));
  }

  async process(event: ClientEventRecord): Promise<void> {
    for (const action of this.actions) {
      if (action.events.includes(event.event)) {
        await action.run({ event });
      }
    }
  }
}
