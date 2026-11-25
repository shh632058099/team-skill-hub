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
  expandResourceEvidenceObligations,
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

test("failure-conditioned edge becomes ready from a failed predecessor without weakening normal success edges", () => {
  const graph = {
    nodes: [node("source"), node("repair"), node("normal")],
    edges: [
      {
        from: "source",
        to: "repair",
        predicate: { kind: "node_result" as const, nodeId: "source", state: "failed" as const },
      },
      { from: "source", to: "normal" },
    ],
  };
  assert.deepEqual(
    readyNodes(graph, [execution("source", "failed")], context)
      .map((item) => item.id)
      .sort(),
    ["repair"],
  );
  assert.deepEqual(
    readyNodes(graph, [execution("source", "succeeded")], context)
      .map((item) => item.id)
      .sort(),
    ["normal"],
  );
});

test("workspace evidence alias matches primary repository evidence", () => {
  const primaryContext: DagContext = {
    subject: "resources:composite",
    primaryResource: "repo:repo",
    resourceSubjects: { "repo:repo": "workspace:primary" },
    facts: {},
    evidence: [
      {
        type: "integration_test",
        subject: "workspace:primary",
        resource: "repo:repo",
        passed: true,
        stale: false,
      },
    ],
    artifacts: [],
    blockers: [],
    cancelled: false,
  };
  assert.equal(
    evaluatePredicate({ kind: "evidence", type: "integration_test" }, primaryContext, [], "workspace"),
    true,
  );
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

test("unknown external outcome blocks only current dependent or same-resource mutation branches", () => {
  const scoped = (id: string, resource: string, mutates: boolean): DagNode => ({
    ...node(id),
    subject: null,
    resource,
    mutates,
  });
  const graph = {
    nodes: [
      scoped("unknown-a", "repo:a", true),
      scoped("safe-read-b", "repo:b", false),
      scoped("safe-write-b", "repo:b", true),
      scoped("same-write-a", "repo:a", true),
      scoped("dependent-b", "repo:b", false),
    ],
    edges: [{ from: "unknown-a", to: "dependent-b" }],
  };
  const executions = [
    execution("unknown-a", "external_outcome_unknown"),
    execution("historical-removed", "external_outcome_unknown"),
  ];
  assert.deepEqual(
    readyNodes(graph, executions, context)
      .map((item) => item.id)
      .sort(),
    ["safe-read-b", "safe-write-b"],
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

test("multi-repository delivery obligations remain resource-bound across replans", () => {
  const graph = {
    nodes: [
      { ...node("a"), resource: "repo:a", mutates: true, subject: null },
      { ...node("b"), resource: "repo:b", mutates: true, subject: null },
    ],
    edges: [],
  };
  const obligations = expandResourceEvidenceObligations(
    [
      {
        id: "publish",
        condition: { kind: "always" as const },
        satisfaction: { kind: "fact" as const, key: "publication.succeeded", equals: true },
      },
      {
        id: "cr",
        condition: { kind: "always" as const },
        satisfaction: { kind: "fact" as const, key: "change_request.created", equals: true },
      },
    ],
    graph,
    ["repo:a", "repo:b"],
  );
  assert.deepEqual(
    obligations.map((item) => [item.id, item.resource, item.satisfaction.kind, (item.satisfaction as any).type]),
    [
      ["publish@repo:a", "repo:a", "evidence", "publication"],
      ["publish@repo:b", "repo:b", "evidence", "publication"],
      ["cr@repo:a", "repo:a", "artifact", "change_request"],
      ["cr@repo:b", "repo:b", "artifact", "change_request"],
    ],
  );

  const resourceContext: DagContext = {
    ...context,
    subject: "resources:composite",
    resourceSubjects: { "repo:a": "workspace:a", "repo:b": "workspace:b" },
    evidence: [
      {
        type: "publication",
        subject: "workspace:a",
        resource: "repo:a",
        passed: true,
        stale: false,
      },
    ],
    artifacts: [
      {
        type: "change_request",
        subject: "workspace:a",
        resource: "repo:a",
      },
    ],
  };
  const partial = completion(obligations, [], resourceContext);
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missing.sort(), ["cr@repo:b", "publish@repo:b"]);

  const complete = completion(obligations, [], {
    ...resourceContext,
    evidence: [
      ...resourceContext.evidence,
      {
        type: "publication",
        subject: "workspace:b",
        resource: "repo:b",
        passed: true,
        stale: false,
      },
    ],
    artifacts: [
      ...resourceContext.artifacts,
      {
        type: "change_request",
        subject: "workspace:b",
        resource: "repo:b",
      },
    ],
  });
  assert.equal(complete.ready, true);
});
