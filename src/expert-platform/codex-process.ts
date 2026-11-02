import { spawn } from "node:child_process";
import { parseCodexJsonlResult } from "./codex-runtime.js";
import { JsonlReader } from "./jsonl-reader.js";
import { mapExecutionActivity, StreamResultCollector, type ExecutionActivity } from "./execution-activity.js";

function sanitizedStderrHint(stderr: string): string {
  if (/install: cannot open .* for reading: Permission denied/i.test(stderr))
    return "Codex startup cannot read a mounted file";
  if (/bwrap/i.test(stderr)) return "Codex sandbox initialization failed";
  if (/mount source path|mounting.*permission denied|permission denied.*mount/i.test(stderr))
    return "Docker bind mount permission failure";
  if (/Error loading config file: open .*\.docker\/config\.json: permission denied/i.test(stderr))
    return "Docker CLI cannot read its host config";
  if (/permission denied while trying to connect to the Docker daemon socket/i.test(stderr))
    return "Docker daemon socket permission denied";
  if (/EROFS: read-only file system/i.test(stderr)) return "container filesystem is read-only at a required path";
  if (/\bEACCES\b.*permission denied/i.test(stderr)) return "container path access denied";
  if (/Could not resolve proxy|proxy.*(?:refused|unreachable|timed out)/i.test(stderr))
    return "proxy connection failed";
  if (/unauthorized|authentication required|invalid api key/i.test(stderr)) return "authentication rejected";
  if (/permission denied/i.test(stderr)) return "permission denied";
  if (/network is unreachable|could not resolve host|connection refused/i.test(stderr))
    return "network connection failed";
  return stderr.trim() ? "process wrote stderr; details omitted" : "";
}

function accessTarget(stderr: string): string | undefined {
  if (!/\bEACCES\b|permission denied/i.test(stderr)) return undefined;
  if (/\/run\/expert-mcp\.json/i.test(stderr)) return "MCP_CONFIG";
  if (/\/workspace(?:\/|\b)/i.test(stderr)) return "WORKSPACE";
  if (/\/home\/expert(?:\/|\b)/i.test(stderr)) return "CONTAINER_HOME";
  if (/\/tmp(?:\/|\b)/i.test(stderr)) return "CONTAINER_TMP";
  if (/\.docker\/config\.json/i.test(stderr)) return "DOCKER_CONFIG";
  if (/\/var\/lib\/team-skill-hub-worker/i.test(stderr)) return "WORKER_RUNTIME";
  return "OTHER";
}

function classifyProcessFailure(stderr: string): string {
  if (/bwrap/i.test(stderr) || /No permissions to create a new namespace/i.test(stderr)) return "SANDBOX_INIT_FAILED";
  if (/Could not resolve proxy|proxy.*(?:refused|unreachable|timed out)|ECONNREFUSED.*proxy/i.test(stderr))
    return "PROXY_CONNECTION_FAILED";
  if (/pull access denied|manifest unknown|image not found/i.test(stderr)) return "DOCKER_IMAGE_UNAVAILABLE";
  if (/unauthorized|authentication required|invalid api key/i.test(stderr)) return "AUTHENTICATION_FAILED";
  if (/no space left on device/i.test(stderr)) return "DISK_FULL";
  if (/mount source path|mounting.*permission denied|permission denied.*mount/i.test(stderr))
    return "DOCKER_MOUNT_PERMISSION";
  if (/Error loading config file: open .*\.docker\/config\.json: permission denied/i.test(stderr))
    return "DOCKER_CONFIG_PERMISSION";
  if (/permission denied while trying to connect to the Docker daemon socket/i.test(stderr))
    return "DOCKER_SOCKET_PERMISSION";
  if (/EROFS: read-only file system/i.test(stderr)) return "READ_ONLY_FILESYSTEM";
  if (/\bEACCES\b.*permission denied/i.test(stderr)) return "FILE_ACCESS_DENIED";
  if (/permission denied/i.test(stderr)) return "PERMISSION_DENIED";
  if (
    /network is unreachable|could not resolve host|connection refused|temporary failure in name resolution/i.test(
      stderr,
    )
  )
    return "NETWORK_CONNECTION_FAILED";
  return "PROCESS_EXIT_NONZERO";
}
/** Classify only structured model errors; never log raw stdout or provider messages. */
function classifyJsonlFailure(output: string): string | undefined {
  for (const line of output.split("\n")) {
    if (line.length > 16384 || !line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "error" && event.type !== "turn.failed") continue;
    const failure = event.error;
    const code = failure && typeof failure === "object" ? (failure as Record<string, unknown>).code : undefined;
    if (code === "insufficient_quota") return "MODEL_QUOTA_EXCEEDED";
    const message =
      failure && typeof failure === "object" ? (failure as Record<string, unknown>).message : event.message;
    if (typeof message !== "string") return "MODEL_REQUEST_FAILED";
    if (/401|unauthorized|invalid.api.key|authentication/i.test(message)) return "AUTHENTICATION_FAILED";
    if (/403|access.denied|forbidden/i.test(message)) return "MODEL_ACCESS_DENIED";
    if (/429|rate.limit|quota/i.test(message)) return "MODEL_RATE_LIMITED";
    if (/model.*(not.found|unsupported)|404/i.test(message)) return "MODEL_NOT_FOUND";
    if (/proxy|ECONNREFUSED|ENOTFOUND|TLS|certificate|connection|timeout/i.test(message)) return "MODEL_NETWORK_FAILED";
    return "MODEL_REQUEST_FAILED";
  }
  return undefined;
}

