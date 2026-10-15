import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

async function fakeClaude(bin: string) { await writeFile(path.join(bin, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 }); }

test("bash setup bootstraps shared runtime state with absolute custom homes and no secret", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bootstrap-"));
  const codex = path.join(home, "custom-codex"); const claude = path.join(home, "custom-claude"); const bin = path.join(home, "bin");
  await mkdir(bin); await fakeClaude(bin);
  const env = { ...process.env, HOME: home, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, PATH: `${bin}:${process.env.PATH ?? ""}`, TEAM_SKILL_HUB_API_KEY: "super-secret-key" };
  await execFileAsync("bash", ["scripts/setup-codex-mcp.sh", "--url", "http://127.0.0.1:8080/mcp"], { cwd: process.cwd(), env });
  await execFileAsync("bash", ["scripts/setup-claude-code.sh", "--url", "http://127.0.0.1:8080/mcp"], { cwd: process.cwd(), env });
  const statePath = path.join(home, ".team-skill-hub", "state.json");
  const raw = await readFile(statePath, "utf8"); const state = JSON.parse(raw);
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
  assert.match(await readFile(path.join(codex, "hooks.json"), "utf8"), /team-skill-hub-client.*session-start/);
  const claudeSettings = await readFile(path.join(claude, "settings.json"), "utf8");
  assert.match(claudeSettings, /team-skill-hub-client.*session-start --client claude/);
  assert.match(claudeSettings, /team-skill-hub-client.*session-start-display --client claude/);
});

test("second client targeting a different Hub fails before setup mutation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bootstrap-"));
  const codex = path.join(home, "codex"); const claude = path.join(home, "claude"); const bin = path.join(home, "bin");
  await mkdir(bin); await fakeClaude(bin);
  const env = { ...process.env, HOME: home, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, PATH: `${bin}:${process.env.PATH ?? ""}` };
  await execFileAsync("bash", ["scripts/setup-codex-mcp.sh", "--url", "http://hub-one:8080/mcp"], { cwd: process.cwd(), env });
  await assert.rejects(() => execFileAsync("bash", ["scripts/setup-claude-code.sh", "--url", "http://hub-two:8080/mcp"], { cwd: process.cwd(), env }), /different Team Skill Hub|different Hub/i);
  await assert.rejects(() => stat(path.join(claude, "settings.json")));
});

test("bootstrap refuses to downgrade a newer installed runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-hub-bootstrap-downgrade-"));
  const config = path.join(home, "codex");
  const root = path.join(home, ".team-skill-hub");
  await mkdir(root, { recursive: true });
  const releaseVersion = JSON.parse(await readFile("client-integration/release.json", "utf8")).version;
  const newerVersion = releaseVersion + 1;
  await writeFile(path.join(root, "state.json"), JSON.stringify({ schema_version: 1, installed_version: newerVersion, hub_base_url: "http://127.0.0.1:8080", api_key_env: "TEAM_SKILL_HUB_API_KEY", clients: {} }));
  await writeFile(path.join(root, "current"), `${newerVersion}\n`);
  await assert.rejects(() => execFileAsync("bash", ["scripts/bootstrap-client-integration.sh", "--client", "codex", "--config-home", config, "--hub-base-url", "http://127.0.0.1:8080", "--server-name", "teamSkillHub", "--api-key-env", "TEAM_SKILL_HUB_API_KEY"], { cwd: process.cwd(), env: { ...process.env, HOME: home } }), /newer.*installed|downgrade/i);
  assert.equal(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).installed_version, newerVersion);
  assert.equal((await readFile(path.join(root, "current"), "utf8")).trim(), String(newerVersion));
});

test("PowerShell setup scripts contain runtime bootstrap and SessionStart integration", async () => {
  for (const file of ["scripts/setup-codex-mcp.ps1", "scripts/setup-claude-code.ps1"]) {
    const source = await readFile(file, "utf8");
    assert.match(source, /bootstrap-client-integration\.ps1/);
    assert.match(source, /session-start/);
    if (file.endsWith("setup-claude-code.ps1")) assert.match(source, /session-start-display/);
  }
});
