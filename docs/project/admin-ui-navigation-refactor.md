# Admin UI 信息架构与多级页面重构任务

> 状态：已完成（核心范围）（已完成观测与 Candidate Review / Knowledge Gaps / Repository Governance 的稳定一级、二级、三级入口及 bounded API；旧 hash UI 仍兼容；Knowledge/Eval/Access legacy migration remains future work）
> 创建时间：2026-10-13
> 目标：解决 Admin UI 随用户数、Session、Hook、Candidate、Knowledge Gap 等数据增长后页面过长、信息拥挤、定位困难的问题。

## 1. 背景

当前实现说明：`/admin/observability` 返回稳定的模块索引；Sessions、Hooks、Candidate detections、MCP calls 使用稳定资源 API（默认分页 20，最大 100），旧 `/admin` hash-tab 入口继续兼容。JSONL 存储仍保留，详情读取保持 bounded scan 语义，不引入数据库。

本轮补充：所有 `/admin/observability/*` pathname 路由使用独立 no-store UI shell，列表通过 URL 驱动服务端过滤/分页，详情直接请求按 ID API。新增 `reuse`（从既有 MCP calls 派生 discover/search/get knowledge/skill 调用）和 `failures`（当前仅失败 MCP calls）稳定列表/详情 API；两者均支持 q/tool/actorId/sessionId/from/to。Candidate Review、Knowledge Gaps、Repository Governance 也已切换为独立 no-store 模块 shell：根路径只展示入口卡片，候选、缺口、仓库治理分别提供列表和按 ID 详情 API；默认分页 20、上限 100，服务端执行状态/关键词过滤。旧 `/admin` hash-tab 入口继续兼容。

当前 Admin Web 多个模块把“统计、筛选、长列表、详情、操作、原始数据”集中在同一个一级页面中。

典型问题：

- `运行观测` 中 Codex Session 数量增长后页面会非常长；
- Hook、自动候选判定、MCP 调用、Evidence 等信息继续增长后会进一步挤压页面；
- Candidate、Knowledge Gap、Repository Governance、Evaluation、Access Control 等模块也存在同类扩展性问题；
- 一级页面承担了过多职责，用户进入模块后很难快速找到真正想看的数据类型；
- 当前部分列表缺少完善的服务端分页、组合过滤、URL 状态保持和详情页。

本次重构原则不是简单“给现有长表加分页”，而是统一 Admin UI 的信息架构。

## 2. 核心设计原则

采用统一的三级结构：

```text
一级：功能清单 / 模块入口 + 少量摘要统计
  ↓
二级：某类数据的筛选 + 分页列表
  ↓
三级：单条记录完整详情
```

### 2.1 一级页面

一级页面不直接展示完整数据列表，只展示该模块下面有哪些能力、每个入口的少量关键摘要统计，以及进入二级页的入口。数据量增加时一级页高度应基本稳定。

示例：

```text
运行观测

[Codex 会话]
26 sessions · 2 active · 1 failure · 最近 16:23

[Hook 执行]
120 executions · 3 failed · 最近 16:20

[自动候选判定]
45 detections · 6 accepted · 12 ignored

[MCP 调用]
1,250 calls · 8 failed

[Knowledge Reuse]
64 reuses · 18 sessions

[错误与失败]
12 unresolved
```

一级页不要渲染完整 Session/Hook/Candidate 表格。

### 2.2 二级页面

二级页面用于某一类资源的检索和列表浏览：服务端分页、多条件过滤、统一搜索、默认按最近时间倒序、行可点击进入三级详情，并通过 URL 保存过滤和分页状态。

### 2.3 三级详情页

三级详情页展示完整信息和关联信息，包括基本元数据、Timeline / Events、关联实体、Evidence、错误、原始数据和必要操作按钮。详情页优先使用稳定 URL，而不是只使用弹窗。

## 3. 运行观测重构

一级入口 `运行观测` 建议包含以下功能清单。

### 3.1 Codex 会话

路由建议：

```text
/admin/observability/sessions
/admin/observability/sessions/:sessionId
```

