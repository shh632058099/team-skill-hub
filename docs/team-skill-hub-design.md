# Team Skill Hub：基于 MCP 的团队共享 Skill 中台方案

## 1. 项目背景

团队正在逐步沉淀 OTA、Yocto、Linux、代码审查、部署、调试、文档审查等专业 Skill，并希望这些 Skill 能被 Codex、Claude Code、Cursor、内部 Agent 等 AI 客户端统一使用。

如果 Skill 分散在个人电脑、个人 Prompt 或不同项目中，会产生以下问题：

- Skill 无法统一共享；
- 不同成员使用不同版本；
- Skill 更新后其他成员无法自动获得；
- 缺少 Review、版本管理和回滚；
- Skill 数量增加后难以快速找到正确 Skill；
- 研发 Skill、客户 Skill、公共 Skill 缺少隔离；
- 无法统一统计、治理和维护；
- AI 每次需要人工指定 Skill；
- 不同 AI Client 需要重复配置。

因此建设一套：

> **Team Skill Hub**

以 Git Repository 为 Skill 的唯一事实源，通过 MCP Server 对 Skill 做统一同步、索引、检索、权限控制和自动路由。

---

## 2. 核心设计原则

### 2.1 Git First

正式 Skill 必须通过 Git Repository 管理，支持：

- Branch
- Pull Request / Merge Request
- Review
- CODEOWNERS
- Tag / Release
- History
- Rollback
- Audit

Git 是 Skill 的 **Single Source of Truth**。

### 2.2 Repository First

系统的一级管理对象不是 Skill，而是 **Skill Repository**。

关系：

```text
Repository
 ├── Skill A
 ├── Skill B
 ├── Skill C
 └── Skill D
```

Skill Hub 负责管理一个或多个 Skill Repository，再对 Repo 内的 Skill 进行扫描、索引和路由。

### 2.3 Skill 与 MCP Server 完全解耦

MCP Server 源码仓库不直接保存业务 Skill。

推荐拆分：

```text
team-skill-hub      # MCP / Registry / Search / Router / Sync
rd-skills           # 研发 Skill
customer-skills     # 客户 Skill（后续）
common-skills       # 公共 Skill（后续）
```

Skill 更新不需要重新编译或重新发布 MCP Server。

### 2.4 Multi Repository Ready

V1 可以只接入 `rd-skills`，但架构必须天然支持 N 个 Repository。

### 2.5 Progressive Loading

客户端不要一次加载所有 Skill。

```text
Metadata / Index
      ↓
Search / Resolve
      ↓
SKILL.md
      ↓
References / Examples
      ↓
Scripts / Tools
```

### 2.6 Security by Server

权限必须在 MCP Server / Registry 层过滤，不能只依赖 Prompt。

---

## 3. 项目目标

Team Skill Hub 需要实现：

1. 团队 Skill 统一 Git 管理；
2. 研发 Skill 独立 Repo 管理；
3. 支持后续新增 customer/common/product Skill Repo；
4. Git Merge 后 Skill Hub 自动同步最新版本；
5. 支持 Skill 分类、标签、Owner、生命周期；
6. 支持全文检索和关键词路由；
7. 根据用户问题自动选择合适 Skill；
8. 支持研发与客户权限隔离；
9. 记录 Skill 来源 Repo、Commit、Path、Version；
10. 通过 MCP 统一提供给 Codex、Claude Code、Cursor、内部 Agent；
11. MCP Server 与 Skill 发布周期完全解耦。

---

## 4. Repository 划分

### 4.1 Team Skill Hub Repository

仓库：

```text
team-skill-hub
```

职责：

- MCP Server
- Repository Registry
- Git Sync
- Skill Scanner
- Skill Parser
- Skill Registry
- Skill Search
- Skill Router
- Permission
- Skill Index
- REST API（可选）
- Authentication
- Logging
- Metrics

不负责直接保存具体研发 Skill。

### 4.2 研发 Skill Repository

仓库：

```text
rd-skills
```

示例结构：

```text
rd-skills/
├── ota/
│   ├── code-review/
│   │   ├── SKILL.md
│   │   ├── references/
│   │   ├── examples/
│   │   └── scripts/
│   ├── api-review/
│   │   └── SKILL.md
│   ├── deployment/
│   │   └── SKILL.md
│   └── debugging/
│       └── SKILL.md
├── yocto/
│   ├── development/
│   ├── cve-management/
│   ├── debugging/
│   └── image-analysis/
├── linux/
├── testing/
├── common/
│   ├── code-review/
│   ├── document-review/
│   └── issue-analysis/
├── schemas/
│   └── skill.schema.json
├── templates/
│   └── SKILL.template.md
└── README.md
```

研发人员主要维护该 Repository。

---

## 5. 总体架构

```text
                          GitLab / GitHub
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
                 ▼              ▼              ▼
             rd-skills    customer-skills  common-skills
                 │              │              │
                 └──────────────┼──────────────┘
                                │
                         Merge / Webhook
                                │
                                ▼
                    ┌──────────────────────┐
                    │ Repository Manager   │
                    │                      │
                    │ Repo Registry        │
                    │ Git Sync             │
                    │ Revision Manager     │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Skill Processing     │
                    │                      │
                    │ Scanner              │
                    │ Parser               │
                    │ Validator            │
                    │ Indexer              │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Skill Registry       │
                    │                      │
                    │ Metadata             │
                    │ Full-text Index      │
                    │ Version              │
                    │ Permissions          │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ MCP Server           │
                    │                      │
                    │ list_skills          │
                    │ search_skills        │
                    │ resolve_skill        │
                    │ get_skill            │
                    │ get_skill_resource   │
                    └──────────┬───────────┘
                               │
                  ┌────────────┼────────────┐
                  ▼            ▼            ▼
               Codex      Claude Code     Cursor
```

