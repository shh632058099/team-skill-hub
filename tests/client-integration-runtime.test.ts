import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const runtimeUrl = new URL("../client-integration/runtime/client-runtime.mjs", import.meta.url);

async function runtime(root: string) {
  process.env.TEAM_SKILL_HUB_CLIENT_ROOT = root;
  return await import(runtimeUrl.href + `?t=${Date.now()}-${Math.random()}`);
}

test("state round trip is atomic and stores no token values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  const r = await runtime(root);
  const state = { schema_version: 1, installed_version: 1, hub_base_url: "http://127.0.0.1:8080", api_key_env: "TEAM_SKILL_HUB_API_KEY", clients: {} };
  await r.writeStateAtomic(state);
  assert.deepEqual(await r.readState(), state);
  assert.doesNotMatch(await readFile(path.join(root, "state.json"), "utf8"), /super-secret/);
});

test("malformed state fails closed for mutation readers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "state.json"), "{");
  const r = await runtime(root);
  await assert.rejects(() => r.readState(), /state.json/);
});

test("relative package URL preserves reverse proxy prefix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  const r = await runtime(root);
  assert.equal(r.resolvePackageUrl("releases/5/linux.tar.gz", "https://host/skill-hub/client-integration/manifest.json"), "https://host/skill-hub/client-integration/releases/5/linux.tar.gz");
});

test("manifest cache honors 1 hour TTL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  const r = await runtime(root);
  await r.writeManifestCache({ version: 2 }, Date.now() - 1000);
  assert.equal((await r.readManifestCache())?.fresh, true);
  await r.writeManifestCache({ version: 2 }, Date.now() - 61 * 60 * 1000);
  assert.equal((await r.readManifestCache())?.fresh, false);
});

test("update-check lock is non-blocking and mutation lock is exclusive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  const r = await runtime(root);
  const a = await r.acquireUpdateCheckLock();
  assert.ok(a);
  assert.equal(await r.acquireUpdateCheckLock(), null);
  await a.release();
  const m = await r.acquireMutationLock("upgrade");
  assert.ok(m);
  assert.equal(await r.acquireMutationLock("rollback"), null);
  await m.release();
});

test("stale lock is reclaimed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  await mkdir(path.join(root, "locks"), { recursive: true });
  await writeFile(path.join(root, "locks", "mutation.lock"), JSON.stringify({ pid: 99999999, created_at: new Date(0).toISOString(), command: "upgrade" }));
  const r = await runtime(root);
  const lock = await r.acquireMutationLock("upgrade");
  assert.ok(lock);
  await lock.release();
});

test("incomplete applying transaction restores previous state and current", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-runtime-"));
  const r = await runtime(root);
  await r.writeStateAtomic({ schema_version: 1, installed_version: 2, clients: {} });
  await r.writeCurrentVersion(2);
  const tx = path.join(root, "transactions", "active.json");
  await mkdir(path.dirname(tx), { recursive: true });
  await writeFile(tx, JSON.stringify({ state: "applying", previous_state: { schema_version: 1, installed_version: 1, clients: {} }, previous_current_version: 1, backups: [] }));
  assert.equal(await r.recoverIncompleteTransaction(), true);
  assert.equal((await r.readState()).installed_version, 1);
  assert.equal(await r.readCurrentVersion(), 1);
});
