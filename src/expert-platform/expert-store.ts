import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ExpertModelConfig {
  providerId: string;
  model: string;
  baseUrl: string;
  wireApi: "responses";
  credentialRef?: string;
  allowedEnvNames: string[];
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
  if (config.wireApi !== "responses" || !Array.isArray(config.allowedEnvNames) || config.allowedEnvNames.length === 0)
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
    const definitionColumns = this.db.prepare("PRAGMA table_info(expert_definitions)").all() as Array<{ name: string }>;
    if (!definitionColumns.some((column) => column.name === "model_config_json")) {
      this.db.exec("ALTER TABLE expert_definitions ADD COLUMN model_config_json TEXT NOT NULL DEFAULT 'null'");
    }
    const deploymentColumns = this.db.prepare("PRAGMA table_info(expert_deployments)").all() as Array<{ name: string }>;
    if (!deploymentColumns.some((column) => column.name === "repositories_json")) {
      this.db.exec("ALTER TABLE expert_deployments ADD COLUMN repositories_json TEXT NOT NULL DEFAULT '[]'");
    }
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
      !deployment.runtimeProfile.trim()
    ) {
      throw new Error("INVALID_EXPERT_DEPLOYMENT");
    }
    if (!this.db.prepare("SELECT 1 FROM expert_definitions WHERE id=?").get(deployment.expertId)) {
      throw new Error("EXPERT_NOT_FOUND");
    }
    this.db
      .prepare(
        `
      INSERT INTO expert_deployments(id,expert_id,repository_ids_json,repositories_json,principals_json,runtime_profile,active)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        expert_id=excluded.expert_id,
        repository_ids_json=excluded.repository_ids_json,
        repositories_json=excluded.repositories_json,
        principals_json=excluded.principals_json,
        runtime_profile=excluded.runtime_profile,
        active=excluded.active
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
    }));
  }

  close(): void {
    this.db.close();
  }
}
