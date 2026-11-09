import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedApiKeyStore } from "../src/api-keys.js";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import {
  ApiKeyAuthenticationProvider,
  DevelopmentAuthenticationProvider,
  StaticRolePermissionProvider,
} from "../src/security.js";
import { startServer } from "../src/server.js";

test("admin API key list defaults to 10 and supports server-side filters", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-admin-api-keys-"));
  const search = new SqliteFtsSearchBackend();
  process.env.ADMIN_API_KEY = "admin-test-key";
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development" as const, apiKeys: {} },
    repositories: [],
  };
  const store = new ManagedApiKeyStore(dataDir);
  await store.load();
  for (let index = 0; index < 13; index += 1) {
    await store.create({
      label: index % 2 === 0 ? `codex-${index}` : `claude-${index}`,
      principal: {
        id: index % 3 === 0 ? "biao" : `user-${index}`,
        tenantId: index < 8 ? "default" : "customer",
        roles: index % 2 === 0 ? ["developer", "internal"] : ["customer"],
      },
    });
  }
  const disabled = store.list()[2]!;
  await store.update(disabled.id, { enabled: false });
  const apiKeyAuth = new ApiKeyAuthenticationProvider({});
  apiKeyAuth.replaceManagedKeys(store.snapshot());

  const service = new SkillHubApplicationService(
    config,
    [],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [],
    new LoggingEventSink(),
  );
  await service.initialize();
  const app = await startServer(config, service, undefined, store, apiKeyAuth);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    const headers = { "x-skill-hub-admin-key": "admin-test-key" };

    const managementPage = await fetch(base + "/admin/access/api-keys", { headers });
    assert.equal(managementPage.status, 200);
    assert.match(await managementPage.text(), /访问控制 \/ API Keys/);

    const first = await fetch(base + "/admin/api/api-keys", { headers });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as any;
    assert.equal(firstBody.keys.length, 10);
    assert.deepEqual(firstBody.page, {
      total: 13,
      limit: 10,
      cursor: "0",
      nextCursor: "10",
    });
    assert.deepEqual(firstBody.summary, { total: 13, enabled: 12, disabled: 1 });
    assert.ok(firstBody.facets.userIds.includes("biao"));

    const filtered = await fetch(
      base + "/admin/api/api-keys?q=biao&status=enabled&tenant=default&role=developer&limit=10",
      { headers },
    );
    assert.equal(filtered.status, 200);
    const filteredBody = (await filtered.json()) as any;
    assert.ok(filteredBody.keys.length > 0);
    assert.ok(filteredBody.keys.every((item: any) => item.principal.id === "biao"));
    assert.ok(filteredBody.keys.every((item: any) => item.enabled));
    assert.ok(filteredBody.keys.every((item: any) => item.principal.tenantId === "default"));
    assert.ok(filteredBody.keys.every((item: any) => item.principal.roles.includes("developer")));

    const disabledResponse = await fetch(base + "/admin/api/api-keys?status=disabled", { headers });
    const disabledBody = (await disabledResponse.json()) as any;
    assert.equal(disabledBody.page.total, 1);
    assert.equal(disabledBody.keys[0]?.id, disabled.id);
  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});
