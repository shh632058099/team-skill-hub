import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import { startServer } from "../src/server.js";

async function makeService(dataDir: string) {
  const search = new SqliteFtsSearchBackend();
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development" as const, apiKeys: {} },
    repositories: [],
  };
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
  return { config, service };
}

test("serves unauthenticated manifest and immutable platform package safely", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-server-"));
  const releases = path.join(dataDir, "client-integration");
  await mkdir(path.join(releases, "releases", "5"), { recursive: true });
  await writeFile(
    path.join(releases, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      version: 5,
      minimum_supported_version: 4,
      packages: { linux: { path: "releases/5/linux.tar.gz", sha256: "x" } },
    }),
  );
  await writeFile(path.join(releases, "releases", "5", "linux.tar.gz"), "package-body");
  process.env.CLIENT_INTEGRATION_DIR = releases;
  const { config, service } = await makeService(dataDir);
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const manifest = await fetch(base + "/client-integration/manifest.json");
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("cache-control") ?? "", /no-cache/);
    assert.equal(((await manifest.json()) as any).version, 5);
    const pkg = await fetch(base + "/client-integration/releases/5/linux.tar.gz");
    assert.equal(pkg.status, 200);
    assert.match(pkg.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await pkg.text(), "package-body");
    assert.equal((await fetch(base + "/client-integration/releases/5/unknown.txt")).status, 404);
    assert.notEqual((await fetch(base + "/client-integration/releases/5/..%2Fmanifest.json")).status, 200);
  } finally {
    await app.close();
    delete process.env.CLIENT_INTEGRATION_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
