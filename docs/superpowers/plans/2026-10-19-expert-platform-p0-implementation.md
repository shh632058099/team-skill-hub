# Expert Platform 独立评审与 P0 实施计划

> 日期：2026-10-19
> 状态：基于当前代码的评审与实施计划；尚未开始实现。
> 主设计：`docs/superpowers/specs/2026-10-19-expert-platform-design.md`
> 工作方式：按任务逐步实施，优先测试先行；本计划本身不授权部署、提交或推送。

## 1. 评审结论

总体方向可行：继续复用现有 Team Skill Hub 的 MCP、Skill / Knowledge 检索、候选审核、Skill Bundle 发布、身份入口和 SQLite 持久化能力；新增 Expert Worker、Runtime Adapter、任务状态机、工作区管理和受控工具执行能力。

但不应把 33 项决策一次性全部实现。P0 应聚焦**一个 Hub、一个获准 Worker、一种 Expert、一种 Runtime Adapter、一个仓库**的真实端到端闭环。多专家 DAG、通用插件市场和复杂资源调度按后续阶段扩展。

### 1.1 当前代码证据

| 主题 | 代码证据 | 当前结论 |
|---|---|---|
| MCP 工具入口 | `src/mcp.ts:92-148` | 已有统一 MCP handler、调用审计和 Trace 注入，可作为新增任务工具的入口。 |
| Agent 资产 | `src/artifacts.ts:110-135`、`src/types.ts:180-197` | `AGENT.yaml` 被解析为目录资产，描述 Skill / Prompt / Tool 引用；它不是执行中的 Expert Worker。 |
| 知识候选 | `src/mcp.ts:801-838`、`src/application.ts:3328-3359` | 已有 Knowledge-only Candidate API、校验和人工审核流程；Skill 输入会被拒绝。 |
| Skill Bundle | `src/mcp.ts:840+`、`src/skill-bundle-service.ts`、`src/storage/skill-bundle-repository.ts` | 已有独立的 Bundle-first Skill 提交、快照、审核和发布流程，应直接复用。 |
| 数据库 | `src/storage/database.ts:5-143` | 当前迁移版本为 1–5，覆盖观测、Candidate 历史、Skill Bundle 等表；尚无 ExpertTask / Worker / WorkflowRun 的持久化模型。 |
| 身份与权限 | `src/types.ts:371-375`、`src/security.ts:38-68` | 当前 Principal 主要由 `id`、`roles`、`tenantId` 组成；权限以角色、仓库和可见性为主。不能直接等同于 Expert ACL 或 Workflow 委托授权。 |
| 工具政策 | `src/policy.ts:1-104` | 现有规则可作为安全信号，但基于命令字符串的模式匹配不能替代 Worker 侧的工具 allowlist、OS 权限和服务端授权。 |
| Hub 入口与部署 | `src/index.ts:18-60`、`docker-compose.yml:1-37`、`deploy-local-wsl2.sh:1-31` | 当前是单个 Hub 服务；本地部署脚本只重建 Hub 并检查 readiness。Worker 进程及其生命周期尚需设计。 |
| 测试基础 | `package.json:10-20`，`tests/` | 使用 Node test runner、TypeScript / tsx，已有 MCP、候选、Bundle、SQLite 迁移和发布测试，可沿用当前测试风格。 |

### 1.2 必须先处理的设计问题

