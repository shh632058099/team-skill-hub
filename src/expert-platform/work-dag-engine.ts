import type { WorkItemRecord, WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { DagGraph, DagKind, DagNode } from "./work-dag.js";
import type { DagNodeResult, WorkDagNodeExecutionRecord, WorkDagProposalRecord } from "./work-dag-runtime.js";

export interface WorkDagPlannerContext {
  work: Pick<
    WorkItemRecord,
    | "workItemId"
    | "title"
    | "description"
    | "status"
    | "workflowId"
    | "workflowVersion"
    | "currentSubjectRevision"
    | "repositoryId"
    | "activeWorkAttemptId"
  >;
  workflow: ReturnType<WorkOrchestrationStore["getWorkflow"]>;
  runtime: ReturnType<WorkOrchestrationStore["getDagContext"]>;
  frozen: ReturnType<WorkOrchestrationStore["getDagPlannerInput"]>["frozen"];
  frozenDigest: string;
  digest: string;
  currentGraph: DagGraph | null;
  obligations: ReturnType<WorkOrchestrationStore["getEffectiveDagObligations"]>;
  executions: ReturnType<WorkOrchestrationStore["listDagExecutions"]>;
  facts: ReturnType<WorkOrchestrationStore["listDagFacts"]>;
  evidence: ReturnType<WorkOrchestrationStore["listDagEvidence"]>;
  artifacts: ReturnType<WorkOrchestrationStore["listDagArtifacts"]>;
}

export interface WorkDagPlanner {
  identity: string;
  version: string;
  propose(input: WorkDagPlannerContext, reasonCode: string, signal?: AbortSignal): Promise<DagGraph>;
}

function boundedErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "PLANNER_FAILED";
  const code = error.message.trim().split(/[:\s]/, 1)[0] ?? "";
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "PLANNER_FAILED";
}

export class WorkDagPlannerCoordinator {
  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly planner: WorkDagPlanner,
    private readonly plannerTimeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(plannerTimeoutMs) || plannerTimeoutMs < 1 || plannerTimeoutMs > 10 * 60_000) {
      throw new Error("INVALID_PLANNER_TIMEOUT");
    }
  }
  async replan(
    workItemId: string,
    principalId: string,
    scope: string,
    reasonCode: string,
    now = Date.now(),
  ): Promise<WorkDagProposalRecord | null> {
    const work = this.store.getWork(workItemId, principalId, scope);
    const input = this.store.getDagPlannerInput(workItemId);
    const context: WorkDagPlannerContext = {
      work: {
        workItemId: work.workItemId,
        title: work.title,
        description: work.description,
        status: work.status,
        workflowId: work.workflowId,
        workflowVersion: work.workflowVersion,
        currentSubjectRevision: work.currentSubjectRevision,
        repositoryId: work.repositoryId,
        activeWorkAttemptId: work.activeWorkAttemptId,
      },
      frozen: input.frozen,
      workflow: this.store.getWorkflow(work.workflowId, work.workflowVersion),
      runtime: this.store.getDagContext(workItemId),
      frozenDigest: input.digest,
      digest: input.digest,
      currentGraph: input.currentGraph,
      obligations: this.store.getEffectiveDagObligations(workItemId),
      executions: this.store.listDagExecutions(workItemId),
      facts: this.store.listDagFacts(workItemId),
      evidence: this.store.listDagEvidence(workItemId),
      artifacts: this.store.listDagArtifacts(workItemId),
    };

    let graph: DagGraph;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("PLANNER_TIMEOUT"));
          controller.abort();
        }, this.plannerTimeoutMs);
      });
      graph = await Promise.race([this.planner.propose(context, reasonCode, controller.signal), timedOut]);
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      this.store.recordDagPlannerFailure(
        workItemId,
        this.planner.identity,
        this.planner.version,
        reasonCode,
        input.digest,
        boundedErrorCode(error),
        now,
      );
      return null;
    }
    if (timeout) clearTimeout(timeout);
    return this.store.submitDagProposal(
      {
        workItemId,
        principalId,
        scope,
        expectedWorkRevision: input.frozen.workRevision,
        expectedDagRevision: input.frozen.dagRevision,
        expectedRequirementRevision: input.frozen.requirementRevision,
        attemptId: work.activeWorkAttemptId,
        plannerIdentity: this.planner.identity,
        plannerVersion: this.planner.version,
        plannerInputDigest: input.digest,
        reasonCode,
        graph,
      },
      now,
    );
  }
}

