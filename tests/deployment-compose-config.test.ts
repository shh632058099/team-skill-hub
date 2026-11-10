import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../docker-compose.gitlab.yml", import.meta.url);
const localComposePath = new URL("../docker-compose.yml", import.meta.url);

test("GitLab compose keeps ADMIN_API_KEY optional for session-based admin login", async () => {
  const compose = await readFile(composePath, "utf8");
  assert.match(compose, /ADMIN_API_KEY:\s*\$\{ADMIN_API_KEY:-\}/);
  assert.doesNotMatch(compose, /ADMIN_API_KEY:\s*\$\{ADMIN_API_KEY:\?/);
});

test("local compose always appends its internal service hostname for Worker MCP", async () => {
  const compose = await readFile(localComposePath, "utf8");
  assert.match(compose, /SKILL_HUB_ALLOWED_HOSTS:\s*"\$\{SKILL_HUB_ALLOWED_HOSTS:-\},team-skill-hub"/);
});