1. **事件流决策不一致。** 设计第 14.1 节允许把 gRPC streaming / WebSocket 留待决定；第 20.2 节又说事件订阅可后续增加，但已确认的决策 #32 是“控制 RPC + 服务端事件流”。实施前应统一为：P0 必须提供控制 RPC、服务端事件流、事件序号 / 游标和断线补拉；具体传输实现经最小兼容性验证后固定，不能把事件流整体延期。
2. **P0 范围过宽。** 当前 P0 同时涵盖注册、权限、Runtime、工作区、工具、知识快照、PR、重试、取消和观测。必须先验证 Agent CLI 的非交互执行、输出采集、进程树取消与认证，再分任务实现；否则可能在核心 Runtime 不满足要求时先建完一套无法运行的队列。
3. **Worker 注册信任链未具体化。** “自助注册、管理员审核”还需定义一次性 Enrollment 凭证、Worker 独立身份、凭证轮换 / 撤销、心跳和激活前拒绝领取任务。不得把个人 API Key 或管理员密钥复制到 Worker / Adapter。
4. **单实例与数据库边界需明确。** 当前服务采用 SQLite / WAL 和版本化迁移。P0 应先按单 Hub 实例、单权威数据库设计原子领取与租约；不能默认多个 Hub 副本共享本地 SQLite。需要水平扩展时再评估 PostgreSQL / 独立队列。
5. **Artifact 不能复用 Skill Bundle 文件表充当通用制品库。** 当前 Bundle 快照存的是待审核 Skill 文件。P0 仅登记 Git commit、PR、测试报告、日志等引用与摘要；镜像、大日志等实际内容放在获准的 Git / CI / 制品存储，不经 MCP 或 Hub 中转。
6. **现有 Agent / Tool Registry 是目录能力，不是执行授权。** P0 的实际执行必须由 Deployment 的 Tool Binding + Worker allowlist + 服务端 ACL 共同决定，不能因为 `AGENT.yaml` 或 `TOOL.yaml` 声明了能力就自动授予权限。
7. **三层作用域与当前身份模型有差异。** P0 可只部署一个组织 / 团队 / 项目，但新实体应预留明确的 `scope_type` / `scope_id`；不能把现有 `tenantId` 直接当作完整的组织 / 团队 / 项目授权体系。

## 2. P0 的交付边界

### 2.1 P0 必须交付

- Worker 可申请注册，管理员审核后激活；被暂停 / 撤销的 Worker 不再领取新任务。
- Hub 持久化任务、幂等键、Attempt、状态迁移和事件；重启后状态可恢复。
- Worker 主动出站连接 Hub，断线后可重连、补拉事件 / 状态；任务事实不依赖内存队列或长连接。
- 一个已批准 ExpertDeployment 可通过一个固定版本的 Runtime Adapter 执行任务。
- 每个 TaskRun 有独立 Workspace，执行工具通过明确 allowlist 授权。
- MCP 提供异步提交、状态查询、结果读取和取消；提交立即返回任务标识。
- Worker 在授权范围内获取现有 Skill / Knowledge，并记录使用的 revision / 内容摘要。
- 可自动完成诊断、修改、构建、测试和创建工作分支 / PR；**不能合入受保护分支**。
- 关键状态迁移、Runtime / Tool 结果和 PR / 测试证据可关联到 Trace / Audit。
- 有自动化回归测试，以及在 WSL2 / Docker 环境中的真实部署和至少一次真实 Runtime 端到端验证。

### 2.2 P0 明确不交付

- OTA → Yocto 等多专家 DAG、动态增加节点和并行 Join Gate（P1）。
- 多种 Runtime 同时上线；先验证候选，再选择一种作为首个生产 Adapter，其他 Adapter 后续接入。
- 通用插件市场的完整 UI、第三方插件自助发布与复杂签名供应链流程（P2）；P0 仍需固定 Adapter 版本并校验其允许状态。
- 通用大文件 Artifact Store、镜像复制 / 传输；P0 只交接引用、摘要和获授权的下载位置。
- 完整多租户管理 UI、复杂组织成员管理、通用硬件实验室调度（后续阶段）。
- 任意 Shell / 任意文件系统访问；所有工具调用必须由 Worker 的受限能力边界控制。

## 3. P0 实施顺序

### Task 0：Runtime 可行性验证与协议冻结

**目的：** 先证明至少一种 Runtime 可以在目标 Worker 环境中真正运行，再建设依赖它的基础设施。

