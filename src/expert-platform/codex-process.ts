import { spawn } from "node:child_process";
import { parseCodexJsonlResult } from "./codex-runtime.js";

export interface CodexProcessOptions {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/** Low-level subprocess transport; caller must enforce container isolation. */
export async function runCodexProcess(options: CodexProcessOptions): Promise<string> {
  const limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!options.executable || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || limit <= 0) {
    throw new Error("INVALID_REQUEST");
  }
  if (options.signal?.aborted) throw new Error("CODEX_CANCELLED");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable, [...options.args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let output = "";
    let bytes = 0;
    const kill = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else {
        try {
          resolve(parseCodexJsonlResult(output));
        } catch (parseError) {
          reject(parseError);
        }
      }
    };
    const onAbort = () => {
      kill();
      finish(new Error("CODEX_CANCELLED"));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error("CODEX_TIMEOUT"));
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const onChunk = (chunk: Buffer, record: boolean) => {
      bytes += chunk.length;
      if (bytes > limit) {
        kill();
        finish(new Error("CODEX_OUTPUT_LIMIT"));
        return;
      }
      if (record) output += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => onChunk(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => onChunk(chunk, false));
    child.once("error", () => finish(new Error("CODEX_PROCESS_FAILED")));
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("CODEX_PROCESS_FAILED")));
  });
}
