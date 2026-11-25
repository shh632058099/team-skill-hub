import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import {
  StaticWorkDagOrganizationPolicyProvider,
  WorkDagPolicyContextResolver,
  createWorkDagOrganizationPolicyProviderFromEnv,
  workflowOnlyDagPolicyContext,
} from "../src/expert-platform/work-dag-policy-context.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";

test("policy context is derived from pinned deployment and repository capabilities", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-policy-context-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota-analysis"],
      keywords: ["ota"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-ro",
      expertId: "ota",
      repositoryIds: ["repo", "repo-b"],
      repositories: [
        {
          id: "repo",
          url: "https://example.test/repo.git",
          branch: "main",
          verificationPolicy: {
            version: 1,
            required: [
              {
                id: "build",
                type: "command",
                argv: ["sh", "-lc", "./build.sh"],
                timeoutMs: 60_000,
                evidenceType: "build",
              },
            ],
          },
          publicationPolicy: {
            version: 1,
            permissions: ["prepare-commit"],
            branchPrefix: "work/",
            protectedBranches: ["main"],
            allowedPushRemote: "origin",
            allowForcePush: false,
            allowDeleteRef: false,
          },
        },
        {
          id: "repo-b",
          url: "https://example.test/repo-b.git",
          branch: "main",
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "test",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });

    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "policy-context",
      sourceType: "mcp",
      title: "Inspect OTA",
      description: "Inspect OTA",
      workflowId: "investigation",
      expertId: "ota",
      repositoryId: "repo",
      deploymentId: "ota-ro",
    });
    const workflow = workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const resolver = new WorkDagPolicyContextResolver(
      workStore,
      new ExpertDispatchService(experts, tasks),
      experts,
      tasks,
    );
    const context = resolver.resolve(work, workflow);

    assert.equal(context.routingIssue, undefined);
    assert.equal(context.deployment?.deploymentId, "ota-ro");
    assert.equal(context.repository?.repositoryId, "repo");
    assert.deepEqual(context.repository?.verificationCapabilities, ["build"]);
    assert.deepEqual(context.executorCapabilities.verification, ["build"]);
    assert.deepEqual(context.executorCapabilities.publication, ["prepare"]);
    assert.deepEqual(context.executorCapabilities.change_request, []);
    assert.ok(context.resourcePolicies);
    const resourcePolicies = context.resourcePolicies;
    assert.deepEqual(resourcePolicies["repo:repo"]?.executorCapabilities.verification, ["build"]);
    assert.deepEqual(resourcePolicies["repo:repo-b"]?.executorCapabilities.verification, []);
    assert.notEqual(
      resourcePolicies["repo:repo"]?.repository.policyDigest,
      resourcePolicies["repo:repo-b"]?.repository.policyDigest,
    );
    assert.ok(context.digest.length > 20);

    const baseA = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition, {
      replansUsed: 0,
      reworksUsed: 0,
      continuationTurns: 0,
    });
    const baseB = workflowOnlyDagPolicyContext(workflow.workflowId, workflow.version, workflow.definition, {
      replansUsed: 7,
      reworksUsed: 1,
      continuationTurns: 5,
    });
    assert.equal(baseA.digest, baseB.digest, "dynamic usage must not change pinned policy identity");
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy context prefers caller backend when explicit expert and repository leave deployments ambiguous", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-policy-backend-preference-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "ota",
      displayName: "OTA",
      capabilities: ["ota"],
      keywords: ["ota"],
      active: true,
    });
    const common = {
      expertId: "ota",
      repositoryIds: ["repo"],
      repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
      principals: ["alice"],
      active: true,
    };
    experts.putDeployment({
      ...common,
      id: "ota-claude-ro",
      runtimeProfile: "claude-readonly",
      executor: {
        backend: "claude",
        modelConfig: {
          providerId: "router",
          model: "test",
          baseUrl: "https://router.example/v1",
          wireApi: "anthropic-messages",
          allowedEnvNames: ["ANTHROPIC_AUTH_TOKEN"],
        },
      },
    });
    experts.putDeployment({
      ...common,
      id: "ota-codex-ro",
      runtimeProfile: "codex-readonly",
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "test",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });

    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "policy-backend-preference",
      sourceType: "mcp",
      sourceScope: "claude-code_2.1.332 (sdk-cli)/session-1",
      sourceRef: "request-1",
      title: "Inspect OTA",
      description: "Inspect OTA",
      workflowId: "investigation",
      expertId: "ota",
      repositoryId: "repo",
    });
    const workflow = workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const resolver = new WorkDagPolicyContextResolver(
      workStore,
      new ExpertDispatchService(experts, tasks),
      experts,
      tasks,
    );

    const context = resolver.resolve(work, workflow);

    assert.equal(context.routingIssue, undefined);
    assert.equal(context.deployment?.deploymentId, "ota-claude-ro");
    assert.equal(context.deployment?.runtimeProfile, "claude-readonly");
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy context auto routing follows current RequirementSnapshot before original request", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-policy-requirement-routing-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    for (const [expertId, keyword] of [
      ["legacy", "legacy"],
      ["snapshot", "snapshot-specialist"],
    ] as const) {
      experts.putDefinition({
        id: expertId,
        displayName: expertId,
        capabilities: [keyword],
        keywords: [keyword],
        active: true,
      });
      experts.putDeployment({
        id: expertId + "-ro",
        expertId,
        repositoryIds: ["repo"],
        repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
        principals: ["alice"],
        runtimeProfile: "codex-readonly",
        active: true,
        executor: {
          backend: "codex",
          modelConfig: {
            providerId: "router",
            model: "test",
            baseUrl: "https://router.example/v1",
            wireApi: "responses",
            allowedEnvNames: ["OPENAI_API_KEY"],
          },
        },
      });
    }

    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "policy-requirement-routing",
      sourceType: "mcp",
      title: "route current requirement",
      description: "legacy diagnosis",
      workflowId: "investigation",
      repositoryId: "repo",
    });
    const initial = workStore.ensureRequirementSnapshot(work.workItemId);
    let current = workStore.getWorkInternal(work.workItemId);
    const updated = workStore.updateRequirementSnapshot(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      initial.revision,
      [
        {
          id: "user:snapshot-specialist",
          source: "user",
          strength: "preferred",
          condition: { kind: "always" },
          satisfaction: { kind: "fact", key: "snapshot-specialist", equals: true },
        },
      ],
      "test",
      20,
    );
    current = updated.work;

    const workflow = workStore.getWorkflow(current.workflowId, current.workflowVersion);
    const resolver = new WorkDagPolicyContextResolver(
      workStore,
      new ExpertDispatchService(experts, tasks),
      experts,
      tasks,
    );
    const context = resolver.resolve(current, workflow);

    assert.equal(context.routingIssue, undefined);
    assert.equal(context.deployment?.expertId, "snapshot");
    assert.equal(context.deployment?.deploymentId, "snapshot-ro");
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository verification policy is pinned into RequirementSnapshot and gates completion when that resource becomes active", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-repository-obligation-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "ota-write",
      displayName: "OTA write",
      capabilities: ["ota"],
      keywords: ["ota"],
      active: true,
    });
    experts.putDeployment({
      id: "ota-write-deployment",
      expertId: "ota-write",
      repositoryIds: ["repo"],
      repositories: [
        {
          id: "repo",
          url: "https://example.test/repo.git",
          branch: "main",
          verificationPolicy: {
            version: 1,
            required: [
              {
                id: "repo-integration",
                type: "command",
                argv: ["sh", "-lc", "./integration.sh"],
                timeoutMs: 60_000,
                evidenceType: "integration_test",
              },
            ],
          },
        },
      ],
      principals: ["alice"],
      runtimeProfile: "codex-workspace-write",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "test",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });

    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "repo-policy-obligation",
      sourceType: "mcp",
      title: "Fix OTA",
      description: "Fix OTA",
      workflowId: "bug-fix",
      expertId: "ota-write",
      repositoryId: "repo",
      deploymentId: "ota-write-deployment",
    });
    const first = workStore.ensureRequirementSnapshot(work.workItemId, 100);
    const workflow = workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const resolver = new WorkDagPolicyContextResolver(
      workStore,
      new ExpertDispatchService(experts, tasks),
      experts,
      tasks,
    );
    const context = resolver.resolve(work, workflow);
    const current = workStore.getWorkInternal(work.workItemId);
    const bound = workStore.bindRequirementPolicyContext(
      work.workItemId,
      "alice",
      "team",
      current.stateRevision,
      first.revision,
      context,
      110,
    );

    const integrationObligations = bound.snapshot.policyObligations.filter(
      (obligation) =>
        obligation.satisfaction.kind === "evidence" && obligation.satisfaction.type === "integration_test",
    );
    assert.equal(integrationObligations.length, 1, "primary repository alias must not duplicate one policy obligation");
    assert.equal(integrationObligations[0]?.resource, "workspace");
    assert.ok(
      workStore
        .getEffectiveDagObligations(work.workItemId)
        .some(
          (obligation) =>
            obligation.resource === "workspace" &&
            obligation.satisfaction.kind === "evidence" &&
            obligation.satisfaction.type === "integration_test",
        ),
    );

    workStore.setCurrentSubjectRevision(
      work.workItemId,
      "alice",
      "team",
      bound.work.stateRevision,
      "workspace:changed",
      120,
    );
    const completion = workStore.evaluateDagCompletion(work.workItemId);
    assert.ok(completion.missing.some((id) => id.includes("integration_test")));

    const persistedRevision = bound.snapshot.revision;
    workStore.close();
    tasks.close();
    experts.close();

    const reopened = new WorkOrchestrationStore(file);
    const persisted = reopened.getRequirementSnapshot(work.workItemId, persistedRevision);
    assert.deepEqual(persisted.policyObligations, bound.snapshot.policyObligations);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organization policy provider is authoritative, pinned and environment-configurable", () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-organization-policy-"));
  const file = join(dir, "runtime.db");
  const experts = new ExpertStore(file);
  const tasks = new ExpertTaskStore(file);
  const workStore = new WorkOrchestrationStore(file);
  try {
    experts.putDefinition({
      id: "reviewer",
      displayName: "Reviewer",
      capabilities: ["review"],
      keywords: ["review"],
      active: true,
    });
    experts.putDeployment({
      id: "reviewer-ro",
      expertId: "reviewer",
      repositoryIds: ["repo"],
      repositories: [{ id: "repo", url: "https://example.test/repo.git", branch: "main" }],
      principals: ["alice"],
      runtimeProfile: "codex-readonly",
      active: true,
      executor: {
        backend: "codex",
        modelConfig: {
          providerId: "router",
          model: "test",
          baseUrl: "https://router.example/v1",
          wireApi: "responses",
          allowedEnvNames: ["OPENAI_API_KEY"],
        },
      },
    });
    const work = workStore.createOrReuseWork({
      principalId: "alice",
      scope: "team",
      idempotencyKey: "organization-policy",
      sourceType: "mcp",
      title: "Review",
      description: "Review only",
      workflowId: "investigation",
      expertId: "reviewer",
      repositoryId: "repo",
      deploymentId: "reviewer-ro",
    });
    const workflow = workStore.getWorkflow(work.workflowId, work.workflowVersion);
    const provider = new StaticWorkDagOrganizationPolicyProvider({
      ref: "organization:restricted@7",
      allowedNodeKinds: ["agent", "verification", "review", "approval", "wait"],
    });
    const context = new WorkDagPolicyContextResolver(
      workStore,
      new ExpertDispatchService(experts, tasks),
      experts,
      tasks,
      [],
      provider,
    ).resolve(work, workflow);
    assert.equal(context.organization.ref, "organization:restricted@7");
    assert.ok(context.organization.digest.length > 20);
    assert.equal(context.organization.allowedNodeKinds.includes("publication"), false);

    const envProvider = createWorkDagOrganizationPolicyProviderFromEnv({
      WORK_DAG_ORGANIZATION_POLICY_REF: "organization:env@2",
      WORK_DAG_ORGANIZATION_ALLOWED_NODE_KINDS: "agent,review,wait",
    });
    const envPolicy = envProvider.resolve(work);
    assert.equal(envPolicy.ref, "organization:env@2");
    assert.deepEqual(envPolicy.allowedNodeKinds, ["agent", "review", "wait"]);
    assert.ok(envPolicy.digest.length > 20);
  } finally {
    workStore.close();
    tasks.close();
    experts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
