import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { structuredPatch } from "diff";
import type { Principal, RepositoryConfig, Skill, ValidationRule } from "./types.js";
import { scanSkills, validateSkills } from "./skills.js";
import {
  canonicalTreeHash,
  createSkillBundleSnapshot,
  diffSkillBundleTrees,
  normalizeSkillBundleInput,
  skillBundleFileBytes,
  type NormalizedSkillBundleInput,
  type SkillBundleDiff,
  type SkillBundleFile,
  type SkillBundleImport,
  type SkillBundleImportType,
} from "./skill-bundles.js";
import type { SqliteSkillBundleRepository } from "./storage/skill-bundle-repository.js";
import { SkillBundlePublisher, SkillBundleReviewStaleError } from "./skill-bundle-publishing.js";
import { artifactIdentity, matchArtifact, type ArtifactMatch } from "./artifact-relation.js";
import { buildArtifactPreview, type ArtifactPreviewContract } from "./artifact-preview.js";

export interface SkillBundleMaterializedRepository {
  sourceRoot: string;
  revision: string;
}

export interface SkillBundlePreview {
  namespace: string;
  importType: SkillBundleImportType;
  skillPath?: string;
  replacementRoot: string;
  targetRevision: string;
  targetTreeSha256: string;
  targetExists: boolean;
  expectedTreeSha256: string;
  artifactPreview: ArtifactPreviewContract;
  diff: SkillBundleDiff;
  fileDiffs: SkillBundleFileDiff[];
  skills: Skill[];
  /** Advisory only: explicit namespace/skillPath and replacementRoot always win. */
  artifactMatch?: ArtifactMatch;
}

export interface SkillBundleFileDiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface SkillBundleFileDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: SkillBundleFileDiffLine[];
}

export interface SkillBundleFileDiff {
  path: string;
  operation: "add" | "modify" | "delete";
  binary: boolean;
  oldMode?: "0644" | "0755";
  newMode?: "0644" | "0755";
  addedLines: number;
  removedLines: number;
  hunks: SkillBundleFileDiffHunk[];
}

export interface SubmitSkillBundleServiceInput {
  namespace: string;
  importType: SkillBundleImportType;
  skillPath?: string;
  files: Array<{ path: string; content?: string; contentBase64?: string; mode?: "0644" | "0755" }>;
  sourceType: SkillBundleImport["sourceType"];
  sourceMetadata?: Record<string, string>;
  submissionKey?: string;
}

export interface SkillBundleSubmitResult {
  import: SkillBundleImport;
  created: boolean;
}

interface SkillBundleServiceOptions {
  storage: SqliteSkillBundleRepository;
  rules: ValidationRule[];
  materialize: (repository: RepositoryConfig) => Promise<SkillBundleMaterializedRepository>;
  authorize: (principal: Principal, repository: RepositoryConfig) => boolean;
  publisher?: SkillBundlePublisher;
}

function semanticsHash(repository: RepositoryConfig, normalized: NormalizedSkillBundleInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repository: repository.id,
        collection: "rd-skills",
        namespace: normalized.namespace,
        importType: normalized.importType,
        skillPath: normalized.skillPath ?? null,
        snapshotSha256: normalized.snapshotSha256,
      }),
    )
    .digest("hex");
}

async function readTextTree(root: string): Promise<SkillBundleFile[]> {
  const files: SkillBundleFile[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  async function walk(dir: string, relative = ""): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink())
        throw new Error(`target repository contains symlink inside replacementRoot: ${childRelative}`);
      if (info.isDirectory()) {
        await walk(full, childRelative);
        continue;
      }
      if (!info.isFile()) throw new Error(`target repository contains unsupported file type: ${childRelative}`);
      const bytes = await readFile(full);
      let content: string | undefined;
      try {
        const decoded = decoder.decode(bytes);
        if (!decoded.includes("\0")) content = decoded;
      } catch {}
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      files.push({
        path: childRelative.replaceAll("\\", "/"),
        ...(content !== undefined ? { content } : { contentBase64: bytes.toString("base64") }),
        sha256,
        sizeBytes: bytes.byteLength,
        mode: (info.mode & 0o111) !== 0 ? "0755" : "0644",
      });
    }
  }
  await walk(root);
  return files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}

