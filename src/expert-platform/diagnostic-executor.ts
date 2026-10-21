import { spawn } from "node:child_process";
import { buildReadOnlySandboxArgs } from "./sandbox.js";

export interface DiagnosticRequest {
  sourcePath: string;
  operation: "node-version";
}

export async function runReadOnlyDiagnostic(request: DiagnosticRequest): Promise<string> {
  if (request.operation !== "node-version") throw new Error("INVALID_DIAGNOSTIC");
  const args = buildReadOnlySandboxArgs({
    image: "node:24-bookworm-slim",
    sourcePath: request.sourcePath,
    command: ["node", "--version"],
  });
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("DIAGNOSTIC_TIMEOUT"));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        child.kill("SIGKILL");
        finish(new Error("DIAGNOSTIC_OUTPUT_LIMIT"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        child.kill("SIGKILL");
        finish(new Error("DIAGNOSTIC_OUTPUT_LIMIT"));
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) finish(new Error("DIAGNOSTIC_FAILED"));
      else finish(undefined, Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}
