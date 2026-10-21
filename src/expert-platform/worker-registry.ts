export type WorkerStatus = "pending" | "active" | "revoked";

export interface WorkerRegistration {
  id: string;
  capabilities: readonly string[];
  status: WorkerStatus;
}

/**
 * Prototype domain model. It is deliberately not an authentication provider:
 * transport peers must be cryptographically authenticated before consulting it.
 * Persistent Hub-owned registry and credential rotation are required for production.
 */
export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerRegistration>();

  enroll(id: string, capabilities: string[]): WorkerRegistration {
    if (!id.trim() || capabilities.length === 0 || capabilities.some((capability) => !capability.trim())) {
      throw new Error("INVALID_WORKER");
    }
    if (this.workers.has(id)) throw new Error("WORKER_ALREADY_EXISTS");
    const registration: WorkerRegistration = {
      id,
      capabilities: [...new Set(capabilities)],
      status: "pending",
    };
    this.workers.set(id, registration);
    return registration;
  }

  approve(id: string): void {
    const worker = this.requireWorker(id);
    if (worker.status === "revoked") throw new Error("WORKER_REVOKED");
    this.workers.set(id, { ...worker, status: "active" });
  }

  revoke(id: string): void {
    const worker = this.requireWorker(id);
    this.workers.set(id, { ...worker, status: "revoked" });
  }

  isAuthorized(id: string, capability: string): boolean {
    const worker = this.workers.get(id);
    return worker?.status === "active" && worker.capabilities.includes(capability);
  }

  private requireWorker(id: string): WorkerRegistration {
    const worker = this.workers.get(id);
    if (!worker) throw new Error("WORKER_NOT_FOUND");
    return worker;
  }
}
