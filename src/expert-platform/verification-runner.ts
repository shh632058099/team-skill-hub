import { spawn } from "node:child_process";
import path from "node:path";
import type { VerificationPolicyStep, VerificationRunResult } from "./verification-policy.js";

function runStep(
  workspacePath: string,
  step: VerificationPolicyStep,
  signal: AbortSignal,
): Promise<VerificationRunResult> {
  if (signal.aborted) return Promise.reject(new Error("VERIFICATION_CANCELLED"));
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    const child = spawn(step.argv[0]!, step.argv.slice(1), {
      cwd: workspacePath,
      shell: false,
      stdio: "ignore",
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
    });

    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (value: VerificationRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new Error("VERIFICATION_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
    }, step.timeoutMs);

    child.once("error", () => {
      finish({
        stepId: step.id,
        type: step.type,
        evidenceType: step.evidenceType,
        status: "failed",
        exitCode: null,
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCode: "VERIFICATION_PROCESS_FAILED",
      });
    });
    child.once("close", (code) => {
      finish({
        stepId: step.id,
        type: step.type,
        evidenceType: step.evidenceType,
        status: code === 0 && !timedOut ? "passed" : "failed",
        exitCode: typeof code === "number" ? code : null,
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCode: timedOut ? "VERIFICATION_TIMEOUT" : code === 0 ? null : "VERIFICATION_EXIT_NONZERO",
      });
    });
  });
}

export async function runVerificationPolicy(
  workspacePath: string,
  policy: readonly VerificationPolicyStep[],
  signal: AbortSignal,
): Promise<VerificationRunResult[]> {
  if (!path.isAbsolute(workspacePath) || workspacePath === path.parse(workspacePath).root) {
    throw new Error("INVALID_VERIFICATION_WORKSPACE");
  }
  if (signal.aborted) throw new Error("VERIFICATION_CANCELLED");
  const results: VerificationRunResult[] = [];
  for (const step of policy) results.push(await runStep(workspacePath, step, signal));
  return results;
}
