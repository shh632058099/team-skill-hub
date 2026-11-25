import type { WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { WorkPublicationRecord, WorkPublicationStore } from "./work-publication-store.js";
import type { WorkChangeRequestRecord, WorkChangeRequestStore } from "./work-change-request-store.js";
import type { DagDeferredExecution, WorkDagExecutionContext, WorkDagExecutorAdapter } from "./work-dag-engine.js";
import type { DagNodeResult } from "./work-dag-runtime.js";

export interface WorkDagDeliveryTarget {
  resourceKey: string;
  repositoryId: string | null;
  subjectRevision: string | null;
}

function deliveryTarget(context: WorkDagExecutionContext): WorkDagDeliveryTarget {
  const resourceKey = context.node.resource ?? "workspace";
  const repositoryId = resourceKey.startsWith("repo:")
    ? resourceKey.slice("repo:".length).trim() || null
    : context.work.repositoryId;
  return {
    resourceKey,
    repositoryId,
    subjectRevision: context.node.subject,
  };
}

export interface WorkDagDeliveryGateway {
  ensurePublication(
    workItemId: string,
    principalId: string,
    scope: string,
    now?: number,
    target?: WorkDagDeliveryTarget,
  ): WorkPublicationRecord;
  recordPreparedPublicationArtifact(
    workItemId: string,
    principalId: string,
    scope: string,
    publicationId: string,
    now?: number,
    target?: WorkDagDeliveryTarget,
  ): unknown;
  ensureChangeRequest(
    workItemId: string,
    principalId: string,
    scope: string,
    now?: number,
    target?: WorkDagDeliveryTarget,
  ): WorkChangeRequestRecord;
}
type PublicationReader = Pick<
  WorkPublicationStore,
  "listPublications" | "getPublication" | "getPublicationArtifact" | "transitionPublication"
>;
type ChangeRequestReader = Pick<WorkChangeRequestStore, "getByPublication">;

function currentPublication(
  publications: PublicationReader,
  workItemId: string,
  target: WorkDagDeliveryTarget,
): WorkPublicationRecord | null {
  return (
    publications
      .listPublications(workItemId)
      .filter(
        (item) =>
          item.sourceSubjectRevision === target.subjectRevision &&
          (target.repositoryId === null || item.repositoryId === target.repositoryId),
      )
      .at(-1) ?? null
  );
}
class PublicationDagAdapter implements WorkDagExecutorAdapter {
  readonly kind = "publication" as const;

  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly publications: PublicationReader,
    private readonly gateway: WorkDagDeliveryGateway,
  ) {}

  correlationRef(context: WorkDagExecutionContext): string {
    const target = deliveryTarget(context);
    return [
      "publication-key",
      context.work.workItemId,
      context.node.capability,
      target.resourceKey,
      target.subjectRevision ?? "missing",
    ].join(":");
  }
  private maybeApprovePush(
    context: WorkDagExecutionContext,
    publication: WorkPublicationRecord,
    now: number,
  ): WorkPublicationRecord | DagNodeResult {
    if (publication.state !== "prepared") return publication;
    const workflow = this.store.getWorkflow(context.work.workflowId, context.work.workflowVersion);
    if (workflow.definition.publication?.approvalRequired === false) {
      return this.publications.transitionPublication(publication.publicationId, "approved", {}, now);
    }
    if (!publication.commitSha) return publication;
    const subject = "publication:" + publication.publicationId + ":" + publication.commitSha;
    const approval = this.store
      .listApprovals(context.work.workItemId)
      .filter(
        (item) =>
          !item.stale &&
          item.approvalScope === "publish_work_branch" &&
          item.subjectType === "publication_artifact" &&
          item.subjectRevision === subject,
      )
      .at(-1);
    if (!approval) return publication;
    if (approval.decision === "rejected") {
      return { status: "failed", summary: "PUBLICATION_APPROVAL_REJECTED" };
    }
    return this.publications.transitionPublication(publication.publicationId, "approved", {}, now);
  }

  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution | DagNodeResult> {
    if (context.node.capability !== "prepare" && context.node.capability !== "push") {
      return { status: "failed", summary: "PUBLICATION_CAPABILITY_UNSUPPORTED" };
    }
    const target = deliveryTarget(context);
    let publication =
      currentPublication(this.publications, context.work.workItemId, target) ??
      this.gateway.ensurePublication(
        context.work.workItemId,
        context.work.principalId,
        context.work.scope,
        Date.now(),
        target,
      );
    if (context.node.capability === "push") {
      const advanced = this.maybeApprovePush(context, publication, Date.now());
      if ("status" in advanced) return advanced;
      publication = advanced;
    }
    return {
      kind: "deferred",
      externalRef: context.execution.externalRef ?? this.correlationRef(context),
    };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    const target = deliveryTarget(context);
    let publication = currentPublication(this.publications, context.work.workItemId, target);
    if (!publication) return null;
    if (publication.state === "blocked" || publication.state === "failed" || publication.state === "cancelled") {
      return {
        status: "failed",
        summary: publication.lastErrorCode ?? "PUBLICATION_FAILED",
      };
    }

    if (context.node.capability === "prepare") {
      if (!["prepared", "approved", "pushing", "pushed"].includes(publication.state)) return null;
      const artifact = this.publications.getPublicationArtifact(publication.publicationId);
      if (!artifact) return null;
      this.gateway.recordPreparedPublicationArtifact(
        context.work.workItemId,
        context.work.principalId,
        context.work.scope,
        publication.publicationId,
        Date.now(),
        target,
      );
      return {
        status: "succeeded",
        summary: "Publication artifact prepared",
        facts: [{ key: "publication.prepared", value: true }],
        artifacts: [
          {
            artifactId: artifact.artifactId,
            type: "git_commit",
            ref: artifact.artifactId,
            subjectRevision: publication.sourceSubjectRevision,
            resourceIdentity: target.resourceKey,
          },
        ],
      };
    }

    if (context.node.capability !== "push") {
      return { status: "failed", summary: "PUBLICATION_CAPABILITY_UNSUPPORTED" };
    }
    const advanced = this.maybeApprovePush(context, publication, Date.now());
    if ("status" in advanced) return advanced;
    publication = advanced;
    if (publication.state !== "pushed" || !publication.commitSha || !publication.artifactRef) return null;
    const subject = "publication:" + publication.publicationId + ":" + publication.commitSha;
    return {
      status: "succeeded",
      summary: "Publication pushed",
      facts: [{ key: "publication.succeeded", value: true }],
      evidence: [
        {
          type: "publication",
          passed: true,
          subjectRevision: subject,
          verifierIdentity: "team-skill-hub-publication",
          artifactRef: publication.artifactRef,
          resourceIdentity: target.resourceKey,
        },
      ],
    };
  }
}

