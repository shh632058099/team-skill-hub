import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExpertDispatchService } from "../src/expert-platform/expert-dispatch-service.js";
import { ExpertStore } from "../src/expert-platform/expert-store.js";
import { ExpertTaskStore } from "../src/expert-platform/task-store.js";
import { WorkOrchestrationStore } from "../src/expert-platform/work-orchestration-store.js";
import { WorkOrchestrator } from "../src/expert-platform/work-orchestrator.js";
import { WorkDagScheduler } from "../src/expert-platform/work-dag-engine.js";
import { createControlDagAdapters } from "../src/expert-platform/work-dag-control-adapters.js";
import { sourceEventResourceIdentity } from "../src/expert-platform/work-dag.js";
import {
  WorkSourceIngestion,
  type NormalizedWorkSourceSignal,
  type NormalizedWorkSourceSubmission,
  type WorkSourceAdapter,
} from "../src/expert-platform/work-source-adapter.js";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-source-adapter-"));
  const db = path.join(dir, "runtime.sqlite");
  const experts = new ExpertStore(db);
  const tasks = new ExpertTaskStore(db);
  const work = new WorkOrchestrationStore(db);
  experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
  experts.putDeployment({
    id: "ota-default",
    expertId: "ota",
    repositoryIds: ["ota-repo"],
    repositories: [],
    principals: ["alice"],
    runtimeProfile: "codex-readonly",
    active: true,
  });
  const orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
  return {
    dir,
    experts,
    tasks,
    work,
    orchestrator,
    ingestion: new WorkSourceIngestion(work, orchestrator),
    close() {
      work.close();
      tasks.close();
      experts.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface DemoSubmit {
  key: string;
}
interface DemoSignal {
  state: "active" | "terminal";
  fingerprint: string;
}
interface DemoContext {
  sourceScope: string;
}

const adapter: WorkSourceAdapter<DemoSubmit, DemoSignal, DemoContext> = {
  normalizeSubmission(input, context): NormalizedWorkSourceSubmission {
    return {
      identity: { sourceType: "demo", sourceScope: context.sourceScope, sourceRef: input.key },
      idempotencyKey: input.key,
      title: "Demo Work",
      description: "provider-neutral source adapter test",
      expertId: "ota",
      deploymentId: "ota-default",
      repositoryId: "ota-repo",
      observation: { state: "active", fingerprint: `active:${input.key}` },
    };
  },
  normalizeSignal(work, input, context): NormalizedWorkSourceSignal {
    return {
      identity: { sourceType: "demo", sourceScope: context.sourceScope, sourceRef: work.sourceRef! },
      state: input.state,
      fingerprint: input.fingerprint,
    };
  },
};

test("provider-neutral source ingestion owns Work creation and observation reconciliation", () => {
  const f = fixture();
  try {
    const detail = f.ingestion.submit(
      adapter,
      { key: "demo-1" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    assert.equal(detail.work.sourceType, "demo");
    assert.equal(detail.work.sourceScope, "scope-a");
    assert.equal(detail.work.sourceRef, "demo-1");
    assert.equal(detail.sourceObservations.length, 1);
    assert.equal(detail.sourceObservations[0]!.reconciliationAction, "noop");
    assert.equal(detail.work.orchestrationEngine, "dynamic-dag");
    assert.equal(detail.work.status, "queued");
    assert.equal(detail.currentTask, null);
    const terminal = f.ingestion.update(
      adapter,
      detail.work.workItemId,
      { state: "terminal", fingerprint: "terminal:demo-1" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      2000,
    );
    assert.equal(terminal.work.status, "cancelled");
    assert.equal(terminal.currentTask, null);
    assert.equal(terminal.sourceObservations.at(-1)!.reconciliationAction, "cancel");
  } finally {
    f.close();
  }
});

test("durable source observation automatically signals a matching source-event DAG wait", async () => {
  const f = fixture();
  try {
    const base = f.work.getWorkflow("investigation").definition;
    f.work.putWorkflow("source-event-wait", 1, {
      ...structuredClone(base),
      validation: { requiredEvidence: [], required: [] },
      review: { required: false },
      change: { mode: "readonly" },
      publication: { required: false, mode: "work_branch", approvalRequired: false },
      completion: { require: ["no_unresolved_blocker"] },
      graph: { mode: "dynamic-dag" },
    });
    const sourceWaitAdapter: WorkSourceAdapter<DemoSubmit, DemoSignal, DemoContext> = {
      ...adapter,
      normalizeSubmission(input, context, now) {
        return {
          ...adapter.normalizeSubmission(input, context, now),
          workflowId: "source-event-wait",
        };
      },
    };
    const detail = f.ingestion.submit(
      sourceWaitAdapter,
      { key: "demo-wait" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    f.work.ensureRequirementSnapshot(detail.work.workItemId, 1001);
    const input = f.work.getDagPlannerInput(detail.work.workItemId);
    const sourceResource = sourceEventResourceIdentity(detail.work.workItemId, "demo", "scope-a", "demo-wait");
    const proposal = f.work.submitDagProposal(
      {
        workItemId: detail.work.workItemId,
        principalId: "alice",
        scope: "team-a",
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        plannerIdentity: "test",
        plannerVersion: "1",
        plannerInputDigest: input.digest,
        reasonCode: "initial",
        graph: {
          nodes: [
            {
              id: "wait-source",
              kind: "wait",
              capability: "source_event",
              subject: null,
              resource: sourceResource,
              mutates: false,
              requirements: [],
            },
          ],
          edges: [],
        },
      },
      1010,
    );
    assert.equal(proposal.status, "accepted", JSON.stringify(proposal.decisionCodes));

    const scheduler = new WorkDagScheduler(f.work, createControlDagAdapters(f.work));
    assert.equal(await scheduler.runOne(detail.work.workItemId, "alice", "team-a", "hub", 1020), true);
    const waiting = f.work.listDagWaits(detail.work.workItemId)[0]!;
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.correlationKey, sourceResource);

    const updated = f.ingestion.update(
      sourceWaitAdapter,
      detail.work.workItemId,
      { state: "active", fingerprint: "active:demo-wait:2" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1100,
    );
    const observation = updated.sourceObservations.at(-1)!;
    const signaled = f.work.listDagWaits(detail.work.workItemId)[0]!;
    assert.equal(signaled.state, "signaled");
    assert.equal(signaled.signalEventId, "source-observation:" + observation.observationId);
    assert.deepEqual(signaled.signalPayload, {
      sourceType: "demo",
      sourceScope: "scope-a",
      sourceRef: "demo-wait",
      state: "active",
      detail: null,
      fingerprint: "active:demo-wait:2",
      observedAt: 1100,
    });
  } finally {
    f.close();
  }
});

test("source ingestion rejects adapter identity drift before recording a signal", () => {
  const f = fixture();
  try {
    const detail = f.ingestion.submit(
      adapter,
      { key: "demo-2" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    assert.throws(
      () =>
        f.ingestion.update(
          adapter,
          detail.work.workItemId,
          { state: "terminal", fingerprint: "terminal:demo-2" },
          { sourceScope: "scope-b" },
          { principalId: "alice", scope: "team-a" },
          2000,
        ),
      /SOURCE_ADAPTER_IDENTITY_MISMATCH/,
    );
    assert.equal(f.work.listSourceObservations(detail.work.workItemId).length, 1);
    assert.equal(f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a").work.status, "queued");
  } finally {
    f.close();
  }
});

test("source ingestion actor and identity override any adapter-supplied routing authority", () => {
  const f = fixture();
  try {
    const malicious: WorkSourceAdapter<DemoSubmit, DemoSignal, DemoContext> = {
      ...adapter,
      normalizeSubmission(input, context) {
        return {
          ...(adapter.normalizeSubmission(input, context, 1000) as any),
          principalId: "mallory",
          scope: "other-team",
          sourceType: "evil",
          sourceScope: "evil-scope",
          sourceRef: "evil-ref",
        } as any;
      },
    };
    const detail = f.ingestion.submit(
      malicious,
      { key: "demo-authority" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    assert.equal(detail.work.principalId, "alice");
    assert.equal(detail.work.scope, "team-a");
    assert.equal(detail.work.sourceType, "demo");
    assert.equal(detail.work.sourceScope, "scope-a");
    assert.equal(detail.work.sourceRef, "demo-authority");
  } finally {
    f.close();
  }
});

test("unreconciled terminal source observation survives reopen and reconciles exactly once", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-source-reopen-"));
  const db = path.join(dir, "runtime.sqlite");
  let experts = new ExpertStore(db);
  let tasks = new ExpertTaskStore(db);
  let work = new WorkOrchestrationStore(db);
  experts.putDefinition({ id: "ota", displayName: "OTA", capabilities: ["ota"], keywords: ["ota"], active: true });
  experts.putDeployment({
    id: "ota-default",
    expertId: "ota",
    repositoryIds: ["ota-repo"],
    repositories: [],
    principals: ["alice"],
    runtimeProfile: "codex-readonly",
    active: true,
  });
  let orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
  const ingestion = new WorkSourceIngestion(work, orchestrator);
  try {
    const detail = ingestion.submit(
      adapter,
      { key: "demo-reopen" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    const terminal = work.recordSourceObservation(
      {
        workItemId: detail.work.workItemId,
        sourceType: "demo",
        sourceScope: "scope-a",
        sourceRef: "demo-reopen",
        state: "terminal",
        fingerprint: "terminal:demo-reopen",
        observedAt: 1500,
      },
      1500,
    );
    assert.equal(terminal.reconciledAt, null);
    work.close();
    tasks.close();
    experts.close();

    experts = new ExpertStore(db);
    tasks = new ExpertTaskStore(db);
    work = new WorkOrchestrationStore(db);
    orchestrator = new WorkOrchestrator(work, tasks, new ExpertDispatchService(experts, tasks));
    const startupProcessed = orchestrator.reconcileStartup(2000, 100);
    assert.ok(startupProcessed.includes(detail.work.workItemId));
    const first = orchestrator.getWork(detail.work.workItemId, "alice", "team-a");
    assert.equal(first.work.status, "cancelled");
    const recorded = work.getSourceObservation(terminal.observationId);
    assert.equal(recorded.reconciliationAction, "cancel");
    assert.equal(recorded.reconciledAt, 2000);
    const allEvents = work.listEvents(detail.work.workItemId, 0, 200).events;
    assert.ok(allEvents.some((event) => event.eventType === "source.observed"));
    const eventsBefore = allEvents.filter((event) => event.eventType === "source.reconciled").length;
    const replay = orchestrator.reconcileSourceObservation(terminal.observationId, "alice", "team-a", 3000);
    assert.equal(replay.work.status, "cancelled");
    assert.equal(work.getSourceObservation(terminal.observationId).reconciledAt, 2000);
    const eventsAfter = work
      .listEvents(detail.work.workItemId, 0, 200)
      .events.filter((event) => event.eventType === "source.reconciled").length;
    assert.equal(eventsAfter, eventsBefore);
  } finally {
    try {
      work.close();
    } catch {}
    try {
      tasks.close();
    } catch {}
    try {
      experts.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source reconciliation respects the durable orchestration claim before changing Work state", () => {
  const f = fixture();
  try {
    const detail = f.ingestion.submit(
      adapter,
      { key: "demo-claimed" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    const terminal = f.work.recordSourceObservation(
      {
        workItemId: detail.work.workItemId,
        sourceType: "demo",
        sourceScope: "scope-a",
        sourceRef: "demo-claimed",
        state: "terminal",
        fingerprint: "terminal:demo-claimed",
        observedAt: 1500,
      },
      1500,
    );
    f.work.claimWorkForOrchestration(detail.work.workItemId, "other-orchestrator", 1600, 1000);
    assert.throws(
      () => f.orchestrator.reconcileSourceObservation(terminal.observationId, "alice", "team-a", 2000),
      /WORK_ORCHESTRATION_CLAIMED/,
    );
    assert.equal(f.work.getSourceObservation(terminal.observationId).reconciledAt, null);
    assert.equal(f.orchestrator.getWork(detail.work.workItemId, "alice", "team-a").work.status, "queued");
    const recovered = f.orchestrator.reconcileSourceObservation(terminal.observationId, "alice", "team-a", 2601);
    assert.equal(recovered.work.status, "cancelled");
    assert.equal(f.work.getSourceObservation(terminal.observationId).reconciliationAction, "cancel");
  } finally {
    f.close();
  }
});

test("source observation is durable and reconciled before any initial dispatch", () => {
  const f = fixture();
  try {
    const terminalOnSubmit: WorkSourceAdapter<DemoSubmit, DemoSignal, DemoContext> = {
      ...adapter,
      normalizeSubmission(input, context) {
        const normalized = adapter.normalizeSubmission(input, context, 1000);
        return {
          ...normalized,
          observation: { state: "terminal", fingerprint: `terminal:${input.key}` },
        };
      },
    };
    const detail = f.ingestion.submit(
      terminalOnSubmit,
      { key: "terminal-before-dispatch" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    assert.equal(detail.work.status, "cancelled");
    assert.equal(detail.attempts.length, 0);
    assert.equal(detail.currentTask, null);
    assert.deepEqual(
      detail.sourceObservations.map((item) => [item.state, item.reconciliationAction]),
      [["terminal", "cancel"]],
    );
    const events = f.work.listEvents(detail.work.workItemId, 0, 100).events.map((event) => event.eventType);
    assert.ok(events.indexOf("source.observed") > events.indexOf("work.created"));
    assert.equal(
      events.some((event) => event.startsWith("work_attempt.")),
      false,
    );
  } finally {
    f.close();
  }
});

test("direct Work reconciliation fences pending terminal source before execution advances", () => {
  const f = fixture();
  try {
    const detail = f.ingestion.submit(
      adapter,
      { key: "pending-before-reconcile" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    const terminal = f.work.recordSourceObservation(
      {
        workItemId: detail.work.workItemId,
        sourceType: "demo",
        sourceScope: "scope-a",
        sourceRef: "pending-before-reconcile",
        state: "terminal",
        fingerprint: "terminal:pending-before-reconcile",
        observedAt: 1500,
      },
      1500,
    );
    assert.equal(terminal.reconciledAt, null);

    const reconciled = f.orchestrator.reconcileWork(detail.work.workItemId, "alice", "team-a", 2000);
    assert.equal(reconciled.work.status, "cancelled");
    assert.equal(reconciled.currentTask, null);
    assert.equal(f.work.getSourceObservation(terminal.observationId).reconciliationAction, "cancel");
  } finally {
    f.close();
  }
});

test("resume fences pending terminal source before a blocked Work can resume", () => {
  const f = fixture();
  try {
    const detail = f.ingestion.submit(
      adapter,
      { key: "pending-before-resume" },
      { sourceScope: "scope-a" },
      { principalId: "alice", scope: "team-a" },
      1000,
    );
    let work = f.work.getWork(detail.work.workItemId, "alice", "team-a");
    work = f.work.blockWork(
      work.workItemId,
      work.principalId,
      work.scope,
      work.stateRevision,
      "permission_required",
      "TEST_BLOCK",
      1200,
      { resumeCondition: "manual", blockedByType: "permission", blockedByRef: "test" },
    );
    const terminal = f.work.recordSourceObservation(
      {
        workItemId: work.workItemId,
        sourceType: "demo",
        sourceScope: "scope-a",
        sourceRef: "pending-before-resume",
        state: "terminal",
        fingerprint: "terminal:pending-before-resume",
        observedAt: 1500,
      },
      1500,
    );

    const resumed = f.orchestrator.resumeWork(work.workItemId, "alice", "team-a", work.stateRevision, 2000);
    assert.equal(resumed.work.status, "cancelled");
    assert.equal(f.work.getSourceObservation(terminal.observationId).reconciliationAction, "cancel");
  } finally {
    f.close();
  }
});
