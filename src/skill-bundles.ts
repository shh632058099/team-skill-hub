import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";

export type SkillBundleImportType = "skill" | "collection";
export type SkillBundleFileMode = "0644" | "0755";
export type SkillBundleImportStatus =
  | "pending"
  | "approved"
  | "review_stale"
  | "rejected"
  | "publishing"
  | "publish_failed"
  | "published"
  | "deleting"
  | "delete_failed"
  | "deleted"
  | "published_drifted";

export interface SkillBundleFile {
  path: string;
  content?: string;
  contentBase64?: string;
  sha256: string;
  sizeBytes: number;
  mode: SkillBundleFileMode;
}

export interface SkillBundleSkillSummary {
  name?: string;
  rootPath: string;
  skillFilePath: string;
}

export interface SkillBundleSnapshot {
  id: string;
  files: SkillBundleFile[];
  skills: SkillBundleSkillSummary[];
  sha256: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export interface SkillBundleReview {
  reviewer: string;
  reviewedAt: string;
  targetRevision?: string;
  targetTreeSha256?: string;
  diffSha256?: string;
  added?: number;
  modified?: number;
  deleted?: number;
  reason?: string;
}

export interface SkillBundlePullRequestPublication {
  kind: "pull-request";
  provider: "github" | "gitlab";
  projectPath: string;
  branch: string;
  targetBranch: string;
  targetRoot: string;
  mergeRequestIid: number;
  mergeRequestUrl: string;
  mergeRequestState: "opened" | "merged" | "closed" | "locked";
  added: number;
  modified: number;
  deleted: number;
  expectedTreeSha256: string;
  pullRequestCreatedAt: string;
  lastCheckedAt: string;
  mergedAt?: string;
  closedAt?: string;
  mergeCommitSha?: string;
  finalTreeSha256?: string;
  finalTreeVerifiedAt?: string;
}

export interface SkillBundleNoopPublication {
  kind: "no-op";
  targetRevision: string;
  targetRoot: string;
  checkedAt: string;
  expectedTreeSha256: string;
}

export type SkillBundlePublication = SkillBundlePullRequestPublication | SkillBundleNoopPublication;

export interface SkillBundleImport {
  id: string;
  revision: number;
  namespace: string;
  importType: SkillBundleImportType;
  skillPath?: string;
  replacementRoot: string;
  collection: "rd-skills";
  repository: string;
  sourceType: "mcp" | "web-files" | "web-zip" | "web-git";
  sourceMetadata?: Record<string, string>;
  snapshotId: string;
  snapshotSha256: string;
  status: SkillBundleImportStatus;
  submitter?: string;
  submissionKey?: string;
  requestSemanticsSha256?: string;
  review?: SkillBundleReview;
  publication?: SkillBundlePublication;
  publishError?: string;
  deletionPublication?: SkillBundlePullRequestPublication;
  deletionError?: string;
  driftSummary?: SkillBundleDiff;
  createdAt: string;
  updatedAt: string;
}

export interface SkillBundleDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  sha256: string;
}

export interface SkillBundleInputFile {
  path: string;
  content?: string;
  contentBase64?: string;
  mode?: SkillBundleFileMode;
}

export interface NormalizedSkillBundleInput {
  namespace: string;
  importType: SkillBundleImportType;
  skillPath?: string;
  replacementRoot: string;
  files: SkillBundleFile[];
  skills: SkillBundleSkillSummary[];
  snapshotSha256: string;
  expectedTreeSha256: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_FILE_BYTES = 512 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_BUNDLE_SKILLS = 100;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function skillBundleFileBytes(
  file: Pick<SkillBundleFile, "content" | "contentBase64"> | SkillBundleInputFile,
): Buffer {
  const hasText = file.content !== undefined;
  const hasBinary = file.contentBase64 !== undefined;
  if (hasText === hasBinary) throw new Error("bundle file must contain exactly one of content or contentBase64");
  if (hasText) return Buffer.from(file.content!, "utf8");
  const encoded = file.contentBase64!;
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error("bundle file contentBase64 is invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("bundle file contentBase64 is invalid");
  return bytes;
}

function normalizeNamespace(value: string): string {
  const normalized = value.trim();
  if (!SAFE_SEGMENT.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("namespace is invalid");
  }
  return normalized;
}

function normalizeRelativePath(value: string, label: string, allowNested = true): string {
  const raw = value.trim();
  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`${label} is invalid`);
  }
  const parts = raw.split("/");
  if (
    (!allowNested && parts.length !== 1) ||
    parts.some((part) => !part || part === "." || part === ".." || !SAFE_SEGMENT.test(part))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return parts.join("/");
}

function normalizedTreeFiles(
  files: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
): SkillBundleFile[] {
  const seen = new Set<string>();
  return files
    .map((file) => {
      const normalizedPath = normalizeRelativePath(file.path, "file path");
      const folded = normalizedPath.toLocaleLowerCase("en-US");
      if (seen.has(folded)) throw new Error(`file path case collision: ${normalizedPath}`);
      seen.add(folded);
      const mode: SkillBundleFileMode = file.mode ?? "0644";
      if (mode !== "0644" && mode !== "0755") throw new Error(`file mode is invalid: ${normalizedPath}`);
      const bytes = skillBundleFileBytes(file);
      return {
        path: normalizedPath,
        ...(file.content !== undefined ? { content: file.content } : { contentBase64: file.contentBase64! }),
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        mode,
      };
    })
    .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}

export function canonicalTreeHash(
  files: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
): string {
  const normalized = normalizedTreeFiles(files);
  const hash = createHash("sha256");
  for (const file of normalized) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.mode, "utf8");
    hash.update("\0");
    hash.update(file.sha256, "utf8");
    hash.update("\n");
  }
  return hash.digest("hex");
}

