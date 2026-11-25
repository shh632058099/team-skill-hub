import type { DagDeferredExecution, WorkDagExecutionContext, WorkDagExecutorAdapter } from "./work-dag-engine.js";
import type { DagNodeResult } from "./work-dag-runtime.js";
import type { WorkDagExternalActionPolicyContext } from "./work-dag-policy-context.js";

export interface ExternalActionHandler {
  capability: string;
  mutates: boolean;
  resourcePrefix?: string;
  correlationRef?(context: WorkDagExecutionContext): string | null;
  execute(context: WorkDagExecutionContext): Promise<DagNodeResult | DagDeferredExecution>;
  reconcile?(context: WorkDagExecutionContext): Promise<DagNodeResult | null>;
}

const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class ExternalActionRegistry {
  private readonly handlers = new Map<string, ExternalActionHandler>();

  register(handler: ExternalActionHandler): void {
    const capability = handler.capability.trim();
    const resourcePrefix = handler.resourcePrefix?.trim();
    if (!CAPABILITY.test(capability)) throw new Error("INVALID_EXTERNAL_ACTION_CAPABILITY");
    if (typeof handler.mutates !== "boolean") throw new Error("INVALID_EXTERNAL_ACTION_BEHAVIOR");
    if (resourcePrefix !== undefined && !CAPABILITY.test(resourcePrefix)) {
      throw new Error("INVALID_EXTERNAL_ACTION_RESOURCE_PREFIX");
    }
    if (this.handlers.has(capability)) throw new Error("DUPLICATE_EXTERNAL_ACTION_CAPABILITY");
    this.handlers.set(capability, {
      ...handler,
      capability,
      ...(resourcePrefix ? { resourcePrefix } : {}),
    });
  }

  listCapabilities(): string[] {
    return [...this.handlers.keys()].sort();
  }

  listPolicies(): WorkDagExternalActionPolicyContext[] {
    return [...this.handlers.values()]
      .map((handler) => ({
        capability: handler.capability,
        mutates: handler.mutates,
        ...(handler.resourcePrefix ? { resourcePrefix: handler.resourcePrefix } : {}),
      }))
      .sort((left, right) => left.capability.localeCompare(right.capability));
  }

  get(capability: string): ExternalActionHandler | null {
    return this.handlers.get(capability) ?? null;
  }

  require(capability: string): ExternalActionHandler {
    const handler = this.get(capability);
    if (!handler) throw new Error("EXTERNAL_ACTION_CAPABILITY_UNAVAILABLE");
    return handler;
  }
}

function resourceMatchesPrefix(resource: string | null, prefix: string | undefined): boolean {
  if (!prefix) return true;
  if (!resource) return false;
  return resource === prefix || resource.startsWith(prefix.endsWith(":") ? prefix : prefix + ":");
}

function assertTrustedBehavior(handler: ExternalActionHandler, context: WorkDagExecutionContext): void {
  if (
    context.node.mutates !== handler.mutates ||
    !resourceMatchesPrefix(context.node.resource, handler.resourcePrefix)
  ) {
    throw new Error("EXTERNAL_ACTION_BEHAVIOR_MISMATCH");
  }
}

class ExternalActionDagAdapter implements WorkDagExecutorAdapter {
  readonly kind = "external_action" as const;

  constructor(private readonly registry: ExternalActionRegistry) {}

  correlationRef(context: WorkDagExecutionContext): string | null {
    const handler = this.registry.require(context.node.capability);
    assertTrustedBehavior(handler, context);
    return handler.correlationRef?.(context) ?? null;
  }

  canReconcile(node: WorkDagExecutionContext["node"]): boolean {
    return Boolean(this.registry.get(node.capability)?.reconcile);
  }

  execute(context: WorkDagExecutionContext): Promise<DagNodeResult | DagDeferredExecution> {
    const handler = this.registry.require(context.node.capability);
    assertTrustedBehavior(handler, context);
    return handler.execute(context);
  }

  reconcile(context: WorkDagExecutionContext): Promise<DagNodeResult | null> {
    const handler = this.registry.require(context.node.capability);
    assertTrustedBehavior(handler, context);
    return handler.reconcile ? handler.reconcile(context) : Promise.resolve(null);
  }
}

export function createExternalActionDagAdapters(registry: ExternalActionRegistry): WorkDagExecutorAdapter[] {
  return [new ExternalActionDagAdapter(registry)];
}