二级列表支持：User、Repository、Runtime、Event、Status（ALL / ACTIVE / ENDED / FAILED）、开始/结束时间、Project、Session ID、关键字搜索、仅有 MCP 调用、仅有 Evidence、仅有 Knowledge reuse。

列表建议列：

```text
开始时间 | User | Session | Repository | Runtime | Events | MCP | Evidence | Status | 操作
```

要求：

- Session ID 缩短显示，保留复制完整 ID；
- 每页默认 20 条，支持 20 / 50 / 100；
- 默认开始时间倒序；
- 服务端分页，不允许一次加载所有 Session；
- 显示总数或至少稳定的 next/previous cursor；
- 点击行进入详情。

三级 Session 详情至少包含：

```text
Overview
Timeline / Events
MCP Calls
Evidence
Knowledge / Skill Reuse
Errors
Raw Data
```

### 3.2 Hook 执行

路由建议：

```text
/admin/observability/hooks
/admin/observability/hooks/:id
```

二级过滤：Hook 类型、User、Session、Project、Status、是否产生 Candidate、时间范围。

三级详情：trigger、来源、input/output 摘要、执行耗时、成功/失败、错误原因、关联 Session、Candidate、Evidence、Raw Event。

### 3.3 自动候选判定

路由建议：

```text
/admin/observability/candidate-detections
/admin/observability/candidate-detections/:id
```

二级过滤：User、Session、suggestedType、判定结果（candidate / ignored / rejected / duplicate）、repository、sourceType、confidence/score、时间范围。

三级详情重点展示为什么触发自动候选判定、score/confidence、命中/未通过规则、suggestedType、recommended repository、source session/hook/evidence、是否最终创建 Candidate、Candidate ID、被忽略/拒绝原因和原始 detection payload。

目标是让管理员能解释“为什么这一条被系统判定为值得回流”。

### 3.4 MCP 调用

路由建议：

```text
/admin/observability/mcp-calls
/admin/observability/mcp-calls/:id
```

过滤：tool、user、session、repository、success/failure、latency、时间范围。

详情：tool 名称、调用时间、脱敏参数摘要、result 摘要、latency、error、关联 Session、Knowledge / Skill、Raw event。

### 3.5 Knowledge / Skill Reuse

路由建议：

```text
/admin/observability/reuse
/admin/observability/reuse/:id
```

用于回答哪些 Knowledge / Skill 真正被使用、谁在使用、在哪个 Session 使用、discover/get_skill/get_knowledge 链路，以及复用后是否继续产生 Candidate / Feedback。

### 3.6 错误与失败

路由建议：

```text
/admin/observability/failures
/admin/observability/failures/:id
```

聚合 Session failure、Hook failure、MCP failure、Candidate publish failure、Repository sync failure、Evaluation failure，并支持来源类型、时间、用户、仓库、错误关键字过滤。

## 4. 其他一级模块的多级页面设计

### 4.1 候选审核

一级页面改为功能清单：待审核、已批准、已拒绝、发布失败、已发布。

二级显示对应状态 Candidate 列表；三级显示 Candidate 完整详情，包括 title/type/collection、repository/path、完整正文、source/session/trace、Evidence、duplicate/relation、review 信息、publication、PR/MR、reconcile 和审核/发布历史。一级/二级页不要直接展开完整正文。

### 4.2 知识缺口

一级可包含：活跃缺口、已生成 Candidate、已解决、忽略项。

二级支持 query、repository、occurrence、source、status、时间范围、是否有关联 Candidate 等过滤；三级展示 gap key、occurrences、firstSeen/lastSeen、相关 queries、关联 sessions/Evidence/Candidate 和 lifecycle history。

### 4.3 治理

一级建议入口：仓库治理、同步记录、发布记录、PR/MR 状态、配置检查。

仓库治理二级显示 Repository 清单；三级显示 revision、health、branch、provider、last sync、sync history、最近错误、资产数量、publishing config 摘要、最近 Candidate、最近 PR/MR。`立即同步` 可以保留在列表页。

### 4.4 知识库

一级入口建议：Knowledge、Skill、Prompt、Agent、Repository。

二级为资产搜索列表；三级为资产详情，包括 metadata、repository/path、revision/version、正文、最近命中、reuse 统计、来源 Candidate、关联资产。