**检查 / 产出：**
- 对 Codex CLI 与 Claude Code 做同一组最小实验：非交互启动、指定 Workspace、输入任务、收集结构化输出 / 退出码、采集日志、设置超时、取消进程树、确认凭证不泄露。
- 确认 gRPC + Protocol Buffers 在 Node.js 24 和目标 Windows / WSL2 / Linux 环境中的生成、打包与版本兼容方式。
- 定义 Adapter Manifest、协议版本协商、启动 / 状态 / 事件 / 取消 / 结果契约。
- 固定首个 MVP Adapter 和明确不支持的生命周期能力；不能宣称未经验证的恢复或取消语义。
- 冻结任务状态、事件信封、错误分类、idempotencyKey、Worker 身份和 Artifact 引用的最小契约。

**验收：** 有可重复运行的最小脚本 / 测试记录；能证明 Runtime 在独立 Workspace 执行、返回结果并在超时后停止受控进程。未通过前，不进入完整任务执行实现。

### Task 1：领域模型、Schema 与数据库迁移

**建议新增 / 修改：**
- 修改：`src/storage/database.ts`，新增后续版本迁移；保留已有迁移不可变。
- 新增：专家任务领域类型 / 状态机模块，以及独立的 SQLite Repository。
- 新增：版本化 `.proto` 契约及其生成 / 校验步骤；MCP 输入输出继续用项目现有 Zod 风格校验。
- 测试：数据库迁移、状态迁移、幂等提交、并发领取和重开恢复测试。

**P0 最小实体：**
- Worker：身份、注册 / 审核状态、协议版本、能力、最后心跳、撤销状态。
- ExpertDefinition / ExpertDeployment：固定版本、Capability、Worker 绑定、Runtime Adapter、Tool Binding、scope。
- ExpertTask / ExpertTaskRun：请求摘要、请求者、状态、Attempt、固定版本、错误和结果摘要。
- TaskEvent：Event ID、Run ID、单调序号、Schema 版本、时间和结构化 payload / Artifact 引用。
- TaskIdempotency：调用方作用域、幂等键、请求摘要、任务 ID。
- 最小 Artifact Reference：类型、URI、digest、来源 Run、scope / ACL 元数据。

**约束：**
- 任务创建、幂等键登记与入队必须原子化。
- 状态迁移与事件持久化同事务完成，或使用可靠 Outbox。
- 领取采用事务 / CAS 和租约代次；旧 Worker / 旧 Attempt 的迟到事件不能覆盖新状态。
- P0 按单 Hub 实例、单权威 SQLite 数据库实施；明确禁止把多个独立本地 SQLite 当作共享队列。
- 每个关键枚举的非法状态转换必须失败关闭。

**验收：** 数据库重开后任务和事件仍存在；重复提交返回同一任务；并发 Worker 只能有一个有效领取者；旧租约结果被拒绝；迁移测试通过。

### Task 2：Worker Enrollment、授权和通信通道

**建议新增 / 修改：**
- 新增：Worker 注册 / 心跳 / 领取 / 确认 / 续租 / 事件补拉服务模块。
- 修改：`src/server.ts` 增加内部 Worker API / RPC 接入点；复用现有服务启动方式但隔离用户 MCP API 与机器身份。
- 新增：Worker 端最小可运行进程入口和配置模板。
- 新增：Worker 管理的最小 Admin 审核 API；UI 可先提供足以激活 / 暂停 / 撤销的操作入口。
- 新增：注册、鉴权、重连、撤销和事件游标测试。

**授权规则：**
- Enrollment 使用一次性 / 短时凭证；审批后为每个 Worker 建立独立、可撤销的机器身份。
- Worker 不复用个人 API Key、管理员 API Key 或模型凭证。
- TLS 与 Worker 身份认证必须在协议层强制；如果首期无法建立 mTLS，必须把替代的 Worker 专属凭证机制作为明确安全决策，并保证可轮换 / 撤销。
- 注册状态 pending / active / suspended / revoked 与 online / offline 分开建模。
- 未激活、已暂停或已撤销的 Worker 不得领取新任务；任务领取时再次校验 Deployment / Capability / scope。
- 按已选决策实现控制 RPC + 服务端事件流；事件具有序号和恢复游标，断线后从最后确认位置补拉，长连接不是任务事实来源。

