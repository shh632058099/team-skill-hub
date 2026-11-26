import type { ExpertDispatchService, ResolvedDispatch } from "./expert-dispatch-service.js";
import type { ExpertStore } from "./expert-store.js";
import type { ExpertTaskStore } from "./task-store.js";
import type { WorkItemRecord, WorkOrchestrationStore, WorkflowDefinition } from "./work-orchestration-store.js";
import { canonicalResourceIdentity, stableDigest, type DagKind, type DagObligation } from "./work-dag.js";
import { normalizeVerificationPolicy } from "./verification-policy.js";
import { requirementRoutingProblems, resolveRequirementRouting } from "./work-dag-requirements.js";

export interface WorkDagOrganizationPolicyContext {
  ref: string;
  digest: string;
  allowedNodeKinds: DagKind[];
}

export interface WorkDagRepositoryPolicyContext {
  repositoryId: string;
  policyDigest: string;
  verificationCapabilities: string[];
  requiredEvidence?: string[];
  publicationPermissions: string[];
}

export interface WorkDagDeploymentPolicyContext {
  deploymentId: string;
  configVersion: number;
  expertId: string;
  runtimeProfile: string;
  digest: string;
}

export interface WorkDagResourcePolicyContext {
  repository: WorkDagRepositoryPolicyContext;
  deployment: WorkDagDeploymentPolicyContext;
  executorCapabilities: Readonly<Record<DagKind, readonly string[]>>;
}
export interface WorkDagExternalActionPolicyContext {
  capability: string;
  mutates: boolean;
  resourcePrefix?: string;
}
export interface WorkDagPolicyLimits {
  maxReplans: number;
  maxReworks: number;
  maxTurnsPerRun: number;
}

export interface WorkDagPolicyUsage {
  replansUsed: number;
  reworksUsed: number;
  continuationTurns: number;
}

export interface WorkDagPolicyContext {
  workflowRef: string;
  workflowDigest: string;
  executionConstraints?: {
    workspaceMutation: "allowed" | "forbidden" | "unspecified";
  };
  organization: WorkDagOrganizationPolicyContext;
  repository: WorkDagRepositoryPolicyContext | null;
  deployment: WorkDagDeploymentPolicyContext | null;
  executorCapabilities: Record<DagKind, string[]>;
  externalActionPolicies?: Record<string, WorkDagExternalActionPolicyContext>;
  resourcePolicies?: Record<string, WorkDagResourcePolicyContext>;
  limits: WorkDagPolicyLimits;
  usage: WorkDagPolicyUsage;
  routingIssue?: string;
  digest: string;
}

const ALL_KINDS: DagKind[] = [
  "agent",
  "verification",
  "review",
  "approval",
  "publication",
  "change_request",
  "wait",
  "external_action",
];
export interface WorkDagOrganizationPolicyProvider {
  resolve(work: Pick<WorkItemRecord, "principalId" | "scope">): WorkDagOrganizationPolicyContext;
}

function normalizeOrganizationPolicy(input: {
  ref: string;
  allowedNodeKinds: readonly DagKind[];
}): WorkDagOrganizationPolicyContext {
  const ref = input.ref.trim();
  if (!ref || ref.length > 200) throw new Error("INVALID_DAG_ORGANIZATION_POLICY");
  const allowed = [...new Set(input.allowedNodeKinds)];
  if (allowed.length === 0 || allowed.some((kind) => !ALL_KINDS.includes(kind))) {
    throw new Error("INVALID_DAG_ORGANIZATION_POLICY");
  }
  allowed.sort();
  const value = { ref, allowedNodeKinds: allowed };
  return { ...value, digest: stableDigest(value) };
}

export class StaticWorkDagOrganizationPolicyProvider implements WorkDagOrganizationPolicyProvider {
  private readonly policy: WorkDagOrganizationPolicyContext;

  constructor(
    input: { ref: string; allowedNodeKinds: readonly DagKind[] } = {
      ref: "organization:default@1",
      allowedNodeKinds: ALL_KINDS,
    },
  ) {
    this.policy = normalizeOrganizationPolicy(input);
  }

