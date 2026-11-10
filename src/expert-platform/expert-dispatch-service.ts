import type { ExpertStore } from "./expert-store.js";
import { routeExpert } from "./router.js";
import type { DeploymentTaskSnapshot, ExpertTaskFeedbackInput, ExpertTaskStore, TaskRecord } from "./task-store.js";
import type { VerificationPolicyStep } from "./verification-policy.js";

export interface DispatchInput {
  principalId: string;
  scope: string;
  idempotencyKey: string;
  sourceSessionId?: string;
  sourceClient?: string;
  sourceRequestId?: string;
  problem: string;
  expertId?: string;
  selectionMode?: "explicit" | "auto";
  repositoryId?: string;
  deploymentId?: string;
  workItemId?: string;
  workAttemptId?: string;
  workflowId?: string;
  workflowVersion?: number;
  workspaceKey?: string;
  validationSnapshot?: VerificationPolicyStep[];
  requiredRuntimeProfile?: string;
}

export interface AvailableExpert {
  expertId: string;
  displayName: string;
  capabilities: string[];
  keywords: string[];
  repositoryIds: string[];
}

export interface ResolvedDispatch {
  expertId: string;
  selectionMode: "explicit" | "auto";
  repositoryId?: string;
  deploymentId: string;
  deploymentConfigVersion: number;
  runtimeProfile?: string;
  deploymentSnapshot?: DeploymentTaskSnapshot;
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

