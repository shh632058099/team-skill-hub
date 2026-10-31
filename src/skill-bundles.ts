import { randomUUID } from "node:crypto";
import YAML from "yaml";
import {
  artifactBundleFileBytes,
  canonicalArtifactTreeHash,
  diffArtifactTrees,
  normalizeArtifactFiles,
  normalizeArtifactRelativePath,
  type ArtifactBundleFileMode,
} from "./artifact-bundles.js";

export type SkillBundleImportType = "skill" | "collection";
export type SkillBundleFileMode = ArtifactBundleFileMode;export type SkillBundleImportStatus =
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

export const skillBundleFileBytes = artifactBundleFileBytes;
function normalizeNamespace(value: string): string {
  const normalized = value.trim();
  if (!SAFE_SEGMENT.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("namespace is invalid");
  }
  return normalized;
}

function normalizeRelativePath(value: string, label: string, allowNested = true): string {
  const normalized = normalizeArtifactRelativePath(value, label);
  if (!allowNested && normalized.includes("/")) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizedTreeFiles(
  files: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
): SkillBundleFile[] {
  return normalizeArtifactFiles(files);
}
export function canonicalTreeHash(
  files: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
): string {
  return canonicalArtifactTreeHash(files);
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

export function diffSkillBundleTrees(
  before: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
  after: Array<Pick<SkillBundleFile, "path" | "content" | "contentBase64" | "mode"> | SkillBundleInputFile>,
): SkillBundleDiff {
  return diffArtifactTrees(before, after);
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
