import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentArtifact, ArtifactSearchResult, PromptArtifact, RepositoryConfig, ToolArtifact } from "./types.js";

interface PromptFrontmatter {
  schema_version?: number;
  name?: string;
  version?: string;
  description?: string;
  metadata?: {
    audience?: string[];
    visibility?: string[];
    keywords?: string[];
    category?: string[];
    owner?: string;
    compatibility?: Record<string, boolean>;
  };
}

interface AgentManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  description?: string;
  metadata?: {
    audience?: string[];
    visibility?: string[];
    keywords?: string[];
    owner?: string;
    compatibility?: Record<string, boolean>;
  };
  skills?: string[];
  prompts?: string[];
  tools?: string[];
}

interface ToolManifest {
  schema_version?: number;
  name?: string;
  version?: string;
  description?: string;
  type?: string;
  metadata?: {
    audience?: string[];
    visibility?: string[];
    keywords?: string[];
    owner?: string;
    compatibility?: Record<string, boolean>;
  };
  environments?: string[];
  capabilities?: string[];
  permissions?: string[];
  endpoints?: Record<string, string>;
  authentication?: {
    type?: string;
    reference?: string;
  };
}

function parseFrontmatter(content: string): { data: PromptFrontmatter; body: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("PROMPT.md must contain YAML frontmatter");
  return { data: YAML.parse(match[1]!) as PromptFrontmatter, body: match[2]! };
}

async function walk(root: string, fileName: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name === fileName) result.push(full);
    }
  }
  await visit(root);
  return result.sort();
}

export async function scanPrompts(root: string, repositoryId: string, revision: string): Promise<PromptArtifact[]> {
  const result: PromptArtifact[] = [];
  for (const file of await walk(root, "PROMPT.md")) {
    const content = await readFile(file, "utf8");
    const { data } = parseFrontmatter(content);
    const metadata = data.metadata ?? {};
    if (!data.name || !data.description || !metadata.owner) throw new Error(`Invalid prompt metadata: ${file}`);
    result.push({
      key: `${repositoryId}:${data.name}`,
      schemaVersion: data.schema_version ?? 1,
      name: data.name,
      version: data.version,
      description: data.description,
      repositoryId,
      revision,
      relativePath: path.relative(root, path.dirname(file)).replaceAll("\\", "/"),
      content,
      audience: metadata.audience ?? [],
      visibility: metadata.visibility ?? [],
      keywords: metadata.keywords ?? [],
      category: metadata.category ?? [],
      owner: metadata.owner,
      compatibility: metadata.compatibility ?? {}
    });
  }
  return result;
}

export async function scanAgents(root: string, repositoryId: string, revision: string): Promise<AgentArtifact[]> {
  const result: AgentArtifact[] = [];
  for (const file of await walk(root, "AGENT.yaml")) {
    const data = YAML.parse(await readFile(file, "utf8")) as AgentManifest;
    const metadata = data.metadata ?? {};
    if (!data.name || !data.description || !metadata.owner) throw new Error(`Invalid agent metadata: ${file}`);
    result.push({
      key: `${repositoryId}:${data.name}`,
      schemaVersion: data.schema_version ?? 1,
      name: data.name,
      version: data.version,
      description: data.description,
      repositoryId,
      revision,
      relativePath: path.relative(root, path.dirname(file)).replaceAll("\\", "/"),
      audience: metadata.audience ?? [],
      visibility: metadata.visibility ?? [],
      keywords: metadata.keywords ?? [],
      owner: metadata.owner,
      skills: data.skills ?? [],
      prompts: data.prompts ?? [],
      tools: data.tools ?? [],
      compatibility: metadata.compatibility ?? {}
    });
  }
  return result;
}

export async function scanTools(root: string, repositoryId: string, revision: string): Promise<ToolArtifact[]> {
  const result: ToolArtifact[] = [];
  for (const file of await walk(root, "TOOL.yaml")) {
    const data = YAML.parse(await readFile(file, "utf8")) as ToolManifest;
    const metadata = data.metadata ?? {};
    if (!data.name || !data.description || !data.type || !metadata.owner) {
      throw new Error(`Invalid tool metadata: ${file}`);
    }
    const authReference = data.authentication?.reference;
    if (authReference && /(?:token|password|secret|key)=/i.test(authReference)) {
      throw new Error(`Tool ${data.name}: authentication.reference must name a credential reference, not contain a secret`);
    }
    result.push({
      key: `${repositoryId}:${data.name}`,
      schemaVersion: data.schema_version ?? 1,
      name: data.name,
      version: data.version,
      description: data.description,
      repositoryId,
      revision,
      relativePath: path.relative(root, path.dirname(file)).replaceAll("\\", "/"),
      type: data.type,
      owner: metadata.owner,
      audience: metadata.audience ?? [],
      visibility: metadata.visibility ?? [],
      keywords: metadata.keywords ?? [],
      environments: data.environments ?? [],
      capabilities: data.capabilities ?? [],
      permissions: data.permissions ?? [],
      endpoints: data.endpoints ?? {},
      authentication: data.authentication?.type
        ? { type: data.authentication.type, reference: authReference }
        : undefined,
      compatibility: metadata.compatibility ?? {}
    });
  }
  return result;
}

