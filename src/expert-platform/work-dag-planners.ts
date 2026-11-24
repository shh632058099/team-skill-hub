import { evaluatePredicate, validateGraph, type DagExecution, type DagGraph, type DagNode } from "./work-dag.js";
import type { WorkDagPlanner, WorkDagPlannerContext } from "./work-dag-engine.js";

function currentExecutions(input: WorkDagPlannerContext): DagExecution[] {
  return input.executions.map((execution) => ({
    nodeId: execution.nodeId,
    generation: execution.generation,
    state: execution.state,
    fence: execution.fence,
    key: execution.idempotencyKey,
  }));
}

function outstandingObligations(input: WorkDagPlannerContext) {
  const executions = currentExecutions(input);
  return input.obligations.filter((obligation) => {
    const condition = evaluatePredicate(obligation.condition, input.runtime, executions);
    if (condition === false) return false;
    return evaluatePredicate(obligation.satisfaction, input.runtime, executions) !== true;
  });
}

export class WorkDagSeedPlanner implements WorkDagPlanner {
  readonly identity = "team-skill-hub-seed-planner";
  readonly version = "1";

  async propose(input: WorkDagPlannerContext, reasonCode: string): Promise<DagGraph> {
    const outstanding = outstandingObligations(input);
    const revision = input.frozen.dagRevision + 1;
    let sequence = 0;
    const nodes: DagNode[] = [];
    const edges: DagGraph["edges"] = [];
    let previous: DagNode | null = null;

    const add = (
      kind: DagNode["kind"],
      capability: string,
      options: Partial<Pick<DagNode, "subject" | "resource" | "mutates" | "timeoutMs">> = {},
    ) => {
      const node: DagNode = {
        id: kind + ":r" + revision + ":" + ++sequence,
        kind,
        capability,
        subject: options.subject ?? input.work.currentSubjectRevision,
        resource: options.resource ?? (kind === "approval" || kind === "wait" ? null : "workspace"),
        mutates: options.mutates ?? false,
        requirements: [],
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      };
      nodes.push(node);
      if (previous) edges.push({ from: previous.id, to: node.id });
      previous = node;
      return node;
    };

    const forcedRepair =
      reasonCode === "verification_failure" ||
      reasonCode === "review_rework" ||
      reasonCode === "human_rework" ||
      reasonCode === "new_information";
    const conditionalChange = input.workflow.definition.change?.mode === "conditional_code_change";
    if (conditionalChange && reasonCode === "initial" && !Object.hasOwn(input.runtime.facts, "workspace.changed")) {
      add("review", "review", { subject: input.work.currentSubjectRevision, mutates: false });
      return { nodes, edges };
    }

    const evidenceTypes = new Set<string>();
    let needsReview = false;
    let needsPublication = false;
    let needsChangeRequest = false;
    let needsApproval = false;
    let needsAttempt = false;
    let needsOpenWorldAgent = false;

    for (const obligation of outstanding) {
      switch (obligation.satisfaction.kind) {
        case "evidence":
          evidenceTypes.add(obligation.satisfaction.type);
          break;
        case "fact":
          switch (obligation.satisfaction.key) {
            case "attempt.latest_succeeded":
              needsAttempt = true;
              break;
            case "review.accepted":
              needsReview = true;
              break;
            case "publication.succeeded":
              needsPublication = true;
              break;
            case "change_request.created":
              needsChangeRequest = true;
              break;
            case "approval.required_approved":
              needsApproval = true;
              break;
            default:
              needsOpenWorldAgent = true;
              break;
          }
          break;
        case "artifact":
          if (obligation.satisfaction.type === "git_commit") needsPublication = true;
          else if (obligation.satisfaction.type === "change_request") needsChangeRequest = true;
          else needsOpenWorldAgent = true;
          break;
        case "always":
        case "subject":
        case "no_blocker":
        case "node_result":
          needsOpenWorldAgent = true;
          break;
      }
    }

    const needsExpertResult = evidenceTypes.delete("expert_result");
    evidenceTypes.delete("publication");
    const needsAgent = forcedRepair || needsExpertResult || needsOpenWorldAgent;

    if (needsAgent) {
      add("agent", forcedRepair ? "repair" : "analysis", {
        subject: null,
        mutates: input.workflow.definition.change?.mode === "code_change" || (conditionalChange && forcedRepair),
      }); // An agent may change the subject. Re-plan after its result rather than binding
      // future verification/review nodes to a subject that is no longer current.
      return { nodes, edges };
    }

    for (const evidenceType of [...evidenceTypes].sort()) {
      add("verification", evidenceType, {
        subject: input.work.currentSubjectRevision,
      });
    }

    if (needsReview) {
      add("review", "review", {
        subject: input.work.currentSubjectRevision,
      });
    }

    if (needsPublication) {
      add("publication", "prepare", {
        subject: input.work.currentSubjectRevision,
      });
      if (needsApproval) {
        add("approval", "publish_work_branch", {
          subject: input.work.currentSubjectRevision,
          resource: null,
        });
      }
      add("publication", "push", {
        subject: input.work.currentSubjectRevision,
      });
    } else if (
      needsApproval &&
      input.workflow.definition.completion.requiredApprovals?.some((approval) => approval.scope === "work_completion")
    ) {
      add("approval", "work_completion", {
        subject: input.work.currentSubjectRevision,
        resource: null,
      });
    }

    if (needsChangeRequest) {
      add("change_request", "create", {
        subject: input.work.currentSubjectRevision,
      });
    }

    if (nodes.length === 0 && needsAttempt && !input.work.activeWorkAttemptId) {
      add("agent", "analysis", {
        subject: null,
        mutates: input.workflow.definition.change?.mode === "code_change",
      });
    }

    if (nodes.length === 0 && reasonCode === "initial" && input.work.description.trim().length > 0) {
      add("agent", "analysis", {
        subject: null,
        mutates: input.workflow.definition.change?.mode === "code_change",
      });
    }

    return { nodes, edges };
  }
}

