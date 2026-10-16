import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSkillHubDatabase } from "../src/storage/database.js";
import { SqliteSkillBundleRepository } from "../src/storage/skill-bundle-repository.js";
import { SkillBundleService } from "../src/skill-bundle-service.js";
import { SkillBundleReviewStaleError, type SkillBundlePublisher } from "../src/skill-bundle-publishing.js";
import { RequiredFieldsRule, RepositoryVisibilityRule, SkillDependencyRule, UniqueNameRule } from "../src/skills.js";
import type { Principal, RepositoryConfig } from "../src/types.js";

const skill = (name: string) => `---\nschema_version: 1\nname: ${name}\ndescription: ${name}\nmetadata:\n  owner: team\n  audience: [developer]\n  domain: [ota]\n  category: [engineering]\n  keywords: [ota]\n  visibility: [internal]\n  priority: 50\n---\n\n# ${name}\n`;

const repository: RepositoryConfig = {
  id: "rd-skills",
  name: "RD Skills",
  provider: "local",
  path: ".",
  gitAuth: { type: "none" },
  webhookAliases: [],
  enabled: true,
  audience: ["developer"],
  visibility: ["internal"],
  pollingIntervalSeconds: 60,
  readRoles: [],
  syncRoles: [],
  skillPublishing: {
    enabled: true,
    provider: "github",
    baseUrl: "https://github.com",
    projectPath: "example/rd-skills",
    tokenEnv: "TEST_TOKEN",
    targetBranch: "master",
    branchPrefix: "skill-hub-skill"
  }
};

const principal: Principal = { id: "user-1", tenantId: "tenant-1", roles: [] };
const adminPrincipal: Principal = { id: "admin-1", tenantId: "tenant-1", roles: ["admin"] };

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-bundle-service-"));
  const sourceRoot = path.join(dir, "repo");
  await mkdir(path.join(sourceRoot, "skills", "ota", "usage"), { recursive: true });
  await writeFile(path.join(sourceRoot, "skills", "ota", "usage", "SKILL.md"), skill("ota-usage"));
  const db = openSkillHubDatabase(path.join(dir, "hub.sqlite3"));
  const storage = new SqliteSkillBundleRepository(db);
  const service = new SkillBundleService({
    storage,
    rules: [new RequiredFieldsRule(), new UniqueNameRule(), new SkillDependencyRule(), new RepositoryVisibilityRule()],
    materialize: async () => ({ sourceRoot, revision: "rev-1" }),
    authorize: (_who, repo) => repo.id === "rd-skills"
  });
  return { dir, sourceRoot, db, service };
}

async function publisherFixture(finalTreeMatches = true) {
  const base = await fixture();
  const calls: string[] = [];
  const publisher = {
    async publish(record: any, snapshot: any) {
      calls.push("publish");
      return {
        kind: "pull-request" as const,
        provider: "github" as const,
        projectPath: "example/rd-skills",
        branch: "skill-hub-skill-test",
        targetBranch: "master",
        targetRoot: record.replacementRoot,
        mergeRequestIid: 9,
        mergeRequestUrl: "https://github.com/example/rd-skills/pull/9",
        mergeRequestState: "opened" as const,
        added: 1,
        modified: 0,
        deleted: 0,
        expectedTreeSha256: snapshot.sha256,
        pullRequestCreatedAt: "2026-10-14T01:00:00.000Z",
        lastCheckedAt: "2026-10-14T01:00:00.000Z"
      };
    },
    async reconcile(publication: any) {
      calls.push("reconcile");
      return {
        publication: {
          ...publication,
          mergeRequestState: "merged" as const,
          mergedAt: "2026-10-14T02:00:00.000Z",
          lastCheckedAt: "2026-10-14T02:00:00.000Z",
          finalTreeSha256: finalTreeMatches ? publication.expectedTreeSha256 : "different",
          finalTreeVerifiedAt: "2026-10-14T02:00:00.000Z"
        },
        finalTreeMatches
      };
    }
  } as unknown as SkillBundlePublisher;
  const service = new SkillBundleService({
    storage: (base.service as any).options.storage,
    rules: [new RequiredFieldsRule(), new UniqueNameRule(), new SkillDependencyRule(), new RepositoryVisibilityRule()],
    materialize: async () => ({ sourceRoot: base.sourceRoot, revision: "rev-1" }),
    authorize: (_who, repo) => repo.id === "rd-skills",
    publisher
  });
  return { ...base, service, calls };
}

