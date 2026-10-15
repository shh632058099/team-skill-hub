import { execFile, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import type { SkillBundleImportType, SkillBundleInputFile } from "./skill-bundles.js";

const execFileAsync = promisify(execFile);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_GIT_TEMP_BYTES = 64 * 1024 * 1024;

function normalizeSourceRoot(value?: string): string {
  const raw = (value ?? "").trim().replace(/\/$/, "");
  if (!raw) return "";
  if (raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error("source_root is invalid");
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("source_root is invalid");
  return parts.join("/");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`file exceeds size limit: ${label}`);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`file must be UTF-8 text: ${label}`); }
  if (content.includes("\0")) throw new Error(`file must be UTF-8 text: ${label}`);
  return content;
}

function sourceFileFromBytes(bytes: Uint8Array, label: string, mode: "0644" | "0755"): SkillBundleInputFile {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`file exceeds size limit: ${label}`);
  if (label === "SKILL.md" || label.endsWith("/SKILL.md")) return { path: label, content: decodeUtf8(bytes, label), mode };
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!content.includes("\0")) return { path: label, content, mode };
  } catch {}
  return { path: label, contentBase64: Buffer.from(bytes).toString("base64"), mode };
}

async function readZipEntryLimited(entry: JSZip.JSZipObject, label: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = entry.nodeStream("nodebuffer") as any;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (typeof stream.pause === "function") stream.pause();
      if (typeof stream.destroy === "function") stream.destroy();
      reject(error);
    };
    stream.on("data", (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_FILE_BYTES) {
        fail(new Error(`file exceeds size limit: ${label}`));
        return;
      }
      chunks.push(bytes);
    });
    stream.on("error", (error: Error) => fail(error));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}

function assertFileSetLimits(files: SkillBundleInputFile[]): SkillBundleInputFile[] {
  if (files.length === 0) throw new Error("import source contains no files");
  if (files.length > MAX_FILES) throw new Error("bundle file count exceeds limit");
  const bytes = files.reduce((sum, file) => sum + (file.content !== undefined ? Buffer.byteLength(file.content, "utf8") : Buffer.from(file.contentBase64 ?? "", "base64").byteLength), 0);
  if (bytes > MAX_TOTAL_BYTES) throw new Error("bundle total size exceeds limit");
  return files;
}

function skillRoots(files: SkillBundleInputFile[]): string[] {
  return files
    .filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => file.path === "SKILL.md" ? "" : file.path.slice(0, -"/SKILL.md".length))
    .sort();
}