**验收：** 未审批 Worker 无法领取任务；撤销后拒绝新操作；重连后可补拉事件；伪造 / 过期租约的 Worker 不能写入结果；长连接断开不会丢失任务。

### Task 3：首个 Runtime Adapter、独立 Workspace 与工具白名单

**建议新增：**
- Runtime Adapter 接口与首个已验证的实现。
- Worker 运行管理器：启动、状态采集、协作式取消、超时强制终止、进程树核验。
- Workspace Manager：每个 TaskRun 独立目录 / Git worktree，记录基础 commit、分支、环境和清理状态。
- Tool Registry 的 P0 子集：固定版本的 Git、构建、测试、PR 工具定义及 Deployment 绑定。
- 受限执行器：只执行绑定中允许的操作，不接受 Agent 任意指定可执行文件、环境变量、工作目录或 Secret。

**安全约束：**
- Workspace 路径必须由 Worker 生成和校验，不能由 MCP 请求任意指定绝对路径。
- Adapter 仅通过授权的工具接口访问 Git / 构建 / 测试能力。
- 命令、参数、环境、超时和输出大小均受限；日志和结果脱敏。
- 取消不是回滚；外部操作结果未知时先查询 / 对账，不直接重放。
- Workspace 清理前必须确认受管进程停止且必要证据已保存。

**验收：** 并发任务不会共享可写工作目录；禁止的 Tool 调用被拒绝；超时会终止受控进程；Workspace / 产物元数据可追踪；清理失败会显式报告。

### Task 4：异步 MCP Task API、路由与 Skill / Knowledge 快照

**建议修改：**
- 修改：`src/mcp.ts` 增加任务提交、状态、结果、取消工具。
- 修改：`src/application.ts` 增加任务服务协调，复用当前身份、仓库授权、Skill / Knowledge 查询和 Candidate / Bundle 入口。
- 新增：任务路由模块，根据所需 Capability、Deployment 健康状态、权限和资源可用性选取专家。
- 新增：MCP 输入 / 输出与权限测试。

**最小 API：**
- `submit_expert_task`：接受目标、项目 / 仓库、所需能力、约束和幂等键；返回 taskId，不等待构建完成。
- `get_expert_task_status`：返回状态、当前 Attempt、阶段、更新时间和阻塞原因。
- `get_expert_task_result`：返回结论、PR、Artifact 引用、验证证据和适用版本。
- `cancel_expert_task`：请求协作式取消并按期限升级到强制终止。

**知识和权限：**
- Worker 通过机器身份获取授权的 Skill / Knowledge；不能把 Worker 的访问权限等同于所有用户权限。
- 记录实际采用的 Skill revision、Knowledge revision / digest、来源、Adapter / 模型和工具版本。
- Expert 的知识回流继续调用现有 Knowledge Candidate 或 Skill Bundle 流程；不得绕过审核直接发布。
- 查询 / 结果读取必须检查请求者、scope 与任务 ACL；知道 taskId 不代表有权读取。
- 自动路由只从激活的 ExpertDeployment 中选择；Planner 不能扩大请求授权范围。

**验收：** MCP 调用快速返回 taskId；客户端断开后任务继续；重复幂等请求不重复执行；越权用户无法查询结果；知识候选 / Bundle 仍走人工审核。

### Task 5：基础 Trace、审计、失败恢复与端到端验证

**建议新增 / 修改：**
- 修改：`src/mcp.ts` / 应用服务的任务 Trace 与审计关联。
- 修改：`deploy-local-wsl2.sh` 及必要的 Compose / Worker 启动配置，以部署真实新增服务。
- 新增：Worker 断线、Hub 重启、重复事件、租约过期、取消、未知副作用、权限拒绝和恢复测试。
- 新增：从提交任务到 PR / 测试证据的端到端验收脚本或测试说明。

**可观测性最小要求：**
- 统一关联 taskId、runId、workerId、expertId、traceId、eventId 和 artifactId。
- 状态迁移、领取 / 租约、Runtime 启停、工具调用、PR 创建、取消和人工 Gate 记录审计事件。
- Secret、Token、环境变量和不必要的源码内容不得进入日志。
- 区分可重试基础设施故障与确定性构建 / 测试失败；自动重试有上限和退避。
- 外部操作状态未知时进入 reconciliation / 人工核验，不盲目重试。

