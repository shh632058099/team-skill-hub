import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryRegistryStore } from "../src/registry.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { LocalRepositoryProvider } from "../src/repository.js";
import {
  ApiKeyAuthenticationProvider,
  StaticRolePermissionProvider
} from "../src/security.js";
import { LoggingEventSink } from "../src/events.js";
import { SkillHubApplicationService } from "../src/application.js";
import {
  RequiredFieldsRule,
  RepositoryVisibilityRule,
  UniqueNameRule
} from "../src/skills.js";
import { startServer } from "../src/server.js";
import type { RepositoryConfig } from "../src/types.js";

test("MCP search_knowledge then get_knowledge returns repository-grounded context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-hub-mcp-rag-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "skill-hub-mcp-rag-data-"));
  const search = new SqliteFtsSearchBackend();

  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "ota-recovery.md"),
      "# OTA 断电恢复\n\n升级过程中突然断电后，系统读取安全检查点并恢复升级状态机。\n\n回滚前会校验镜像完整性。\n",
      "utf8"
    );

    const repository: RepositoryConfig = {
      id: "rd-skills",
      name: "R&D Skills",
      provider: "local",
      path: root,
      gitAuth: { type: "none" },
      webhookAliases: [],
      enabled: true,
      audience: ["developer"],
      visibility: ["internal"],
      pollingIntervalSeconds: 0,
      readRoles: ["developer", "internal"],
      syncRoles: ["developer", "admin"]
    };

    const auth = new ApiKeyAuthenticationProvider({
      "rag-e2e-key": {
        id: "rag-e2e",
        roles: ["developer", "internal"],
        tenantId: "rd"
      }
    });

    const service = new SkillHubApplicationService(
      {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        defaultRoles: [],
        authentication: { mode: "api-key", apiKeys: {} },
        repositories: [repository]
      },
      [new LocalRepositoryProvider()],
      new MemoryRegistryStore(),
      search,
      new SearchRoutingStrategy(search),
      auth,
      new StaticRolePermissionProvider(),
      [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
      new LoggingEventSink()
    );

    await service.initialize();
    const app = await startServer(
      {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        defaultRoles: [],
        authentication: { mode: "api-key", apiKeys: {} },
        repositories: [repository]
      },
      service
    );

    try {
      const address = app.server.address();
      assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}/mcp`;
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-skill-hub-api-key": "rag-e2e-key"
      };

      const searchResponse = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_knowledge",
            arguments: { query: "断电恢复怎么处理", top_k: 3 }
          }
        })
      });
      assert.equal(searchResponse.status, 200);
      const searchText = await searchResponse.text();
      assert.match(searchText, /ota-recovery\.md/);
      assert.match(searchText, /安全检查点/);

      const getResponse = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_knowledge",
            arguments: {
              repository: "rd-skills",
              path: "docs/ota-recovery.md",
              chunk_index: 0
            }
          }
        })
      });
      assert.equal(getResponse.status, 200);
      const getText = await getResponse.text();
      assert.match(getText, /OTA 断电恢复/);
      assert.match(getText, /回滚前会校验镜像完整性/);

      const calls = await service.listMcpCalls(10);
      assert.ok(calls.some((item) => item.tool === "search_knowledge" && item.success));
      assert.ok(calls.some((item) => item.tool === "get_knowledge" && item.success));
      assert.ok(calls.every((item) => item.actorId === "rag-e2e"));
    } finally {
      await app.close();
    }
  } finally {
    search.close();
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