---

## 6. Repository Registry

Skill Hub 维护统一 Repo 配置。

示例：

```yaml
repositories:
  - id: rd-skills
    name: R&D Skills
    git_url: git@gitlab.company.com:ai/rd-skills.git
    branch: main
    audience:
      - developer
    visibility:
      - internal
    sync:
      webhook: true
      polling_interval: 300

  - id: customer-skills
    name: Customer Skills
    git_url: git@gitlab.company.com:ai/customer-skills.git
    branch: main
    audience:
      - customer
      - fae
    visibility:
      - customer
    sync:
      webhook: true
```

增加新 Repo 时应通过配置完成，不应修改 MCP Server 代码。

---

## 7. Repository 数据模型

建议：

```text
SkillRepository
├── id
├── name
├── git_url
├── default_branch
├── current_commit
├── last_good_commit
├── audience
├── visibility
├── owner
├── enabled
├── sync_mode
├── last_sync_at
├── status
└── skill_count
```

Repository 状态：

```text
healthy
syncing
error
disabled
```

---

## 8. Skill 标准结构

每个 Skill 是一个独立目录：

```text
skill-name/
├── SKILL.md
├── references/
├── examples/
├── scripts/
└── assets/
```

`SKILL.md` 是入口文件。

---

## 9. Skill Metadata

推荐：

```yaml
---
name: ota-code-review
version: 1.2.0

description: >
  Review OTA implementation code and identify unnecessary APIs,
  excessive call chains, redundant abstractions and dead code.

metadata:
  audience:
    - developer

  domain:
    - ota
    - embedded

  category:
    - code-review
    - refactor
    - architecture

  keywords:
    - OTA
    - API
    - code review
    - refactor
    - simplify
    - interface
    - call chain
    - 代码审查
    - 代码精简
    - 接口
    - 调用链

  product:
    - ota-library

  visibility:
    - internal

  maturity: stable

  owner: ota-team

  priority: 90
---
```

---

## 10. 分类体系

### Audience

```text
developer
customer
fae
test
architect
manager
```

### Domain

```text
ota
yocto
linux
security
network
autosar
diagnostics
testing
container
ci
```

### Category

```text
development
code-review
debugging
architecture
deployment
troubleshooting
testing
documentation
analysis
refactor
security
```

### Visibility

```text
internal
customer
public
restricted
```

### Maturity

```text
experimental
beta
stable
deprecated
```

---

## 11. Repository 与 Skill 权限关系

Repo 级权限是上限。

例如：

```text
repository.visibility = internal
```

即使某个 SKILL.md 错误声明：

```text
visibility = public
```

也不能突破 Repo 权限。

有效权限：

```text
Repository Permission
        ∩
Skill Permission
        =
Effective Permission
```

权限过滤必须发生在搜索之前。

---

## 12. Git 工作流

```text
Developer
    ↓
Clone rd-skills
    ↓
Create Branch
    ↓
Create / Modify Skill
    ↓
Commit
    ↓
Push
    ↓
Pull Request / Merge Request
    ↓
CI Validation
    ↓
CODEOWNERS Review
    ↓
Merge Main
    ↓
Webhook
    ↓
Skill Hub 自动同步
```

正式 Skill 不通过 Web UI 直接编辑。

---

## 13. CODEOWNERS

示例：

```text
/ota/**          @ota-team
/yocto/**        @yocto-team
/linux/**        @linux-team
/common/**       @ai-platform-team
```

Repository Owner 与 Skill Owner 分离：

- Repo Owner：AI Platform Team；
- Skill Owner：具体领域团队。

---

## 14. CI Validation

PR 阶段执行：

```text
skill lint
skill validate
skill test
skill security-check
```

至少检查：

- SKILL.md 是否存在；
- YAML Frontmatter 是否合法；
- name 是否唯一；
- description 是否存在；
- metadata 是否符合 schema；
- owner 是否存在；
- maturity 是否有效；
- keywords 是否合理；
- reference 是否存在；
- resource path 是否越界；
- script 是否包含明显危险行为。

---

## 15. Repository Sync Manager

Team Skill Hub 中增加独立模块：

```text
RepositoryManager
RepositoryConfig
GitRepositoryProvider
RepositorySyncService
WebhookHandler
RevisionManager
SkillScanner
SkillIndexer
```

同步流程：

```text
GitLab / GitHub
      │
      │ Webhook
      ▼
Repository Sync Manager
      │
      ├── git fetch
      ├── resolve branch
      ├── checkout commit
      ├── scan SKILL.md
      ├── validate
      ├── build index
      └── atomic activate
```

建议 Webhook + 5 分钟 fallback polling。

---

## 16. Commit Snapshot 与回滚

不能直接对线上工作目录 `git pull` 后立即生效。

推荐：

```text
repositories/
└── rd-skills/
    ├── revisions/
    │   ├── a8c9f21/
    │   ├── c61fe19/
    │   └── ...
    └── current -> revisions/a8c9f21
```

