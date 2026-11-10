function hasForbiddenGitRefChar(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || "\\ ~^:?*[]".includes(character)) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
}

function safeRefPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !hasForbiddenGitRefChar(value)
  );
}

function safePrefix(prefix: string): boolean {
  return (
    prefix.length > 0 &&
    prefix.length <= 160 &&
    prefix.endsWith("/") &&
    !prefix.startsWith("/") &&
    !prefix.startsWith("refs/") &&
    !prefix.includes("..") &&
    !hasForbiddenGitRefChar(prefix)
  );
}

export function buildWorkBranchName(branchPrefix: string, workItemId: string, attemptSequence: number): string {
  if (!safePrefix(branchPrefix) || !Number.isSafeInteger(attemptSequence) || attemptSequence < 1)
    throw new Error("PUBLICATION_BRANCH_INVALID");
  const normalized = workItemId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("PUBLICATION_BRANCH_INVALID");
  const short = normalized.split("-")[0]!.slice(0, 12);
  const branchName = branchPrefix + short + "-a" + attemptSequence;
  if (!safeRefPart(branchName)) throw new Error("PUBLICATION_BRANCH_INVALID");
  return branchName;
}

export function validatePublicationBranch(input: {
  branchName: string;
  branchPrefix: string;
  defaultBranch: string;
  protectedBranches: readonly string[];
}): string {
  const branchName = input.branchName.trim();
  const branchPrefix = input.branchPrefix.trim();
  if (
    !safePrefix(branchPrefix) ||
    !safeRefPart(branchName) ||
    !branchName.startsWith(branchPrefix) ||
    branchName === input.defaultBranch ||
    input.protectedBranches.includes(branchName)
  ) {
    throw new Error("PUBLICATION_BRANCH_INVALID");
  }
  return branchName;
}

export function buildPublicationCommitMetadata(input: {
  title: string;
  workItemId: string;
  workAttemptId: string;
  sourceSubjectRevision: string;
  timestamp: number;
}): {
  authorName: "Team Skill Hub";
  authorEmail: "team-skill-hub@local.invalid";
  message: string;
  timestamp: number;
} {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0) throw new Error("INVALID_PUBLICATION_METADATA");
  const clean = (value: string, max: number): string => {
    const result = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
    if (!result || result.length > max) throw new Error("INVALID_PUBLICATION_METADATA");
    return result;
  };
  const title = clean(input.title, 200);
  const workItemId = clean(input.workItemId, 200);
  const workAttemptId = clean(input.workAttemptId, 200);
  const sourceSubjectRevision = clean(input.sourceSubjectRevision, 500);
  return {
    authorName: "Team Skill Hub",
    authorEmail: "team-skill-hub@local.invalid",
    timestamp: input.timestamp,
    message: [
      title,
      "",
      "Work-Item: " + workItemId,
      "Work-Attempt: " + workAttemptId,
      "Workspace-Revision: " + sourceSubjectRevision,
      "",
    ].join("\n"),
  };
}