class ChangeRequestDagAdapter implements WorkDagExecutorAdapter {
  readonly kind = "change_request" as const;

  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly publications: PublicationReader,
    private readonly requests: ChangeRequestReader,
    private readonly gateway: WorkDagDeliveryGateway,
  ) {}

  correlationRef(context: WorkDagExecutionContext): string {
    const target = deliveryTarget(context);
    return [
      "change-request-key",
      context.work.workItemId,
      target.resourceKey,
      target.subjectRevision ?? "missing",
    ].join(":");
  }
  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution | DagNodeResult> {
    if (context.node.capability !== "create") {
      return { status: "failed", summary: "CHANGE_REQUEST_CAPABILITY_UNSUPPORTED" };
    }
    const target = deliveryTarget(context);
    this.gateway.ensureChangeRequest(
      context.work.workItemId,
      context.work.principalId,
      context.work.scope,
      Date.now(),
      target,
    );
    return { kind: "deferred", externalRef: context.execution.externalRef ?? this.correlationRef(context) };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    const target = deliveryTarget(context);
    const publication = currentPublication(this.publications, context.work.workItemId, target);
    if (!publication) return null;
    const request = this.requests.getByPublication(publication.publicationId);
    if (!request) return null;
    if (request.state === "blocked") {
      return { status: "failed", summary: request.lastErrorCode ?? "CHANGE_REQUEST_CREATE_FAILED" };
    }
    if (request.state !== "created" || !request.provider || !request.externalId || !request.url) return null;
    return {
      status: "succeeded",
      summary: request.url,
      facts: [{ key: "change_request.created", value: true }],
      artifacts: [
        {
          artifactId: "change-request:" + request.provider + ":" + request.externalId,
          type: "change_request",
          ref: request.url,
          subjectRevision:
            publication.commitSha === null
              ? publication.sourceSubjectRevision
              : "publication:" + publication.publicationId + ":" + publication.commitSha,
          resourceIdentity: target.resourceKey,
        },
      ],
    };
  }
}

export function createDeliveryDagAdapters(
  store: WorkOrchestrationStore,
  publications: PublicationReader | undefined,
  requests: ChangeRequestReader | undefined,
  gateway: WorkDagDeliveryGateway,
): WorkDagExecutorAdapter[] {
  const result: WorkDagExecutorAdapter[] = [];
  if (publications) result.push(new PublicationDagAdapter(store, publications, gateway));
  if (publications && requests) result.push(new ChangeRequestDagAdapter(store, publications, requests, gateway));
  return result;
}
