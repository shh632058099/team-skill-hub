# Team Skill Hub 代码改动计划

## 1. 目标

本计划用于把当前设计方案落地成可运行的 V1。

V1 至少包含两个可独立管理的工程：

```text
team-skill-hub/
rd-skills/
```

其中：

- `team-skill-hub`：MCP Server、Repo Sync、Skill Registry、Search、Router、Permission、Docker 部署；
- `rd-skills`：研发团队共享 Skill 的独立 Git Repository；
- `rd-skills` 中至少包含一个完整示例 Skill；
- Codex 通过 MCP 使用 Team Skill Hub，不直接依赖本地 Skill 文件。

---

# 2. V1 最终目录关系

建议两个 Repo 在本机保持平级：

```text
D:\wsl\.codex\workspace\skill-hub-workspace\
├── team-skill-hub/
└── rd-skills/
```

逻辑关系：

```text
rd-skills Git Repo
       │
       │ clone / fetch
       ▼
team-skill-hub
       │
       ├── scan
       ├── validate
       ├── index
       ├── search
       └── resolve
       │
       ▼
MCP /mcp
       │
       ▼
Codex
```

---

# 3. Team Skill Hub 计划目录

目标目录：

```text
team-skill-hub/
├── apps/
│   └── mcp-server/
│       ├── src/
│       │   ├── index.ts
│       │   ├── server.ts
│       │   ├── routes/
│       │   │   ├── health.ts
│       │   │   └── webhook.ts
│       │   └── mcp/
│       │       └── tools.ts
│       └── package.json
│
├── packages/
│   ├── repository/
│   │   └── src/
│   │       ├── types.ts
│   │       ├── repository-manager.ts
│   │       └── git-repository-provider.ts
│   │
│   ├── git-sync/
│   │   └── src/
│   │       ├── sync-service.ts
│   │       ├── revision-manager.ts
│   │       └── webhook-handler.ts
│   │
│   ├── skill-parser/
│   │   └── src/
│   │       ├── scanner.ts
│   │       ├── parser.ts
│   │       ├── validator.ts
│   │       └── schema.ts
│   │
│   ├── registry/
│   │   └── src/
│   │       ├── registry.ts
│   │       ├── skill-store.ts
│   │       └── repository-store.ts
│   │
│   ├── search/
│   │   └── src/
│   │       ├── fts-index.ts
│   │       ├── search-engine.ts
│   │       └── ranking.ts
│   │
│   ├── router/
│   │   └── src/
│   │       └── skill-router.ts
│   │
│   └── permissions/
│       └── src/
│           └── permission-service.ts
│
├── config/
│   ├── repositories.example.yaml
│   └── application.example.yaml
│
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── unit/
│
├── docs/
│   ├── team-skill-hub-design.md
│   └── implementation-plan.md
│
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── package.json
├── tsconfig.json
└── README.md
```

---

# 4. Phase 1：项目骨架

## 4.1 初始化 TypeScript workspace

新增：

```text
package.json
tsconfig.json
apps/
packages/
```

建议使用 npm workspace。

根 `package.json` 至少提供：

```json
{
  "scripts": {
    "build": "...",
    "test": "...",
    "lint": "...",
    "dev": "...",
    "start": "..."
  }
}
```

### 验收

```bash
npm install
npm run build
npm test
```

均可执行。

---

# 5. Phase 2：Repository Abstraction

先实现 Repo，再实现 Skill。

## 5.1 Repository 类型

定义：

```ts
interface SkillRepositoryConfig {
  id: string;
  name: string;
  gitUrl: string;
  branch: string;
  audience: string[];
  visibility: string[];
  enabled: boolean;
}
```

定义运行状态：

```ts
interface SkillRepositoryState {
  currentCommit?: string;
  lastGoodCommit?: string;
  lastSyncAt?: string;
  status: "healthy" | "syncing" | "error" | "disabled";
  skillCount: number;
}
```

## 5.2 RepositoryManager

职责：

- 加载 `repositories.yaml`；
- 注册所有 Repo；
- 根据 user/context 返回允许访问的 Repo；
- 查询 Repo 健康状态；
- 触发 Repo 同步。

## 5.3 GitRepositoryProvider

职责：

