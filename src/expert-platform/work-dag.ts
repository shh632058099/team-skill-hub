import { createHash } from "node:crypto";

export type DagScalar = string | number | boolean | null;
export type DagPredicate =
  | { kind: "always" }
  | { kind: "resource_active" }
  | { kind: "fact"; key: string; equals: DagScalar }
  | { kind: "evidence"; type: string }
  | { kind: "artifact"; type: string }
  | { kind: "subject"; revision: string }
  | { kind: "no_blocker" }
  | { kind: "node_result"; nodeId: string; state: "succeeded" | "failed" };
export type DagTruth = boolean | "unknown";
export type DagKind =
  "agent" | "verification" | "review" | "approval" | "publication" | "change_request" | "wait" | "external_action";
export type DagState =
  "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled" | "superseded" | "external_outcome_unknown";
export interface DagNode {
  id: string;
  kind: DagKind;
  capability: string;
  subject: string | null;
  resource: string | null;
  mutates: boolean;
  requirements: DagPredicate[];
  timeoutMs?: number;
}
export interface DagEdge {
  from: string;
  to: string;
  predicate?: DagPredicate;
}
export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
}
export interface DagExecution {
  nodeId: string;
  generation: number;
  state: DagState;
  fence: number;
  key: string;
}
export interface DagContext {
  subject: string | null;
  primaryResource?: string | null;
  resourceSubjects?: Readonly<Record<string, string>>;
  facts: Readonly<Record<string, DagScalar>>;
  factRecords?: ReadonlyArray<{
    key: string;
    value: DagScalar;
    subject: string | null;
    resource?: string | null;
    createdAt?: number;
  }>;
  evidence: ReadonlyArray<{
    type: string;
    subject: string | null;
    resource?: string | null;
    passed: boolean;
    stale: boolean;
    createdAt?: number;
  }>;
  artifacts: ReadonlyArray<{ type: string; subject: string | null; resource?: string | null }>;
  blockers: readonly string[];
  cancelled: boolean;
}
export interface DagObligation {
  id: string;
  condition: DagPredicate;
  satisfaction: DagPredicate;
  resource?: string | null;
}
const kinds = new Set<DagKind>([
  "agent",
  "verification",
  "review",
  "approval",
  "publication",
  "change_request",
  "wait",
  "external_action",
]);

export function stableDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canonical(x)]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function sourceEventResourceIdentity(
  workItemId: string,
  sourceType: string,
  sourceScope: string,
  sourceRef: string,
): string {
  const values = [workItemId, sourceType, sourceScope, sourceRef].map((value) => value.trim());
  if (values.some((value) => !value)) throw new Error("INVALID_SOURCE_EVENT_RESOURCE");
  return "source-event:" + stableDigest(values);
}

export function executionKey(workId: string, node: DagNode, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("DAG_INVALID_GENERATION");
  return stableDigest([workId, node.id, generation, node.kind, node.capability, node.subject, node.resource]);
}

function validatePredicate(p: DagPredicate, ids: Set<string>): void {
  if (!p || typeof p !== "object") throw new Error("DAG_INVALID_PREDICATE");
  const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
  switch (p.kind) {
    case "always":
    case "resource_active":
    case "no_blocker":
      return;
    case "fact":
      if (
        nonempty(p.key) &&
        (p.equals === null ||
          typeof p.equals === "string" ||
          typeof p.equals === "boolean" ||
          (typeof p.equals === "number" && Number.isFinite(p.equals)))
      )
        return;
      break;
    case "evidence":
    case "artifact":
      if (nonempty(p.type)) return;
      break;
    case "subject":
      if (nonempty(p.revision)) return;
      break;
    case "node_result":
      if (ids.has(p.nodeId) && (p.state === "succeeded" || p.state === "failed")) return;
      break;
  }
  throw new Error("DAG_INVALID_PREDICATE");
}

export function validateGraph(graph: DagGraph): void {
  if (
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    graph.nodes.length > 1000 ||
    graph.edges.length > 10000
  )
    throw new Error("DAG_INVALID_SIZE");
  const ids = new Set<string>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (
      !n.id ||
      typeof n.id !== "string" ||
      !kinds.has(n.kind) ||
      typeof n.capability !== "string" ||
      !n.capability ||
      typeof n.mutates !== "boolean" ||
      !Array.isArray(n.requirements) ||
      (n.subject !== null && typeof n.subject !== "string") ||
      (n.resource !== null && typeof n.resource !== "string") ||
      (n.mutates && !n.resource) ||
      (n.timeoutMs !== undefined && (!Number.isSafeInteger(n.timeoutMs) || n.timeoutMs <= 0))
    )
      throw new Error("DAG_INVALID_NODE");
    if (ids.has(n.id)) throw new Error("DAG_DUPLICATE_NODE");
    ids.add(n.id);
    incoming.set(n.id, 0);
    outgoing.set(n.id, []);
  }
  for (const n of graph.nodes) for (const p of n.requirements) validatePredicate(p, ids);
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error("DAG_INVALID_ENDPOINT");
    const key = JSON.stringify([e.from, e.to]);
    if (seen.has(key)) throw new Error("DAG_DUPLICATE_EDGE");
    seen.add(key);
    if (e.predicate !== undefined) validatePredicate(e.predicate, ids);
    incoming.set(e.to, incoming.get(e.to)! + 1);
    outgoing.get(e.from)!.push(e.to);
  }
  const queue = [...ids].filter((id) => incoming.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    for (const child of outgoing.get(queue[i]!)!) {
      const degree = incoming.get(child)! - 1;
      incoming.set(child, degree);
      if (!degree) queue.push(child);
    }
  }
  if (queue.length !== ids.size) throw new Error("DAG_CYCLE");
}

