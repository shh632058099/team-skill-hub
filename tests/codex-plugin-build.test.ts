import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Codex plugin builder emits portable plugin, MCP auth, hooks and marketplace without secrets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-plugin-"));
  const out = path.join(temp, "plugin");
  const marketplace = path.join(temp, "marketplace");
  try {
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli/build-codex-plugin.ts",
        "--url",
        "https://hub.example.test/mcp",
        "--api-key-env",
        "TEST_TEAM_HUB_TOKEN",
        "--out",
        out,
        "--marketplace-root",
        marketplace,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TEST_TEAM_HUB_TOKEN: "must-never-be-written" },
      },
    );

    const plugin = JSON.parse(await readFile(path.join(out, "plugin.json"), "utf8"));
    assert.equal(plugin.name, "team-skill-hub");
    assert.equal(plugin.version, "0.1.0");
    assert.equal(plugin.extensions["com.openai"].hooks, "./hooks/hooks.json");

    const mcp = JSON.parse(await readFile(path.join(out, "mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers.teamSkillHub, {
      type: "streamable-http",
      url: "https://hub.example.test/mcp",
      bearer_token_env_var: "TEST_TEAM_HUB_TOKEN",
    });

    const hooks = JSON.parse(await readFile(path.join(out, "hooks", "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].async, false);
    assert.equal(hooks.hooks.PostToolUse[0].hooks[0].async, false);
    assert.equal(hooks.hooks.Stop[0].hooks[0].async, false);
    assert.equal(hooks.hooks.SessionEnd[0].hooks[0].async, false);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].async, true);
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /PLUGIN_ROOT/);
    assert.match(hooks.hooks.SessionStart[0].hooks[0].commandWindows, /PLUGIN_ROOT/);
    assert.equal(hooks.hooks.PreToolUse[0].matcher, "^__team_skill_hub_reserved__$");
    assert.equal(hooks.hooks.PreToolUse[1].matcher, "^mcp__[A-Za-z0-9_-]+__submit_expert_task(_auto)?$");
    assert.equal(hooks.hooks.PreToolUse[1].hooks[0].async, false);
    assert.match(hooks.hooks.PreToolUse[1].hooks[0].command, /codex\/expert-session-hook\.py/);
    await stat(path.join(out, "hooks", "codex", "expert-session-hook.py"));
    await stat(path.join(out, "hooks", "codex", "expert-session-hook.ps1"));

    const conf = await readFile(path.join(out, "hooks", "team-skill-hub.conf"), "utf8");
    assert.match(conf, /event_url=https:\/\/hub\.example\.test\/client-events/);
    assert.match(conf, /api_key_env=TEST_TEAM_HUB_TOKEN/);
    assert.match(conf, /runtime_version=1\.3\.0/);
    assert.match(conf, /hook_schema_version=1/);

    const catalog = JSON.parse(
      await readFile(path.join(marketplace, ".agents", "plugins", "marketplace.json"), "utf8"),
    );
    assert.equal(catalog.plugins[0].source.path, "./plugins/team-skill-hub");

    const serialized = [
      await readFile(path.join(out, "plugin.json"), "utf8"),
      await readFile(path.join(out, "mcp.json"), "utf8"),
      await readFile(path.join(out, "hooks", "hooks.json"), "utf8"),
      conf,
    ].join("\n");
    assert.doesNotMatch(serialized, /must-never-be-written/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
