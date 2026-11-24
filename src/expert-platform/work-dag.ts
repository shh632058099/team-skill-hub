import { createHash } from "node:crypto";

export type DagScalar = string | number | boolean | null;
export type DagPredicate =
  | { kind: "always" }
  | { kind: "fact"; key: string; equals: DagScalar }
  | { kind: "evidence"; type: string }
  | { kind: "artifact"; type: string }
  | { kind: "subject"; revision: string }
  | { kind: "no_blocker" }
  | { kind: "node_result"; nodeId: string; state: "succeeded" | "failed" };
export type DagTruth = boolean | "unknown";
export type DagKind = "agent" | "verification" | "review" | "approval" | "publication" | "change_request" | "wait";
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
  facts: Readonly<Record<string, DagScalar>>;
  evidence: ReadonlyArray<{
    type: string;
    subject: string | null;
    passed: boolean;
    stale: boolean;
    createdAt?: number;
  }>;
  artifacts: ReadonlyArray<{ type: string; subject: string | null }>;
  blockers: readonly string[];
  cancelled: boolean;
}
export interface DagObligation {
  id: string;
  condition: DagPredicate;
  satisfaction: DagPredicate;
}
const kinds = new Set<DagKind>([
  "agent",
  "verification",
  "review",
  "approval",
  "publication",
  "change_request",
  "wait",
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

export function executionKey(workId: string, node: DagNode, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("DAG_INVALID_GENERATION");
  return stableDigest([workId, node.id, generation, node.kind, node.capability, node.subject, node.resource]);
}

function validatePredicate(p: DagPredicate, ids: Set<string>): void {
  if (!p || typeof p !== "object") throw new Error("DAG_INVALID_PREDICATE");
  const nonempty = (v: unknown) => typeof v === "string" && v.length > 0;
  switch (p.kind) {
    case "always":
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

export function evaluatePredicate(p: DagPredicate, c: DagContext, executions: readonly DagExecution[] = []): DagTruth {
  switch (p.kind) {
    case "always":
      return true;
    case "fact":
      return Object.hasOwn(c.facts, p.key) ? c.facts[p.key] === p.equals : "unknown";
    case "evidence": {
      const matches = c.evidence.filter((e) => e.type === p.type && e.subject === c.subject && !e.stale);
      if (!matches.length) return "unknown";
      let latest = matches[0]!;
      for (let index = 1; index < matches.length; index++) {
        const candidate = matches[index]!;
        if ((candidate.createdAt ?? index) >= (latest.createdAt ?? index - 1)) latest = candidate;
      }
      return latest.passed;
    }
    case "artifact":
      return c.artifacts.some((a) => a.type === p.type && a.subject === c.subject) ? true : "unknown";
    case "subject":
      return c.subject === null ? "unknown" : c.subject === p.revision;
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

export function readyNodes(graph: DagGraph, executions: readonly DagExecution[], context: DagContext): DagNode[] {
  validateGraph(graph);
  if (context.cancelled || context.blockers.length || executions.some((e) => e.state === "external_outcome_unknown"))
    return [];
  const latest = latestExecutions(executions);
  const active = [...latest.values()].filter((e) => e.state === "claimed" || e.state === "running");
  return graph.nodes.filter((n) => {
    const state = latest.get(n.id)?.state;
    if (state && state !== "pending") return false;
    if (n.subject !== null && n.subject !== context.subject) return false;
    if (
      active.some((e) => {
        const other = graph.nodes.find((x) => x.id === e.nodeId);
        return !other || (other.resource === n.resource && (n.mutates || other.mutates));
      })
    )
      return false;
    return (
      n.requirements.every((p) => evaluatePredicate(p, context, executions) === true) &&
      graph.edges
        .filter((e) => e.to === n.id)
        .every(
          (e) =>
            latest.get(e.from)?.state === "succeeded" &&
            (!e.predicate || evaluatePredicate(e.predicate, context, executions) === true),
        )
    );
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
    const condition = evaluatePredicate(o.condition, c, currentExecutions);
    if (
      condition === "unknown" ||
      (condition === true && evaluatePredicate(o.satisfaction, c, currentExecutions) !== true)
    )
      missing.push(o.id);
  }
  return { ready: missing.length === 0, missing };
}
