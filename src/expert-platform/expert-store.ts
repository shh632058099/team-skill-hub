import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ExpertDefinition {
  id: string;
  displayName: string;
  capabilities: string[];
  keywords: string[];
  active: boolean;
}

export interface ExpertDeploymentRecord {
  id: string;
  expertId: string;
  repositoryIds: string[];
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
};

type DeploymentRow = {
  id: string;
  expert_id: string;
  repository_ids_json: string;
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
        active INTEGER NOT NULL CHECK (active IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS expert_deployments (
        id TEXT PRIMARY KEY,
        expert_id TEXT NOT NULL REFERENCES expert_definitions(id),
        repository_ids_json TEXT NOT NULL,
        principals_json TEXT NOT NULL,
        runtime_profile TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0,1))
      );
    `);
  }

  putDefinition(definition: ExpertDefinition): void {
    if (
      !definition.id.trim() ||
      !definition.displayName.trim() ||
      definition.capabilities.length === 0 ||
      definition.capabilities.some((item) => !item.trim()) ||
      definition.keywords.some((item) => !item.trim())
    ) {
      throw new Error("INVALID_EXPERT");
    }
    this.db
      .prepare(
        `
      INSERT INTO expert_definitions(id,display_name,capabilities_json,keywords_json,active)
      VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        display_name=excluded.display_name,
        capabilities_json=excluded.capabilities_json,
        keywords_json=excluded.keywords_json,
        active=excluded.active
    `,
      )
      .run(
        definition.id,
        definition.displayName,
        JSON.stringify([...new Set(definition.capabilities)]),
        JSON.stringify([...new Set(definition.keywords)]),
        definition.active ? 1 : 0,
      );
  }

  putDeployment(deployment: ExpertDeploymentRecord): void {
    if (
      !deployment.id.trim() ||
      !deployment.expertId.trim() ||
      deployment.repositoryIds.length === 0 ||
      deployment.repositoryIds.some((item) => !item.trim()) ||
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
      INSERT INTO expert_deployments(id,expert_id,repository_ids_json,principals_json,runtime_profile,active)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        expert_id=excluded.expert_id,
        repository_ids_json=excluded.repository_ids_json,
        principals_json=excluded.principals_json,
        runtime_profile=excluded.runtime_profile,
        active=excluded.active
    `,
      )
      .run(
        deployment.id,
        deployment.expertId,
        JSON.stringify([...new Set(deployment.repositoryIds)]),
        JSON.stringify([...new Set(deployment.principals)]),
        deployment.runtimeProfile,
        deployment.active ? 1 : 0,
      );
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
    };
  }

  getDeployment(id: string): ExpertDeploymentRecord {
    const row = this.db.prepare("SELECT * FROM expert_deployments WHERE id=?").get(id) as DeploymentRow | undefined;
    if (!row) throw new Error("EXPERT_DEPLOYMENT_NOT_FOUND");
    return {
      id: row.id,
      expertId: row.expert_id,
      repositoryIds: stringArray(row.repository_ids_json),
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
      principals: stringArray(row.principals_json),
      runtimeProfile: row.runtime_profile,
      active: row.active === 1,
    }));
  }

  close(): void {
    this.db.close();
  }
}
