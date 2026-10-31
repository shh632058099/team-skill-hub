import { createHash } from "node:crypto";

export type ArtifactKind = "skill" | "knowledge";
export type ArtifactTargetKind = "file" | "directory";
export type ArtifactSubmissionMode = "merge" | "replace";
export type ArtifactBundleFileMode = "0644" | "0755";

export interface ArtifactBundleFileInput {
  path: string;
  content?: string;
  contentBase64?: string;
  mode?: ArtifactBundleFileMode;
}

export interface ArtifactBundleFile {
  path: string;
  content?: string;
  contentBase64?: string;
  sha256: string;
  sizeBytes: number;
  mode: ArtifactBundleFileMode;
}

export interface ArtifactBundleSnapshot {
  id: string;
  files: ArtifactBundleFile[];
  sha256: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

export interface ArtifactBundleDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  sha256: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function artifactBundleFileBytes(
  file: Pick<ArtifactBundleFile, "content" | "contentBase64"> | ArtifactBundleFileInput,
): Buffer {
  const hasText = file.content !== undefined;
  const hasBinary = file.contentBase64 !== undefined;
  if (hasText === hasBinary) throw new Error("bundle file must contain exactly one of content or contentBase64");
  if (hasText) return Buffer.from(file.content!, "utf8");
  const encoded = file.contentBase64!;
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("bundle file contentBase64 is invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("bundle file contentBase64 is invalid");
  return bytes;
}

export function normalizeArtifactRelativePath(value: string, label = "file path"): string {
  const raw = value.trim();
  if (!raw || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`${label} is invalid`);
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !SAFE_SEGMENT.test(part))) {
    throw new Error(`${label} is invalid`);
  }
  return parts.join("/");
}

export function normalizeArtifactFiles(
  files: Array<Pick<ArtifactBundleFile, "path" | "content" | "contentBase64" | "mode"> | ArtifactBundleFileInput>,
): ArtifactBundleFile[] {
  const seen = new Set<string>();
  return files
    .map((file) => {
      const normalizedPath = normalizeArtifactRelativePath(file.path);
      const folded = normalizedPath.toLocaleLowerCase("en-US");
      if (seen.has(folded)) throw new Error(`file path case collision: ${normalizedPath}`);
      seen.add(folded);
      const mode: ArtifactBundleFileMode = file.mode ?? "0644";
      if (mode !== "0644" && mode !== "0755") throw new Error(`file mode is invalid: ${normalizedPath}`);
      const bytes = artifactBundleFileBytes(file);
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

export function canonicalArtifactTreeHash(
  files: Array<Pick<ArtifactBundleFile, "path" | "content" | "contentBase64" | "mode"> | ArtifactBundleFileInput>,
): string {
  const normalized = normalizeArtifactFiles(files);
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

function fileIdentity(
  file: Pick<ArtifactBundleFile, "content" | "contentBase64" | "mode"> | ArtifactBundleFileInput,
): string {
  return `${file.mode ?? "0644"}\0${sha256(artifactBundleFileBytes(file))}`;
}

export function diffArtifactTrees(
  before: Array<Pick<ArtifactBundleFile, "path" | "content" | "contentBase64" | "mode"> | ArtifactBundleFileInput>,
  after: Array<Pick<ArtifactBundleFile, "path" | "content" | "contentBase64" | "mode"> | ArtifactBundleFileInput>,
): ArtifactBundleDiff {
  const left = new Map(normalizeArtifactFiles(before).map((file) => [file.path, file]));
  const right = new Map(normalizeArtifactFiles(after).map((file) => [file.path, file]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  );
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];
  const hash = createHash("sha256");
  for (const path of paths) {
    const a = left.get(path);
    const b = right.get(path);
    const change = !a ? "added" : !b ? "deleted" : fileIdentity(a) === fileIdentity(b) ? "unchanged" : "modified";
    (change === "added" ? added : change === "deleted" ? deleted : change === "modified" ? modified : unchanged).push(path);
    if (change !== "unchanged") {
      hash.update(`${path}\0${change}\0${a ? fileIdentity(a) : "-"}\0${b ? fileIdentity(b) : "-"}\n`, "utf8");
    }
  }
  return { added, modified, deleted, unchanged, sha256: hash.digest("hex") };
}

export function planArtifactFinalTree(input: {
  targetKind: ArtifactTargetKind;
  mode: ArtifactSubmissionMode;
  before: Array<Pick<ArtifactBundleFile, "path" | "content" | "contentBase64" | "mode"> | ArtifactBundleFileInput>;
  submitted: ArtifactBundleFileInput[];
}): ArtifactBundleFile[] {
  const before = normalizeArtifactFiles(input.before);
  const submitted = normalizeArtifactFiles(input.submitted);
  if (input.targetKind === "file") {
    if (before.length > 1 || submitted.length !== 1) {
      throw new Error("file-scoped artifact must contain exactly one submitted file and at most one baseline file");
    }
    return submitted;
  }
  if (input.mode === "replace") return submitted;
  const merged = new Map(before.map((file) => [file.path, file]));
  for (const file of submitted) merged.set(file.path, file);
  return [...merged.values()].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}
