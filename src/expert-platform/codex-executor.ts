import type { Claim } from "./task-store.js";
import { buildCodexReadOnlyArgs } from "./codex-runtime.js";
import { runCodexProcess, type CodexProcessOptions } from "./codex-process.js";

export interface CodexExecutorOptions {
  executable: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  runProcess?: (options: CodexProcessOptions) => Promise<string>;
}

export function createCodexExecutor(options: CodexExecutorOptions) {
  const runProcess = options.runProcess ?? runCodexProcess;
  return async (claim: Claim, signal: AbortSignal): Promise<string> => {
    const args = buildCodexReadOnlyArgs(claim.problem);
    return runProcess({
      executable: options.executable,
      args,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      signal,
    });
  };
}
