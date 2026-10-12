import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Principal } from "./types.js";

export interface ManagedApiKeyRecord {
  id: string;
  label: string;
  keyHash: string;
  keyLast4: string;
  keyCiphertext?: string;
  principal: Principal;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedApiKeyView {
  id: string;
  label: string;
  keyLast4: string;
  revealable: boolean;
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
    revealable: Boolean(record.keyCiphertext),
    principal: { ...record.principal, roles: [...record.principal.roles] },
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export class ManagedApiKeyStore {
  private readonly filePath: string;
  private readonly encryptionKeyPath: string;
  private encryptionKey?: Buffer;
  private records: ManagedApiKeyRecord[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "config", "api-keys.json");
    this.encryptionKeyPath = path.join(dataDir, "config", "api-key-encryption.key");
  }

  async load(): Promise<ManagedApiKeyRecord[]> {
    await this.loadOrCreateEncryptionKey();
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
    const id = randomUUID();
    const record: ManagedApiKeyRecord = {
      id,
      label,
      keyHash: hashApiKey(apiKey),
      keyLast4: apiKey.slice(-4),
      keyCiphertext: this.encryptApiKey(apiKey, id),
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

  async rotate(id: string): Promise<{ record: ManagedApiKeyView; apiKey: string }> {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("API key not found");
    const apiKey = `skh_${randomBytes(32).toString("base64url")}`;
    record.keyHash = hashApiKey(apiKey);
    record.keyLast4 = apiKey.slice(-4);
    record.keyCiphertext = this.encryptApiKey(apiKey, record.id);
    record.enabled = true;
    record.updatedAt = new Date().toISOString();
    await this.persist();
    return { record: toView(record), apiKey };
  }

  reveal(id: string): string {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error("API key not found");
    if (!record.keyCiphertext) {
      throw new Error("This legacy API key cannot be revealed; rotate it once to enable reveal");
    }
    return this.decryptApiKey(record.keyCiphertext, record.id);
  }

  async delete(id: string): Promise<boolean> {
    const nextRecords = this.records.filter((record) => record.id !== id);
    if (nextRecords.length === this.records.length) return false;
    await this.persist(nextRecords);
    this.records = nextRecords;
    return true;
  }

  private async loadOrCreateEncryptionKey(): Promise<void> {
    await mkdir(path.dirname(this.encryptionKeyPath), { recursive: true });
    try {
      const key = await readFile(this.encryptionKeyPath);
      if (key.length !== 32) throw new Error("API key encryption master key must be exactly 32 bytes");
      this.encryptionKey = key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await writeFile(this.encryptionKeyPath, key, { mode: 0o600 });
      this.encryptionKey = key;
    }
  }

  private encryptApiKey(apiKey: string, recordId: string): string {
    if (!this.encryptionKey) throw new Error("API key encryption is not initialized");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(recordId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  private decryptApiKey(value: string, recordId: string): string {
    if (!this.encryptionKey) throw new Error("API key encryption is not initialized");
    const [version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split(".");
    if (version !== "v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
      throw new Error("Stored API key ciphertext is invalid");
    }
    const iv = Buffer.from(ivEncoded, "base64url");
    const tag = Buffer.from(tagEncoded, "base64url");
    const ciphertext = Buffer.from(ciphertextEncoded, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Stored API key ciphertext is invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(recordId, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  private async persist(records: ManagedApiKeyRecord[] = this.records): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(records, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}