### 4.5 评测

一级入口：Evaluation Runs、Retrieval Evaluation、Regression、Baselines。

二级为 run 列表；三级展示 evaluation metadata、cases、pass rate、failed cases、asset version、baseline comparison、regression details。

### 4.6 用户反馈

一级可按待处理、已处理、负向反馈、资产反馈拆分；三级详情关联 user、session、Knowledge / Skill、Candidate、原始 feedback 和后续处理动作。

### 4.7 访问控制

一级入口：用户、API Key、Role、Repository 权限。

二级使用列表 + 搜索 + 分页；三级展示 identity、roles、repository access、API key 状态、最近访问、失败访问、audit history。敏感 key 内容不得显示。

### 4.8 系统设置

系统设置不强制使用三级资源页面，更适合 section / tabs，例如 General、Repository、Publishing、Authentication、Observability、Advanced。

## 5. 通用 UI 组件要求

不要为每一个模块重复实现一套列表逻辑，建议统一：

- `ModuleIndex / EntryCard`：title、description、count、warning/failure count、recent timestamp、target route；
- `FilterBar`：keyword、select、date/time range、boolean quick filters、Apply、Clear；
- `Pagination`：默认 20，支持 20/50/100，prev/next，total 可选；
- `DetailPage`：breadcrumb、back link、title、status badge、metadata grid、tabs/sections、raw JSON、related entities；
- `StatusBadge`：成功态、中性态、错误态、进行态统一视觉。

过滤条件必须同步到 URL query，刷新后保持，从三级详情返回二级页时恢复原过滤状态。

## 6. 后端 API 设计要求

必须优先做服务端过滤和分页，避免“API 返回全部数据，浏览器再过滤”。

推荐统一参数：

```text
limit
cursor 或 page
q
status
user
repository
runtime
sourceType
from
until
sort
order
```

特定模块可增加 `hasMcp`、`hasEvidence`、`hasReuse`、`tool`、`suggestedType`、`candidateResult`、`hasCandidate` 等参数。

建议统一返回：

```json
{
  "items": [],
  "page": {
    "limit": 20,
    "nextCursor": "...",
    "previousCursor": "...",
    "total": 123
  }
}
```

如果底层不适合提供 total，则 total 可选，不要为了 total 强制全量扫描大 JSONL。

### 6.1 单条详情 API

不要让三级详情页通过“加载 2000 条再 find(id)”实现。逐步增加按 ID 获取接口，例如：

```text
GET /admin/api/sessions/:id
GET /admin/api/hooks/:id
GET /admin/api/candidate-detections/:id
GET /admin/api/mcp-calls/:id
GET /admin/api/knowledge-candidates/:id
GET /admin/api/knowledge-gaps/:id
GET /admin/api/repositories/:id
```

## 7. 路由实现注意事项

当前 Admin Web 主要由 `src/admin-ui.ts` 输出单页 HTML，需要先评估：

1. 保持单 HTML + hash route：改动小，但 URL 不自然且 `admin-ui.ts` 继续膨胀；
2. 服务端支持 `/admin/*` fallback + History API：推荐优先考虑，可使用 `/admin/observability/sessions/:id`；
3. 如果 `admin-ui.ts` 继续显著膨胀，再评估独立 frontend build。本次不要求强制引入 React/Vue/Next.js。

## 8. 性能与可扩展性要求

目标场景至少考虑：

```text
30+ users
10,000+ sessions
100,000+ MCP/client events
10,000+ Hook records
1,000+ candidates
持续增长的 JSONL observability 数据
```

要求：一级页不能依赖加载全部明细；二级页不能一次返回所有记录；时间过滤尽量服务端完成；搜索有合理上限；详情 API 只读取目标记录；不破坏当前 observability 写入格式；如需索引，必须兼容旧数据。

## 9. 错误处理要求

与 `remaining-work.md` 中 Admin Web API 请求层统一事项协同实现。统一使用 `requestJson()` / `readResponse()`，保证 endpoint 和 HTTP status 可诊断、非 JSON 返回不导致整页崩溃、局部统计失败不阻断其他入口，并统一 loading / empty / error 状态。