test("submit validates the whole repository while replacing only the skill root", async () => {
  const { dir, db, service } = await fixture();
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota",
      importType: "skill",
      skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }],
      sourceType: "mcp",
      submissionKey: "key-1"
    });
    assert.equal(created.status, "pending");
    assert.equal(created.replacementRoot, "skills/ota/design");
    const preview = await service.previewImport(principal, repository, created.id);
    assert.deepEqual(preview.diff.added, ["SKILL.md"]);
    assert.equal(preview.targetRevision, "rev-1");
    assert.deepEqual(preview.skills.map((item) => item.name).sort(), ["ota-design", "ota-usage"]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval stores a review baseline and later target changes make it stale", async () => {
  const { dir, sourceRoot, db, service } = await fixture();
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota",
      importType: "skill",
      skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }],
      sourceType: "mcp"
    });
    const approved = await service.review(adminPrincipal, repository, created.id, "approved", "looks good");
    assert.equal(approved.status, "approved");
    assert.equal(approved.review?.targetRevision, "rev-1");
    await mkdir(path.join(sourceRoot, "skills", "ota", "design"), { recursive: true });
    await writeFile(path.join(sourceRoot, "skills", "ota", "design", "SKILL.md"), skill("ota-design-old"));
    const stale = await service.ensureReviewFresh(adminPrincipal, repository, created.id);
    assert.equal(stale.status, "review_stale");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reject does not require the current target tree to remain valid", async () => {
  const { dir, sourceRoot, db, service } = await fixture();
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota",
      importType: "skill",
      skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }],
      sourceType: "mcp"
    });
    await writeFile(path.join(sourceRoot, "skills", "ota", "usage", "SKILL.md"), "not valid skill");
    const rejected = await service.review(adminPrincipal, repository, created.id, "rejected", "not wanted");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.review?.targetTreeSha256, undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval cannot overwrite a concurrent rejection", async () => {
  const base = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const previewEntered = new Promise<void>((resolve) => { entered = resolve; });
  const previewRelease = new Promise<void>((resolve) => { release = resolve; });
  let blockPreview = false;
  const service = new SkillBundleService({
    storage: (base.service as any).options.storage,
    rules: [new RequiredFieldsRule(), new UniqueNameRule(), new SkillDependencyRule(), new RepositoryVisibilityRule()],
    materialize: async () => {
      if (blockPreview) {
        entered();
        await previewRelease;
      }
      return { sourceRoot: base.sourceRoot, revision: "rev-1" };
    },
    authorize: (_who, repo) => repo.id === "rd-skills"
  });
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }], sourceType: "mcp"
    });
    blockPreview = true;
    const approving = service.review(adminPrincipal, repository, created.id, "approved");
    await previewEntered;
    const rejected = await service.review(adminPrincipal, repository, created.id, "rejected", "superseded");
    assert.equal(rejected.status, "rejected");
    release();
    await assert.rejects(approving, /state conflict/i);
    assert.equal(service.getImport(created.id)?.status, "rejected");
  } finally {
    base.db.close();
    await rm(base.dir, { recursive: true, force: true });
  }
});

