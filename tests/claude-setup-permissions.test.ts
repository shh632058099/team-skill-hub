import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function makeFakeClaude(binDir: string): Promise<void> {
  const script = path.join(binDir, "claude");
  await writeFile(script, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

async function runSetup(configDir: string, binDir: string, extraArgs: string[] = []): Promise<void> {
  await execFileAsync("bash", ["scripts/setup-claude-code.sh", "--url", "http://127.0.0.1:8080/mcp", ...extraArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      TEAM_SKILL_HUB_CLIENT_ROOT: path.join(path.dirname(configDir), ".team-skill-hub"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

test("Claude setup allows every tool from the configured Team Skill Hub without overwriting existing permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-claude-setup-"));
  const configDir = path.join(root, "claude");
  const binDir = path.join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await makeFakeClaude(binDir);
  await writeFile(
    path.join(configDir, "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(git status)"],
        ask: ["Bash(git push *)"],
        deny: ["Read(./secrets/**)"],
      },
    }),
    "utf8",
  );

  try {
    await runSetup(configDir, binDir, ["--server-name", "rdHub"]);
    await runSetup(configDir, binDir, ["--server-name", "rdHub"]);
    const settings = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions.ask, ["Bash(git push *)"]);
    assert.deepEqual(settings.permissions.deny, ["Read(./secrets/**)"]);
    assert.ok(settings.permissions.allow.includes("Bash(git status)"));
    assert.equal(settings.permissions.allow.filter((rule: string) => rule === "mcp__rdHub__*").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude setup --skip-mcp does not grant Team Skill Hub MCP permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-skill-hub-claude-skip-"));
  const configDir = path.join(root, "claude");
  const binDir = path.join(root, "bin");
  await mkdir(configDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await makeFakeClaude(binDir);

  try {
    await runSetup(configDir, binDir, ["--skip-mcp"]);
    const settings = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"));
    assert.ok(!settings.permissions?.allow?.some((rule: string) => rule.startsWith("mcp__teamSkillHub")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PowerShell Claude setup includes the same server-scoped MCP allow rule", async () => {
  const source = await readFile("scripts/setup-claude-code.ps1", "utf8");
  assert.match(source, /mcp__.*ServerName.*__\*/);
  assert.match(source, /permissions/i);
  assert.match(source, /allow/i);
});

test("PowerShell Claude setup preserves single-item arrays and migrates additionalDirectories", async () => {
  const source = await readFile("scripts/setup-claude-code.ps1", "utf8");
  assert.match(source, /return ,@\(\$Value \| ForEach-Object/);
  assert.match(source, /additionalDirectories.*-is \[string\]/s);
  assert.match(source, /additionalDirectories'\] = @\(\$root\['permissions'\]\['additionalDirectories'\]\)/);
});

test("Claude setup registers HTTP MCP with the supported add command", async () => {
  const shellSource = await readFile("scripts/setup-claude-code.sh", "utf8");
  const powerShellSource = await readFile("scripts/setup-claude-code.ps1", "utf8");
  assert.match(shellSource, /claude mcp add --transport http/);
  assert.doesNotMatch(shellSource, /claude mcp add-json/);
  assert.match(powerShellSource, /claude mcp add --transport http/);
  assert.doesNotMatch(powerShellSource, /claude mcp add-json/);
});
