import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const BEGIN = "<!-- BEGIN TEAM-SKILL-HUB -->";
const END = "<!-- END TEAM-SKILL-HUB -->";
const MCP_BEGIN = "# BEGIN TEAM-SKILL-HUB MCP";
const MCP_END = "# END TEAM-SKILL-HUB MCP";

async function exists(file) { return stat(file).then(() => true, () => false); }
async function readText(file, fallback = "") { return (await exists(file)) ? readFile(file, "utf8") : fallback; }
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

export async function renameWithRetry(source, target, renameImpl = rename, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let attempt = 0;
  while (true) {
    try {
      await renameImpl(source, target);
      return;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (!TRANSIENT_RENAME_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await sleepImpl(RENAME_RETRY_DELAYS_MS[attempt++]);
    }
  }
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text);
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}function replaceBlock(content, begin, end, block) {
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
export function windowsLauncherCommand(clientRoot) {
  const root = path.win32.normalize(clientRoot);
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.win32.join(root, "bin", "team-skill-hub-client.ps1")}"`;
}
export function launcherCommand(clientRoot, platform = process.platform) {
  if (platform === "win32") return windowsLauncherCommand(clientRoot);
  return `"${path.join(clientRoot, "bin", "team-skill-hub-client")}"`;
}

function fallbackGuidance(serverName, clientRoot) {
  return `${BEGIN}\n## Team Skill Hub\n\nUse the \`${serverName}\` MCP server proactively for team-specific engineering work.\n\nWhen Team Skill Hub reports a client integration update, never upgrade silently. Only when the user explicitly asks to upgrade, run \`${launcherCommand(clientRoot)} upgrade\`; after a required update, restart the CLI before relying on new integration behavior.\n${END}`;
}
async function renderGuidance(content, serverName, client, releaseRoot, clientRoot) {
  let block = fallbackGuidance(serverName, clientRoot);
  if (releaseRoot) {
    const templateFile = path.join(releaseRoot, "templates", `${client}-guidance.md`);
    if (await exists(templateFile)) {
      block = (await readFile(templateFile, "utf8"))
        .replaceAll("{{SERVER_NAME}}", serverName)
        .replaceAll("{{CLIENT_LAUNCHER}}", launcherCommand(clientRoot));
    }
  }
  return replaceBlock(content, BEGIN, END, block);
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
export function ensureCodexWritableRoot(content, clientRoot) {
  const fullRoot = /^[A-Za-z]:[\\/]/.test(clientRoot) ? clientRoot : path.resolve(clientRoot);
  const root = fullRoot.replaceAll("\\", "/");
  const quotedRoot = JSON.stringify(root);
  const legacyQuotedRoot = `"${fullRoot.replaceAll('"', '\\"')}"`;
  const migrated = legacyQuotedRoot === quotedRoot ? content : content.replaceAll(legacyQuotedRoot, quotedRoot);
  const normalized = migrated.replace(/\r\n/g, "\n");
  const header = /^\[sandbox_workspace_write\]\s*$/m.exec(normalized);
  if (!header) {
    const base = normalized.trimEnd();
    return `${base ? `${base}\n\n` : ""}[sandbox_workspace_write]\nwritable_roots = [${quotedRoot}]\n`;
  }
  const sectionStart = header.index;
  const searchFrom = header.index + header[0].length;
  const nextSectionPattern = /^\[[^\]]+\]\s*$/gm;
  nextSectionPattern.lastIndex = searchFrom;
  const nextSection = nextSectionPattern.exec(normalized);
  const sectionEnd = nextSection?.index ?? normalized.length;
  const section = normalized.slice(sectionStart, sectionEnd);
  if (section.includes(quotedRoot)) return normalized;
  const arrayMatch = /^(\s*writable_roots\s*=\s*\[)([\s\S]*?)(\])/m.exec(section);
  let updatedSection;
  if (arrayMatch) {
    const existing = arrayMatch[2].trim();
    const replacement = `${arrayMatch[1]}${existing ? `${existing}, ` : ""}${quotedRoot}${arrayMatch[3]}`;
    updatedSection = section.slice(0, arrayMatch.index) + replacement + section.slice(arrayMatch.index + arrayMatch[0].length);
  } else {
    updatedSection = `${section.trimEnd()}\nwritable_roots = [${quotedRoot}]\n`;
  }
  return normalized.slice(0, sectionStart) + updatedSection + normalized.slice(sectionEnd);
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
function removeManagedHooks(root, event, markers) {
  root.hooks ||= {};
  const kept = [];
  for (const group of root.hooks[event] || []) {
    const hooks = (group.hooks || []).filter((hook) => {
      const commands = [String(hook.command || ""), String(hook.commandWindows || "")];
      return !markers.some((marker) => commands.some((command) => command.includes(marker)));
    });
    if (hooks.length) kept.push({ ...group, hooks });
  }
  root.hooks[event] = kept;
}
function replaceManagedToolHook(root, event, markers, matcher, handler) {
  removeManagedHooks(root, event, markers);
  root.hooks[event].push({ matcher, hooks: [handler] });
}
async function readKeyValueFile(file) {
  const values = {};
  const raw = await readText(file);
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) values[line.slice(0, i)] = line.slice(i + 1);
  }
  return values;
}
async function getReleaseMetadata(context) {
  if (context.releaseMetadata) return context.releaseMetadata;
  if (!context.releaseRoot) return null;
  return JSON.parse(await readFile(path.join(context.releaseRoot, "release.json"), "utf8"));
}
async function updateHookFiles(context) {
  if (!context.releaseRoot) return;
  const meta = await getReleaseMetadata(context);
  const { state, releaseRoot } = context;
  const codex = state.clients?.codex?.enabled ? state.clients.codex : null;
  if (codex) {
    const hooksDir = path.join(codex.config_home, "hooks");
    await mkdir(hooksDir, { recursive: true });
    const copies = [
      ["scripts/team-skill-hub-hook.sh", "team-skill-hub-hook.sh"],
      ["scripts/team-skill-hub-hook.ps1", "team-skill-hub-hook.ps1"],
      ["scripts/codex/expert-session-hook.py", "expert-session-hook.py"],
      ["scripts/codex/expert-session-hook.ps1", "expert-session-hook.ps1"],
    ];
    for (const [sourceRel, targetName] of copies) {
      const source = path.join(releaseRoot, sourceRel);
      const target = path.join(hooksDir, targetName);
      if (await exists(source)) {
        await copyFile(source, target);
        if (targetName.endsWith(".sh") || targetName.endsWith(".py")) await chmod(target, 0o755).catch(() => {});
      }
    }
    const conf = path.join(hooksDir, "team-skill-hub.conf");
    const old = await readKeyValueFile(conf);
    const eventUrl = `${String(state.hub_base_url).replace(/\/$/, "")}/client-events`;
    await writeAtomic(conf, `event_url=${eventUrl}\nserver_name=${codex.server_name}\napi_key_env=${state.api_key_env}\ncapture_stop_message=${old.capture_stop_message ?? "true"}\nruntime_version=${meta?.hookRuntimeVersion ?? old.runtime_version ?? "unknown"}\nhook_schema_version=${meta?.hookSchemaVersion ?? old.hook_schema_version ?? "0"}\n`);
  }
  const claude = state.clients?.claude?.enabled ? state.clients.claude : null;
  if (claude) {
    const hooksDir = path.join(claude.config_home, "hooks");
    await mkdir(hooksDir, { recursive: true });
    const copies = [
      ["scripts/team-skill-hub-claude-stop.sh", "team-skill-hub-claude-stop.sh"],
      ["scripts/claude/stop-hook.ps1", "team-skill-hub-claude-stop.ps1"],
      ["scripts/claude/expert-session-hook.py", "team-skill-hub-expert-session.py"],
      ["scripts/claude/expert-session-hook.ps1", "team-skill-hub-expert-session.ps1"],
    ];
    for (const [sourceRel, targetName] of copies) {
      const source = path.join(releaseRoot, sourceRel);
      const target = path.join(hooksDir, targetName);
      if (await exists(source)) {
        await copyFile(source, target);
        if (targetName.endsWith(".sh") || targetName.endsWith(".py")) await chmod(target, 0o755).catch(() => {});
      }
    }
    const conf = path.join(hooksDir, "team-skill-hub.conf");
    const old = await readKeyValueFile(conf);
    const base = String(state.hub_base_url).replace(/\/$/, "");
    await writeAtomic(conf, `event_url=${base}/client-events/claude-code\nmcp_url=${base}/mcp\nserver_name=${claude.server_name}\napi_key_env=${state.api_key_env}\ncapture_stop_message=${old.capture_stop_message ?? "true"}\nruntime_version=${meta?.hookRuntimeVersion ?? old.runtime_version ?? "unknown"}\nhook_schema_version=${meta?.hookSchemaVersion ?? old.hook_schema_version ?? "0"}\n`);
  }
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
  const sessionLauncher = launcherCommand(clientRoot);
  const windowsLauncher = windowsLauncherCommand(clientRoot);
  const mcpUrl = `${String(state.hub_base_url).replace(/\/$/, "")}/mcp`;
  if (codex) {
    await mkdir(codex.config_home, { recursive: true });
    const configFile = path.join(codex.config_home, "config.toml");
    const agentsFile = path.join(codex.config_home, "AGENTS.md");
    const hooksFile = path.join(codex.config_home, "hooks.json");
    const originalConfig = await readText(configFile);
    const withWritableRoot = ensureCodexWritableRoot(removeLegacyTomlServer(originalConfig, codex.server_name), clientRoot);
    const config = replaceBlock(withWritableRoot, MCP_BEGIN, MCP_END, codexMcpBlock(codex.server_name, mcpUrl, state.api_key_env));
    const agents = await renderGuidance(await readText(agentsFile), codex.server_name, "codex", context.releaseRoot, clientRoot);
    let hooks = {}; const hooksRaw = await readText(hooksFile, "{}");
    try { hooks = hooksRaw.trim() ? JSON.parse(hooksRaw) : {}; } catch { throw new Error(`Existing Codex hooks.json is invalid JSON: ${hooksFile}`); }
    const session = commandHook(`${sessionLauncher} session-start --client codex`, `${windowsLauncher} session-start --client codex`);
    mergeHook(hooks, "SessionStart", "team-skill-hub-client", session);
    const codexHooksDir = path.join(codex.config_home, "hooks");
    const codexSessionHook = {
      type: "command",
      command: `python3 "${path.join(codexHooksDir, "expert-session-hook.py").replaceAll("\\", "/")}"`,
      commandWindows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.win32.join(path.win32.normalize(codex.config_home), "hooks", "expert-session-hook.ps1")}"`,
      async: false,
      timeout: 5,
    };
    replaceManagedToolHook(
      hooks,
      "PreToolUse",
      ["expert-session-hook", "team-skill-hub-expert-session"],
      `^mcp__${codex.server_name}__(submit_work|update_work_source)$`,
      codexSessionHook,
    );
    mergeHook(hooks, "UserPromptSubmit", "expert-session-hook", {
      ...codexSessionHook,
      timeout: 2,
    });
    await writeAtomic(configFile, config);
    await writeAtomic(agentsFile, agents);
    await writeAtomic(hooksFile, JSON.stringify(hooks, null, 2) + "\n");
  }
  if (claude) {
    await mkdir(claude.config_home, { recursive: true });
    const settingsFile = path.join(claude.config_home, "settings.json");
    const mdFile = path.join(claude.config_home, "CLAUDE.md");
    claudeSettings.permissions ||= {}; const allow = Array.isArray(claudeSettings.permissions.allow) ? claudeSettings.permissions.allow : [];
    if (typeof claudeSettings.permissions.additionalDirectories === "string") {
      claudeSettings.permissions.additionalDirectories = [claudeSettings.permissions.additionalDirectories];
    }
    const rule = `mcp__${claude.server_name}__*`; if (!allow.includes(rule)) allow.push(rule); claudeSettings.permissions.allow = allow;
    claudeSettings.hooks ||= {};
    const session = { type: "command", command: `${sessionLauncher} session-start --client claude`, timeout: 2 };
    const display = { type: "command", command: `${sessionLauncher} session-start-display --client claude`, timeout: 2 };
    mergeHook(claudeSettings, "SessionStart", "session-start-display --client claude", display);
    mergeHook(claudeSettings, "SessionStart", "session-start --client claude", session);
    removeManagedHooks(claudeSettings, "PreToolUse", ["expert-session-hook", "team-skill-hub-expert-session"]);
    removeManagedHooks(claudeSettings, "UserPromptSubmit", ["expert-session-hook", "team-skill-hub-expert-session"]);
    if (claude.server_name === "teamSkillHub") {
      const claudeHooksDir = path.join(claude.config_home, "hooks");
      const command =
        process.platform === "win32"
          ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.win32.join(path.win32.normalize(claude.config_home), "hooks", "team-skill-hub-expert-session.ps1")}"`
          : `python3 "${path.join(claudeHooksDir, "team-skill-hub-expert-session.py").replaceAll("\\", "/")}"`;
      claudeSettings.hooks.PreToolUse.push({
        matcher: "^mcp__teamSkillHub__(submit_work|update_work_source)$",
        hooks: [{ type: "command", command, timeout: 5 }],
      });
      mergeHook(claudeSettings, "UserPromptSubmit", "team-skill-hub-expert-session", {
        type: "command",
        command,
        async: false,
        timeout: 2,
      });
    }
    await writeAtomic(settingsFile, JSON.stringify(claudeSettings, null, 2) + "\n");
    await writeAtomic(mdFile, await renderGuidance(await readText(mdFile), claude.server_name, "claude", context.releaseRoot, clientRoot));
  }
  await updateHookFiles(context);
}

