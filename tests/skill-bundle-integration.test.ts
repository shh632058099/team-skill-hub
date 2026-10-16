import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SkillHubApplicationService } from "../src/application.js";
import { MemoryRegistryStore } from "../src/registry.js";
import { GitRepositoryProvider } from "../src/repository.js";
import { SearchRoutingStrategy, SqliteFtsSearchBackend } from "../src/search.js";
import { DevelopmentAuthenticationProvider, StaticRolePermissionProvider } from "../src/security.js";
import { RequiredFieldsRule, RepositoryVisibilityRule, SkillDependencyRule, UniqueNameRule } from "../src/skills.js";
import type { AppConfig, Principal, RepositoryConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);
const principal: Principal = { id: "bundle-integration", tenantId: "rd", roles: ["developer", "internal"] };

function skill(name: string): string {
  return `---\nschema_version: 1\nname: ${name}\ndescription: ${name}\nmetadata:\n  owner: ota-team\n  audience: [developer]\n  domain: [ota]\n  category: [engineering]\n  keywords: [ota]\n  visibility: [internal]\n  priority: 50\n---\n\n# ${name}\n`;
}

async function git(args: string[], cwd?: string) {
  const { stdout } = await execFileAsync("git", args, { ...(cwd ? { cwd } : {}), timeout: 30_000 });
  return stdout.trim();
}

async function seedRemote(root: string) {
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "seed");
  await git(["init", "--bare", "--initial-branch=master", bare]);
  await git(["clone", bare, work]);
  await git(["config", "user.name", "Skill Bundle Test"], work);
  await git(["config", "user.email", "skill-bundle-test@example.invalid"], work);
  await writeFile(path.join(work, "README.md"), "# rd-skills\n", "utf8");
  await git(["add", "README.md"], work);
  await git(["commit", "-m", "init"], work);
  await git(["push", "origin", "master"], work);
  return { bare, work };
}

async function addSkillToRemote(work: string, relative: string, content: string) {
  const file = path.join(work, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  await git(["add", "--", relative], work);
  await git(["commit", "-m", `add ${relative}`], work);
  await git(["push", "origin", "master"], work);
}

test("real application flow keeps ota/design when later submitting ota/usage and honors idempotency/legacy mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-integration-"));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const { bare, work } = await seedRemote(root);
  const repository: RepositoryConfig = {
    id: "rd-skills",
    name: "RD Skills",
    provider: "git",
    gitUrl: bare,
    branch: "master",
    gitAuth: { type: "none" },
    webhookAliases: ["acme/rd-skills"],
    enabled: true,
    audience: ["developer"],
    visibility: ["internal"],
    pollingIntervalSeconds: 0,
    readRoles: [],
    syncRoles: [],
    skillPublishing: {
      enabled: true,
      provider: "github",
      baseUrl: "https://github.com",
      projectPath: "acme/rd-skills",
      tokenEnv: "TEST_UNUSED_SKILL_TOKEN",
      targetBranch: "master",
      branchPrefix: "skill-hub-skill",
    },
  };
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    defaultRoles: ["developer", "internal"],
    authentication: { mode: "development", apiKeys: {} },
    repositories: [repository],
  };
  const search = new SqliteFtsSearchBackend();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const service = new SkillHubApplicationService(
    config,
    [new GitRepositoryProvider()],
    new MemoryRegistryStore(),
    search,
    new SearchRoutingStrategy(search),
    new DevelopmentAuthenticationProvider(["developer", "internal"]),
    new StaticRolePermissionProvider(),
    [new RequiredFieldsRule(), new UniqueNameRule(), new SkillDependencyRule(), new RepositoryVisibilityRule()],
    { emit: (event, payload) => emitted.push({ event, payload }) },
  );
  try {
    await service.initialize();
    const design = await service.submitSkillCandidateCompat(principal, {
      title: "OTA Design",
      content: skill("ota-design"),
      skillCollection: "rd-skills",
      repository: "rd-skills",
      suggestedPath: "ota/design/SKILL.md",
    });
    assert.match(design.id, /^sbi_/);
    assert.equal((design as any).replacementRoot, "skills/ota/design");

    await addSkillToRemote(work, "skills/ota/design/SKILL.md", skill("ota-design"));

    const usage = await service.submitSkillBundle(principal, {
      namespace: "ota",
      importType: "skill",
      skillPath: "usage",
      files: [{ path: "SKILL.md", content: skill("ota-usage") }],
      sourceType: "mcp",
      submissionKey: "usage-once",
      repository: "rd-skills",
    });
    const usageAgain = await service.submitSkillBundle(principal, {
      namespace: "ota",
      importType: "skill",
      skillPath: "usage",
      files: [{ path: "SKILL.md", content: skill("ota-usage") }],
      sourceType: "mcp",
      submissionKey: "usage-once",
      repository: "rd-skills",
    });
    assert.equal(usageAgain.id, usage.id);
    assert.equal(
      emitted.filter((item) => item.event === "skill_bundle.import.created" && item.payload.importId === usage.id)
        .length,
      1,
    );
    assert.equal(
      emitted.filter((item) => item.event === "skill_bundle.import.reused" && item.payload.importId === usage.id)
        .length,
      1,
    );
    const preview = await service.getSkillBundlePreview(principal, usage.id);
    assert.deepEqual(preview.diff.added, ["SKILL.md"]);
    assert.deepEqual(preview.diff.deleted, []);
    assert.deepEqual(preview.skills.map((item) => item.name).sort(), ["ota-design", "ota-usage"]);
    await assert.rejects(
      () =>
        service.submitSkillBundle(principal, {
          namespace: "ota",
          importType: "skill",
          skillPath: "another",
          files: [{ path: "SKILL.md", content: skill("ota-another") }],
          sourceType: "mcp",
          submissionKey: "usage-once",
          repository: "rd-skills",
        }),
      /submission_key conflicts/i,
    );
    const admin: Principal = { id: "bundle-admin", tenantId: "rd", roles: ["admin", "developer", "internal"] };
    assert.equal(await service.deleteSkillBundle(admin, usage.id), true);
    assert.equal(service.getSkillBundleImport(usage.id), undefined);
    assert.equal(
      emitted.filter((item) => item.event === "skill_bundle.import.deleted" && item.payload.importId === usage.id)
        .length,
      1,
    );
  } finally {
    search.close();
    await rm(root, { recursive: true, force: true });
  }
});