  resolve(input: Omit<DispatchInput, "idempotencyKey"> & { idempotencyKey?: string }): ResolvedDispatch {
    const deployments = this.experts.listDeployments();
    const candidates = deployments.flatMap((deployment) => {
      if (!deployment.active) return [];
      const definition = this.experts.getDefinition(deployment.expertId);
      if (!definition.active) return [];
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
    const requiredRuntimeProfile = input.requiredRuntimeProfile?.trim() || undefined;
    const availableRepositoryIds = [
      ...new Set(
        deployments
          .filter(
            (deployment) =>
              deployment.active &&
              deployment.expertId === route.expertId &&
              deployment.principals.includes(input.principalId) &&
              (!input.deploymentId || deployment.id === input.deploymentId) &&
              (!requiredRuntimeProfile || deployment.runtimeProfile === requiredRuntimeProfile) &&
              (!input.repositoryId || deployment.repositoryIds.includes(input.repositoryId)),
          )
          .flatMap((deployment) => deployment.repositories ?? [])
          .map((repository) => repository.id),
      ),
    ].sort();
    if (!input.repositoryId && availableRepositoryIds.length > 1) throw new Error("REPOSITORY_REQUIRED");
    const configuredRepositoryId = input.repositoryId ?? availableRepositoryIds[0];
    const eligibleBase = deployments.filter(
      (deployment) =>
        deployment.active &&
        deployment.expertId === route.expertId &&
        deployment.principals.includes(input.principalId) &&
        (!input.deploymentId || deployment.id === input.deploymentId) &&
        (!configuredRepositoryId || deployment.repositoryIds.includes(configuredRepositoryId)),
    );
    if (
      input.deploymentId &&
      requiredRuntimeProfile &&
      eligibleBase.some((deployment) => deployment.id === input.deploymentId) &&
      eligibleBase.find((deployment) => deployment.id === input.deploymentId)?.runtimeProfile !== requiredRuntimeProfile
    ) {
      throw new Error("RUNTIME_PROFILE_MISMATCH");
    }
    const eligible = requiredRuntimeProfile
      ? eligibleBase.filter((deployment) => deployment.runtimeProfile === requiredRuntimeProfile)
      : eligibleBase;
    const selected = input.deploymentId
      ? eligible.find((deployment) => deployment.id === input.deploymentId)
      : eligible.length === 1
        ? eligible[0]
        : undefined;
    if (!selected) {
      if (requiredRuntimeProfile && !input.deploymentId) throw new Error("RUNTIME_PROFILE_UNAVAILABLE");
      throw new Error(input.deploymentId ? "DEPLOYMENT_FORBIDDEN" : "DEPLOYMENT_REQUIRED");
    }
    const source = (selected.repositories ?? []).find((repository) => repository.id === configuredRepositoryId);
    if (selected.executor && !source) throw new Error("SOURCE_REPOSITORY_UNAVAILABLE");
    const configuredMcp = selected.mcp;
    const profileId = configuredMcp?.profileRef ?? "default";
    let profile;
    try {
      profile = this.experts.getMcpProfile(profileId);
    } catch (error) {
      if (configuredMcp || (error instanceof Error && error.message !== "EXPERT_MCP_PROFILE_NOT_FOUND")) throw error;
    }
    let effectiveMcp: DeploymentTaskSnapshot["mcp"];
    if (profile) {
      if (
        configuredMcp?.allowedTools &&
        configuredMcp.allowedTools.some((tool) => !profile!.allowedTools.includes(tool))
      ) {
        throw new Error("MCP_PROFILE_TOOL_NOT_ALLOWED");
      }
      effectiveMcp = {
        profileRef: profile.id,
        urlOverride: configuredMcp?.urlOverride ?? profile.url,
        credentialRef: configuredMcp?.credentialRef ?? profile.credentialRef,
        allowedTools: configuredMcp?.allowedTools ?? profile.allowedTools,
        required: configuredMcp?.required ?? profile.required,
      };
    } else if (configuredMcp?.credentialRef && configuredMcp.allowedTools) {
      effectiveMcp = {
        ...configuredMcp,
        credentialRef: configuredMcp.credentialRef,
        allowedTools: configuredMcp.allowedTools,
        required: configuredMcp.required ?? false,
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
    return {
      expertId: route.expertId,
      selectionMode: route.selectionMode,
      ...(configuredRepositoryId ? { repositoryId: configuredRepositoryId } : {}),
      deploymentId: selected.id,
      deploymentConfigVersion: selected.configVersion ?? 1,
      runtimeProfile: selected.runtimeProfile,
      ...(deploymentSnapshot ? { deploymentSnapshot } : {}),
    };
  }
  submit(input: DispatchInput): TaskRecord {
    // Resolve an already-active auto delegation before attempting to route a
    // rephrased problem. Router availability/scoring must not defeat idempotency.
    const autoSourceRequestSlot = JSON.stringify(["auto", input.repositoryId ?? null]);
    if ((input.selectionMode ?? "auto") === "auto" && input.sourceRequestId) {
      const existing = this.tasks.findActiveSourceRequest({ ...input, sourceRequestSlot: autoSourceRequestSlot });
      if (existing) return existing;
    }
    const resolved = this.resolve(input);
    return this.submitResolved(input, resolved);
  }

  submitResolved(input: DispatchInput, resolved: ResolvedDispatch): TaskRecord {
    const autoSourceRequestSlot = JSON.stringify(["auto", input.repositoryId ?? null]);
    return this.tasks.submit({
      principalId: input.principalId,
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
      sourceSessionId: input.sourceSessionId,
      sourceClient: input.sourceClient,
      sourceRequestId: input.sourceRequestId,
      workItemId: input.workItemId,
      workAttemptId: input.workAttemptId,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      workspaceKey: input.workspaceKey,
      validationSnapshot: input.validationSnapshot,
      problem: input.problem,
      expertId: resolved.expertId,
      repositoryId: resolved.repositoryId,
      selectionMode: resolved.selectionMode,
      deploymentId: resolved.deploymentId,
      sourceRequestSlot:
        resolved.selectionMode === "auto"
          ? autoSourceRequestSlot
          : JSON.stringify([resolved.expertId, resolved.repositoryId ?? null, resolved.deploymentId]),
      schemaVersion: resolved.deploymentSnapshot ? 2 : 1,
      ...(resolved.deploymentSnapshot ? { deploymentSnapshot: resolved.deploymentSnapshot } : {}),
    });
  }

  getResult(taskId: string, principalId: string, scope: string) {
    const task = this.tasks.get(taskId, principalId, scope);
    if (task.status !== "succeeded") throw new Error("TASK_NOT_READY");
    return { task, feedback: this.tasks.getFeedback(taskId, principalId, scope) };
  }

  submitFeedback(taskId: string, principalId: string, scope: string, input: ExpertTaskFeedbackInput) {
    return this.tasks.submitFeedback(taskId, principalId, scope, input);
  }
}
