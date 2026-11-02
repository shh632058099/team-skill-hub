import { ExpertStore } from "./expert-store.js";

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function runExpertAdmin(dbPath: string, args: readonly string[]): unknown {
  if (!dbPath.trim() || args.length < 1) throw new Error("INVALID_EXPERT_ADMIN_COMMAND");
  const command = args[0];
  const id = args[1];
  if (!command) throw new Error("INVALID_EXPERT_ADMIN_COMMAND");

  const store = new ExpertStore(dbPath);
  try {
    switch (command) {
      case "list-deployments":
        return store.listDeployments();
      case "define": {
        if (!id?.trim()) throw new Error("INVALID_EXPERT_ADMIN_COMMAND");
        const displayName = args[2]?.trim() ?? "";
        const capabilities = csv(args[3]);
        const keywords = csv(args[4]);
        store.putDefinition({
          id,
          displayName,
          capabilities,
          keywords,
          active: true,
        });
        return store.getDefinition(id);
      }
      case "deploy": {
        if (!id?.trim()) throw new Error("INVALID_EXPERT_ADMIN_COMMAND");
        const expertId = args[2]?.trim() ?? "";
        const repositoryIds = csv(args[3]);
        const principals = csv(args[4]);
        const runtimeProfile = args[5]?.trim() ?? "";
        store.putDeployment({
          id,
          expertId,
          repositoryIds,
          repositories: [],
          principals,
          runtimeProfile,
          active: true,
        });
        return store.getDeployment(id);
      }
      case "get":
        if (!id?.trim()) throw new Error("INVALID_EXPERT_ADMIN_COMMAND");
        return store.getDefinition(id);
      case "get-deployment":
        if (!id?.trim()) throw new Error("INVALID_EXPERT_ADMIN_COMMAND");
        return store.getDeployment(id);
      default:
        throw new Error("INVALID_EXPERT_ADMIN_COMMAND");
    }
  } finally {
    store.close();
  }
}
