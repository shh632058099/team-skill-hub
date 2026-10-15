import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeUrl = new URL("../client-integration/runtime/client-runtime.mjs", import.meta.url);
const codexUrl = new URL("../client-integration/runtime/render-codex.mjs", import.meta.url);
const claudeUrl = new URL("../client-integration/runtime/render-claude.mjs", import.meta.url);

async function runtime(root: string) {
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  return import(runtimeUrl.href + `?t=${Date.now()}-${Math.random()}`);
}

test("decides none optional and required updates", async () => {
  const r = await runtime(await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-")));
  const manifest = { version: 5, minimum_supported_version: 4 };
  assert.equal(r.decideUpdate(5, manifest), "none");
  assert.equal(r.decideUpdate(4, manifest), "optional_update");
  assert.equal(r.decideUpdate(3, manifest), "required_update");
});

test("fresh cache avoids network fetch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-"));
  const r = await runtime(root);
  await r.writeManifestCache({ version: 2, minimum_supported_version: 1 });
  const result = await r.checkUpdateDecision({ installedVersion: 1, manifestUrl: "http://127.0.0.1:1/manifest.json" });
  assert.equal(result.decision, "optional_update");
  assert.equal(result.source, "cache");
});

test("expired cache fetches once and resolves decision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-"));
  const r = await runtime(root);
  await r.writeManifestCache({ version: 1, minimum_supported_version: 1 }, Date.now() - 13 * 60 * 60 * 1000);
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ version: 3, minimum_supported_version: 2 })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const result = await r.checkUpdateDecision({ installedVersion: 1, manifestUrl: `http://127.0.0.1:${address.port}/manifest.json` });
    assert.equal(result.decision, "required_update");
    assert.equal(requests, 1);
  } finally { server.close(); }
});

test("network timeout fails open within budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-session-"));
  const r = await runtime(root);
  const server = createServer((_req, _res) => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const started = Date.now();
  try {
    const result = await r.checkUpdateDecision({ installedVersion: 1, manifestUrl: `http://127.0.0.1:${address.port}/manifest.json`, budgetMs: 100 });
    assert.equal(result.decision, "none");
    assert.ok(Date.now() - started < 500);
  } finally { server.closeAllConnections(); server.close(); }
});

test("Codex and Claude use client-specific renderer contracts", async () => {
  const { renderCodexDecision, renderTerminalNotice: renderCodexTerminalNotice } = await import(codexUrl.href);
  const { renderClaudeDecision, renderTerminalNotice: renderClaudeTerminalNotice } = await import(claudeUrl.href);
  const optionalDetail = { installed: 4, latest: 5, minimum: 4 };
  assert.match(renderCodexDecision("optional_update", optionalDetail), /v4 -> v5/);
  assert.match(renderCodexTerminalNotice("optional_update", optionalDetail), /v4 -> v5/);
  assert.match(renderClaudeTerminalNotice("optional_update", optionalDetail), /v4 -> v5/);
  const claude = JSON.parse(renderClaudeDecision("required_update", { installed: 3, latest: 5, minimum: 4 }));
  assert.equal(claude.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(claude.hookSpecificOutput.additionalContext, /Minimum required version: v4/);
  assert.equal(renderCodexDecision("none", { installed: 5, latest: 5, minimum: 4 }), "");
  assert.equal(renderCodexTerminalNotice("none", { installed: 5, latest: 5, minimum: 4 }), "");
  assert.equal(renderClaudeTerminalNotice("none", { installed: 5, latest: 5, minimum: 4 }), "");
});
