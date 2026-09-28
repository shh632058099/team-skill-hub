export type RepositoryStatus = "healthy" | "syncing" | "error" | "disabled";
export type SkillMaturity = "experimental" | "beta" | "stable" | "deprecated";
export type RepositorySyncTrigger = "startup" | "poll" | "webhook" | "manual";

export interface AuthenticationConfig {
  mode: "development" | "api-key";
  apiKeys: Record<string, Principal>;
}

export interface GitAuthConfig {
  type: "none" | "https-token" | "ssh";
  tokenEnv?: string;
  usernameEnv?: string;
  sshKeyPath?: string;
  knownHostsPath?: string;
}

export interface RepositoryConfig {
  id: string;
  name: string;
  provider: "local" | "git";
  path?: string;
  gitUrl?: string;
  branch?: string;
  gitAuth: GitAuthConfig;
  webhookAliases: string[];
  enabled: boolean;
  audience: string[];
  visibility: string[];
  pollingIntervalSeconds: number;
  readRoles: string[];
  syncRoles: string[];
}

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  defaultRoles: string[];
  authentication: AuthenticationConfig;
  revisionRetentionMax?: number;
  webhookDedupMaxEntries?: number;
  webhookDedupTtlSeconds?: number;
  repositories: RepositoryConfig[];
}

export interface RepositoryState {
  id: string;
  status: RepositoryStatus;
  revision?: string;
  lastGoodRevision?: string;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  skillCount: number;
  promptCount?: number;
  agentCount?: number;
  failureCount: number;
  error?: string;
}

export interface RepositoryView {
  id: string;
  name: string;
  provider: RepositoryConfig["provider"];
  audience: string[];
  visibility: string[];
  state?: RepositoryState;
}

export interface RepositoryRevision {
  revision: string;
  active: boolean;
  lastGood: boolean;
}

export interface AuditEvent {
  ts: string;
  action:
    | "repository.sync.started"
    | "repository.sync.completed"
    | "repository.sync.failed"
    | "repository.sync.denied"
    | "repository.rollback.completed"
    | "repository.rollback.failed";
  repositoryId: string;
  actorId: string;
  trigger: RepositorySyncTrigger;
  revision?: string;
  skillCount?: number;
  error?: string;
}

export interface SkillMetadata {
  audience: string[];
  domain: string[];
  category: string[];
  keywords: string[];
  product?: string[];
  visibility: string[];
  maturity: SkillMaturity;
  owner: string;
  priority: number;
  dependsOn: string[];
  compatibility: Record<string, boolean>;
}

export interface Skill {
  key: string;
  schemaVersion: number;
  name: string;
  version?: string;
  description: string;
  repositoryId: string;
  revision: string;
  relativePath: string;
  rootDir: string;
  content: string;
  metadata: SkillMetadata;
}

export interface PromptArtifact {
  key: string;
  schemaVersion: number;
  name: string;
  version?: string;
  description: string;
  repositoryId: string;
  revision: string;
  relativePath: string;
  content: string;
  audience: string[];
  visibility: string[];
  keywords: string[];
  category: string[];
  owner: string;
  compatibility: Record<string, boolean>;
}

export interface AgentArtifact {
  key: string;
  schemaVersion: number;
  name: string;
  version?: string;
  description: string;
  repositoryId: string;
  revision: string;
  relativePath: string;
  audience: string[];
  visibility: string[];
  keywords: string[];
  owner: string;
  skills: string[];
  prompts: string[];
  tools: string[];
  compatibility: Record<string, boolean>;
}

export interface ArtifactSearchResult<T> {
  artifact: T;
  score: number;
  reason: string;
}

export type EvaluationTarget = "skill" | "prompt" | "agent";
export type EvaluationOperation = "search" | "resolve" | "get";

export interface EvaluationExpectation {
  selected?: string;
  repository?: string;
  contains?: string[];
  skills?: string[];
  prompts?: string[];
  tools?: string[];
}

export interface EvaluationCase {
  id: string;
  description?: string;
  target: EvaluationTarget;
  operation: EvaluationOperation;
  query?: string;
  name?: string;
  client?: string;
  expect: EvaluationExpectation;
}

export interface EvaluationSuite {
  schemaVersion: number;
  id: string;
  description: string;
  repositoryId: string;
  relativePath: string;
  cases: EvaluationCase[];
}

export interface EvaluationCaseResult {
  id: string;
  passed: boolean;
  message: string;
  actual?: unknown;
}

export interface EvaluationRunResult {
  runId: string;
  ts: string;
  repositoryId: string;
  revision: string;
  suiteId: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  cases: EvaluationCaseResult[];
  baselineRevision?: string;
  baselinePassed?: number;
  regression?: boolean;
  removedBaselineCases?: string[];
}

export interface Principal {
  id: string;
  roles: string[];
  tenantId: string;
}

export interface SearchFilters {
  repositories?: string[];
  domain?: string;
  category?: string;
  audience?: string;
  maturity?: SkillMaturity;
  client?: string;
}

export interface SearchResult {
  skill: Skill;
  score: number;
  reason: string;
}

export interface MaterializedRepository {
  config: RepositoryConfig;
  sourceRoot: string;
  revision: string;
}

export interface SkillRepositoryProvider {
  readonly type: RepositoryConfig["provider"];
  materialize(config: RepositoryConfig, dataDir: string): Promise<MaterializedRepository>;
}

export interface RegistryStore {
  list(): Skill[];
  get(repositoryId: string, name: string): Skill | undefined;
  replaceRepository(repositoryId: string, skills: Skill[]): void;
  serialize(): unknown;
  hydrate(value: unknown): void;
}

export interface SkillSearchBackend {
  rebuild(skills: Skill[]): void;
  search(query: string, filters: SearchFilters, limit: number): SearchResult[];
  close(): void;
}

export interface SkillRoutingStrategy {
  resolve(query: string, filters: SearchFilters, limit: number): SearchResult[];
}

export interface SkillCandidateReranker {
  rerank(query: string, candidates: SearchResult[], limit: number): SearchResult[];
}

export interface PermissionProvider {
  allowedRepositories(principal: Principal, repositories: RepositoryConfig[]): RepositoryConfig[];
  canReadSkill(principal: Principal, repository: RepositoryConfig, skill: Skill): boolean;
  canSyncRepository(principal: Principal, repository: RepositoryConfig): boolean;
}

export interface AuthenticationProvider {
  authenticate(headers?: Headers): Principal;
}

export interface ValidationIssue {
  rule: string;
  message: string;
  skillPath?: string;
}

export interface ValidationRule {
  readonly name: string;
  validate(skill: Skill, repository: RepositoryConfig, allSkills: Skill[]): ValidationIssue[];
}

export interface EventSink {
  emit(event: string, payload: Record<string, unknown>): void;
}