同步流程：

```text
New Commit
    ↓
Checkout Temporary Revision
    ↓
Validate
    ↓
Build Index
    ↓
Success
    ↓
Atomic Switch Current
```

若新 Commit 校验失败：

- 不激活新 Revision；
- 继续使用 Last Known Good Revision；
- 记录错误；
- 暴露 Repo 状态为 error，但服务仍可读旧版本。

---

## 17. Skill Index

V1 可以生成：

```text
skills-index.json
```

示例：

```json
{
  "repository": "rd-skills",
  "git_commit": "a8c9f21",
  "skills": [
    {
      "name": "ota-code-review",
      "version": "1.2.0",
      "path": "ota/code-review",
      "description": "Review OTA implementation...",
      "audience": ["developer"],
      "domain": ["ota"],
      "category": ["code-review", "refactor"],
      "keywords": ["OTA", "API", "接口", "调用链"],
      "visibility": ["internal"],
      "maturity": "stable",
      "priority": 90,
      "owner": "ota-team"
    }
  ]
}
```

索引与缓存必须可从 Git 完全重建。

---

## 18. Skill 来源追踪

每个 Skill 都必须记录：

```json
{
  "name": "ota-code-review",
  "repository": "rd-skills",
  "repository_url": "git@gitlab.company.com:ai/rd-skills.git",
  "branch": "main",
  "commit": "a8c9f21",
  "path": "ota/code-review",
  "version": "1.2.0"
}
```

这样可以准确定位某次 Agent 执行使用了哪个 Skill 版本。

---

## 19. MCP API

### list_skill_repositories

列出用户允许访问的 Skill Repo。

### list_skills

支持：

```json
{
  "repository": "rd-skills",
  "domain": "ota",
  "audience": "developer"
}
```

### search_skills

输入：

```json
{
  "query": "OTA API 有没有可以删除的接口",
  "repository": ["rd-skills"],
  "top_k": 5
}
```

返回：

```json
[
  {
    "name": "ota-code-review",
    "repository": "rd-skills",
    "score": 0.94,
    "reason": "Matched OTA, API, interface and code simplification."
  }
]
```

### resolve_skill

输入：

```json
{
  "query": "检查 OTA API 有没有没必要的接口以及太长的调用链"
}
```

返回：

```json
{
  "selected_skill": "ota-code-review",
  "repository": "rd-skills",
  "confidence": 0.94,
  "alternatives": ["ota-api-review"]
}
```

### get_skill

返回完整 SKILL.md，同时返回来源信息：

```json
{
  "name": "ota-code-review",
  "repository": "rd-skills",
  "commit": "a8c9f21",
  "path": "ota/code-review",
  "version": "1.2.0",
  "content": "..."
}
```

### get_skill_resource

按需加载：

```text
references/
examples/
assets/
```

---

## 20. Skill Router

第一版采用：

```text
User Prompt
    ↓
Identity / Permission
    ↓
Allowed Repositories
    ↓
Metadata Filter
    ↓
Keyword / FTS Search
    ↓
Ranking
    ↓
Top K
    ↓
Selected Skill
```

不要先搜索所有 Skill 再做权限过滤。

---

## 21. 搜索策略

V1 推荐 SQLite FTS5 / BM25。

检索字段：

- name
- description
- keywords
- domain
- category
- product

评分示例：

```text
score =
    keyword_match      * 0.35
  + description_match  * 0.25
  + domain_match       * 0.15
  + category_match     * 0.15
  + priority           * 0.10
```

当 Skill 数量明显增加、关键词搜索效果下降后，再加入 Embedding。

---

## 22. Semantic Search（V2）

后续可增加：

```text
User Query
   ↓
Embedding
   ↓
Vector Search
   ↓
Keyword Score
   ↓
Metadata Score
   ↓
Rerank
```

可采用：

```text
PostgreSQL + pgvector
```

V1 不建议直接引入 Milvus / Elasticsearch / Kafka 等重型组件。

---

## 23. Skill Progressive Loading

```text
Level 0
Skill Metadata / Index

↓

Level 1
SKILL.md

↓

Level 2
References / Examples

↓

Level 3
Scripts / Tools
```

MCP Client 启动时不要加载全部 Skill 正文。

---

## 24. 权限模型

所有以下接口都必须经过 Permission Filter：

- list_skill_repositories
- list_skills
- search_skills
- resolve_skill
- get_skill
- get_skill_resource

不能出现“搜索不可见，但通过名字可以直接 get”的绕过。

研发用户可访问：

```text
internal
customer
public
```

客户用户只可访问：

```text
customer
public
```

---

## 25. 客户 Skill 与研发 Skill

推荐 Repo 隔离：

```text
rd-skills
customer-skills
```

MCP Server 可以保持一个，通过权限决定用户可看到哪些 Repo。

如果后期客户网络域、安全域或部署环境完全不同，再拆分 Internal MCP / Customer MCP，但共用 Registry 设计。

---

## 26. Skill 版本模型

每个 Skill 同时维护：

### 业务版本

```text
1.2.0
```

### Git 来源版本

```text
repository + commit + path
```

例如：

```json
{
  "version": "1.2.0",
  "repository": "rd-skills",
  "git_commit": "a8c9f21",
  "path": "ota/code-review"
}
```

Repository Tag 和 Skill Version 是两个不同概念。

---

## 27. Skill 生命周期

