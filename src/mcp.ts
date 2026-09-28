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

    server.registerTool(
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
            "golden-task-regression"
          ]
        })
    );

    server.registerTool(
      "list_skill_repositories",
      {
        description: "List skill repositories visible to the current caller.",
        inputSchema: z.object({})
      },
      async () => toolResult({ repositories: appService.listRepositories(principal) })
    );

    server.registerTool(
      "list_skills",
      {
        description: "List visible skills with optional metadata filters.",
        inputSchema: z.object(filterSchema)
      },
      async (filters) =>
        toolResult({ skills: appService.listSkills(filters, principal).map(compactSkill) })
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "list_prompts",
      {
        description: "List visible reusable prompts.",
        inputSchema: z.object({ client: z.string().min(1).optional() })
      },
      async ({ client }) =>
        toolResult({ prompts: appService.listPrompts(client, principal).map(compactPrompt) })
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "list_agents",
      {
        description: "List visible team Agent manifests.",
        inputSchema: z.object({ client: z.string().min(1).optional() })
      },
      async ({ client }) =>
        toolResult({ agents: appService.listAgents(client, principal).map(compactAgent) })
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "get_agent",
      {
        description: "Load one team Agent manifest including its Skill/Prompt/Tool bindings.",
        inputSchema: z.object({ repository: z.string().min(1), name: z.string().min(1) })
      },
      async ({ repository, name }) =>
        toolResult(compactAgent(appService.getAgent(repository, name, principal)))
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      "get_evaluation_run",
      {
        description: "Get one persisted evaluation run by id.",
        inputSchema: z.object({ run_id: z.string().min(1) })
      },
      async ({ run_id }) =>
        toolResult(await appService.getEvaluationRun(run_id, principal))
    );

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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
