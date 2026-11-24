import type { ExpertTaskStore, TaskRecord, TaskRunTurnRecord } from "./task-store.js";
import type {
  ReviewDecisionRecord,
  WorkAttemptRecord,
  WorkItemRecord,
  WorkOrchestrationStore,
} from "./work-orchestration-store.js";
import type { WorkPublicationRecord, WorkPublicationStore } from "./work-publication-store.js";
import type { WorkChangeRequestRecord, WorkChangeRequestStore } from "./work-change-request-store.js";
import {
  projectShadowDag,
  reconcileShadowDag,
  type ShadowDagProjection,
  type ShadowObservationSource,
  type ShadowSource,
} from "./work-dag-shadow.js";
import type { DagState } from "./work-dag.js";

type WorkReader = Pick<
  WorkOrchestrationStore,
  "getWorkInternal" | "listAttempts" | "listReviewDecisions" | "saveShadowDag" | "getShadowDag"
>;
type TaskReader = Pick<ExpertTaskStore, "get" | "listRunTurns">;
type PublicationReader = Pick<WorkPublicationStore, "listPublications">;
type ChangeRequestReader = Pick<WorkChangeRequestStore, "getByPublication">;

function taskState(status: TaskRecord["status"]): DagState {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function turnState(status: TaskRunTurnRecord["status"]): DagState {
  return status === "running" ? "running" : status;
}

function publicationState(state: WorkPublicationRecord["state"]): DagState {
  switch (state) {
    case "preparing":
    case "pushing":
      return "running";
    case "pushed":
      return "succeeded";
    case "failed":
    case "blocked":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "prepared":
    case "approved":
      return "pending";
  }
}

function changeRequestState(state: WorkChangeRequestRecord["state"]): DagState {
  switch (state) {
    case "pending":
      return "pending";
    case "creating":
      return "running";
    case "created":
      return "succeeded";
    case "blocked":
      return "failed";
  }
}

function reviewState(decision: ReviewDecisionRecord["decision"]): DagState {
  return decision === "accepted" ? "succeeded" : "failed";
}

function attemptSource(attempt: WorkAttemptRecord) {
  return {
    id: attempt.workAttemptId,
    parent: attempt.parentWorkAttemptId,
    status: attempt.status,
    deployment: attempt.deploymentId + "@" + attempt.deploymentConfigVersion,
    workspace: attempt.workspaceId,
  };
}

export class WorkDagShadowProjector {
  constructor(
    private readonly works: WorkReader,
    private readonly tasks: TaskReader,
    private readonly publications?: PublicationReader,
    private readonly changeRequests?: ChangeRequestReader,
  ) {}

  readSource(workItemId: string): ShadowSource {
    const work = this.works.getWorkInternal(workItemId);
    const attempts = [...this.works.listAttempts(workItemId)].sort((a, b) => a.sequence - b.sequence);
    const observations: ShadowObservationSource[] = [];
    let predecessor: string | null = null;

    const append = (observation: Omit<ShadowObservationSource, "predecessorIds">, predecessorId = predecessor) => {
      observations.push({
        ...observation,
        predecessorIds: predecessorId ? [predecessorId] : [],
      });
      predecessor = observation.id;
    };

    for (const attempt of attempts) {
      if (attempt.taskId) {
        const task = this.tasks.get(attempt.taskId, work.principalId, work.scope);
        const turns = this.tasks.listRunTurns(task.taskId, work.principalId, work.scope);
        if (turns.length > 0) {
          for (const turn of turns) {
            append({
              id: `agent:${task.taskId}:${turn.runId}:${turn.turnIndex}`,
              attemptId: attempt.workAttemptId,
              kind: "agent",
              state: turnState(turn.status),
              subject: task.workspaceChangeSummary
                ? "workspace:" + task.workspaceChangeSummary.contentRevision
                : (task.commitSha ?? null),
            });
          }
        } else {
          append({
            id: "agent:" + task.taskId,
            attemptId: attempt.workAttemptId,
            kind: "agent",
            state: taskState(task.status),
            subject: task.workspaceChangeSummary
              ? "workspace:" + task.workspaceChangeSummary.contentRevision
              : (task.commitSha ?? null),
          });
        }

        for (const verification of task.verificationResults) {
          append({
            id: "verification:" + task.taskId + ":" + verification.stepId + ":" + verification.subjectRevision,
            attemptId: attempt.workAttemptId,
            kind: "verification",
            state: verification.status === "passed" ? "succeeded" : "failed",
            subject: verification.subjectRevision,
          });
        }
      }

      if (attempt.reviewTaskId) {
        const reviewTask = this.tasks.get(attempt.reviewTaskId, work.principalId, work.scope);
        const turns = this.tasks.listRunTurns(reviewTask.taskId, work.principalId, work.scope);
        if (turns.length > 0) {
          for (const turn of turns) {
            append({
              id: `review:${reviewTask.taskId}:${turn.runId}:${turn.turnIndex}`,
              attemptId: attempt.workAttemptId,
              kind: "review",
              state: turnState(turn.status),
              subject: work.currentSubjectRevision,
            });
          }
        } else {
          append({
            id: "review:" + reviewTask.taskId,
            attemptId: attempt.workAttemptId,
            kind: "review",
            state: taskState(reviewTask.status),
            subject: work.currentSubjectRevision,
          });
        }
      }
    }

    for (const review of this.works.listReviewDecisions(workItemId)) {
      append({
        id: "review-decision:" + review.reviewDecisionId,
        attemptId: attempts.at(-1)?.workAttemptId ?? "work:" + workItemId,
        kind: "review",
        state: reviewState(review.decision),
        subject: review.subjectRevision,
      });
    }

    for (const publication of this.publications?.listPublications(workItemId) ?? []) {
      append({
        id: "publication:" + publication.publicationId,
        attemptId: publication.workAttemptId,
        kind: "publication",
        state: publicationState(publication.state),
        subject: publication.sourceSubjectRevision,
      });
      const request = this.changeRequests?.getByPublication(publication.publicationId);
      if (request) {
        append({
          id: "change-request:" + request.changeRequestId,
          attemptId: request.workAttemptId,
          kind: "change_request",
          state: changeRequestState(request.state),
          subject: "publication:" + publication.publicationId + ":" + request.headCommit,
        });
      }
    }

    return {
      workItemId: work.workItemId,
      stateRevision: work.stateRevision,
      subject: work.currentSubjectRevision,
      status: work.status,
      workflow: work.workflowId + "@" + work.workflowVersion,
      attempts: attempts.map(attemptSource),
      observations,
    };
  }

  project(workItemId: string): ShadowDagProjection {
    return projectShadowDag(this.readSource(workItemId));
  }

  reconcile(workItemId: string, now = Date.now()): ShadowDagProjection | null {
    return reconcileShadowDag(this.works, () => this.readSource(workItemId), now);
  }
}