export interface CodexProcessOptions {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onAbort?: () => Promise<void>;
  parseResult?: (output: string) => string;
  env?: NodeJS.ProcessEnv;
  /** Opt-in: consume JSONL incrementally without retaining the complete stdout. */
  streamingBackend?: "claude" | "codex";
  onActivity?: (activity: ExecutionActivity) => void;
}
/** Low-level subprocess transport; caller must enforce container isolation. */
export async function runCodexProcess(options: CodexProcessOptions): Promise<string> {
  const limit = options.maxOutputBytes ?? (options.streamingBackend ? 64 * 1024 * 1024 : 4 * 1024 * 1024);
  if (!options.executable || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || limit <= 0) {
    throw new Error("INVALID_REQUEST");
  }
  if (options.signal?.aborted) throw new Error("CODEX_CANCELLED");
  return new Promise<string>((resolve, reject) => {
    const child = spawn(options.executable, [...options.args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
      detached: process.platform !== "win32",
    });
    let settled = false;
    let terminating = false;
    let output = "";
    let structuredErrorCode: string | undefined;
    const collector = options.streamingBackend ? new StreamResultCollector(options.streamingBackend) : undefined;
    const reader = collector
      ? new JsonlReader((event) => {
          collector.accept(event);
          if (options.streamingBackend === "codex" && !structuredErrorCode)
            structuredErrorCode = classifyJsonlFailure(JSON.stringify(event));
          for (const activity of mapExecutionActivity(options.streamingBackend!, event)) {
            try {
              options.onActivity?.(activity);
            } catch {
              /* Observability cannot disrupt execution. */
            }
          }
        })
      : undefined;
    let bytes = 0;
    let stderrOutput = "";
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
          if (reader) reader.finish();
          resolve(collector ? collector.result() : (options.parseResult ?? parseCodexJsonlResult)(output));
        } catch (parseError) {
          reject(parseError);
        }
      }
    };
    const terminate = (reason: "CODEX_CANCELLED" | "CODEX_TIMEOUT") => {
      if (settled || terminating) return;
      terminating = true;
      void (async () => {
        if (options.onAbort) {
          let timeout: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              options.onAbort(),
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, 5_000);
              }),
            ]);
          } catch {
            /* process-group termination below remains the fallback */
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        }
        kill();
        finish(new Error(reason));
      })();
    };
    const onAbort = () => terminate("CODEX_CANCELLED");
    const timer = setTimeout(() => terminate("CODEX_TIMEOUT"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const onChunk = (chunk: Buffer, record: boolean) => {
      bytes += chunk.length;
      if (bytes > limit) {
        kill();
        finish(new Error("CODEX_OUTPUT_LIMIT"));
        return;
      }
      if (record) {
        if (reader) {
          try {
            reader.push(chunk);
          } catch {
            kill();
            finish(new Error("EXPERT_STREAM_INVALID"));
          }
        } else output += chunk.toString("utf8");
      } else if (stderrOutput.length < 4096)
        stderrOutput += chunk.toString("utf8").slice(0, 4096 - stderrOutput.length);
    };
    child.stdout.on("data", (chunk: Buffer) => onChunk(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => onChunk(chunk, false));
    child.once("error", () => finish(new Error("CODEX_PROCESS_FAILED")));
    child.once("close", (code) => {
      if (terminating) return;
      if (code !== 0) {
        console.error(
          JSON.stringify({
            event: "expert_worker.codex_process_failed",
            exitCode: code,
            errorCode: structuredErrorCode ?? classifyJsonlFailure(output) ?? classifyProcessFailure(stderrOutput),
            stderrHint: sanitizedStderrHint(stderrOutput),
            ...(accessTarget(stderrOutput) ? { accessTarget: accessTarget(stderrOutput) } : {}),
          }),
        );
      }
      finish(code === 0 ? undefined : new Error("CODEX_PROCESS_FAILED"));
    });
  });
}