**真实验收路径：**
1. 在 WSL2 / Docker 环境按项目流程重新部署 Hub，并验证 readiness。
2. 启动一个真实 Worker，完成 Enrollment 和管理员激活。
3. 通过 MCP 提交任务，验证调用立即返回 taskId。
4. 使用独立 Workspace 让首个 Runtime 完成一个安全、可重复的仓库任务。
5. 验证构建 / 测试结果和 Git commit / PR 链接可查询。
6. 证明 Expert 无法合入受保护分支。
7. 中途断开 Worker 或 Hub 后恢复任务状态与事件游标。
8. 运行完整既有测试套件，确认 Candidate、Skill Bundle、部署和知识检索回归通过。

## 4. 建议实施依赖顺序

    Task 0 Runtime / 协议可行性
              |
              v
    Task 1 契约 + 数据模型 + 持久化
              |
              v
    Task 2 Worker 身份 + 队列 + 事件流
              |
              v
    Task 3 Adapter + Workspace + Tools
              |
              v
    Task 4 MCP + 路由 + 知识快照
              |
              v
    Task 5 安全回归 + 部署 + 真实端到端验收

Task 0 失败时应调整 Adapter 选择或能力边界，而不是绕过验证继续建设。Task 1–2 的队列和协议契约稳定后，Task 3–4 可在接口冻结的前提下并行开发，但仍由集成测试验证端到端契约。

## 5. P0 完成定义

P0 只有在以下条件全部满足时才算完成：

- [ ] 一个 Worker 经管理员批准后可以在线领取任务。
- [ ] 一个 ExpertDeployment 能使用固定版本 Adapter 执行任务。
- [ ] MCP 异步提交、状态查询、结果读取和取消均可用。
- [ ] 任务、Attempt、事件、幂等键和版本信息持久化且可恢复。
- [ ] Worker 重连后可恢复任务状态并补拉事件；重复事件不会重复应用。
- [ ] 每个 TaskRun 使用独立 Workspace；工具权限可由服务端和 Worker 双重限制。
- [ ] Skill / Knowledge 的读取受授权控制，使用版本有记录；知识回流需人工审核。
- [ ] 自动化结果可以交付 Git commit / PR 和测试证据，不能绕过保护分支合入。
- [ ] 断线、超时、取消、重试、撤销和未知外部副作用有自动化测试。
- [ ] WSL2 / Docker 真实部署验证完成，现有完整回归测试通过。
- [ ] 文档和部署脚本与实际 API、Worker 启动方式、配置和故障恢复行为一致。

## 6. P1 / P2 后续边界

**P1：** 多专家 Handoff、WorkflowRun / DAG 执行、Plan Revision、Schema Registry 完整治理、共享上下文、Artifact Store Adapter、Verification 失效传播、Resource Lease 和 OTA → Yocto 集成验证。

**P2：** 插件注册中心完整审核发布 UI、多 Runtime / 模型策略、多个 Artifact / Secret / Resource Provider、复杂资源调度和更完整的租户治理。

这些能力在架构上应保留扩展点，但不要为了“预留”而在 P0 实现没有实际消费者的完整抽象层。

## 7. 仍需在 Task 0 验证、但不阻塞方案方向的事实

- Codex CLI / Claude Code 在实际部署环境中的非交互、结构化输出、认证、取消和进程树行为。
- Node.js 24 下 gRPC / Protobuf 的代码生成与 Windows / WSL2 打包方式。
- Worker 与 Hub 的 TLS / 身份配置、代理穿透和断线恢复行为。
- 现有仓库发布配置能否为 Worker 创建受限工作分支和 PR，并能可靠检查保护分支。
- 现有数据备份 / 恢复流程如何覆盖新增任务队列、Worker 凭证元数据和审计事件。

在这些验证完成之前，不应将设计中提议的实体或 API 描述为现有系统已经支持的功能。
