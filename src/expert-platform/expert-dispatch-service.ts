import type { ExpertStore } from "./expert-store.js";
import { routeExpert } from "./router.js";
import type { ExpertTaskStore, TaskRecord } from "./task-store.js";

export interface DispatchInput {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  problem: string;
  expertId?: string;
  selectionMode?: "explicit" | "auto";
  repositoryId?: string;
}

export interface AvailableExpert {
  expertId: string;
  displayName: string;
  capabilities: string[];
  keywords: string[];
  repositoryIds: string[];
}

export class ExpertDispatchService {
  constructor(
    private readonly experts: ExpertStore,
    private readonly tasks: ExpertTaskStore,
  ) {}

  listAvailable(principalId: string): AvailableExpert[] {
    if (!principalId.trim()) throw new Error("INVALID_REQUEST");
    const available = new Map<string, AvailableExpert>();

    for (const deployment of this.experts.listDeployments()) {
      if (!deployment.active || !deployment.principals.includes(principalId)) continue;
      const definition = this.experts.getDefinition(deployment.expertId);
      if (!definition.active) continue;

      const current = available.get(definition.id) ?? {
        expertId: definition.id,
        displayName: definition.displayName,
        capabilities: definition.capabilities,
        keywords: definition.keywords,
        repositoryIds: [],
      };
      current.repositoryIds = [...new Set([...current.repositoryIds, ...deployment.repositoryIds])].sort();
      available.set(definition.id, current);
    }

    return [...available.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  submit(input: DispatchInput): TaskRecord {
    const deployments = this.experts.listDeployments();
    const candidates = deployments.flatMap((deployment) => {
      if (!deployment.active) return [];
      const definition = this.experts.getDefinition(deployment.expertId);
      if (!definition.active) return [];
      // Keep each Deployment as its own authorization tuple. Do not merge principals
      // and repositories independently, which would grant their cross product.
      return [
        {
          id: definition.id,
          capabilities: definition.capabilities,
          keywords: definition.keywords,
          repositories: deployment.repositoryIds,
          principals: deployment.principals,
          active: true,
        },
      ];
    });

    const route = routeExpert(candidates, {
      principal: input.principalId,
      problem: input.problem,
      expertId: input.expertId,
      selectionMode: input.selectionMode,
      repositoryId: input.repositoryId,
    });

    const availableRepositoryIds = [
      ...new Set(
        deployments
          .filter(
            (deployment) =>
              deployment.active &&
              deployment.expertId === route.expertId &&
              deployment.principals.includes(input.principalId) &&
              (!input.repositoryId || deployment.repositoryIds.includes(input.repositoryId)),
          )
          .flatMap((deployment) => deployment.repositories ?? [])
          .map((repository) => repository.id),
      ),
    ].sort();
    if (!input.repositoryId && availableRepositoryIds.length > 1) {
      throw new Error("REPOSITORY_REQUIRED");
    }
    const configuredRepositoryId = input.repositoryId ?? availableRepositoryIds[0];

    return this.tasks.submit({
      principalId: input.principalId,
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
      problem: input.problem,
      expertId: route.expertId,
      repositoryId: configuredRepositoryId,
      selectionMode: route.selectionMode,
      schemaVersion: 1,
    });
  }
}
