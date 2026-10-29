import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ExpertModelConfig {
  providerId: string;
  model: string;
  baseUrl: string;
  wireApi: "responses" | "anthropic-messages";
  credentialRef?: string;
  allowedEnvNames: string[];
}

export interface ExpertMcpProfile {
  id: string;
  url: string;
  credentialRef: string;
  allowedTools: string[];
  required: boolean;
}

export interface ExpertDefinition {
  id: string;
  displayName: string;
  capabilities: string[];
  keywords: string[];
  active: boolean;
  modelConfig?: ExpertModelConfig;
}

export interface ExpertSourceRepository {
  id: string;
  url: string;
  branch: string;
  credentialRef?: string;
  gitProxyUrl?: string;
}

export interface ExpertDeploymentRecord {
  id: string;
  expertId: string;
  repositoryIds: string[];
  repositories?: ExpertSourceRepository[];
  principals: string[];
  runtimeProfile: string;
  active: boolean;
  executor?: { backend: "claude" | "codex"; modelConfig: ExpertModelConfig };
  mcp?: {
    profileRef?: string;
    urlOverride?: string;
    credentialRef: string;
    allowedTools: string[];
    required?: boolean;
  };
  configVersion?: number;
}

type DefinitionRow = {
  id: string;
  display_name: string;
  capabilities_json: string;
  keywords_json: string;
  active: number;
  model_config_json?: string;
};

type DeploymentRow = {
  id: string;
  expert_id: string;
  repository_ids_json: string;
  repositories_json?: string;
  principals_json: string;
  runtime_profile: string;
  active: number;
  executor_json?: string;
  mcp_json?: string;
  config_version?: number;
};

function stringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("EXPERT_RECORD_INVALID");
  }
  return parsed;
}

function isValidModelConfig(config: ExpertModelConfig): boolean {
  if (!config.providerId.trim() || config.providerId.length > 100 || !config.model.trim() || config.model.length > 200)
    return false;
  if (
    !(["responses", "anthropic-messages"] as string[]).includes(config.wireApi) ||
    !Array.isArray(config.allowedEnvNames) ||
    config.allowedEnvNames.length === 0
  )
    return false;
  if (
    config.allowedEnvNames.some(
      (name) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
        /^(PATH|HOME|CODEX_HOME|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|BASH_ENV|ENV|IFS|SHELLOPTS)$/.test(name) ||
        name.startsWith("DOCKER_"),
    )
  )
    return false;
  if (config.credentialRef !== undefined && (!config.credentialRef.trim() || config.credentialRef.length > 100))
    return false;
  try {
    const url = new URL(config.baseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
  } catch {
    return false;
  }
  return config.baseUrl.length <= 2048;
}

function parseModelConfig(value: string | undefined): ExpertModelConfig | undefined {
  if (!value || value === "null") return undefined;
  const parsed = JSON.parse(value) as ExpertModelConfig;
  if (!isValidModelConfig(parsed)) throw new Error("EXPERT_RECORD_INVALID");
  return parsed;
}

function validMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      raw.length <= 2048
    );
  } catch {
    return false;
  }
}

export const READ_ONLY_MCP_TOOLS = new Set([
  "list_skills",
  "search_skills",
  "resolve_skill",
  "get_skill",
  "get_skill_resource",
  "list_knowledge_sources",
  "search_knowledge",
  "get_knowledge",
]);

