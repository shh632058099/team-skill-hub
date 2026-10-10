# Team Skill Hub V2 Roadmap

## 1. 当前已完成基线

当前 V1/V1.5 已形成可运行闭环：

- 独立 `team-skill-hub`、`rd-skills` 与 `customer-skills` Repository；
- Local / Git Repository Provider；
- Skill 扫描、Frontmatter 解析、Validation Pipeline；
- Last Known Good Revision；
- SQLite FTS5 搜索与自动 Skill Router；
- MCP Streamable HTTP；
- Skill Progressive Disclosure：索引 -> `SKILL.md` -> resource；
- polling + webhook + manual sync；
- 同一 Repo 并发同步去重；
- Repo 级 `read_roles` / `sync_roles`；
- 同步审计 JSONL；
- Repository 对外视图脱敏；
- Webhook fail-closed；
- HTTP 运维接口独立 `ADMIN_API_KEY`；
- Docker / Docker Compose；
- benchmark 脚本；
- 单元/回归测试。
- Request-scoped API-Key Authentication；
- developer/customer Principal 严格仓库隔离；
- validated revision history + rollback；
- Prometheus 风格 metrics；
- `depends_on` Skill 依赖元数据；
- `compatibility` 客户端兼容性过滤；
- Hybrid Routing / reranker 扩展接口。
- Skill Repo CLI validator；
- GitHub Actions / GitLab CI 校验模板。

## 2. V2 目标架构

```text
Developer / CI
      |
      v
Git Repositories
  |- rd-skills
  |- customer-skills
  |- common-skills   (future)
      |
      v
Repository Providers
  |- Local
  |- Git
  |- future: OCI / HTTP / DB
      |
      v
Sync + Validation + Revision
      |
      +--> Audit / Metrics / Events
      |
      v
Skill Registry
      |
      +--> Search Backend
      |      |- SQLite FTS5
      |      `- future: pgvector / hybrid search
      |
      +--> Routing Strategy
      |      |- keyword / metadata
      |      `- future: semantic reranker
      |
      v
Permission / Tenant Boundary
      |
      v
MCP Gateway
      |
      +--> Codex
      +--> Claude Code
      +--> internal Agent
      `--> customer Agent
```

## 3. P0 完成状态

### 3.1 Request-scoped Authentication

已完成：

- API Key -> Principal；
- Header -> Principal；
- tenant / roles 注入到每个 MCP request；
- 不允许一个全局静态身份代表全部调用方；
- 为未来 OAuth/OIDC/SSO 保留 Provider 接口。

验收：同一 MCP Server 上，developer 与 customer 请求只能看到各自允许的 Repo/Skill。

### 3.2 Customer Skill Repository

已新增独立仓：

```text
skill-hub-workspace/
|- team-skill-hub/
|- rd-skills/
`- customer-skills/
```

要求：

- customer repo 不得引用 internal resource；
- CI 阶段验证 `visibility`；
- MCP 查询严格按 Principal 过滤；
- Repo 元数据和内部路径不得跨边界泄露。

### 3.3 Repository Revision API

已实现：

- 当前 revision；
- last good revision；
- 最近同步结果；
- 最近失败原因；
- revision history；
- 可选 rollback 到已验证 revision。

注意：rollback 只允许管理员操作，并记录审计。

## 4. P1 扩展能力

### 4.1 Hybrid Search

保留当前 SQLite FTS5 为第一阶段召回；Skill 数量增长后增加：

```text
metadata filter
  -> FTS/BM25 recall
  -> embedding recall
  -> reranker
  -> permission filter
  -> top-k
```

搜索后端继续通过 `SkillSearchBackend` 插件化，不让 MCP 层绑定具体数据库。

### 4.2 Skill Dependency

Skill metadata 已支持：

```yaml
depends_on:
  - common-skills:git-analysis
  - common-skills:log-analysis
```

当前同步阶段检查依赖格式、自依赖和同 Repo 依赖存在性；跨 Repo 依赖与循环依赖保留给 Registry 级校验阶段。

### 4.3 Skill Compatibility

已支持：

```yaml
compatibility:
  codex: true
  claude_code: true
  customer_agent: false
```

Router 根据客户端能力过滤。

### 4.4 Metrics

增加 Prometheus 风格指标：

- `skill_search_total`
- `skill_resolve_total`
- `skill_load_total`
- `repository_sync_total`
- `repository_sync_total{result=...}`
- `repository_sync_duration_seconds_count`
- `repository_sync_duration_seconds_sum`
- `repository_rollback_total{result=...}`

## 5. P2 平台化能力

### 5.1 PostgreSQL Registry

当单机 Registry 不再满足需求时，将：

- Repository State；
- Skill Index；
- Audit；
- Revision metadata

迁移到 PostgreSQL。

Skill 原始内容仍由 Git 保持 Source of Truth。

### 5.2 Redis

只用于：

- distributed lock；
- hot metadata cache；
- rate limit；
- event fanout。

不作为 Skill Source of Truth。

### 5.3 Horizontal Scaling

目标：

```text
Load Balancer
   |
   +-- Skill Hub instance 1
   +-- Skill Hub instance 2
   `-- Skill Hub instance N
          |
          +-- PostgreSQL
          +-- Redis
          `-- shared revision storage / object storage
```

## 6. 后续实施顺序

当前单机完整版本已经覆盖原 P0 与主要 P1 扩展边界。后续按实际规模触发：

1. 增加真正的 embedding/semantic reranker；
2. 增加 Registry 级跨 Repo dependency/cycle validation；
3. 增加 OAuth/OIDC/企业 SSO AuthenticationProvider；
4. 在确定 Git 平台后把现有 CI 模板接入真实远程仓，并增加 publish/release policy；
5. Skill 数量或实例规模达到瓶颈后再迁移 PostgreSQL；
6. 需要多实例同步锁时再引入 Redis；
7. 最后进入 horizontal scaling。

原则：在 Skill 数量和调用规模没有达到瓶颈前，不提前引入 PostgreSQL、Redis、Vector DB，优先保持单机部署简单、可调试、可维护。
