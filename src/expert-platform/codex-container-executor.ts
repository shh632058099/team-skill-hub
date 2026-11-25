import { buildAgentDockerArgs, type AgentDockerConfig } from "./agent-container-executor.js";

/** @deprecated Shared container argument construction lives in agent-container-executor.ts. */
export interface CodexDockerConfig extends Omit<AgentDockerConfig, "commandArgs"> {
  codexArgs: readonly string[];
}

/** @deprecated Use buildAgentDockerArgs. */
export function buildCodexDockerArgs(config: CodexDockerConfig): string[] {
  const { codexArgs, ...rest } = config;
  return buildAgentDockerArgs({ ...rest, commandArgs: codexArgs });
}