export interface WorkDagExecutionContext {
  work: WorkItemRecord;
  node: DagNode;
  execution: WorkDagNodeExecutionRecord;
  dagRevision: number;
  signal: AbortSignal;
}

export interface DagDeferredExecution {
  kind: "deferred";
  externalRef: string;
}

export interface WorkDagExecutorAdapter {
  kind: DagKind;
  capability?: string;
  correlationRef?(context: WorkDagExecutionContext): string | null;
  execute(context: WorkDagExecutionContext): Promise<DagNodeResult | DagDeferredExecution>;
  reconcile?(context: WorkDagExecutionContext): Promise<DagNodeResult | null>;
}

export class DagExternalOutcomeUnknownError extends Error {
  constructor(readonly externalRef: string) {
    super("DAG_EXTERNAL_OUTCOME_UNKNOWN");
    this.name = "DagExternalOutcomeUnknownError";
  }
}

function safeExecutionFailure(error: unknown): string {
  if (!(error instanceof Error)) return "EXECUTION_FAILED";
  const code = error.message.trim().split(/[:\s]/, 1)[0] ?? "";
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : "EXECUTION_FAILED";
}

function isDeferredExecution(result: DagNodeResult | DagDeferredExecution): result is DagDeferredExecution {
  return "kind" in result && result.kind === "deferred";
}

