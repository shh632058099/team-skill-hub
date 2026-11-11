import type { WorkItemRecord, WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { SubmitWorkInput, WorkDetail, WorkOrchestrator } from "./work-orchestrator.js";

export interface WorkSourceIdentity {
  sourceType: string;
  sourceScope: string;
  sourceRef: string;
  sourceUrl?: string;
}

export interface NormalizedWorkSourceObservation {
  state: "active" | "terminal";
  detail?: string;
  fingerprint: string;
}

export interface NormalizedWorkSourceSubmission extends Omit<
  SubmitWorkInput,
  "principalId" | "scope" | "sourceType" | "sourceScope" | "sourceRef" | "sourceUrl"
> {
  identity: WorkSourceIdentity;
  observation: NormalizedWorkSourceObservation;
}

export interface NormalizedWorkSourceSignal extends NormalizedWorkSourceObservation {
  identity: WorkSourceIdentity;
}

export interface WorkSourceActor {
  principalId: string;
  scope: string;
}

export interface WorkSourceAdapter<TSubmit, TSignal, TContext> {
  normalizeSubmission(input: TSubmit, context: TContext, now: number): NormalizedWorkSourceSubmission;
  normalizeSignal(work: WorkItemRecord, input: TSignal, context: TContext, now: number): NormalizedWorkSourceSignal;
}

function sameIdentity(work: WorkItemRecord, identity: WorkSourceIdentity): boolean {
  return (
    work.sourceType === identity.sourceType &&
    work.sourceScope === identity.sourceScope &&
    work.sourceRef === identity.sourceRef &&
    (identity.sourceUrl === undefined || work.sourceUrl === identity.sourceUrl)
  );
}

export class WorkSourceIngestion {
  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly orchestrator: WorkOrchestrator,
  ) {}

  submit<TSubmit, TSignal, TContext>(
    adapter: WorkSourceAdapter<TSubmit, TSignal, TContext>,
    input: TSubmit,
    context: TContext,
    actor: WorkSourceActor,
    now = Date.now(),
  ): WorkDetail {
    const normalized = adapter.normalizeSubmission(input, context, now);
    const staged = this.orchestrator.stageWork(
      {
        ...normalized,
        principalId: actor.principalId,
        scope: actor.scope,
        sourceType: normalized.identity.sourceType,
        sourceScope: normalized.identity.sourceScope,
        sourceRef: normalized.identity.sourceRef,
        ...(normalized.identity.sourceUrl === undefined ? {} : { sourceUrl: normalized.identity.sourceUrl }),
      },
      now,
    );
    if (!sameIdentity(staged.work, normalized.identity)) throw new Error("SOURCE_ADAPTER_IDENTITY_MISMATCH");
    const observation = this.store.recordSourceObservation(
      {
        workItemId: staged.work.workItemId,
        sourceType: normalized.identity.sourceType,
        sourceScope: normalized.identity.sourceScope,
        sourceRef: normalized.identity.sourceRef,
        state: normalized.observation.state,
        ...(normalized.observation.detail === undefined ? {} : { detail: normalized.observation.detail }),
        fingerprint: normalized.observation.fingerprint,
        observedAt: now,
      },
      now,
    );
    const sourceReconciled = this.orchestrator.reconcileSourceObservation(
      observation.observationId,
      actor.principalId,
      actor.scope,
      now,
    );
    if (["completed", "failed", "cancelled"].includes(sourceReconciled.work.status)) return sourceReconciled;
    return this.orchestrator.reconcileWork(sourceReconciled.work.workItemId, actor.principalId, actor.scope, now);
  }

  update<TSubmit, TSignal, TContext>(
    adapter: WorkSourceAdapter<TSubmit, TSignal, TContext>,
    workItemId: string,
    input: TSignal,
    context: TContext,
    actor: WorkSourceActor,
    now = Date.now(),
  ): WorkDetail {
    const work = this.store.getWork(workItemId, actor.principalId, actor.scope);
    const normalized = adapter.normalizeSignal(work, input, context, now);
    if (!sameIdentity(work, normalized.identity)) throw new Error("SOURCE_ADAPTER_IDENTITY_MISMATCH");
    const observation = this.store.recordSourceObservation(
      {
        workItemId,
        sourceType: normalized.identity.sourceType,
        sourceScope: normalized.identity.sourceScope,
        sourceRef: normalized.identity.sourceRef,
        state: normalized.state,
        ...(normalized.detail === undefined ? {} : { detail: normalized.detail }),
        fingerprint: normalized.fingerprint,
        observedAt: now,
      },
      now,
    );
    return this.orchestrator.reconcileSourceObservation(observation.observationId, actor.principalId, actor.scope, now);
  }
}
