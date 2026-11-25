import { verifyClientSessionProof } from "./expert-platform/session-proof.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { observeReuse } from "./reuse-observability.js";
import * as z from "zod/v4";
import type { SkillHubApplicationService } from "./application.js";
import { loadClientIntegrationStatus } from "./client-integration/release.js";
import { ExpertDispatchService } from "./expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "./expert-platform/expert-store.js";
import { ExpertTaskStore } from "./expert-platform/task-store.js";
import { WorkOrchestrationStore } from "./expert-platform/work-orchestration-store.js";
import { WorkOrchestrator } from "./expert-platform/work-orchestrator.js";
import { McpWorkAdapter } from "./expert-platform/mcp-work-adapter.js";
import { WorkPublicationStore } from "./expert-platform/work-publication-store.js";
import { WorkChangeRequestStore } from "./expert-platform/work-change-request-store.js";
import { createWorkerAvailabilityProbe } from "./expert-platform/persistent-worker-registry.js";
import { workWaitRequiresHumanAction, workWaitShouldContinuePolling } from "./expert-platform/work-wait-policy.js";
import { WorkDagPlannerCoordinator, WorkDagScheduler } from "./expert-platform/work-dag-engine.js";
import {
  WorkDagPolicyContextResolver,
  createWorkDagOrganizationPolicyProviderFromEnv,
} from "./expert-platform/work-dag-policy-context.js";
import { WorkDagSeedPlanner } from "./expert-platform/work-dag-planners.js";
import { createConfiguredWorkDagPlanner } from "./expert-platform/work-dag-model-client.js";
import { WorkDagRuntime } from "./expert-platform/work-dag-runtime-service.js";
import { createExpertTaskDagAdapters } from "./expert-platform/work-dag-expert-adapters.js";
import { createControlDagAdapters } from "./expert-platform/work-dag-control-adapters.js";
import { createDeliveryDagAdapters } from "./expert-platform/work-dag-delivery-adapters.js";

export interface McpExpertRuntime {
  expertTaskStore: ExpertTaskStore | null;
  expertStore: ExpertStore | null;
  expertDispatchService: ExpertDispatchService | null;
  workOrchestrationStore: WorkOrchestrationStore | null;
  workPublicationStore: WorkPublicationStore | null;
  workChangeRequestStore: WorkChangeRequestStore | null;
  workOrchestrator: WorkOrchestrator | null;
  workDagRuntime?: WorkDagRuntime | null;
  mcpWorkAdapter: McpWorkAdapter | null;
}

function createMcpExpertRuntime(): McpExpertRuntime {
  const expertRuntimeDb = process.env.EXPERT_RUNTIME_DB?.trim();
  if (!expertRuntimeDb) {
    return {
      expertTaskStore: null,
      expertStore: null,
      expertDispatchService: null,
      workOrchestrationStore: null,
      workPublicationStore: null,
      workChangeRequestStore: null,
      workOrchestrator: null,
      workDagRuntime: null,
      mcpWorkAdapter: null,
    };
  }
  const expertTaskStore = new ExpertTaskStore(expertRuntimeDb);
  const expertStore = new ExpertStore(expertRuntimeDb);
  const expertDispatchService = new ExpertDispatchService(expertStore, expertTaskStore);
  const workOrchestrationStore = new WorkOrchestrationStore(expertRuntimeDb);
  const workPublicationStore = new WorkPublicationStore(expertRuntimeDb);
  const workChangeRequestStore = new WorkChangeRequestStore(expertRuntimeDb);
  const workerAvailability = createWorkerAvailabilityProbe(
    process.env.EXPERT_WORKER_REGISTRY_DB?.trim() || path.join(path.dirname(expertRuntimeDb), "expert-workers.sqlite"),
  );
  const workOrchestrator = new WorkOrchestrator(
    workOrchestrationStore,
    expertTaskStore,
    expertDispatchService,
    workerAvailability,
    workPublicationStore,
    workChangeRequestStore,
  );
  const dagScheduler = new WorkDagScheduler(workOrchestrationStore, [
    ...createExpertTaskDagAdapters(workOrchestrationStore, expertTaskStore, expertDispatchService),
    ...createControlDagAdapters(workOrchestrationStore, workPublicationStore),
    ...createDeliveryDagAdapters(
      workOrchestrationStore,
      workPublicationStore,
      workChangeRequestStore,
      workOrchestrator,
    ),
  ]);
  const configuredDagPlanner = createConfiguredWorkDagPlanner(process.env);
  const dagPlanner = configuredDagPlanner?.planner ?? new WorkDagSeedPlanner();
  const workDagRuntime = new WorkDagRuntime(
    workOrchestrationStore,
    new WorkDagPlannerCoordinator(
      workOrchestrationStore,
      dagPlanner,
      configuredDagPlanner?.timeoutMs ?? 30_000,
      new WorkDagPolicyContextResolver(
        workOrchestrationStore,
        expertDispatchService,
        expertStore,
        expertTaskStore,
        [],
        createWorkDagOrganizationPolicyProviderFromEnv(process.env),
      ),
    ),
    dagScheduler,
  );
  return {
    expertTaskStore,
    expertStore,
    expertDispatchService,
    workOrchestrationStore,
    workPublicationStore,
    workChangeRequestStore,
    workOrchestrator,
    workDagRuntime,
    mcpWorkAdapter: new McpWorkAdapter(workOrchestrationStore, workOrchestrator),
  };
}

async function reconcileMcpWork(
  store: WorkOrchestrationStore,
  orchestrator: WorkOrchestrator,
  dagRuntime: WorkDagRuntime | null | undefined,
  workItemId: string,
  principalId: string,
  scope: string,
) {
  const work = store.getWork(workItemId, principalId, scope);
  if (work.orchestrationEngine === "dynamic-dag") {
    if (dagRuntime) {
      await dagRuntime.reconcileUntilBoundary(workItemId, principalId, scope);
    }
    return orchestrator.getWork(workItemId, principalId, scope);
  }
  return orchestrator.reconcileWork(workItemId, principalId, scope);
}
const filterSchema = {
  domain: z.string().optional(),
  category: z.string().optional(),
  audience: z.string().optional(),
  maturity: z.enum(["experimental", "beta", "stable", "deprecated"]).optional(),
  client: z.string().min(1).optional(),
};

const workDagScalarSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);

const workDagPredicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({ kind: z.literal("fact"), key: z.string().trim().min(1).max(200), equals: workDagScalarSchema }).strict(),
  z.object({ kind: z.literal("evidence"), type: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("artifact"), type: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("subject"), revision: z.string().trim().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("no_blocker") }).strict(),
]);

const workRequirementInputSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/),
    strength: z.enum(["required", "preferred"]).default("required"),
    condition: workDagPredicateSchema,
    satisfaction: workDagPredicateSchema,
  })
  .strict();

type McpWorkRequirementInput = z.infer<typeof workRequirementInputSchema>;

const UNSUPPORTED_MCP_LIFECYCLE_EVIDENCE = new Set(["review", "verification"]);
const UNSUPPORTED_MCP_POLICY_FACTS = new Set([
  "publication_required",
  "review_required",
  "verification_required",
  "change_request_required",
]);

function validateMcpWorkRequirements(requirements: readonly McpWorkRequirementInput[]): void {
  for (const requirement of requirements) {
    const satisfaction = requirement.satisfaction;
    if (satisfaction.kind === "evidence" && UNSUPPORTED_MCP_LIFECYCLE_EVIDENCE.has(satisfaction.type)) {
      throw new Error("WORK_REQUIREMENT_UNSUPPORTED_LIFECYCLE_ALIAS:" + satisfaction.type);
    }
    if (satisfaction.kind === "fact" && UNSUPPORTED_MCP_POLICY_FACTS.has(satisfaction.key)) {
      throw new Error("WORK_REQUIREMENT_UNSUPPORTED_LIFECYCLE_ALIAS:" + satisfaction.key);
    }
  }
}

function canonicalMcpRequirements(requirements: readonly McpWorkRequirementInput[]) {
  const ids = new Set<string>();
  const normalized = requirements.map((item) => {
    if (ids.has(item.id)) throw new Error("DUPLICATE_WORK_REQUIREMENT");
    ids.add(item.id);
    return {
      id: item.id,
      source: "user" as const,
      strength: item.strength,
      condition: structuredClone(item.condition),
      satisfaction: structuredClone(item.satisfaction),
    };
  });
  return normalized.sort((a, b) => a.id.localeCompare(b.id));
}

function mcpRequirementsDigest(requirements: readonly McpWorkRequirementInput[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalMcpRequirements(requirements)))
    .digest("hex");
}

function applyMcpWorkRequirements(
  store: WorkOrchestrationStore,
  orchestrator: WorkOrchestrator,
  workItemId: string,
  principalId: string,
  scope: string,
  requirements: readonly McpWorkRequirementInput[],
  expectedWorkRevision?: number,
  expectedRequirementRevision?: number,
  unresolvedResolutions: readonly {
    unresolvedId: string;
    replacementRequirementIds: readonly string[];
  }[] = [],
) {
  validateMcpWorkRequirements(requirements);
  const work = store.getWork(workItemId, principalId, scope);
  if (expectedWorkRevision !== undefined && work.stateRevision !== expectedWorkRevision) {
    throw new Error("STALE_WORK_REVISION");
  }
  if (expectedRequirementRevision !== undefined && work.currentRequirementRevision !== expectedRequirementRevision) {
    throw new Error("STALE_REQUIREMENT_REVISION");
  }
  if (work.orchestrationEngine !== "dynamic-dag") {
    throw new Error("WORK_REQUIREMENTS_REQUIRE_DYNAMIC_DAG");
  }
  const current = store.getRequirementSnapshot(workItemId, work.currentRequirementRevision);
  const canonicalRequirements = canonicalMcpRequirements(requirements);
  const canonicalRequirementsById = new Map(canonicalRequirements.map((item) => [item.id, item] as const));
  const resolvedIds = new Set<string>();
  for (const resolution of unresolvedResolutions) {
    if (resolvedIds.has(resolution.unresolvedId)) throw new Error("DUPLICATE_UNRESOLVED_REQUIREMENT_ID");
    const unresolved = current.unresolved.find((item) => item.id === resolution.unresolvedId);
    if (!unresolved || unresolved.source !== "user") {
      throw new Error("WORK_REQUIREMENT_UNRESOLVED_NOT_RESOLVABLE:" + resolution.unresolvedId);
    }
    if (
      resolution.replacementRequirementIds.length === 0 ||
      resolution.replacementRequirementIds.some((id) => {
        const replacement = canonicalRequirementsById.get(id);
        return !replacement || replacement.strength !== "required";
      })
    ) {
      throw new Error("WORK_REQUIREMENT_RESOLUTION_REPLACEMENT_REQUIRED:" + resolution.unresolvedId);
    }
    resolvedIds.add(resolution.unresolvedId);
  }
  const desiredUnresolved = current.unresolved.filter((item) => !resolvedIds.has(item.id));
  const desired = [
    ...current.requirements.filter(
      (item) => item.source === "source" || (item.source === "user" && item.id.startsWith("user:intent:")),
    ),
    ...canonicalRequirements,
  ].sort((a, b) => a.id.localeCompare(b.id));
  const currentCanonical = [...current.requirements].sort((a, b) => a.id.localeCompare(b.id));
  if (
    JSON.stringify(currentCanonical) !== JSON.stringify(desired) ||
    JSON.stringify(current.unresolved) !== JSON.stringify(desiredUnresolved)
  ) {
    store.updateRequirementSnapshot(
      workItemId,
      principalId,
      scope,
      work.stateRevision,
      current.revision,
      desired,
      "mcp-typed-v2",
      Date.now(),
      desiredUnresolved,
    );
  }
  return orchestrator.getWork(workItemId, principalId, scope);
}
function compactSkill(skill: ReturnType<SkillHubApplicationService["listSkills"]>[number]) {
  return {
    name: skill.name,
    repository: skill.repositoryId,
    revision: skill.revision,
    version: skill.version,
    description: skill.description,
    path: skill.relativePath,
    metadata: skill.metadata,
  };
}

