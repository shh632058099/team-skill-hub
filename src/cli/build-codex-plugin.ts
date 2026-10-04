import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_HOOK_RUNTIME_VERSION,
  CURRENT_HOOK_SCHEMA_VERSION
} from "../client-events.js";

interface Options {
  url: string;
  apiKeyEnv: string;
  out: string;
  marketplaceRoot?: string;
  marketplaceName: string;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function options(): Options {
  const rawUrl = argument("--url");
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    throw new Error("--url must be an http(s) Team Skill Hub MCP URL");
  }
  const apiKeyEnv = argument("--api-key-env") ?? "TEAM_SKILL_HUB_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error("--api-key-env must be a valid environment variable name");
  }
  const trimmed = rawUrl.replace(/\/+$/, "");
  const marketplaceRoot = argument("--marketplace-root");
  return {
    url: trimmed.endsWith("/mcp") ? trimmed : trimmed + "/mcp",
    apiKeyEnv,
    out: path.resolve(argument("--out") ?? "dist/plugins/team-skill-hub"),
    ...(marketplaceRoot ? { marketplaceRoot: path.resolve(marketplaceRoot) } : {}),
    marketplaceName: argument("--marketplace-name") ?? "team-skill-hub"
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function main(): Promise<void> {
  const root = process.cwd();
  const opts = options();
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  ) as { version: string };
  const version = packageJson.version;
  const eventUrl = opts.url.replace(/\/mcp$/, "/client-events");

  await rm(opts.out, { recursive: true, force: true });
  await mkdir(path.join(opts.out, "hooks"), { recursive: true });
  await mkdir(path.join(opts.out, "skills", "team-skill-hub"), { recursive: true });

  await writeFile(
    path.join(opts.out, "plugin.json"),
    json({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "team-skill-hub",
      version,
      description:
        "Discover and reuse internal engineering Skills, Knowledge, Prompts, Agents, and Tools through Team Skill Hub.",
      license: "Apache-2.0",
      keywords: ["engineering", "knowledge", "mcp", "codex"],
      extensions: {
        "com.openai": {
          hooks: "./hooks/hooks.json",
          interface: {
            displayName: "Team Skill Hub",
            shortDescription: "Reuse verified internal engineering knowledge.",
            longDescription:
              "Connect Codex to Team Skill Hub for internal engineering discovery, evidence-aware feedback, and human-reviewed knowledge capture.",
            developerName: "Team Skill Hub",
            category: "Productivity",
            capabilities: ["Read", "Write"],
            defaultPrompt: [
              "Use Team Skill Hub to find relevant internal guidance before implementing this task.",
              "Search Team Skill Hub for verified prior solutions related to this issue."
            ]
          }
        }
      }
    })
  );

  await writeFile(
    path.join(opts.out, "mcp.json"),
    json({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        teamSkillHub: {
          type: "streamable-http",
          url: opts.url,
          bearer_token_env_var: opts.apiKeyEnv
        }
      }
    })
  );

  const handler = {
    type: "command",
    command: 'bash "$PLUGIN_ROOT/hooks/team-skill-hub-hook.sh"',
    commandWindows:
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& \\"$env:PLUGIN_ROOT\\\\hooks\\\\team-skill-hub-hook.ps1\\""',
    async: true,
    timeout: 2
  };
  const hooks: Record<string, unknown[]> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
    hooks[event] = [{ hooks: [handler] }];
  }
  for (const event of ["PreToolUse", "PreCompact", "PostCompact"]) {
    hooks[event] = [{ matcher: "^__team_skill_hub_reserved__$", hooks: [handler] }];
  }
  await writeFile(
    path.join(opts.out, "hooks", "hooks.json"),
    json({
      description: "Team Skill Hub lifecycle telemetry and knowledge feedback hooks.",
      hooks
    })
  );

  await cp(
    path.join(root, "scripts", "team-skill-hub-hook.sh"),
    path.join(opts.out, "hooks", "team-skill-hub-hook.sh")
  );
  await cp(
    path.join(root, "scripts", "team-skill-hub-hook.ps1"),
    path.join(opts.out, "hooks", "team-skill-hub-hook.ps1")
  );
  await writeFile(
    path.join(opts.out, "hooks", "team-skill-hub.conf"),
    [
      "event_url=" + eventUrl,
      "server_name=teamSkillHub",
      "api_key_env=" + opts.apiKeyEnv,
      "capture_stop_message=true",
      "runtime_version=" + CURRENT_HOOK_RUNTIME_VERSION,
      "hook_schema_version=" + CURRENT_HOOK_SCHEMA_VERSION,
      ""
    ].join("\n")
  );

  const skill = [
    "---",
    "name: team-skill-hub",
    "description: Use Team Skill Hub proactively for internal engineering Skills, Knowledge, Prompts, Agents, and Tools.",
    "---",
    "",
    "# Team Skill Hub",
    "",
    "For non-trivial engineering tasks, query the bundled teamSkillHub MCP server before implementing or reviewing from scratch when reusable internal guidance may exist.",
    "",
    "1. Prefer discover first to get relevant Skills, Knowledge, Prompts, Agents, and Tools together.",
    "2. Load only selected assets with get_skill, get_knowledge, get_prompt, get_agent, or get_tool.",
    "3. Prefer relevant team assets over generic assumptions while respecting repository visibility and client compatibility.",
    "4. Submit concise evidence-based feedback when retrieved guidance is clearly outdated or incorrect.",
    "5. Submit a Knowledge Candidate for durable verified team-specific knowledge that is missing. Never submit secrets, credentials, customer-sensitive data, or speculative conclusions.",
    "6. Do not invoke repository sync, rollback, or administrative operations unless the user explicitly asks for that operational action.",
    ""
  ].join("\n");
  await writeFile(path.join(opts.out, "skills", "team-skill-hub", "SKILL.md"), skill);

  if (opts.marketplaceRoot) {
    const pluginDir = path.join(opts.marketplaceRoot, "plugins", "team-skill-hub");
    await rm(pluginDir, { recursive: true, force: true });
    await mkdir(path.dirname(pluginDir), { recursive: true });
    await cp(opts.out, pluginDir, { recursive: true });
    const catalogDir = path.join(opts.marketplaceRoot, ".agents", "plugins");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(
      path.join(catalogDir, "marketplace.json"),
      json({
        name: opts.marketplaceName,
        interface: { displayName: "Team Skill Hub" },
        plugins: [
          {
            name: "team-skill-hub",
            source: { source: "local", path: "./plugins/team-skill-hub" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity"
          }
        ]
      })
    );
  }

  console.log(
    json({
      ok: true,
      version,
      pluginDir: opts.out,
      hookRuntimeVersion: CURRENT_HOOK_RUNTIME_VERSION,
      hookSchemaVersion: CURRENT_HOOK_SCHEMA_VERSION,
      mcpUrl: opts.url,
      apiKeyEnv: opts.apiKeyEnv,
      marketplaceRoot: opts.marketplaceRoot ?? null
    }).trim()
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
