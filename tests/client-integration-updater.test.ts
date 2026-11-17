import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const updaterUrl = new URL("../client-integration/updater/updater.mjs", import.meta.url);
const runtimeUrl = new URL("../client-integration/runtime/client-runtime.mjs", import.meta.url);

test("atomic rename retries transient Windows file-lock errors and fails fast otherwise", async () => {
  const { renameWithRetry } = await import(updaterUrl.href + `?rename-retry=${Date.now()}`);
  const attempts: string[] = [];
  const delays: number[] = [];
  await renameWithRetry(
    "source",
    "target",
    async () => {
      attempts.push("try");
      if (attempts.length < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
    async (ms: number) => {
      delays.push(ms);
    },
  );
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [50, 100]);

  let nonTransientAttempts = 0;
  await assert.rejects(
    () =>
      renameWithRetry(
        "source",
        "target",
        async () => {
          nonTransientAttempts += 1;
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        async () => {},
      ),
    /missing/,
  );
  assert.equal(nonTransientAttempts, 1);
});

test("Windows launcher normalizes doubled separators from legacy state", async () => {
  const { launcherCommand, windowsLauncherCommand } = await import(updaterUrl.href + `?launcher-path=${Date.now()}`);
  const legacyRoot = String.raw`C:\\Users\\bst\\.team-skill-hub`;
  const expected =
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\bst\\.team-skill-hub\\bin\\team-skill-hub-client.ps1"';
  assert.equal(windowsLauncherCommand(legacyRoot), expected);
  assert.equal(launcherCommand(legacyRoot, "win32"), expected);
  assert.doesNotMatch(windowsLauncherCommand(legacyRoot), /C:\\\\Users/);
});

test("Codex writable root migration repairs legacy Windows TOML paths", async () => {
  const { ensureCodexWritableRoot } = await import(updaterUrl.href + `?windows-path=${Date.now()}`);
  const legacyRoot = "C:\\Users\\bst\\.team-skill-hub";
  const content = `[sandbox_workspace_write]\nwritable_roots = ["${legacyRoot}"]\n`;
  const updated = ensureCodexWritableRoot(content, legacyRoot);
  assert.match(updated, /C:\/Users\/bst\/\.team-skill-hub/);
  assert.doesNotMatch(updated, /C:\\Users\\bst/);
});

test("managed config apply is idempotent and preserves unrelated content in custom homes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-updater-"));
  const codex = path.join(root, "custom-codex");
  const claude = path.join(root, "custom-claude");
  const clientRoot = path.join(root, "client-root");
  await mkdir(codex, { recursive: true });
  await mkdir(claude, { recursive: true });
  const existingWritableRoot = path.join(root, "existing-write-root").replaceAll("\\", "/");
  await writeFile(
    path.join(codex, "config.toml"),
    `model = "gpt-x"\n\n[sandbox_workspace_write]\nwritable_roots = ["${existingWritableRoot}"]\n`,
  );
  await writeFile(path.join(codex, "AGENTS.md"), "# Personal rules\nkeep me\n");
  await writeFile(
    path.join(claude, "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(git status)"] }, theme: "dark" }, null, 2),
  );
  await writeFile(path.join(claude, "CLAUDE.md"), "# Personal Claude\nkeep me\n");
  const { applyManagedConfig, selfCheckManagedConfig } = await import(updaterUrl.href + `?t=${Date.now()}`);
  const context = {
    clientRoot,
    state: {
      hub_base_url: "http://127.0.0.1:8080",
      api_key_env: "TEAM_SKILL_HUB_API_KEY",
      clients: {
        codex: { enabled: true, config_home: codex, server_name: "rdHub" },
        claude: { enabled: true, config_home: claude, server_name: "rdHub" },
      },
    },
  };
  await applyManagedConfig(context);
  await applyManagedConfig(context);
  await selfCheckManagedConfig(context);
  assert.match(await readFile(path.join(codex, "config.toml"), "utf8"), /model = "gpt-x"/);
  const codexConfig = await readFile(path.join(codex, "config.toml"), "utf8");
  assert.match(codexConfig, new RegExp(existingWritableRoot.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")));
  assert.match(codexConfig, new RegExp(clientRoot.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")));
  assert.equal((codexConfig.match(/\[sandbox_workspace_write\]/g) ?? []).length, 1);
  assert.equal((await readFile(path.join(codex, "AGENTS.md"), "utf8")).match(/BEGIN TEAM-SKILL-HUB/g)?.length, 1);
  const settings = JSON.parse(await readFile(path.join(claude, "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.ok(settings.permissions.allow.includes("Bash(git status)"));
  assert.equal(settings.permissions.allow.filter((x: string) => x === "mcp__rdHub__*").length, 1);
});
test("managed config upgrade migrates legacy ExpertTask hooks to Work-first hooks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-hook-migration-"));
  const codex = path.join(root, "codex");
  const claude = path.join(root, "claude");
  const releaseRoot = path.join(root, "release");
  await mkdir(path.join(codex, "hooks"), { recursive: true });
  await mkdir(path.join(claude, "hooks"), { recursive: true });
  await mkdir(path.join(releaseRoot, "scripts", "codex"), { recursive: true });
  await mkdir(path.join(releaseRoot, "scripts", "claude"), { recursive: true });

  await writeFile(path.join(codex, "config.toml"), "");
  await writeFile(path.join(codex, "AGENTS.md"), "");
  await writeFile(
    path.join(codex, "hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^mcp__teamSkillHub__(submit_expert_task|submit_expert_task_auto)$",
            hooks: [{ type: "command", command: 'python3 "old/expert-session-hook.py"' }],
          },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: 'python3 "old/expert-session-hook.py"' }] }],
      },
    }),
  );
  await writeFile(
    path.join(claude, "settings.json"),
    JSON.stringify({
      permissions: { allow: [] },
      hooks: {
        PreToolUse: [
          {
            matcher: "^mcp__teamSkillHub__(submit_expert_task|submit_expert_task_auto)$",
            hooks: [
              {
                type: "command",
                command:
                  'powershell.exe -NoProfile -File "C:\\\\Users\\\\bst\\\\.claude\\\\hooks\\\\team-skill-hub-expert-session.ps1"',
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'powershell.exe -NoProfile -File "C:\\\\Users\\\\bst\\\\.claude\\\\hooks\\\\team-skill-hub-expert-session.ps1"',
              },
            ],
          },
        ],
      },
    }),
  );
  await writeFile(path.join(claude, "CLAUDE.md"), "");

  for (const [rel, content] of [
    ["scripts/team-skill-hub-hook.sh", "generic hook\n"],
    ["scripts/team-skill-hub-hook.ps1", "generic hook\n"],
    ["scripts/team-skill-hub-claude-stop.sh", "stop hook\n"],
    ["scripts/codex/expert-session-hook.py", "submit_work update_work_source\n"],
    ["scripts/codex/expert-session-hook.ps1", "submit_work update_work_source\n"],
    ["scripts/claude/expert-session-hook.py", "submit_work update_work_source\n"],
    ["scripts/claude/expert-session-hook.ps1", "submit_work update_work_source\n"],
    ["scripts/claude/stop-hook.ps1", "stop hook\n"],
  ] as const) {
    const target = path.join(releaseRoot, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(
    path.join(releaseRoot, "release.json"),
    JSON.stringify({ hookRuntimeVersion: "1.5.4", hookSchemaVersion: 1 }),
  );

  const { applyManagedConfig, selfCheckManagedConfig } = await import(
    updaterUrl.href + `?hook-migration=${Date.now()}`
  );
  const context = {
    clientRoot: root,
    releaseRoot,
    state: {
      hub_base_url: "http://127.0.0.1:8080",
      api_key_env: "TEAM_SKILL_HUB_API_KEY",
      clients: {
        codex: { enabled: true, config_home: codex, server_name: "teamSkillHub" },
        claude: { enabled: true, config_home: claude, server_name: "teamSkillHub" },
      },
    },
  };

  await applyManagedConfig(context);
  await applyManagedConfig(context);
  await selfCheckManagedConfig(context);

  const codexHooks = JSON.parse(await readFile(path.join(codex, "hooks.json"), "utf8"));
  const codexPre = codexHooks.hooks.PreToolUse.filter((group: { matcher?: string }) =>
    group.matcher?.includes("submit_work"),
  );
  assert.equal(codexPre.length, 1);
  assert.equal(codexPre[0].matcher, "^mcp__teamSkillHub__(submit_work|update_work_source)$");
  assert.equal(
    (codexHooks.hooks.UserPromptSubmit ?? []).some((group: { hooks?: Array<{ command?: string }> }) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes("expert-session-hook")),
    ),
    false,
  );

  const claudeSettings = JSON.parse(await readFile(path.join(claude, "settings.json"), "utf8"));
  const claudePre = claudeSettings.hooks.PreToolUse.filter((group: { matcher?: string }) =>
    group.matcher?.includes("submit_work"),
  );
  assert.equal(claudePre.length, 1);
  assert.equal(claudePre[0].matcher, "^mcp__teamSkillHub__(submit_work|update_work_source)$");
  assert.equal(
    (claudeSettings.hooks.UserPromptSubmit ?? []).some((group: { hooks?: Array<{ command?: string }> }) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes("team-skill-hub-expert-session")),
    ),
    false,
  );

  const installedClaudeHook = await readFile(path.join(claude, "hooks", "team-skill-hub-expert-session.py"), "utf8");
  const installedCodexHook = await readFile(path.join(codex, "hooks", "expert-session-hook.py"), "utf8");
  for (const source of [installedClaudeHook, installedCodexHook]) {
    assert.match(source, /submit_work/);
    assert.doesNotMatch(source, /submit_expert_task/);
  }
});