```text
experimental
    ↓
beta
    ↓
stable
    ↓
deprecated
```

Router 默认优先 stable。

---

## 28. Skill 冲突处理

当多个 Skill 同时命中时，建议优先级：

1. Permission；
2. Repository scope；
3. Domain specificity；
4. Category specificity；
5. Search score；
6. Priority；
7. Maturity。

专用 Skill 应优先于通用 Skill。

---

## 29. Skill Composition（V2）

未来允许一次任务组合多个 Skill。

例如：

```text
用户：
Review OTA API，同时检查文档与代码是否一致。
```

解析：

```text
Primary Skill
  ota-api-review

Secondary Skill
  document-code-consistency
```

V1 暂不实现。

---

## 30. 推荐代码结构

```text
team-skill-hub/
├── apps/
│   ├── mcp-server/
│   └── web/
├── packages/
│   ├── repository/
│   ├── git-sync/
│   ├── registry/
│   ├── skill-parser/
│   ├── search/
│   ├── router/
│   └── permissions/
├── config/
├── tests/
├── docker/
├── docs/
│   └── team-skill-hub-design.md
└── docker-compose.yml
```

建议核心类：

```text
RepositoryManager
GitRepositoryProvider
RepositorySyncService
RevisionManager
SkillScanner
SkillParser
SkillRegistry
SkillSearchEngine
SkillRouter
PermissionService
McpSkillService
```

避免把 Git、Parser、Search、Permission、Router 全部写进一个 MCPServer 类。

---

## 31. 推荐技术栈

V1：

```text
Language        TypeScript
Runtime         Node.js
MCP             Official MCP SDK
Git             GitLab / GitHub
Metadata        JSON / SQLite
Search          SQLite FTS5
Sync            Git Webhook + Polling fallback
Cache           Memory
Deployment      Docker
Auth            Company SSO / OAuth
```

后续：

```text
PostgreSQL
Redis
pgvector
```

---

## 32. 本地缓存

示例：

```text
/var/lib/team-skill-hub/
├── repositories/
│   ├── rd-skills/
│   │   ├── revisions/
│   │   └── current
│   └── customer-skills/
└── indexes/
    ├── rd-skills.db
    └── customer-skills.db
```

原则：

```text
Git = State
Cache / DB = Rebuildable
```

---

## 33. Logging 与审计

每次 Skill 使用建议记录：

```json
{
  "timestamp": "...",
  "user": "...",
  "repository": "rd-skills",
  "selected_skill": "ota-code-review",
  "skill_version": "1.2.0",
  "git_commit": "a8c9f21",
  "score": 0.94
}
```

默认不要持久化完整用户 Prompt，除非公司安全规范明确允许。

可以选择：

- 不记录；
- 脱敏；
- Hash；
- 仅记录分类结果。

---

## 34. Metrics

建议统计：

- Skill Invocation Count
- Skill Search Count
- No Skill Found Rate
- Top Skill
- Unused Skill
- Skill Selection Confidence
- Deprecated Skill Usage
- Search Latency
- MCP Latency
- Repository Sync Success Rate
- Repository Sync Lag

`No Skill Found Rate` 很重要，它可以反向指导团队新增 Skill。

---

## 35. 安全设计

至少包含：

- RBAC；
- Git Review；
- Webhook Signature；
- Customer / Internal Isolation；
- Audit Log；
- Input Validation；
- Resource Path Traversal Protection；
- Rate Limit；
- Script Execution Permission。

Skill 中可以带 `scripts/`，但 V1 默认 MCP Server 不直接执行脚本。

---

## 36. 开源项目复用建议

实现前优先评估并复用：

### mcp-skills-registry

重点参考：

- Skill Discovery
- SKILL.md Parser
- MCP Server
- REST API

### awesome-skills-registry

重点参考：

- Git-based Registry
- Repo Scan
- Skill Catalog
- CI 自动生成索引

### MCPHub

重点参考：

- Search
- Smart Routing
- MCP Gateway
- 权限管理

### skillmd

重点参考：

- Skill Lint
- Skill Search
- Skill CI
- Skill Publish

原则：

> 可以复用现有实现，但不能为了复用破坏 Git First、Repository First、Skill/Server 解耦和 Multi Repository Ready。

---

## 37. V1 范围

V1 只需要：

```text
team-skill-hub
       +
rd-skills
```

必须完成：

### P0

1. Repository abstraction
2. Repository Registry
3. rd-skills Git integration
4. Git clone / fetch
5. Revision tracking
6. Skill scan
7. Skill metadata parse
8. Skill schema validation
9. Skill index
10. SQLite FTS5 search
11. list_skill_repositories
12. list_skills
13. search_skills
14. get_skill
15. get_skill_resource
16. Webhook sync
17. Permission filter
18. Last Known Good rollback

### P1

1. resolve_skill
2. Ranking
3. Repository status
4. Sync audit
5. Skill usage analytics
6. Hot reload
7. Deprecated management

### P2

1. Semantic Search
2. Embedding
3. LLM Rerank
4. Multi-Skill Composition
5. Web Admin
6. Skill Quality Evaluation

---

## 38. V1 明确不做

暂时不要实现：

- Web Skill Editor；
- 在线直接修改 SKILL.md；
- 复杂 Vector Database；
- Agent Framework；
- Workflow Engine；
- Prompt Management Platform；
- 模型管理；
- 完整 AI 中台；
- 复杂审批系统。

