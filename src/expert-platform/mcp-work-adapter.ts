import { createHash } from "node:crypto";
import type { WorkOrchestrationStore } from "./work-orchestration-store.js";
import type { SubmitWorkInput, WorkDetail, WorkOrchestrator } from "./work-orchestrator.js";

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
}

function cleanSegment(value: string, fallback: string): string {
  const normalized = value.trim();
  return (normalized || fallback).slice(0, 200).replace(/[\r\n/]+/g, "_");
}

export class McpWorkAdapter {
  constructor(
    private readonly store: WorkOrchestrationStore,
    private readonly orchestrator: WorkOrchestrator,
  ) {}

  private sourceScope(context: McpWorkContext): string {
    return `${cleanSegment(context.client, "mcp")}/${cleanSegment(context.sessionId ?? "unbound", "unbound")}`;
  }

  submit(input: McpWorkSubmitInput, context: McpWorkContext, now = Date.now()): WorkDetail {
    const sourceScope = this.sourceScope(context);
    const sourceRef = input.idempotencyKey.trim();
    const detail = this.orchestrator.submitWork(
      {
        ...input,
        principalId: context.principalId,
        scope: context.scope,
        sourceType: "mcp",
        sourceScope,
        sourceRef,
        sourceSessionId: context.trustedSession ? context.sessionId : undefined,
        sourceClient: context.client,
      },
      now,
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          state: "active",
          sourceScope,
          sourceRef,
          title: input.title.trim(),
          description: input.description.trim(),
        }),
      )
      .digest("hex");
    const observation = this.store.recordSourceObservation(
      {
        workItemId: detail.work.workItemId,
        sourceType: "mcp",
        sourceScope,
        sourceRef,
        state: "active",
        fingerprint,
        observedAt: now,
      },
      now,
    );
    return this.orchestrator.reconcileSourceObservation(
      observation.observationId,
      context.principalId,
      context.scope,
      now,
    );
  }

  updateSource(workItemId: string, input: McpSourceUpdateInput, context: McpWorkContext, now = Date.now()): WorkDetail {
    if (!context.trustedSession || !context.sessionId) throw new Error("MCP_SOURCE_SESSION_UNTRUSTED");
    const work = this.store.getWork(workItemId, context.principalId, context.scope);
    const sourceScope = this.sourceScope(context);
    if (work.sourceType !== "mcp" || work.sourceScope !== sourceScope) throw new Error("MCP_SOURCE_SCOPE_MISMATCH");
    const sourceRef = work.sourceRef;
    if (!sourceRef) throw new Error("MCP_SOURCE_IDENTITY_MISSING");
    const detail = input.detail?.trim() || undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ state: input.state, detail: detail ?? null, sourceScope, sourceRef }))
      .digest("hex");
    const observation = this.store.recordSourceObservation(
      {
        workItemId,
        sourceType: "mcp",
        sourceScope,
        sourceRef,
        state: input.state,
        ...(detail ? { detail } : {}),
        fingerprint,
        observedAt: now,
      },
      now,
    );
    return this.orchestrator.reconcileSourceObservation(
      observation.observationId,
      context.principalId,
      context.scope,
      now,
    );
  }
}
