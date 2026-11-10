import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export interface WorkspaceChangeSummary {
  baseCommit: string;
  changedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  diffStat: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  contentRevision: string;
}

type ChangeEntry = {
  path: string;
  status: "A" | "M" | "D";
  mode?: "100644" | "100755" | "120000";
  digest?: string;
};

const MAX_CHANGED_FILES = 500;
const MAX_PATH_LENGTH = 1024;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

function normalizeSummaryPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("INVALID_WORKSPACE_CHANGE_SUMMARY");
  try {
    return validateRelativePath(value);
  } catch {
    throw new Error("INVALID_WORKSPACE_CHANGE_SUMMARY");
  }
}

export function normalizeWorkspaceChangeSummary(input: unknown): WorkspaceChangeSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("INVALID_WORKSPACE_CHANGE_SUMMARY");
  }
  const value = input as Partial<WorkspaceChangeSummary>;
  if (
    typeof value.baseCommit !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(value.baseCommit) ||
    typeof value.contentRevision !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.contentRevision) ||
    !Array.isArray(value.changedFiles) ||
    !Array.isArray(value.addedFiles) ||
    !Array.isArray(value.deletedFiles) ||
    !value.diffStat ||
    typeof value.diffStat !== "object"
  ) {
    throw new Error("INVALID_WORKSPACE_CHANGE_SUMMARY");
  }
  const changedFiles = value.changedFiles.map(normalizeSummaryPath);
  const addedFiles = value.addedFiles.map(normalizeSummaryPath);
  const deletedFiles = value.deletedFiles.map(normalizeSummaryPath);
  const allPaths = [...changedFiles, ...addedFiles, ...deletedFiles];
  if (
    allPaths.length > MAX_CHANGED_FILES ||
    new Set(allPaths).size !== allPaths.length ||
    changedFiles.join("\0") !== [...changedFiles].sort().join("\0") ||
    addedFiles.join("\0") !== [...addedFiles].sort().join("\0") ||
    deletedFiles.join("\0") !== [...deletedFiles].sort().join("\0")
  ) {
    throw new Error("INVALID_WORKSPACE_CHANGE_SUMMARY");
  }
  const { filesChanged, insertions, deletions } = value.diffStat;
  if (
    !Number.isSafeInteger(filesChanged) ||
    !Number.isSafeInteger(insertions) ||
    !Number.isSafeInteger(deletions) ||
    filesChanged! < 0 ||
    insertions! < 0 ||
    deletions! < 0 ||
    filesChanged !== allPaths.length
  ) {
    throw new Error("INVALID_WORKSPACE_CHANGE_SUMMARY");
  }
  return {
    baseCommit: value.baseCommit.toLowerCase(),
    changedFiles,
    addedFiles,
    deletedFiles,
    diffStat: { filesChanged: filesChanged!, insertions: insertions!, deletions: deletions! },
    contentRevision: value.contentRevision.toLowerCase(),
  };
}

function runGit(workspacePath: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", workspacePath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_GIT_OUTPUT) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((total, item) => total + item.length, 0) < 64 * 1024) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (size > MAX_GIT_OUTPUT) return reject(new Error("WORKSPACE_CHANGE_LIMIT"));
      if (code !== 0) return reject(new Error("WORKSPACE_GIT_FAILED"));
      resolve(Buffer.concat(stdout));
    });
  });
}

function parseNameStatus(raw: Buffer): Array<{ status: string; path: string }> {
  const tokens = raw.toString("utf8").split("\0").filter(Boolean);
  const result: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const filePath = tokens[index + 1];
    if (!status || filePath === undefined) throw new Error("WORKSPACE_GIT_OUTPUT_INVALID");
    result.push({ status: status[0]!, path: filePath });
  }
  return result;
}

function validateRelativePath(filePath: string): string {
  if (
    !filePath ||
    filePath.length > MAX_PATH_LENGTH ||
    filePath.includes("\0") ||
    path.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error("INVALID_WORKSPACE_CHANGE_PATH");
  }
  return filePath.replaceAll("\\", "/");
}

