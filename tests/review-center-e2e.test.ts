import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import { startServer } from "../src/server.js";
import type { AppConfig } from "../src/types.js";

async function fixture(name: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), name));
  const search = new SqliteFtsSearchBackend();
  const config: AppConfig = { host: "127.0.0.1", port: 0, dataDir, defaultRoles: ["developer", "internal"], authentication: { mode: "development", apiKeys: {} }, repositories: [] };
  const service = new SkillHubApplicationService(config, [], new MemoryRegistryStore(), search, new SearchRoutingStrategy(search), new DevelopmentAuthenticationProvider(["developer", "internal"]), new StaticRolePermissionProvider(), [], new LoggingEventSink());
  await service.initialize();
  return { dataDir, search, config, service };
}

const candidateItem = { kind: "candidate", id: "kc_pending", title: "Knowledge", contentType: "knowledge", status: "pending", statusGroup: "pending", repository: "rd-knowledges", submitter: "alice", updatedAt: "2026-10-15T02:00:00.000Z" } as any;
const bundleItem = { kind: "skill-bundle", id: "sbi_pending", title: "superpowers", contentType: "skill-bundle-collection", status: "pending", statusGroup: "pending", repository: "rd-skills", namespace: "superpowers", importType: "collection", submitter: "bob", updatedAt: "2026-10-15T01:00:00.000Z" } as any;

test("unified review admin APIs require admin access and return mixed rows", async () => {
  const { dataDir, search, config, service } = await fixture("review-center-e2e-");
  process.env.ADMIN_API_KEY = "review-admin";
  (service as any).adminReviewItemsPage = async (query: any) => {
    const items = [candidateItem, bundleItem].filter((item) => !query.kind || item.kind === query.kind).filter((item) => !query.status || item.statusGroup === query.status);
    return { items, page: { total: items.length, limit: 20, cursor: "0" } };
  };
  (service as any).adminReviewSummary = async () => ({ counts: { pending: 2 }, total: 2 });
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base + "/admin/api/review-items")).status, 403);
    assert.equal((await fetch(base + "/admin/api/review-summary")).status, 403);
    const headers = { "x-skill-hub-admin-key": "review-admin" };
    const mixed = await fetch(base + "/admin/api/review-items?status=pending", { headers });
    assert.equal(mixed.status, 200);
    assert.deepEqual(((await mixed.json()) as any).items.map((item: any) => item.id), ["kc_pending", "sbi_pending"]);
    const candidates = await fetch(base + "/admin/api/review-items?kind=candidate", { headers });
    assert.deepEqual(((await candidates.json()) as any).items.map((item: any) => item.id), ["kc_pending"]);
    const bundles = await fetch(base + "/admin/api/review-items?kind=skill-bundle", { headers });
    assert.deepEqual(((await bundles.json()) as any).items.map((item: any) => item.id), ["sbi_pending"]);
    const summary = await fetch(base + "/admin/api/review-summary", { headers });
    assert.equal(summary.status, 200);
    assert.equal(((await summary.json()) as any).total, 2);
  } finally {
    await app.close(); search.close(); await rm(dataDir, { recursive: true, force: true }); delete process.env.ADMIN_API_KEY;
  }
});

test("unified review API rejects malformed filters and bounded scan errors", async () => {
  const { dataDir, search, config, service } = await fixture("review-center-errors-");
  process.env.ADMIN_API_KEY = "review-admin-errors";
  (service as any).adminReviewItemsPage = async () => { throw new Error("Admin review query exceeded bounded source scan"); };
  const app = await startServer(config, service);
  try {
    const address = app.server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "x-skill-hub-admin-key": "review-admin-errors" };
    for (const query of ["kind=bad", "type=bad", "status=bad", "importType=bad"]) {
      const response = await fetch(base + "/admin/api/review-items?" + query, { headers });
      assert.equal(response.status, 400);
    }
    const bounded = await fetch(base + "/admin/api/review-items", { headers });
    assert.equal(bounded.status, 400);
    assert.match(((await bounded.json()) as any).error, /bounded source scan/);
  } finally {
    await app.close(); search.close(); await rm(dataDir, { recursive: true, force: true }); delete process.env.ADMIN_API_KEY;
  }
});