function compactPrompt(prompt: ReturnType<SkillHubApplicationService["listPrompts"]>[number]) {
  return {
    name: prompt.name,
    repository: prompt.repositoryId,
    revision: prompt.revision,
    version: prompt.version,
    description: prompt.description,
    path: prompt.relativePath,
    audience: prompt.audience,
    visibility: prompt.visibility,
    keywords: prompt.keywords,
    category: prompt.category,
    owner: prompt.owner,
    compatibility: prompt.compatibility,
  };
}

function compactAgent(agent: ReturnType<SkillHubApplicationService["listAgents"]>[number]) {
  return {
    name: agent.name,
    repository: agent.repositoryId,
    revision: agent.revision,
    version: agent.version,
    description: agent.description,
    path: agent.relativePath,
    audience: agent.audience,
    visibility: agent.visibility,
    keywords: agent.keywords,
    owner: agent.owner,
    skills: agent.skills,
    prompts: agent.prompts,
    tools: agent.tools,
    compatibility: agent.compatibility,
  };
}

function compactTool(tool: ReturnType<SkillHubApplicationService["listTools"]>[number]) {
  return {
    name: tool.name,
    repository: tool.repositoryId,
    revision: tool.revision,
    version: tool.version,
    description: tool.description,
    path: tool.relativePath,
    type: tool.type,
    owner: tool.owner,
    audience: tool.audience,
    visibility: tool.visibility,
    keywords: tool.keywords,
    environments: tool.environments,
    capabilities: tool.capabilities,
    permissions: tool.permissions,
    endpoints: tool.endpoints,
    authentication: tool.authentication,
    compatibility: tool.compatibility,
  };
}