function rootForSkillFile(path: string): string {
  const suffix = "/SKILL.md";
  return path === "SKILL.md" ? "" : path.endsWith(suffix) ? path.slice(0, -suffix.length) : "";
}

function skillNameFromContent(content: string): string | undefined {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  try {
    const data = YAML.parse(match[1]!) as { name?: unknown } | null;
    return typeof data?.name === "string" && data.name.trim() ? data.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function skillSummaries(files: SkillBundleFile[]): SkillBundleSkillSummary[] {
  return files
    .filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => {
      if (file.content === undefined) throw new Error(`${file.path} must be UTF-8 text`);
      const name = skillNameFromContent(file.content);
      return {
        ...(name ? { name } : {}),
        rootPath: rootForSkillFile(file.path),
        skillFilePath: file.path,
      };
    });
}

function assertCollectionRootsNotNested(skills: SkillBundleSkillSummary[]): void {
  const roots = skills.map((item) => item.rootPath).sort();
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const left = roots[i]!;
      const right = roots[j]!;
      if (left === "" || right.startsWith(left + "/")) {
        throw new Error(`collection contains nested skill roots: ${left || "."} and ${right}`);
      }
    }
  }
}

export function normalizeSkillBundleInput(input: {
  namespace: string;
  importType: SkillBundleImportType;
  skillPath?: string;
  files: SkillBundleInputFile[];
}): NormalizedSkillBundleInput {
  const namespace = normalizeNamespace(input.namespace);
  const skillPath =
    input.importType === "skill" && input.skillPath !== undefined
      ? normalizeRelativePath(input.skillPath, "skill_path")
      : undefined;
  if (input.importType === "collection" && input.skillPath !== undefined) {
    throw new Error("skill_path is only valid for skill imports");
  }
  if (!input.files.length) throw new Error("bundle files must not be empty");
  if (input.files.length > MAX_BUNDLE_FILES) throw new Error(`bundle file count limit exceeded (${MAX_BUNDLE_FILES})`);
  const files = normalizedTreeFiles(input.files);
  for (const file of files) {
    if (file.sizeBytes > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`bundle single file size limit exceeded (${MAX_BUNDLE_FILE_BYTES} bytes): ${file.path}`);
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > MAX_BUNDLE_TOTAL_BYTES)
    throw new Error(`bundle total size limit exceeded (${MAX_BUNDLE_TOTAL_BYTES} bytes)`);
  const skills = skillSummaries(files);
  if (skills.length > MAX_BUNDLE_SKILLS) throw new Error(`bundle Skill count limit exceeded (${MAX_BUNDLE_SKILLS})`);
  if (input.importType === "skill") {
    if (skills.length !== 1 || skills[0]!.skillFilePath !== "SKILL.md") {
      throw new Error("skill import must contain exactly one root SKILL.md");
    }
  } else {
    if (!skills.length) throw new Error("collection import must contain at least one SKILL.md");
    assertCollectionRootsNotNested(skills);
  }
  const replacementRoot =
    input.importType === "skill" && skillPath ? `skills/${namespace}/${skillPath}` : `skills/${namespace}`;
  const snapshotSha256 = canonicalTreeHash(files);
  return {
    namespace,
    importType: input.importType,
    ...(skillPath ? { skillPath } : {}),
    replacementRoot,
    files,
    skills,
    snapshotSha256,
    expectedTreeSha256: snapshotSha256,
  };
}

function fileIdentity(
  file: Pick<SkillBundleFile, "content" | "contentBase64" | "mode"> | SkillBundleInputFile,
): string {
  return `${file.mode ?? "0644"}\0${sha256(skillBundleFileBytes(file))}`;
}

export function diffSkillBundleTrees(
  before: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
  after: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
): SkillBundleDiff {
  const left = new Map(normalizedTreeFiles(before).map((file) => [file.path, file]));
  const right = new Map(normalizedTreeFiles(after).map((file) => [file.path, file]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];
  const hash = createHash("sha256");
  for (const path of paths) {
    const a = left.get(path);
    const b = right.get(path);
    const change = !a ? "added" : !b ? "deleted" : fileIdentity(a) === fileIdentity(b) ? "unchanged" : "modified";
    (change === "added" ? added : change === "deleted" ? deleted : change === "modified" ? modified : unchanged).push(
      path,
    );
    if (change !== "unchanged") {
      hash.update(`${path}\0${change}\0${a ? fileIdentity(a) : "-"}\0${b ? fileIdentity(b) : "-"}\n`, "utf8");
    }
  }
  return { added, modified, deleted, unchanged, sha256: hash.digest("hex") };
}

export function legacyRdSkillPathToTarget(
  value: string,
): { namespace: string; skillPath: string; replacementRoot: string } | undefined {
  const raw = value.trim().replace(/^skills\//, "");
  if (raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || !raw.endsWith("/SKILL.md"))
    return undefined;
  const parts = raw.split("/");
  if (parts.length < 3 || parts.at(-1) !== "SKILL.md") return undefined;
  try {
    const namespace = normalizeNamespace(parts[0]!);
    const skillPath = normalizeRelativePath(parts.slice(1, -1).join("/"), "skill_path");
    return { namespace, skillPath, replacementRoot: `skills/${namespace}/${skillPath}` };
  } catch {
    return undefined;
  }
}

export function createSkillBundleSnapshot(
  normalized: NormalizedSkillBundleInput,
  now = new Date().toISOString(),
): SkillBundleSnapshot {
  return {
    id: "sbs_" + randomUUID().replaceAll("-", ""),
    files: normalized.files,
    skills: normalized.skills,
    sha256: normalized.snapshotSha256,
    fileCount: normalized.files.length,
    totalBytes: normalized.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    createdAt: now,
  };
}