export interface WorkDagPlannerModel {
  complete(
    input: { system: string; payload: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<string | unknown>;
}

function assertStrictGraphShape(value: unknown): asserts value is DagGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PLANNER_OUTPUT_INVALID");
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== "edges" || keys[1] !== "nodes") {
    throw new Error("PLANNER_OUTPUT_INVALID");
  }
  const graph = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("PLANNER_OUTPUT_INVALID");
  }
  const allowedNodeKeys = new Set([
    "id",
    "kind",
    "capability",
    "subject",
    "resource",
    "mutates",
    "requirements",
    "timeoutMs",
  ]);
  for (const node of graph.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("PLANNER_OUTPUT_INVALID");
    if (Object.keys(node).some((key) => !allowedNodeKeys.has(key))) throw new Error("PLANNER_OUTPUT_INVALID");
  }
  const allowedEdgeKeys = new Set(["from", "to", "predicate"]);
  for (const edge of graph.edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) throw new Error("PLANNER_OUTPUT_INVALID");
    if (Object.keys(edge).some((key) => !allowedEdgeKeys.has(key))) throw new Error("PLANNER_OUTPUT_INVALID");
  }
  try {
    validateGraph(value as DagGraph);
  } catch {
    throw new Error("PLANNER_OUTPUT_INVALID");
  }
}

export class WorkDagJsonPlanner implements WorkDagPlanner {
  constructor(
    private readonly model: WorkDagPlannerModel,
    readonly identity: string,
    readonly version: string,
  ) {}

  async propose(input: WorkDagPlannerContext, reasonCode: string, signal?: AbortSignal): Promise<DagGraph> {
    const response = await this.model.complete(
      {
        system: [
          "Propose a Team Skill Hub Dynamic Runtime DAG as strict JSON.",
          "Return exactly {nodes,edges}; never return commands, prose, permissions, evidence claims, or side effects.",
          "Allowed node kinds: agent, verification, review, approval, publication, change_request, wait.",
          "Logical node IDs are durable identities across revisions: if planned work is retained, keep the exact prior node id and node definition.",
          "Every claimed/running/external-outcome-unknown node in currentGraph must remain present and unchanged; never silently supersede it.",
          "If a pending node's semantics, subject, capability, resource, or mutation intent changes, replace it with a new node id rather than redefining the old id.",
          "Bind verification/review/publication/approval/change_request nodes to the current subject revision. Agent nodes may use subject=null because they may create a new subject.",
          "Never propose two unordered mutating nodes for the same resource.",
          "The platform will independently validate policy, predicates, subject binding, and completion.",
        ].join("\n"),
        payload: {
          reasonCode,
          work: input.work,
          workflow: input.workflow,
          frozen: input.frozen,
          currentGraph: input.currentGraph,
          obligations: input.obligations,
          runtime: input.runtime,
          executions: input.executions,
          facts: input.facts,
          evidence: input.evidence,
          artifacts: input.artifacts,
        },
      },
      signal,
    );
    let parsed: unknown = response;
    if (typeof response === "string") {
      try {
        parsed = JSON.parse(response);
      } catch {
        throw new Error("PLANNER_OUTPUT_INVALID");
      }
    }
    assertStrictGraphShape(parsed);
    return structuredClone(parsed);
  }
}
