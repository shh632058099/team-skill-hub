import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AutoCandidatePolicy } from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(reason: string): never {
  throw new Error(`Invalid auto candidate policy: ${reason}`);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) fail(`${name} must be a positive integer`);
  return Number(value);
}

function boundedNumber(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail(`${name} must be between ${min} and ${max}`);
  return number;
}

export function defaultAutoCandidatePolicy(): AutoCandidatePolicy {
  return {
    schemaVersion: 1,
    policyVersion: 1,
    enabled: true,
    mode: "shadow",
    thresholds: {
      shadowScore: 60,
      createScore: 80,
      duplicateSimilarity: 0.84,
    },
    requirements: {
      requireVerification: true,
    },
    limits: {
      perSession: 1,
      perUserPerHour: 2,
      perUserPerDay: 5,
      perRepositoryPerHour: 5,
      perRepositoryPerDay: 20,
      globalPerHour: 10,
      globalPerDay: 50,
    },
    cooldown: {
      sameRepositoryMinutes: 5,
    },
  };
}

export function validateAutoCandidatePolicy(value: unknown): AutoCandidatePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("root must be an object");
  const raw = value as Record<string, any>;
  if (raw.schemaVersion !== 1) fail("unsupported schemaVersion");
  const policyVersion = positiveInteger(raw.policyVersion, "policyVersion");
  if (typeof raw.enabled !== "boolean") fail("enabled must be boolean");
  if (raw.mode !== "shadow" && raw.mode !== "active") fail("mode must be shadow or active");

  if (!raw.thresholds || typeof raw.thresholds !== "object") fail("thresholds are required");
  const shadowScore = boundedNumber(raw.thresholds.shadowScore, "thresholds.shadowScore", 0, 100);
  const createScore = boundedNumber(raw.thresholds.createScore, "thresholds.createScore", 0, 100);
  if (shadowScore > createScore) fail("shadowScore must not exceed createScore");
  const duplicateSimilarity = boundedNumber(raw.thresholds.duplicateSimilarity, "thresholds.duplicateSimilarity", 0, 1);

  if (!raw.requirements || typeof raw.requirements !== "object") fail("requirements are required");
  if (typeof raw.requirements.requireVerification !== "boolean") {
    fail("requirements.requireVerification must be boolean");
  }

  if (!raw.limits || typeof raw.limits !== "object") fail("limits are required");
  const limitNames = [
    "perSession",
    "perUserPerHour",
    "perUserPerDay",
    "perRepositoryPerHour",
    "perRepositoryPerDay",
    "globalPerHour",
    "globalPerDay",
  ] as const;
  const limits = {} as AutoCandidatePolicy["limits"];
  for (const name of limitNames) limits[name] = positiveInteger(raw.limits[name], `limits.${name}`);

  if (!raw.cooldown || typeof raw.cooldown !== "object") fail("cooldown is required");
  const sameRepositoryMinutes = positiveInteger(raw.cooldown.sameRepositoryMinutes, "cooldown.sameRepositoryMinutes");

  return {
    schemaVersion: 1,
    policyVersion,
    enabled: raw.enabled,
    mode: raw.mode,
    thresholds: { shadowScore, createScore, duplicateSimilarity },
    requirements: { requireVerification: raw.requirements.requireVerification },
    limits,
    cooldown: { sameRepositoryMinutes },
  };
}

export class AutoCandidatePolicyStore {
  private readonly root: string;
  private readonly historyDir: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "config", "auto-candidate-policy");
    this.historyDir = path.join(this.root, "history");
  }

  private currentFile(): string {
    return path.join(this.root, "current.json");
  }

  private historyFile(version: number): string {
    return path.join(this.historyDir, `v${version}.json`);
  }

  private async atomicWrite(file: string, value: AutoCandidatePolicy): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async readPolicy(file: string): Promise<AutoCandidatePolicy> {
    return validateAutoCandidatePolicy(JSON.parse(await readFile(file, "utf8")));
  }

  async loadCurrent(): Promise<AutoCandidatePolicy> {
    try {
      return clone(await this.readPolicy(this.currentFile()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultAutoCandidatePolicy();
      throw error;
    }
  }

  private async ensureVersionPersisted(policy: AutoCandidatePolicy): Promise<void> {
    const file = this.historyFile(policy.policyVersion);
    try {
      const existing = await this.readPolicy(file);
      if (JSON.stringify(existing) !== JSON.stringify(policy)) {
        throw new Error(`immutable history version v${policy.policyVersion} already exists with different content`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.atomicWrite(file, policy);
    }
  }

  private async writeHistoryImmutable(policy: AutoCandidatePolicy): Promise<void> {
    const file = this.historyFile(policy.policyVersion);
    try {
      const existing = await this.readPolicy(file);
      if (JSON.stringify(existing) !== JSON.stringify(policy)) {
        throw new Error(`immutable history version v${policy.policyVersion} already exists with different content`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.atomicWrite(file, policy);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async saveNext(input: AutoCandidatePolicy): Promise<AutoCandidatePolicy> {
    return await this.enqueue(async () => {
      const current = await this.loadCurrent();
      await this.ensureVersionPersisted(current);
      const validated = validateAutoCandidatePolicy({
        ...clone(input),
        schemaVersion: 1,
        policyVersion: current.policyVersion + 1,
      });
      await this.writeHistoryImmutable(validated);
      await this.atomicWrite(this.currentFile(), validated);
      return clone(validated);
    });
  }

  async history(): Promise<AutoCandidatePolicy[]> {
    const current = await this.loadCurrent();
    await mkdir(this.historyDir, { recursive: true });
    const names = await readdir(this.historyDir).catch(() => []);
    const byVersion = new Map<number, AutoCandidatePolicy>();
    for (const name of names) {
      const match = /^v(\d+)\.json$/.exec(name);
      if (!match) continue;
      const policy = await this.readPolicy(path.join(this.historyDir, name));
      byVersion.set(policy.policyVersion, policy);
    }
    byVersion.set(current.policyVersion, current);
    if (!byVersion.has(1)) byVersion.set(1, defaultAutoCandidatePolicy());
    return [...byVersion.values()].sort((a, b) => b.policyVersion - a.policyVersion).map(clone);
  }

  async rollbackTo(version: number): Promise<AutoCandidatePolicy> {
    return await this.enqueue(async () => {
      const current = await this.loadCurrent();
      await this.ensureVersionPersisted(current);
      const source = version === 1 ? defaultAutoCandidatePolicy() : await this.readPolicy(this.historyFile(version));
      const next = validateAutoCandidatePolicy({
        ...clone(source),
        schemaVersion: 1,
        policyVersion: current.policyVersion + 1,
      });
      await this.writeHistoryImmutable(next);
      await this.atomicWrite(this.currentFile(), next);
      return clone(next);
    });
  }
}