function commonParent(roots: string[]): string {
  if (!roots.length) return "";
  const parents = roots.map((root) => root.split("/").slice(0, -1));
  const first = parents[0] ?? [];
  let length = first.length;
  for (const parts of parents.slice(1)) {
    length = Math.min(length, parts.length);
    let index = 0;
    while (index < length && parts[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length).join("/");
}

export function selectSkillBundleFiles(files: SkillBundleInputFile[], importType: SkillBundleImportType): SkillBundleInputFile[] {
  const roots = skillRoots(files);
  if (!roots.length) return files;
  if (importType === "skill") {
    if (roots.includes("")) {
      if (roots.length !== 1) throw new Error("source_root is required because multiple Skill roots are present");
      return files;
    }
    if (roots.length !== 1) throw new Error("source_root is required because multiple Skill roots are present");
    const prefix = roots[0]! + "/";
    return files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  if (roots.includes("")) return files;
  const prefixes = roots.map((root) => root + "/");
  const packagingRoot = commonParent(roots);
  const stripPrefix = packagingRoot ? packagingRoot + "/" : "";
  return files
    .filter((file) => prefixes.some((prefix) => file.path.startsWith(prefix)))
    .map((file) => ({ ...file, path: stripPrefix && file.path.startsWith(stripPrefix) ? file.path.slice(stripPrefix.length) : file.path }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeRevision(value?: string): string | undefined {
  const revision = value?.trim();
  if (!revision) return undefined;
  if (revision.startsWith("-") || revision.includes("..") || revision.includes("@{") || revision.includes("\\") || !/^[A-Za-z0-9._/-]{1,200}$/.test(revision)) {
    throw new Error("Git revision is invalid");
  }
  return revision;
}

async function directoryBytes(root: string, maxBytes = MAX_GIT_TEMP_BYTES): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) continue;
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) total += info.size;
      if (total > maxBytes) throw new Error("Git import temporary disk usage exceeds limit");
    }
  }
  await walk(root);
  return total;
}

export async function readSkillBundleTextFile(fullPath: string, label: string, mode = 0o644): Promise<SkillBundleInputFile> {
  const info = await lstat(fullPath);
  if (!info.isFile()) throw new Error(`Git source special file is not allowed: ${label}`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds size limit: ${label}`);
  const bytes = await readFile(fullPath);
  const normalizedLabel = label.replaceAll("\\", "/");
  return sourceFileFromBytes(bytes, normalizedLabel, (mode & 0o111) !== 0 ? "0755" : "0644");
}

export async function runGitCommandWithDirectoryQuota(input: {
  executable?: string;
  args: string[];
  cwd: string;
  monitorRoot: string;
  timeoutMs: number;
  maxBytes?: number;
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(input.executable ?? "git", input.args, {
      cwd: input.cwd,
      windowsHide: true,
      detached: useProcessGroup,
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const outputLimit = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let checking = false;
    let quotaError: Error | undefined;

    const append = (current: string, chunk: Buffer | string) => {
      if (current.length >= outputLimit) return current;
      return (current + chunk.toString()).slice(0, outputLimit);
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });

    const stop = () => {
      clearInterval(monitor);
      clearTimeout(timeout);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    };
    const kill = (error: Error) => {
      if (settled || quotaError) return;
      quotaError = error;
      if (useProcessGroup && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      } else {
        child.kill("SIGKILL");
      }
    };
    const monitor = setInterval(async () => {
      if (settled || checking) return;
      checking = true;
      try {
        await directoryBytes(input.monitorRoot, input.maxBytes ?? MAX_GIT_TEMP_BYTES);
      } catch (error) {
        kill(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    }, Math.max(10, input.pollIntervalMs ?? 100));
    const timeout = setTimeout(() => kill(new Error("Git import command timed out")), input.timeoutMs);

    child.once("error", (error) => finishError(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      stop();
      if (quotaError) {
        reject(quotaError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`Git command failed (${code ?? signal ?? "unknown"}): ${stderr.trim()}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function extractSkillBundleZip(zipBase64: string, sourceRoot?: string): Promise<SkillBundleInputFile[]> {
  const archive = Buffer.from(zipBase64, "base64");
  if (!archive.length || archive.length > MAX_TOTAL_BYTES * 2) throw new Error("ZIP payload is empty or too large");
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false });
  const root = normalizeSourceRoot(sourceRoot);
  const prefix = root ? root + "/" : "";
  const files: SkillBundleInputFile[] = [];
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normalized = entryPath.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.some((part) => part === ".." || part === "." || !part)) {
      throw new Error(`unsafe ZIP path: ${entryPath}`);
    }
    if (prefix && !normalized.startsWith(prefix)) continue;
    const relative = prefix ? normalized.slice(prefix.length) : normalized;
    if (!relative) continue;
    const unixPermissions = typeof entry.unixPermissions === "string"
      ? Number.parseInt(entry.unixPermissions, 8)
      : entry.unixPermissions;
    if (typeof unixPermissions === "number") {
      const fileType = unixPermissions & 0o170000;
      if (fileType && fileType !== 0o100000) throw new Error(`ZIP special file or symlink is not allowed: ${entryPath}`);
    }
    const bytes = await readZipEntryLimited(entry, relative);
    const executable = typeof unixPermissions === "number" && (unixPermissions & 0o111) !== 0;
    files.push(sourceFileFromBytes(bytes, relative, executable ? "0755" : "0644"));
  }
  return assertFileSetLimits(files.sort((a, b) => a.path.localeCompare(b.path)));
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function privateIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0]!;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    if (isIP(mapped) === 4) return privateIpv4(mapped);
    return true;
  }
  return value === "::" || value === "::1" || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff");
}

export function buildSkillBundleGitCurlResolve(url: URL, addresses: string[]): string {
  const port = url.port || "443";
  const formattedAddresses = addresses.map((address) => isIP(address) === 6 ? `[${address}]` : address);
  return `${url.hostname}:${port}:${formattedAddresses.join(",")}`;
}

export function buildSkillBundleGitEnvironment(base: NodeJS.ProcessEnv, host: string): NodeJS.ProcessEnv {
  const noProxy = [base.NO_PROXY, base.no_proxy, host]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const mergedNoProxy = [...new Set(noProxy)].join(",");
  return {
    ...base,
    NO_PROXY: mergedNoProxy,
    no_proxy: mergedNoProxy,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1"
  };
}