export class ExpertStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS expert_definitions (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0,1)),
        model_config_json TEXT NOT NULL DEFAULT 'null'
      );
      CREATE TABLE IF NOT EXISTS expert_deployments (
        id TEXT PRIMARY KEY,
        expert_id TEXT NOT NULL REFERENCES expert_definitions(id),
        repository_ids_json TEXT NOT NULL,
        repositories_json TEXT NOT NULL DEFAULT '[]',
        principals_json TEXT NOT NULL,
        runtime_profile TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0,1))
      );
    `);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS expert_mcp_profiles (id TEXT PRIMARY KEY, url TEXT NOT NULL, credential_ref TEXT NOT NULL, allowed_tools_json TEXT NOT NULL, required INTEGER NOT NULL CHECK(required IN (0,1)))`,
    );
    const definitionColumns = this.db.prepare("PRAGMA table_info(expert_definitions)").all() as Array<{ name: string }>;
    if (!definitionColumns.some((column) => column.name === "model_config_json")) {
      this.db.exec("ALTER TABLE expert_definitions ADD COLUMN model_config_json TEXT NOT NULL DEFAULT 'null'");
    }
    const deploymentColumns = this.db.prepare("PRAGMA table_info(expert_deployments)").all() as Array<{ name: string }>;
    if (!deploymentColumns.some((column) => column.name === "repositories_json")) {
      this.db.exec("ALTER TABLE expert_deployments ADD COLUMN repositories_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!deploymentColumns.some((column) => column.name === "executor_json"))
      this.db.exec("ALTER TABLE expert_deployments ADD COLUMN executor_json TEXT NOT NULL DEFAULT 'null'");
    if (!deploymentColumns.some((column) => column.name === "mcp_json"))
      this.db.exec("ALTER TABLE expert_deployments ADD COLUMN mcp_json TEXT NOT NULL DEFAULT 'null'");
    if (!deploymentColumns.some((column) => column.name === "config_version"))
      this.db.exec("ALTER TABLE expert_deployments ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1");
  }

  putMcpProfile(profile: ExpertMcpProfile): void {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(profile.id) ||
      !validMcpUrl(profile.url) ||
      !profile.credentialRef?.trim() ||
      !Array.isArray(profile.allowedTools) ||
      profile.allowedTools.length === 0 ||
      profile.allowedTools.some((tool) => !READ_ONLY_MCP_TOOLS.has(tool)) ||
      typeof profile.required !== "boolean"
    )
      throw new Error("INVALID_EXPERT_MCP_PROFILE");
    this.db
      .prepare(
        `INSERT INTO expert_mcp_profiles (id,url,credential_ref,allowed_tools_json,required)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,
      credential_ref=excluded.credential_ref,allowed_tools_json=excluded.allowed_tools_json,
      required=excluded.required`,
      )
      .run(
        profile.id,
        profile.url,
        profile.credentialRef,
        JSON.stringify([...new Set(profile.allowedTools)]),
        profile.required ? 1 : 0,
      );
  }

  getMcpProfile(id: string): ExpertMcpProfile {
    const row = this.db.prepare("SELECT * FROM expert_mcp_profiles WHERE id=?").get(id) as
      { id: string; url: string; credential_ref: string; allowed_tools_json: string; required: number } | undefined;
    if (!row) throw new Error("EXPERT_MCP_PROFILE_NOT_FOUND");
    return {
      id: row.id,
      url: row.url,
      credentialRef: row.credential_ref,
      allowedTools: stringArray(row.allowed_tools_json),
      required: row.required === 1,
    };
  }

  listMcpProfiles(): ExpertMcpProfile[] {
    const rows = this.db.prepare("SELECT id FROM expert_mcp_profiles ORDER BY id").all() as Array<{ id: string }>;
    return rows.map((row) => this.getMcpProfile(row.id));
  }

  putDefinition(definition: ExpertDefinition): void {
    if (
      !definition.id.trim() ||
      !definition.displayName.trim() ||
      definition.capabilities.length === 0 ||
      definition.capabilities.some((item) => !item.trim()) ||
      definition.keywords.some((item) => !item.trim()) ||
      (definition.modelConfig !== undefined && !isValidModelConfig(definition.modelConfig))
    ) {
      throw new Error("INVALID_EXPERT");
    }
    this.db
      .prepare(
        `
      INSERT INTO expert_definitions(id,display_name,capabilities_json,keywords_json,active,model_config_json)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        display_name=excluded.display_name,
        capabilities_json=excluded.capabilities_json,
        keywords_json=excluded.keywords_json,
        active=excluded.active,
        model_config_json=excluded.model_config_json
    `,
      )
      .run(
        definition.id,
        definition.displayName,
        JSON.stringify([...new Set(definition.capabilities)]),
        JSON.stringify([...new Set(definition.keywords)]),
        definition.active ? 1 : 0,
        JSON.stringify(definition.modelConfig ?? null),
      );
  }

  putDeployment(deployment: ExpertDeploymentRecord): void {
    if (
      !deployment.id.trim() ||
      !deployment.expertId.trim() ||
      ((deployment.repositories ?? []).length === 0 && deployment.repositoryIds.length === 0) ||
      deployment.repositoryIds.some((item) => !item.trim()) ||
      (deployment.repositories ?? []).some((repo) => !repo.id.trim() || !repo.url.trim() || !repo.branch.trim()) ||
      deployment.principals.length === 0 ||
      deployment.principals.some((item) => !item.trim()) ||
      !deployment.runtimeProfile.trim() ||
      (deployment.executor !== undefined &&
        (!deployment.executor.modelConfig ||
          !isValidModelConfig(deployment.executor.modelConfig) ||
          !["claude", "codex"].includes(deployment.executor.backend) ||
          (deployment.executor.backend === "claude" ? "anthropic-messages" : "responses") !==
            deployment.executor.modelConfig.wireApi)) ||
      (deployment.mcp !== undefined &&
        (!deployment.mcp.credentialRef?.trim() ||
          !Array.isArray(deployment.mcp.allowedTools) ||
          deployment.mcp.allowedTools.some(
            (tool) =>
              ![
                "list_skills",
                "search_skills",
                "resolve_skill",
                "get_skill",
                "get_skill_resource",
                "list_knowledge_sources",
                "search_knowledge",
                "get_knowledge",
              ].includes(tool),
          ) ||
          (deployment.mcp.urlOverride !== undefined && !validMcpUrl(deployment.mcp.urlOverride))))
    ) {
      throw new Error("INVALID_EXPERT_DEPLOYMENT");
    }
    if (!this.db.prepare("SELECT 1 FROM expert_definitions WHERE id=?").get(deployment.expertId)) {
      throw new Error("EXPERT_NOT_FOUND");
    }
    this.db
      .prepare(
        `
      INSERT INTO expert_deployments(id,expert_id,repository_ids_json,repositories_json,principals_json,runtime_profile,active,executor_json,mcp_json,config_version)
      VALUES(?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET
        expert_id=excluded.expert_id,
        repository_ids_json=excluded.repository_ids_json,
        repositories_json=excluded.repositories_json,
        principals_json=excluded.principals_json,
        runtime_profile=excluded.runtime_profile,
        active=excluded.active,
        executor_json=excluded.executor_json,
        mcp_json=excluded.mcp_json,
        config_version=expert_deployments.config_version+1
    `,
      )
      .run(
        deployment.id,
        deployment.expertId,
        JSON.stringify([
          ...new Set([...deployment.repositoryIds, ...(deployment.repositories ?? []).map((repo) => repo.id)]),
        ]),
        JSON.stringify(deployment.repositories ?? []),
        JSON.stringify([...new Set(deployment.principals)]),
        deployment.runtimeProfile,
        deployment.active ? 1 : 0,
        JSON.stringify(deployment.executor ?? null),
        JSON.stringify(deployment.mcp ?? null),
      );
  }

  listDefinitions(): ExpertDefinition[] {
    const rows = this.db.prepare("SELECT * FROM expert_definitions ORDER BY id").all() as DefinitionRow[];
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      capabilities: stringArray(row.capabilities_json),
      keywords: stringArray(row.keywords_json),
      active: row.active === 1,
      ...(parseModelConfig(row.model_config_json) ? { modelConfig: parseModelConfig(row.model_config_json)! } : {}),
    }));
  }

  getDefinition(id: string): ExpertDefinition {
    const row = this.db.prepare("SELECT * FROM expert_definitions WHERE id=?").get(id) as DefinitionRow | undefined;
    if (!row) throw new Error("EXPERT_NOT_FOUND");
    return {
      id: row.id,
      displayName: row.display_name,
      capabilities: stringArray(row.capabilities_json),
      keywords: stringArray(row.keywords_json),
      active: row.active === 1,
      ...(parseModelConfig(row.model_config_json) ? { modelConfig: parseModelConfig(row.model_config_json)! } : {}),
    };
  }

  getDeployment(id: string): ExpertDeploymentRecord {
    const row = this.db.prepare("SELECT * FROM expert_deployments WHERE id=?").get(id) as DeploymentRow | undefined;
    if (!row) throw new Error("EXPERT_DEPLOYMENT_NOT_FOUND");
    return {
      id: row.id,
      expertId: row.expert_id,
      repositoryIds: stringArray(row.repository_ids_json),
      repositories: row.repositories_json ? (JSON.parse(row.repositories_json) as ExpertSourceRepository[]) : [],
      principals: stringArray(row.principals_json),
      runtimeProfile: row.runtime_profile,
      active: row.active === 1,
      ...(row.executor_json && row.executor_json !== "null"
        ? { executor: JSON.parse(row.executor_json) as NonNullable<ExpertDeploymentRecord["executor"]> }
        : {}),
      ...(row.mcp_json && row.mcp_json !== "null"
        ? { mcp: JSON.parse(row.mcp_json) as NonNullable<ExpertDeploymentRecord["mcp"]> }
        : {}),
      ...(row.config_version !== undefined && row.executor_json && row.executor_json !== "null"
        ? { configVersion: row.config_version }
        : {}),
    };
  }

  listDeployments(): ExpertDeploymentRecord[] {
    const rows = this.db.prepare("SELECT * FROM expert_deployments ORDER BY id").all() as DeploymentRow[];
    return rows.map((row) => ({
      id: row.id,
      expertId: row.expert_id,
      repositoryIds: stringArray(row.repository_ids_json),
      repositories: row.repositories_json ? (JSON.parse(row.repositories_json) as ExpertSourceRepository[]) : [],
      principals: stringArray(row.principals_json),
      runtimeProfile: row.runtime_profile,
      active: row.active === 1,
      ...(row.executor_json && row.executor_json !== "null"
        ? { executor: JSON.parse(row.executor_json) as NonNullable<ExpertDeploymentRecord["executor"]> }
        : {}),
      ...(row.mcp_json && row.mcp_json !== "null"
        ? { mcp: JSON.parse(row.mcp_json) as NonNullable<ExpertDeploymentRecord["mcp"]> }
        : {}),
      ...(row.config_version !== undefined && row.executor_json && row.executor_json !== "null"
        ? { configVersion: row.config_version }
        : {}),
    }));
  }

  deleteDeployment(id: string): void {
    const result = this.db.prepare("DELETE FROM expert_deployments WHERE id=?").run(id);
    if (result.changes === 0) throw new Error("EXPERT_DEPLOYMENT_NOT_FOUND");
  }

  deleteDefinition(id: string): void {
    if (!this.db.prepare("SELECT 1 FROM expert_definitions WHERE id=?").get(id)) {
      throw new Error("EXPERT_NOT_FOUND");
    }
    if (this.db.prepare("SELECT 1 FROM expert_deployments WHERE expert_id=? LIMIT 1").get(id)) {
      throw new Error("EXPERT_IN_USE");
    }
    this.db.prepare("DELETE FROM expert_definitions WHERE id=?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