export function validateArtifactPolicies(
  repository: RepositoryConfig,
  prompts: PromptArtifact[],
  agents: AgentArtifact[],
  skillNames: string[],
  tools: ToolArtifact[] = []
): string[] {
  const issues: string[] = [];
  const checkVisibility = (kind: string, name: string, visibility: string[]) => {
    if (visibility.length === 0) issues.push(`${kind} ${name}: visibility must not be empty`);
    const invalid = visibility.filter((item) => !repository.visibility.includes(item));
    if (invalid.length > 0) {
      issues.push(`${kind} ${name}: visibility exceeds repository policy: ${invalid.join(", ")}`);
    }
  };
  const promptNames = new Set<string>();
  for (const prompt of prompts) {
    if (prompt.schemaVersion !== 1) issues.push(`prompt ${prompt.name}: schema_version must be 1`);
    if (promptNames.has(prompt.name)) issues.push(`prompt ${prompt.name}: duplicate name`);
    promptNames.add(prompt.name);
    checkVisibility("prompt", prompt.name, prompt.visibility);
  }
  const agentNames = new Set<string>();
  for (const agent of agents) {
    if (agent.schemaVersion !== 1) issues.push(`agent ${agent.name}: schema_version must be 1`);
    if (agentNames.has(agent.name)) issues.push(`agent ${agent.name}: duplicate name`);
    agentNames.add(agent.name);
    checkVisibility("agent", agent.name, agent.visibility);
  }
  const toolNames = new Set<string>();
  for (const tool of tools) {
    if (tool.schemaVersion !== 1) issues.push(`tool ${tool.name}: schema_version must be 1`);
    if (toolNames.has(tool.name)) issues.push(`tool ${tool.name}: duplicate name`);
    toolNames.add(tool.name);
    checkVisibility("tool", tool.name, tool.visibility);
  }
  issues.push(...validateAgentBindings(agents, prompts, skillNames, tools));
  return issues;
}

export function validateAgentBindings(
  agents: AgentArtifact[],
  prompts: PromptArtifact[],
  skillNames: string[],
  tools: ToolArtifact[] = []
): string[] {
  const promptNames = new Set(prompts.map((prompt) => prompt.name));
  const skills = new Set(skillNames);
  const toolNames = new Set(tools.map((tool) => tool.name));
  const issues: string[] = [];
  for (const agent of agents) {
    for (const skill of agent.skills) {
      if (!skill.includes(":") && !skills.has(skill)) {
        issues.push(`${agent.name}: missing skill ${skill}`);
      }
    }
    for (const prompt of agent.prompts) {
      if (!prompt.includes(":") && !promptNames.has(prompt)) {
        issues.push(`${agent.name}: missing prompt ${prompt}`);
      }
    }
    for (const tool of agent.tools) {
      if (!tool.includes(":") && !toolNames.has(tool)) {
        issues.push(`${agent.name}: missing tool ${tool}`);
      }
    }
  }
  return issues;
}

function visible(repository: RepositoryConfig, visibility: string[], roles: string[]): boolean {
  if (visibility.includes("public")) return true;
  if (visibility.includes("internal") && (roles.includes("developer") || roles.includes("internal"))) return true;
  if (visibility.includes("customer") && roles.includes("customer")) return true;
  return repository.readRoles.length === 0 || repository.readRoles.some((role) => roles.includes(role));
}

export function searchArtifacts<T extends PromptArtifact | AgentArtifact | ToolArtifact>(
  query: string,
  artifacts: T[],
  limit: number
): ArtifactSearchResult<T>[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  return artifacts
    .map((artifact) => {
      const name = artifact.name.toLowerCase();
      const description = artifact.description.toLowerCase();
      const keywords = artifact.keywords.join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 4;
        if (keywords.includes(term)) score += 3;
        if (description.includes(term)) score += 1;
      }
      return { artifact, score, reason: `lexical score=${score.toFixed(2)}` };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function canReadArtifact(
  repository: RepositoryConfig,
  visibility: string[],
  roles: string[]
): boolean {
  return visible(repository, visibility, roles);
}

export interface AgentToolResolution {
  reference: string;
  status: "resolved" | "not-visible" | "environment-mismatch" | "ambiguous";
  tool?: ToolArtifact;
  reason: string;
}

export function resolveAgentToolBindings(
  agent: AgentArtifact,
  visibleTools: ToolArtifact[],
  environment?: string
): AgentToolResolution[] {
  return agent.tools.map((reference) => {
    const qualified = reference.includes(":");
    let matches = qualified
      ? visibleTools.filter((tool) => tool.key === reference)
      : visibleTools.filter((tool) => tool.name === reference);

    if (!qualified) {
      const sameRepository = matches.filter((tool) => tool.repositoryId === agent.repositoryId);
      if (sameRepository.length === 1) matches = sameRepository;
    }
    if (matches.length === 0) {
      return {
        reference,
        status: "not-visible",
        reason: "tool is missing or not visible to the current caller"
      };
    }
    if (matches.length > 1) {
      return {
        reference,
        status: "ambiguous",
        reason: "multiple visible tools match; qualify the binding as repository:name"
      };
    }
    const tool = matches[0]!;
    if (environment && tool.environments.length > 0 && !tool.environments.includes(environment)) {
      return {
        reference,
        status: "environment-mismatch",
        tool,
        reason: `tool does not declare environment ${environment}`
      };
    }
    return {
      reference,
      status: "resolved",
      tool,
      reason: qualified
        ? "resolved explicit repository-qualified tool"
        : tool.repositoryId === agent.repositoryId
          ? "resolved same-repository tool"
          : "resolved unique visible tool"
    };
  });
}
