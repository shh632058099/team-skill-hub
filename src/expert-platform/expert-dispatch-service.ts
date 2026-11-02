import type { ExpertStore } from "./expert-store.js";
import { routeExpert } from "./router.js";
import type { DeploymentTaskSnapshot, ExpertTaskStore, TaskRecord } from "./task-store.js";

export interface DispatchInput {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceSessionId?: string;
  sourceClient?: string;
  problem: string;
  expertId?: string;
  selectionMode?: "explicit" | "auto";
  repositoryId?: string;
  deploymentId?: string;
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
              (!input.deploymentId || deployment.id === input.deploymentId) &&
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

    const eligible = deployments.filter(
      (deployment) =>
        deployment.active &&
        deployment.expertId === route.expertId &&
        deployment.principals.includes(input.principalId) &&
        (!input.deploymentId || deployment.id === input.deploymentId) &&
        (!configuredRepositoryId || deployment.repositoryIds.includes(configuredRepositoryId)),
    );
    const selected = input.deploymentId
      ? eligible.find((deployment) => deployment.id === input.deploymentId)
      : eligible.length === 1
        ? eligible[0]
        : undefined;
    if (!selected) throw new Error(input.deploymentId ? "DEPLOYMENT_FORBIDDEN" : "DEPLOYMENT_REQUIRED");
    const source = (selected.repositories ?? []).find((repository) => repository.id === configuredRepositoryId);
    if (selected.executor && !source) throw new Error("SOURCE_REPOSITORY_UNAVAILABLE");
    let effectiveMcp = selected.mcp ? structuredClone(selected.mcp) : undefined;
    const profileId = selected.mcp?.profileRef ?? "default";
    let profile;
    try {
      profile = this.experts.getMcpProfile(profileId);
    } catch (error) {
      if (selected.mcp?.profileRef || (error instanceof Error && error.message !== "EXPERT_MCP_PROFILE_NOT_FOUND"))
        throw error;
    }
    if (profile) {
      if (effectiveMcp && effectiveMcp.allowedTools.some((tool) => !profile!.allowedTools.includes(tool)))
        throw new Error("MCP_PROFILE_TOOL_NOT_ALLOWED");
      effectiveMcp = {
        profileRef: profile.id,
        urlOverride: effectiveMcp?.urlOverride ?? profile.url,
        credentialRef: effectiveMcp?.credentialRef ?? profile.credentialRef,
        allowedTools: effectiveMcp?.allowedTools ?? profile.allowedTools,
        required: effectiveMcp?.required ?? profile.required,
      };
    }
    const deploymentSnapshot: DeploymentTaskSnapshot | undefined =
      selected.executor && source
        ? {
            deploymentId: selected.id,
            configVersion: selected.configVersion ?? 1,
            runtimeProfile: selected.runtimeProfile,
            repository: { ...source },
            executor: structuredClone(selected.executor),
            ...(effectiveMcp ? { mcp: effectiveMcp } : {}),
          }
        : undefined;

    return this.tasks.submit({
      principalId: input.principalId,
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
      sourceSessionId: input.sourceSessionId,
      sourceClient: input.sourceClient,
      problem: input.problem,
      expertId: route.expertId,
      repositoryId: configuredRepositoryId,
      selectionMode: route.selectionMode,
      schemaVersion: deploymentSnapshot ? 2 : 1,
      ...(deploymentSnapshot ? { deploymentSnapshot } : {}),
    });
  }
}