async function inspectPath(
  root: string,
  relativePath: string,
): Promise<{ mode: ChangeEntry["mode"]; digest: string; lines: number }> {
  const normalized = validateRelativePath(relativePath);
  const absolute = path.resolve(root, normalized);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!absolute.startsWith(prefix)) throw new Error("INVALID_WORKSPACE_CHANGE_PATH");
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolute);
    return {
      mode: "120000",
      digest: createHash("sha256").update("symlink\0").update(target, "utf8").digest("hex"),
      lines: 1,
    };
  }
  if (!stat.isFile()) throw new Error("UNSUPPORTED_WORKSPACE_CHANGE_TYPE");
  const hash = createHash("sha256");
  let lines = 0;
  let bytes = 0;
  let lastByte = -1;
  let binary = false;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      bytes += buffer.length;
      if (buffer.includes(0)) binary = true;
      for (const byte of buffer) if (byte === 10) lines++;
      if (buffer.length) lastByte = buffer[buffer.length - 1]!;
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  if (!binary && bytes > 0 && lastByte !== 10) lines++;
  return {
    mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    digest: hash.digest("hex"),
    lines: binary ? 0 : lines,
  };
}

function parseNumStat(raw: Buffer): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const record of raw.toString("utf8").split("\0").filter(Boolean)) {
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error("WORKSPACE_GIT_OUTPUT_INVALID");
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    if (added !== "-") insertions += Number(added) || 0;
    if (removed !== "-") deletions += Number(removed) || 0;
  }
  return { insertions, deletions };
}

export async function computeWorkspaceChangeSummary(
  workspacePath: string,
  baseCommit: string,
): Promise<WorkspaceChangeSummary> {
  if (!path.isAbsolute(workspacePath) || !/^[a-f0-9]{40,64}$/i.test(baseCommit)) {
    throw new Error("INVALID_WORKSPACE_CHANGE_REQUEST");
  }
  const root = await realpath(workspacePath);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error("INVALID_WORKSPACE_CHANGE_REQUEST");
  await runGit(root, ["cat-file", "-e", `${baseCommit}^{commit}`]);

  const tracked = parseNameStatus(
    await runGit(root, ["diff", "--name-status", "-z", "--no-renames", baseCommit, "--"]),
  );
  const untracked = (await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(validateRelativePath);

  const byPath = new Map<string, "A" | "M" | "D">();
  for (const item of tracked) {
    const filePath = validateRelativePath(item.path);
    if (item.status === "D") byPath.set(filePath, "D");
    else if (item.status === "A") byPath.set(filePath, "A");
    else byPath.set(filePath, "M");
  }
  for (const filePath of untracked) byPath.set(filePath, "A");
  if (byPath.size > MAX_CHANGED_FILES) throw new Error("WORKSPACE_CHANGE_LIMIT");

  const entries: ChangeEntry[] = [];
  let untrackedInsertions = 0;
  const untrackedSet = new Set(untracked);
  for (const [filePath, status] of [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (status === "D") {
      entries.push({ path: filePath, status });
      continue;
    }
    const inspected = await inspectPath(root, filePath);
    entries.push({ path: filePath, status, mode: inspected.mode, digest: inspected.digest });
    if (untrackedSet.has(filePath)) untrackedInsertions += inspected.lines;
  }

  const trackedStat = parseNumStat(await runGit(root, ["diff", "--numstat", "-z", "--no-renames", baseCommit, "--"]));
  const changedFiles = entries.filter((entry) => entry.status === "M").map((entry) => entry.path);
  const addedFiles = entries.filter((entry) => entry.status === "A").map((entry) => entry.path);
  const deletedFiles = entries.filter((entry) => entry.status === "D").map((entry) => entry.path);
  const contentRevision = createHash("sha256")
    .update(JSON.stringify({ version: 1, baseCommit: baseCommit.toLowerCase(), entries }))
    .digest("hex");

  return {
    baseCommit: baseCommit.toLowerCase(),
    changedFiles,
    addedFiles,
    deletedFiles,
    diffStat: {
      filesChanged: entries.length,
      insertions: trackedStat.insertions + untrackedInsertions,
      deletions: trackedStat.deletions,
    },
    contentRevision,
  };
}
