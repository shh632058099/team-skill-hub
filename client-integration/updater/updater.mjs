import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BEGIN = "<!-- BEGIN TEAM-SKILL-HUB -->";
const END = "<!-- END TEAM-SKILL-HUB -->";
const MCP_BEGIN = "# BEGIN TEAM-SKILL-HUB MCP";
const MCP_END = "# END TEAM-SKILL-HUB MCP";

async function exists(file) { return stat(file).then(() => true, () => false); }
async function readText(file, fallback = "") { return (await exists(file)) ? readFile(file, "utf8") : fallback; }
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text);
  await rename(temp, file);
}
function replaceBlock(content, begin, end, block) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out = []; let skipping = false;
  for (const line of lines) {
    if (line === begin) { skipping = true; continue; }
    if (skipping && line === end) { skipping = false; continue; }
    if (!skipping) out.push(line);
  }
  const base = out.join("\n").trimEnd();
  return (base ? base + "\n\n" : "") + block.trimEnd() + "\n";
}
function guidanceBlock(serverName) {
  return `${BEGIN}\n## Team Skill Hub\n\nUse the \`${serverName}\` MCP server proactively for team-specific engineering work.\n\nWhen Team Skill Hub reports a client integration update, never upgrade silently. Only when the user explicitly asks to upgrade, run \`team-skill-hub-client upgrade\`; after a required update, restart the CLI before relying on new integration behavior.\n${END}`;
}
function codexMcpBlock(serverName, url, apiKeyEnv) {
  return `${MCP_BEGIN}\n[mcp_servers.${serverName}]\nurl = "${url}"\nbearer_token_env_var = "${apiKeyEnv}"\ndefault_tools_approval_mode = "approve"\n${MCP_END}`;
}
function removeLegacyTomlServer(content, serverName) {
  if (content.includes(MCP_BEGIN)) return content;
  const lines = content.split(/\r?\n/); const out = []; let skip = false;
  for (const line of lines) {
    if (!skip && line.trim() === `[mcp_servers.${serverName}]`) { skip = true; continue; }
    if (skip && /^\s*\[[^\]]+\]\s*$/.test(line)) skip = false;
    if (!skip) out.push(line);
  }
  return out.join("\n");
}
function commandHook(command, windowsCommand) {
  return { type: "command", command, commandWindows: windowsCommand, timeout: 2 };
}
function mergeHook(root, event, marker, handler) {
  root.hooks ||= {};
  const kept = [];
  for (const group of root.hooks[event] || []) {
    const hooks = (group.hooks || []).filter((h) => !String(h.command || "").includes(marker) && !String(h.commandWindows || "").includes(marker));
    if (hooks.length) kept.push({ ...group, hooks });
  }
  kept.push({ hooks: [handler] });
  root.hooks[event] = kept;
}

export async function applyManagedConfig(context) {
  const { state, clientRoot } = context;
  const codex = state.clients?.codex?.enabled ? state.clients.codex : null;
  const claude = state.clients?.claude?.enabled ? state.clients.claude : null;
  let claudeSettings = null;
  if (claude) {
    const settingsFile = path.join(claude.config_home, "settings.json");
    const raw = await readText(settingsFile, "{}");
    try { claudeSettings = raw.trim() ? JSON.parse(raw) : {}; }
    catch { throw new Error(`Existing Claude settings.json is invalid JSON: ${settingsFile}`); }
  }
  const launcher = path.join(clientRoot, "bin", "team-skill-hub-client").replaceAll("\\", "/");
  const mcpUrl = `${String(state.hub_base_url).replace(/\/$/, "")}/mcp`;
  if (codex) {
    await mkdir(codex.config_home, { recursive: true });
    const configFile = path.join(codex.config_home, "config.toml");
    const agentsFile = path.join(codex.config_home, "AGENTS.md");
    const hooksFile = path.join(codex.config_home, "hooks.json");
    const originalConfig = await readText(configFile);
    const config = replaceBlock(removeLegacyTomlServer(originalConfig, codex.server_name), MCP_BEGIN, MCP_END, codexMcpBlock(codex.server_name, mcpUrl, state.api_key_env));
    const agents = replaceBlock(await readText(agentsFile), BEGIN, END, guidanceBlock(codex.server_name));
    let hooks = {}; const hooksRaw = await readText(hooksFile, "{}");
    try { hooks = hooksRaw.trim() ? JSON.parse(hooksRaw) : {}; } catch { throw new Error(`Existing Codex hooks.json is invalid JSON: ${hooksFile}`); }
    const normal = commandHook(`"${launcher}" lifecycle --client codex`, `powershell.exe -NoProfile -File "${clientRoot}\\bin\\team-skill-hub-client.ps1" lifecycle --client codex`);
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) mergeHook(hooks, event, "team-skill-hub-client", normal);
    const session = commandHook(`"${launcher}" session-start --client codex`, `powershell.exe -NoProfile -File "${clientRoot}\\bin\\team-skill-hub-client.ps1" session-start --client codex`);
    mergeHook(hooks, "SessionStart", "team-skill-hub-client", session);
    await writeAtomic(configFile, config);
    await writeAtomic(agentsFile, agents);
    await writeAtomic(hooksFile, JSON.stringify(hooks, null, 2) + "\n");
  }
  if (claude) {
    await mkdir(claude.config_home, { recursive: true });
    const settingsFile = path.join(claude.config_home, "settings.json");
    const mdFile = path.join(claude.config_home, "CLAUDE.md");
    claudeSettings.permissions ||= {}; const allow = Array.isArray(claudeSettings.permissions.allow) ? claudeSettings.permissions.allow : [];
    const rule = `mcp__${claude.server_name}__*`; if (!allow.includes(rule)) allow.push(rule); claudeSettings.permissions.allow = allow;
    claudeSettings.hooks ||= {};
    const session = { type: "command", command: `"${launcher}" session-start --client claude`, timeout: 2 };
    mergeHook(claudeSettings, "SessionStart", "team-skill-hub-client", session);
    await writeAtomic(settingsFile, JSON.stringify(claudeSettings, null, 2) + "\n");
    await writeAtomic(mdFile, replaceBlock(await readText(mdFile), BEGIN, END, guidanceBlock(claude.server_name)));
  }
}

export async function selfCheckManagedConfig(context) {
  const { state } = context;
  if (state.clients?.codex?.enabled) {
    const text = await readFile(path.join(state.clients.codex.config_home, "AGENTS.md"), "utf8");
    if (!text.includes(BEGIN) || !text.includes(END)) throw new Error("Codex managed guidance self-check failed");
  }
  if (state.clients?.claude?.enabled) {
    const settings = JSON.parse(await readFile(path.join(state.clients.claude.config_home, "settings.json"), "utf8"));
    const rule = `mcp__${state.clients.claude.server_name}__*`;
    if (!settings.permissions?.allow?.includes(rule)) throw new Error("Claude permission self-check failed");
  }
  return true;
}

export async function reconcileToVersion(context) {
  await applyManagedConfig(context);
  await selfCheckManagedConfig(context);
}
