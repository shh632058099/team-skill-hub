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

const configPath = path.resolve(
  process.env.CONFIG_PATH ??
    (process.env.NODE_ENV === "production"
      ? "./config/repositories.yaml"
      : "./config/repositories.local.yaml")
);
const config = await loadConfig(configPath);

const registry = new MemoryRegistryStore();
const search = new SqliteFtsSearchBackend();
const routing = new HybridRoutingStrategy(search);
const auth =
  config.authentication.mode === "api-key"
    ? new ApiKeyAuthenticationProvider(config.authentication.apiKeys)
    : new DevelopmentAuthenticationProvider(config.defaultRoles);
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
await startServer(config, service);

for (const repositoryId of service.repositoryIds()) {
  const intervalSeconds = service.pollingIntervalSeconds(repositoryId);
  if (intervalSeconds <= 0) continue;
  const timer = setInterval(() => {
    void service.syncRepository(repositoryId, "poll").catch((error) => {
      console.error(
        JSON.stringify({
          event: "repository.poll.failed",
          repository: repositoryId,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    });
  }, intervalSeconds * 1000);
  timer.unref();
}

console.log(
  JSON.stringify({
    event: "server.started",
    host: config.host,
    port: config.port,
    config: configPath
  })
);