- clone；
- fetch；
- resolve branch -> commit；
- checkout revision；
- 获取 Git metadata；
- 不执行 push。

### 验收

给定本地或测试 Git Repo，能够：

```text
clone
→ resolve HEAD
→ 获取 commit SHA
```

---

# 6. Phase 3：Revision 与同步

## 6.1 Revision 目录

```text
/var/lib/team-skill-hub/
└── repositories/
    └── rd-skills/
        ├── revisions/
        │   ├── <commit-a>/
        │   └── <commit-b>/
        └── current
```

## 6.2 同步流程

```text
fetch
  ↓
resolve commit
  ↓
如果已加载该 commit -> no-op
  ↓
checkout temp revision
  ↓
scan
  ↓
validate
  ↓
build index
  ↓
atomic activate
```

## 6.3 Last Known Good

如果：

```text
新 Skill 校验失败
```

则：

```text
current 不切换
lastGoodCommit 不变化
repo.status = error
```

服务继续提供旧 Skill。

### 验收

构造错误 `SKILL.md`，验证线上仍读取旧 Revision。

---

# 7. Phase 4：Skill Scanner / Parser

## 7.1 Scanner

递归查找：

```text
**/SKILL.md
```

忽略：

```text
.git/
node_modules/
build/
dist/
```

## 7.2 Parser

解析：

- YAML frontmatter；
- Markdown body；
- Skill 相对路径；
- references/examples/scripts/assets。

## 7.3 Skill Model

```ts
interface Skill {
  name: string;
  version?: string;
  description: string;

  repositoryId: string;
  repositoryCommit: string;
  path: string;

  audience: string[];
  domain: string[];
  category: string[];
  keywords: string[];
  visibility: string[];

  maturity: string;
  owner: string;
  priority: number;
}
```

---

# 8. Phase 5：Skill Validation

V1 验证：

- SKILL.md 存在；
- frontmatter 可解析；
- name 必填；
- name 在 Repo 内唯一；
- description 必填；
- owner 必填；
- maturity 在允许集合中；
- audience/domain/category/keywords 类型正确；
- resource path 不允许越过 Skill 目录；
- 禁止 `../` path traversal；
- Repo 权限不可被 Skill Metadata 放宽。

失败必须给出：

```text
repository
skill path
validation error
```

---

# 9. Phase 6：Skill Registry

Registry 为当前激活 Revision 建立内存/SQLite 视图。

核心接口：

```ts
listRepositories(context)
listSkills(context, filter)
getSkill(context, repository, name)
getSkillResource(context, repository, name, resource)
```

所有方法必须经过权限层。

---

# 10. Phase 7：SQLite FTS5 Search

V1 不引入 Vector DB。

建立 FTS 字段：

```text
name
description
keywords
domain
category
product
```

接口：

```ts
searchSkills(context, query, filters, topK)
```

流程：

```text
Identity
  ↓
Allowed Repositories
  ↓
Metadata Filter
  ↓
FTS5
  ↓
Ranking
```

权限必须先于 Search。

---

# 11. Phase 8：Skill Router

实现：

```text
resolve_skill
```

第一版不调用额外 LLM。

评分：

```text
score =
  FTS score
  + exact keyword bonus
  + domain bonus
  + category bonus
  + priority bonus
  + maturity bonus
```

返回：

```json
{
  "selected_skill": "ota-code-review",
  "repository": "rd-skills",
  "confidence": 0.94,
  "alternatives": [
    "generic-code-review"
  ]
}
```

---

# 12. Phase 9：MCP Server

通过官方 MCP SDK 实现 Streamable HTTP。

默认：

```text
http://localhost:8080/mcp
```

V1 Tools：

```text
list_skill_repositories
list_skills
search_skills
resolve_skill
get_skill
get_skill_resource
```

## 12.1 list_skill_repositories

只返回用户可访问 Repo。

## 12.2 list_skills

支持 repository/domain/category/audience/maturity filter。

## 12.3 search_skills

主要用于检索。

## 12.4 resolve_skill

用于自动选择。

## 12.5 get_skill

只在确定需要 Skill 后加载完整 `SKILL.md`。

## 12.6 get_skill_resource

按需加载 reference/example/resource。

---

# 13. Phase 10：HTTP / Webhook / Health

