export interface ExpertDeployment {
  id: string;
  capabilities: string[];
  keywords: string[];
  repositories: string[];
  principals: string[];
  active: boolean;
}

interface RouteInput {
  principal: string;
  problem: string;
  expertId?: string;
  selectionMode?: "explicit" | "auto";
  repositoryId?: string;
}

export interface RouteResult {
  expertId: string;
  selectionMode: "explicit" | "auto";
}

function deploymentMatches(deployment: ExpertDeployment, input: RouteInput): boolean {
  return (
    deployment.active &&
    deployment.principals.includes(input.principal) &&
    (!input.repositoryId || deployment.repositories.includes(input.repositoryId))
  );
}

export function routeExpert(deployments: readonly ExpertDeployment[], input: RouteInput): RouteResult {
  if (!input.principal.trim() || !input.problem.trim()) throw new Error("INVALID_REQUEST");
  if (input.selectionMode === "explicit" && !input.expertId) throw new Error("EXPERT_ID_REQUIRED");
  if (input.selectionMode === "auto" && input.expertId) throw new Error("EXPERT_ID_NOT_ALLOWED_FOR_AUTO");
  if (input.selectionMode !== undefined && input.selectionMode !== "explicit" && input.selectionMode !== "auto") {
    throw new Error("INVALID_REQUEST");
  }
  if (input.expertId) {
    const matchingExpert = deployments.filter((item) => item.id === input.expertId);
    if (matchingExpert.length === 0) throw new Error("EXPERT_NOT_FOUND");
    if (!matchingExpert.some((item) => item.principals.includes(input.principal))) throw new Error("EXPERT_FORBIDDEN");
    if (!matchingExpert.some((item) => item.active)) throw new Error("EXPERT_UNAVAILABLE");
    if (!matchingExpert.some((item) => deploymentMatches(item, input))) {
      if (input.repositoryId) throw new Error("REPOSITORY_FORBIDDEN");
      throw new Error("EXPERT_UNAVAILABLE");
    }
    return { expertId: input.expertId, selectionMode: "explicit" };
  }

  // Score each expert once, but only if one single deployment grants this principal
  // access to the requested repository. Never cross-product principals and repositories.
  const eligibleByExpert = new Map<string, ExpertDeployment>();
  for (const deployment of deployments) {
    if (deploymentMatches(deployment, input) && !eligibleByExpert.has(deployment.id)) {
      eligibleByExpert.set(deployment.id, deployment);
    }
  }
  const normalizedProblem = input.problem.toLowerCase();
  const scores = [...eligibleByExpert.values()].map((expert) => ({
    expert,
    score: [...new Set([...expert.capabilities, ...expert.keywords].map((word) => word.toLowerCase()))].reduce(
      (sum, word) => sum + (normalizedProblem.includes(word) ? 1 : 0),
      0,
    ),
  }));
  scores.sort((a, b) => b.score - a.score || a.expert.id.localeCompare(b.expert.id));
  if (!scores[0] || scores[0].score === 0) throw new Error("EXPERT_UNAVAILABLE");
  if (scores[1] && scores[1].score === scores[0].score) throw new Error("AMBIGUOUS_EXPERT");
  return { expertId: scores[0].expert.id, selectionMode: "auto" };
}