test("versioned guidance template replaces only the managed block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-guidance-"));
  const codex = path.join(root, "codex");
  const releaseRoot = path.join(root, "release");
  await mkdir(codex, { recursive: true });
  await mkdir(path.join(codex, "hooks"), { recursive: true });
  await mkdir(path.join(releaseRoot, "templates"), { recursive: true });
  await mkdir(path.join(releaseRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(codex, "AGENTS.md"),
    "personal-before\n\n<!-- BEGIN TEAM-SKILL-HUB -->\nold guidance\n<!-- END TEAM-SKILL-HUB -->\n\npersonal-after\n",
  );
  await writeFile(
    path.join(codex, "hooks", "team-skill-hub.conf"),
    "capture_stop_message=false\nruntime_version=old\nhook_schema_version=1\n",
  );
  await writeFile(
    path.join(releaseRoot, "templates", "codex-guidance.md"),
    "<!-- BEGIN TEAM-SKILL-HUB -->\nUPDATED {{SERVER_NAME}} {{CLIENT_LAUNCHER}}\n<!-- END TEAM-SKILL-HUB -->\n",
  );
  await writeFile(path.join(releaseRoot, "scripts", "team-skill-hub-hook.sh"), "new shell hook\n");
  await writeFile(path.join(releaseRoot, "scripts", "team-skill-hub-hook.ps1"), "new powershell hook\n");
  await writeFile(
    path.join(releaseRoot, "release.json"),
    JSON.stringify({ hookRuntimeVersion: "2.0.0", hookSchemaVersion: 2 }),
  );
  const { applyManagedConfig } = await import(updaterUrl.href + `?guidance=${Date.now()}`);
  await applyManagedConfig({
    clientRoot: root,
    releaseRoot,
    state: {
      hub_base_url: "http://hub",
      api_key_env: "TEAM_SKILL_HUB_API_KEY",
      clients: { codex: { enabled: true, config_home: codex, server_name: "rdHub" } },
    },
  });
  const text = await readFile(path.join(codex, "AGENTS.md"), "utf8");
  assert.match(text, /personal-before/);
  assert.match(text, /personal-after/);
  assert.match(text, /UPDATED rdHub/);
  assert.doesNotMatch(text, /old guidance/);
  assert.match(text, /\.team-skill-hub|skill-hub-guidance-/);
  assert.equal(await readFile(path.join(codex, "hooks", "team-skill-hub-hook.sh"), "utf8"), "new shell hook\n");
  const conf = await readFile(path.join(codex, "hooks", "team-skill-hub.conf"), "utf8");
  assert.match(conf, /capture_stop_message=false/);
  assert.match(conf, /runtime_version=2\.0\.0/);
  assert.match(conf, /hook_schema_version=2/);
});

