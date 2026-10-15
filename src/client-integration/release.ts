import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ClientIntegrationRelease {
  schemaVersion: number;
  version: number;
  minimumSupportedVersion: number;
  hookRuntimeVersion: string;
  hookSchemaVersion: number;
}

export interface ClientIntegrationManifest {
  schema_version: number;
  version: number;
  minimum_supported_version: number;
  released_at: string;
  server_compatibility: { min: string; max: string };
  restart_required: boolean;
  summary: string;
  packages: {
    linux: { path: string; sha256: string };
    windows: { path: string; sha256: string };
  };
}

function validateRelease(value: unknown): ClientIntegrationRelease {
  if (!value || typeof value !== "object") throw new Error("release metadata must be an object");
  const v = value as Record<string, unknown>;
  const release: ClientIntegrationRelease = {
    schemaVersion: Number(v.schemaVersion),
    version: Number(v.version),
    minimumSupportedVersion: Number(v.minimumSupportedVersion),
    hookRuntimeVersion: String(v.hookRuntimeVersion ?? ""),
    hookSchemaVersion: Number(v.hookSchemaVersion)
  };
  if (release.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!Number.isInteger(release.version) || release.version <= 0) throw new Error("version must be a positive integer");
  if (!Number.isInteger(release.minimumSupportedVersion) || release.minimumSupportedVersion <= 0) throw new Error("minimumSupportedVersion must be a positive integer");
  if (release.minimumSupportedVersion > release.version) throw new Error("minimumSupportedVersion must not exceed version");
  if (!release.hookRuntimeVersion.trim()) throw new Error("hookRuntimeVersion is required");
  if (!Number.isInteger(release.hookSchemaVersion) || release.hookSchemaVersion <= 0) throw new Error("hookSchemaVersion must be a positive integer");
  return release;
}

export async function loadClientIntegrationRelease(root = process.cwd()): Promise<ClientIntegrationRelease> {
  const file = path.join(root, "client-integration", "release.json");
  return validateRelease(JSON.parse(await readFile(file, "utf8")));
}

export function buildClientIntegrationManifest(
  release: ClientIntegrationRelease,
  options: {
    releasedAt: string;
    serverVersion: string;
    linuxSha256: string;
    windowsSha256: string;
    restartRequired?: boolean;
    summary?: string;
  }
): ClientIntegrationManifest {
  return {
    schema_version: release.schemaVersion,
    version: release.version,
    minimum_supported_version: release.minimumSupportedVersion,
    released_at: options.releasedAt,
    server_compatibility: { min: options.serverVersion, max: options.serverVersion },
    restart_required: options.restartRequired ?? true,
    summary: options.summary ?? "Team Skill Hub client integration update",
    packages: {
      linux: { path: `releases/${release.version}/linux.tar.gz`, sha256: options.linuxSha256 },
      windows: { path: `releases/${release.version}/windows.zip`, sha256: options.windowsSha256 }
    }
  };
}
