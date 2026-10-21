import type { ExpertStore } from "./expert-store.js";
import { routeExpert } from "./router.js";
import type { ExpertTaskStore, TaskRecord } from "./task-store.js";

export interface DispatchInput {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  problem: string;
  expertId?: string;
  repositoryId?: string;
}

export class ExpertDispatchService {
  constructor(
    private readonly experts: ExpertStore,
    private readonly tasks: ExpertTaskStore,
  ) {}

  submit(input: DispatchInput): TaskRecord {
    const deployments = this.experts.listDeployments();
    const merged = new Map<
      string,
      {
        id: string;
        capabilities: string[];
        keywords: string[];
        repositories: string[];
        principals: string[];
        active: boolean;
      }
    >();

    for (const deployment of deployments) {
      if (!deployment.active) continue;
      const definition = this.experts.getDefinition(deployment.expertId);
      if (!definition.active) continue;
      const current = merged.get(definition.id) ?? {
        id: definition.id,
        capabilities: definition.capabilities,
        keywords: definition.keywords,
        repositories: [],
        principals: [],
        active: definition.active,
      };
      current.repositories = [...new Set([...current.repositories, ...deployment.repositoryIds])];
      current.principals = [...new Set([...current.principals, ...deployment.principals])];
      current.active = true;
      merged.set(definition.id, current);
    }

    const route = routeExpert([...merged.values()], {
      principal: input.principalId,
      problem: input.problem,
      expertId: input.expertId,
      repositoryId: input.repositoryId,
    });

    return this.tasks.submit({
      principalId: input.principalId,
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
      problem: input.problem,
      expertId: route.expertId,
      repositoryId: input.repositoryId,
      selectionMode: route.selectionMode,
      schemaVersion: 1,
    });
  }
}