test("unauthorized principal cannot submit", async () => {
  const { dir, db, service } = await fixture();
  try {
    await assert.rejects(() => service.submit({ ...principal, id: "blocked" }, { ...repository, id: "other" }, {
      namespace: "ota",
      importType: "skill",
      skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }],
      sourceType: "mcp"
    }), /not authorized/i);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-admin submitter cannot review or publish a Bundle", async () => {
  const { dir, db, service } = await fixture();
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }], sourceType: "mcp"
    });
    await assert.rejects(() => service.review(principal, repository, created.id, "approved"), /administrator role/i);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("admin can delete only unpublished Bundle states", async () => {
  const { dir, db, service } = await fixture();
  try {
    const first = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "auth-check",
      files: [{ path: "SKILL.md", content: skill("ota-auth-check") }], sourceType: "mcp"
    });
    await assert.rejects(() => service.delete(principal, repository, first.id), /administrator role/i);

    const storage = (service as any).options.storage as SqliteSkillBundleRepository;
    const allowed = ["pending", "approved", "rejected", "publish_failed", "review_stale"] as const;
    for (const [index, status] of allowed.entries()) {
      const created = await service.submit(principal, repository, {
        namespace: "ota", importType: "skill", skillPath: `delete-${index}`,
        files: [{ path: "SKILL.md", content: skill(`ota-delete-${index}`) }], sourceType: "mcp"
      });
      const current = status === "pending" ? created : storage.updateImport({ ...created, status, updatedAt: `2026-10-14T03:0${index}:00.000Z` });
      assert.equal(await service.delete(adminPrincipal, repository, current.id), true, `${status} should be deletable`);
      assert.equal(service.getImport(current.id), undefined);
    }

    const forbidden = ["publishing", "published", "published_drifted"] as const;
    for (const [index, status] of forbidden.entries()) {
      const created = await service.submit(principal, repository, {
        namespace: "ota", importType: "skill", skillPath: `keep-${index}`,
        files: [{ path: "SKILL.md", content: skill(`ota-keep-${index}`) }], sourceType: "mcp"
      });
      const current = storage.updateImport({ ...created, status, updatedAt: `2026-10-14T04:0${index}:00.000Z` });
      await assert.rejects(() => service.delete(adminPrincipal, repository, current.id), /cannot be deleted/i);
      assert.equal(service.getImport(current.id)?.status, status);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("publisher-time target drift returns review_stale instead of publish_failed", async () => {
  const base = await fixture();
  const service = new SkillBundleService({
    storage: (base.service as any).options.storage,
    rules: [new RequiredFieldsRule(), new UniqueNameRule(), new SkillDependencyRule(), new RepositoryVisibilityRule()],
    materialize: async () => ({ sourceRoot: base.sourceRoot, revision: "rev-1" }),
    authorize: (_who, repo) => repo.id === "rd-skills",
    publisher: {
      async publish() { throw new SkillBundleReviewStaleError(); }
    } as unknown as SkillBundlePublisher
  });
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }], sourceType: "mcp"
    });
    await service.review(adminPrincipal, repository, created.id, "approved");
    const stale = await service.publish(adminPrincipal, repository, created.id);
    assert.equal(stale.status, "review_stale");
    assert.equal(stale.publishError, undefined);
  } finally {
    base.db.close();
    await rm(base.dir, { recursive: true, force: true });
  }
});

test("publish marks PR workflow publishing and reconcile marks exact merged tree published", async () => {
  const { dir, db, service, calls } = await publisherFixture(true);
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }], sourceType: "mcp"
    });
    await service.review(adminPrincipal, repository, created.id, "approved");
    const publishing = await service.publish(adminPrincipal, repository, created.id);
    assert.equal(publishing.status, "publishing");
    assert.equal(publishing.publication?.kind, "pull-request");
    const published = await service.reconcile(adminPrincipal, repository, created.id);
    assert.equal(published.status, "published");
    assert.deepEqual(calls, ["publish", "reconcile"]);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("reconcile marks merged but divergent final tree published_drifted", async () => {
  const { dir, db, service } = await publisherFixture(false);
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }], sourceType: "mcp"
    });
    await service.review(adminPrincipal, repository, created.id, "approved");
    await service.publish(adminPrincipal, repository, created.id);
    const drifted = await service.reconcile(adminPrincipal, repository, created.id);
    assert.equal(drifted.status, "published_drifted");
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("reconcile transport failure does not downgrade an already published import", async () => {
  const { dir, db, service } = await publisherFixture(true);
  try {
    const created = await service.submit(principal, repository, {
      namespace: "ota", importType: "skill", skillPath: "design",
      files: [{ path: "SKILL.md", content: skill("ota-design") }], sourceType: "mcp"
    });
    await service.review(adminPrincipal, repository, created.id, "approved");
    await service.publish(adminPrincipal, repository, created.id);
    const published = await service.reconcile(adminPrincipal, repository, created.id);
    assert.equal(published.status, "published");
    (service as any).publisher.reconcile = async () => { throw new Error("temporary remote failure"); };
    await assert.rejects(() => service.reconcile(adminPrincipal, repository, created.id), /temporary remote failure/);
    assert.equal(service.getImport(created.id)?.status, "published");
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
