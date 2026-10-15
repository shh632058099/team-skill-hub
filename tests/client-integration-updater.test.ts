import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const updaterUrl = new URL("../client-integration/updater/updater.mjs", import.meta.url);
const runtimeUrl = new URL("../client-integration/runtime/client-runtime.mjs", import.meta.url);

test("managed config apply is idempotent and preserves unrelated content in custom homes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-updater-"));
  const codex = path.join(root, "custom-codex");
  const claude = path.join(root, "custom-claude");
  await mkdir(codex, { recursive: true }); await mkdir(claude, { recursive: true });
  await writeFile(path.join(codex, "config.toml"), "model = \"gpt-x\"\n");
  await writeFile(path.join(codex, "AGENTS.md"), "# Personal rules\nkeep me\n");
  await writeFile(path.join(claude, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status)"] }, theme: "dark" }, null, 2));
  await writeFile(path.join(claude, "CLAUDE.md"), "# Personal Claude\nkeep me\n");
  const { applyManagedConfig, selfCheckManagedConfig } = await import(updaterUrl.href + `?t=${Date.now()}`);
  const context = { clientRoot: root, state: { hub_base_url: "http://127.0.0.1:8080", api_key_env: "TEAM_SKILL_HUB_API_KEY", clients: { codex: { enabled: true, config_home: codex, server_name: "rdHub" }, claude: { enabled: true, config_home: claude, server_name: "rdHub" } } } };
  await applyManagedConfig(context); await applyManagedConfig(context); await selfCheckManagedConfig(context);
  assert.match(await readFile(path.join(codex, "config.toml"), "utf8"), /model = "gpt-x"/);
  assert.equal((await readFile(path.join(codex, "AGENTS.md"), "utf8")).match(/BEGIN TEAM-SKILL-HUB/g)?.length, 1);
  const settings = JSON.parse(await readFile(path.join(claude, "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.ok(settings.permissions.allow.includes("Bash(git status)"));
  assert.equal(settings.permissions.allow.filter((x: string) => x === "mcp__rdHub__*").length, 1);
});

test("malformed Claude JSON aborts before mutating other client files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-updater-"));
  const codex = path.join(root, "codex"); const claude = path.join(root, "claude");
  await mkdir(codex); await mkdir(claude);
  await writeFile(path.join(codex, "AGENTS.md"), "unchanged\n");
  await writeFile(path.join(claude, "settings.json"), "{");
  const { applyManagedConfig } = await import(updaterUrl.href + `?t=${Date.now()}`);
  const context = { clientRoot: root, state: { hub_base_url: "http://hub", api_key_env: "TEAM_SKILL_HUB_API_KEY", clients: { codex: { enabled: true, config_home: codex, server_name: "teamSkillHub" }, claude: { enabled: true, config_home: claude, server_name: "teamSkillHub" } } } };
  await assert.rejects(() => applyManagedConfig(context), /settings.json/);
  assert.equal(await readFile(path.join(codex, "AGENTS.md"), "utf8"), "unchanged\n");
});

test("rollback switches to locally retained previous version without server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-rollback-"));
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  const r = await import(runtimeUrl.href + `?t=${Date.now()}`);
  const state = { schema_version: 1, installed_version: 2, previous_version: 1, hub_base_url: "http://127.0.0.1:1", api_key_env: "TEAM_SKILL_HUB_API_KEY", clients: {} };
  await r.writeStateAtomic(state); await r.writeCurrentVersion(2);
  await mkdir(path.join(root, "releases", "v1", "updater"), { recursive: true });
  await writeFile(path.join(root, "releases", "v1", "updater", "updater.mjs"), "export async function reconcileToVersion(){}\n");
  await r.rollbackToPrevious();
  assert.equal((await r.readState()).installed_version, 1);
  assert.equal(await r.readCurrentVersion(), 1);
});
