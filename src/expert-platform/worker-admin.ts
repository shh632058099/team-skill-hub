import { PersistentWorkerRegistry } from "./persistent-worker-registry.js";

export function runWorkerAdmin(dbPath: string, args: readonly string[]): unknown {
  if (!dbPath.trim() || args.length < 2) throw new Error("INVALID_WORKER_ADMIN_COMMAND");
  const command = args[0];
  const workerId = args[1];
  const extra = args[2];
  if (!command || !workerId?.trim()) throw new Error("INVALID_WORKER_ADMIN_COMMAND");
  const registry = new PersistentWorkerRegistry(dbPath);
  try {
    switch (command) {
      case "enroll": {
        const capabilities = (extra ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        return registry.enroll(workerId, capabilities);
      }
      case "approve":
        registry.approve(workerId);
        return { id: workerId, status: registry.get(workerId).status };
      case "issue-credential":
        return { id: workerId, credential: registry.issueCredential(workerId) };
      case "revoke":
        registry.revoke(workerId);
        return { id: workerId, status: registry.get(workerId).status };
      default:
        throw new Error("INVALID_WORKER_ADMIN_COMMAND");
    }
  } finally {
    registry.close();
  }
}
