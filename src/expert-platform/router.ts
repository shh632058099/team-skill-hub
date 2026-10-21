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
  repositoryId?: string;
}

export interface RouteResult {
  expertId: string;
  selectionMode: "explicit" | "auto";
}

export function routeExpert(deployments: readonly ExpertDeployment[], input: RouteInput): RouteResult {
  if (!input.principal.trim() || !input.problem.trim()) throw new Error("INVALID_REQUEST");
  if (input.expertId) {
    const expert = deployments.find((item) => item.id === input.expertId);
    if (!expert) throw new Error("EXPERT_NOT_FOUND");
    if (!expert.principals.includes(input.principal)) throw new Error("EXPERT_FORBIDDEN");
    if (!expert.active) throw new Error("EXPERT_UNAVAILABLE");
    if (input.repositoryId && !expert.repositories.includes(input.repositoryId)) {
      throw new Error("REPOSITORY_FORBIDDEN");
    }
    return { expertId: expert.id, selectionMode: "explicit" };
  }
  const eligible = deployments.filter(
    (item) =>
      item.active &&
      item.principals.includes(input.principal) &&
      (!input.repositoryId || item.repositories.includes(input.repositoryId)),
  );
  const normalizedProblem = input.problem.toLowerCase();
  const scores = eligible.map((expert) => ({
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
