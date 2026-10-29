import { verifyClaudeSessionProof } from "./expert-platform/session-proof.js";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { observeReuse } from "./reuse-observability.js";
import * as z from "zod/v4";
import type { SkillHubApplicationService } from "./application.js";
import { loadClientIntegrationStatus } from "./client-integration/release.js";
import { ExpertDispatchService } from "./expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "./expert-platform/expert-store.js";
import { ExpertTaskStore } from "./expert-platform/task-store.js";

// The experimental task API is opt-in until an isolated Worker runtime is provisioned.
const expertTaskStore = process.env.EXPERT_RUNTIME_DB ? new ExpertTaskStore(process.env.EXPERT_RUNTIME_DB) : null;
const expertStore = process.env.EXPERT_RUNTIME_DB ? new ExpertStore(process.env.EXPERT_RUNTIME_DB) : null;
const expertDispatchService =
  expertTaskStore && expertStore ? new ExpertDispatchService(expertStore, expertTaskStore) : null;

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

    const registerTool = (name: string, definition: any, handler: (...args: any[]) => Promise<any>) =>
      server.registerTool(name, definition as any, async (...args: any[]) => {
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
          "Knowledge ONLY. Submit a candidate team Knowledge item for human review using the current server specification returned by get_knowledge_submission_spec. Include that spec_version. NEVER use this tool for Skills or SKILL.md content; Skills must use submit_skill_bundle. This never publishes directly to Git.",
        inputSchema: z.object({
          trace_id: z.string().min(1).optional(),
          spec_version: z.number().int().min(1),
          title: z.string().min(1).max(200),
          content: z.string().min(1).max(50_000),
          source_type: z.enum(["mcp-session", "manual", "codex-summary", "troubleshooting", "review"]).optional(),
          repository: z.string().min(1).optional(),
        }),
      },
      async ({ trace_id, spec_version, title, content, source_type, repository }) =>
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
          }),
        }),
    );

    registerTool(
      "submit_skill_bundle",
      {
        description:
          "The only MCP entrypoint for submitting Skills. Use this for every Skill, including a single-file Skill containing only SKILL.md, and for explicit multi-Skill collections. Submit one complete Skill root with import_type=skill or one complete namespace snapshot with import_type=collection. The Bundle is validated against the target repository and is never published directly.",
        inputSchema: z
          .object({
            trace_id: z.string().min(1).optional(),
            namespace: z.string().min(1).max(200),
            import_type: z.enum(["skill", "collection"]),
            skill_path: z.string().min(1).max(500).optional(),
            skill_collection: z.literal("rd-skills"),
            repository: z.string().min(1).optional(),
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
            "List active Expert Platform experts and repositories authorized for the current principal. Call this ONLY when the user explicitly names an Expert and you need to map its display name to expertId, or when the user asks to list available experts. For ordinary technical analysis requests where the user did not name an Expert, do NOT call this tool: call submit_expert_task directly and omit expertId so the Hub performs automatic routing. This catalog is separate from Skill Hub skills and agents returned by discover, resolve_agent, or list_agents. Map an explicitly named Expert to the returned expertId, and use only repositoryIds returned here; never pass a Skill Hub agent name or Skill Hub publishing repository ID as an Expert Platform ID.",
          inputSchema: z.object({}),
        },
        async () => toolResult({ experts: expertDispatchService!.listAvailable(principal.id) }),
      );

      registerTool(
        "submit_expert_task_auto",
        {
          description:
            "DEFAULT Expert Platform delegation tool for natural-language specialist work. This tool ALWAYS automatically chooses the Expert, and requires NO expertId or selectionMode. Use for OTA, drivers, code review, Yocto and other specialist analysis unless the user explicitly named a specific Expert Platform Expert. Provide the user's problem and a new unique idempotencyKey. Session identity is injected by the Claude client PreToolUse hook when installed; do not invent or generate clientSessionId. repositoryId is optional and must be a real ID from list_available_experts, never a placeholder. Returns a taskId immediately; when the user wants results, automatically call wait_expert_task with its cursor until terminal, then get_expert_task_result on success. Share actual progress while waiting.",
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
          }),
        },
        async ({ problem, idempotencyKey, clientSessionId, clientSessionProof }) => {
          if (!expertDispatchService) throw new Error("EXPERT_RUNTIME_UNAVAILABLE");
          return toolResult({
            ...expertDispatchService.submit({
              principalId: principal.id,
              scope: principal.tenantId,
              idempotencyKey,
              sourceSessionId:
                sessionId ??
                transportSessionId ??
                (verifyClaudeSessionProof(credential, clientSessionId, idempotencyKey, clientSessionProof)
                  ? clientSessionId
                  : undefined),
              sourceClient: client?.slice(0, 200) || "mcp",
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
            'Use submit_expert_task_auto INSTEAD for ordinary natural-language analysis; only use this tool when an explicit expertId or repositoryId is required. Delegate a technical investigation to the Expert Platform when the user asks for specialist analysis, source-code root-cause investigation, a focused subsystem review, or analysis that should run asynchronously. Use this tool when an authorized Expert should do the investigation instead of completing the full specialist analysis in the current chat. Put the user\'s question in problem. CRITICAL ROUTING RULE: if the user did NOT explicitly name an Expert, set selectionMode="auto" and OMIT expertId; never use magic expertId strings such as __AUTO__, auto, AUTO_SELECT, or automatic. The Hub will automatically route using the problem and eligible expert capabilities. If the user explicitly names an Expert, set selectionMode="explicit", call list_available_experts first and pass the matching Expert Platform expertId. Never silently substitute a different expert for an explicit request. Use only a repositoryId returned by list_available_experts when one is needed; do not pass Skill Hub publishing repository IDs. This queues a read-only task for a Worker, which executes asynchronously. Return taskId and selectionMode; for a result-seeking request automatically call wait_expert_task in bounded windows and pass nextEventId each time until terminal, then get_expert_task_result after succeeded. Do not require the user to ask again. Use a fresh idempotencyKey for a new task; reuse the same key only when retrying the same request. Claude client PreToolUse injects native session identity when installed; do not invent or generate clientSessionId.',
          inputSchema: z.object({
            problem: z.string().trim().min(1).max(10000),
            idempotencyKey: z.string().min(1).max(200),
            expertId: z.string().trim().min(1).max(200).optional(),
            selectionMode: z.enum(["auto", "explicit"]).optional(),
            repositoryId: z.string().trim().min(1).max(200).optional(),
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
          }),
        },
        async ({
          problem,
          idempotencyKey,
          expertId,
          selectionMode,
          repositoryId,
          clientSessionId,
          clientSessionProof,
        }) => {
          if (!expertDispatchService) throw new Error("EXPERT_RUNTIME_UNAVAILABLE");
          return toolResult({
            ...expertDispatchService.submit({
              principalId: principal.id,
              scope: principal.tenantId,
              idempotencyKey,
              sourceSessionId:
                sessionId ??
                transportSessionId ??
                (verifyClaudeSessionProof(credential, clientSessionId, idempotencyKey, clientSessionProof)
                  ? clientSessionId
                  : undefined),
              sourceClient: client?.slice(0, 200) || "mcp",
              problem,
              expertId,
              selectionMode,
              repositoryId,
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
            "Retrieve the persisted report and evidence for an Expert Platform task only after get_expert_task_status reports succeeded. Include the actual taskId and evidence in the answer, and distinguish verified findings from hypotheses. Queued or running tasks do not yet have a report.",
          inputSchema: z.object({ taskId: z.string().uuid() }),
        },
        async ({ taskId }) => {
          const task = expertTaskStore.get(taskId, principal.id, principal.tenantId);
          if (task.status !== "succeeded") throw new Error("TASK_NOT_READY");
          return toolResult({ ...task });
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
