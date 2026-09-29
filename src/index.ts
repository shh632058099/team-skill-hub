import path from "node:path";
import { loadConfig } from "./config.js";
import {
  GitRepositoryProvider,
  LocalRepositoryProvider
} from "./repository.js";
import {
  RequiredFieldsRule,
  RepositoryVisibilityRule,
  SkillDependencyRule,
  UniqueNameRule
} from "./skills.js";
import { MemoryRegistryStore } from "./registry.js";
import { HybridRoutingStrategy, SqliteFtsSearchBackend } from "./search.js";
import {
  ApiKeyAuthenticationProvider,
  DevelopmentAuthenticationProvider,
  StaticRolePermissionProvider
} from "./security.js";
import { LoggingEventSink } from "./events.js";
import { SkillHubApplicationService } from "./application.js";
import { startServer } from "./server.js";
import { AdminConfigStore } from "./admin-config.js";
import { ManagedApiKeyStore } from "./api-keys.js";

const configPath = path.resolve(
  process.env.CONFIG_PATH ??
    (process.env.NODE_ENV === "production"
      ? "./config/repositories.yaml"
      : "./config/repositories.local.yaml")
);
const config = await loadConfig(configPath);
const adminConfigStore = new AdminConfigStore(config.dataDir);
await adminConfigStore.load(config);

const registry = new MemoryRegistryStore();
const search = new SqliteFtsSearchBackend();
const routing = new HybridRoutingStrategy(search);
const apiKeyStore = new ManagedApiKeyStore(config.dataDir);
const managedApiKeys = await apiKeyStore.load();
const auth =
  config.authentication.mode === "api-key"
    ? new ApiKeyAuthenticationProvider(config.authentication.apiKeys)
    : new DevelopmentAuthenticationProvider(config.defaultRoles);
if (auth instanceof ApiKeyAuthenticationProvider) {
  auth.replaceManagedKeys(managedApiKeys);
}
const permissions = new StaticRolePermissionProvider();
const events = new LoggingEventSink();

const service = new SkillHubApplicationService(
  config,
  [new LocalRepositoryProvider(), new GitRepositoryProvider()],
  registry,
  search,
  routing,
  auth,
  permissions,
  [
    new RequiredFieldsRule(),
    new UniqueNameRule(),
    new SkillDependencyRule(),
    new RepositoryVisibilityRule()
  ],
  events
);

await service.initialize();
await startServer(config, service, adminConfigStore, apiKeyStore, auth instanceof ApiKeyAuthenticationProvider ? auth : undefined);

const lastPolledAt = new Map<string, number>();
const pollScheduler = setInterval(() => {
  const now = Date.now();
  const activeIds = new Set(service.repositoryIds());
  for (const repositoryId of activeIds) {
    const intervalSeconds = service.pollingIntervalSeconds(repositoryId);
    if (intervalSeconds <= 0) continue;
    const previous = lastPolledAt.get(repositoryId) ?? now;
    if (now - previous < intervalSeconds * 1000) continue;
    lastPolledAt.set(repositoryId, now);
    void service.syncRepository(repositoryId, "poll").catch((error) => {
      console.error(
        JSON.stringify({
          event: "repository.poll.failed",
          repository: repositoryId,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    });
  }
  for (const repositoryId of lastPolledAt.keys()) {
    if (!activeIds.has(repositoryId)) lastPolledAt.delete(repositoryId);
  }
}, 5000);
pollScheduler.unref();

console.log(
  JSON.stringify({
    event: "server.started",
    host: config.host,
    port: config.port,
    config: configPath
  })
);