  resolve(_work: Pick<WorkItemRecord, "principalId" | "scope">): WorkDagOrganizationPolicyContext {
    return structuredClone(this.policy);
  }
}

const DEFAULT_ORGANIZATION_POLICY_PROVIDER = new StaticWorkDagOrganizationPolicyProvider();

export function createWorkDagOrganizationPolicyProviderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): WorkDagOrganizationPolicyProvider {
  const ref = env.WORK_DAG_ORGANIZATION_POLICY_REF?.trim() || "organization:default@1";
  const rawKinds = env.WORK_DAG_ORGANIZATION_ALLOWED_NODE_KINDS?.trim();
  if (!rawKinds) return new StaticWorkDagOrganizationPolicyProvider({ ref, allowedNodeKinds: ALL_KINDS });
  const kinds = rawKinds
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as DagKind[];
  return new StaticWorkDagOrganizationPolicyProvider({ ref, allowedNodeKinds: kinds });
}

function defaultOrganizationPolicy(): WorkDagOrganizationPolicyContext {
  return DEFAULT_ORGANIZATION_POLICY_PROVIDER.resolve({ principalId: "platform", scope: "default" });
}
function legacyWorkspaceMutationConstraint(workflow: WorkflowDefinition): "allowed" | "forbidden" | "unspecified" {
  if (workflow.change?.mode === "readonly") return "forbidden";
  if (workflow.change?.mode === "code_change" || workflow.change?.mode === "conditional_code_change") return "allowed";
  return "unspecified";
}

function limits(workflow: WorkflowDefinition): WorkDagPolicyLimits {
  return {
    maxReplans: workflow.planning?.maxReplans ?? 12,
    maxReworks: workflow.lifecycle.attempt.maxReworks,
    maxTurnsPerRun: workflow.lifecycle.continuation.maxTurnsPerRun,
  };
}

function defaultCapabilities(): Record<DagKind, string[]> {
  return {
    agent: ["*"],
    verification: ["*"],
    review: ["review"],
    approval: ["work_completion", "publish_work_branch"],
    publication: ["*"],
    change_request: ["*"],
    wait: ["*"],
    external_action: [],
  };
}

function finalize(input: Omit<WorkDagPolicyContext, "digest"> | WorkDagPolicyContext): WorkDagPolicyContext {
  const { usage: _usage, digest: _previousDigest, ...pinnedPolicy } = input as WorkDagPolicyContext;
  return { ...input, digest: stableDigest(pinnedPolicy) };
}

export function withExternalActionCapabilities(
  context: WorkDagPolicyContext,
  policies: readonly WorkDagExternalActionPolicyContext[],
): WorkDagPolicyContext {
  const normalized = Object.fromEntries(
    policies
      .map((policy) => ({
        capability: policy.capability.trim(),
        mutates: policy.mutates,
        ...(policy.resourcePrefix ? { resourcePrefix: policy.resourcePrefix.trim() } : {}),
      }))
      .filter((policy) => policy.capability)
      .sort((left, right) => left.capability.localeCompare(right.capability))
      .map((policy) => [policy.capability, policy]),
  );
  return finalize({
    ...context,
    externalActionPolicies: normalized,
    executorCapabilities: {
      ...context.executorCapabilities,
      external_action: Object.keys(normalized).sort(),
    },
  });
}