test("malformed Claude JSON aborts before mutating other client files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-updater-"));
  const codex = path.join(root, "codex");
  const claude = path.join(root, "claude");
  await mkdir(codex);
  await mkdir(claude);
  await writeFile(path.join(codex, "AGENTS.md"), "unchanged\n");
  await writeFile(path.join(claude, "settings.json"), "{");
  const { applyManagedConfig } = await import(updaterUrl.href + `?t=${Date.now()}`);
  const context = {
    clientRoot: root,
    state: {
      hub_base_url: "http://hub",
      api_key_env: "TEAM_SKILL_HUB_API_KEY",
      clients: {
        codex: { enabled: true, config_home: codex, server_name: "teamSkillHub" },
        claude: { enabled: true, config_home: claude, server_name: "teamSkillHub" },
      },
    },
  };
  await assert.rejects(() => applyManagedConfig(context), /settings.json/);
  assert.equal(await readFile(path.join(codex, "AGENTS.md"), "utf8"), "unchanged\n");
});

test("Windows launcher staging preserves existing bootstrap and restores missing cross-platform launcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-windows-launcher-"));
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  const releaseRoot = path.join(root, "release");
  await mkdir(path.join(releaseRoot, "runtime"), { recursive: true });
  await writeFile(path.join(releaseRoot, "runtime", "team-skill-hub-client"), "shell-v16\n");
  await writeFile(path.join(releaseRoot, "runtime", "team-skill-hub-client.ps1"), "powershell-v16\n");
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "team-skill-hub-client.ps1"), "stable-existing\n");
  await writeFile(path.join(bin, "team-skill-hub-client.ps1.next"), "stale-next\n");

  const runtime = await import(runtimeUrl.href + `?windows-launcher=${Date.now()}`);
  const state: Record<string, unknown> = { installed_version: 16, pending_launcher_version: 16 };
  await runtime.stageLauncherReplacement(releaseRoot, state, "win32");

  assert.equal(await readFile(path.join(bin, "team-skill-hub-client.ps1"), "utf8"), "stable-existing\n");
  assert.equal(await readFile(path.join(bin, "team-skill-hub-client"), "utf8"), "shell-v16\n");
  await assert.rejects(() => readFile(path.join(bin, "team-skill-hub-client.ps1.next"), "utf8"));
  assert.equal(state.pending_launcher_version, undefined);

  await writeFile(path.join(bin, "team-skill-hub-client.ps1"), "");
  const { rm } = await import("node:fs/promises");
  await rm(path.join(bin, "team-skill-hub-client.ps1"));
  await runtime.stageLauncherReplacement(releaseRoot, state, "win32");
  assert.equal(await readFile(path.join(bin, "team-skill-hub-client.ps1"), "utf8"), "powershell-v16\n");
});