Git 本身已经解决编辑、版本控制、Review 和回滚，不应重复建设。

---

## 39. MVP 闭环

第一阶段最重要的目标：

```text
Developer 修改 rd-skills
        ↓
Pull Request
        ↓
CI Validation
        ↓
CODEOWNERS Review
        ↓
Merge
        ↓
Webhook
        ↓
Team Skill Hub Sync
        ↓
Skill Re-index
        ↓
其他成员 Search / Resolve
        ↓
自动加载最新 Skill
```

这个闭环优先级高于 Web UI、Embedding 和复杂管理功能。

---

## 40. 示例：OTA Skill 自动选择

用户：

```text
Review 当前 OTA 仓库，
看看有没有没必要的接口以及可以缩短的调用链。
```

Router：

```text
Allowed Repo:
  rd-skills

Domain:
  ota

Category:
  code-review
  refactor

Keywords:
  interface
  调用链
  review
```

搜索结果：

```text
ota-code-review       0.95
ota-api-review        0.81
generic-code-review   0.63
```

最终选择：

```text
rd-skills / ota-code-review
```

然后：

```text
get_skill
  ↓
SKILL.md
  ↓
按需加载 references
```

---

## 41. 测试要求

至少覆盖：

- Repository clone；
- Repository update；
- New Skill；
- Updated Skill；
- Deleted Skill；
- Invalid SKILL.md；
- Rollback；
- Webhook duplicate event；
- Concurrent sync；
- Search；
- Permission；
- Repository filter；
- Skill get；
- Resource path validation；
- Last Known Good；
- Repo disable / enable；
- Permission cannot be bypassed by direct get。

重点测试：

> 一个坏 Commit 不得影响当前可用的 Good Revision。

---

## 42. 项目实施阶段

### Phase 1：Repository 基础

完成：

- Repository abstraction；
- Repo config；
- Git clone / fetch；
- Revision tracking；
- rd-skills 接入。

### Phase 2：Skill Registry

完成：

- Scanner；
- Parser；
- Validator；
- Metadata Schema；
- Index。

### Phase 3：MCP

完成：

- list_skill_repositories；
- list_skills；
- search_skills；
- get_skill；
- get_skill_resource。

### Phase 4：Router

完成：

- Metadata Filter；
- FTS Search；
- Ranking；
- resolve_skill。

### Phase 5：Enterprise

完成：

- SSO；
- RBAC；
- Customer Isolation；
- Audit；
- Analytics。

### Phase 6：Semantic

完成：

- Embedding；
- Vector Search；
- LLM Rerank；
- Multi Skill。

---

## 43. Docker / Docker Compose 部署方案

V1 必须支持：

```text
docker
```

以及推荐的一键部署方式：

```text
docker compose
```

其中 **Docker Compose 作为 V1 默认部署路径**，单独 Docker 运行作为轻量备用方式。

### 43.1 容器架构

V1 推荐先保持单应用容器，不为了拆分而拆分：

```text
                 Host / VM
                    │
                    ▼
          ┌──────────────────────┐
          │ Docker Compose       │
          │                      │
          │ team-skill-hub       │
          │                      │
          │ MCP Server           │
          │ REST/Webhook         │
          │ Repo Sync Manager    │
          │ Skill Registry       │
          │ Search / Router      │
          └──────────┬───────────┘
                     │
             Persistent Volume
                     │
          ┌──────────┴───────────┐
          │                      │
          ▼                      ▼
   repository cache          SQLite/index
```

如果后续增加 PostgreSQL、Redis，再拆成独立 Compose Service。

### 43.2 Dockerfile 要求

项目根目录提供：

```text
Dockerfile
```

要求：

- 使用 multi-stage build；
- 构建阶段安装依赖并编译 TypeScript；
- Runtime 镜像只保留运行所需文件；
- 不以 root 用户运行；
- 镜像中包含 Git client，用于 clone/fetch Skill Repository；
- 暴露 MCP/HTTP 服务端口；
- 提供容器级 HEALTHCHECK；
- 配置、凭据和 Skill Repo 不打包进镜像；
- 镜像版本与 Git Commit 可追踪。

示例目标：

```text
team-skill-hub:1.0.0
team-skill-hub:<git-sha>
```

### 43.3 Docker Compose

项目根目录必须提供：

```text
docker-compose.yml
```

推荐结构：

```yaml
services:
  team-skill-hub:
    image: team-skill-hub:latest
    build:
      context: .
      dockerfile: Dockerfile

    restart: unless-stopped

    ports:
      - "8080:8080"

    environment:
      NODE_ENV: production
      CONFIG_PATH: /app/config/repositories.yaml
      DATA_DIR: /var/lib/team-skill-hub

    volumes:
      - ./config:/app/config:ro
      - skill-hub-data:/var/lib/team-skill-hub

    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  skill-hub-data:
```

生产环境不要把 Git Token、SSH Private Key 等敏感信息直接写入 `docker-compose.yml`。

### 43.4 持久化目录

容器内统一使用：

```text
/var/lib/team-skill-hub/
```

保存：

```text
/var/lib/team-skill-hub/
├── repositories/
│   ├── rd-skills/
│   │   ├── revisions/
│   │   └── current
│   └── ...
├── indexes/
│   └── skills.db
└── state/
```

通过 Docker Volume 持久化。

容器删除和重新创建后：