## 10. 安全要求

- 不显示 API key/token/Authorization；
- Raw Data 继续使用服务端脱敏结果；
- URL query 不得放 token；
- 用户只能看到有权限访问的 Repository 相关记录；
- 三级详情 API 必须执行与列表相同的权限检查；
- MCP 参数和 Hook payload 继续脱敏。

## 11. 推荐实施顺序

### Phase 1：公共框架

Admin `/admin/*` routing、ModuleIndex/EntryCard、FilterBar、Pagination、DetailPage、StatusBadge、URL query state、统一 requestJson/readResponse。

### Phase 2：运行观测

Codex Sessions -> Hook Executions -> Candidate Detections -> MCP Calls -> Knowledge Reuse -> Failures。

### Phase 3：Candidate / Gap

候选审核、Knowledge Gap、用户反馈。

### Phase 4：Governance / Knowledge / Eval / Access

Repository Governance、Knowledge / Skill、Evaluation、Access Control。

### Phase 5：清理旧 UI

删除被新二级页替代的旧长表和重复筛选/分页逻辑，清理无用 CSS/JS，更新 Admin 用户文档。

## 12. 兼容要求

- 现有 `/admin` 入口继续可用；
- API Key Admin Authentication 不变；
- Repository sync / publish / review 等现有操作能力不丢失；
- 现有数据无需人工迁移即可查看；
- 旧 API 在新 UI 切换完成前不要过早删除；
- 页面缓存继续保持 `no-store`。

## 13. 测试要求

Backend 至少覆盖分页、搜索、组合过滤、时间过滤、单条详情 404、ACL、Admin access denied、大数据量返回上限。

Frontend/HTML 至少覆盖一级入口、一级无长列表、二级列表加载、Apply/Clear、URL query 恢复、Pagination、detail navigation、Back 恢复过滤、empty/error/loading、状态 badge。

WSL2 Docker 真实 smoke 至少验证：

```text
/admin
/admin/observability
/admin/observability/sessions
/admin/observability/sessions/:id
```

并验证真实 Session、ACTIVE/ENDED、MCP/Evidence，以及分页不会造成页面无限增长。

## 14. 非目标

暂不要求为了 UI 重构迁移 Observability 到大型数据库、强制引入前端框架、重写 MCP/Knowledge 核心逻辑、改变 Candidate 审核策略、改变 Repository 配置格式或引入复杂图表库。

## 15. 完成标准

- `运行观测` 一级页只显示功能清单和摘要，不再显示长 Session 表；
- Codex Session、Hook、自动候选判定至少形成“一级入口 -> 二级列表 -> 三级详情”；
- 二级列表使用服务端过滤和分页；
- URL 可保存筛选条件；
- 单条详情不通过加载全量列表实现；
- 候选审核、Knowledge Gap、治理等主要模块迁移到相同信息架构，或至少完成明确迁移入口；
- 30+ 用户、万级 Session 情况下 Admin 页面不会因 DOM 全量渲染持续增长；
- Docker build、相关测试和实际 Admin smoke test 通过；
- 更新用户/Admin 文档。

## 16. 新会话建议提示词

```text
使用 WebCodex，在 team-skill-hub 项目中实现 docs/project/admin-ui-navigation-refactor.md。

要求：
1. 使用 WSL2 Ubuntu-24.04 完成测试、构建、Git 操作。
2. 先阅读该文档和当前 src/admin-ui.ts、src/server.ts、observability/admin API 实现，再给出分阶段改造计划。
3. 不要一次性盲目重写 Admin UI，先建立公共 routing/filter/pagination/detail 基础，再优先实现运行观测：Codex 会话、Hook、自动候选判定。
4. 一级页面只显示功能清单和摘要统计，不直接显示长数据列表。
5. 二级页面使用服务端分页和过滤；三级页面提供单条详情。
6. 保持当前 Admin auth、ACL、Repository sync、Candidate review/publish 等行为兼容。
7. 每个阶段使用 WSL2 Docker 验证，确认无回归后再继续。
8. 实现完成后 review diff，再 commit + push。
```
