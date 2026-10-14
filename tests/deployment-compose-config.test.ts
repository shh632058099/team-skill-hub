import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../docker-compose.gitlab.yml", import.meta.url);

test("GitLab compose keeps ADMIN_API_KEY optional for session-based admin login", async () => {
  const compose = await readFile(composePath, "utf8");
  assert.match(compose, /ADMIN_API_KEY:\s*\$\{ADMIN_API_KEY:-\}/);
  assert.doesNotMatch(compose, /ADMIN_API_KEY:\s*\$\{ADMIN_API_KEY:\?/);
});