async function writeSnapshotRoot(repositoryRoot: string, normalized: NormalizedSkillBundleInput): Promise<void> {
  const target = path.join(repositoryRoot, ...normalized.replacementRoot.split("/"));
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const file of normalized.files) {
    const destination = path.join(target, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, skillBundleFileBytes(file));
    await chmod(destination, file.mode === "0755" ? 0o755 : 0o644);
  }
}

function decodeBundleText(file: SkillBundleFile): string | undefined {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(skillBundleFileBytes(file));
    return decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function buildSkillBundleFileDiffs(
  before: SkillBundleFile[],
  after: SkillBundleFile[],
  treeDiff: SkillBundleDiff,
): SkillBundleFileDiff[] {
  const left = new Map(before.map((file) => [file.path, file]));
  const right = new Map(after.map((file) => [file.path, file]));
  const operations = new Map<string, SkillBundleFileDiff["operation"]>([
    ...treeDiff.added.map((path) => [path, "add"] as const),
    ...treeDiff.modified.map((path) => [path, "modify"] as const),
    ...treeDiff.deleted.map((path) => [path, "delete"] as const),
  ]);

  return [...operations.keys()]
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
    .map((filePath) => {
      const oldFile = left.get(filePath);
      const newFile = right.get(filePath);
      const oldText = oldFile ? decodeBundleText(oldFile) : "";
      const newText = newFile ? decodeBundleText(newFile) : "";
      const binary = oldText === undefined || newText === undefined;
      if (binary) {
        return {
          path: filePath,
          operation: operations.get(filePath)!,
          binary: true,
          ...(oldFile ? { oldMode: oldFile.mode } : {}),
          ...(newFile ? { newMode: newFile.mode } : {}),
          addedLines: 0,
          removedLines: 0,
          hunks: [],
        };
      }

      const patch = structuredPatch(
        oldFile ? `a/${filePath}` : "/dev/null",
        newFile ? `b/${filePath}` : "/dev/null",
        oldText,
        newText,
        "",
        "",
        { context: 3 },
      );
      let addedLines = 0;
      let removedLines = 0;
      const hunks = patch.hunks.map((hunk) => {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        const lines = hunk.lines
          .filter((line) => line !== "\\ No newline at end of file")
          .map((line): SkillBundleFileDiffLine => {
            const prefix = line[0];
            const text = line.slice(1);
            if (prefix === "+") {
              addedLines += 1;
              return { kind: "add", text, newLine: newLine++ };
            }
            if (prefix === "-") {
              removedLines += 1;
              return { kind: "remove", text, oldLine: oldLine++ };
            }
            return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
          });
        return {
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines,
        };
      });
      return {
        path: filePath,
        operation: operations.get(filePath)!,
        binary: false,
        ...(oldFile ? { oldMode: oldFile.mode } : {}),
        ...(newFile ? { newMode: newFile.mode } : {}),
        addedLines,
        removedLines,
        hunks,
      };
    });
}

export class SkillBundleService {
  private readonly publisher: SkillBundlePublisher;

  constructor(private readonly options: SkillBundleServiceOptions) {
    this.publisher = options.publisher ?? new SkillBundlePublisher();
  }

  private assertAuthorized(principal: Principal, repository: RepositoryConfig): void {
    if (!repository.enabled || !repository.skillPublishing?.enabled || !this.options.authorize(principal, repository)) {
      throw new Error("principal is not authorized for Skill Bundle repository");
    }
  }

  private assertAdmin(principal: Principal): void {
    if (!principal.roles.includes("admin")) {
      throw new Error("administrator role is required for Skill Bundle review/publishing");
    }
  }

  private async previewNormalized(
    repository: RepositoryConfig,
    normalized: NormalizedSkillBundleInput,
  ): Promise<SkillBundlePreview> {
    const materialized = await this.options.materialize(repository);
    const currentRoot = path.join(materialized.sourceRoot, ...normalized.replacementRoot.split("/"));
    const before = await readTextTree(currentRoot);
    // Skill imports already update the explicit replacementRoot. Provide a safe,
    // same-repository match hint for renamed Skills without redirecting it.
    let artifactMatch: ArtifactMatch | undefined;
    if (normalized.importType === "skill") {
      const file = normalized.files.find((item) => item.path === "SKILL.md");
      const existingSkills = await scanSkills(materialized.sourceRoot, repository.id, materialized.revision);
      const title = normalized.skills[0]?.name;
      if (file?.content && title) {
        artifactMatch = matchArtifact(
          { kind: "skill", repositoryId: repository.id, title, content: file.content },
          existingSkills.map((skill) => ({ identity: artifactIdentity(skill, "skill"), content: skill.content })),
        );
      }
    }
    const tempParent = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-preview-"));
    const tempRoot = path.join(tempParent, "repo");
    try {
      await cp(materialized.sourceRoot, tempRoot, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".git",
      });
      await writeSnapshotRoot(tempRoot, normalized);
      const skills = await scanSkills(tempRoot, repository.id, materialized.revision);
      const issues = validateSkills(skills, repository, this.options.rules);
      if (issues.length) {
        throw new Error(
          `Skill Bundle validation failed: ${issues.map((issue) => `${issue.skillPath ?? "repo"}: ${issue.message}`).join("; ")}`,
        );
      }
      const diff = diffSkillBundleTrees(before, normalized.files);
      return {
        namespace: normalized.namespace,
        importType: normalized.importType,
        ...(normalized.skillPath ? { skillPath: normalized.skillPath } : {}),
        replacementRoot: normalized.replacementRoot,
        targetRevision: materialized.revision,
        targetTreeSha256: canonicalTreeHash(before),
        targetExists: before.length > 0,
        expectedTreeSha256: normalized.expectedTreeSha256,
        diff,
        fileDiffs: buildSkillBundleFileDiffs(before, normalized.files, diff),
        skills,
        artifactPreview: buildArtifactPreview({
          artifactType: "skill",
          targetPath: normalized.replacementRoot,
          targetExists: before.length > 0,
          changed: diff.added.length + diff.modified.length + diff.deleted.length > 0,
          changedFiles: { added: diff.added, modified: diff.modified, deleted: diff.deleted },
          ...(artifactMatch?.relation
            ? { relationConfidence: "high" as const }
            : artifactMatch?.hint
              ? { relationConfidence: "medium" as const }
              : {}),
        }),
        ...(artifactMatch?.relation || artifactMatch?.hint ? { artifactMatch } : {}),
      };
    } finally {
      await rm(tempParent, { recursive: true, force: true });
    }
  }

  async preview(
    principal: Principal,
    repository: RepositoryConfig,
    input: Omit<SubmitSkillBundleServiceInput, "sourceType" | "sourceMetadata" | "submissionKey">,
  ): Promise<SkillBundlePreview> {
    this.assertAuthorized(principal, repository);
    const normalized = normalizeSkillBundleInput(input);
    return await this.previewNormalized(repository, normalized);
  }

  async submitDetailed(
    principal: Principal,
    repository: RepositoryConfig,
    input: SubmitSkillBundleServiceInput,
  ): Promise<SkillBundleSubmitResult> {
    this.assertAuthorized(principal, repository);
    const normalized = normalizeSkillBundleInput(input);
    const requestSemanticsSha256 = semanticsHash(repository, normalized);
    if (input.submissionKey) {
      const existing = this.options.storage.findBySubmissionKey(principal.id, input.submissionKey);
      if (existing) {
        if (existing.requestSemanticsSha256 !== requestSemanticsSha256)
          throw new Error("submission_key conflicts with a different Skill Bundle request");
        return { import: existing, created: false };
      }
    }
    await this.previewNormalized(repository, normalized);
    const snapshot = this.options.storage.saveSnapshot(createSkillBundleSnapshot(normalized));
    const now = new Date().toISOString();
    const record: SkillBundleImport = {
      id: "sbi_" + randomUUID().replaceAll("-", ""),
      revision: 0,
      namespace: normalized.namespace,
      importType: normalized.importType,
      ...(normalized.skillPath ? { skillPath: normalized.skillPath } : {}),
      replacementRoot: normalized.replacementRoot,
      collection: "rd-skills",
      repository: repository.id,
      sourceType: input.sourceType,
      ...(input.sourceMetadata ? { sourceMetadata: input.sourceMetadata } : {}),
      snapshotId: snapshot.id,
      snapshotSha256: snapshot.sha256,
      status: "pending",
      submitter: principal.id,
      ...(input.submissionKey ? { submissionKey: input.submissionKey } : {}),
      requestSemanticsSha256,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return { import: this.options.storage.createImport(record), created: true };
    } catch (error) {
      if (input.submissionKey) {
        const existing = this.options.storage.findBySubmissionKey(principal.id, input.submissionKey);
        if (existing) {
          if (existing.requestSemanticsSha256 !== requestSemanticsSha256)
            throw new Error("submission_key conflicts with a different Skill Bundle request");
          return { import: existing, created: false };
        }
      }
      throw error;
    }
  }

  async submit(
    principal: Principal,
    repository: RepositoryConfig,
    input: SubmitSkillBundleServiceInput,
  ): Promise<SkillBundleImport> {
    return (await this.submitDetailed(principal, repository, input)).import;
  }

  private normalizedFromImport(record: SkillBundleImport): NormalizedSkillBundleInput {
    const snapshot = this.options.storage.getSnapshot(record.snapshotId);
    if (!snapshot) throw new Error("Skill Bundle snapshot not found");
    return normalizeSkillBundleInput({
      namespace: record.namespace,
      importType: record.importType,
      skillPath: record.skillPath,
      files: snapshot.files.map((file) => ({
        path: file.path,
        ...(file.content !== undefined ? { content: file.content } : { contentBase64: file.contentBase64 }),
        mode: file.mode,
      })),
    });
  }

  async previewImport(principal: Principal, repository: RepositoryConfig, id: string): Promise<SkillBundlePreview> {
    this.assertAuthorized(principal, repository);
    const record = this.options.storage.getImport(id);
    if (!record || record.repository !== repository.id) throw new Error("Skill Bundle import not found");
    return await this.previewNormalized(repository, this.normalizedFromImport(record));
  }

  async review(
    principal: Principal,
    repository: RepositoryConfig,
    id: string,
    status: "approved" | "rejected",
    reason?: string,
  ): Promise<SkillBundleImport> {
    this.assertAuthorized(principal, repository);
    this.assertAdmin(principal);
    const current = this.options.storage.getImport(id);
    if (!current || current.repository !== repository.id) throw new Error("Skill Bundle import not found");
    if (!["pending", "approved", "rejected", "publish_failed", "review_stale"].includes(current.status)) {
      throw new Error("Skill Bundle import is not reviewable");
    }
    const now = new Date().toISOString();
    if (status === "rejected") {
      return this.options.storage.updateImport({
        ...current,
        status,
        review: { reviewer: principal.id, reviewedAt: now, ...(reason ? { reason } : {}) },
        publishError: undefined,
        updatedAt: now,
      });
    }
    const preview = await this.previewImport(principal, repository, id);
    return this.options.storage.updateImport({
      ...current,
      status,
      review: {
        reviewer: principal.id,
        reviewedAt: now,
        targetRevision: preview.targetRevision,
        targetTreeSha256: preview.targetTreeSha256,
        diffSha256: preview.diff.sha256,
        added: preview.diff.added.length,
        modified: preview.diff.modified.length,
        deleted: preview.diff.deleted.length,
        ...(reason ? { reason } : {}),
      },
      publishError: undefined,
      updatedAt: now,
    });
  }

  async ensureReviewFresh(principal: Principal, repository: RepositoryConfig, id: string): Promise<SkillBundleImport> {
    this.assertAuthorized(principal, repository);
    this.assertAdmin(principal);
    const current = this.options.storage.getImport(id);
    if (!current || current.repository !== repository.id) throw new Error("Skill Bundle import not found");
    if (current.status !== "approved" && current.status !== "publish_failed") return current;
    if (!current.review) throw new Error("Skill Bundle import has no approval review");
    if (!current.review.targetTreeSha256 || !current.review.diffSha256 || !current.review.targetRevision) {
      throw new Error("Skill Bundle approval review is missing target baseline");
    }
    const preview = await this.previewImport(principal, repository, id);
    if (preview.targetTreeSha256 === current.review.targetTreeSha256) return current;
    return this.options.storage.updateImport({
      ...current,
      status: "review_stale",
      publishError: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  async publish(principal: Principal, repository: RepositoryConfig, id: string): Promise<SkillBundleImport> {
    this.assertAuthorized(principal, repository);
    this.assertAdmin(principal);
    const fresh = await this.ensureReviewFresh(principal, repository, id);
    if (fresh.status === "review_stale") return fresh;
    if (!fresh.review || !["approved", "publish_failed"].includes(fresh.status)) {
      throw new Error("Skill Bundle import must be approved before publishing");
    }
    const snapshot = this.options.storage.getSnapshot(fresh.snapshotId);
    if (!snapshot) throw new Error("Skill Bundle snapshot not found");
    const publishing = this.options.storage.updateImport({
      ...fresh,
      status: "publishing",
      publishError: undefined,
      updatedAt: new Date().toISOString(),
    });
    try {
      const publication = await this.publisher.publish({ ...fresh, status: fresh.status }, snapshot, repository);
      const nextStatus = publication.kind === "no-op" ? "published" : "publishing";
      return this.options.storage.updateImport({
        ...publishing,
        status: nextStatus,
        publication,
        publishError: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SkillBundleReviewStaleError) {
        return this.options.storage.updateImport({
          ...publishing,
          status: "review_stale",
          publishError: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
      this.options.storage.updateImport({
        ...publishing,
        status: "publish_failed",
        publishError: message,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async reconcile(principal: Principal, repository: RepositoryConfig, id: string): Promise<SkillBundleImport> {
    this.assertAuthorized(principal, repository);
    this.assertAdmin(principal);
    const current = this.options.storage.getImport(id);
    if (!current || current.repository !== repository.id) throw new Error("Skill Bundle import not found");
    if (["deleting", "deleted"].includes(current.status)) {
      if (!current.deletionPublication) throw new Error("Skill Bundle deletion has not created a PR/MR");
      const result = await this.publisher.reconcileDeletion(current.deletionPublication, repository);
      const status: SkillBundleImport["status"] =
        current.status === "deleting" && result.publication.mergeRequestState === "merged" ? "deleted" : current.status;
      return this.options.storage.updateImport({
        ...current,
        status,
        deletionPublication: result.publication,
        deletionError: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    if (current.publication?.kind === "no-op") return current;
    if (current.publication?.kind !== "pull-request") throw new Error("Skill Bundle import has no PR/MR publication");
    if (!["publishing", "published", "published_drifted", "publish_failed"].includes(current.status)) {
      throw new Error("Skill Bundle import is not awaiting publication reconciliation");
    }
    try {
      const snapshot = this.options.storage.getSnapshot(current.snapshotId);
      if (!snapshot) throw new Error("Skill Bundle snapshot not found");
      const result = await this.publisher.reconcile(current.publication, snapshot, repository);
      let status: SkillBundleImport["status"] = "publishing";
      if (result.publication.mergeRequestState === "closed") status = "publish_failed";
      else if (result.publication.mergeRequestState === "merged")
        status = result.finalTreeMatches ? "published" : "published_drifted";
      return this.options.storage.updateImport({
        ...current,
        status,
        publication: result.publication,
        publishError: status === "publish_failed" ? "PR/MR was closed without merge" : undefined,
        ...(status === "published_drifted" ? { driftSummary: result.finalDiff } : { driftSummary: undefined }),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (current.status === "published" || current.status === "published_drifted") throw error;
      this.options.storage.updateImport({
        ...current,
        status: "publish_failed",
        publishError: message,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async deletePublished(principal: Principal, repository: RepositoryConfig, id: string): Promise<SkillBundleImport> {
    this.assertAuthorized(principal, repository);
    this.assertAdmin(principal);
    const current = this.options.storage.getImport(id);
    if (!current || current.repository !== repository.id) throw new Error("Skill Bundle import not found");
    if (!["published", "delete_failed"].includes(current.status)) {
      throw new Error("Skill Bundle import must be published before deleting its remote asset");
    }
    if (current.publication?.kind === "no-op") {
      throw new Error("No-op Skill Bundle publications cannot delete pre-existing remote content");
    }
    if (current.publication?.kind !== "pull-request") {
      throw new Error("Skill Bundle import has no PR/MR publication");
    }
    const snapshot = this.options.storage.getSnapshot(current.snapshotId);
    if (!snapshot) throw new Error("Skill Bundle snapshot not found");

    const verified = await this.publisher.reconcile(current.publication, snapshot, repository);
    const verifiedPublication = verified.publication;
    if (verifiedPublication.mergeRequestState !== "merged") {
      if (current.status !== "published") {
        throw new Error("Original Skill Bundle publication is no longer merged; deletion cannot proceed");
      }
      const status: SkillBundleImport["status"] =
        verifiedPublication.mergeRequestState === "closed" ? "publish_failed" : "publishing";
      return this.options.storage.updateImport({
        ...current,
        status,
        publication: verifiedPublication,
        publishError: status === "publish_failed" ? "Original PR/MR was closed without merge" : undefined,
        updatedAt: new Date().toISOString(),
      });
    }

    const deleting = this.options.storage.updateImport({
      ...current,
      status: "deleting",
      publication: verifiedPublication,
      deletionError: undefined,
      updatedAt: new Date().toISOString(),
    });
    try {
      const deletionPublication = await this.publisher.deletePublished(
        { ...current, status: "published", publication: verifiedPublication },
        verifiedPublication,
        repository,
      );
      return this.options.storage.updateImport({
        ...deleting,
        deletionPublication,
        deletionError: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.storage.updateImport({
        ...deleting,
        status: "delete_failed",
        deletionError: message,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async delete(principal: Principal, repository: RepositoryConfig, id: string): Promise<boolean> {
    this.assertAuthorized(principal, repository);
    this.assertAdmin(principal);
    const current = this.options.storage.getImport(id);
    if (!current || current.repository !== repository.id) return false;
    if (!["pending", "approved", "rejected", "publish_failed", "review_stale"].includes(current.status)) {
      throw new Error(`Skill Bundle import in status ${current.status} cannot be deleted`);
    }
    return this.options.storage.deleteImport(id, current.revision);
  }

  getImport(id: string): SkillBundleImport | undefined {
    return this.options.storage.getImport(id);
  }
  getSnapshot(id: string) {
    return this.options.storage.getSnapshot(id);
  }
  getHistory(id: string): SkillBundleImport[] {
    return this.options.storage.getImportHistory(id);
  }
  listImports(limit = 200): SkillBundleImport[] {
    return this.options.storage.listImports(limit);
  }
  listImportsPage(query: Parameters<SqliteSkillBundleRepository["listImportsPage"]>[0]) {
    return this.options.storage.listImportsPage(query);
  }
}
