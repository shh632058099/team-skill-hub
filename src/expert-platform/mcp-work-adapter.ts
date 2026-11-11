import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WorkItemRecord, WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { SubmitWorkInput, WorkDetail, WorkOrchestrator } from "./work-orchestrator.js";
import {
  WorkSourceIngestion,
  type NormalizedWorkSourceSignal,
  type NormalizedWorkSourceSubmission,
  type WorkSourceAdapter,
} from "./work-source-adapter.js";

export interface McpWorkContext {
  principalId: string;
  scope: string;
  client: string;
  sessionId?: string;
  trustedSession: boolean;
}

export interface McpWorkSubmitInput extends Omit<
  SubmitWorkInput,
  "principalId" | "scope" | "sourceType" | "sourceScope" | "sourceRef" | "sourceSessionId" | "sourceClient"
> {}

export interface McpSourceUpdateInput {
  state: "active" | "terminal";
  detail?: string;
  sourceControlToken: string;
}

export interface McpWorkSubmissionResult extends WorkDetail {
  sourceControlToken: string;
}

type McpAdapterContext = Omit<McpWorkContext, "principalId" | "scope">;

function cleanSegment(value: string, fallback: string): string {
  const normalized = value.trim();
  return (normalized || fallback).slice(0, 200).replace(/[\r\n/]+/g, "_");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class McpWorkAdapter implements WorkSourceAdapter<McpWorkSubmitInput, McpSourceUpdateInput, McpAdapterContext> {
  private readonly ingestion: WorkSourceIngestion;

  constructor(
    private readonly store: WorkOrchestrationStore,
    orchestrator: WorkOrchestrator,
  ) {
    this.ingestion = new WorkSourceIngestion(store, orchestrator);
  }

  private sourceScope(context: McpAdapterContext): string {
    return `${cleanSegment(context.client, "mcp")}/${cleanSegment(context.sessionId ?? "unbound", "unbound")}`;
  }

  normalizeSubmission(
    input: McpWorkSubmitInput,
    context: McpAdapterContext,
    _now: number,
  ): NormalizedWorkSourceSubmission {
    const sourceScope = this.sourceScope(context);
    const sourceRef = input.idempotencyKey.trim();
    return {
      ...input,
      identity: { sourceType: "mcp", sourceScope, sourceRef },
      ...(context.trustedSession && context.sessionId ? { sourceSessionId: context.sessionId } : {}),
      sourceClient: context.client,
      observation: {
        state: "active",
        fingerprint: fingerprint({
          state: "active",
          sourceScope,
          sourceRef,
          title: input.title.trim(),
          description: input.description.trim(),
        }),
      },
    };
  }

  normalizeSignal(
    work: WorkItemRecord,
    input: McpSourceUpdateInput,
    context: McpAdapterContext,
    _now: number,
  ): NormalizedWorkSourceSignal {
    if (work.sourceType !== "mcp" || !work.sourceScope || !work.sourceRef)
      throw new Error("MCP_SOURCE_IDENTITY_MISSING");
    const token = input.sourceControlToken?.trim();
    if (!token || !/^wsc_[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("MCP_SOURCE_CONTROL_DENIED");
    const expectedHash = this.store.getSourceControlTokenHash(work.workItemId);
    const actualHash = createHash("sha256").update(token).digest("hex");
    if (
      !expectedHash ||
      expectedHash.length !== actualHash.length ||
      !timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(actualHash, "hex"))
    )
      throw new Error("MCP_SOURCE_CONTROL_DENIED");
    if (context.trustedSession && context.sessionId) {
      const expectedScope = this.sourceScope(context);
      if (work.sourceScope !== expectedScope) throw new Error("MCP_SOURCE_SCOPE_MISMATCH");
    }
    const sourceScope = work.sourceScope;
    const detail = input.detail?.trim() || undefined;
    return {
      identity: { sourceType: "mcp", sourceScope, sourceRef: work.sourceRef },
      state: input.state,
      ...(detail ? { detail } : {}),
      fingerprint: fingerprint({ state: input.state, detail: detail ?? null, sourceScope, sourceRef: work.sourceRef }),
    };
  }

  submit(input: McpWorkSubmitInput, context: McpWorkContext, now = Date.now()): McpWorkSubmissionResult {
    const detail = this.ingestion.submit(
      this,
      input,
      { client: context.client, sessionId: context.sessionId, trustedSession: context.trustedSession },
      { principalId: context.principalId, scope: context.scope },
      now,
    );
    const sourceControlToken = `wsc_${randomBytes(32).toString("base64url")}`;
    this.store.rotateSourceControlTokenHash(
      detail.work.workItemId,
      createHash("sha256").update(sourceControlToken).digest("hex"),
      now,
    );
    return { ...detail, sourceControlToken };
  }

  updateSource(workItemId: string, input: McpSourceUpdateInput, context: McpWorkContext, now = Date.now()): WorkDetail {
    return this.ingestion.update(
      this,
      workItemId,
      input,
      { client: context.client, sessionId: context.sessionId, trustedSession: context.trustedSession },
      { principalId: context.principalId, scope: context.scope },
      now,
    );
  }
}
