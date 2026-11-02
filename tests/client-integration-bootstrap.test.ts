import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

async function fakeClaude(bin: string) {
  await writeFile(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

test("bash setup bootstraps shared runtime state with absolute custom homes and no secret", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bootstrap-"));
  const codex = path.join(home, "custom-codex");
  const claude = path.join(home, "custom-claude");
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await fakeClaude(bin);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TEAM_SKILL_HUB_API_KEY: "super-secret-key",
  };
  await execFileAsync("bash", ["scripts/setup-codex-mcp.sh", "--url", "http://127.0.0.1:8080/mcp"], {
    cwd: process.cwd(),
    env,
  });
  await execFileAsync("bash", ["scripts/setup-claude-code.sh", "--url", "http://127.0.0.1:8080/mcp"], {
    cwd: process.cwd(),
    env,
  });
  const statePath = path.join(home, ".team-skill-hub", "state.json");
  const raw = await readFile(statePath, "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.hub_base_url, "http://127.0.0.1:8080");
  assert.equal(state.clients.codex.config_home, path.resolve(codex));
  assert.equal(state.clients.claude.config_home, path.resolve(claude));
  assert.equal(state.api_key_env, "TEAM_SKILL_HUB_API_KEY");
  assert.doesNotMatch(raw, /super-secret-key/);
  const releaseVersion = JSON.parse(await readFile("client-integration/release.json", "utf8")).version;
  assert.equal(state.installed_version, releaseVersion);
  await stat(path.join(home, ".team-skill-hub", "bin", "team-skill-hub-client"));
  await stat(path.join(home, ".team-skill-hub", "releases", `v${releaseVersion}`, "templates", "codex-guidance.md"));
  await stat(path.join(home, ".team-skill-hub", "releases", `v${releaseVersion}`, "scripts", "team-skill-hub-hook.sh"));
  await stat(
    path.join(home, ".team-skill-hub", "releases", `v${releaseVersion}`, "scripts", "codex", "expert-session-hook.py"),
  );
  await stat(path.join(codex, "hooks", "expert-session-hook.py"));
  const codexHooks = JSON.parse(await readFile(path.join(codex, "hooks.json"), "utf8"));
  const codexSessionHook = codexHooks.hooks.PreToolUse.find(
    (group: { matcher?: string }) => group.matcher === "^mcp__[A-Za-z0-9_-]+__submit_expert_task(_auto)?$",
  );
  assert.ok(codexSessionHook);
  assert.equal(codexSessionHook.hooks[0].async, false);
  assert.match(await readFile(path.join(codex, "hooks.json"), "utf8"), /team-skill-hub-client.*session-start/);
  const codexConfig = await readFile(path.join(codex, "config.toml"), "utf8");
  assert.match(codexConfig, /\[sandbox_workspace_write\]/);
  assert.match(
    codexConfig,
    new RegExp(`writable_roots\\s*=\\s*\\[[^\\]]*${home.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\/.team-skill-hub`),
  );
  const claudeSettings = await readFile(path.join(claude, "settings.json"), "utf8");
  assert.match(claudeSettings, /team-skill-hub-client.*session-start --client claude/);
  assert.match(claudeSettings, /team-skill-hub-client.*session-start-display --client claude/);
  const sessionHookFile = path.join(claude, "hooks", "team-skill-hub-expert-session.py");
  await stat(sessionHookFile);
  assert.equal(
    await readFile(sessionHookFile, "utf8"),
    await readFile("scripts/claude/expert-session-hook.py", "utf8"),
  );
  const sessionMatcher = "^mcp__teamSkillHub__(submit_expert_task|submit_expert_task_auto)$";
  let groups = JSON.parse(claudeSettings).hooks.PreToolUse as Array<{
    matcher?: string;
    hooks?: Array<{ command?: string }>;
  }>;
  assert.equal(groups.filter((group) => group.matcher === sessionMatcher).length, 1);
  // Re-run Setup from the installed release itself. Bootstrap must not delete its source.
  await execFileAsync(
    "bash",
    [
      path.join(home, ".team-skill-hub", "releases", `v${releaseVersion}`, "scripts", "setup-claude-code.sh"),
      "--url",
      "http://127.0.0.1:8080/mcp",
      "--skip-mcp",
    ],
    { cwd: process.cwd(), env },
  );
  await stat(path.join(home, ".team-skill-hub", "releases", `v${releaseVersion}`, "release.json"));
  // Re-running setup updates the managed hook without duplicating it or other settings.
  await execFileAsync("bash", ["scripts/setup-claude-code.sh", "--url", "http://127.0.0.1:8080/mcp"], {
    cwd: process.cwd(),
    env,
  });
  groups = JSON.parse(await readFile(path.join(claude, "settings.json"), "utf8")).hooks.PreToolUse;
  assert.equal(groups.filter((group) => group.matcher === sessionMatcher).length, 1);

  const codexGuidance = await readFile(path.join(codex, "AGENTS.md"), "utf8");
  const claudeGuidance = await readFile(path.join(claude, "CLAUDE.md"), "utf8");
  for (const guidance of [codexGuidance, claudeGuidance]) {
    assert.match(guidance, /get_knowledge_submission_spec/);
    assert.match(guidance, /submit_knowledge_candidate/);
    assert.doesNotMatch(guidance, /## 问题/);
    assert.doesNotMatch(guidance, /exact six-section/i);
  }
  assert.ok(releaseVersion >= 7, "single-file remote bootstrap requires client integration v7 or newer");
});

test("second client targeting a different Hub fails before setup mutation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bootstrap-"));
  const codex = path.join(home, "codex");
  const claude = path.join(home, "claude");
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await fakeClaude(bin);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  await execFileAsync("bash", ["scripts/setup-codex-mcp.sh", "--url", "http://hub-one:8080/mcp"], {
    cwd: process.cwd(),
    env,
  });
  await assert.rejects(
    () =>
      execFileAsync("bash", ["scripts/setup-claude-code.sh", "--url", "http://hub-two:8080/mcp"], {
        cwd: process.cwd(),
        env,
      }),
    /different Team Skill Hub|different Hub/i,
  );
  await assert.rejects(() => stat(path.join(claude, "settings.json")));
});