HTTP Endpoint：

```text
POST /mcp
POST /webhooks/git
GET  /health/live
GET  /health/ready
```

Webhook：

- 校验 Secret / Signature；
- 校验 Repo；
- 校验 Branch；
- 重复事件幂等；
- 触发异步 Repo Sync；
- 如果同步失败继续保留 Last Known Good。

---

# 14. Phase 11：Docker

新增：

```text
Dockerfile
.dockerignore
docker-compose.yml
```

Dockerfile：

- multi-stage；
- Node runtime；
- git client；
- non-root；
- healthcheck；
- 不包含 Skill Repo 和 Secret。

Docker Compose：

```yaml
services:
  team-skill-hub:
    build: .
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./config:/app/config:ro
      - skill-hub-data:/var/lib/team-skill-hub

volumes:
  skill-hub-data:
```

验收：

```bash
docker compose up -d --build
docker compose ps
```

服务应为 healthy。

---

# 15. Phase 12：示例研发 Skill Repo

新建独立 Repo：

```text
rd-skills
```

不要放到 `team-skill-hub` 内。

初始目录：

```text
rd-skills/
├── ota/
│   └── code-review/
│       ├── SKILL.md
│       ├── references/
│       │   └── review-checklist.md
│       └── examples/
│           └── example.md
│
├── schemas/
│   └── skill.schema.json
├── templates/
│   └── SKILL.template.md
├── CODEOWNERS
└── README.md
```

---

# 16. 示例 Skill：ota-code-review

文件：

```text
rd-skills/ota/code-review/SKILL.md
```

计划内容：

```yaml
---
name: ota-code-review
version: 1.0.0
description: >
  Review an OTA implementation with focus on unnecessary APIs,
  excessive call chains, redundant abstractions, dead code,
  maintainability and deletion risk.

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
    - ota
    - api
    - interface
    - code review
    - simplify
    - refactor
    - call chain
    - dead code
    - 接口
    - 删除
    - 精简
    - 调用链
    - 代码审查

  visibility:
    - internal

  maturity: stable
  owner: ota-team
  priority: 90
---
```

正文至少要求 Agent：

1. 先理解 OTA 模块边界；
2. 找出可删除接口；
3. 找出可缩短调用链；
4. 找出重复抽象；
5. 找出 dead code；
6. 每个删除建议必须说明风险；
7. 不允许只因为接口当前引用少就判断可删除；
8. 输出具体文件、符号、调用路径和理由；
9. 按风险分成 Low / Medium / High；
10. 优先给出最小改动方案。

---

# 17. 示例 Skill Resource

`references/review-checklist.md`：

```text
API necessity
Call-chain length
Duplicate abstraction
Error handling
State ownership
Compatibility
Public API impact
Test coverage
Rollback risk
```

用于验证 `get_skill_resource`。

---

# 18. rd-skills CI

第一版 CI：

```text
lint
validate
duplicate-name-check
resource-path-check
```

后续增加：

```text
security-check
skill tests
quality evaluation
```

---

# 19. 开发阶段本地配置

`team-skill-hub/config/repositories.yaml`：

```yaml
repositories:
  - id: rd-skills
    name: R&D Skills

    # 开发阶段可以先指向本地 Git Repo，
    # 集成阶段切换为 GitLab/GitHub SSH URL。
    git_url: file:///D:/wsl/.codex/workspace/skill-hub-workspace/rd-skills
    branch: main

    audience:
      - developer

    visibility:
      - internal

    sync:
      webhook: false
      polling_interval: 300
```

Docker 场景不建议直接依赖 Windows host path。

Docker 集成测试优先使用：

- 一个实际远程测试 Repo；或
- Compose 中专门准备的 Git fixture。

---

# 20. Codex 使用方式

## 20.1 启动 Team Skill Hub

在：

```text
D:\wsl\.codex\workspace\skill-hub-workspace\team-skill-hub
```

执行：

```bash
docker compose up -d --build
```

确认：

```bash
docker compose ps
```

以及：

```text
http://localhost:8080/health/ready
```

返回 ready 后再连接 Codex。

---

# 21. Codex 添加 MCP Server

Codex CLI 和 Codex IDE 共用 MCP 配置。

