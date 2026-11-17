import { verifyClientSessionProof } from "./expert-platform/session-proof.js";
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

// The experimental task API is opt-in until an isolated Worker runtime is provisioned.
const expertRuntimeDb = process.env.EXPERT_RUNTIME_DB?.trim();
const expertTaskStore = expertRuntimeDb ? new ExpertTaskStore(expertRuntimeDb) : null;
const expertStore = expertRuntimeDb ? new ExpertStore(expertRuntimeDb) : null;
const expertDispatchService =
  expertTaskStore && expertStore ? new ExpertDispatchService(expertStore, expertTaskStore) : null;
const workOrchestrationStore = expertRuntimeDb ? new WorkOrchestrationStore(expertRuntimeDb) : null;
const workPublicationStore = expertRuntimeDb ? new WorkPublicationStore(expertRuntimeDb) : null;
const workChangeRequestStore = expertRuntimeDb ? new WorkChangeRequestStore(expertRuntimeDb) : null;
const workerAvailability = expertRuntimeDb
  ? createWorkerAvailabilityProbe(
      process.env.EXPERT_WORKER_REGISTRY_DB?.trim() ||
        path.join(path.dirname(expertRuntimeDb), "expert-workers.sqlite"),
    )
  : undefined;
const workOrchestrator =
  workOrchestrationStore && expertTaskStore && expertDispatchService
    ? new WorkOrchestrator(
        workOrchestrationStore,
        expertTaskStore,
        expertDispatchService,
        workerAvailability,
        workPublicationStore ?? undefined,
        workChangeRequestStore ?? undefined,
      )
    : null;
const mcpWorkAdapter =
  workOrchestrationStore && workOrchestrator ? new McpWorkAdapter(workOrchestrationStore, workOrchestrator) : null;
const filterSchema = {
  repositories: z.array(z.string()).optional(),
  domain: z.string().optional(),
  category: z.string().optional(),
  audience: z.string().optional(),
  maturity: z.enum(["experimental", "beta", "stable", "deprecated"]).optional(),
  client: z.string().min(1).optional(),
};

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
): string {
  const workflow = workflowId?.trim() || null;
  return routingMode === "explicit"
    ? JSON.stringify(["explicit", expertId ?? null, repositoryId ?? null, deploymentId ?? null, workflow])
    : JSON.stringify(["auto", workflow]);
}

export function createSkillHubMcpHandler(appService: SkillHubApplicationService) {
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
          "Discover the most relevant visible team Skills, Knowledge, Prompts, and Agents for one task in a single request.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          repositories: z.array(z.string()).optional(),
          client: z.string().min(1).optional(),
        }),
      },
      async ({ query, top_k, repositories, client }) => {
        const result = appService.discover(query, { topK: top_k ?? 5, repositories, client }, principal);
        return toolResult({
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
        });
      },
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
        description: "List skill repositories visible to the current caller.",
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
        description: "List visible skills with optional metadata filters.",
        inputSchema: z.object(filterSchema),
      },
      async (filters) => toolResult({ skills: appService.listSkills(filters, principal).map(compactSkill) }),
    );

    registerTool(
      "search_skills",
      {
        description: "Search team skills by natural-language query and metadata.",
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
        description: "Choose the best matching team skill for a task.",
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
        description: "List repository knowledge documents visible to the current caller.",
        inputSchema: z.object({
          repositories: z.array(z.string()).optional(),
        }),
      },
      async ({ repositories }) => {
        const documents = appService.listKnowledgeDocuments(principal, repositories);
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
          "Search internal repository documentation and text knowledge. Use this for current project facts, designs, APIs, troubleshooting notes, and other document-grounded context.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          repositories: z.array(z.string()).optional(),
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
      async ({ query, top_k, repositories, applicability }) =>
        toolResult({
          results: appService
            .searchKnowledge(
              query,
              top_k ?? 5,
              repositories,
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
          "submit_work",
          {
            description:
              "PRIMARY submission tool for all new Expert Platform work. Submit a durable engineering WorkItem that Team Skill Hub will keep advancing through Expert execution, evidence, review, rework, publication and completion. Use this instead of deprecated submit_expert_task / submit_expert_task_auto for both automatic and explicit routing.",
            inputSchema: z.object({
              title: z.string().trim().min(1).max(500),
              description: z.string().trim().min(1).max(10000),
              idempotencyKey: z.string().trim().min(1).max(200),
              workflowId: z.string().trim().min(1).max(200).optional(),
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
            const sourceRequestSlot = workSourceRequestSlot(
              routingMode,
              workflowId,
              normalizedExpertId,
              explicitRouting ? normalizedRepositoryId : undefined,
              explicitRouting ? normalizedDeploymentId : undefined,
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
            const submitted = adapter.submit(
              {
                idempotencyKey,
                title,
                description,
                ...(workflowId === undefined ? {} : { workflowId }),
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
            return toolResult({
              ...submitted,
              workItemId: submitted.work.workItemId,
              status: submitted.work.status,
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
            toolResult(workOrchestrator.reconcileWork(workItemId, principal.id, principal.tenantId)),
        );

        registerTool(
          "wait_work",
          {
            description:
              "DEFAULT follow-up after submit_work. Wait for durable WorkItem progress using a compact incremental response. Pass afterActivityEventId=0 on the first activity-aware call, then repeat with nextEventId + nextActivityEventId to stream Worker/model/tool and Reviewer activity; omitting afterActivityEventId preserves legacy Work-only waiting. With an MCP progressToken it emits notifications/progress while waiting. Without a progressToken, activity-aware calls return as soon as a new Work or activity event appears. When terminal=true or humanActionRequired=true, call get_work once for the full Work snapshot, result, Evidence, Workspace and verification details.",
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
            let detail = workOrchestrator.reconcileWork(workItemId, principal.id, principal.tenantId);

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

              detail = workOrchestrator.reconcileWork(workItemId, principal.id, principal.tenantId);
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
          async ({ workItemId, expectedRevision, subjectRevision, decision, reason }) =>
            toolResult(
              workOrchestrator.submitReview(workItemId, principal.id, principal.tenantId, {
                expectedRevision,
                subjectRevision,
                decision,
                ...(reason === undefined ? {} : { reason }),
              }),
            ),
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
            return toolResult(
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
          "resume_work",
          {
            description:
              "Explicitly resume a blocked WorkItem after its external blocker has been addressed. The current WorkItem revision is required; resume revalidates durable orchestration and Workspace ownership before any dispatch.",
            inputSchema: z.object({
              workItemId: z.string().uuid(),
              expectedRevision: z.number().int().min(1),
            }),
          },
          async ({ workItemId, expectedRevision }) =>
            toolResult(workOrchestrator.resumeWork(workItemId, principal.id, principal.tenantId, expectedRevision)),
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
          return toolResult({
            feedback,
            ...(linkedWork ? { work: linkedWork } : {}),
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
  const handler = createSkillHubMcpHandler(catalogService);
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
