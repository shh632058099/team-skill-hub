import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, RepositoryConfig } from "./types.js";

export interface AdminEditableConfig {
  defaultRoles: string[];
  revisionRetentionMax: number;
  webhookDedupMaxEntries: number;
  webhookDedupTtlSeconds: number;
  repositories: RepositoryConfig[];
}

function cloneRepositories(repositories: RepositoryConfig[]): RepositoryConfig[] {
  return repositories.map((repository) => ({
    ...repository,
    gitAuth: { ...repository.gitAuth },
    webhookAliases: [...repository.webhookAliases],
    audience: [...repository.audience],
    visibility: [...repository.visibility],
    readRoles: [...repository.readRoles],
    syncRoles: [...repository.syncRoles]
  }));
}

export function editableConfigFromApp(config: AppConfig): AdminEditableConfig {
  return {
    defaultRoles: [...config.defaultRoles],
    revisionRetentionMax: config.revisionRetentionMax ?? 20,
    webhookDedupMaxEntries: config.webhookDedupMaxEntries ?? 1000,
    webhookDedupTtlSeconds: config.webhookDedupTtlSeconds ?? 604800,
    repositories: cloneRepositories(config.repositories)
  };
}

function validateRepository(repository: RepositoryConfig, seen: Set<string>): void {
  if (!repository.id.trim() || !repository.name.trim()) throw new Error("Repository id and name are required");
  if (seen.has(repository.id)) throw new Error(`Duplicate repository id: ${repository.id}`);
  seen.add(repository.id);
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
    repositories
  };
}

export function applyAdminConfig(target: AppConfig, editable: AdminEditableConfig): void {
  const normalized = validateAdminConfig(editable);
  target.defaultRoles = normalized.defaultRoles;
  target.revisionRetentionMax = normalized.revisionRetentionMax;
  target.webhookDedupMaxEntries = normalized.webhookDedupMaxEntries;
  target.webhookDedupTtlSeconds = normalized.webhookDedupTtlSeconds;
  target.repositories = normalized.repositories;
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
