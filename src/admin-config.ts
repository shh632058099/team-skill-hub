import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, ProjectConfig, RepositoryConfig } from "./types.js";
import { normalizeKnowledgeConfig } from "./knowledge.js";

export interface AdminEditableConfig {
  defaultRoles: string[];
  revisionRetentionMax: number;
  webhookDedupMaxEntries: number;
  webhookDedupTtlSeconds: number;
  repositories: RepositoryConfig[];
  projects: ProjectConfig[];
}

function cloneRepositories(repositories: RepositoryConfig[]): RepositoryConfig[] {
  return repositories.map((repository) => ({
    ...repository,
    owners: [...(repository.owners ?? [])],
    gitAuth: { ...repository.gitAuth },
    webhookAliases: [...repository.webhookAliases],
    audience: [...repository.audience],
    visibility: [...repository.visibility],
    readRoles: [...repository.readRoles],
    syncRoles: [...repository.syncRoles],
    knowledge: normalizeKnowledgeConfig(repository.knowledge),
    knowledgePublishing: repository.knowledgePublishing ? { ...repository.knowledgePublishing } : undefined
  }));
}

function cloneProjects(projects: ProjectConfig[] | undefined): ProjectConfig[] {
  return (projects ?? []).map((project) => ({
    ...project,
    repositoryPatterns: [...project.repositoryPatterns],
    owners: [...project.owners],
    preferredSkillRepositories: [...project.preferredSkillRepositories],
    preferredKnowledgeRepositories: [...project.preferredKnowledgeRepositories],
    tools: [...project.tools],
    environments: [...project.environments],
    aliases: [...project.aliases]
  }));
}

export function editableConfigFromApp(config: AppConfig): AdminEditableConfig {
  return {
    defaultRoles: [...config.defaultRoles],
    revisionRetentionMax: config.revisionRetentionMax ?? 20,
    webhookDedupMaxEntries: config.webhookDedupMaxEntries ?? 1000,
    webhookDedupTtlSeconds: config.webhookDedupTtlSeconds ?? 604800,
    repositories: cloneRepositories(config.repositories),
    projects: cloneProjects(config.projects)
  };
}

function validateRepository(repository: RepositoryConfig, seen: Set<string>): void {
  if (!repository.id.trim() || !repository.name.trim()) throw new Error("Repository id and name are required");
  if (seen.has(repository.id)) throw new Error(`Duplicate repository id: ${repository.id}`);
  seen.add(repository.id);
  repository.owners = [...new Set((repository.owners ?? []).map((item) => item.trim()).filter(Boolean))];
  if (repository.provider === "local" && !repository.path) {
    throw new Error(`Repository ${repository.id}: local provider requires path`);
  }
  if (repository.provider === "git" && !repository.gitUrl) {
    throw new Error(`Repository ${repository.id}: git provider requires gitUrl`);
  }
  if (!["local", "git"].includes(repository.provider)) {
    throw new Error(`Repository ${repository.id}: unsupported provider`);
  }
  if (!["none", "https-token", "ssh"].includes(repository.gitAuth.type)) {
    throw new Error(`Repository ${repository.id}: unsupported git auth type`);
  }
  repository.knowledge = normalizeKnowledgeConfig(repository.knowledge);
  const knowledge = repository.knowledge;
  if (!Array.isArray(knowledge.include) || knowledge.include.some((item) => !item.trim())) {
    throw new Error(`Repository ${repository.id}: knowledge include patterns are invalid`);
  }
  if (!Array.isArray(knowledge.exclude) || knowledge.exclude.some((item) => !item.trim())) {
    throw new Error(`Repository ${repository.id}: knowledge exclude patterns are invalid`);
  }
  knowledge.maxDocumentBytes = Math.max(1024, Number(knowledge.maxDocumentBytes ?? 2 * 1024 * 1024));
  knowledge.chunkSizeChars = Math.max(200, Number(knowledge.chunkSizeChars ?? 1400));
  knowledge.chunkOverlapChars = Math.max(0, Number(knowledge.chunkOverlapChars ?? 180));
  if (knowledge.chunkOverlapChars >= knowledge.chunkSizeChars) {
    throw new Error(`Repository ${repository.id}: chunk overlap must be smaller than chunk size`);
  }
  if (repository.knowledgePublishing) {
    const publishing = repository.knowledgePublishing;
    if (publishing.provider !== "gitlab") {
      throw new Error(`Repository ${repository.id}: unsupported knowledge publisher`);
    }
    if (!publishing.tokenEnv?.trim()) throw new Error(`Repository ${repository.id}: publishing tokenEnv is required`);
    if (!publishing.targetBranch?.trim()) throw new Error(`Repository ${repository.id}: publishing targetBranch is required`);
    if (!publishing.branchPrefix?.trim()) throw new Error(`Repository ${repository.id}: publishing branchPrefix is required`);
  }
}