function latestExecutions(executions: readonly DagExecution[]): Map<string, DagExecution> {
  const result = new Map<string, DagExecution>();
  for (const e of executions) {
    const old = result.get(e.nodeId);
    if (!old || old.generation < e.generation) result.set(e.nodeId, e);
  }
  return result;
}

export function canonicalResourceIdentity(resource?: string | null, primaryResource?: string | null): string | null {
  if (resource === "workspace" && primaryResource?.startsWith("repo:")) return primaryResource;
  return resource ?? null;
}

export function subjectForResource(context: DagContext, resource?: string | null): string | null {
  const canonical = canonicalResourceIdentity(resource, context.primaryResource);
  if (canonical && context.resourceSubjects && Object.hasOwn(context.resourceSubjects, canonical)) {
    return context.resourceSubjects[canonical] ?? null;
  }
  if (canonical?.startsWith("repo:")) {
    return canonical === context.primaryResource ? context.subject : null;
  }
  return context.subject;
}

export function evaluatePredicate(
  p: DagPredicate,
  c: DagContext,
  executions: readonly DagExecution[] = [],
  resource?: string | null,
): DagTruth {
  switch (p.kind) {
    case "always":
      return true;
    case "resource_active": {
      const canonical = canonicalResourceIdentity(resource, c.primaryResource);
      if (canonical?.startsWith("repo:")) {
        if (c.resourceSubjects && Object.hasOwn(c.resourceSubjects, canonical)) return true;
        return canonical === c.primaryResource && c.subject !== null;
      }
      if (canonical === "workspace") {
        const explicitRepositories = Object.keys(c.resourceSubjects ?? {}).some((key) => key.startsWith("repo:"));
        return !explicitRepositories && c.subject !== null;
      }
      return c.subject !== null;
    }
    case "fact": {
      const records = c.factRecords?.filter((record) => record.key === p.key) ?? [];
      if (records.length > 0) {
        const targetResource = canonicalResourceIdentity(resource, c.primaryResource);
        const targetSubject = subjectForResource(c, resource);
        const matches = records.filter((record) => {
          const global = record.subject === null && (record.resource ?? null) === null;
          const resourceMatches =
            resource == null || canonicalResourceIdentity(record.resource, c.primaryResource) === targetResource;
          const subjectMatches = record.subject === null || record.subject === targetSubject;
          return global || (resourceMatches && subjectMatches);
        });
        if (!matches.length) return "unknown";
        let latest = matches[0]!;
        for (let index = 1; index < matches.length; index++) {
          const candidate = matches[index]!;
          if ((candidate.createdAt ?? index) >= (latest.createdAt ?? index - 1)) latest = candidate;
        }
        return latest.value === p.equals;
      }
      return Object.hasOwn(c.facts, p.key) ? c.facts[p.key] === p.equals : "unknown";
    }
    case "evidence": {
      const subject = subjectForResource(c, resource);
      const targetResource = canonicalResourceIdentity(resource, c.primaryResource);
      const matches = c.evidence.filter(
        (e) =>
          e.type === p.type &&
          e.subject === subject &&
          !e.stale &&
          (resource == null || canonicalResourceIdentity(e.resource, c.primaryResource) === targetResource),
      );
      if (!matches.length) return "unknown";
      let latest = matches[0]!;
      for (let index = 1; index < matches.length; index++) {
        const candidate = matches[index]!;
        if ((candidate.createdAt ?? index) >= (latest.createdAt ?? index - 1)) latest = candidate;
      }
      return latest.passed;
    }
    case "artifact": {
      const targetResource = canonicalResourceIdentity(resource, c.primaryResource);
      return c.artifacts.some(
        (a) =>
          a.type === p.type &&
          a.subject === subjectForResource(c, resource) &&
          (resource == null || canonicalResourceIdentity(a.resource, c.primaryResource) === targetResource),
      )
        ? true
        : "unknown";
    }
    case "subject":
      return subjectForResource(c, resource) === null ? "unknown" : subjectForResource(c, resource) === p.revision;
    case "no_blocker":
      return c.blockers.length === 0;
    case "node_result": {
      const e = latestExecutions(executions).get(p.nodeId);
      return e && (e.state === "succeeded" || e.state === "failed") ? e.state === p.state : "unknown";
    }
    default:
      return "unknown";
  }
}

