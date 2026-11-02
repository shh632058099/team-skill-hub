import {
  normalizeArtifactFiles,
  type ArtifactBundleFile,
  type ArtifactBundleFileInput,
  type ArtifactBundleFileMode,
} from "./artifact-bundles.js";

export type ArtifactFileAction =
  | { action: "create" | "update"; path: string; file: ArtifactBundleFile }
  | { action: "delete"; path: string }
  | { action: "chmod"; path: string; mode: ArtifactBundleFileMode };

export function buildArtifactFileActions(
  beforeInput: Array<ArtifactBundleFileInput | ArtifactBundleFile>,
  finalInput: Array<ArtifactBundleFileInput | ArtifactBundleFile>,
): ArtifactFileAction[] {
  const before = new Map(normalizeArtifactFiles(beforeInput).map((file) => [file.path, file]));
  const finalTree = new Map(normalizeArtifactFiles(finalInput).map((file) => [file.path, file]));
  const sorted = (paths: Iterable<string>) => [...paths].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const actions: ArtifactFileAction[] = [];

  for (const filePath of sorted(finalTree.keys())) {
    const oldFile = before.get(filePath);
    const newFile = finalTree.get(filePath)!;
    if (!oldFile) {
      actions.push({ action: "create", path: filePath, file: newFile });
      if (newFile.mode !== "0644") actions.push({ action: "chmod", path: filePath, mode: newFile.mode });
      continue;
    }
    if (oldFile.sha256 !== newFile.sha256) actions.push({ action: "update", path: filePath, file: newFile });
    if (oldFile.mode !== newFile.mode) actions.push({ action: "chmod", path: filePath, mode: newFile.mode });
  }

  for (const filePath of sorted(before.keys())) {
    if (!finalTree.has(filePath)) actions.push({ action: "delete", path: filePath });
  }
  return actions;
}