- Repo Cache 可以复用；
- SQLite Index 可以复用；
- 即使 Volume 丢失，也必须能够从 Git Repository 完整重建。

即：

```text
Git = authoritative state
Docker Volume = cache / derived state
```

### 43.5 配置挂载

推荐：

```text
config/
├── repositories.yaml
└── application.yaml
```

通过只读 Volume 挂载：

```text
./config:/app/config:ro
```

Repository 配置、端口、日志级别、轮询周期等不得写死在镜像中。

### 43.6 Git 凭据

Skill Repository 如果使用 SSH：

优先使用只读 Deploy Key。

容器只需要：

```text
git clone
git fetch
```

一般不需要：

```text
git push
```

生产环境应遵循最小权限原则。

推荐：

```text
rd-skills:
  read-only deploy key
```

不要把开发者个人 SSH Key 固化进镜像。

也可以使用：

- GitLab Deploy Token；
- GitHub App / Deploy Key；
- 企业内部 Git Service Token；
- Docker Secret / 外部 Secret Manager。

### 43.7 Webhook

容器提供 HTTP Webhook Endpoint，例如：

```text
POST /webhooks/git
```

外部：

```text
GitLab / GitHub
      ↓
Reverse Proxy / Ingress
      ↓
team-skill-hub:8080
      ↓
Webhook Handler
      ↓
Repository Sync
```

必须校验：

- Webhook Secret；
- Signature；
- Repository ID；
- Branch；
- Event 类型。

重复 Webhook 必须幂等。

### 43.8 健康检查

提供：

```text
GET /health
```

建议区分：

```text
/health/live
/health/ready
```

其中：

`live`：

- 进程运行；
- Event Loop 正常。

`ready`：

- Registry 已初始化；
- 当前索引可读取；
- 至少完成一次启动初始化。

某个外部 Skill Repo 暂时同步失败，不应该直接导致整个服务 liveness 失败。

Repo 健康状态应单独暴露。

### 43.9 推荐启动方式

本地或单机服务器：

```bash
docker compose up -d --build
```

查看：

```bash
docker compose ps
docker compose logs -f team-skill-hub
```

停止：

```bash
docker compose down
```

默认不要执行：

```bash
docker compose down -v
```

避免误删 Repo Cache / Index Volume。

### 43.10 单 Docker 运行

同时支持：

```bash
docker build -t team-skill-hub:latest .
```

然后：

```bash
docker run -d \
  --name team-skill-hub \
  --restart unless-stopped \
  -p 8080:8080 \
  -v ./config:/app/config:ro \
  -v team-skill-hub-data:/var/lib/team-skill-hub \
  team-skill-hub:latest
```

### 43.11 MCP 暴露方式

容器部署场景优先支持网络型 MCP Transport，例如 Streamable HTTP。

```text
Codex / Claude / Cursor
          │
          ▼
http(s)://skill-hub.company.com/mcp
```

如果需要本机 STDIO 模式，可以作为开发/兼容模式保留，但生产部署应优先使用可集中治理的网络服务。

### 43.12 Reverse Proxy

生产环境推荐：

```text
Nginx / Traefik / Company Gateway
              │
              ├── TLS
              ├── Authentication
              ├── Rate Limit
              └── Access Log
              │
              ▼
       team-skill-hub
```

Team Skill Hub 本身仍需执行应用层身份认证和权限检查，不能完全依赖反向代理。

### 43.13 升级

推荐：

```bash
docker compose pull
docker compose up -d
```

或使用新版本镜像：

```text
team-skill-hub:1.1.0
```

升级 MCP Server 不改变 `rd-skills` 的 Git 生命周期。

同理：

```text
rd-skills Merge
```

不需要重建 Docker Image。

这两个发布周期必须保持独立。

### 43.14 容器回滚

应用版本回滚：

```text
team-skill-hub:1.1.0
        ↓
team-skill-hub:1.0.0
```

Skill 内容回滚则由：

```text
Git Revision / Last Known Good
```

负责。

必须区分：

```text
Application Rollback
Skill Revision Rollback
```

二者互不耦合。

### 43.15 Docker Compose V1 验收条件

V1 至少满足：

1. `docker compose up -d --build` 可启动服务；
2. MCP Endpoint 可访问；
3. Health Check 正常；
4. 容器启动后自动加载 Repo 配置；
5. 自动 clone / fetch `rd-skills`；
6. Volume 持久化 Repo Cache 和 Index；
7. 容器重启后数据不丢失；
8. Merge Skill 后 Webhook 能触发同步；
9. Skill 更新不要求重建镜像；
10. 新 Skill Revision 失败时继续使用 Last Known Good；
11. Docker Image 升级与 Skill Repo 更新相互独立；
12. Secret 不固化在镜像和公开 Compose 文件中。

---

## 44. 最终目标

最终系统必须做到：

```text
开发者只维护 rd-skills Repository
        ↓
Merge Skill PR
        ↓
Team Skill Hub 自动同步
        ↓
无需重新部署 MCP Server
        ↓
团队成员自动获得最新 Skill
```

长期架构：

```text
Team Skill Hub
      ↓
Team AI Registry
      ↓
AI Developer Platform
```

但 V1 必须保持简单：

```text
Git
 + Repository Registry
 + Metadata
 + Search
 + MCP
 + Permission
 + Sync
 + Docker Compose
```