test("upgrade downloads verified package and commits new current state", async () => {
  const packageOut = await mkdtemp(path.join(os.tmpdir(), "skill-hub-package-"));
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli/build-client-integration.ts", "--out", packageOut],
    { cwd: process.cwd() },
  );
  const manifest = JSON.parse(await readFile(path.join(packageOut, "manifest.json"), "utf8"));
  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (url === "/client-integration/manifest.json") {
      const body = JSON.stringify(manifest);
      res.setHeader("content-type", "application/json");
      res.end(body);
      return;
    }
    const prefix = "/client-integration/";
    if (url.startsWith(prefix)) {
      try {
        res.end(await readFile(path.join(packageOut, url.slice(prefix.length))));
      } catch {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-upgrade-e2e-"));
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  const r = await import(runtimeUrl.href + `?upgrade=${Date.now()}`);
  await r.writeStateAtomic({
    schema_version: 1,
    installed_version: 0,
    hub_base_url: `http://127.0.0.1:${address.port}`,
    api_key_env: "TEAM_SKILL_HUB_API_KEY",
    clients: {},
  });
  await r.writeCurrentVersion(0);
  try {
    const result = await r.upgradeToLatest();
    assert.equal(result.updated, true);
    assert.equal(result.version, manifest.version);
    assert.equal((await r.readState()).installed_version, manifest.version);
    assert.equal(await r.readCurrentVersion(), manifest.version);
    assert.ok(await readFile(path.join(root, "releases", `v${manifest.version}`, "updater", "updater.mjs"), "utf8"));
    assert.match(
      await readFile(path.join(root, "bin", "team-skill-hub-client"), "utf8"),
      /client integration is not installed/,
    );
    assert.match(
      await readFile(path.join(root, "bin", "team-skill-hub-client.ps1"), "utf8"),
      /Team Skill Hub client integration is not installed/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("rollback failure restores managed files and committed state immediately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-rollback-fail-"));
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  const codex = path.join(root, "codex");
  await mkdir(codex, { recursive: true });
  const agents = path.join(codex, "AGENTS.md");
  await writeFile(agents, "before\n");
  const r = await import(runtimeUrl.href + `?rollbackFail=${Date.now()}`);
  const state = {
    schema_version: 1,
    installed_version: 2,
    previous_version: 1,
    hub_base_url: "http://hub",
    api_key_env: "TEAM_SKILL_HUB_API_KEY",
    clients: { codex: { enabled: true, config_home: codex, server_name: "teamSkillHub" } },
  };
  await r.writeStateAtomic(state);
  await r.writeCurrentVersion(2);
  const updaterDir = path.join(root, "releases", "v1", "updater");
  await mkdir(updaterDir, { recursive: true });
  await writeFile(
    path.join(updaterDir, "updater.mjs"),
    `import { writeFile } from "node:fs/promises"; export async function reconcileToVersion(ctx){ await writeFile(${JSON.stringify(agents)}, "changed\\n"); throw new Error("rollback failed"); }\n`,
  );
  await assert.rejects(() => r.rollbackToPrevious(), /rollback failed/);
  assert.equal(await readFile(agents, "utf8"), "before\n");
  assert.equal((await r.readState()).installed_version, 2);
  assert.equal(await r.readCurrentVersion(), 2);
});

test("rollback switches to locally retained previous version without server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-rollback-"));
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  const r = await import(runtimeUrl.href + `?t=${Date.now()}`);
  const state = {
    schema_version: 1,
    installed_version: 2,
    previous_version: 1,
    hub_base_url: "http://127.0.0.1:1",
    api_key_env: "TEAM_SKILL_HUB_API_KEY",
    clients: {},
  };
  await r.writeStateAtomic(state);
  await r.writeCurrentVersion(2);
  await mkdir(path.join(root, "releases", "v1", "updater"), { recursive: true });
  await writeFile(
    path.join(root, "releases", "v1", "updater", "updater.mjs"),
    "export async function reconcileToVersion(){}\n",
  );
  await r.rollbackToPrevious();
  assert.equal((await r.readState()).installed_version, 1);
  assert.equal(await r.readCurrentVersion(), 1);
});
