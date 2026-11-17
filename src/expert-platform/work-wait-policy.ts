export interface WorkWaitHumanActionInput {
  status: string;
  currentSubjectRevision: string | null;
  reviewTaskStatus?: string | null;
  reviews: Array<{ subjectRevision: string; decision: string }>;
  gateMissing: string[];
  publicationCommitSha?: string | null;
}

export function workWaitShouldContinuePolling(status: string, humanActionRequired: boolean): boolean {
  return ["queued", "running", "rework"].includes(status) || (status === "waiting_review" && !humanActionRequired);
}

export function workWaitRequiresHumanAction(input: WorkWaitHumanActionInput): boolean {
  if (input.status === "blocked") return true;
  if (input.status !== "waiting_review") return false;

  const reviewTaskActive = /^(queued|running)$/.test(input.reviewTaskStatus ?? "");
  const acceptedReview =
    input.currentSubjectRevision !== null &&
    input.reviews.some(
      (review) => review.subjectRevision === input.currentSubjectRevision && review.decision === "accepted",
    );

  if (!acceptedReview) return !reviewTaskActive;

  for (const missing of input.gateMissing) {
    if (missing === "required_approval:work_completion") return true;
    if (missing === "required_approval:publish_work_branch") return Boolean(input.publicationCommitSha);
    if (missing.startsWith("required_approval:") || missing.startsWith("approval:")) return true;
  }

  return false;
}