test("bootstrap refuses to downgrade a newer installed runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bootstrap-downgrade-"));
  const config = path.join(home, "codex");
  const root = path.join(home, ".team-skill-hub");
  await mkdir(root, { recursive: true });
  const releaseVersion = JSON.parse(await readFile("client-integration/release.json", "utf8")).version;
  const newerVersion = releaseVersion + 1;
  await writeFile(
    path.join(root, "state.json"),
    JSON.stringify({
      schema_version: 1,
      installed_version: newerVersion,
      hub_base_url: "http://127.0.0.1:8080",
      api_key_env: "TEAM_SKILL_HUB_API_KEY",
      clients: {},
    }),
  );
  await writeFile(path.join(root, "current"), `${newerVersion}\n`);
  await assert.rejects(
    () =>
      execFileAsync(
        "bash",
        [
          "scripts/bootstrap-client-integration.sh",
          "--client",
          "codex",
          "--config-home",
          config,
          "--hub-base-url",
          "http://127.0.0.1:8080",
          "--server-name",
          "teamSkillHub",
          "--api-key-env",
          "TEAM_SKILL_HUB_API_KEY",
        ],
        { cwd: process.cwd(), env: { ...process.env, HOME: home } },
      ),
    /newer.*installed|downgrade/i,
  );
  assert.equal(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).installed_version, newerVersion);
  assert.equal((await readFile(path.join(root, "current"), "utf8")).trim(), String(newerVersion));
});

test("setup scripts support remote bootstrap fallback from the Hub", async () => {
  for (const file of [
    "scripts/setup-codex-mcp.ps1",
    "scripts/setup-claude-code.ps1",
    "scripts/setup-codex-mcp.sh",
    "scripts/setup-claude-code.sh",
  ]) {
    const source = await readFile(file, "utf8");
    assert.match(source, /bootstrap-client-integration\.(?:ps1|sh)/);
    assert.match(source, /client-integration\/bootstrap-client-integration/);
    assert.match(source, /control characters.*HTTP header/i);
    assert.match(source, /ClientReleaseDir|CLIENT_RELEASE_DIR/);
    assert.match(source, /session-start/);
    if (file.includes("claude-code")) assert.match(source, /session-start-display/);
    if (file.includes("codex-mcp")) {
      assert.match(source, /expert-session-hook/);
      assert.match(source, /submit_expert_task/);
      assert.match(source, /\/hooks.*review\/trust/i);
    }
  }
});

test("PowerShell Codex setup normalizes Windows writable roots for TOML", async () => {
  const source = await readFile("scripts/setup-codex-mcp.ps1", "utf8");
  assert.match(source, /\.Replace\('\\', '\/'\)/);
  assert.doesNotMatch(source, /\.Replace\('\\\\', '\/'\)/);
  assert.match(source, /legacyQuotedRoot/);
  assert.match(source, /\.Replace\(\$legacyQuotedRoot, \$quotedRoot\)/);
});

test("bash setup rejects API key values containing HTTP header control characters", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-invalid-key-"));
  const codex = path.join(home, "codex");
  await assert.rejects(
    () =>
      execFileAsync("bash", ["scripts/setup-codex-mcp.sh", "--url", "http://127.0.0.1:8080/mcp"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, CODEX_HOME: codex, TEAM_SKILL_HUB_API_KEY: "bad\nkey" },
      }),
    /API key.*control|HTTP header/i,
  );
  await assert.rejects(() => stat(path.join(codex, "config.toml")));
});
