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
      principal: { id: "biao", roles: ["developer", "internal"], tenantId: "rd" },
    });

    assert.match(created.apiKey, /^skh_/);
    const persisted = await readFile(path.join(dir, "config", "api-keys.json"), "utf8");
    assert.equal(persisted.includes(created.apiKey), false);
    assert.equal(persisted.includes(created.apiKey.slice(-4)), true);
    assert.equal(store.reveal(created.record.id), created.apiKey);

    const auth = new ApiKeyAuthenticationProvider({});
    auth.replaceManagedKeys(store.snapshot());
    const principal = auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey }));
    assert.deepEqual(principal, {
      id: "biao",
      roles: ["developer", "internal"],
      tenantId: "rd",
    });

    await store.update(created.record.id, { enabled: false });
    auth.replaceManagedKeys(store.snapshot());
    assert.throws(() => auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })), /Invalid API key/);
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
      principal: { id: "temporary-user", roles: ["developer"], tenantId: "rd" },
    });
    const auth = new ApiKeyAuthenticationProvider({});
    auth.replaceManagedKeys(store.snapshot());
    assert.equal(auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })).id, "temporary-user");

    assert.equal(await store.delete(created.record.id), true);
    auth.replaceManagedKeys(store.snapshot());
    assert.throws(() => auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })), /Invalid API key/);
    assert.equal(await store.delete(created.record.id), false);

    const reloaded = new ManagedApiKeyStore(dir);
    await reloaded.load();
    assert.equal(
      reloaded.list().some((item) => item.id === created.record.id),
      false,
    );
    const reloadedAuth = new ApiKeyAuthenticationProvider({});
    reloadedAuth.replaceManagedKeys(reloaded.snapshot());
    assert.throws(
      () => reloadedAuth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })),
      /Invalid API key/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotated managed API key invalidates the previous key without persisting plaintext", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-api-keys-rotate-"));
  try {
    const store = new ManagedApiKeyStore(dir);
    await store.load();
    const created = await store.create({
      label: "Rotating Codex",
      principal: { id: "rotating-user", roles: ["developer"], tenantId: "rd" },
    });
    const rotated = await store.rotate(created.record.id);

    assert.notEqual(rotated.apiKey, created.apiKey);
    assert.equal(rotated.record.id, created.record.id);
    assert.equal(rotated.record.keyLast4, rotated.apiKey.slice(-4));
    assert.equal(rotated.record.enabled, true);
    assert.equal(rotated.record.revealable, true);
    assert.equal(store.reveal(rotated.record.id), rotated.apiKey);

    const persisted = await readFile(path.join(dir, "config", "api-keys.json"), "utf8");
    assert.equal(persisted.includes(created.apiKey), false);
    assert.equal(persisted.includes(rotated.apiKey), false);

    const auth = new ApiKeyAuthenticationProvider({});
    auth.replaceManagedKeys(store.snapshot());
    assert.throws(() => auth.authenticate(new Headers({ "x-skill-hub-api-key": created.apiKey })), /Invalid API key/);
    assert.equal(auth.authenticate(new Headers({ "x-skill-hub-api-key": rotated.apiKey })).id, "rotating-user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revealed API key survives store reload while remaining encrypted at rest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-api-keys-reveal-"));
  try {
    const store = new ManagedApiKeyStore(dir);
    await store.load();
    const created = await store.create({
      label: "Revealable Codex",
      principal: { id: "reveal-user", roles: ["developer"], tenantId: "rd" },
    });

    const reloaded = new ManagedApiKeyStore(dir);
    await reloaded.load();
    assert.equal(reloaded.reveal(created.record.id), created.apiKey);
    const persisted = await readFile(path.join(dir, "config", "api-keys.json"), "utf8");
    assert.equal(persisted.includes(created.apiKey), false);
    assert.equal((await readFile(path.join(dir, "config", "api-key-encryption.key"))).length, 32);
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
      principal: { id: "customer-a", roles: ["customer"], tenantId: "customer-a" },
    });
    const auth = new ApiKeyAuthenticationProvider({
      bootstrap: { id: "bootstrap-user", roles: ["developer"], tenantId: "rd" },
    });
    auth.replaceManagedKeys(store.snapshot());

    assert.equal(auth.authenticate(new Headers({ "x-skill-hub-api-key": "bootstrap" })).id, "bootstrap-user");
    assert.equal(auth.authenticate(new Headers({ authorization: `Bearer ${created.apiKey}` })).id, "customer-a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("managed API key query filters, sorts and paginates with a default page size of 10", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-api-keys-query-"));
  try {
    const store = new ManagedApiKeyStore(dir);
    await store.load();
    for (let index = 0; index < 13; index += 1) {
      await store.create({
        label: index % 2 === 0 ? `codex-${String(index).padStart(2, "0")}` : `claude-${String(index).padStart(2, "0")}`,
        principal: {
          id: index % 3 === 0 ? "biao" : `user-${index}`,
          tenantId: index < 8 ? "default" : "customer",
          roles: index % 2 === 0 ? ["developer", "internal"] : ["customer"],
        },
      });
    }
    const disabled = store.list()[2]!;
    await store.update(disabled.id, { enabled: false });

    const first = store.query({});
    assert.equal(first.page.limit, 10);
    assert.equal(first.page.total, 13);
    assert.equal(first.items.length, 10);
    assert.equal(first.page.cursor, "0");
    assert.equal(first.page.nextCursor, "10");

    const filtered = store.query({ q: "biao", status: "enabled", tenant: "default", role: "developer" });
    assert.ok(filtered.items.length > 0);
    assert.ok(filtered.items.every((item) => item.principal.id === "biao"));
    assert.ok(filtered.items.every((item) => item.enabled));
    assert.ok(filtered.items.every((item) => item.principal.tenantId === "default"));
    assert.ok(filtered.items.every((item) => item.principal.roles.includes("developer")));

    const disabledOnly = store.query({ status: "disabled" });
    assert.equal(disabledOnly.page.total, 1);
    assert.equal(disabledOnly.items[0]?.id, disabled.id);
    const invalidStatus = store.query({ status: "bogus" as any });
    assert.equal(invalidStatus.page.total, 13);

    assert.equal(first.summary.total, 13);
    assert.equal(first.summary.enabled, 12);
    assert.equal(first.summary.disabled, 1);
    assert.ok(first.facets.tenants.includes("default"));
    assert.ok(first.facets.tenants.includes("customer"));
    assert.ok(first.facets.roles.includes("developer"));
    assert.ok(first.facets.userIds.includes("biao"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