export function workDagPolicyContextRef(context: WorkDagPolicyContext): string {
  const resources = Object.entries(context.resourcePolicies ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + "=" + value.repository.policyDigest + ":" + value.deployment.digest)
    .join(",");
  return [
    context.workflowRef,
    context.organization.ref,
    context.repository?.repositoryId ?? "no-repository",
    context.deployment ? context.deployment.deploymentId + "@" + context.deployment.configVersion : "no-deployment",
    resources || "no-resource-policies",
  ].join("|");
}
export function workflowOnlyDagPolicyContext(
  workflowId: string,
  workflowVersion: number,
  workflow: WorkflowDefinition,
  usage: WorkDagPolicyUsage = { replansUsed: 0, reworksUsed: 0, continuationTurns: 0 },
  organization: WorkDagOrganizationPolicyContext = defaultOrganizationPolicy(),
): WorkDagPolicyContext {
  return finalize({
    workflowRef: workflowId + "@" + workflowVersion,
    workflowDigest: stableDigest(workflow),
    executionConstraints: {
      workspaceMutation: legacyWorkspaceMutationConstraint(workflow),
    },
    organization: structuredClone(organization),
    repository: null,
    deployment: null,
    executorCapabilities: defaultCapabilities(),
    externalActionPolicies: {},

    limits: limits(workflow),
    usage,
  });
}

function repositoryRequiredEvidence(resolved: ResolvedDispatch): string[] {
  const steps = normalizeVerificationPolicy(
    resolved.deploymentSnapshot?.repository?.verificationPolicy?.required ?? [],
  );
  return [...new Set(steps.map((step) => step.evidenceType))].sort();
}

function configuredVerificationCapabilities(workflow: WorkflowDefinition, resolved: ResolvedDispatch): string[] {
  const steps = normalizeVerificationPolicy([
    ...workflow.validation.required,
    ...(resolved.deploymentSnapshot?.repository?.verificationPolicy?.required ?? []),
  ]);
  return [...new Set(steps.flatMap((step) => [step.id, step.evidenceType]))].sort();
}

function configuredPublicationCapabilities(resolved: ResolvedDispatch): {
  permissions: string[];
  capabilities: string[];
} {
  const permissions = [...(resolved.deploymentSnapshot?.repository?.publicationPolicy?.permissions ?? [])].sort();
  const capabilities: string[] = [];
  if (permissions.includes("prepare-commit")) capabilities.push("prepare");
  if (permissions.includes("push-work-branch")) capabilities.push("push");
  return { permissions, capabilities };
}

function preferredBackend(work: WorkItemRecord): "claude" | "codex" | undefined {
  const source = (work.sourceScope ?? "").split("/", 1)[0]!.toLowerCase();
  if (source.includes("claude")) return "claude";
  if (source.includes("codex")) return "codex";
  return undefined;
}

function boundedCode(error: unknown): string {
  if (!(error instanceof Error)) return "POLICY_CONTEXT_UNAVAILABLE";
  const code = error.message.trim().split(/[:\s]/, 1)[0] ?? "";
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : "POLICY_CONTEXT_UNAVAILABLE";
}

function resolvedResourcePolicy(
  workflow: WorkflowDefinition,
  resolved: ResolvedDispatch,
  expertCapabilities: readonly string[],
  externalActionCapabilities: readonly string[],
): WorkDagResourcePolicyContext | null {
  const repositorySnapshot = resolved.deploymentSnapshot?.repository ?? null;
  if (!repositorySnapshot) return null;
  const verificationCapabilities = configuredVerificationCapabilities(workflow, resolved);
  const publication = configuredPublicationCapabilities(resolved);
  const repository: WorkDagRepositoryPolicyContext = {
    repositoryId: repositorySnapshot.id,
    policyDigest: stableDigest({
      id: repositorySnapshot.id,
      verificationPolicy: repositorySnapshot.verificationPolicy ?? null,
      publicationPolicy: repositorySnapshot.publicationPolicy ?? null,
    }),
    verificationCapabilities,
    requiredEvidence: repositoryRequiredEvidence(resolved),
    publicationPermissions: publication.permissions,
  };
  const deployment: WorkDagDeploymentPolicyContext = {
    deploymentId: resolved.deploymentId,
    configVersion: resolved.deploymentConfigVersion,
    expertId: resolved.expertId,
    runtimeProfile: resolved.runtimeProfile ?? "",
    digest: stableDigest({
      deploymentId: resolved.deploymentId,
      configVersion: resolved.deploymentConfigVersion,
      expertId: resolved.expertId,
      expertCapabilities,
      runtimeProfile: resolved.runtimeProfile ?? null,
      deploymentSnapshot: resolved.deploymentSnapshot ?? null,
    }),
  };
  return {
    repository,
    deployment,
    executorCapabilities: {
      agent: ["*"],
      verification: verificationCapabilities.length ? verificationCapabilities : [],
      review: ["review"],
      approval: ["work_completion", "publish_work_branch"],
      publication: publication.capabilities,
      change_request: publication.permissions.includes("create-change-request") ? ["create"] : [],
      wait: ["*"],
      external_action: [...new Set(externalActionCapabilities)].sort(),
    },
  };
}