优先先把团队共享 Skill 的工程闭环跑通，再扩展成更大的 AI 平台。

---

## 45. 扩展性设计原则

扩展性必须作为当前架构约束，而不是后续补丁。

V1 可以只实现最简单的一套能力，但以下边界必须从一开始抽象出来：

- Repository Provider
- Skill Parser / Schema
- Registry Storage
- Search Backend
- Routing Strategy
- Permission Provider
- Authentication Provider
- Resource Resolver
- Event / Hook
- Deployment Topology
- API / Schema Version

原则：

> V1 简单实现，接口稳定；以后通过新增实现扩展，不通过大规模重写扩展。

---

## 46. Repository Provider 扩展

V1 主要支持 Git Repository，但不要把 Git 写死到业务层。

定义：

```text
SkillRepositoryProvider
```

统一能力：

```text
resolveRevision()
checkoutRevision()
readFile()
listFiles()
getMetadata()
healthCheck()
```

V1：

```text
GitRepositoryProvider
```

未来可增加：

```text
GitLabRepositoryProvider
GitHubRepositoryProvider
LocalRepositoryProvider
ObjectStorageRepositoryProvider
ArtifactRepositoryProvider
```

上层 Skill Registry 不应依赖具体 Git 命令。

---

## 47. Skill 类型扩展

当前核心资产是：

```text
SKILL.md
```

但数据模型不要限制未来只能管理一种资产。

建议内部抽象：

```text
RegistryAsset
├── Skill
├── Prompt
├── Tool Descriptor
├── Agent Definition
├── Workflow
└── Knowledge Package
```

V1 MCP API 只暴露 Skill。

未来扩展 Team AI Registry 时，可复用：

- Repository；
- Version；
- Permission；
- Search；
- Audit；
- Sync。

避免重新做第二套 Registry。

---

## 48. Schema Version

Skill Metadata 必须显式支持 schema version。

推荐：

```yaml
schema_version: 1
```

内部解析：

```text
SkillSchemaV1Parser
```

未来：

```text
SkillSchemaV2Parser
```

允许一个过渡期同时读取 V1 和 V2。

不要在新字段出现后直接破坏已有 Skill。

---

## 49. Search Backend 抽象

业务层只依赖：

```text
SkillSearchBackend
```

接口：

```text
index()
remove()
search()
rebuild()
healthCheck()
```

V1：

```text
SQLiteFtsSearchBackend
```

未来：

```text
PostgresFtsSearchBackend
PgVectorSearchBackend
OpenSearchBackend
HybridSearchBackend
```

这样从 FTS5 升级向量检索时不影响 MCP 层。

---

## 50. Routing Strategy 抽象

定义：

```text
SkillRoutingStrategy
```

V1：

```text
KeywordRankingStrategy
```

未来：

```text
SemanticRoutingStrategy
HybridRoutingStrategy
LLMRerankStrategy
RuleBasedRoutingStrategy
ProductSpecificRoutingStrategy
```

Router 本身只负责编排，不直接实现具体评分算法。

---

## 51. Permission Provider 抽象

定义：

```text
PermissionProvider
```

能力：

```text
allowedRepositories()
canListSkill()
canReadSkill()
canReadResource()
```

V1 可以使用：

```text
StaticRolePermissionProvider
```

未来：

```text
LDAPPermissionProvider
OIDCPermissionProvider
CompanyIAMPermissionProvider
TenantPermissionProvider
```

业务代码不能散落大量：

```text
if role === ...
```

---

## 52. Authentication Provider

认证与授权分离。

定义：

```text
AuthenticationProvider
```

V1：

- local development identity；
- reverse proxy header / simple token。

未来：

- OIDC；
- OAuth；
- 企业 SSO；
- mTLS；
- service account。

认证输出统一：

```text
RequestPrincipal
```

再交给 PermissionProvider。

---

## 53. Registry Storage 抽象

Registry 不要直接耦合 SQLite。

定义：

```text
RegistryStore
```

V1：

```text
Memory + SQLite
```

未来：

```text
PostgreSQL
Distributed Registry Store
```

需要明确：

```text
Git Repository = Source of Truth
Registry Store = Derived State
```

即使替换数据库，也不影响 Skill 内容。

---

## 54. Event / Hook 机制

关键生命周期应产生内部事件。

例如：

```text
repository.sync.started
repository.sync.completed
repository.sync.failed
skill.added
skill.updated
skill.deleted
skill.validation.failed
skill.selected
```

V1 可以使用进程内 Event Bus。

未来可扩展：

```text
Webhook
Kafka
NATS
Audit Pipeline
Metrics Pipeline
```

不要让 Analytics、通知、审计逻辑直接侵入 Sync 核心代码。

---

## 55. Resource Resolver

Skill Resource 不应只假设本地文件。

定义：

```text
SkillResourceResolver
```

V1：

```text
RepositoryFileResourceResolver
```

未来可支持：

```text
ArtifactResourceResolver
ObjectStorageResourceResolver
KnowledgeBaseResourceResolver
```

同时必须保持权限检查和路径安全。

---

## 56. 多环境

从 V1 开始区分：

```text
development
staging
production
```

Repository 配置可按环境覆盖：

```text
config/
├── application.yaml
├── application.dev.yaml
├── application.staging.yaml
└── application.prod.yaml
```

不同环境可以：

- 使用不同 Repo；
- 使用不同 Branch；
- 使用不同权限；
- 使用不同 Auth Provider；
- 使用不同 Search Backend。