function hasDependencyPath(graph: DagGraph, sourceNodeId: string, targetNodeId: string): boolean {
  if (sourceNodeId === targetNodeId) return true;
  const pending = graph.edges.filter((edge) => edge.from === sourceNodeId).map((edge) => edge.to);
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === targetNodeId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of graph.edges) if (edge.from === current) pending.push(edge.to);
  }
  return false;
}

export function readyNodes(graph: DagGraph, executions: readonly DagExecution[], context: DagContext): DagNode[] {
  validateGraph(graph);
  if (context.cancelled || context.blockers.length) return [];
  const latest = latestExecutions(executions);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const unknownCurrent = [...latest.values()].filter(
    (execution) => execution.state === "external_outcome_unknown" && nodesById.has(execution.nodeId),
  );
  const active = [...latest.values()].filter((e) => e.state === "claimed" || e.state === "running");
  return graph.nodes.filter((n) => {
    const state = latest.get(n.id)?.state;
    if (state && state !== "pending") return false;
    if (n.subject !== null && n.subject !== subjectForResource(context, n.resource)) return false;
    if (
      unknownCurrent.some((execution) => {
        const unknownNode = nodesById.get(execution.nodeId);
        if (!unknownNode) return false;
        if (hasDependencyPath(graph, execution.nodeId, n.id)) return true;
        if (!n.mutates) return false;
        return (
          unknownNode.resource === null ||
          canonicalResourceIdentity(unknownNode.resource, context.primaryResource) ===
            canonicalResourceIdentity(n.resource, context.primaryResource)
        );
      })
    ) {
      return false;
    }
    if (
      active.some((e) => {
        const other = graph.nodes.find((x) => x.id === e.nodeId);
        return (
          !other ||
          (canonicalResourceIdentity(other.resource, context.primaryResource) ===
            canonicalResourceIdentity(n.resource, context.primaryResource) &&
            (n.mutates || other.mutates))
        );
      })
    )
      return false;
    return (
      n.requirements.every((p) => evaluatePredicate(p, context, executions, n.resource) === true) &&
      graph.edges
        .filter((e) => e.to === n.id)
        .every((e) => {
          const sourceState = latest.get(e.from)?.state;
          if (e.predicate?.kind === "node_result" && e.predicate.nodeId === e.from) {
            return evaluatePredicate(e.predicate, context, executions, n.resource) === true;
          }
          return (
            sourceState === "succeeded" &&
            (!e.predicate || evaluatePredicate(e.predicate, context, executions, n.resource) === true)
          );
        })
    );
  });
}

export function expandResourceEvidenceObligations(
  obligations: readonly DagObligation[],
  graph: DagGraph,
  retainedResources: readonly string[] = [],
): DagObligation[] {
  const resources = [
    ...new Set([
      ...retainedResources.filter((resource) => resource.startsWith("repo:")),
      ...graph.nodes.filter((node) => node.mutates && node.resource?.startsWith("repo:")).map((node) => node.resource!),
    ]),
  ].sort();
  if (resources.length < 2) return obligations.map((item) => structuredClone(item));
  return obligations.flatMap((obligation) => {
    if (obligation.resource !== undefined) return [structuredClone(obligation)];

    let satisfaction: DagPredicate | null = null;
    if (obligation.satisfaction.kind === "evidence" || obligation.satisfaction.kind === "artifact") {
      satisfaction = structuredClone(obligation.satisfaction);
    } else if (
      obligation.satisfaction.kind === "fact" &&
      obligation.satisfaction.key === "publication.succeeded" &&
      obligation.satisfaction.equals === true
    ) {
      satisfaction = { kind: "evidence", type: "publication" };
    } else if (
      obligation.satisfaction.kind === "fact" &&
      obligation.satisfaction.key === "change_request.created" &&
      obligation.satisfaction.equals === true
    ) {
      satisfaction = { kind: "artifact", type: "change_request" };
    }
    if (!satisfaction) return [structuredClone(obligation)];

    return resources.map((resource) => ({
      ...structuredClone(obligation),
      id: obligation.id + "@" + resource,
      satisfaction: structuredClone(satisfaction),
      resource,
    }));
  });
}
export function completion(
  obligations: readonly DagObligation[],
  currentExecutions: readonly DagExecution[],
  c: DagContext,
): { ready: boolean; missing: string[] } {
  const missing = [...c.blockers];
  if (c.cancelled) missing.push("WORK_CANCELLED");
  for (const e of latestExecutions(currentExecutions).values()) {
    if (e.state !== "succeeded" && e.state !== "superseded")
      missing.push("NODE_" + e.state.toUpperCase() + ":" + e.nodeId);
  }
  for (const o of obligations) {
    const condition = evaluatePredicate(o.condition, c, currentExecutions, o.resource);
    if (
      condition === "unknown" ||
      (condition === true && evaluatePredicate(o.satisfaction, c, currentExecutions, o.resource) !== true)
    )
      missing.push(o.id);
  }
  return { ready: missing.length === 0, missing };
}