推荐直接通过 CLI：

```bash
codex mcp add teamSkillHub --url http://localhost:8080/mcp
```

然后验证：

```bash
codex mcp list
```

应该可以看到：

```text
teamSkillHub
```

也可以手工编辑：

```text
~/.codex/config.toml
```

增加：

```toml
[mcp_servers.teamSkillHub]
url = "http://localhost:8080/mcp"
```

如果只希望某一个项目使用，也可以在受信任项目下配置：

```text
.codex/config.toml
```

内容相同。

---

# 22. 让 Codex 自动使用 Skill Hub

建议在研发项目的 `AGENTS.md` 中增加：

```text
When a task could benefit from team-specific engineering knowledge,
use the teamSkillHub MCP server before starting substantial work.

First use search_skills or resolve_skill with the user's task.
If a suitable skill is found, load it with get_skill and follow it.
Load referenced skill resources only when needed.

Prefer a domain-specific team skill over a generic skill when both apply.
Do not load every skill eagerly.
```

对应中文可以写：

```text
处理研发任务时，如果团队 Skill 可能提供领域知识，
优先使用 teamSkillHub MCP。

先通过 search_skills 或 resolve_skill 根据当前任务选择 Skill。
命中合适 Skill 后再使用 get_skill 加载完整内容。
只有 Skill 明确需要时才继续加载 references/resources。

不要一次性加载所有 Skill。
存在领域专用 Skill 时优先于通用 Skill。
```

---

# 23. Codex 手工指定用法

用户可以直接告诉 Codex：

```text
使用 teamSkillHub 查找适合当前 OTA 代码精简 Review 的 Skill，
加载后按照 Skill 要求 review 当前仓库。
```

预期流程：

```text
Codex
  ↓
resolve_skill(
  "OTA 代码精简 Review..."
)
  ↓
rd-skills / ota-code-review
  ↓
get_skill(...)
  ↓
读取 SKILL.md
  ↓
必要时 get_skill_resource(...)
  ↓
Review 当前代码
```

---

# 24. Codex 自动选择示例

用户输入：

```text
review 一下当前 OTA 实现，
看看有没有没必要的接口，以及可以缩短的调用链，
每个建议给出删除风险。
```

Codex 应自动调用：

```text
resolve_skill
```

Router 返回：

```json
{
  "selected_skill": "ota-code-review",
  "repository": "rd-skills",
  "confidence": 0.95
}
```

然后：

```text
get_skill(
  repository = "rd-skills",
  name = "ota-code-review"
)
```

再按照 Skill 规则执行代码 Review。

---

# 25. Codex 查看已有 Skill

可以问：

```text
通过 teamSkillHub 列出我可以使用的 OTA 相关研发 Skill。
```

对应：

```text
list_skills(
  repository = "rd-skills",
  domain = "ota"
)
```

---

# 26. Codex 搜索 Skill

可以问：

```text
通过 teamSkillHub 搜索和 Yocto CVE 管理相关的 Skill。
```

对应：

```text
search_skills(
  query = "Yocto CVE 管理"
)
```

如果不存在：

```text
No Skill Found
```

后续可根据搜索日志决定是否新增该 Skill。

---

# 27. Codex 与 Skill 更新

开发者修改：

```text
rd-skills/ota/code-review/SKILL.md
```

Merge 到 main 后：

```text
Webhook
  ↓
team-skill-hub fetch
  ↓
validate
  ↓
re-index
  ↓
activate
```

Codex MCP 配置：

```text
无需修改
```

Codex：

```text
无需重新安装 Skill
```

下一个任务通过 `get_skill` 就会读取最新激活版本。

---

# 28. Codex 开发模式

本地开发时：

```bash
npm run dev
```

如果 MCP 暴露：

```text
http://localhost:8080/mcp
```

则 Codex MCP 配置无需变化。

Docker / Native dev 可以使用同一地址。

---

# 29. V1 测试场景

## Case 1：正常搜索

Prompt：

```text
查找 OTA code review Skill。
```

预期：

```text
ota-code-review
```

## Case 2：自动路由

Prompt：

```text
检查 OTA 调用链和多余 API。
```

预期：

```text
resolve -> ota-code-review
```

## Case 3：加载 Resource

Skill 要求读取：

