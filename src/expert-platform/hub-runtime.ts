import path from "node:path";
import { readFileSync } from "node:fs";
import { ExpertTaskStore } from "./task-store.js";
import { PersistentWorkerRegistry } from "./persistent-worker-registry.js";
import { startExpertWorkerGrpcServer } from "./grpc-transport.js";
import { ExpertStore } from "./expert-store.js";

export async function startExpertHubRuntimeFromEnv(
  env: Record<string, string | undefined>,
): Promise<{ address: string; close(): Promise<void> } | null> {
  const runtimeDb = env.EXPERT_RUNTIME_DB?.trim();
  const grpcAddress = env.EXPERT_GRPC_ADDRESS?.trim();
  // Expert DB is also used by MCP/Admin without starting the Worker gRPC listener.
  // gRPC remains explicitly opt-in; if requested, it requires the shared runtime DB.
  if (!grpcAddress) return null;
  if (!runtimeDb) throw new Error("INVALID_EXPERT_HUB_CONFIG");

  const registryDb =
    env.EXPERT_WORKER_REGISTRY_DB?.trim() || path.join(path.dirname(runtimeDb), "expert-workers.sqlite");

  const caPath = env.EXPERT_GRPC_TLS_CA_PATH?.trim();
  const certPath = env.EXPERT_GRPC_TLS_CERT_PATH?.trim();
  const keyPath = env.EXPERT_GRPC_TLS_KEY_PATH?.trim();
  const tlsCount = [caPath, certPath, keyPath].filter(Boolean).length;
  if (tlsCount !== 0 && tlsCount !== 3) throw new Error("INVALID_EXPERT_HUB_CONFIG");

  const tasks = new ExpertTaskStore(runtimeDb);
  const experts = new ExpertStore(runtimeDb);
  const workers = new PersistentWorkerRegistry(registryDb);
  try {
    const server = await startExpertWorkerGrpcServer(tasks, workers, grpcAddress, {
      experts,
      ...(tlsCount === 3
        ? {
            tls: {
              ca: readFileSync(caPath!),
              cert: readFileSync(certPath!),
              key: readFileSync(keyPath!),
              requireClientCertificate: true,
            },
          }
        : {}),
    });
    return {
      address: server.address,
      close: async () => {
        await server.close();
        tasks.close();
        experts.close();
        workers.close();
      },
    };
  } catch (error) {
    tasks.close();
    experts.close();
    workers.close();
    throw error;
  }
}
