import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { SkillHubApplicationService } from "./application.js";

const filterSchema = {
  repositories: z.array(z.string()).optional(),
  domain: z.string().optional(),
  category: z.string().optional(),
  audience: z.string().optional(),
  maturity: z.enum(["experimental", "beta", "stable", "deprecated"]).optional(),
  client: z.string().min(1).optional()
};

function compactSkill(skill: ReturnType<SkillHubApplicationService["listSkills"]>[number]) {
  return {
    name: skill.name,
    repository: skill.repositoryId,
    revision: skill.revision,
    version: skill.version,
    description: skill.description,
    path: skill.relativePath,
    metadata: skill.metadata
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
    compatibility: prompt.compatibility
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
    compatibility: agent.compatibility
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
    compatibility: tool.compatibility
  };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

export function createSkillHubMcpHandler(appService: SkillHubApplicationService) {
  return createMcpHandler(({ requestInfo }) => {
    const principal = appService.authenticateRequest(requestInfo?.headers);
    const server = new McpServer({
      name: "team-skill-hub",
      version: "0.1.0",
      description: "Team shared skill registry, search and routing service."
    });
    const requestHeaders = requestInfo?.headers;
    const explicitTraceId =
      requestHeaders?.get("x-skill-hub-trace-id") ??
      requestHeaders?.get("x-trace-id") ??
      undefined;
    const traceId = explicitTraceId ?? appService.newMcpTraceId();
    const sessionId = requestHeaders?.get("x-skill-hub-session-id") ?? undefined;
    const transportSessionId = requestHeaders?.get("mcp-session-id") ?? undefined;
    const client =
      requestHeaders?.get("x-skill-hub-client") ??
      requestHeaders?.get("user-agent") ??
      undefined;

    const registerTool = (
      name: string,
      definition: any,
      handler: (...args: any[]) => Promise<any>
    ) =>
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
            principal
          });
          if (result?.structuredContent && typeof result.structuredContent === "object") {
            result.structuredContent = {
              ...result.structuredContent,
              _trace: { trace_id: call.traceId, session_id: call.sessionId, call_id: call.id }
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
            principal
          });
          throw error;
        }
      });

    registerTool(
      "get_server_info",
      {
        description: "Return Team Skill Hub version and capabilities.",
        inputSchema: z.object({})
      },
      async () =>
        toolResult({
          server_version: "0.1.0",
          skill_schema_versions: [1],
          principal: {
            id: principal.id,
            roles: principal.roles,
            tenant_id: principal.tenantId
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
            "knowledge-candidate-inbox"
,
        "unified-discover"
,
        "tool-registry",
        "project-context-recommendations",
        "agent-tool-resolution"
          ]
        })
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
          client: z.string().min(1).optional()
        })
      },
      async ({ query, top_k, repositories, client }) => {
        const result = appService.discover(
          query,
          { topK: top_k ?? 5, repositories, client },
          principal
        );
        return toolResult({
          skills: result.skills.map((item) => ({
            ...compactSkill(item.skill),
            score: item.score,
            reason: item.reason
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
            reason: item.reason
          })),
          prompts: result.prompts.map((item) => ({
            ...compactPrompt(item.artifact),
            score: item.score,
            reason: item.reason
          })),
          agents: result.agents.map((item) => ({
            ...compactAgent(item.artifact),
            score: item.score,
            reason: item.reason
          }))
,
          tools: result.tools.map((item) => ({
            ...compactTool(item.artifact),
            score: item.score,
            reason: item.reason
          }))
        });
      }
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
          top_k: z.number().int().min(1).max(5).optional()
        })
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
            topK: top_k
          },
          principal
        );
        return toolResult({
          project: result.project,
          profile: result.profile,
          query: result.query,
          reason: result.reason,
          skills: result.recommendations.skills.map((item) => ({
            ...compactSkill(item.skill),
            score: item.score,
            reason: item.reason
          })),
          knowledge: result.recommendations.knowledge.map((item) => ({
            repository: item.chunk.repositoryId,
            path: item.chunk.relativePath,
            title: item.chunk.title,
            chunk_index: item.chunk.chunkIndex,
            score: item.score,
            reason: item.reason
          })),
          prompts: result.recommendations.prompts.map((item) => ({
            ...compactPrompt(item.artifact),
            score: item.score,
            reason: item.reason
          })),
          agents: result.recommendations.agents.map((item) => ({
            ...compactAgent(item.artifact),
            score: item.score,
            reason: item.reason
          })),
          tools: result.recommendations.tools.map((item) => ({
            ...compactTool(item.artifact),
            score: item.score,
            reason: item.reason
          }))
        });
      }
    );

    registerTool(
      "list_skill_repositories",
      {
        description: "List skill repositories visible to the current caller.",
        inputSchema: z.object({})
      },
      async () => toolResult({ repositories: appService.listRepositories(principal) })
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
          environment: z.string().min(1).optional()
        })
      },
      async ({ repository, agent, client, environment }) => {
        const result = appService.resolveAgentTools(
          repository,
          agent,
          { client, environment },
          principal
        );
        return toolResult({
          ...result,
          bindings: result.bindings.map((binding) => ({
            reference: binding.reference,
            status: binding.status,
            reason: binding.reason,
            tool: binding.tool ? compactTool(binding.tool) : undefined
          }))
        });
      }
    );

    registerTool(
      "list_skills",
      {
        description: "List visible skills with optional metadata filters.",
        inputSchema: z.object(filterSchema)
      },
      async (filters) =>
        toolResult({ skills: appService.listSkills(filters, principal).map(compactSkill) })
    );

    registerTool(
      "search_skills",
      {
        description: "Search team skills by natural-language query and metadata.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          ...filterSchema
        })
      },
      async ({ query, top_k, ...filters }) =>
        toolResult({
          results: appService.searchSkills(query, filters, top_k ?? 5, principal).map((result) => ({
            ...compactSkill(result.skill),
            score: result.score,
            reason: result.reason
          }))
        })
    );

    registerTool(
      "resolve_skill",
      {
        description: "Choose the best matching team skill for a task.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(10).optional(),
          ...filterSchema
        })
      },
      async ({ query, top_k, ...filters }) => {
        const results = appService.resolveSkill(query, filters, top_k ?? 3, principal);
        const selected = results[0];
        return toolResult({
          selected_skill: selected
            ? {
                ...compactSkill(selected.skill),
                score: selected.score,
                confidence: Math.min(1, selected.score / 10)
              }
            : null,
          alternatives: results.slice(1).map((result) => ({
            ...compactSkill(result.skill),
            score: result.score
          }))
        });
      }
    );

    registerTool(
      "get_skill",
      {
        description: "Load the complete SKILL.md for a selected skill.",
        inputSchema: z.object({
          repository: z.string().min(1),
          name: z.string().min(1)
        })
      },
      async ({ repository, name }) => {
        const skill = appService.getSkill(repository, name, principal);
        return toolResult({
          ...compactSkill(skill),
          content: skill.content
        });
      }
    );

    registerTool(
      "get_skill_resource",
      {
        description: "Load a referenced text resource from a selected skill.",
        inputSchema: z.object({
          repository: z.string().min(1),
          name: z.string().min(1),
          resource: z.string().min(1)
        })
      },
      async ({ repository, name, resource }) =>
        toolResult({
          repository,
          name,
          resource,
          content: await appService.getSkillResource(repository, name, resource, principal)
        })
    );

    registerTool(
      "list_knowledge_sources",
      {
        description: "List repository knowledge documents visible to the current caller.",
        inputSchema: z.object({
          repositories: z.array(z.string()).optional()
        })
      },
      async ({ repositories }) => {
        const documents = appService.listKnowledgeDocuments(principal, repositories);
        const grouped = new Map<string, { repository: string; documents: number; chunks: number; paths: string[] }>();
        for (const document of documents) {
          const current = grouped.get(document.repositoryId) ?? {
            repository: document.repositoryId,
            documents: 0,
            chunks: 0,
            paths: []
          };
          current.documents += 1;
          current.chunks += document.chunkCount;
          current.paths.push(document.relativePath);
          grouped.set(document.repositoryId, current);
        }
        return toolResult({ sources: [...grouped.values()] });
      }
    );

    registerTool(
      "search_knowledge",
      {
        description: "Search internal repository documentation and text knowledge. Use this for current project facts, designs, APIs, troubleshooting notes, and other document-grounded context.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          repositories: z.array(z.string()).optional(),
          applicability: z.object({
            product: z.string().optional(),
            branch: z.string().optional(),
            firmware_version: z.string().optional(),
            yocto_release: z.string().optional(),
            kernel_version: z.string().optional(),
            api_version: z.string().optional(),
            hardware_revision: z.string().optional(),
            variant: z.string().optional()
          }).optional()
        })
      },
      async ({ query, top_k, repositories, applicability }) =>
        toolResult({
          results: appService.searchKnowledge(
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
                  variant: applicability.variant
                }
              : undefined
          ).map((result) => ({
            repository: result.chunk.repositoryId,
            revision: result.chunk.revision,
            path: result.chunk.relativePath,
            title: result.chunk.title,
            metadata: result.chunk.metadata,
            chunk_index: result.chunk.chunkIndex,
            content: result.chunk.content,
            score: result.score,
            reason: result.reason
          }))
        })
    );

    registerTool(
      "get_knowledge",
      {
        description: "Load a visible knowledge document or one exact chunk after search_knowledge selects it.",
        inputSchema: z.object({
          repository: z.string().min(1),
          path: z.string().min(1),
          chunk_index: z.number().int().min(0).optional()
        })
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
            content: result.chunk.content
          });
        }
        return toolResult({
          repository,
          revision: result.document.revision,
          path,
          title: result.document.title,
          metadata: result.document.metadata,
          chunk_count: result.document.chunkCount,
          content: result.document.content
        });
      }
    );

    registerTool(
      "list_prompts",
      {
        description: "List visible reusable prompts.",
        inputSchema: z.object({ client: z.string().min(1).optional() })
      },
      async ({ client }) =>
        toolResult({ prompts: appService.listPrompts(client, principal).map(compactPrompt) })
    );

    registerTool(
      "search_prompts",
      {
        description: "Search reusable prompts by task or keywords.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional()
        })
      },
      async ({ query, top_k, client }) =>
        toolResult({
          results: appService.searchPrompts(query, top_k ?? 5, client, principal).map((result) => ({
            ...compactPrompt(result.artifact),
            score: result.score,
            reason: result.reason
          }))
        })
    );

    registerTool(
      "get_prompt",
      {
        description: "Load the complete reusable PROMPT.md.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) })
      },
      async ({ repository, name }) => {
        const prompt = appService.getPrompt(repository, name, principal);
        return toolResult({ ...compactPrompt(prompt), content: prompt.content });
      }
    );

    registerTool(
      "list_agents",
      {
        description: "List visible team Agent manifests.",
        inputSchema: z.object({ client: z.string().min(1).optional() })
      },
      async ({ client }) =>
        toolResult({ agents: appService.listAgents(client, principal).map(compactAgent) })
    );

    registerTool(
      "search_agents",
      {
        description: "Search team Agents by task or keywords.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional()
        })
      },
      async ({ query, top_k, client }) =>
        toolResult({
          results: appService.searchAgents(query, top_k ?? 5, client, principal).map((result) => ({
            ...compactAgent(result.artifact),
            score: result.score,
            reason: result.reason
          }))
        })
    );

    registerTool(
      "list_tools",
      {
        description: "List visible registered team tools and their non-secret metadata.",
        inputSchema: z.object({ client: z.string().min(1).optional() })
      },
      async ({ client }) =>
        toolResult({ tools: appService.listTools(client, principal).map(compactTool) })
    );

    registerTool(
      "search_tools",
      {
        description: "Search registered team tools by task, capability, or keywords.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(20).optional(),
          client: z.string().min(1).optional()
        })
      },
      async ({ query, top_k, client }) =>
        toolResult({
          results: appService.searchTools(query, top_k ?? 5, client, principal).map((item) => ({
            ...compactTool(item.artifact),
            score: item.score,
            reason: item.reason
          }))
        })
    );

    registerTool(
      "get_tool",
      {
        description: "Load one registered team Tool manifest. Credential values are never returned.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) })
      },
      async ({ repository, name }) =>
        toolResult(compactTool(appService.getTool(repository, name, principal)))
    );

    registerTool(
      "resolve_agent",
      {
        description: "Resolve the best matching team Agent for a task.",
        inputSchema: z.object({
          query: z.string().min(1),
          top_k: z.number().int().min(1).max(10).optional(),
          client: z.string().min(1).optional()
        })
      },
      async ({ query, top_k, client }) => {
        const results = appService.resolveAgent(query, top_k ?? 3, client, principal);
        return toolResult({
          selected_agent: results[0]
            ? { ...compactAgent(results[0].artifact), score: results[0].score }
            : null,
          alternatives: results.slice(1).map((result) => ({
            ...compactAgent(result.artifact),
            score: result.score
          }))
        });
      }
    );

    registerTool(
      "get_agent",
      {
        description: "Load one team Agent manifest including its Skill/Prompt/Tool bindings.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) })
      },
      async ({ repository, name }) =>
        toolResult(compactAgent(appService.getAgent(repository, name, principal)))
    );

    registerTool(
      "list_evaluation_suites",
      {
        description: "List deterministic golden evaluation suites for a visible repository/revision.",
        inputSchema: z.object({
          repository: z.string().min(1),
          revision: z.string().min(1).optional()
        })
      },
      async ({ repository, revision }) =>
        toolResult({
          repository,
          revision: revision ?? "active",
          suites: await appService.listEvaluationSuites(repository, revision, principal)
        })
    );

    registerTool(
      "run_evaluation",
      {
        description: "Run one deterministic golden evaluation suite against a validated revision.",
        inputSchema: z.object({
          repository: z.string().min(1),
          suite: z.string().min(1),
          revision: z.string().min(1).optional(),
          baseline_revision: z.string().min(1).optional()
        })
      },
      async ({ repository, suite, revision, baseline_revision }) =>
        toolResult(
          await appService.runEvaluation(
            repository,
            suite,
            revision,
            baseline_revision,
            principal
          )
        )
    );

    registerTool(
      "list_evaluation_runs",
      {
        description: "List persisted evaluation runs visible to the caller.",
        inputSchema: z.object({
          repository: z.string().min(1).optional(),
          suite: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(1000).optional()
        })
      },
      async ({ repository, suite, limit }) =>
        toolResult({
          runs: await appService.listEvaluationRuns(
            limit ?? 100,
            repository,
            suite,
            principal
          )
        })
    );

    registerTool(
      "get_evaluation_run",
      {
        description: "Get one persisted evaluation run by id.",
        inputSchema: z.object({ run_id: z.string().min(1) })
      },
      async ({ run_id }) =>
        toolResult(await appService.getEvaluationRun(run_id, principal))
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
          reason: z.string().max(2000).optional()
        })
      },
      async ({ trace_id, call_id, target_type, target, rating, reason }) =>
        toolResult({
          feedback: await appService.submitFeedback(principal, {
            traceId: trace_id,
            callId: call_id,
            targetType: target_type,
            target,
            rating,
            reason
          })
        })
    );

    registerTool(
      "submit_knowledge_candidate",
      {
        description: "Submit a candidate team Knowledge/Skill item for human review. This never publishes directly to Git.",
        inputSchema: z.object({
          trace_id: z.string().min(1).optional(),
          title: z.string().min(1).max(200),
          content: z.string().min(1).max(10000),
          source_type: z.enum(["mcp-session", "manual", "codex-summary", "troubleshooting", "review"]).optional(),
          suggested_type: z.enum(["knowledge", "skill"]).optional(),
          repository: z.string().min(1).optional(),
          suggested_path: z.string().min(1).optional()
        })
      },
      async ({ trace_id, title, content, source_type, suggested_type, repository, suggested_path }) =>
        toolResult({
          candidate: await appService.submitKnowledgeCandidate(principal, {
            traceId: trace_id,
            title,
            content,
            sourceType: source_type ?? "mcp-session",
            suggestedType: suggested_type ?? "knowledge",
            repository,
            suggestedPath: suggested_path
          })
        })
    );

    registerTool(
      "sync_skill_repository",
      {
        description: "Synchronize one configured skill repository and activate it only after validation.",
        inputSchema: z.object({
          repository: z.string().min(1)
        })
      },
      async ({ repository }) =>
        toolResult(await appService.syncRepository(repository, "manual", principal))
    );

    registerTool(
      "list_repository_revisions",
      {
        description: "List validated revisions available for a visible repository.",
        inputSchema: z.object({ repository: z.string().min(1) })
      },
      async ({ repository }) =>
        toolResult({
          repository,
          revisions: await appService.listRepositoryRevisions(repository, principal)
        })
    );

    registerTool(
      "rollback_repository_revision",
      {
        description: "Rollback a repository to a previously validated revision. Requires sync permission.",
        inputSchema: z.object({
          repository: z.string().min(1),
          revision: z.string().min(1)
        })
      },
      async ({ repository, revision }) =>
        toolResult(await appService.rollbackRepositoryRevision(repository, revision, principal))
    );

    registerTool(
      "list_sync_audit",
      {
        description: "List recent repository synchronization audit events.",
        inputSchema: z.object({
          repository: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(1000).optional()
        })
      },
      async ({ repository, limit }) =>
        toolResult({
          events: await appService.listAuditEvents(limit ?? 100, repository, principal)
        })
    );

    return server;
  });
}