```text
references/review-checklist.md
```

预期：

```text
get_skill_resource
```

## Case 4：Skill 更新

修改 Skill 后 Merge。

预期：

```text
无需重启 Codex
无需重建 Skill Hub Image
下一次读取自动为新版本
```

## Case 5：坏 Skill

提交非法 Metadata。

预期：

```text
新 revision rejected
旧 Skill 继续可用
```

## Case 6：权限

Customer 身份访问 internal Skill。

预期：

```text
list/search/get 均不可见
```

---

# 30. 实现顺序

建议严格按以下顺序：

```text
1. Project skeleton
2. Repository config/model
3. Git clone/fetch
4. Revision Manager
5. Skill Scanner
6. Skill Parser
7. Skill Validator
8. Skill Registry
9. SQLite FTS5
10. Permission filter
11. MCP list/get
12. MCP search
13. resolve_skill
14. Health API
15. Webhook
16. Dockerfile
17. docker-compose
18. rd-skills example repo
19. ota-code-review example
20. Codex end-to-end test
```

---

# 31. 建议提交拆分

为了方便 Review，建议不要一个 Commit 完成全部功能。

推荐：

```text
commit 1
chore: initialize TypeScript workspace

commit 2
feat: add skill repository abstraction

commit 3
feat: add git repository sync and revision manager

commit 4
feat: add skill scanner parser and validation

commit 5
feat: add skill registry and sqlite search

commit 6
feat: add MCP skill tools

commit 7
feat: add skill routing

commit 8
feat: add webhook and health endpoints

commit 9
build: add Docker and Docker Compose deployment

commit 10
docs: add Codex integration guide
```

`rd-skills` 独立 Repo：

```text
commit 1
chore: initialize shared R&D skill repository

commit 2
feat: add ota-code-review example skill

commit 3
ci: add skill validation
```

---

# 32. V1 Definition of Done

只有满足以下条件才算 V1 完成：

- `team-skill-hub` 和 `rd-skills` 是独立 Repo；
- `rd-skills` 至少存在 `ota-code-review` 示例 Skill；
- Team Skill Hub 能 clone/fetch `rd-skills`；
- 能扫描并验证 SKILL.md；
- 能建立 FTS 索引；
- 能 list/search/resolve/get Skill；
- 能按需读取 resource；
- Skill 权限不可绕过；
- 新坏 Revision 不影响 Last Known Good；
- 支持 Docker Compose 一键部署；
- `/health/ready` 可用于容器健康检查；
- Codex 可以通过 `codex mcp add ... --url ...` 接入；
- Codex 能根据自然语言自动找到 `ota-code-review`；
- 更新 `rd-skills` 后无需重新部署 MCP Server；
- 更新 MCP Server 后无需修改 `rd-skills`；
- 关键路径有自动化测试。

---

# 33. 第一轮建议实际开发范围

第一轮编码建议只完成：

```text
team-skill-hub
├── project skeleton
├── Repository abstraction
├── local/remote Git sync
├── Skill scanner/parser/validator
├── in-memory registry
├── basic search
├── MCP list/search/get
├── health
├── Docker
└── Docker Compose
```

同时新建：

```text
rd-skills
└── ota/code-review/SKILL.md
```

第一轮先把以下链路完全跑通：

```text
rd-skills
   ↓
Team Skill Hub
   ↓
search_skills
   ↓
get_skill
   ↓
Codex
```

之后第二轮再增加：

```text
Webhook
Last Known Good
RBAC
resolve_skill ranking
usage analytics
```

这样能够最快获得一个真正可用的端到端 MVP。

---

# 34. 扩展性实现约束

后续编码必须把扩展点落实为接口，不允许仅写在设计文档中。

第一轮至少定义以下接口：

```ts
interface SkillRepositoryProvider {}
interface RegistryStore {}
interface SkillSearchBackend {}
interface SkillRoutingStrategy {}
interface PermissionProvider {}
interface AuthenticationProvider {}
interface SkillResourceResolver {}
interface ValidationRule {}
interface EventSink {}
```

V1 可以只有一个实现，但调用方只依赖接口。

---

# 35. 推荐 Provider 实现

V1：