export class WorkDagScheduler {
  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly adapters: readonly WorkDagExecutorAdapter[],
    private readonly claimLeaseMs = 30_000,
  ) {}

  private adapterFor(node: DagNode): WorkDagExecutorAdapter | undefined {
    return this.adapters.find(
      (adapter) =>
        adapter.kind === node.kind && (adapter.capability === undefined || adapter.capability === node.capability),
    );
  }

  async runOne(
    workItemId: string,
    principalId: string,
    scope: string,
    ownerId: string,
    now = Date.now(),
    signal = new AbortController().signal,
  ): Promise<boolean> {
    const work = this.store.getWork(workItemId, principalId, scope);
    if (work.currentDagRevision < 1 || ["completed", "failed", "cancelled", "blocked"].includes(work.status)) {
      return false;
    }
    const evaluation = this.store.evaluateDagCompletion(workItemId);
    const nodeId = evaluation.readyNodeIds[0];
    if (!nodeId) return false;
    const revision = this.store.getDagRevision(workItemId, work.currentDagRevision);
    const node = revision.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error("DAG_NODE_NOT_FOUND");
    const adapter = this.adapterFor(node);
    if (!adapter) throw new Error("DAG_EXECUTOR_NOT_FOUND");

    const claimed = this.store.claimDagNode(
      workItemId,
      principalId,
      scope,
      nodeId,
      ownerId,
      work.stateRevision,
      work.currentDagRevision,
      now,
      this.claimLeaseMs,
    );
    let running = this.store.startDagNodeExecution(claimed.nodeExecutionId, ownerId, claimed.fence, now);
    const baseContext: WorkDagExecutionContext = {
      work: this.store.getWork(workItemId, principalId, scope),
      node,
      execution: running,
      dagRevision: work.currentDagRevision,
      signal,
    };
    const correlationRef = adapter.correlationRef?.(baseContext) ?? null;
    if (correlationRef) {
      running = this.store.setDagExecutionExternalRef(
        running.nodeExecutionId,
        ownerId,
        running.fence,
        correlationRef,
        now,
      );
    }
    let result: DagNodeResult | DagDeferredExecution;
    try {
      result = await adapter.execute({
        ...baseContext,
        execution: running,
      });
    } catch (error) {
      result =
        error instanceof DagExternalOutcomeUnknownError
          ? {
              status: "external_outcome_unknown",
              summary: "External outcome requires reconciliation",
              externalRef: error.externalRef,
            }
          : { status: "failed", summary: safeExecutionFailure(error) };
    }
    if (isDeferredExecution(result)) {
      this.store.setDagExecutionExternalRef(
        running.nodeExecutionId,
        ownerId,
        running.fence,
        result.externalRef,
        Date.now(),
      );
      return true;
    }
    this.store.reconcileDagNodeResult(running.nodeExecutionId, ownerId, running.fence, result, Date.now());
    return true;
  }

  async recoverOne(
    workItemId: string,
    principalId: string,
    scope: string,
    ownerId: string,
    now = Date.now(),
    signal = new AbortController().signal,
  ): Promise<boolean> {
    const work = this.store.getWork(workItemId, principalId, scope);
    if (work.currentDagRevision < 1 || ["completed", "failed", "cancelled", "blocked"].includes(work.status)) {
      return false;
    }
    const revision = this.store.getDagRevision(workItemId, work.currentDagRevision);
    const candidate = this.store
      .listDagExecutions(workItemId)
      .filter(
        (execution) =>
          execution.state === "claimed" && revision.graph.nodes.some((node) => node.id === execution.nodeId),
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!candidate) return false;
    const claimed = this.store.claimDagExecutionForStartRecovery(
      candidate.nodeExecutionId,
      ownerId,
      now,
      this.claimLeaseMs,
    );
    if (!claimed) return false;
    const node = revision.graph.nodes.find((item) => item.id === claimed.nodeId);
    if (!node) return false;
    const adapter = this.adapterFor(node);
    if (!adapter) throw new Error("DAG_EXECUTOR_NOT_FOUND");

    let running = this.store.startDagNodeExecution(claimed.nodeExecutionId, ownerId, claimed.fence, now);
    const baseContext: WorkDagExecutionContext = {
      work: this.store.getWork(workItemId, principalId, scope),
      node,
      execution: running,
      dagRevision: work.currentDagRevision,
      signal,
    };
    const correlationRef = adapter.correlationRef?.(baseContext) ?? null;
    if (correlationRef) {
      running = this.store.setDagExecutionExternalRef(
        running.nodeExecutionId,
        ownerId,
        running.fence,
        correlationRef,
        now,
      );
    }

    let result: DagNodeResult | DagDeferredExecution;
    try {
      result = await adapter.execute({ ...baseContext, execution: running });
    } catch (error) {
      result =
        error instanceof DagExternalOutcomeUnknownError
          ? {
              status: "external_outcome_unknown",
              summary: "External outcome requires reconciliation",
              externalRef: error.externalRef,
            }
          : { status: "failed", summary: safeExecutionFailure(error) };
    }
    if (isDeferredExecution(result)) {
      this.store.setDagExecutionExternalRef(
        running.nodeExecutionId,
        ownerId,
        running.fence,
        result.externalRef,
        Date.now(),
      );
      return true;
    }
    this.store.reconcileDagNodeResult(running.nodeExecutionId, ownerId, running.fence, result, Date.now());
    return true;
  }

  async reconcileOne(
    workItemId: string,
    principalId: string,
    scope: string,
    ownerId: string,
    now = Date.now(),
    signal = new AbortController().signal,
  ): Promise<boolean> {
    const work = this.store.getWork(workItemId, principalId, scope);
    if (work.currentDagRevision < 1 || ["completed", "failed", "cancelled"].includes(work.status)) return false;
    const revision = this.store.getDagRevision(workItemId, work.currentDagRevision);
    const candidates = this.store
      .listDagExecutions(workItemId)
      .filter(
        (execution) =>
          execution.state === "running" &&
          execution.externalRef !== null &&
          revision.graph.nodes.some((node) => node.id === execution.nodeId),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.nodeExecutionId.localeCompare(b.nodeExecutionId));
    for (const candidate of candidates) {
      const running = this.store.claimDagExecutionForReconciliation(
        candidate.nodeExecutionId,
        ownerId,
        now,
        this.claimLeaseMs,
      );
      if (!running) continue;
      const node = revision.graph.nodes.find((item) => item.id === running.nodeId);
      if (!node) continue;
      const adapter = this.adapterFor(node);
      if (!adapter?.reconcile) continue;
      const result = await adapter.reconcile({
        work,
        node,
        execution: running,
        dagRevision: work.currentDagRevision,
        signal,
      });
      if (!result) continue;
      this.store.reconcileDagNodeResult(running.nodeExecutionId, ownerId, running.fence, result, now);
      return true;
    }
    return false;
  }
}
