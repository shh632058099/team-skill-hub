import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";

test("V2 deployment snapshots are immutable, capability-gated and part of deduplication identity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-v2-snapshot-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "review",
      displayName: "Review",
      capabilities: ["review"],
      keywords: [],
      active: true,
    });
    const modelConfig = {
      providerId: "router",
      model: "review-model-a",
      baseUrl: "https://example.org/v1",
      wireApi: "responses" as const,
      credentialRef: "model",
      allowedEnvNames: ["OPENAI_API_KEY"],
    };
    const repository = { id: "repo", url: "https://github.com/example/example.git", branch: "main" };
    const baseline = {
      expertId: "review",
      repositoryIds: ["repo"],
      repositories: [repository],
      principals: ["alice"],
      runtimeProfile: "runtime-v2",
      active: true,
    };
    experts.putDeployment({ ...baseline, id: "d1", executor: { backend: "codex", modelConfig } });
    experts.putDeployment({
      ...baseline,
      id: "d2",
      executor: { backend: "codex", modelConfig: { ...modelConfig, model: "review-model-b" } },
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const input = {
      principalId: "alice",
      scope: "test",
      sourceClient: "claude",
      sourceSessionId: "stable-session",
      problem: "review this repository",
      expertId: "review",
      repositoryId: "repo",
      selectionMode: "explicit" as const,
    };
    assert.throws(() => dispatch.submit({ ...input, idempotencyKey: "ambiguous" }), /DEPLOYMENT_REQUIRED/);
    const first = dispatch.submit({ ...input, idempotencyKey: "first", deploymentId: "d1" });
    const second = dispatch.submit({ ...input, idempotencyKey: "second", deploymentId: "d2" });
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(first.deploymentSnapshot?.executor.modelConfig.model, "review-model-a");
    assert.equal(first.schemaVersion, 2);
    assert.equal(tasks.claim("old-worker", Date.now(), 30_000, "review"), null, "legacy Worker cannot claim V2");
    assert.equal(
      tasks.claim("wrong-backend", Date.now(), 30_000, "review", {
        backend: "claude",
        runtimeProfiles: ["runtime-v2"],
      }),
      null,
    );
    assert.equal(
      tasks.claim("wrong-profile", Date.now(), 30_000, "review", { backend: "codex", runtimeProfiles: ["other"] }),
      null,
    );
    experts.putDeployment({
      ...baseline,
      id: "d1",
      executor: { backend: "codex", modelConfig: { ...modelConfig, model: "changed-model" } },
    });
    const claim = tasks.claim("v2-worker", Date.now(), 30_000, "review", {
      backend: "codex",
      runtimeProfiles: ["runtime-v2"],
    });
    assert.equal(
      claim?.deploymentSnapshot?.executor.modelConfig.model,
      "review-model-a",
      "queued snapshot must not change",
    );
    assert.equal(claim?.taskId, first.taskId);
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch auto-routes and persists routing metadata on task", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });

    const dispatch = new ExpertDispatchService(experts, tasks);
    const task = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "auto-1",
      problem: "investigate ota upgrade failure",
      repositoryId: "ota-repo",
    });

    assert.equal(task.expertId, "ota");
    assert.equal(task.repositoryId, "ota-repo");
    assert.equal(task.selectionMode, "auto");
    assert.equal(task.schemaVersion, 1);
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch preserves strict explicit selection and repository authorization", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: [],
      active: true,
    });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });

    const dispatch = new ExpertDispatchService(experts, tasks);
    assert.throws(
      () =>
        dispatch.submit({
          principalId: "alice",
          scope: "org",
          idempotencyKey: "explicit-bad",
          problem: "inspect update",
          expertId: "ota",
          repositoryId: "other-repo",
        }),
      /REPOSITORY_FORBIDDEN/,
    );

    const task = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "explicit-good",
      problem: "inspect update",
      expertId: "ota",
      repositoryId: "ota-repo",
    });
    assert.equal(task.selectionMode, "explicit");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch infers the only configured URL repository when caller omits an internal repository ID", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-url-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({ id: "ota", displayName: "OTA Expert", capabilities: ["ota"], keywords: [], active: true });
    experts.putDeployment({
      id: "ota-default",
      expertId: "ota",
      repositoryIds: ["repo-0123456789abcdefabcd"],
      repositories: [{ id: "repo-0123456789abcdefabcd", url: "https://github.com/example/ota.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const task = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "url-auto-1",
      problem: "investigate ota",
    });
    assert.equal(task.expertId, "ota");
    assert.equal(task.repositoryId, "repo-0123456789abcdefabcd");
    assert.equal(task.selectionMode, "auto");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch does not combine principals and repositories across deployments", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-acl-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "review",
      displayName: "Review Expert",
      capabilities: ["review"],
      keywords: ["code"],
      active: true,
    });
    experts.putDeployment({
      id: "alice-a",
      expertId: "review",
      repositoryIds: ["repo-a"],
      repositories: [],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    experts.putDeployment({
      id: "bob-b",
      expertId: "review",
      repositoryIds: ["repo-b"],
      repositories: [],
      principals: ["bob"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    assert.throws(
      () =>
        dispatch.submit({
          principalId: "alice",
          scope: "org",
          idempotencyKey: "acl-cross-product",
          problem: "review code",
          expertId: "review",
          repositoryId: "repo-b",
        }),
      /REPOSITORY_FORBIDDEN/,
    );
    const allowed = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "acl-allowed",
      problem: "review code",
      expertId: "review",
      repositoryId: "repo-a",
    });
    assert.equal(allowed.repositoryId, "repo-a");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch requires an explicit repository when the selected expert has multiple URL repositories", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-multi-repo-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA Expert",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-multi",
      expertId: "ota",
      repositoryIds: ["repo-aaaaaaaaaaaaaaaaaaaa", "repo-bbbbbbbbbbbbbbbbbbbb"],
      repositories: [
        { id: "repo-aaaaaaaaaaaaaaaaaaaa", url: "https://github.com/example/ota-core.git", branch: "main" },
        { id: "repo-bbbbbbbbbbbbbbbbbbbb", url: "https://github.com/example/ota-tests.git", branch: "main" },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    assert.throws(
      () =>
        dispatch.submit({
          principalId: "alice",
          scope: "org",
          idempotencyKey: "multi-repo-missing",
          problem: "investigate ota upgrade failure",
          expertId: "ota",
        }),
      /REPOSITORY_REQUIRED/,
    );
    const explicit = dispatch.submit({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "multi-repo-explicit",
      problem: "investigate ota upgrade failure",
      expertId: "ota",
      repositoryId: "repo-bbbbbbbbbbbbbbbbbbbb",
    });
    assert.equal(explicit.repositoryId, "repo-bbbbbbbbbbbbbbbbbbbb");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch resolves MCP Profile defaults with sparse overrides and snapshots effective values", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-mcp-profile-inherit-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: [], active: true });
    const base = {
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [{ id: "repo", url: "https://example.org/ota.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "runtime",
      active: true,
      executor: {
        backend: "claude" as const,
        modelConfig: {
          providerId: "router",
          model: "sonnet",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages" as const,
          allowedEnvNames: ["ANTHROPIC_API_KEY"],
        },
      },
    };
    experts.putMcpProfile({
      id: "default",
      url: "https://hub.example/mcp",
      credentialRef: "hub-ro",
      allowedTools: ["discover", "search_skills"],
      required: true,
    });
    experts.putDeployment({ ...base, id: "inherit", mcp: { profileRef: "default" } });
    experts.putDeployment({
      ...base,
      id: "inherit-codex",
      executor: {
        ...base.executor,
        backend: "codex" as const,
        modelConfig: { ...base.executor.modelConfig, wireApi: "responses" as const },
      },
      mcp: { profileRef: "default" },
    });
    experts.putDeployment({
      ...base,
      id: "override",
      mcp: {
        profileRef: "default",
        urlOverride: "https://other.example/mcp",
        allowedTools: ["discover"],
        required: false,
      },
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const input = {
      principalId: "alice",
      scope: "test",
      problem: "inspect ota",
      expertId: "ota",
      repositoryId: "repo",
      selectionMode: "explicit" as const,
    };
    const inherited = dispatch.submit({ ...input, idempotencyKey: "inherit", deploymentId: "inherit" });
    assert.deepEqual(inherited.deploymentSnapshot?.mcp, {
      profileRef: "default",
      urlOverride: "https://hub.example/mcp",
      credentialRef: "hub-ro",
      allowedTools: ["discover", "search_skills"],
      required: true,
    });
    const codex = dispatch.submit({ ...input, idempotencyKey: "inherit-codex", deploymentId: "inherit-codex" });
    assert.equal(codex.deploymentSnapshot?.executor.backend, "codex");
    assert.deepEqual(codex.deploymentSnapshot?.mcp, inherited.deploymentSnapshot?.mcp);
    const overridden = dispatch.submit({ ...input, idempotencyKey: "override", deploymentId: "override" });
    assert.deepEqual(overridden.deploymentSnapshot?.mcp, {
      profileRef: "default",
      urlOverride: "https://other.example/mcp",
      credentialRef: "hub-ro",
      allowedTools: ["discover"],
      required: false,
    });
    experts.putMcpProfile({
      id: "default",
      url: "https://hub-v2.example/mcp",
      credentialRef: "hub-v2",
      allowedTools: ["discover"],
      required: false,
    });
    const next = dispatch.submit({ ...input, idempotencyKey: "after-profile-update", deploymentId: "inherit" });
    assert.equal(next.deploymentSnapshot?.mcp?.urlOverride, "https://hub-v2.example/mcp");
    assert.equal(next.deploymentSnapshot?.mcp?.credentialRef, "hub-v2");
    assert.deepEqual(
      inherited.deploymentSnapshot?.mcp?.allowedTools,
      ["discover", "search_skills"],
      "existing snapshot remains immutable",
    );
    experts.putDeployment({ ...base, id: "bad-profile", mcp: { profileRef: "missing" } });
    assert.throws(
      () => dispatch.submit({ ...input, idempotencyKey: "missing-profile", deploymentId: "bad-profile" }),
      /EXPERT_MCP_PROFILE_NOT_FOUND/,
    );
    experts.putDeployment({
      ...base,
      id: "bad-tools",
      mcp: { profileRef: "default", allowedTools: ["search_skills"] },
    });
    assert.throws(
      () => dispatch.submit({ ...input, idempotencyKey: "bad-tools", deploymentId: "bad-tools" }),
      /MCP_PROFILE_TOOL_NOT_ALLOWED/,
    );
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch filters deployments by required runtime profile and fails closed on mismatch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-runtime-profile-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    const common = {
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [],
      principals: ["alice"],
      active: true,
    };
    experts.putDeployment({ ...common, id: "ota-ro", runtimeProfile: "codex-readonly" });
    experts.putDeployment({ ...common, id: "ota-rw", runtimeProfile: "codex-workspace-write" });
    const dispatch = new ExpertDispatchService(experts, tasks);

    const auto = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      problem: "upgrade failure",
      repositoryId: "ota-repo",
      requiredRuntimeProfile: "codex-workspace-write",
    });
    assert.equal(auto.deploymentId, "ota-rw");

    assert.throws(
      () =>
        dispatch.resolve({
          principalId: "alice",
          scope: "org",
          problem: "upgrade failure",
          repositoryId: "ota-repo",
          requiredRuntimeProfile: "claude-workspace-write",
        }),
      /RUNTIME_PROFILE_UNAVAILABLE/,
    );

    assert.throws(
      () =>
        dispatch.resolve({
          principalId: "alice",
          scope: "org",
          problem: "upgrade failure",
          expertId: "ota",
          selectionMode: "explicit",
          repositoryId: "ota-repo",
          deploymentId: "ota-ro",
          requiredRuntimeProfile: "codex-workspace-write",
        }),
      /RUNTIME_PROFILE_MISMATCH/,
    );

    const legacy = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      problem: "upgrade failure",
      expertId: "ota",
      selectionMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-ro",
    });
    assert.equal(legacy.deploymentId, "ota-ro");
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch combines workflow workspace access with caller backend preference", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-workspace-access-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    const common = {
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [{ id: "ota-repo", url: "https://example.test/ota.git", branch: "main" }],
      principals: ["alice"],
      active: true,
    };
    experts.putDeployment({ ...common, id: "ota-claude-ro", runtimeProfile: "claude-readonly" });
    experts.putDeployment({ ...common, id: "ota-claude-rw", runtimeProfile: "claude-workspace-write" });
    experts.putDeployment({ ...common, id: "ota-codex-ro", runtimeProfile: "codex-readonly" });
    experts.putDeployment({ ...common, id: "ota-codex-rw", runtimeProfile: "codex-workspace-write" });
    const dispatch = new ExpertDispatchService(experts, tasks);

    const claudeWrite = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      problem: "fix upgrade failure",
      expertId: "ota",
      selectionMode: "explicit",
      requiredWorkspaceAccess: "read-write",
      preferredBackend: "claude",
    });
    assert.equal(claudeWrite.repositoryId, "ota-repo");
    assert.equal(claudeWrite.deploymentId, "ota-claude-rw");

    const codexRead = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      problem: "inspect upgrade failure",
      expertId: "ota",
      selectionMode: "explicit",
      requiredWorkspaceAccess: "read-only",
      preferredBackend: "codex",
    });
    assert.equal(codexRead.deploymentId, "ota-codex-ro");

    const claudeWriteCanReview = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      problem: "review upgrade failure",
      expertId: "ota",
      selectionMode: "explicit",
      deploymentId: "ota-claude-rw",
      requiredWorkspaceAccess: "read-only",
    });
    assert.equal(claudeWriteCanReview.deploymentId, "ota-claude-rw");

    assert.throws(
      () =>
        dispatch.resolve({
          principalId: "alice",
          scope: "org",
          problem: "fix upgrade failure",
          expertId: "ota",
          selectionMode: "explicit",
          requiredWorkspaceAccess: "read-write",
        }),
      /DEPLOYMENT_REQUIRED/,
      "without an exact deployment or backend preference multiple write deployments remain ambiguous",
    );

    assert.throws(
      () =>
        dispatch.resolve({
          principalId: "alice",
          scope: "org",
          problem: "fix upgrade failure",
          expertId: "ota",
          selectionMode: "explicit",
          deploymentId: "ota-claude-ro",
          requiredWorkspaceAccess: "read-write",
        }),
      /RUNTIME_PROFILE_MISMATCH/,
    );
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository verification policy is validated and pinned into the deployment snapshot", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-verification-policy-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    const modelConfig = {
      providerId: "router",
      model: "model",
      baseUrl: "https://router.example/v1",
      wireApi: "anthropic-messages" as const,
      allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
    };
    const verificationPolicy = {
      version: 3,
      required: [
        {
          id: "build",
          type: "command",
          argv: ["cmake", "--build", "/tmp/build"],
          timeoutMs: 120_000,
          evidenceType: "build",
        },
        {
          id: "unit",
          type: "command",
          argv: ["ctest", "--test-dir", "/tmp/build"],
          timeoutMs: 120_000,
          evidenceType: "unit_test",
        },
        {
          id: "integration",
          type: "command",
          argv: ["ctest", "--test-dir", "/tmp/build", "-R", "^integration$"],
          timeoutMs: 120_000,
          evidenceType: "integration_test",
        },
      ],
    };
    experts.putDeployment({
      id: "ota-write",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.org/ota.git",
          branch: "main",
          verificationPolicy,
        } as any,
      ],
      principals: ["alice"],
      runtimeProfile: "claude-workspace-write",
      active: true,
      executor: { backend: "claude", modelConfig },
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const resolved = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      problem: "fix upgrade failure",
      expertId: "ota",
      selectionMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-write",
    });
    assert.deepEqual((resolved.deploymentSnapshot?.repository as any)?.verificationPolicy, verificationPolicy);

    assert.throws(
      () =>
        experts.putDeployment({
          ...experts.getDeployment("ota-write"),
          id: "ota-invalid-verification",
          repositories: [
            {
              id: "ota-repo",
              url: "https://example.org/ota.git",
              branch: "main",
              verificationPolicy: {
                version: 1,
                required: [
                  {
                    id: "lint",
                    type: "command",
                    argv: ["npm", "run", "lint"],
                    timeoutMs: 60_000,
                    evidenceType: "lint",
                  },
                ],
              },
            } as any,
          ],
        }),
      /INVALID_EXPERT_DEPLOYMENT/,
    );

    experts.putDeployment({
      ...experts.getDeployment("ota-write"),
      repositories: [
        {
          ...experts.getDeployment("ota-write").repositories![0]!,
          verificationPolicy: {
            ...verificationPolicy,
            version: 4,
            required: verificationPolicy.required.slice(0, 2),
          },
        } as any,
      ],
    });
    assert.equal((resolved.deploymentSnapshot?.repository as any)?.verificationPolicy.version, 3);
    assert.equal((resolved.deploymentSnapshot?.repository as any)?.verificationPolicy.required.length, 3);
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch pins repository publication policy into the task snapshot", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expert-dispatch-publication-policy-"));
  const db = path.join(dir, "runtime.sqlite");
  try {
    const experts = new ExpertStore(db);
    const tasks = new ExpertTaskStore(db);
    experts.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota"],
      keywords: ["upgrade"],
      active: true,
    });
    const publicationPolicy = {
      version: 7,
      permissions: ["prepare-commit", "push-work-branch"],
      branchPrefix: "skillhub/work/",
      protectedBranches: ["main"],
      allowedPushRemote: "origin",
      credentialRef: "publish-credential-ref",
      allowForcePush: false,
      allowDeleteRef: false,
    };
    experts.putDeployment({
      id: "ota-write",
      expertId: "ota",
      repositoryIds: ["ota-repo"],
      repositories: [
        {
          id: "ota-repo",
          url: "https://example.org/ota.git",
          branch: "main",
          credentialRef: "readonly-clone",
          publicationPolicy,
        } as any,
      ],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "model",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    const dispatch = new ExpertDispatchService(experts, tasks);
    const resolved = dispatch.resolve({
      principalId: "alice",
      scope: "org",
      idempotencyKey: "pub-policy-1",
      problem: "upgrade failure",
      expertId: "ota",
      selectionMode: "explicit",
      repositoryId: "ota-repo",
      deploymentId: "ota-write",
    });
    assert.deepEqual((resolved.deploymentSnapshot?.repository as any)?.publicationPolicy, publicationPolicy);

    experts.putDeployment({
      ...experts.getDeployment("ota-write"),
      repositories: [
        {
          ...experts.getDeployment("ota-write").repositories![0]!,
          publicationPolicy: { ...publicationPolicy, version: 8, branchPrefix: "changed/" },
        } as any,
      ],
    });
    assert.equal((resolved.deploymentSnapshot?.repository as any)?.publicationPolicy.version, 7);
    assert.equal((resolved.deploymentSnapshot?.repository as any)?.publicationPolicy.branchPrefix, "skillhub/work/");

    const task = dispatch.submitResolved(
      {
        principalId: "alice",
        scope: "org",
        idempotencyKey: "pub-policy-submit",
        problem: "upgrade failure",
        expertId: "ota",
        selectionMode: "explicit",
        repositoryId: "ota-repo",
        deploymentId: "ota-write",
      },
      resolved,
    );
    assert.deepEqual((task.deploymentSnapshot?.repository as any)?.publicationPolicy, publicationPolicy);
    experts.close();
    tasks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