export async function validateSkillBundleGitUrl(
  value: string,
  allowedHosts: string[],
  resolveAddresses: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((item) => item.address)
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Git URL is invalid"); }
  if (url.protocol !== "https:") throw new Error("Git URL must use https");
  if (url.username || url.password) throw new Error("Git URL must not contain credentials");
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.map((item) => item.toLowerCase()).includes(host)) throw new Error(`Git host is not allowed: ${host}`);
  const addresses = await resolveAddresses(host);
  if (!addresses.length) throw new Error("Git host did not resolve");
  for (const address of addresses) {
    const version = isIP(address);
    if (!version || (version === 4 ? privateIpv4(address) : privateIpv6(address))) {
      throw new Error(`Git host resolves to private, loopback, link-local, or invalid address: ${address}`);
    }
  }
  return { url, addresses: [...new Set(addresses)] };
}

async function scanTextFiles(root: string): Promise<SkillBundleInputFile[]> {
  const files: SkillBundleInputFile[] = [];
  async function walk(dir: string, relative = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`Git source symlink is not allowed: ${rel}`);
      if (info.isDirectory()) { await walk(full, rel); continue; }
      if (!info.isFile()) throw new Error(`Git source special file is not allowed: ${rel}`);
      if (files.length >= MAX_FILES) throw new Error("bundle file count exceeds limit");
      files.push(await readSkillBundleTextFile(full, rel, info.mode));
    }
  }
  await walk(root);
  return assertFileSetLimits(files.sort((a, b) => a.path.localeCompare(b.path)));
}

export async function importSkillBundleGit(input: {
  repositoryUrl: string;
  revision?: string;
  sourceRoot?: string;
  allowedHosts: string[];
  timeoutMs?: number;
}): Promise<{ files: SkillBundleInputFile[]; resolvedRevision: string }> {
  const { url, addresses } = await validateSkillBundleGitUrl(input.repositoryUrl, input.allowedHosts);
  const sourceRoot = normalizeSourceRoot(input.sourceRoot);
  const revision = normalizeRevision(input.revision);
  const temp = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-git-"));
  const checkout = path.join(temp, "repo");
  const gitEnv = buildSkillBundleGitEnvironment(process.env, url.hostname);
  const run = async (args: string[]) => await runGitCommandWithDirectoryQuota({
    args,
    cwd: temp,
    monitorRoot: temp,
    timeoutMs: input.timeoutMs ?? 60_000,
    maxBytes: MAX_GIT_TEMP_BYTES,
    env: gitEnv
  });
  const networkArgs = [
    "-c", "protocol.file.allow=never",
    "-c", "http.followRedirects=false",
    "-c", `http.curloptResolve=${buildSkillBundleGitCurlResolve(url, addresses)}`
  ];
  try {
    await run([...networkArgs, "clone", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--no-checkout", url.href, checkout]);
    await directoryBytes(checkout);
    if (revision) {
      await runGitCommandWithDirectoryQuota({
        args: [...networkArgs, "fetch", "--depth", "1", "origin", revision],
        cwd: checkout,
        monitorRoot: temp,
        timeoutMs: input.timeoutMs ?? 60_000,
        maxBytes: MAX_GIT_TEMP_BYTES,
        env: gitEnv
      });
      await runGitCommandWithDirectoryQuota({
        args: ["checkout", "--detach", "FETCH_HEAD"],
        cwd: checkout,
        monitorRoot: temp,
        timeoutMs: input.timeoutMs ?? 60_000,
        maxBytes: MAX_GIT_TEMP_BYTES,
        env: gitEnv
      });
    } else {
      await runGitCommandWithDirectoryQuota({
        args: ["checkout", "--detach", "HEAD"],
        cwd: checkout,
        monitorRoot: temp,
        timeoutMs: input.timeoutMs ?? 60_000,
        maxBytes: MAX_GIT_TEMP_BYTES,
        env: gitEnv
      });
    }
    await directoryBytes(checkout);
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: checkout, timeout: 10_000, windowsHide: true });
    const selected = sourceRoot ? path.join(checkout, ...sourceRoot.split("/")) : checkout;
    const info = await lstat(selected).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error("source_root does not exist or is not a directory");
    return { files: await scanTextFiles(selected), resolvedRevision: stdout.trim() };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
