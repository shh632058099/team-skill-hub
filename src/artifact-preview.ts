export type ArtifactOperation = "create" | "update" | "no_changes" | "needs_review";
export type ArtifactPreviewKind = "knowledge" | "skill";

export interface ArtifactPreviewContract {
  operation: ArtifactOperation;
  artifactType: ArtifactPreviewKind;
  targetPath: string | null;
  relationConfidence?: "high" | "medium";
  changedFiles: {
    added: string[];
    modified: string[];
    deleted: string[];
  };
  reviewReason?: string;
}

export function buildArtifactPreview(input: {
  artifactType: ArtifactPreviewKind;
  targetPath: string | null;
  targetExists: boolean;
  changed: boolean;
  changedFiles: ArtifactPreviewContract["changedFiles"];
  relationConfidence?: "high" | "medium";
  needsReviewReason?: string;
}): ArtifactPreviewContract {
  const operation: ArtifactOperation = input.needsReviewReason
    ? "needs_review"
    : !input.changed
      ? "no_changes"
      : input.targetExists
        ? "update"
        : "create";
  return {
    operation,
    artifactType: input.artifactType,
    targetPath: input.targetPath,
    ...(input.relationConfidence ? { relationConfidence: input.relationConfidence } : {}),
    changedFiles: input.changedFiles,
    ...(input.needsReviewReason ? { reviewReason: input.needsReviewReason } : {}),
  };
}
