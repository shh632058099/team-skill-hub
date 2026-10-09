import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedApiKeyStore } from "../src/api-keys.js";
import { ApiKeyAuthenticationProvider } from "../src/security.js";

test("managed API key authenticates without persisting plaintext", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-api-keys-"));
  try {
    const store = new ManagedApiKeyStore(dir);
    await store.load();
    const created = await store.create({
      label: "Codex",
      principal: { id: "biao", roles: ["developer", "internal"], tenantId: "rd" }
    });

    assert.match(created.apiKey, /^skh_/);
    const persisted = await readFile(path.join(dir, "config", "api-keys.json"), "utf8");
    assert.equal(persisted.includes(created.apiKey), false);
    assert.equal(persisted.includes(created.apiKey.slice(-4)), true);

    const auth = new ApiKeyAuthenticationProvider({});
    auth.replaceManagedKeys(store.snapshot());
    const principal = auth.authenticate(
      new Headers({ "x-skill-hub-api-key": created.apiKey })
    );
    assert.deepEqual(principal, {
      id: "biao",
      roles: ["developer", "internal"],
      tenantId: "rd"
    });

    await store.update(created.record.id, { enabled: false });
    auth.replaceManagedKeys(store.snapshot());
    assert.throws(
      () => auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })),
      /Invalid API key/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleted managed API key is removed from persistence and authentication immediately", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-api-keys-delete-"));
  try {
    const store = new ManagedApiKeyStore(dir);
    await store.load();
    const created = await store.create({
      label: "Temporary Codex",
      principal: { id: "temporary-user", roles: ["developer"], tenantId: "rd" }
    });
    const auth = new ApiKeyAuthenticationProvider({});
    auth.replaceManagedKeys(store.snapshot());
    assert.equal(
      auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })).id,
      "temporary-user"
    );

    assert.equal(await store.delete(created.record.id), true);
    auth.replaceManagedKeys(store.snapshot());
    assert.throws(
      () => auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })),
      /Invalid API key/
    );
    assert.equal(await store.delete(created.record.id), false);

    const reloaded = new ManagedApiKeyStore(dir);
    await reloaded.load();
    assert.equal(reloaded.list().some((item) => item.id === created.record.id), false);
    const reloadedAuth = new ApiKeyAuthenticationProvider({});
    reloadedAuth.replaceManagedKeys(reloaded.snapshot());
    assert.throws(
      () => reloadedAuth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })),
      /Invalid API key/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootstrap API keys remain compatible with managed keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-api-keys-"));
  try {
    const store = new ManagedApiKeyStore(dir);
    await store.load();
    const created = await store.create({
      label: "Customer",
      principal: { id: "customer-a", roles: ["customer"], tenantId: "customer-a" }
    });
    const auth = new ApiKeyAuthenticationProvider({
      bootstrap: { id: "bootstrap-user", roles: ["developer"], tenantId: "rd" }
    });
    auth.replaceManagedKeys(store.snapshot());

    assert.equal(
      auth.authenticate(new Headers({ "x-skill-hub-api-key": "bootstrap" })).id,
      "bootstrap-user"
    );
    assert.equal(
      auth.authenticate(new Headers({ authorization: `Bearer ${created.apiKey}` })).id,
      "customer-a"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