function compactDiscovery(result: ReturnType<SkillHubApplicationService["discover"]>) {
  return {
    selected: result.selected,
    ambiguous: result.ambiguous,
    skills: result.skills.map((item) => ({
      ...compactSkill(item.skill),
      score: item.score,
      confidence: item.confidence,
      coverage: item.coverage,
      reason: item.reason,
    })),
    knowledge: result.knowledge.map((item) => ({
      repository: item.chunk.repositoryId,
      revision: item.chunk.revision,
      path: item.chunk.relativePath,
      title: item.chunk.title,
      metadata: item.chunk.metadata,
      chunk_index: item.chunk.chunkIndex,
      content: item.chunk.content,
      score: item.score,
      confidence: item.confidence,
      coverage: item.coverage,
      reason: item.reason,
    })),
    prompts: result.prompts.map((item) => ({
      ...compactPrompt(item.artifact),
      score: item.score,
      confidence: item.confidence,
      coverage: item.coverage,
      reason: item.reason,
    })),
    agents: result.agents.map((item) => ({
      ...compactAgent(item.artifact),
      score: item.score,
      confidence: item.confidence,
      coverage: item.coverage,
      reason: item.reason,
    })),
    tools: result.tools.map((item) => ({
      ...compactTool(item.artifact),
      score: item.score,
      confidence: item.confidence,
      coverage: item.coverage,
      reason: item.reason,
    })),
  };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function normalizeOptionalMcpIdentifier(value: string | undefined): string | undefined {
  if (value === undefined || value === ":omit:" || value === "__UNSPECIFIED__") return undefined;
  return value;
}

const WORKER_MCP_READ_ONLY_TOOLS = new Set([
  "get_server_info",
  "discover",
  "discover_scoped",
  "project_recommendations",
  "list_skill_repositories",
  "resolve_agent_tools",
  "list_skills",
  "search_skills",
  "resolve_skill",
  "get_skill",
  "get_skill_resource",
  "list_knowledge_sources",
  "search_knowledge",
  "get_knowledge",
  "list_prompts",
  "search_prompts",
  "get_prompt",
  "list_agents",
  "search_agents",
  "list_tools",
  "search_tools",
  "get_tool",
  "resolve_agent",
  "get_agent",
  "list_evaluation_suites",
  "list_evaluation_runs",
  "get_evaluation_run",
  "get_knowledge_submission_spec",
  "list_repository_revisions",
  "list_sync_audit",
  "list_available_experts",
  "get_expert_task_status",
  "get_expert_task_events",
  "wait_expert_task",
  "get_expert_task_result",
]);

const activeExpertWaits = new Map<string, number>();
function safeExpertActivityMessage(event: { type: string; tool: string | null; count: number | null }): string {
  const tool = event.tool && ["Read", "Glob", "Grep", "other"].includes(event.tool) ? event.tool : "other";
  if (event.type === "tool.activity")
    return `Worker 正在执行 ${tool} 操作${event.count ? `（${event.count} 次）` : ""}`;
  const names: Record<string, string> = {
    queued: "任务已入队",
    running: "Worker 已开始执行",
    "repository.started": "正在同步 Git 仓库",
    "repository.completed": "Git 仓库准备完成",
    "repository.failed": "Git 仓库准备失败",
    "container.started": "正在启动执行容器",
    "container.completed": "执行容器已结束",
    "model.started": "模型已启动",
    "model.active": "模型正在分析",
    "model.completed": "模型已生成结果",
    "model.failed": "模型执行失败",
    "execution.started": "Worker 开始执行",
    "execution.completed": "Worker 执行完成",
    "execution.failed": "Worker 执行失败",
    succeeded: "任务已成功",
    failed: "任务失败",
    cancelled: "任务已取消",
  };
  return names[event.type] ?? "任务状态已更新";
}

function safeWorkProgressMessage(event: { eventType: string; details: Record<string, unknown> | null }): string {
  const names: Record<string, string> = {
    "work.created": "Work 已创建",
    "work.queued": "Work 已进入队列",
    "work.running": "Work 正在执行",
    "work.rework": "Work 已进入返工",
    "work.waiting_review": "Work 正在等待 Review",
    "work.blocked": "Work 已阻塞",
    "work.resumed": "Work 已恢复执行",
    "work.completed": "Work 已完成",
    "work.failed": "Work 执行失败",
    "work.cancelled": "Work 已取消",
    "work_attempt.created": "新的 WorkAttempt 已创建",
    "work_attempt.succeeded": "WorkAttempt 已成功",
    "work_attempt.failed": "WorkAttempt 执行失败",
    "review.requested": "已请求 Review",
    "review.decided": "Review 已产生结论",
    "rework.started": "返工已开始",
    "run.retry_scheduled": "已安排执行重试",
    "run.continued": "已继续同一 WorkAttempt",
    "source.observed": "已收到外部来源状态",
    "source.reconciled": "外部来源状态已完成协调",
    "work.subject_changed": "Work 源码版本已更新",
    "approval.invalidated": "旧授权已失效",
    "evidence.staled": "旧 Evidence 已失效",
  };
  if (event.eventType === "evidence.recorded") {
    const type = typeof event.details?.type === "string" ? event.details.type : "";
    if (type === "publication") return "工作分支发布已验证";
    if (type === "pull_request") return "PR/MR 已创建并验证";
    if (type === "build") return "Build 验证已记录";
    if (type === "unit_test") return "单元测试验证已记录";
    if (type === "integration_test") return "集成测试验证已记录";
    if (type === "code_review") return "Code Review 验证已记录";
    return "新的 Work Evidence 已记录";
  }
  return names[event.eventType] ?? `Work 状态已更新：${event.eventType}`;
}

function managedWorkClientRequiresBoundSession(client: string | undefined): boolean {
  const value = client?.trim().toLowerCase() ?? "";
  return value.startsWith("claude-code") || value === "codex" || value.startsWith("codex/");
}

function assertManagedWorkSessionBinding(client: string | undefined, effectiveSessionId: string | undefined): void {
  if (managedWorkClientRequiresBoundSession(client) && !effectiveSessionId) {
    throw new Error("CLIENT_SESSION_BINDING_REQUIRED");
  }
}

function assertManagedWorkRequestBinding(
  client: string | undefined,
  effectiveSessionId: string | undefined,
  trustedSourceRequest: boolean,
): void {
  if (!managedWorkClientRequiresBoundSession(client)) return;
  if (!effectiveSessionId) throw new Error("CLIENT_SESSION_BINDING_REQUIRED");
  if (!trustedSourceRequest) throw new Error("CLIENT_SOURCE_REQUEST_BINDING_REQUIRED");
}

function workSourceRequestSlot(
  routingMode: "auto" | "explicit",
  workflowId: string | undefined,
  expertId: string | undefined,
  repositoryId: string | undefined,
  deploymentId: string | undefined,
  requirementsDigest?: string,
): string {
  const workflow = workflowId?.trim() || null;
  return routingMode === "explicit"
    ? JSON.stringify([
        "explicit",
        expertId ?? null,
        repositoryId ?? null,
        deploymentId ?? null,
        workflow,
        requirementsDigest ?? null,
      ])
    : JSON.stringify(["auto", workflow, requirementsDigest ?? null]);
}
export function createSkillHubMcpHandler(appService: SkillHubApplicationService, expertRuntime?: McpExpertRuntime) {
  const {
    expertTaskStore,
    expertStore,
    expertDispatchService,
    workOrchestrationStore,
    workPublicationStore,
    workChangeRequestStore,
    workOrchestrator,
    mcpWorkAdapter,
    workDagRuntime,
  } = expertRuntime ?? createMcpExpertRuntime();
  return createMcpHandler(({ requestInfo }) => {
    const principal = appService.authenticateRequest(requestInfo?.headers);
    const server = new McpServer({
      name: "team-skill-hub",
      version: "0.1.0",
      description: "Team shared skill registry, search and routing service.",
    });
    const requestHeaders = requestInfo?.headers;
    const explicitTraceId =
      requestHeaders?.get("x-skill-hub-trace-id") ?? requestHeaders?.get("x-trace-id") ?? undefined;
    const traceId = explicitTraceId ?? appService.newMcpTraceId();
    const sessionId = requestHeaders?.get("x-skill-hub-session-id") ?? undefined;
    const transportSessionId = requestHeaders?.get("mcp-session-id") ?? undefined;
    const credential =
      requestHeaders?.get("x-skill-hub-api-key") ??
      requestHeaders?.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const client = requestHeaders?.get("x-skill-hub-client") ?? requestHeaders?.get("user-agent") ?? undefined;

    // Tool existence is independent from authorization. All MCP tools are registered for every principal so
    // Admin can build profiles from tools/list. Invocation is still authorized by the credential principal.
    const readOnlyWorker = principal.roles.includes("worker-mcp-readonly");
    const registerTool = (name: string, definition: any, handler: (...args: any[]) => Promise<any>) => {
      return server.registerTool(name, definition as any, async (...args: any[]) => {
        if (readOnlyWorker && !WORKER_MCP_READ_ONLY_TOOLS.has(name)) {
          throw new Error("MCP_TOOL_FORBIDDEN_FOR_PRINCIPAL");
        }
        const started = performance.now();
        try {
          const result = await handler(...args);
          const call = await appService.recordMcpCall({
            traceId,
            traceExplicit: Boolean(explicitTraceId),
            sessionId,
            transportSessionId,
            client,
            tool: name,
            args: args[0],
            latencyMs: performance.now() - started,
            success: true,
            reuse: observeReuse(name, result?.structuredContent, {
              knowledgeMatchMinScore: appService.getKnowledgeMatchThreshold(),
            }),
            principal,
          });
          if (result?.structuredContent && typeof result.structuredContent === "object") {
            result.structuredContent = {
              ...result.structuredContent,
              _trace: { trace_id: call.traceId, session_id: call.sessionId, call_id: call.id },
            };
          }
          return result;
        } catch (error) {
          await appService.recordMcpCall({
            traceId,
            traceExplicit: Boolean(explicitTraceId),
            sessionId,
            transportSessionId,
            client,
            tool: name,
            args: args[0],
            latencyMs: performance.now() - started,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            principal,
          });
          throw error;
        }
      });
    };

    registerTool(
      "get_server_info",
      {
        description: "Return Team Skill Hub version and capabilities.",
        inputSchema: z.object({}),
      },
      async () => {
        const clientIntegration = await loadClientIntegrationStatus();
        return toolResult({
          server_version: "0.1.0",
          skill_schema_versions: [1],
          client_integration: clientIntegration,
          principal: {
            id: principal.id,
            roles: principal.roles,
            tenant_id: principal.tenantId,
          },
          capabilities: [
            "multi-repository",
            "sqlite-fts5-search",
            "skill-routing",
            "resource-read",
            "repository-sync",
            "repository-access-policy",
            "request-scoped-authentication",
            "sync-audit",
            "revision-history",
            "validated-revision-rollback",
            "prometheus-metrics",
            "skill-dependencies",
            "client-compatibility",
            "hybrid-routing-ready",
            "prompt-registry",
            "agent-registry",
            "usage-analytics",
            "unmatched-query-collection",
            "evaluation-framework",
            "golden-task-regression",
            "knowledge-registry",
            "knowledge-fts5-rag",
            "mcp-observability",
            "feedback-loop",
            "knowledge-candidate-inbox",
            "unified-discover",
            "tool-registry",
            "project-context-recommendations",
            "agent-tool-resolution",
          ],
        });
      },
    );

    registerTool(
      "discover",
      {
        description:
          "Discover caller-visible Team Skill Hub Skills, Knowledge, Prompts, Agents, and Tools for reference and planning. This is NOT an execution tool. If the user explicitly asks Team Skill Hub to execute engineering work (including review, fix/rework, build/test or verify), do not invoke a discovered Skill locally as a substitute; call list_workflows and then submit_work so the durable Work/DAG runtime owns execution. Repository scope is determined automatically from API Token permissions; do not pre-list, infer, or guess repositories.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, top_k, client }) => {
        const discovery = compactDiscovery(appService.discover(query, { topK: top_k ?? 5, client }, principal));
        return toolResult(
          workOrchestrator
            ? {
                ...discovery,
                executionGuidance: {
                  durableEngineeringWork:
                    "If the user asked Team Skill Hub to execute engineering work, including review -> conditional fix/rework -> verification, use list_workflows then submit_work. Skills/Prompts returned by discover are reference assets and MUST NOT replace durable Work execution.",
                },
              }
            : discovery,
        );
      },
    );

    registerTool(
      "discover_scoped",
      {
        description:
          "Discover within specific Team Skill Hub repositories ONLY when the user explicitly requested repository-limited search. Never infer repository scope from cwd, git remote, project name, task context, or model preference. If the user explicitly names a library but its repository ID is unknown, list visible repositories only to resolve that explicit request.",
        inputSchema: z.object({
          query: z.string().min(1),
          repositories: z.array(z.string().min(1)).min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, repositories, top_k, client }) =>
        toolResult(
          compactDiscovery(appService.discoverScoped(query, { repositories, topK: top_k ?? 5, client }, principal)),
        ),
    );
    registerTool(
      "project_recommendations",
      {
        description:
          "Identify the current project from cwd/git context and return a small permission-filtered set of relevant team assets.",
        inputSchema: z.object({
          cwd: z.string().optional(),
          git_remote: z.string().optional(),
          git_root: z.string().optional(),
          git_branch: z.string().optional(),
          task: z.string().optional(),
          client: z.string().min(1).optional(),
          top_k: z.number().int().min(1).max(5).optional(),
        }),
      },
      async ({ cwd, git_remote, git_root, git_branch, task, client, top_k }) => {
        const result = appService.recommendProjectContext(
          {
            cwd,
            gitRemote: git_remote,
            gitRoot: git_root,
            gitBranch: git_branch,
            task,
            client,
            topK: top_k,
          },
          principal,
        );
        return toolResult({
          project: result.project,
          profile: result.profile,
          query: result.query,
          reason: result.reason,
          skills: result.recommendations.skills.map((item) => ({
            ...compactSkill(item.skill),
            score: item.score,
            reason: item.reason,
          })),
          knowledge: result.recommendations.knowledge.map((item) => ({
            repository: item.chunk.repositoryId,
            path: item.chunk.relativePath,
            title: item.chunk.title,
            chunk_index: item.chunk.chunkIndex,
            score: item.score,
            reason: item.reason,
          })),
          prompts: result.recommendations.prompts.map((item) => ({
            ...compactPrompt(item.artifact),
            score: item.score,
            reason: item.reason,
          })),
          agents: result.recommendations.agents.map((item) => ({
            ...compactAgent(item.artifact),
            score: item.score,
            reason: item.reason,
          })),
          tools: result.recommendations.tools.map((item) => ({
            ...compactTool(item.artifact),
            score: item.score,
            reason: item.reason,
          })),
        });
      },
    );

    registerTool(
      "list_skill_repositories",
      {
        description:
          "List skill repositories visible to the current caller. This is not a prerequisite or preflight step for normal discover/search; use it only when the user asks about repositories or explicitly requests repository-limited search.",
        inputSchema: z.object({}),
      },
      async () => toolResult({ repositories: appService.listRepositories(principal) }),
    );

    registerTool(
      "resolve_agent_tools",
      {
        description:
          "Resolve an Agent's declared Tool bindings through caller permissions, client compatibility, and target environment. This returns metadata only and never invokes an external tool.",
        inputSchema: z.object({
          repository: z.string().min(1),
          agent: z.string().min(1),
          client: z.string().min(1).optional(),
          environment: z.string().min(1).optional(),
        }),
      },
      async ({ repository, agent, client, environment }) => {
        const result = appService.resolveAgentTools(repository, agent, { client, environment }, principal);
        return toolResult({
          ...result,
          bindings: result.bindings.map((binding) => ({
            reference: binding.reference,
            status: binding.status,
            reason: binding.reason,
            tool: binding.tool ? compactTool(binding.tool) : undefined,
          })),
        });
      },
    );

    registerTool(
      "list_skills",
      {
        description:
          "List caller-visible skills with optional metadata filters. Repository scope is derived automatically from the API Token permissions.",
        inputSchema: z.object(filterSchema),
      },
      async (filters) => toolResult({ skills: appService.listSkills(filters, principal).map(compactSkill) }),
    );

    registerTool(
      "search_skills",
      {
        description:
          "Search caller-visible team skills by natural-language query and metadata. Repository scope is derived automatically from the API Token permissions; do not pre-list or guess repositories.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          ...filterSchema,
        }),
      },
      async ({ query, top_k, ...filters }) =>
        toolResult({
          results: appService.searchSkills(query, filters, top_k ?? 5, principal).map((result) => ({
            ...compactSkill(result.skill),
            score: result.score,
            reason: result.reason,
          })),
        }),
    );

    registerTool(
      "resolve_skill",
      {
        description:
          "Choose the best matching caller-visible team skill for a task. Repository scope is derived automatically from the API Token permissions; do not pre-list or guess repositories.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(10).optional(),
          ...filterSchema,
        }),
      },
      async ({ query, top_k, ...filters }) => {
        const results = appService.resolveSkill(query, filters, top_k ?? 3, principal);
        const selected = results[0];
        return toolResult({
          selected_skill: selected
            ? {
                ...compactSkill(selected.skill),
                score: selected.score,
                confidence: Math.min(1, selected.score / 10),
              }
            : null,
          alternatives: results.slice(1).map((result) => ({
            ...compactSkill(result.skill),
            score: result.score,
          })),
        });
      },
    );

    registerTool(
      "get_skill",
      {
        description: "Load the complete SKILL.md for a selected skill.",
        inputSchema: z.object({
          repository: z.string().min(1),
          name: z.string().min(1),
        }),
      },
      async ({ repository, name }) => {
        const skill = appService.getSkill(repository, name, principal);
        return toolResult({
          ...compactSkill(skill),
          content: skill.content,
        });
      },
    );

    registerTool(
      "get_skill_resource",
      {
        description: "Load a referenced text resource from a selected skill.",
        inputSchema: z.object({
          repository: z.string().min(1),
          name: z.string().min(1),
          resource: z.string().min(1),
        }),
      },
      async ({ repository, name, resource }) =>
        toolResult({
          repository,
          name,
          resource,
          content: await appService.getSkillResource(repository, name, resource, principal),
        }),
    );

    registerTool(
      "list_knowledge_sources",
      {
        description:
          "List knowledge sources visible to the current caller across all repositories allowed by the API Token. Repository selection is automatic.",
        inputSchema: z.object({}),
      },
      async () => {
        const documents = appService.listKnowledgeDocuments(principal);
        const grouped = new Map<string, { repository: string; documents: number; chunks: number; paths: string[] }>();
        for (const document of documents) {
          const current = grouped.get(document.repositoryId) ?? {
            repository: document.repositoryId,
            documents: 0,
            chunks: 0,
            paths: [],
          };
          current.documents += 1;
          current.chunks += document.chunkCount;
          current.paths.push(document.relativePath);
          grouped.set(document.repositoryId, current);
        }
        return toolResult({ sources: [...grouped.values()] });
      },
    );
    registerTool(
      "search_knowledge",
      {
        description:
          "Search caller-visible internal documentation and text knowledge across all repositories allowed by the API Token. Use this for current project facts, designs, APIs, troubleshooting notes, and other document-grounded context; do not pre-list or guess repositories.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          applicability: z
            .object({
              product: z.string().optional(),
              branch: z.string().optional(),
              firmware_version: z.string().optional(),
              yocto_release: z.string().optional(),
              kernel_version: z.string().optional(),
              api_version: z.string().optional(),
              hardware_revision: z.string().optional(),
              variant: z.string().optional(),
            })
            .optional(),
        }),
      },
      async ({ query, top_k, applicability }) =>
        toolResult({
          results: appService
            .searchKnowledge(
              query,
              top_k ?? 5,
              undefined,
              principal,
              applicability
                ? {
                    product: applicability.product,
                    branch: applicability.branch,
                    firmwareVersion: applicability.firmware_version,
                    yoctoRelease: applicability.yocto_release,
                    kernelVersion: applicability.kernel_version,
                    apiVersion: applicability.api_version,
                    hardwareRevision: applicability.hardware_revision,
                    variant: applicability.variant,
                  }
                : undefined,
            )
            .map((result) => ({
              repository: result.chunk.repositoryId,
              revision: result.chunk.revision,
              path: result.chunk.relativePath,
              title: result.chunk.title,
              metadata: result.chunk.metadata,
              chunk_index: result.chunk.chunkIndex,
              content: result.chunk.content,
              score: result.score,
              reason: result.reason,
            })),
        }),
    );

    registerTool(
      "get_knowledge",
      {
        description: "Load a visible knowledge document or one exact chunk after search_knowledge selects it.",
        inputSchema: z.object({
          repository: z.string().min(1),
          path: z.string().min(1),
          chunk_index: z.number().int().min(0).optional(),
        }),
      },
      async ({ repository, path, chunk_index }) => {
        const result = appService.getKnowledge(repository, path, chunk_index, principal);
        if (result.chunk) {
          return toolResult({
            repository,
            revision: result.document.revision,
            path,
            title: result.document.title,
            metadata: result.document.metadata,
            chunk_index: result.chunk.chunkIndex,
            content: result.chunk.content,
          });
        }
        return toolResult({
          repository,
          revision: result.document.revision,
          path,
          title: result.document.title,
          metadata: result.document.metadata,
          chunk_count: result.document.chunkCount,
          content: result.document.content,
        });
      },
    );

    registerTool(
      "list_prompts",
      {
        description: "List visible reusable prompts.",
        inputSchema: z.object({ client: z.string().min(1).optional() }),
      },
      async ({ client }) => toolResult({ prompts: appService.listPrompts(client, principal).map(compactPrompt) }),
    );

    registerTool(
      "search_prompts",
      {
        description: "Search reusable prompts by task or keywords.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, top_k, client }) =>
        toolResult({
          results: appService.searchPrompts(query, top_k ?? 5, client, principal).map((result) => ({
            ...compactPrompt(result.artifact),
            score: result.score,
            reason: result.reason,
          })),
        }),
    );

    registerTool(
      "get_prompt",
      {
        description: "Load the complete reusable PROMPT.md.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) }),
      },
      async ({ repository, name }) => {
        const prompt = appService.getPrompt(repository, name, principal);
        return toolResult({ ...compactPrompt(prompt), content: prompt.content });
      },
    );

    registerTool(
      "list_agents",
      {
        description: "List visible team Agent manifests.",
        inputSchema: z.object({ client: z.string().min(1).optional() }),
      },
      async ({ client }) => toolResult({ agents: appService.listAgents(client, principal).map(compactAgent) }),
    );

    registerTool(
      "search_agents",
      {
        description: "Search team Agents by task or keywords.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, top_k, client }) =>
        toolResult({
          results: appService.searchAgents(query, top_k ?? 5, client, principal).map((result) => ({
            ...compactAgent(result.artifact),
            score: result.score,
            reason: result.reason,
          })),
        }),
    );

    registerTool(
      "list_tools",
      {
        description: "List visible registered team tools and their non-secret metadata.",
        inputSchema: z.object({ client: z.string().min(1).optional() }),
      },
      async ({ client }) => toolResult({ tools: appService.listTools(client, principal).map(compactTool) }),
    );

    registerTool(
      "search_tools",
      {
        description: "Search registered team tools by task, capability, or keywords.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, top_k, client }) =>
        toolResult({
          results: appService.searchTools(query, top_k ?? 5, client, principal).map((item) => ({
            ...compactTool(item.artifact),
            score: item.score,
            reason: item.reason,
          })),
        }),
    );

    registerTool(
      "get_tool",
      {
        description: "Load one registered team Tool manifest. Credential values are never returned.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) }),
      },
      async ({ repository, name }) => toolResult(compactTool(appService.getTool(repository, name, principal))),
    );

    registerTool(
      "resolve_agent",
      {
        description: "Resolve the best matching team Agent for a task.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(10).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, top_k, client }) => {
        const results = appService.resolveAgent(query, top_k ?? 3, client, principal);
        return toolResult({
          selected_agent: results[0] ? { ...compactAgent(results[0].artifact), score: results[0].score } : null,
          alternatives: results.slice(1).map((result) => ({
            ...compactAgent(result.artifact),
            score: result.score,
          })),
        });
      },
    );

    registerTool(
      "get_agent",
      {
        description: "Load one team Agent manifest including its Skill/Prompt/Tool bindings.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) }),
      },
      async ({ repository, name }) => toolResult(compactAgent(appService.getAgent(repository, name, principal))),
    );

    registerTool(
      "list_evaluation_suites",
      {
        description: "List deterministic golden evaluation suites for a visible repository/revision.",
        inputSchema: z.object({
          repository: z.string().min(1),
          revision: z.string().min(1).optional(),
        }),
      },
      async ({ repository, revision }) =>
        toolResult({
          repository,
          revision: revision ?? "active",
          suites: await appService.listEvaluationSuites(repository, revision, principal),
        }),
    );

    registerTool(
      "run_evaluation",
      {
        description: "Run one deterministic golden evaluation suite against a validated revision.",
        inputSchema: z.object({
          repository: z.string().min(1),
          suite: z.string().min(1),
          revision: z.string().min(1).optional(),
          baseline_revision: z.string().min(1).optional(),
        }),
      },
      async ({ repository, suite, revision, baseline_revision }) =>
        toolResult(await appService.runEvaluation(repository, suite, revision, baseline_revision, principal)),
    );

    registerTool(
      "list_evaluation_runs",
      {
        description: "List persisted evaluation runs visible to the caller.",
        inputSchema: z.object({
          repository: z.string().min(1).optional(),
          suite: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        }),
      },
      async ({ repository, suite, limit }) =>
        toolResult({
          runs: await appService.listEvaluationRuns(limit ?? 100, repository, suite, principal),
        }),
    );

    registerTool(
      "get_evaluation_run",
      {
        description: "Get one persisted evaluation run by id.",
        inputSchema: z.object({ run_id: z.string().min(1) }),
      },
      async ({ run_id }) => toolResult(await appService.getEvaluationRun(run_id, principal)),
    );

    registerTool(
      "submit_feedback",
      {
        description: "Submit explicit feedback about an MCP result, Skill, Knowledge document, Prompt, or Agent.",
        inputSchema: z.object({
          trace_id: z.string().min(1).optional(),
          call_id: z.string().min(1).optional(),
          target_type: z.enum(["skill", "knowledge", "prompt", "agent", "mcp-call"]),
          target: z.string().min(1).optional(),
          rating: z.enum(["positive", "negative"]),
          reason: z.string().max(2000).optional(),
        }),
      },
      async ({ trace_id, call_id, target_type, target, rating, reason }) =>
        toolResult({
          feedback: await appService.submitFeedback(principal, {
            traceId: trace_id,
            callId: call_id,
            targetType: target_type,
            target,
            rating,
            reason,
          }),
        }),
    );

    registerTool(
      "get_knowledge_submission_spec",
      {
        description:
          "Return the current server-managed Knowledge submission specification. Call this immediately before submit_knowledge_candidate and follow the returned template and spec_version.",
        inputSchema: z.object({ repository: z.string().min(1).optional() }),
      },
      async () => toolResult(await appService.getKnowledgeSubmissionSpec()),
    );

    registerTool(
      "submit_knowledge_candidate",
      {
        description:
          "Knowledge ONLY. Submit a Knowledge Artifact Bundle for human review using the current server specification returned by get_knowledge_submission_spec. Include that spec_version. submission_mode defaults to merge; replace explicitly replaces only the selected Knowledge artifact scope. NEVER use this tool for Skills or SKILL.md content; Skills must use submit_skill_bundle. This never publishes directly to Git.",
        inputSchema: z.object({
          trace_id: z.string().min(1).optional(),
          spec_version: z.number().int().min(1),
          title: z.string().min(1).max(200),
          content: z.string().min(1).max(50_000),
          source_type: z.enum(["mcp-session", "manual", "codex-summary", "troubleshooting", "review"]).optional(),
          repository: z.string().min(1).optional(),
          submission_mode: z.enum(["merge", "replace"]).nullish(),
        }),
      },
      async ({ trace_id, spec_version, title, content, source_type, repository, submission_mode }) =>
        toolResult({
          candidate: await appService.submitKnowledgeCandidate(principal, {
            traceId: trace_id,
            title,
            content,
            sourceType: source_type ?? "mcp-session",
            suggestedType: "knowledge",
            repository,
            submittedSpecVersion: spec_version,
            submissionMode: "mcp",
            bundleSubmissionMode: submission_mode ?? "merge",
          }),
        }),
    );

    registerTool(
      "submit_skill_bundle",
      {
        description:
          "The only MCP entrypoint for submitting Skills. submission_mode defaults to merge: submitted paths are added/updated and omitted existing files are preserved. Use submission_mode=replace only when the submitted files are the complete desired target and omitted files should be deleted. The Bundle is validated against the target repository and is never published directly.",
        inputSchema: z
          .object({
            trace_id: z.string().min(1).optional(),
            namespace: z.string().min(1).max(200),
            import_type: z.enum(["skill", "collection"]),
            skill_path: z
              .string()
              .min(1)
              .max(500)
              .optional()
              .describe(
                "Skill path relative to namespace (for example systematic-debugging). Full paths such as skills/<namespace>/<path> are also accepted and normalized.",
              ),
            skill_collection: z.literal("rd-skills"),
            repository: z.string().min(1).optional(),
            submission_mode: z.enum(["merge", "replace"]).nullish(),
            files: z
              .array(
                z
                  .object({
                    path: z.string().min(1).max(1000),
                    content: z
                      .string()
                      .max(512 * 1024)
                      .optional()
                      .describe(
                        "UTF-8 text file content. For a text file, set this field and omit content_base64 (an empty content_base64 placeholder is tolerated).",
                      ),
                    content_base64: z
                      .string()
                      .max(700 * 1024)
                      .optional()
                      .describe(
                        "Base64-encoded binary file content. For a binary file, set this field and omit content (an empty content placeholder is tolerated).",
                      ),
                    mode: z.enum(["0644", "0755"]).optional(),
                  })
                  .refine(
                    (file) => {
                      const hasTextField = file.content !== undefined;
                      const hasBinaryField = file.content_base64 !== undefined;
                      if (!hasTextField && !hasBinaryField) return false;
                      if (hasTextField && hasBinaryField && file.content !== "" && file.content_base64 !== "")
                        return false;
                      return true;
                    },
                    {
                      message:
                        "file must contain one representation: content for text or content_base64 for binary; an empty unused placeholder is allowed",
                    },
                  ),
              )
              .min(1)
              .max(500),
            source: z
              .object({ repository_url: z.string().max(2000).optional(), revision: z.string().max(500).optional() })
              .optional(),
            note: z.string().max(4000).optional(),
            submission_key: z.string().min(1).max(500).optional(),
          })
          .superRefine((input, ctx) => {
            if (input.import_type === "skill" && !input.skill_path) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["skill_path"],
                message: "skill_path is required when import_type=skill",
              });
            }
            if (input.import_type === "collection" && input.skill_path !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["skill_path"],
                message: "skill_path is not allowed when import_type=collection",
              });
            }
          }),
      },
      async (input) =>
        toolResult({
          import: await appService.submitSkillBundle(principal, {
            namespace: input.namespace,
            importType: input.import_type,
            ...(input.import_type === "skill" ? { skillPath: input.skill_path! } : {}),
            submissionMode: input.submission_mode ?? "merge",
            files: input.files.map(
              (file: { path: string; content?: string; content_base64?: string; mode?: "0644" | "0755" }) => {
                const useBinary =
                  file.content_base64 !== undefined &&
                  file.content_base64 !== "" &&
                  (file.content === undefined || file.content === "");
                return {
                  path: file.path,
                  ...(useBinary ? { contentBase64: file.content_base64 } : { content: file.content ?? "" }),
                  mode: file.mode,
                };
              },
            ),
            sourceType: "mcp",
            sourceMetadata: {
              ...(input.source?.repository_url ? { repository_url: input.source.repository_url } : {}),
              ...(input.source?.revision ? { revision: input.source.revision } : {}),
              ...(input.note ? { note: input.note } : {}),
              ...(input.trace_id ? { trace_id: input.trace_id } : {}),
            },
            submissionKey: input.submission_key,
            repository: input.repository,
          }),
        }),
    );

    registerTool(
      "sync_skill_repository",
      {
        description: "Synchronize one configured skill repository and activate it only after validation.",
        inputSchema: z.object({
          repository: z.string().min(1),
        }),
      },
      async ({ repository }) => toolResult(await appService.syncRepository(repository, "manual", principal)),
    );

    registerTool(
      "list_repository_revisions",
      {
        description: "List validated revisions available for a visible repository.",
        inputSchema: z.object({ repository: z.string().min(1) }),
      },
      async ({ repository }) =>
        toolResult({
          repository,
          revisions: await appService.listRepositoryRevisions(repository, principal),
        }),
    );

    registerTool(
      "rollback_repository_revision",
      {
        description: "Rollback a repository to a previously validated revision. Requires sync permission.",
        inputSchema: z.object({
          repository: z.string().min(1),
          revision: z.string().min(1),
        }),
      },
      async ({ repository, revision }) =>
        toolResult(await appService.rollbackRepositoryRevision(repository, revision, principal)),
    );

    registerTool(
      "list_sync_audit",
      {
        description: "List recent repository synchronization audit events.",
        inputSchema: z.object({
          repository: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        }),
      },
      async ({ repository, limit }) =>
        toolResult({
          events: await appService.listAuditEvents(limit ?? 100, repository, principal),
        }),
    );

    if (expertTaskStore) {
      registerTool(
        "list_available_experts",
        {
          description:
            "List active Expert Platform experts and repositories authorized for the current principal. Use this only when the user explicitly names an Expert, asks to list available experts, or you need exact IDs for submit_work with routingMode=explicit. New work must be submitted with submit_work; submit_expert_task and submit_expert_task_auto are deprecated compatibility tools.",
          inputSchema: z.object({}),
        },
        async () => toolResult({ experts: expertDispatchService!.listAvailable(principal.id) }),
      );

      registerTool(
        "submit_expert_task_auto",
        {
          description:
            "DEPRECATED compatibility-only ExpertTask submission tool. New Claude/Codex/MCP clients MUST use submit_work so the Hub owns the durable Work lifecycle, routing, evidence, review, rework, publication and completion gates. Keep this tool only for older integrations that have not migrated yet.",
          inputSchema: z.object({
            problem: z.string().trim().min(1).max(10000),
            idempotencyKey: z.string().min(1).max(200),
            clientSessionProof: z
              .string()
              .max(100)
              .optional()
              .describe("Client hook generated proof; do not fabricate."),
            clientSessionId: z
              .string()
              .uuid()
              .optional()
              .describe(
                "Client-injected native conversation session UUID; omit this field unless supplied by trusted client integration.",
              ),
            sourceRequestId: z
              .string()
              .regex(/^srq_[a-f0-9]{64}$/)
              .optional()
              .describe("Trusted hook-injected identity for the current native user turn; do not invent."),
          }),
        },
        async ({ problem, idempotencyKey, clientSessionId, clientSessionProof, sourceRequestId }) => {
          if (!expertDispatchService) throw new Error("EXPERT_RUNTIME_UNAVAILABLE");
          const trustedClientSession = verifyClientSessionProof(
            credential,
            clientSessionId,
            idempotencyKey,
            clientSessionProof,
          );
          const trustedSourceRequest =
            sourceRequestId !== undefined &&
            verifyClientSessionProof(
              credential,
              clientSessionId,
              idempotencyKey,
              clientSessionProof,
              Date.now(),
              sourceRequestId,
            );
          return toolResult({
            ...expertDispatchService.submit({
              principalId: principal.id,
              scope: principal.tenantId,
              idempotencyKey,
              sourceSessionId: trustedSourceRequest
                ? clientSessionId
                : (sessionId ?? transportSessionId ?? (trustedClientSession ? clientSessionId : undefined)),
              sourceClient: client?.slice(0, 200) || "mcp",
              sourceRequestId: trustedSourceRequest ? sourceRequestId : undefined,
              problem,
              selectionMode: "auto",
            }),
          });
        },
      );

      registerTool(
        "submit_expert_task",
        {
          description:
            "DEPRECATED compatibility-only ExpertTask submission tool. New clients MUST use submit_work, including explicit expert/repository/deployment routing via routingMode=explicit. Keep this tool only for older integrations that still expect a direct ExpertTask taskId.",
          inputSchema: z.object({
            problem: z.string().trim().min(1).max(10000),
            idempotencyKey: z.string().min(1).max(200),
            expertId: z.string().trim().min(1).max(200).optional(),
            selectionMode: z.enum(["auto", "explicit"]).optional(),
            repositoryId: z.string().trim().min(1).max(200).optional(),
            deploymentId: z.string().trim().min(1).max(100).optional(),
            clientSessionProof: z
              .string()
              .max(100)
              .optional()
              .describe("Client hook generated proof; do not fabricate."),
            clientSessionId: z
              .string()
              .uuid()
              .optional()
              .describe(
                "Client-injected native conversation session UUID; omit unless supplied by trusted client integration.",
              ),
            sourceRequestId: z
              .string()
              .regex(/^srq_[a-f0-9]{64}$/)
              .optional()
              .describe("Trusted hook-injected identity for the current native user turn; do not invent."),
          }),
        },
        async ({
          problem,
          idempotencyKey,
          expertId,
          selectionMode,
          repositoryId,
          deploymentId,
          clientSessionId,
          clientSessionProof,
          sourceRequestId,
        }) => {
          if (!expertDispatchService) throw new Error("EXPERT_RUNTIME_UNAVAILABLE");
          const trustedClientSession = verifyClientSessionProof(
            credential,
            clientSessionId,
            idempotencyKey,
            clientSessionProof,
          );
          const trustedSourceRequest =
            sourceRequestId !== undefined &&
            verifyClientSessionProof(
              credential,
              clientSessionId,
              idempotencyKey,
              clientSessionProof,
              Date.now(),
              sourceRequestId,
            );
          return toolResult({
            ...expertDispatchService.submit({
              principalId: principal.id,
              scope: principal.tenantId,
              idempotencyKey,
              sourceSessionId: trustedSourceRequest
                ? clientSessionId
                : (sessionId ?? transportSessionId ?? (trustedClientSession ? clientSessionId : undefined)),
              sourceClient: client?.slice(0, 200) || "mcp",
              sourceRequestId: trustedSourceRequest ? sourceRequestId : undefined,
              problem,
              expertId,
              selectionMode,
              repositoryId,
              deploymentId,
            }),
          });
        },
      );

      registerTool(
        "get_expert_task_status",
        {
          description:
            "Check the status of an Expert Platform task after submit_expert_task or when the user asks to resume a task. Use its taskId; authorization is checked on every request. If status is queued or running, wait and retry with backoff rather than polling rapidly. If status is succeeded, call get_expert_task_result; if failed or cancelled, report that state accurately.",
          inputSchema: z.object({ taskId: z.string().uuid() }),
        },
        async ({ taskId }) =>
          toolResult(expertTaskStore.getStatusWithActivity(taskId, principal.id, principal.tenantId)),
      );

      registerTool(
        "get_expert_task_events",
        {
          description:
            "Read authenticated, cursor-based Worker progress (Git sync, model and tool activity). Use after submit_expert_task; keep nextEventId for subsequent calls.",
          inputSchema: z.object({
            taskId: z.string().uuid(),
            afterEventId: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(100).default(50),
          }),
        },
        async ({ taskId, afterEventId, limit }) =>
          toolResult(expertTaskStore.ownerEvents(taskId, principal.id, principal.tenantId, afterEventId, limit)),
      );

      registerTool(
        "wait_expert_task",
        {
          description:
            "DEFAULT follow-up after submitting an Expert task when the user wants to wait. Wait up to 15 seconds for REAL Worker progress, return events and nextEventId. Repeat with nextEventId until terminal, then call get_expert_task_result on success. Do not ask the user to retry manually. Supports MCP progress notifications when the client provides a progressToken; no-token clients receive incremental long-poll results.",
          inputSchema: z.object({
            taskId: z.string().uuid(),
            afterEventId: z.number().int().min(0).default(0),
            waitMs: z.number().int().min(1000).max(30000).default(15000),
            limit: z.number().int().min(1).max(100).default(50),
          }),
        },
        async ({ taskId, afterEventId, waitMs, limit }, ctx) => {
          // Check owner before consuming wait capacity.
          expertTaskStore.get(taskId, principal.id, principal.tenantId);
          const waitKey = `${principal.tenantId}:${principal.id}`;
          const concurrent = activeExpertWaits.get(waitKey) ?? 0;
          if (concurrent >= 5) throw new Error("WAIT_LIMIT_EXCEEDED");
          activeExpertWaits.set(waitKey, concurrent + 1);
          const signal: AbortSignal = ctx.mcpReq.signal;
          const token = ctx.mcpReq._meta?.progressToken;
          const deadline = performance.now() + waitMs;
          let cursor = afterEventId;
          let notificationIndex = 0;
          const collected: ReturnType<ExpertTaskStore["ownerEvents"]>["events"] = [];
          let lastNotify = 0;
          try {
            while (true) {
              if (signal.aborted) throw new Error("WAIT_CANCELLED");
              const page = expertTaskStore.ownerEvents(
                taskId,
                principal.id,
                principal.tenantId,
                cursor,
                limit - collected.length,
              );
              collected.push(...page.events);
              cursor = page.nextEventId;
              if (token !== undefined && page.events.length && performance.now() - lastNotify >= 1000) {
                lastNotify = performance.now();
                const latest = page.events[page.events.length - 1]!;
                try {
                  await ctx.mcpReq.notify({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: ++notificationIndex,
                      message: safeExpertActivityMessage(latest),
                    },
                  });
                } catch {
                  /* notification is best-effort */
                }
              }
              const timedOut = performance.now() >= deadline;
              if (
                page.terminal ||
                collected.length >= limit ||
                timedOut ||
                (token === undefined && collected.length > 0)
              ) {
                const fresh = expertTaskStore.ownerEvents(taskId, principal.id, principal.tenantId, cursor, 1);
                return toolResult({
                  ...page,
                  events: collected,
                  nextEventId: cursor,
                  hasMore: fresh.events.length > 0,
                  status: fresh.status,
                  terminal: fresh.terminal,
                  timedOut: timedOut && !fresh.terminal,
                });
              }
              const remaining = Math.max(0, deadline - performance.now());
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => {
                    signal.removeEventListener("abort", aborted);
                    resolve();
                  },
                  Math.min(750, remaining),
                );
                const aborted = () => {
                  clearTimeout(timer);
                  signal.removeEventListener("abort", aborted);
                  reject(new Error("WAIT_CANCELLED"));
                };
                signal.addEventListener("abort", aborted, { once: true });
              });
            }
          } finally {
            const count = activeExpertWaits.get(waitKey) ?? 1;
            if (count <= 1) activeExpertWaits.delete(waitKey);
            else activeExpertWaits.set(waitKey, count - 1);
          }
        },
      );

      registerTool(
        "get_expert_task_result",
        {
          description:
            "Retrieve the persisted report and evidence for an Expert Platform task only after get_expert_task_status reports succeeded. Include the actual taskId and evidence in the answer, and distinguish verified findings from hypotheses. For an eligible unreviewed result, feedbackGuidance tells the client to present an optional feedback prompt only after the full result, at most once per task per conversation. Never submit feedback unless the user explicitly provides it. Queued or running tasks do not yet have a report.",
          inputSchema: z.object({ taskId: z.string().uuid() }),
        },
        async ({ taskId }) => {
          const { task, feedback } = expertDispatchService!.getResult(taskId, principal.id, principal.tenantId);
          return toolResult({
            ...task,
            feedback,
            ...(feedback
              ? {}
              : {
                  feedbackGuidance: {
                    prompt: "可选：这份专家结果你是已采纳、部分采纳，还是未采纳？如需返工也可以说明。",
                    tool: "submit_expert_task_feedback",
                    presentAfterFullResult: true,
                    oncePerTaskPerConversation: true,
                    explicitUserFeedbackOnly: true,
                    ambiguousTaskReference: "ask_which_result",
                  },
                }),
          });
        },
      );

      if (workOrchestrator) {
        registerTool(
          "list_workflows",
          {
            description:
              "List the current selectable Team Skill Hub Expert Platform Workflow catalog. When the user explicitly asks Team Skill Hub to execute engineering work, choose the Workflow by the user's primary requested outcome and then call submit_work; do not execute a discovered Skill locally as a substitute. Use this when intent is ambiguous or when a custom Workflow may fit better.",
            inputSchema: z.object({}),
          },
          async () =>
            toolResult({
              selectionRule:
                "Choose the Workflow by the user's primary requested outcome; incidental verification failures and secondary activities do not change the Workflow.",
              workflows: workOrchestrationStore!.listSelectableWorkflows(),
            }),
        );

        registerTool(
          "submit_work",
          {
            description:
              "PRIMARY submission tool for Team Skill Hub execution. If the user explicitly says to use Team Skill Hub to execute/do/review+fix+verify engineering work, you MUST create a durable WorkItem with submit_work instead of running a discovered Skill locally. Team Skill Hub will keep advancing the Work through DAG planning, Expert execution, evidence, review, conditional rework, verification, publication when required, and completion. Use this instead of deprecated submit_expert_task / submit_expert_task_auto for both automatic and explicit routing. After a successful submission, you MUST execute the returned followUp and must not return to the user yet: if followUp.tool=wait_work, call wait_work with followUp.arguments and continue following each response; if followUp.tool=get_work, call get_work with followUp.arguments once before replying.",
            inputSchema: z.object({
              title: z.string().trim().min(1).max(500),
              description: z.string().trim().min(1).max(10000),
              idempotencyKey: z.string().trim().min(1).max(200),
              requirements: z
                .array(workRequirementInputSchema)
                .max(200)
                .optional()
                .describe(
                  "Typed EXTRA user requirements for dynamic-dag workflows. Usually OMIT this field when the selected Workflow already captures the user's review/fix/rework/verify/no-publication lifecycle. Do NOT restate lifecycle intent as generic evidence such as review/verification or policy meta-facts such as publication_required. Use requirements only for explicit additional hard/preferred obligations the user actually stated, for example 'even if no code changes, ctest must run'. Do not encode commands or arbitrary expressions.",
                ),
              workflowId: z
                .string()
                .trim()
                .min(1)
                .max(200)
                .optional()
                .describe(
                  "Omit only for clearly read-only investigation/search/statistics/code-inspection work; omission defaults to investigation. For repository modifications, explicitly choose a code-change Workflow by the user's primary requested outcome. If intent is ambiguous or a custom Workflow may fit better, call list_workflows first. Incidental build/test failures and secondary activities do not change the primary Workflow.",
                ),
              routingMode: z
                .enum(["auto", "explicit"])
                .default("auto")
                .describe(
                  "Use auto unless the user explicitly supplied exact deployment/repository IDs. Never invent deployment IDs like writable/read-only; Workflow access requirements are routed by the Hub. In auto mode, deploymentId and repositoryId are ignored.",
                ),
              expertId: z.string().trim().min(1).max(200).optional(),
              repositoryId: z.string().trim().min(1).max(200).optional(),
              deploymentId: z.string().trim().min(1).max(200).optional(),
              priority: z.number().int().optional(),
              clientSessionId: z
                .string()
                .uuid()
                .optional()
                .describe("Trusted client hook session UUID; do not fabricate."),
              sourceRequestId: z
                .string()
                .regex(/^srq_[a-f0-9]{64}$/)
                .optional()
                .describe("Trusted hook-injected identity for the current native user turn; do not fabricate."),
              clientSessionProof: z
                .string()
                .max(100)
                .optional()
                .describe("Trusted client hook proof; do not fabricate."),
            }),
          },
          async ({
            title,
            description,
            idempotencyKey,
            requirements,
            routingMode,
            workflowId,
            expertId,
            repositoryId,
            deploymentId,
            priority,
            clientSessionId,
            sourceRequestId,
            clientSessionProof,
          }) => {
            const normalizedExpertId = normalizeOptionalMcpIdentifier(expertId);
            const normalizedRepositoryId = normalizeOptionalMcpIdentifier(repositoryId);
            const normalizedDeploymentId = normalizeOptionalMcpIdentifier(deploymentId);
            const explicitRouting = routingMode === "explicit";
            const effectiveWorkflowId = workflowId ?? "investigation";
            const requestedRequirements = requirements ?? [];
            if (requirements !== undefined) validateMcpWorkRequirements(requestedRequirements);
            const requirementsDigest =
              requirements === undefined ? undefined : mcpRequirementsDigest(requestedRequirements);
            const sourceRequestSlot = workSourceRequestSlot(
              routingMode,
              effectiveWorkflowId,
              normalizedExpertId,
              explicitRouting ? normalizedRepositoryId : undefined,
              explicitRouting ? normalizedDeploymentId : undefined,
              requirementsDigest,
            );
            const trustedClientSession = verifyClientSessionProof(
              credential,
              clientSessionId,
              idempotencyKey,
              clientSessionProof,
            );
            const trustedSourceRequest =
              sourceRequestId !== undefined &&
              verifyClientSessionProof(
                credential,
                clientSessionId,
                idempotencyKey,
                clientSessionProof,
                Date.now(),
                sourceRequestId,
              );
            const effectiveSessionId =
              transportSessionId ??
              sessionId ??
              (trustedClientSession || trustedSourceRequest ? clientSessionId : undefined);
            assertManagedWorkRequestBinding(client, effectiveSessionId, trustedSourceRequest);
            const adapter = mcpWorkAdapter!;
            let submitted = adapter.submit(
              {
                idempotencyKey,
                title,
                description,
                workflowId: effectiveWorkflowId,
                ...(requirementsDigest === undefined ? {} : { requirementsDigest }),
                ...(normalizedExpertId === undefined ? {} : { expertId: normalizedExpertId }),
                ...(explicitRouting && normalizedRepositoryId !== undefined
                  ? { repositoryId: normalizedRepositoryId }
                  : {}),
                ...(explicitRouting && normalizedDeploymentId !== undefined
                  ? { deploymentId: normalizedDeploymentId }
                  : {}),
                ...(priority === undefined ? {} : { priority }),
              },
              {
                principalId: principal.id,
                scope: principal.tenantId,
                client: client?.slice(0, 200) || "mcp",
                ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
                trustedSession:
                  Boolean(transportSessionId ?? sessionId) || trustedClientSession || trustedSourceRequest,
                ...(trustedSourceRequest && sourceRequestId ? { sourceRequestId, sourceRequestSlot } : {}),
              },
            );
            if (requirements !== undefined) {
              const updated = applyMcpWorkRequirements(
                workOrchestrationStore!,
                workOrchestrator!,
                submitted.work.workItemId,
                principal.id,
                principal.tenantId,
                requestedRequirements,
              );
              submitted = { ...updated, sourceControlToken: submitted.sourceControlToken };
            }

            const submittedHumanActionRequired = workWaitRequiresHumanAction({
              status: submitted.work.status,
              currentSubjectRevision: submitted.work.currentSubjectRevision,
              reviewTaskStatus: submitted.reviewTask?.status,
              reviews: submitted.reviews,
              gateMissing: submitted.gate.missing,
              publicationCommitSha: submitted.publication?.commitSha,
            });
            const continueWaiting = workWaitShouldContinuePolling(submitted.work.status, submittedHumanActionRequired);
            return toolResult({
              ...submitted,
              workItemId: submitted.work.workItemId,
              status: submitted.work.status,
              followUp: continueWaiting
                ? {
                    required: true,
                    tool: "wait_work",
                    arguments: {
                      workItemId: submitted.work.workItemId,
                      afterEventId: 0,
                      afterActivityEventId: 0,
                      timeoutMs: 30_000,
                    },
                  }
                : {
                    required: true,
                    tool: "get_work",
                    arguments: { workItemId: submitted.work.workItemId },
                  },
            });
          },
        );

        registerTool(
          "update_work_source",
          {
            description:
              "Update the lifecycle state of the MCP source that created a WorkItem. Requires the opaque sourceControlToken returned by submit_work; treat it as a secret capability and do not display it to the user. Trusted native session identity is checked as an additional constraint when available. A terminal signal is reconciled by WorkOrchestrator; running execution is cancelled safely, while waiting_review is retained for human review by the default source policy.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              sourceControlToken: z
                .string()
                .regex(/^wsc_[A-Za-z0-9_-]{40,}$/)
                .describe("Opaque Work source capability returned by submit_work. Do not display it to the user."),
              state: z.enum(["active", "terminal"]),
              detail: z.string().trim().max(4000).optional(),
              clientSessionId: z
                .string()
                .uuid()
                .optional()
                .describe("Trusted client hook session UUID; do not fabricate."),
              clientSessionProof: z
                .string()
                .max(100)
                .optional()
                .describe("Trusted client hook proof; do not fabricate."),
            }),
          },
          async ({ workItemId, sourceControlToken, state, detail, clientSessionId, clientSessionProof }) => {
            const trustedClientSession = verifyClientSessionProof(
              credential,
              clientSessionId,
              workItemId,
              clientSessionProof,
            );
            const effectiveSessionId =
              transportSessionId ?? sessionId ?? (trustedClientSession ? clientSessionId : undefined);
            assertManagedWorkSessionBinding(client, effectiveSessionId);
            return toolResult(
              mcpWorkAdapter!.updateSource(
                workItemId,
                { state, sourceControlToken, ...(detail === undefined ? {} : { detail }) },
                {
                  principalId: principal.id,
                  scope: principal.tenantId,
                  client: client?.slice(0, 200) || "mcp",
                  ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
                  trustedSession: Boolean(transportSessionId ?? sessionId) || trustedClientSession,
                },
              ),
            );
          },
        );

        registerTool(
          "get_work",
          {
            description:
              "Get and reconcile one WorkItem owned by the authenticated principal. Returns current Work state, WorkAttempts, current ExpertTask, Run/Turn history, current Workspace, verification summary, evidence and Completion Gate.",
            inputSchema: z.object({ workItemId: z.string().uuid() }),
          },
          async ({ workItemId }) =>
            toolResult(
              await reconcileMcpWork(
                workOrchestrationStore!,
                workOrchestrator!,
                workDagRuntime,
                workItemId,
                principal.id,
                principal.tenantId,
              ),
            ),
        );

        registerTool(
          "wait_work",
          {
            description:
              "MANDATORY follow-up after submit_work. Wait for durable WorkItem progress using a compact incremental response. Start with afterActivityEventId=0, then use the returned followUp.arguments exactly. While followUp.tool=wait_work, you MUST continue calling wait_work and must not return to the user while the Work is still active. Pass nextEventId + nextActivityEventId to stream Worker/model/tool and Reviewer activity; omitting afterActivityEventId preserves legacy Work-only waiting. With an MCP progressToken it emits notifications/progress while waiting. Without a progressToken, activity-aware calls return as soon as a new Work or activity event appears. When the response switches followUp.tool to get_work because terminal=true or humanActionRequired=true, call get_work once for the full Work snapshot, result, Evidence, Workspace and verification details before replying to the user.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              afterEventId: z.number().int().min(0).default(0),
              afterActivityEventId: z.number().int().min(0).optional(),
              timeoutMs: z.number().int().min(0).max(30000).default(30000),
              limit: z.number().int().min(1).max(100).default(50),
            }),
          },
          async ({ workItemId, afterEventId, afterActivityEventId, timeoutMs, limit }, ctx) => {
            workOrchestrator.getWork(workItemId, principal.id, principal.tenantId);
            const signal: AbortSignal = ctx.mcpReq.signal;
            const token = ctx.mcpReq._meta?.progressToken;
            const deadline = performance.now() + timeoutMs;
            let cursor = afterEventId;
            const trackActivity = afterActivityEventId !== undefined || token !== undefined;
            let activityCursor = afterActivityEventId ?? 0;
            let notificationIndex = 0;
            let lastNotify = Number.NEGATIVE_INFINITY;
            const collected: ReturnType<WorkOrchestrator["getEvents"]>["events"] = [];
            const activityEvents: Array<{
              eventId: number;
              taskId: string;
              role: "execution" | "review";
              runId: string | null;
              type: string;
              details: string;
              tool: string | null;
              count: number | null;
              timestampMs: number;
            }> = [];
            let detail = await reconcileMcpWork(
              workOrchestrationStore!,
              workOrchestrator!,
              workDagRuntime,
              workItemId,
              principal.id,
              principal.tenantId,
            );

            const readActivity = (after: number, remaining: number) => {
              const refs = [
                ...(detail.currentTask ? [{ task: detail.currentTask, role: "execution" as const }] : []),
                ...(detail.reviewTask ? [{ task: detail.reviewTask, role: "review" as const }] : []),
              ];
              const seen = new Set<string>();
              return refs
                .filter(({ task }) => {
                  if (seen.has(task.taskId)) return false;
                  seen.add(task.taskId);
                  return true;
                })
                .flatMap(({ task, role }) =>
                  expertTaskStore
                    .ownerEvents(task.taskId, principal.id, principal.tenantId, after, Math.max(1, remaining))
                    .events.map((event) => ({ ...event, taskId: task.taskId, role })),
                )
                .sort((a, b) => a.eventId - b.eventId)
                .slice(0, remaining);
            };

            while (true) {
              if (signal.aborted) throw new Error("WAIT_CANCELLED");
              const workRemaining = Math.max(1, limit - collected.length);
              const page = workOrchestrator.getEvents(
                workItemId,
                principal.id,
                principal.tenantId,
                cursor,
                workRemaining,
              );
              collected.push(...page.events);
              cursor = page.nextEventId;

              detail = await reconcileMcpWork(
                workOrchestrationStore!,
                workOrchestrator!,
                workDagRuntime,
                workItemId,
                principal.id,
                principal.tenantId,
              );
              const activityRemaining = Math.max(1, limit - activityEvents.length);
              const newActivity = trackActivity ? readActivity(activityCursor, activityRemaining) : [];
              activityEvents.push(...newActivity);
              if (newActivity.length) activityCursor = newActivity[newActivity.length - 1]!.eventId;

              if (
                token !== undefined &&
                (page.events.length || newActivity.length) &&
                performance.now() - lastNotify >= 1000
              ) {
                lastNotify = performance.now();
                const latestWork = page.events.at(-1);
                const latestActivity = newActivity.at(-1);
                const useActivity =
                  latestActivity !== undefined &&
                  (latestWork === undefined || latestActivity.timestampMs >= latestWork.createdAt);
                const message = useActivity
                  ? `${latestActivity!.role === "review" ? "Reviewer" : "Worker"}：${safeExpertActivityMessage(latestActivity!)}`
                  : safeWorkProgressMessage(latestWork!);
                try {
                  await ctx.mcpReq.notify({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: ++notificationIndex,
                      message,
                    },
                  });
                } catch {
                  /* notification is best-effort */
                }
              }

              const terminal = ["completed", "failed", "cancelled"].includes(detail.work.status);
              const humanActionRequired = workWaitRequiresHumanAction({
                status: detail.work.status,
                currentSubjectRevision: detail.work.currentSubjectRevision,
                reviewTaskStatus: detail.reviewTask?.status,
                reviews: detail.reviews,
                gateMissing: detail.gate.missing,
                publicationCommitSha: detail.publication?.commitSha,
              });
              const active = workWaitShouldContinuePolling(detail.work.status, humanActionRequired);
              const timedOut = performance.now() >= deadline;
              const hasIncrementalProgress = page.events.length > 0 || newActivity.length > 0;
              if (
                terminal ||
                !active ||
                collected.length >= limit ||
                activityEvents.length >= limit ||
                timedOut ||
                (token === undefined && hasIncrementalProgress)
              ) {
                const moreWork = workOrchestrator.getEvents(workItemId, principal.id, principal.tenantId, cursor, 1)
                  .events.length;
                const moreActivity = trackActivity ? readActivity(activityCursor, 1).length : 0;
                const compactTask = (task: typeof detail.currentTask) =>
                  task
                    ? {
                        taskId: task.taskId,
                        status: task.status,
                        expertId: task.expertId,
                        repositoryId: task.repositoryId,
                        deploymentId: task.deploymentId,
                        runId: task.runId,
                        runtimeSessionId: task.runtimeSessionId,
                        commitSha: task.commitSha,
                        workspaceKey: task.workspaceKey,
                      }
                    : null;
                return toolResult({
                  work: {
                    workItemId: detail.work.workItemId,
                    status: detail.work.status,
                    stateRevision: detail.work.stateRevision,
                    workflowId: detail.work.workflowId,
                    workflowVersion: detail.work.workflowVersion,
                    activeWorkAttemptId: detail.work.activeWorkAttemptId,
                    currentSubjectRevision: detail.work.currentSubjectRevision,
                    requestedExpertId: detail.work.requestedExpertId,
                    requestedDeploymentId: detail.work.requestedDeploymentId,
                    repositoryId: detail.work.repositoryId,
                    blockedReason: detail.work.blockedReason,
                    blockedContext: detail.work.blockedContext,
                    resumeCondition: detail.work.resumeCondition,
                    blockedByType: detail.work.blockedByType,
                    blockedByRef: detail.work.blockedByRef,
                    nextActionType: detail.work.nextActionType,
                    updatedAt: detail.work.updatedAt,
                    completedAt: detail.work.completedAt,
                  },
                  currentTask: compactTask(detail.currentTask),
                  reviewTask: compactTask(detail.reviewTask),
                  gate: {
                    ready: detail.gate.ready,
                    missing: detail.gate.missing,
                  },
                  events: collected,
                  nextEventId: cursor,
                  hasMore: moreWork > 0,
                  activityEvents,
                  nextActivityEventId: activityCursor,
                  activityHasMore: moreActivity > 0,
                  followUp: active
                    ? {
                        required: true,
                        tool: "wait_work",
                        arguments: {
                          workItemId,
                          afterEventId: cursor,
                          ...(trackActivity ? { afterActivityEventId: activityCursor } : {}),
                          timeoutMs: 30_000,
                        },
                      }
                    : {
                        required: true,
                        tool: "get_work",
                        arguments: { workItemId },
                      },
                  terminal,
                  humanActionRequired,
                  timedOut: timedOut && !terminal,
                });
              }

              const remaining = Math.max(0, deadline - performance.now());
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => {
                    signal.removeEventListener("abort", aborted);
                    resolve();
                  },
                  Math.min(500, remaining),
                );
                const aborted = () => {
                  clearTimeout(timer);
                  signal.removeEventListener("abort", aborted);
                  reject(new Error("WAIT_CANCELLED"));
                };
                signal.addEventListener("abort", aborted, { once: true });
              });
            }
          },
        );
        registerTool(
          "review_work",
          {
            description:
              "Submit an explicit Work review decision for the current subject revision. accepted can satisfy the human-review Completion Gate; rework creates a new WorkAttempt; rejected terminates the Work. This is distinct from ExpertTask feedback.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
              subjectRevision: z.string().trim().min(1).max(500),
              decision: z.enum(["accepted", "rework", "rejected"]),
              reason: z.string().trim().max(4000).optional(),
            }),
          },
          async ({ workItemId, expectedRevision, subjectRevision, decision, reason }) => {
            workOrchestrator.submitReview(workItemId, principal.id, principal.tenantId, {
              expectedRevision,
              subjectRevision,
              decision,
              ...(reason === undefined ? {} : { reason }),
            });
            return toolResult(
              await reconcileMcpWork(
                workOrchestrationStore!,
                workOrchestrator!,
                workDagRuntime,
                workItemId,
                principal.id,
                principal.tenantId,
              ),
            );
          },
        );

        registerTool(
          "approve_work",
          {
            description:
              "Record an explicit human authorization decision for either the exact current writable Workspace revision or an exact prepared Publication Artifact. This never grants runtime write permission, push permission is artifact-specific, and approval must never be inferred or self-approved by an agent. Only authenticated admin/developer principals may approve.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
              subjectRevision: z.string().trim().min(1).max(500),
              approvalScope: z.enum(["work_completion", "publish_work_branch"]),
              decision: z.enum(["approved", "rejected"]),
            }),
          },
          async ({ workItemId, expectedRevision, subjectRevision, approvalScope, decision }) => {
            const approvalRole = principal.roles.includes("admin")
              ? "admin"
              : principal.roles.includes("developer")
                ? "developer"
                : null;
            if (!approvalRole) throw new Error("WORK_APPROVAL_FORBIDDEN");
            workOrchestrator.submitApproval(
              workItemId,
              principal.id,
              principal.tenantId,
              {
                expectedRevision,
                subjectRevision,
                approvalScope,
                decision,
              },
              { actor: principal.id, role: approvalRole },
            );
            return toolResult(
              await reconcileMcpWork(
                workOrchestrationStore!,
                workOrchestrator!,
                workDagRuntime,
                workItemId,
                principal.id,
                principal.tenantId,
              ),
            );
          },
        );

        registerTool(
          "record_work_evidence",
          {
            description:
              "Record explicit human/external evidence for a WorkItem. Evidence is bound to a WorkAttempt and current subject revision; stale evidence cannot satisfy Completion Gate. Agent self-reported evidence is not accepted through this user-facing tool.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              workAttemptId: z.string().uuid(),
              type: z.string().trim().min(1).max(200),
              status: z.enum(["pending", "passed", "failed", "unknown"]),
              source: z.enum(["human_verified", "external_verified"]),
              subjectRevision: z.string().trim().min(1).max(500),
              summary: z.string().trim().max(4000).optional(),
              artifactRef: z.string().trim().max(2000).optional(),
              environmentIdentity: z.string().trim().max(1000).optional(),
              verifierIdentity: z.string().trim().max(1000).optional(),
            }),
          },
          async ({
            workItemId,
            workAttemptId,
            type,
            status,
            source,
            subjectRevision,
            summary,
            artifactRef,
            environmentIdentity,
            verifierIdentity,
          }) =>
            toolResult(
              workOrchestrator.recordEvidence(workItemId, principal.id, principal.tenantId, {
                workAttemptId,
                type,
                status,
                source,
                subjectRevision,
                ...(summary === undefined ? {} : { summary }),
                ...(artifactRef === undefined ? {} : { artifactRef }),
                ...(environmentIdentity === undefined ? {} : { environmentIdentity }),
                ...(verifierIdentity === undefined ? {} : { verifierIdentity }),
              }),
            ),
        );

        registerTool(
          "update_work_requirements",
          {
            description:
              "Replace the authenticated user's typed requirements for a Dynamic DAG WorkItem while preserving source-derived and mandatory policy obligations. unresolvedResolutions must explicitly map each user-origin unresolved hard requirement to one or more typed replacement requirement IDs supplied in the same update. Requires current Work and Requirement revisions; semantic changes create an immutable RequirementSnapshot and cause re-plan.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
              expectedRequirementRevision: z.number().int().min(1),
              requirements: z.array(workRequirementInputSchema).max(200),
              unresolvedResolutions: z
                .array(
                  z.object({
                    unresolvedId: z.string().trim().min(1).max(200),
                    replacementRequirementIds: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
                  }),
                )
                .max(200)
                .optional(),
            }),
          },
          async ({ workItemId, expectedRevision, expectedRequirementRevision, requirements, unresolvedResolutions }) =>
            toolResult(
              applyMcpWorkRequirements(
                workOrchestrationStore!,
                workOrchestrator!,
                workItemId,
                principal.id,
                principal.tenantId,
                requirements,
                expectedRevision,
                expectedRequirementRevision,
                unresolvedResolutions ?? [],
              ),
            ),
        );

        registerTool(
          "request_work_replan",
          {
            description:
              "Request a bounded Planner re-plan for a dynamic-dag WorkItem without supplying or installing a DAG directly. The request is durable and deduplicated while pending; Runtime consumes it through the normal Planner -> Policy Validator -> CAS path.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
              reason: z.string().trim().min(1).max(2000),
            }),
          },
          async ({ workItemId, expectedRevision, reason }) => {
            const request = workOrchestrationStore!.requestDagReplan(
              workItemId,
              principal.id,
              principal.tenantId,
              expectedRevision,
              reason,
            );
            return toolResult({
              request,
              work: workOrchestrator!.getWork(workItemId, principal.id, principal.tenantId),
            });
          },
        );

        registerTool(
          "signal_work_wait",
          {
            description:
              "Signal a durable Dynamic DAG Wait node owned by the authenticated principal. eventId is the external event's stable deduplication identity; replaying the same event is idempotent, while late events after cancel/supersession are audited and ignored.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              correlationKey: z.string().trim().min(1).max(500),
              eventId: z.string().trim().min(1).max(300),
              payload: z.unknown().optional(),
            }),
          },
          async ({ workItemId, correlationKey, eventId, payload }) => {
            workOrchestrationStore!.getWork(workItemId, principal.id, principal.tenantId);
            const wait = workOrchestrationStore!
              .listDagWaits(workItemId)
              .find((item) => item.correlationKey === correlationKey);
            if (!wait) throw new Error("DAG_WAIT_NOT_FOUND");
            const signaled = workOrchestrationStore!.signalDagWait(correlationKey, payload ?? null, eventId);
            return toolResult({
              wait: signaled,
              work: await reconcileMcpWork(
                workOrchestrationStore!,
                workOrchestrator!,
                workDagRuntime,
                workItemId,
                principal.id,
                principal.tenantId,
              ),
            });
          },
        );

        registerTool(
          "resolve_work_dag_unknown",
          {
            description:
              "Manually reconcile a Dynamic DAG execution whose external side-effect outcome is unknown. Requires the current Work revision. Use succeeded only after independently verifying the external action occurred; otherwise use failed so policy can re-plan safely.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              nodeExecutionId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
              outcome: z.enum(["succeeded", "failed"]),
              reason: z.string().trim().min(1).max(2000),
            }),
          },
          async ({ workItemId, nodeExecutionId, expectedRevision, outcome, reason }) => {
            const work = workOrchestrationStore!.getWork(workItemId, principal.id, principal.tenantId);
            if (work.stateRevision !== expectedRevision) throw new Error("STALE_WORK_REVISION");
            const execution = workOrchestrationStore!
              .listDagExecutions(workItemId)
              .find((item) => item.nodeExecutionId === nodeExecutionId);
            if (!execution) throw new Error("DAG_EXECUTION_NOT_FOUND");
            const resolvedExecution = workOrchestrationStore!.resolveUnknownDagExecution(
              nodeExecutionId,
              outcome,
              reason,
              Date.now(),
              expectedRevision,
            );
            const current = workOrchestrationStore!.getWork(workItemId, principal.id, principal.tenantId);
            if (current.status === "blocked" && current.blockedReason === "DAG_EXTERNAL_OUTCOME_UNKNOWN") {
              workOrchestrator!.resumeWork(workItemId, principal.id, principal.tenantId, current.stateRevision);
            }
            const detail = await reconcileMcpWork(
              workOrchestrationStore!,
              workOrchestrator!,
              workDagRuntime,
              workItemId,
              principal.id,
              principal.tenantId,
            );
            return toolResult({ ...detail, resolvedExecution });
          },
        );
        registerTool(
          "resume_work",
          {
            description:
              "Explicitly resume a blocked WorkItem after its external blocker has been addressed. The current WorkItem revision is required; resume revalidates durable orchestration and Workspace ownership before any dispatch.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
            }),
          },
          async ({ workItemId, expectedRevision }) => {
            workOrchestrator.resumeWork(workItemId, principal.id, principal.tenantId, expectedRevision);
            return toolResult(
              await reconcileMcpWork(
                workOrchestrationStore!,
                workOrchestrator!,
                workDagRuntime,
                workItemId,
                principal.id,
                principal.tenantId,
              ),
            );
          },
        );

        registerTool(
          "cancel_work",
          {
            description:
              "Cancel a WorkItem owned by the authenticated principal. Cancellation propagates to its current ExpertTask and closes the active WorkAttempt.",
            inputSchema: z.object({ workItemId: z.string().uuid() }),
          },
          async ({ workItemId }) =>
            toolResult(workOrchestrator.cancelWork(workItemId, principal.id, principal.tenantId)),
        );
      }

      registerTool(
        "submit_expert_task_feedback",
        {
          description:
            "Record explicit user feedback for a succeeded Expert Platform task owned by the authenticated principal and tenant. Call only after the user clearly states whether the result was adopted, partially adopted, or not adopted. Do not infer feedback from silence, result viewing, unrelated replies, or ambiguous references; ask which task/result the user means when more than one could apply. A later explicit submission replaces the current feedback for that task.",
          inputSchema: z.object({
            taskId: z.string().uuid(),
            disposition: z.enum(["adopted", "partially_adopted", "not_adopted"]),
            reason: z.string().trim().max(4000).optional(),
            needsRework: z.boolean().optional(),
          }),
        },
        async ({ taskId, disposition, reason, needsRework }) => {
          const feedbackInput = {
            disposition,
            ...(reason === undefined ? {} : { reason }),
            ...(needsRework === undefined ? {} : { needsRework }),
          };
          const feedback = expertDispatchService!.submitFeedback(
            taskId,
            principal.id,
            principal.tenantId,
            feedbackInput,
          );
          const linkedWork = workOrchestrator?.handleTaskFeedback(
            taskId,
            principal.id,
            principal.tenantId,
            feedbackInput,
          );
          const reconciledWork =
            linkedWork?.work.orchestrationEngine === "dynamic-dag"
              ? await reconcileMcpWork(
                  workOrchestrationStore!,
                  workOrchestrator!,
                  workDagRuntime,
                  linkedWork.work.workItemId,
                  principal.id,
                  principal.tenantId,
                )
              : linkedWork;
          return toolResult({
            feedback,
            ...(reconciledWork ? { work: reconciledWork } : {}),
          });
        },
      );

      registerTool(
        "cancel_expert_task",
        {
          description:
            "Cancel a queued Expert Platform task immediately, or request cancellation of a running task. For a running task this signals its owning Worker; the task becomes cancelled after the Worker stops its execution. Check status to confirm completion of cancellation.",
          inputSchema: z.object({ taskId: z.string().uuid() }),
        },
        async ({ taskId }) => {
          const task = expertTaskStore.get(taskId, principal.id, principal.tenantId);
          return toolResult({ ...expertTaskStore.cancel(taskId, principal.id, principal.tenantId) });
        },
      );
    }

    return server;
  });
}

export interface SkillHubMcpToolCatalogEntry {
  name: string;
  description?: string;
}

export async function listSkillHubMcpTools(
  appService: SkillHubApplicationService,
  expertRuntime?: McpExpertRuntime,
): Promise<SkillHubMcpToolCatalogEntry[]> {
  const catalogService = new Proxy(appService, {
    get(target, property, receiver) {
      if (property === "authenticateRequest") {
        return () => ({ id: "admin-mcp-catalog", roles: ["admin", "internal", "developer"], tenantId: "default" });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SkillHubApplicationService;
  const handler = createSkillHubMcpHandler(catalogService, expertRuntime);
  try {
    const response = await handler.fetch(
      new Request("http://team-skill-hub.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    if (!response.ok) throw new Error("MCP_TOOL_CATALOG_UNAVAILABLE");
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine ? dataLine.slice(6) : body) as {
      result?: { tools?: Array<{ name?: unknown; description?: unknown }> };
    };
    return (payload.result?.tools ?? [])
      .filter((tool): tool is { name: string; description?: string } => typeof tool.name === "string")
      .map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    await handler.close();
  }
}