export async function selfCheckManagedConfig(context) {
  const { state } = context;
  if (state.clients?.codex?.enabled) {
    const text = await readFile(path.join(state.clients.codex.config_home, "AGENTS.md"), "utf8");
    if (!text.includes(BEGIN) || !text.includes(END)) throw new Error("Codex managed guidance self-check failed");
  }
  if (state.clients?.codex?.enabled) {
    const config = await readFile(path.join(state.clients.codex.config_home, "config.toml"), "utf8");
    const root = path.resolve(context.clientRoot).replaceAll("\\", "/");
    if (!config.includes(JSON.stringify(root))) throw new Error("Codex writable root self-check failed");
  }
  if (state.clients?.codex?.enabled) {
    const hooks = JSON.parse(await readFile(path.join(state.clients.codex.config_home, "hooks.json"), "utf8"));
    const managedPreTool = (hooks.hooks?.PreToolUse || []).filter((group) =>
      (group.hooks || []).some((hook) =>
        [String(hook.command || ""), String(hook.commandWindows || "")].some((command) => command.includes("expert-session-hook")),
      ),
    );
    const expectedMatcher = `^mcp__${state.clients.codex.server_name}__(submit_work|update_work_source)$`;
    if (managedPreTool.length !== 1 || managedPreTool[0]?.matcher !== expectedMatcher) {
      throw new Error("Codex Work hook self-check failed");
    }
    const managedPrompt = (hooks.hooks?.UserPromptSubmit || []).filter((group) =>
      (group.hooks || []).some((hook) =>
        [String(hook.command || ""), String(hook.commandWindows || "")].some((command) => command.includes("expert-session-hook")),
      ),
    );
    if (managedPrompt.length !== 1 || managedPrompt[0]?.hooks?.length !== 1 || managedPrompt[0]?.hooks?.[0]?.async !== false) {
      throw new Error("Codex source-request prompt hook self-check failed");
    }
    if (context.releaseRoot) {
      const hookFile = path.join(
        state.clients.codex.config_home,
        "hooks",
        process.platform === "win32" ? "expert-session-hook.ps1" : "expert-session-hook.py",
      );
      const hookSource = await readFile(hookFile, "utf8");
      if (!hookSource.includes("submit_work") || hookSource.includes("submit_expert_task")) {
        throw new Error("Codex Work hook runtime self-check failed");
      }
    }
  }
  if (state.clients?.claude?.enabled) {
    const settings = JSON.parse(await readFile(path.join(state.clients.claude.config_home, "settings.json"), "utf8"));
    const rule = `mcp__${state.clients.claude.server_name}__*`;
    if (!settings.permissions?.allow?.includes(rule)) throw new Error("Claude permission self-check failed");
    if (state.clients.claude.server_name === "teamSkillHub") {
      const managedPreTool = (settings.hooks?.PreToolUse || []).filter((group) =>
        (group.hooks || []).some((hook) => String(hook.command || "").includes("team-skill-hub-expert-session")),
      );
      if (
        managedPreTool.length !== 1 ||
        managedPreTool[0]?.matcher !== "^mcp__teamSkillHub__(submit_work|update_work_source)$"
      ) {
        throw new Error("Claude Work hook self-check failed");
      }
      const managedPrompt = (settings.hooks?.UserPromptSubmit || []).filter((group) =>
        (group.hooks || []).some((hook) => String(hook.command || "").includes("team-skill-hub-expert-session")),
      );
      if (managedPrompt.length !== 1 || managedPrompt[0]?.hooks?.length !== 1 || managedPrompt[0]?.hooks?.[0]?.async !== false) {
        throw new Error("Claude source-request prompt hook self-check failed");
      }
      if (context.releaseRoot) {
        const hookFile = path.join(
          state.clients.claude.config_home,
          "hooks",
          process.platform === "win32" ? "team-skill-hub-expert-session.ps1" : "team-skill-hub-expert-session.py",
        );
        const hookSource = await readFile(hookFile, "utf8");
        if (!hookSource.includes("submit_work") || hookSource.includes("submit_expert_task")) {
          throw new Error("Claude Work hook runtime self-check failed");
        }
      }
    }
  }
  return true;
}

export async function reconcileToVersion(context) {
  await applyManagedConfig(context);
  await selfCheckManagedConfig(context);
}