export function policyContextObligations(
  baseObligations: readonly DagObligation[],
  context: WorkDagPolicyContext,
): DagObligation[] {
  const conditionalMutation = baseObligations.some(
    (obligation) =>
      obligation.condition.kind === "fact" &&
      obligation.condition.key === "workspace.changed" &&
      obligation.condition.equals === true,
  );
  const mutationContract =
    conditionalMutation ||
    baseObligations.some(
      (obligation) =>
        (obligation.satisfaction.kind === "evidence" &&
          (obligation.satisfaction.type === "build" || obligation.satisfaction.type === "unit_test")) ||
        (obligation.satisfaction.kind === "fact" &&
          obligation.satisfaction.equals === true &&
          (obligation.satisfaction.key === "workspace.changed" ||
            obligation.satisfaction.key === "publication.succeeded" ||
            obligation.satisfaction.key === "change_request.created")),
    );
  if (!mutationContract) return [];
  const result: DagObligation[] = [];
  const seen = new Set<string>();
  const primaryResource = context.repository ? "repo:" + context.repository.repositoryId : null;
  const addRepository = (resource: string, repository: WorkDagRepositoryPolicyContext | null | undefined) => {
    if (!repository) return;
    const canonicalResource = canonicalResourceIdentity(resource, primaryResource) ?? resource;
    for (const evidenceType of repository.requiredEvidence ?? []) {
      const semanticKey = repository.repositoryId + ":" + evidenceType + ":" + canonicalResource;
      if (seen.has(semanticKey)) continue;
      seen.add(semanticKey);
      const id = "policy:repository:" + repository.repositoryId + ":evidence:" + evidenceType + ":resource:" + resource;
      result.push({
        id,
        condition: conditionalMutation
          ? { kind: "fact", key: "workspace.changed", equals: true }
          : { kind: "resource_active" },
        satisfaction: { kind: "evidence", type: evidenceType },
        resource,
      });
    }
  };
  addRepository("workspace", context.repository);
  for (const [resource, policy] of Object.entries(context.resourcePolicies ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    addRepository(resource, policy.repository);
  }
  return result;
}

export class WorkDagPolicyContextResolver {
  constructor(
    private readonly workStore: WorkOrchestrationStore,
    private readonly dispatch: ExpertDispatchService,
    private readonly experts: ExpertStore,
    private readonly tasks?: ExpertTaskStore,
    private readonly externalActionPolicies: readonly WorkDagExternalActionPolicyContext[] = [],
    private readonly organizationPolicyProvider: WorkDagOrganizationPolicyProvider = DEFAULT_ORGANIZATION_POLICY_PROVIDER,
  ) {}
  resolve(
    work: WorkItemRecord,
    workflow: { workflowId: string; version: number; definition: WorkflowDefinition },
  ): WorkDagPolicyContext {
    const attempts = this.workStore.listAttempts(work.workItemId);
    const reworksUsed = attempts.filter(
      (attempt) => attempt.reason === "human_rework" || attempt.reason === "review_rework",
    ).length;
    const plannerFailures = this.workStore
      .listDagDecisions(work.workItemId)
      .filter((decision) => decision.action === "planner.failed").length;
    const usage: WorkDagPolicyUsage = {
      replansUsed: this.workStore.listDagProposals(work.workItemId).length + plannerFailures,
      reworksUsed,
      continuationTurns: 0,
    };
    const activeAttempt = attempts.find((attempt) => attempt.workAttemptId === work.activeWorkAttemptId);
    if (activeAttempt && this.tasks) {
      try {
        usage.continuationTurns = this.tasks.reservedAgentTurnsForWorkAttempt(
          activeAttempt.workAttemptId,
          work.principalId,
          work.scope,
        );
      } catch {
        usage.continuationTurns = 0;
      }
    }

    const organization = this.organizationPolicyProvider.resolve(work);
    const base = workflowOnlyDagPolicyContext(
      workflow.workflowId,
      workflow.version,
      workflow.definition,
      usage,
      organization,
    );
    const requirementSnapshot =
      work.currentRequirementRevision > 0
        ? this.workStore.getRequirementSnapshot(work.workItemId, work.currentRequirementRevision)
        : null;
    const resolveForProblem = (problem: string) =>
      this.dispatch.resolve({
        principalId: work.principalId,
        scope: work.scope,
        problem,
        ...(work.requestedExpertId
          ? { expertId: work.requestedExpertId, selectionMode: "explicit" as const }
          : { selectionMode: "auto" as const }),
        ...(work.repositoryId ? { repositoryId: work.repositoryId } : {}),
        ...(work.requestedDeploymentId ? { deploymentId: work.requestedDeploymentId } : {}),
        ...(preferredBackend(work) ? { preferredBackend: preferredBackend(work) } : {}),
      });
    let resolved: ResolvedDispatch;
    try {
      resolved = requirementSnapshot
        ? resolveRequirementRouting(requirementSnapshot, resolveForProblem)
        : resolveForProblem(work.description);
    } catch (error) {
      return finalize({ ...base, routingIssue: boundedCode(error) });
    }

    const definition = this.experts.getDefinition(resolved.expertId);
    const primaryPolicy = resolvedResourcePolicy(
      workflow.definition,
      resolved,
      definition.capabilities,
      this.externalActionPolicies.map((policy) => policy.capability),
    );
    const resourcePolicies: Record<string, WorkDagResourcePolicyContext> = {};
    const selectedDeployment = this.experts.getDeployment(resolved.deploymentId);
    for (const repositoryId of selectedDeployment.repositoryIds) {
      try {
        const repositoryResolved =
          repositoryId === resolved.repositoryId
            ? resolved
            : this.dispatch.resolve({
                principalId: work.principalId,
                scope: work.scope,
                problem: requirementSnapshot
                  ? (requirementRoutingProblems(requirementSnapshot)[0] ?? work.description)
                  : work.description,
                expertId: resolved.expertId,
                selectionMode: "explicit",
                repositoryId,
                deploymentId: resolved.deploymentId,
              });
        const resourcePolicy = resolvedResourcePolicy(
          workflow.definition,
          repositoryResolved,
          definition.capabilities,
          this.externalActionPolicies.map((policy) => policy.capability),
        );
        if (resourcePolicy) resourcePolicies["repo:" + repositoryId] = resourcePolicy;
      } catch {
        // Configured but non-resolvable repositories are omitted. Nodes targeting
        // them are rejected deterministically by the validator.
      }
    }
    const fallbackCapabilities: Record<DagKind, string[]> = {
      ...defaultCapabilities(),
      external_action: [...new Set(this.externalActionPolicies.map((policy) => policy.capability))].sort(),
    };
    const primaryCapabilities = Object.fromEntries(
      ALL_KINDS.map((kind) => [kind, [...(primaryPolicy?.executorCapabilities[kind] ?? fallbackCapabilities[kind])]]),
    ) as Record<DagKind, string[]>;
    return finalize({
      ...base,
      repository: primaryPolicy?.repository ?? null,
      deployment: primaryPolicy?.deployment ?? null,
      executorCapabilities: primaryCapabilities,
      externalActionPolicies: Object.fromEntries(
        this.externalActionPolicies
          .map((policy) => structuredClone(policy))
          .sort((left, right) => left.capability.localeCompare(right.capability))
          .map((policy) => [policy.capability, policy]),
      ),
      resourcePolicies,
    });
  }
}
