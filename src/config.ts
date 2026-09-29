import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AppConfig, Principal, RepositoryConfig } from "./types.js";

interface RawConfig {
  server?: {
    host?: string;
    port?: number;
  };
  data_dir?: string;
  default_roles?: string[];
  authentication?: {
    mode?: "development" | "api-key";
  };
  retention?: {
    max_revisions?: number;
  };
  webhook_dedup?: {
    max_entries?: number;
    ttl_seconds?: number;
  };
  repositories?: Array<{
    id?: string;
    name?: string;
    provider?: "local" | "git";
    path?: string;
    git_url?: string;
    branch?: string;
    git_auth?: {
      type?: "none" | "https-token" | "ssh";
      token_env?: string;
      username_env?: string;
      ssh_key_path?: string;
      known_hosts_path?: string;
    };
    enabled?: boolean;
    webhook_aliases?: string[];
    audience?: string[];
    visibility?: string[];
    sync?: {
      polling_interval?: number;
    };
    access?: {
      read_roles?: string[];
      sync_roles?: string[];
    };
    knowledge?: {
      enabled?: boolean;
      include?: string[];
      exclude?: string[];
      max_document_bytes?: number;
      chunk_size_chars?: number;
      chunk_overlap_chars?: number;
    };
    knowledge_publishing?: {
      enabled?: boolean;
      provider?: "gitlab";
      base_url?: string;
      project_path?: string;
      token_env?: string;
      target_branch?: string;
      branch_prefix?: string;
    };
  }>;
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const raw = YAML.parse(await readFile(configPath, "utf8")) as RawConfig;
  const base = path.dirname(path.resolve(configPath));

  const repositories: RepositoryConfig[] = (raw.repositories ?? []).map((repo) => {
    if (!repo.id || !repo.name || !repo.provider) {
      throw new Error("Each repository requires id, name, and provider");
    }
    if (repo.provider === "local" && !repo.path) {
      throw new Error(`Repository ${repo.id}: local provider requires path`);
    }
    if (repo.provider === "git" && !repo.git_url) {
      throw new Error(`Repository ${repo.id}: git provider requires git_url`);
    }
    if (repo.provider === "git" && repo.git_auth?.type === "ssh") {
      if (!repo.git_auth.ssh_key_path || !repo.git_auth.known_hosts_path) {
        throw new Error(
          `Repository ${repo.id}: ssh git_auth requires ssh_key_path and known_hosts_path`
        );
      }
    }
    return {
      id: repo.id,
      name: repo.name,
      provider: repo.provider,
      path: repo.path
        ? path.resolve(base, repo.path)
        : undefined,
      gitUrl: repo.git_url,
      branch: repo.branch ?? "main",
      gitAuth: {
        type: repo.git_auth?.type ?? "none",
        tokenEnv: repo.git_auth?.token_env,
        usernameEnv: repo.git_auth?.username_env,
        sshKeyPath: repo.git_auth?.ssh_key_path,
        knownHostsPath: repo.git_auth?.known_hosts_path
      },
      webhookAliases: repo.webhook_aliases ?? [],
      enabled: repo.enabled ?? true,
      audience: repo.audience ?? ["developer"],
      visibility: repo.visibility ?? ["internal"],
      pollingIntervalSeconds: repo.sync?.polling_interval ?? 300,
      readRoles:
        repo.access?.read_roles ??
        (repo.visibility?.includes("public")
          ? []
          : repo.visibility?.includes("customer")
            ? ["customer"]
            : ["developer", "internal"]),
      syncRoles: repo.access?.sync_roles ?? ["developer", "admin"],
      knowledge: {
        enabled: repo.knowledge?.enabled ?? true,
        include: repo.knowledge?.include ?? ["**/*.md", "**/*.txt", "**/*.pdf", "**/*.docx"],
        exclude: repo.knowledge?.exclude ?? [],
        maxDocumentBytes: Math.max(1024, Number(repo.knowledge?.max_document_bytes ?? 2 * 1024 * 1024)),
        chunkSizeChars: Math.max(200, Number(repo.knowledge?.chunk_size_chars ?? 1400)),
        chunkOverlapChars: Math.max(0, Number(repo.knowledge?.chunk_overlap_chars ?? 180))
      },
      knowledgePublishing: {
        enabled: repo.knowledge_publishing?.enabled ?? false,
        provider: repo.knowledge_publishing?.provider ?? "gitlab",
        baseUrl: repo.knowledge_publishing?.base_url,
        projectPath: repo.knowledge_publishing?.project_path,
        tokenEnv: repo.knowledge_publishing?.token_env ?? "GITLAB_WRITE_TOKEN",
        targetBranch: repo.knowledge_publishing?.target_branch ?? repo.branch ?? "main",
        branchPrefix: repo.knowledge_publishing?.branch_prefix ?? "skill-hub-knowledge"
      }
    };
  });

  const authMode = (process.env.AUTH_MODE ?? raw.authentication?.mode ?? "development") as
    | "development"
    | "api-key";
  let apiKeys: Record<string, Principal> = {};
  const apiKeysJson = process.env.SKILL_HUB_API_KEYS_JSON;
  if (apiKeysJson) {
    const parsed = JSON.parse(apiKeysJson) as Record<string, Partial<Principal>>;
    apiKeys = Object.fromEntries(
      Object.entries(parsed).map(([key, principal]) => [
        key,
        {
          id: principal.id ?? "api-key-user",
          roles: principal.roles ?? [],
          tenantId: principal.tenantId ?? "default"
        }
      ])
    );
  }
  return {
    host: process.env.HOST ?? raw.server?.host ?? "0.0.0.0",
    port: Number(process.env.PORT ?? raw.server?.port ?? 8080),
    dataDir: path.resolve(process.env.DATA_DIR ?? raw.data_dir ?? "./data"),
    defaultRoles: raw.default_roles ?? ["developer", "internal"],
    authentication: { mode: authMode, apiKeys },
    revisionRetentionMax: Math.max(
      2,
      Number(process.env.REVISION_RETENTION_MAX ?? raw.retention?.max_revisions ?? 20)
    ),
    webhookDedupMaxEntries: Math.max(
      100,
      Number(process.env.WEBHOOK_DEDUP_MAX_ENTRIES ?? raw.webhook_dedup?.max_entries ?? 1000)
    ),
    webhookDedupTtlSeconds: Math.max(
      3600,
      Number(process.env.WEBHOOK_DEDUP_TTL_SECONDS ?? raw.webhook_dedup?.ttl_seconds ?? 604800)
    ),
    repositories
  };
}