```text
SkillRepositoryProvider
└── GitRepositoryProvider

SkillSearchBackend
└── SQLiteFtsSearchBackend

SkillRoutingStrategy
└── KeywordRankingStrategy

PermissionProvider
└── StaticRolePermissionProvider

AuthenticationProvider
└── DevelopmentAuthenticationProvider

SkillResourceResolver
└── RepositoryFileResourceResolver

RegistryStore
└── SQLiteRegistryStore
```

未来替换实现时不修改 MCP tools。

---

# 36. 配置驱动而非代码驱动

以下内容必须由配置决定：

- Repository 列表；
- Git URL；
- Branch；
- Sync 周期；
- Search Backend；
- Routing Strategy；
- Auth Provider；
- Permission Provider；
- 数据目录；
- MCP/HTTP 端口。

禁止因为增加第二个 Repo 而修改 TypeScript 业务代码。

---

# 37. 数据模型预留

Repository / Skill 数据模型至少预留：

```ts
tenantId?: string;
schemaVersion: number;
repositoryId: string;
revision: string;
```

Skill 唯一定位不要只使用：

```text
name
```

使用：

```text
tenantId + repositoryId + name
```

V1 tenantId 可以固定为 `default`。

---

# 38. Skill Schema 演进

示例 Skill 增加：

```yaml
schema_version: 1
```

Parser 必须根据版本选择解析器。

不要让未来 schema V2 直接覆盖 V1 行为。

计划实现：

```text
SkillSchemaParser
├── SkillSchemaV1Parser
└── future SkillSchemaV2Parser
```

---

# 39. Validation Pipeline

不要写成单个巨大 `validateSkill()`。

使用：

```ts
ValidationRule[]
```

V1 Rules：

```text
MetadataSchemaRule
RequiredFieldsRule
UniqueSkillNameRule
PathTraversalRule
RepositoryVisibilityRule
OwnerRule
```

未来可以按产品动态增加 Rule。

---

# 40. Event Bus

第一版增加轻量内部 Event Bus。

事件：

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

V1 Event Sink：

```text
LoggingEventSink
```

未来：

```text
MetricsEventSink
AuditEventSink
WebhookEventSink
KafkaEventSink
```

---

# 41. Application Service 层

MCP Tool Handler 不直接操作：

- Git；
- SQLite；
- Filesystem；
- Permission DB。

增加：

```text
SkillHubApplicationService
```

提供：

```ts
listRepositories()
listSkills()
searchSkills()
resolveSkill()
getSkill()
getSkillResource()
```

MCP Server 只是协议适配层。

这样未来还可以同时提供：

```text
REST API
CLI
Web Admin
```

而不复制业务逻辑。

---

# 42. Capability 与版本接口

V1 增加：

```text
get_server_info
```

返回：

```json
{
  "server_version": "1.0.0",
  "skill_schema_versions": [1],
  "capabilities": [
    "multi-repository",
    "fts-search",
    "resource-read"
  ]
}
```

未来客户端根据 capabilities 决定是否调用高级功能。

---

# 43. 多环境实现

配置至少支持：

```text
development
staging
production
```

允许：

```text
development -> local rd-skills
staging     -> rd-skills/develop
production  -> rd-skills/main
```

Docker Compose 通过环境变量指定：

```text
APP_ENV=production
```

---

# 44. 扩展性测试

除功能测试外增加架构测试场景：

## Case A：第二个 Repo

新增 `common-skills` 配置，不修改业务代码即可被扫描和搜索。

## Case B：替换 Search Backend

测试用 MemorySearchBackend 替换 SQLite，不修改 MCP handlers。

## Case C：新增 Validation Rule

增加测试 Rule，不修改 Validator Pipeline。

## Case D：新增 Routing Strategy

增加测试 Strategy，不修改 `resolve_skill` MCP handler。

## Case E：Schema V2 Fixture

保证 Parser Registry 可以并存多个 schema parser。

---

# 45. 第一轮编码额外要求

虽然第一轮只做 MVP，也必须完成以下“扩展性骨架”：

```text
Provider interfaces
Application Service
Validation Pipeline
Event Bus
schema_version
capability discovery
config-driven repository list
```

这些实现可以很轻，但不能等 V2 再重构。

V1 的原则是：

> 功能做少，边界做对。
