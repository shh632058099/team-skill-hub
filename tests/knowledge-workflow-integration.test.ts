import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SkillHubApplicationService } from "../src/application.js";
import { LoggingEventSink } from "../src/events.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { GitRepositoryProvider } from "../src/repository.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import {
  DevelopmentAuthenticationProvider,
  StaticRolePermissionProvider
} from "../src/security.js";
import {
  RequiredFieldsRule,
  RepositoryVisibilityRule,
  UniqueNameRule
} from "../src/skills.js";
import type { Principal, RepositoryConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
}

test("automatic candidate can publish through MR, merge, sync and become searchable Knowledge", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skill-hub-knowledge-workflow-"));
  const upstream = path.join(tempRoot, "rd-skills");
  const dataDir = path.join(tempRoot, "data");
  await mkdir(upstream, { recursive: true });
  await writeFile(path.join(upstream, "README.md"), "# R&D Skills\n\nInitial repository.\n", "utf8");
  await git(upstream, "init", "-b", "master");
  await git(upstream, "config", "user.name", "Skill Hub Test");
  await git(upstream, "config", "user.email", "skill-hub-test@example.invalid");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "initial");

  const repository: RepositoryConfig = {
    id: "rd-skills",
    name: "R&D Skills",
    owners: ["platform-team"],
    provider: "git",
    gitUrl: upstream,
    branch: "master",
    gitAuth: { type: "none" },
    webhookAliases: [],
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 0,
    readRoles: ["developer", "internal"],
    syncRoles: ["developer", "admin"],
    knowledgePublishing: {
      enabled: true,
      provider: "gitlab",
      baseUrl: "https://gitlab.example.test",
      projectPath: "ai/rd-skills",
      tokenEnv: "TEST_GITLAB_WRITE_TOKEN",
      targetBranch: "master",
      branchPrefix: "skill-hub-knowledge"
    }
  };
  const principal: Principal = {
    id: "developer-integration",
    tenantId: "rd",
    roles: ["developer", "internal"]
  };
  const search = new SqliteFtsSearchBackend();
  const service = new SkillHubApplicationService(
    {
      host: "127.0.0.1",
      port: 0,
      dataDir,
      defaultRoles: ["developer", "internal"],
      authentication: { mode: "development", apiKeys: {} },
      repositories: [repository]
    },
    [new GitRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new RepositoryVisibilityRule()],
    new LoggingEventSink()
  );

  const originalFetch = globalThis.fetch;
  const assistantResult =
    "OTA断电恢复问题已经完成修复并通过回归测试。设备在升级断电后会从最后一个安全检查点恢复，" +
    "恢复前重新校验镜像版本与完整性，避免损坏镜像继续启动。新增回归测试覆盖断电恢复、镜像校验失败和正常升级路径，" +
    "当前十二项相关测试全部通过。这个结论适合作为后续 OTA 项目的故障排查和恢复设计参考。";
  let publishedMarkdown = "";
  try {
    await service.initialize();

    await service.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "SessionStart",
      sessionId: "workflow-session",
      cwd: upstream,
      metadata: {}
    });
    await service.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "PostToolUse",
      sessionId: "workflow-session",
      turnId: "workflow-turn",
      cwd: upstream,
      metadata: {
        tool_name: "Bash",
        tool_use_id: "workflow-test-tool",
        evidence: {
          success: true,
          exit_code: 0,
          tests_run: 12,
          tests_passed: 12,
          tests_failed: 0
        }
      }
    });
    await service.recordClientEvent(principal, {
      schemaVersion: 1,
      client: "codex",
      event: "Stop",
      sessionId: "workflow-session",
      turnId: "workflow-turn",
      cwd: upstream,
      metadata: {
        stop_hook_active: false,
        assistant_result_excerpt: assistantResult
      }
    });

    const generated = (await service.listKnowledgeCandidates(100)).find(
      (item) =>
        item.sourceType === "codex-summary" &&
        item.sourceSessionId === "workflow-session"
    );
    assert.ok(generated, "automatic Candidate should be generated");
    assert.equal(generated.repository, "rd-skills");
    assert.equal(generated.status, "pending");

    const edited = await service.updateKnowledgeCandidate(generated.id, {
      repository: "rd-skills",
      suggestedPath: "docs/ota/recovery-note.md"
    });
    assert.equal(edited.suggestedPath, "docs/ota/recovery-note.md");
    const approved = await service.reviewKnowledgeCandidate(
      generated.id,
      "approved",
      "integration-reviewer",
      "Verified with regression evidence",
      "useful"
    );
    assert.equal(approved.status, "approved");

    process.env.TEST_GITLAB_WRITE_TOKEN = "write-token";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (/\/repository\/branches\/skill-hub-knowledge-/.test(url) && method === "GET") {
        return new Response("", { status: 404 });
      }
      if (/\/repository\/files\//.test(url) && method === "HEAD") {
        return new Response("", { status: 404 });
      }
      if (/\/repository\/files\//.test(url) && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string };
        publishedMarkdown = body.content ?? "";
        return new Response(JSON.stringify({ file_path: "docs/ota/recovery-note.md" }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      if (/\/merge_requests$/.test(url) && method === "POST") {
        return new Response(
          JSON.stringify({
            iid: 12,
            web_url: "https://gitlab.example.test/ai/rd-skills/-/merge_requests/12",
            state: "opened"
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }
      if (/\/merge_requests\/12$/.test(url) && method === "GET") {
        return new Response(
          JSON.stringify({
            state: "merged",
            merged_at: "2026-09-30T12:00:00.000Z",
            merge_commit_sha: "merge123",
            has_conflicts: false,
            detailed_merge_status: "merged",
            head_pipeline: { status: "success" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error("unexpected mocked GitLab request: " + method + " " + url);
    };

    const published = await service.publishKnowledgeCandidate(generated.id);
    assert.equal(published.status, "published");
    assert.equal(published.publication?.mergeRequestState, "opened");
    assert.equal(published.publication?.mergeRequestIid, 12);
    assert.match(publishedMarkdown, /^# OTA断电恢复问题已经完成修复/m);

    await mkdir(path.join(upstream, "docs", "ota"), { recursive: true });
    await writeFile(
      path.join(upstream, "docs", "ota", "recovery-note.md"),
      publishedMarkdown,
      "utf8"
    );
    await git(upstream, "add", "docs/ota/recovery-note.md");
    await git(upstream, "commit", "-m", "merge knowledge candidate");

    const reconciled = await service.reconcileKnowledgeCandidatePublication(generated.id);
    assert.equal(reconciled.publication?.mergeRequestState, "merged");
    assert.equal(reconciled.publication?.pipelineStatus, "success");
    assert.equal(reconciled.publication?.hasConflicts, false);

    const synced = await service.syncRepository("rd-skills");
    assert.equal(synced.status, "healthy");
    const results = service.searchKnowledge("OTA 断电 恢复 安全 检查点", 5, ["rd-skills"], principal);
    assert.ok(
      results.some((item) => item.chunk.relativePath === "docs/ota/recovery-note.md"),
      "merged Knowledge should be searchable after Repository Sync"
    );
    const loaded = service.getKnowledge(
      "rd-skills",
      "docs/ota/recovery-note.md",
      undefined,
      principal
    );
    assert.match(loaded.document.content, /最后一个安全检查点/);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TEST_GITLAB_WRITE_TOKEN;
    search.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