function validateProjects(projects: ProjectConfig[] | undefined, repositories: RepositoryConfig[]): ProjectConfig[] {
  const repositoryIds = new Set(repositories.map((item) => item.id));
  const seen = new Set<string>();
  return cloneProjects(projects).map((project) => {
    if (!project.id.trim()) throw new Error("Project id is required");
    if (seen.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    seen.add(project.id);
    if (!project.repositoryPatterns.length) throw new Error(`Project ${project.id}: repositoryPatterns is required`);
    for (const repositoryId of [...project.preferredSkillRepositories, ...project.preferredKnowledgeRepositories]) {
      if (!repositoryIds.has(repositoryId)) throw new Error(`Project ${project.id}: unknown preferred repository ${repositoryId}`);
    }
    return {
      ...project,
      id: project.id.trim(),
      name: project.name?.trim() || project.id.trim(),
      repositoryPatterns: [...new Set(project.repositoryPatterns.map((item) => item.trim()).filter(Boolean))],
      owners: [...new Set(project.owners.map((item) => item.trim()).filter(Boolean))],
      preferredSkillRepositories: [...new Set(project.preferredSkillRepositories)],
      preferredKnowledgeRepositories: [...new Set(project.preferredKnowledgeRepositories)],
      tools: [...new Set(project.tools.map((item) => item.trim()).filter(Boolean))],
      environments: [...new Set(project.environments.map((item) => item.trim()).filter(Boolean))],
      aliases: [...new Set(project.aliases.map((item) => item.trim()).filter(Boolean))]
    };
  });
}

export function validateAdminConfig(value: AdminEditableConfig): AdminEditableConfig {
  const seen = new Set<string>();
  const repositories = cloneRepositories(value.repositories ?? []);
  for (const repository of repositories) validateRepository(repository, seen);
  return {
    defaultRoles: [...new Set(value.defaultRoles ?? [])],
    revisionRetentionMax: Math.max(2, Number(value.revisionRetentionMax ?? 20)),
    webhookDedupMaxEntries: Math.max(100, Number(value.webhookDedupMaxEntries ?? 1000)),
    webhookDedupTtlSeconds: Math.max(3600, Number(value.webhookDedupTtlSeconds ?? 604800)),
    repositories,
    projects: validateProjects(value.projects ?? [], repositories)
  };
}

export function applyAdminConfig(target: AppConfig, editable: AdminEditableConfig): void {
  const normalized = validateAdminConfig(editable);
  target.defaultRoles = normalized.defaultRoles;
  target.revisionRetentionMax = normalized.revisionRetentionMax;
  target.webhookDedupMaxEntries = normalized.webhookDedupMaxEntries;
  target.webhookDedupTtlSeconds = normalized.webhookDedupTtlSeconds;
  target.repositories = normalized.repositories;
  target.projects = normalized.projects;
}

export class AdminConfigStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "config", "admin-config.json");
  }

  async load(base: AppConfig): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as AdminEditableConfig;
      applyAdminConfig(base, parsed);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async save(config: AdminEditableConfig): Promise<AdminEditableConfig> {
    const normalized = validateAdminConfig(config);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }
}
