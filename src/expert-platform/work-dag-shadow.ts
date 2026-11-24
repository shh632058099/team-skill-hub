import type { WorkStatus } from "./work-orchestration-store.js";
import { stableDigest, validateGraph, type DagGraph, type DagKind, type DagState } from "./work-dag.js";

export interface ShadowAttemptSource {
  id: string;
  parent: string | null;
  status: string;
  deployment: string;
  workspace: string | null;
}

export interface ShadowObservationSource {
  id: string;
  attemptId: string;
  kind: DagKind;
  state: DagState;
  subject: string | null;
  predecessorIds: string[];
}

export interface ShadowSource {
  workItemId: string;
  stateRevision: number;
  subject: string | null;
  status: WorkStatus;
  workflow: string;
  attempts: ShadowAttemptSource[];
  observations: ShadowObservationSource[];
}

export interface ShadowDagNode {
  id: string;
  attemptId: string;
  kind: DagKind;
  state: DagState;
  subject: string | null;
}

export interface ShadowDagProjection {
  mode: "shadow";
  workItemId: string;
  stateRevision: number;
  sourceDigest: string;
  semanticDigest: string;
  graph: DagGraph;
  nodes: ShadowDagNode[];
}

function semanticSource(source: ShadowSource): Omit<ShadowSource, "stateRevision"> {
  const { stateRevision: _ignored, ...semantic } = source;
  return semantic;
}

export function projectShadowDag(source: ShadowSource): ShadowDagProjection {
  if (!source.workItemId || !Number.isSafeInteger(source.stateRevision) || source.stateRevision < 1) {
    throw new Error("DAG_SHADOW_INVALID_SOURCE");
  }
  const observations = [...source.observations].sort((a, b) => a.id.localeCompare(b.id));
  const graph: DagGraph = {
    nodes: observations.map((item) => ({
      id: item.id,
      kind: item.kind,
      capability: item.kind,
      subject: item.subject,
      resource: item.attemptId,
      mutates: false,
      requirements: [],
    })),
    edges: observations.flatMap((item) =>
      [...new Set(item.predecessorIds)].sort().map((predecessor) => ({
        from: predecessor,
        to: item.id,
      })),
    ),
  };
  validateGraph(graph);
  return {
    mode: "shadow",
    workItemId: source.workItemId,
    stateRevision: source.stateRevision,
    sourceDigest: stableDigest(source),
    semanticDigest: stableDigest(semanticSource(source)),
    graph,
    nodes: observations.map((item) => ({
      id: item.id,
      attemptId: item.attemptId,
      kind: item.kind,
      state: item.state,
      subject: item.subject,
    })),
  };
}

export interface ShadowProjectionStore {
  getShadowDag(workItemId: string): ShadowDagProjection | null;
  saveShadowDag(projection: ShadowDagProjection, now?: number): boolean;
}

export function reconcileShadowDag(
  store: ShadowProjectionStore,
  readAuthoritativeSource: () => ShadowSource,
  now = Date.now(),
): ShadowDagProjection | null {
  const first = readAuthoritativeSource();
  const projected = projectShadowDag(first);
  const second = readAuthoritativeSource();
  if (stableDigest(first) !== stableDigest(second)) return null;

  const existing = store.getShadowDag(first.workItemId);
  if (
    existing &&
    existing.sourceDigest === projected.sourceDigest &&
    existing.semanticDigest === projected.semanticDigest &&
    stableDigest(existing) === stableDigest(projected)
  ) {
    return existing;
  }
  return store.saveShadowDag(projected, now) ? projected : null;
}
