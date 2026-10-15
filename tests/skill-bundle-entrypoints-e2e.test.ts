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
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: []
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
    new LoggingEventSink()
  );
  await service.initialize();
  return { dataDir, search, config, service };
}

test("Admin Skill Bundle API exposes preview/import/list/detail/review actions", async () => {
  const { dataDir, search, config, service } = await fixture("skill-bundle-admin-e2e-");
  process.env.ADMIN_API_KEY = "skill-bundle-admin";
  const calls: string[] = [];
  const record = {
    id: "sbi_http",
    namespace: "ota",
    importType: "skill",
    skillPath: "design",
    replacementRoot: "skills/ota/design",
    collection: "rd-skills",
    repository: "rd-skills",
    sourceType: "web-files",
    snapshotId: "sbs_http",
    snapshotSha256: "snapshot-http",
    status: "pending",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z"
  } as any;
  (service as any).previewSkillBundle = async (_principal: any, input: any) => {
    calls.push(`preview:${input.namespace}:${input.skillPath ?? "-"}`);
    assert.equal(input.files[0].path, "SKILL.md");
    const replacementRoot = input.skillPath ? `skills/${input.namespace}/${input.skillPath}` : `skills/${input.namespace}`;
    return { replacementRoot, targetRevision: "rev-1", expectedTreeSha256: "tree", diff: { added: ["SKILL.md"], modified: [], deleted: [], unchanged: [], sha256: "diff" }, skills: [] };
  };
  (service as any).submitSkillBundle = async (_principal: any, input: any) => {
    calls.push("import:" + input.sourceType);
    assert.equal(input.importType, "skill");
    return record;
  };
  (service as any).skillBundleImportsPage = () => ({ items: [record], total: 1, limit: 20, cursor: "0" });
  (service as any).getSkillBundleImport = () => record;
  (service as any).getSkillBundleSnapshot = () => ({ id: "sbs_http", files: [{ path: "SKILL.md" }], skills: [{ rootPath: "", skillFilePath: "SKILL.md" }], fileCount: 1, totalBytes: 10 });
  (service as any).reviewSkillBundle = async (_p: any, _id: string, status: string) => ({ ...record, status });
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "x-skill-hub-admin-key": "skill-bundle-admin", "content-type": "application/json" };
    const body = JSON.stringify({ namespace: "ota", import_type: "skill", skill_path: "design", source_type: "files", files: [{ path: "SKILL.md", content: "skill" }] });
    const preview = await fetch(base + "/admin/api/skill-bundles/preview", { method: "POST", headers, body });
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /skills\/ota\/design/);
    const topLevelPreview = await fetch(base + "/admin/api/skill-bundles/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ target_path: "skill-creator", import_type: "skill", source_type: "files", files: [{ path: "SKILL.md", content: "skill" }] })
    });
    assert.equal(topLevelPreview.status, 200);
    assert.match(await topLevelPreview.text(), /skills\/skill-creator/);
    const nestedTargetPreview = await fetch(base + "/admin/api/skill-bundles/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ target_path: "ota/design", import_type: "skill", source_type: "files", files: [{ path: "SKILL.md", content: "skill" }] })
    });
    assert.equal(nestedTargetPreview.status, 200);
    assert.match(await nestedTargetPreview.text(), /skills\/ota\/design/);
    const invalidPreview = await fetch(base + "/admin/api/skill-bundles/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ namespace: "ota", import_type: "bogus", source_type: "files", files: [{ path: "SKILL.md", content: "skill" }] })
    });
    assert.equal(invalidPreview.status, 400);
    const largePreview = await fetch(base + "/admin/api/skill-bundles/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({
        namespace: "ota",
        import_type: "skill",
        skill_path: "design",
        source_type: "files",
        files: [
          { path: "SKILL.md", content: "skill" },
          { path: "references/a.txt", content: "a".repeat(450 * 1024) },
          { path: "references/b.txt", content: "b".repeat(450 * 1024) },
          { path: "references/c.txt", content: "c".repeat(300 * 1024) }
        ]
      })
    });
    assert.equal(largePreview.status, 200);
    const imported = await fetch(base + "/admin/api/skill-bundles/import", { method: "POST", headers, body });
    assert.equal(imported.status, 201);
    assert.match(await imported.text(), /sbi_http/);
    const list = await fetch(base + "/admin/api/skill-bundles", { headers });
    const listBody = await list.json() as any;
    assert.equal(listBody.imports[0].skillCount, 1);
    assert.equal(listBody.imports[0].fileCount, 1);
    const detail = await fetch(base + "/admin/api/skill-bundles/sbi_http", { headers });
    assert.equal(((await detail.json()) as any).import.skills.length, 1);
    const approve = await fetch(base + "/admin/api/skill-bundles/sbi_http/approve", { method: "POST", headers, body: JSON.stringify({ reason: "ok" }) });
    assert.equal(((await approve.json()) as any).import.status, "approved");
    assert.deepEqual(calls, ["preview:ota:design", "preview:skill-creator:-", "preview:ota:design", "preview:ota:design", "import:web-files"]);
  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_API_KEY;
  }
});

test("MCP submit_skill_bundle maps Codex payload to Bundle application workflow", async () => {
  const { dataDir, search, config, service } = await fixture("skill-bundle-mcp-e2e-");
  let captured: any;
  (service as any).submitSkillBundle = async (principal: any, input: any) => {
    captured = { principal, input };
    return { id: "sbi_mcp", status: "pending", namespace: input.namespace, replacementRoot: "skills/ota/design" };
  };
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-skill-hub-client": "codex" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "submit_skill_bundle",
          arguments: {
            namespace: "ota",
            import_type: "skill",
            skill_path: "design",
            skill_collection: "rd-skills",
            files: [{ path: "SKILL.md", content: "skill", content_base64: "" }],
            submission_key: "codex-retry-1"
          }
        }
      })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /sbi_mcp/);
    assert.equal(captured.input.importType, "skill");
    assert.equal(captured.input.skillPath, "design");
    assert.equal(captured.input.submissionKey, "codex-retry-1");
    assert.equal(captured.input.sourceType, "mcp");
    assert.equal(captured.input.files[0].content, "skill");
    assert.equal("contentBase64" in captured.input.files[0], false);
    assert.equal(captured.principal.id, "development-user");
  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("MCP exposes Bundle as the only Skill submission entrypoint", async () => {
  const { dataDir, search, config, service } = await fixture("skill-bundle-tools-e2e-");
  const app = await startServer(config, service);
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-skill-hub-client": "claude-code" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /submit_skill_bundle/);
    assert.doesNotMatch(text, /submit_skill_candidate/);
    assert.doesNotMatch(text, /suggested_type/);
    assert.match(text, /only MCP entrypoint for submitting Skills/i);
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine);
    const payload = JSON.parse(dataLine.slice("data: ".length)) as any;
    const bundleTool = payload.result.tools.find((tool: any) => tool.name === "submit_skill_bundle");
    assert.ok(bundleTool);
    assert.equal(bundleTool.inputSchema.type, "object");
    assert.equal(bundleTool.inputSchema.oneOf, undefined);
  } finally {
    await app.close();
    search.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
