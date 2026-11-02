import { spawn } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

export type GitCredentialConfig =
  { type: "ssh-key"; path: string } | { type: "https-token"; tokenEnv: string; username?: string };

export interface PrepareRepositoryInput {
  id: string;
  url: string;
  branch: string;
  root: string;
  credentialRef?: string;
  gitProxyUrl?: string;
  credentials?: Readonly<Record<string, GitCredentialConfig>>;
  runGit?: (args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv) => Promise<void>;
}

function runGit(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`GIT_OPERATION_FAILED:${code}:${stderr.trim().slice(-800)}`));
    });
  });
}

function sshCommand(keyPath: string): string {
  const escaped = keyPath.replace(/'/g, "'\\''");
  return `ssh -i '${escaped}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
}

/** Make a private Worker checkout group-readable by the execution container.
 * Non-root Workers keep their own primary group; root Workers retain the image GID 10001 fallback.
 * Never follow symlinks outside the checkout.
 */
export function grantExecutionContainerReadAccess(
  root: string,
  containerGid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 10001,
): void {
  const visit = (file: string): void => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory() && !stat.isFile()) return;
    if (stat.gid !== containerGid) {
      try {
        chownSync(file, stat.uid, containerGid);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EPERM")
          throw new Error("WORKER_CHECKOUT_GROUP_NOT_CONFIGURED");
        throw error;
      }
    }
    const ownerBits = (stat.mode >> 6) & 0o7;
    const groupBits = stat.isDirectory() ? ownerBits & 0o5 : ownerBits & 0o4;
    chmodSync(file, (stat.mode & 0o707) | (groupBits << 3));
    if (stat.isDirectory()) for (const entry of readdirSync(file)) visit(path.join(file, entry));
  };
  visit(root);
}

export async function prepareRepositoryWorkspace(
  input: PrepareRepositoryInput,
): Promise<{ path: string; commitSha: string }> {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.id) ||
    !input.url ||
    !input.branch ||
    !path.isAbsolute(input.root) ||
    input.root === "/"
  ) {
    throw new Error("INVALID_SOURCE_REPOSITORY");
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: input.gitProxyUrl ? "2" : "1",
    GIT_CONFIG_KEY_0: "http.version",
    GIT_CONFIG_VALUE_0: "HTTP/1.1",
    ...(input.gitProxyUrl ? { GIT_CONFIG_KEY_1: "http.proxy", GIT_CONFIG_VALUE_1: input.gitProxyUrl } : {}),
  };
  if (input.gitProxyUrl) {
    let proxy: URL;
    try {
      proxy = new URL(input.gitProxyUrl);
    } catch {
      throw new Error("INVALID_GIT_PROXY_URL");
    }
    if (
      !["http:", "https:"].includes(proxy.protocol) ||
      !proxy.hostname ||
      proxy.username ||
      proxy.password ||
      proxy.search ||
      proxy.hash ||
      /[\r\n\0]/.test(input.gitProxyUrl)
    ) {
      throw new Error("INVALID_GIT_PROXY_URL");
    }
  }
  let credentialTempDir: string | undefined;
  try {
    if (input.credentialRef) {
      const credential = input.credentials?.[input.credentialRef];
      if (!credential) throw new Error("SOURCE_REPOSITORY_CREDENTIAL_NOT_CONFIGURED");
      if (credential.type === "ssh-key") {
        if (!path.isAbsolute(credential.path) || credential.path === "/" || !existsSync(credential.path)) {
          throw new Error("SOURCE_REPOSITORY_CREDENTIAL_NOT_CONFIGURED");
        }
        if (!input.url.startsWith("git@")) throw new Error("SOURCE_REPOSITORY_CREDENTIAL_TYPE_MISMATCH");
        env.GIT_SSH_COMMAND = sshCommand(credential.path);
      } else {
        if (!input.url.startsWith("https://") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.tokenEnv)) {
          throw new Error("SOURCE_REPOSITORY_CREDENTIAL_TYPE_MISMATCH");
        }
        const token = process.env[credential.tokenEnv];
        if (!token) throw new Error("SOURCE_REPOSITORY_CREDENTIAL_NOT_CONFIGURED");
        credentialTempDir = mkdtempSync(path.join(os.tmpdir(), "expert-git-askpass-"));
        const askpass = path.join(credentialTempDir, "askpass.sh");
        writeFileSync(
          askpass,
          '#!/bin/sh\ncase "$1" in *sername*) printf \'%s\\n\' "${EXPERT_GIT_HTTP_USERNAME:-x-access-token}" ;; *) printf \'%s\\n\' "$EXPERT_GIT_HTTP_TOKEN" ;; esac\n',
          { mode: 0o700 },
        );
        chmodSync(askpass, 0o700);
        env.GIT_ASKPASS = askpass;
        env.EXPERT_GIT_HTTP_TOKEN = token;
        env.EXPERT_GIT_HTTP_USERNAME = credential.username || "x-access-token";
      }
    }
    const run = input.runGit ?? runGit;
    mkdirSync(input.root, { recursive: true });
    const destination = path.join(input.root, input.id);
    if (!existsSync(path.join(destination, ".git"))) {
      if (existsSync(destination)) throw new Error("SOURCE_REPOSITORY_PATH_NOT_EMPTY");
      await run(
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--branch",
          input.branch,
          "--no-checkout",
          "--",
          input.url,
          destination,
        ],
        undefined,
        env,
      );
    } else {
      const remote = await new Promise<string>((resolve, reject) => {
        const child = spawn("git", ["-C", destination, "remote", "get-url", "origin"], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve(output.trim()) : reject(new Error("SOURCE_REPOSITORY_REMOTE_UNAVAILABLE")),
        );
      });
      if (remote !== input.url) throw new Error("SOURCE_REPOSITORY_REMOTE_MISMATCH");
    }
    await run(["-C", destination, "fetch", "--depth", "1", "--prune", "origin", input.branch], undefined, env);
    await run(["-C", destination, "checkout", "-B", input.branch, "FETCH_HEAD"], undefined, env);
    await run(["-C", destination, "reset", "--hard", "FETCH_HEAD"], undefined, env);
    await run(["-C", destination, "clean", "-fdx"], undefined, env);
    const origin = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["-C", destination, "rev-parse", "HEAD"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve(output.trim()) : reject(new Error("SOURCE_REPOSITORY_COMMIT_UNAVAILABLE")),
      );
    });
    if (!/^[a-f0-9]{40,64}$/i.test(origin)) throw new Error("SOURCE_REPOSITORY_COMMIT_UNAVAILABLE");
    grantExecutionContainerReadAccess(destination);
    return { path: destination, commitSha: origin };
  } finally {
    if (credentialTempDir) rmSync(credentialTempDir, { recursive: true, force: true });
    delete env.EXPERT_GIT_HTTP_TOKEN;
  }
}

export function loadGitCredentialConfigs(raw: string | undefined): Record<string, GitCredentialConfig> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_EXPERT_GIT_CREDENTIALS_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("INVALID_EXPERT_GIT_CREDENTIALS_JSON");
  const output: Record<string, GitCredentialConfig> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new Error("INVALID_EXPERT_GIT_CREDENTIALS_JSON");
    if (typeof value === "string") {
      if (!path.isAbsolute(value) || value === "/") throw new Error("INVALID_EXPERT_GIT_CREDENTIALS_JSON");
      output[name] = { type: "ssh-key", path: value };
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("INVALID_EXPERT_GIT_CREDENTIALS_JSON");
    const item = value as Record<string, unknown>;
    if (item.type === "ssh-key" && typeof item.path === "string" && path.isAbsolute(item.path) && item.path !== "/") {
      output[name] = { type: "ssh-key", path: item.path };
    } else if (
      item.type === "https-token" &&
      typeof item.tokenEnv === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.tokenEnv) &&
      (item.username === undefined ||
        (typeof item.username === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(item.username)))
    ) {
      output[name] = {
        type: "https-token",
        tokenEnv: item.tokenEnv,
        ...(typeof item.username === "string" ? { username: item.username } : {}),
      };
    } else {
      throw new Error("INVALID_EXPERT_GIT_CREDENTIALS_JSON");
    }
  }
  return output;
}
