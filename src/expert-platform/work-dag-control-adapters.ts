import type { WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { WorkPublicationStore } from "./work-publication-store.js";
import type { DagDeferredExecution, WorkDagExecutionContext, WorkDagExecutorAdapter } from "./work-dag-engine.js";
import type { DagNodeResult } from "./work-dag-runtime.js";

type PublicationReader = Pick<WorkPublicationStore, "listPublications">;

interface ApprovalTarget {
  subjectType: "workspace_revision" | "publication_artifact";
  subjectRevision: string;
}

class ApprovalDagAdapter implements WorkDagExecutorAdapter {
  readonly kind = "approval" as const;

  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly publications?: PublicationReader,
  ) {}

  private target(context: WorkDagExecutionContext): ApprovalTarget | null {
    const work = this.store.getWorkInternal(context.work.workItemId);
    if (!work.currentSubjectRevision) return null;

    if (context.node.capability === "work_completion") {
      return {
        subjectType: "workspace_revision",
        subjectRevision: work.currentSubjectRevision,
      };
    }

    if (context.node.capability === "publish_work_branch") {
      const publication = this.publications
        ?.listPublications(work.workItemId)
        .filter(
          (item) =>
            item.sourceSubjectRevision === work.currentSubjectRevision &&
            ["prepared", "approved", "pushing", "pushed"].includes(item.state) &&
            Boolean(item.commitSha),
        )
        .at(-1);
      if (!publication?.commitSha) return null;
      return {
        subjectType: "publication_artifact",
        subjectRevision: "publication:" + publication.publicationId + ":" + publication.commitSha,
      };
    }

    return null;
  }

  correlationRef(context: WorkDagExecutionContext): string {
    const target = this.target(context);
    return ["approval", context.work.workItemId, context.node.capability, target?.subjectRevision ?? "missing"].join(
      ":",
    );
  }

  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution> {
    const target = this.target(context);
    if (!target) {
      throw new Error(
        context.node.capability === "publish_work_branch" ? "PUBLICATION_ARTIFACT_NOT_READY" : "WORK_SUBJECT_REQUIRED",
      );
    }
    return {
      kind: "deferred",
      externalRef: context.execution.externalRef ?? this.correlationRef(context),
    };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    const target = this.target(context);
    if (!target) return null;
    const approval = this.store
      .listApprovals(context.work.workItemId)
      .filter(
        (item) =>
          !item.stale &&
          item.approvalScope === context.node.capability &&
          item.subjectType === target.subjectType &&
          item.subjectRevision === target.subjectRevision,
      )
      .at(-1);
    if (!approval) return null;
    return approval.decision === "approved"
      ? {
          status: "succeeded",
          summary: "Approval granted",
          facts: [{ key: "approval." + context.node.capability, value: true }],
        }
      : {
          status: "failed",
          summary: "APPROVAL_REJECTED",
          facts: [{ key: "approval." + context.node.capability, value: false }],
        };
  }
}

class WaitDagAdapter implements WorkDagExecutorAdapter {
  readonly kind = "wait" as const;

  constructor(private readonly store: WorkOrchestrationStore) {}

  correlationRef(context: WorkDagExecutionContext): string {
    if (context.node.resource?.startsWith("source-event:")) return context.node.resource;
    return "dag-wait:" + context.execution.idempotencyKey;
  }

  async execute(context: WorkDagExecutionContext): Promise<DagDeferredExecution> {
    const correlation = context.execution.externalRef ?? this.correlationRef(context);
    this.store.ensureDagWait(
      context.execution.nodeExecutionId,
      context.node.capability,
      correlation,
      context.node.timeoutMs ? Date.now() + context.node.timeoutMs : null,
      Date.now(),
    );
    return { kind: "deferred", externalRef: correlation };
  }

  async reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    let wait = this.store.getDagWaitByExecution(context.execution.nodeExecutionId);
    if (!wait) return null;
    if (wait.state === "waiting" && wait.expiresAt !== null && wait.expiresAt <= Date.now()) {
      wait = this.store.expireDagWait(wait.waitId, Date.now());
    }
    if (wait.state === "waiting") return null;
    if (wait.state === "signaled") {
      return {
        status: "succeeded",
        summary: "Wait condition signaled",
        facts: [
          { key: "wait." + context.node.capability, value: true },
          ...(wait.signalDigest ? [{ key: "wait.signal_digest", value: wait.signalDigest }] : []),
        ],
      };
    }
    return {
      status: "failed",
      summary: wait.state === "expired" ? "WAIT_EXPIRED" : "WAIT_CANCELLED",
    };
  }
}

export function createControlDagAdapters(
  store: WorkOrchestrationStore,
  publications?: PublicationReader,
): WorkDagExecutorAdapter[] {
  return [new ApprovalDagAdapter(store, publications), new WaitDagAdapter(store)];
}
