export const AGENT_OUTCOME_PROTOCOL_MARKER = "TEAM_SKILL_HUB_AGENT_OUTCOME_PROTOCOL=v1";

export type AgentExecutionOutcomeStatus = "succeeded" | "blocked" | "failed";

export type AgentExecutionOutcome = {
  status: AgentExecutionOutcomeStatus;
  reasonCode?: string;
  protocolWarning?: "AGENT_OUTCOME_PROTOCOL_MISSING";
};

export type ParsedAgentExecutionResult = {
  result: string;
  executionOutcome: AgentExecutionOutcome;
};

const OUTCOME_PATTERN = /\n?<TEAM_SKILL_HUB_OUTCOME>(\{[^\n]*\})<\/TEAM_SKILL_HUB_OUTCOME>\s*$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

export function agentOutcomeProtocolInstructions(): string[] {
  return [
    AGENT_OUTCOME_PROTOCOL_MARKER,
    "The provided /workspace is the Team Skill Hub checkout of the routed remote repository for this WorkAttempt; it is not the caller's local workspace.",
    "If the request says not to use the caller's local workspace, continue using the provided /workspace unless the request explicitly forbids the Team Skill Hub checkout.",
    "Your final response must end with exactly one machine-readable outcome line after the human-readable result:",
    '<TEAM_SKILL_HUB_OUTCOME>{"status":"succeeded"}</TEAM_SKILL_HUB_OUTCOME>',
    "Use status=succeeded only when the requested task was actually fulfilled.",
    "If a required permission, input, repository, tool, or environment is unavailable, use status=blocked and include an uppercase reasonCode.",
    "If execution was attempted but failed, use status=failed and include an uppercase reasonCode.",
    "Do not describe an unfulfilled request as succeeded merely because the model process completed normally.",
  ];
}

export function requiresAgentOutcomeProtocol(problem: string): boolean {
  return problem.includes(AGENT_OUTCOME_PROTOCOL_MARKER);
}

export function parseAgentExecutionResult(output: string): ParsedAgentExecutionResult {
  const normalized = output.trim();
  if (!normalized) throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
  const match = OUTCOME_PATTERN.exec(output);
  if (!match) {
    if (output.includes("<TEAM_SKILL_HUB_OUTCOME>") || output.includes("</TEAM_SKILL_HUB_OUTCOME>")) {
      throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
    }
    return {
      result: normalized,
      executionOutcome: {
        status: "succeeded",
        protocolWarning: "AGENT_OUTCOME_PROTOCOL_MISSING",
      },
    };
  }
  const result = output.slice(0, match.index).trim();
  if (!result) throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
  const value = parsed as Record<string, unknown>;
  const status = value.status;
  if (status !== "succeeded" && status !== "blocked" && status !== "failed") {
    throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
  }
  const reasonCode = value.reasonCode;
  if (status === "succeeded") {
    if (reasonCode !== undefined) throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
    return { result, executionOutcome: { status } };
  }
  if (typeof reasonCode !== "string" || !REASON_CODE_PATTERN.test(reasonCode)) {
    throw new Error("AGENT_OUTCOME_PROTOCOL_INVALID");
  }
  return { result, executionOutcome: { status, reasonCode } };
}

export function agentFailureReason(result: string, outcome: AgentExecutionOutcome): string {
  if (outcome.status === "succeeded") throw new Error("INVALID_AGENT_FAILURE_OUTCOME");
  const prefix = outcome.status === "blocked" ? "AGENT_BLOCKED" : "AGENT_FAILED";
  const code = outcome.reasonCode ? ":" + outcome.reasonCode : "";
  return prefix + code + "\n" + result.trim();
}
