import type { ExpertModelConfig } from "./expert-store.js";
import { createHash } from "node:crypto";
import { WorkDagJsonPlanner, type WorkDagPlannerModel } from "./work-dag-planners.js";

const FORBIDDEN_ENV = /^(PATH|HOME|CODEX_HOME|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|BASH_ENV|ENV|IFS|SHELLOPTS)$/;
const PROXY_ENV = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

export interface WorkDagPlannerModelClientOptions {
  config: ExpertModelConfig;
  credentialEnvNames?: Readonly<Record<string, string>>;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

export interface LoadedWorkDagPlannerConfig {
  config: ExpertModelConfig;
  credentialEnvNames: Record<string, string>;
  timeoutMs: number;
}

function validModelConfig(value: unknown): value is ExpertModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Partial<ExpertModelConfig>;
  if (
    typeof config.providerId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(config.providerId) ||
    typeof config.model !== "string" ||
    !config.model.trim() ||
    config.model.length > 200 ||
    (config.wireApi !== "responses" && config.wireApi !== "anthropic-messages") ||
    !Array.isArray(config.allowedEnvNames) ||
    config.allowedEnvNames.length === 0 ||
    config.allowedEnvNames.length > 100 ||
    config.allowedEnvNames.some(
      (name) =>
        typeof name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
        FORBIDDEN_ENV.test(name) ||
        name.startsWith("DOCKER_"),
    ) ||
    (config.credentialRef !== undefined &&
      (typeof config.credentialRef !== "string" || !config.credentialRef.trim() || config.credentialRef.length > 100))
  ) {
    return false;
  }
  try {
    const url = new URL(String(config.baseUrl));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      String(config.baseUrl).length > 2048
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function validCredentialMap(value: unknown, allowedEnvNames: readonly string[]): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) return false;
  const allowed = new Set(allowedEnvNames);
  return entries.every(
    ([ref, envName]) =>
      /^[A-Za-z0-9._:-]{1,100}$/.test(ref) &&
      typeof envName === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(envName) &&
      allowed.has(envName) &&
      !FORBIDDEN_ENV.test(envName) &&
      !envName.startsWith("DOCKER_"),
  );
}

function endpoint(baseUrl: string, suffix: "responses" | "messages"): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/" + suffix)) return url.toString().replace(/\/$/, "");
  url.pathname = (path || "") + "/" + suffix;
  return url.toString().replace(/\/$/, "");
}

function extractResponsesText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  if (!Array.isArray(record.output)) return null;
  const parts: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "output_text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
  }
  return parts.length ? parts.join("") : null;
}

function extractAnthropicText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.length ? parts.join("") : null;
}

export class HttpWorkDagPlannerModel implements WorkDagPlannerModel {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: WorkDagPlannerModelClientOptions) {
    if (!validModelConfig(options.config)) throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
    if (
      options.credentialEnvNames !== undefined &&
      !validCredentialMap(options.credentialEnvNames, options.config.allowedEnvNames)
    ) {
      throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
    }
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1024 ||
      this.maxResponseBytes > 8 * 1024 * 1024
    ) {
      throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
    }
  }

  private credential(): { envName: string; value: string } {
    const config = this.options.config;
    let envName: string | undefined;
    if (config.credentialRef) {
      envName = this.options.credentialEnvNames?.[config.credentialRef];
      if (!envName || !config.allowedEnvNames.includes(envName)) {
        throw new Error("PLANNER_CREDENTIAL_NOT_CONFIGURED");
      }
    } else {
      envName = config.allowedEnvNames.find((name) => !PROXY_ENV.has(name) && Boolean(this.env[name]?.trim()));
    }
    if (!envName || PROXY_ENV.has(envName)) throw new Error("PLANNER_CREDENTIAL_NOT_CONFIGURED");
    const value = this.env[envName]?.trim();
    if (!value) throw new Error("PLANNER_CREDENTIAL_NOT_CONFIGURED");
    return { envName, value };
  }

  async complete(input: { system: string; payload: Record<string, unknown> }, signal?: AbortSignal): Promise<string> {
    const credential = this.credential();
    const config = this.options.config;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    let url: string;
    let body: Record<string, unknown>;

    if (config.wireApi === "responses") {
      url = endpoint(config.baseUrl, "responses");
      headers.authorization = "Bearer " + credential.value;
      body = {
        model: config.model,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: input.system }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(input.payload),
              },
            ],
          },
        ],
      };
    } else {
      url = endpoint(config.baseUrl, "messages");
      headers["anthropic-version"] = "2023-06-01";
      if (/AUTH_TOKEN|OAUTH/i.test(credential.envName)) {
        headers.authorization = "Bearer " + credential.value;
      } else {
        headers["x-api-key"] = credential.value;
      }
      body = {
        model: config.model,
        max_tokens: 8192,
        system: input.system,
        messages: [{ role: "user", content: JSON.stringify(input.payload) }],
      };
    }

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error("PLANNER_MODEL_HTTP_" + response.status);

    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > this.maxResponseBytes) {
      throw new Error("PLANNER_MODEL_OUTPUT_TOO_LARGE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("PLANNER_MODEL_OUTPUT_INVALID");
    }
    const text = config.wireApi === "responses" ? extractResponsesText(parsed) : extractAnthropicText(parsed);
    if (!text || Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
      throw new Error(text ? "PLANNER_MODEL_OUTPUT_TOO_LARGE" : "PLANNER_MODEL_OUTPUT_INVALID");
    }
    return text;
  }
}

export function createConfiguredWorkDagPlanner(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): { planner: WorkDagJsonPlanner; timeoutMs: number } | null {
  const loaded = loadWorkDagPlannerConfig(env);
  if (!loaded) return null;
  const version = createHash("sha256")
    .update(
      JSON.stringify({
        providerId: loaded.config.providerId,
        model: loaded.config.model,
        baseUrl: loaded.config.baseUrl,
        wireApi: loaded.config.wireApi,
        credentialRef: loaded.config.credentialRef ?? null,
        allowedEnvNames: loaded.config.allowedEnvNames,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    planner: new WorkDagJsonPlanner(
      new HttpWorkDagPlannerModel({
        config: loaded.config,
        credentialEnvNames: loaded.credentialEnvNames,
        env,
        fetchImpl,
      }),
      "llm:" + loaded.config.providerId + ":" + loaded.config.model,
      version,
    ),
    timeoutMs: loaded.timeoutMs,
  };
}

export function loadWorkDagPlannerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LoadedWorkDagPlannerConfig | null {
  const rawConfig = env.EXPERT_WORK_DAG_PLANNER_MODEL_CONFIG_JSON?.trim();
  if (!rawConfig) return null;
  let config: unknown;
  try {
    config = JSON.parse(rawConfig);
  } catch {
    throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
  }
  if (!validModelConfig(config)) throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");

  let credentialEnvNames: unknown = {};
  const rawCredentials = env.EXPERT_WORK_DAG_PLANNER_CREDENTIAL_REFS_JSON?.trim();
  if (rawCredentials) {
    try {
      credentialEnvNames = JSON.parse(rawCredentials);
    } catch {
      throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
    }
  }
  if (!validCredentialMap(credentialEnvNames, config.allowedEnvNames)) {
    throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
  }

  const rawTimeout = env.EXPERT_WORK_DAG_PLANNER_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10 * 60_000) {
    throw new Error("INVALID_WORK_DAG_PLANNER_CONFIG");
  }
  return {
    config: structuredClone(config),
    credentialEnvNames: { ...(credentialEnvNames as Record<string, string>) },
    timeoutMs,
  };
}