例如：

```text
staging -> rd-skills/develop
production -> rd-skills/main
```

---

## 57. 多租户预留

V1 不需要实现完整 Multi-Tenant。

但核心数据结构建议预留：

```text
tenantId?
```

至少不要默认全局唯一键只能是：

```text
skill.name
```

推荐逻辑唯一键：

```text
tenant + repository + skill
```

单租户 V1 中 tenant 可以固定为：

```text
default
```

未来客户隔离或 BU 隔离时无需重构全部主键。

---

## 58. 多部署拓扑

V1：

```text
Single Node + Docker Compose
```

架构上应允许以后：

```text
Load Balancer
    ↓
MCP Server x N
    ↓
Shared Registry / DB
    ↓
Shared Repository Cache / Object Storage
```

因此：

- 不依赖单进程内唯一状态作为事实源；
- Sync lock 需要可替换；
- Repository revision 应有稳定 ID；
- MCP 层尽量 stateless；
- cache 可以重建。

---

## 59. MCP/API 版本兼容

对外 MCP Tool 参数不能随意破坏。

推荐原则：

1. 新字段优先 optional；
2. 返回结构新增字段保持向后兼容；
3. Tool 重命名使用过渡期；
4. 重大不兼容变更引入新版本；
5. Server 暴露版本信息。

例如：

```text
get_server_info
```

返回：

```json
{
  "server_version": "1.0.0",
  "skill_schema_versions": [1],
  "capabilities": [
    "fts-search",
    "multi-repository"
  ]
}
```

---

## 60. Capability Discovery

客户端不要假设所有部署都支持所有高级功能。

建议支持 capability discovery：

```text
search
semantic-search
multi-repository
resource-read
webhook-sync
rbac
```

这样未来不同环境、不同版本可以逐步升级。

---

## 61. Migration Strategy

任何 Registry Schema、SQLite Schema、Metadata Schema 变化都必须有 migration 策略。

V1 即建立：

```text
schema_version
db migration version
```

原则：

- Derived Data 可以重建时，优先 rebuild；
- 用户维护的 Git 内容不能自动做不可逆修改；
- Metadata 升级提供 lint/migrate 工具；
- migration 可以 dry-run。

未来可以提供：

```text
skillctl migrate
```

---

## 62. Plugin 架构

不需要 V1 就实现复杂插件框架，但模块边界要允许插件化。

推荐未来扩展点：

```text
RepositoryProviderPlugin
SearchBackendPlugin
RoutingStrategyPlugin
PermissionProviderPlugin
AuthenticationProviderPlugin
ValidationRulePlugin
EventSinkPlugin
```

V1 可以通过 TypeScript interface + dependency injection 实现。

不要一开始做动态 npm 插件加载。

---

## 63. Validation Rule 扩展

Validator 使用规则集合：

```text
ValidationRule[]
```

例如：

```text
RequiredFieldRule
UniqueNameRule
PathTraversalRule
MetadataSchemaRule
OwnerRule
VisibilityRule
```

未来业务团队可以增加：

```text
ProductSpecificRule
SecurityRule
CustomerExportRule
```

无需修改 Validator 主流程。

---

## 64. Observability 扩展

统一抽象：

```text
Logger
Metrics
Tracer
AuditSink
```

V1：

- structured console log；
- basic metrics。

未来：

- OpenTelemetry；
- Prometheus；
- ELK / Loki；
- 企业审计平台。

所有日志应包含稳定维度：

```text
repository
revision
skill
request_id
principal
tenant
```

---

## 65. 避免 V1 写死的清单

V1 开发时禁止以下做法：

- 写死只有 `rd-skills`；
- 写死只有 `main` branch；
- 写死只有 GitLab；
- 写死只有 SQLite；
- 写死只有 FTS；
- 写死角色名称；
- 写死 Skill domain/category；
- 用目录名代替 Metadata；
- 用全局 skill name 作为唯一定位；
- 把 Auth 与 Permission 写进 MCP Tool handler；
- 把 Git 命令写进 Skill Parser；
- 把 Search Ranking 写进 MCP Server；
- 把 Webhook 逻辑直接绑定到某一个 Git Provider；
- 把 Secret 存到 Repo 配置文件。

---

## 66. 推荐核心接口边界

```text
RepositoryProvider
        ↓
RepositorySyncService
        ↓
SkillScanner
        ↓
SkillParser
        ↓
ValidationPipeline
        ↓
RegistryStore
        ↓
SearchBackend
        ↓
RoutingStrategy
        ↓
PermissionProvider
        ↓
MCP Application Service
```

MCP 层只负责：

- 参数校验；
- 调 Application Service；
- 返回协议结果。

不直接承担底层业务实现。

---

## 67. 扩展性验收标准

即使 V1 只实现一套默认实现，也必须能够在不修改核心业务流程的情况下做到：

1. 增加第二个 Skill Repo；
2. 增加 Local Repo Provider；
3. 替换 Search Backend；
4. 增加新的 Routing Strategy；
5. 增加新的 Validation Rule；
6. 增加新的 Permission Provider；
7. 新增 Skill Metadata 字段；
8. 同时解析两个 Schema Version；
9. 新增一个 Event Sink；
10. 单机迁移到多实例部署。

如果以上任何一项需要大规模修改 MCP Tool Handler，则说明模块边界设计不合格。
