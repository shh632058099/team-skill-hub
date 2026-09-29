import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Principal } from "./types.js";

export interface ManagedApiKeyRecord {
  id: string;
  label: string;
  keyHash: string;
  keyLast4: string;
  principal: Principal;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedApiKeyView {
  id: string;
  label: string;
  keyLast4: string;
  principal: Principal;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedApiKeyCreateInput {
  label: string;
  principal: Principal;
}

export interface ManagedApiKeyUpdateInput {
  label?: string;
  principal?: Principal;
  enabled?: boolean;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function normalizePrincipal(principal: Principal): Principal {
  const id = principal.id?.trim();
  const tenantId = principal.tenantId?.trim();
  const roles = [...new Set((principal.roles ?? []).map((role) => role.trim()).filter(Boolean))];
  if (!id) throw new Error("User id is required");
  if (!tenantId) throw new Error("Tenant id is required");
  return { id, tenantId, roles };
}

function toView(record: ManagedApiKeyRecord): ManagedApiKeyView {
  return {
    id: record.id,
    label: record.label,
    keyLast4: record.keyLast4,
    principal: { ...record.principal, roles: [...record.principal.roles] },
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export class ManagedApiKeyStore {
  private readonly filePath: string;
  private records: ManagedApiKeyRecord[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "config", "api-keys.json");
  }

  async load(): Promise<ManagedApiKeyRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as ManagedApiKeyRecord[];
      this.records = (parsed ?? []).map((record) => ({
        ...record,
        label: record.label?.trim() || record.principal?.id || "API Key",
        principal: normalizePrincipal(record.principal),
        enabled: record.enabled !== false
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records = [];
    }
    return this.snapshot();
  }

  list(): ManagedApiKeyView[] {
    return this.records.map(toView);
  }

  snapshot(): ManagedApiKeyRecord[] {
    return this.records.map((record) => ({
      ...record,
      principal: { ...record.principal, roles: [...record.principal.roles] }
    }));
  }

  async create(input: ManagedApiKeyCreateInput): Promise<{ record: ManagedApiKeyView; apiKey: string }> {
    const label = input.label?.trim();
    if (!label) throw new Error("Key label is required");
    const principal = normalizePrincipal(input.principal);
    const apiKey = `skh_${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: ManagedApiKeyRecord = {
      id: randomUUID(),
      label,
      keyHash: hashApiKey(apiKey),
      keyLast4: apiKey.slice(-4),
      principal,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    this.records.push(record);
    await this.persist();
    return { record: toView(record), apiKey };
  }

  async update(id: string, input: ManagedApiKeyUpdateInput): Promise<ManagedApiKeyView> {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("API key not found");
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label) throw new Error("Key label is required");
      record.label = label;
    }
    if (input.principal !== undefined) record.principal = normalizePrincipal(input.principal);
    if (input.enabled !== undefined) record.enabled = Boolean(input.enabled);
    record.updatedAt = new Date().toISOString();
    await this.persist();
    return toView(record);
  }

  async delete(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.records, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}
