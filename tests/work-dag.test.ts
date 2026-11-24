import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DagNode,
  type DagExecution,
  type DagContext,
  validateGraph,
  readyNodes,
  evaluatePredicate,
  executionKey,
  completion,
} from "../src/expert-platform/work-dag.js";

const node = (id: string, kind: DagNode["kind"] = "agent"): DagNode => ({
  id,
  kind,
  capability: kind,
  subject: "abc",
  resource: "workspace",
  mutates: false,
  requirements: [],
});
const execution = (id: string, state: DagExecution["state"]): DagExecution => ({
  nodeId: id,
  generation: 1,
  state,
  fence: 1,
  key: id,
});
const context: DagContext = { subject: "abc", facts: {}, evidence: [], artifacts: [], blockers: [], cancelled: false };

test("graph validation rejects cycles, unknown endpoints and duplicate logical IDs", () => {
  const a = node("a"),
    b = node("b");
  assert.throws(
    () =>
      validateGraph({
        nodes: [a, b],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    /CYCLE/,
  );
  assert.throws(() => validateGraph({ nodes: [a], edges: [{ from: "a", to: "missing" }] }), /ENDPOINT/);
  assert.throws(() => validateGraph({ nodes: [a, a], edges: [] }), /DUPLICATE/);
});

test("all-join readiness requires reconciled success, true predicates and current subject", () => {
  const graph = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [
      { from: "a", to: "c" },
      { from: "b", to: "c", predicate: { kind: "fact" as const, key: "ok", equals: true } },
    ],
  };
  assert.deepEqual(readyNodes(graph, [execution("a", "succeeded"), execution("b", "failed")], context), []);
  assert.deepEqual(readyNodes(graph, [execution("a", "succeeded"), execution("b", "succeeded")], context), []);
  assert.deepEqual(
    readyNodes(graph, [execution("a", "succeeded"), execution("b", "succeeded")], {
      ...context,
      facts: { ok: true },
    }).map((n) => n.id),
    ["c"],
  );
  assert.deepEqual(readyNodes(graph, [], { ...context, subject: "def" }), []);
  assert.deepEqual(readyNodes(graph, [], { ...context, cancelled: true }), []);
});

test("evidence predicates fail closed on stale or wrong-subject results", () => {
  const predicate = { kind: "evidence" as const, type: "build" };
  assert.equal(evaluatePredicate(predicate, context), "unknown");
  assert.equal(
    evaluatePredicate(predicate, {
      ...context,
      evidence: [{ type: "build", subject: "abc", passed: true, stale: true }],
    }),
    "unknown",
  );
  assert.equal(
    evaluatePredicate(predicate, {
      ...context,
      evidence: [{ type: "build", subject: "def", passed: true, stale: false }],
    }),
    "unknown",
  );
  assert.equal(
    evaluatePredicate(predicate, {
      ...context,
      evidence: [{ type: "build", subject: "abc", passed: true, stale: false }],
    }),
    true,
  );
  assert.equal(
    evaluatePredicate(predicate, {
      ...context,
      evidence: [
        { type: "build", subject: "abc", passed: false, stale: false },
        { type: "build", subject: "abc", passed: true, stale: false },
      ],
    }),
    true,
  );
  assert.equal(
    evaluatePredicate(predicate, {
      ...context,
      evidence: [
        { type: "build", subject: "abc", passed: true, stale: false },
        { type: "build", subject: "abc", passed: false, stale: false },
      ],
    }),
    false,
  );
});

test("execution identity does not depend on plan revision, but changes with generation and resource", () => {
  const a = node("a");
  assert.equal(executionKey("work", a, 1), executionKey("work", { ...a }, 1));
  assert.notEqual(executionKey("work", a, 1), executionKey("work", a, 2));
  assert.notEqual(executionKey("work", a, 1), executionKey("work", { ...a, resource: "other" }, 1));
});

test("completion cannot infer success from an empty DAG or unknown external outcome", () => {
  const obligations = [
    { id: "build", condition: { kind: "always" as const }, satisfaction: { kind: "evidence" as const, type: "build" } },
  ];
  assert.equal(completion(obligations, [], context).ready, false);
  const satisfied = { ...context, evidence: [{ type: "build", subject: "abc", passed: true, stale: false }] };
  assert.equal(completion(obligations, [execution("a", "external_outcome_unknown")], satisfied).ready, false);
  assert.equal(completion(obligations, [execution("a", "failed")], satisfied).ready, false);
  assert.equal(completion(obligations, [], satisfied).ready, true);
});
