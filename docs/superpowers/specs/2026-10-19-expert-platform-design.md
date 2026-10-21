# Team Skill Hub Expert Platform 架构设计（评审修订版）

> 状态：评审修订版 v2（已针对 F-01 至 F-08 修订；待第二轮设计评审，未获批准前不进入实现）
> 日期：2026-10-19
> 目标：在现有 Team Skill Hub / MCP 能力基础上，构建可扩展、可治理、可恢复的多领域 Expert Platform。
> 范围：本文描述目标架构和实施路线，不表示所有组件、模型或接口已经存在于当前代码库。
> 修订说明：保留已确认的 33 项架构决策；本次修订明确 P0 Task 契约、Hub–Worker 事件流、执行隔离、身份委托、运行时数据库、事件确认、插件信任和状态机。当前文件是待评审设计，不代表实现已完成。

## 1. 执行摘要

Team Skill Hub 将从 Skill / Knowledge 管理与治理平台，逐步扩展为可调度领域专家的研发协作平台。专家可以部署在开发者电脑、WSL2、Linux 构建服务器或受控测试节点上，通过统一协议接受任务，使用经过授权的工具和知识完成分析、代码修改、构建与测试，并通过 PR 交付结果。最终合入仍由领域负责人或管理员决定。

平台的核心价值不是自研 LLM 推理引擎，而是把已有 Agent Runtime、研发环境、专用工具、领域知识、跨专家工作流、产物和审核流程连接起来。

### 1.1 核心原则

1. 核心协议稳定、扩展点插件化；新增 Expert、Runtime、Tool、Schema、Artifact Store 或 Secret Provider 原则上不修改 Workflow Engine 核心。
2. Agent 负责分析和提出计划；Hub / Workflow Engine 负责授权、校验、调度、状态持久化和审批 Gate。
3. 每个 ExpertTaskRun 使用独立 Workspace 和执行上下文；共享缓存和硬件通过资源租约协调。
4. 专家之间传递版本化结构化消息和 Artifact 引用，不通过 Hub / MCP 中转大型镜像、压缩包或日志文件。
5. 所有长任务异步且可恢复；连接只用于通知，不是任务状态的唯一来源。
6. 动态协作必须受控。Planner 可以提出 DAG 计划和交接需求，Workflow Engine 必须验证能力、依赖、权限、预算与 Gate。
7. 允许在授权范围内自动分析、修改、编译、测试、创建分支和 PR；禁止绕过受保护分支和人工审批直接合入。
8. 每次运行固定关键配置、Adapter、模型、Schema、Skill / Knowledge revision、工具链和输入 Artifact。
9. 专家可见性、执行权限、管理权限、凭证权限与 Workflow 委托权限分开控制。
10. 先构建可靠单专家闭环，再逐步扩展到多专家 DAG；不在第一阶段引入多个重叠的 Agent / Workflow 框架。

### 1.2 推荐技术路线

- 通用 Expert Worker + 插件化 Agent Runtime Adapter。
- 插件独立进程，通过 gRPC + Protocol Buffers 通信。
- P0 先交付独立 ExpertTask / ExpertTaskRun 闭环；跨专家 WorkflowRun、Plan Revision 和 DAG 编排在 P1 提供，不混用 taskId 与 workflowId。
- P0 使用单 Hub 实例和独立 Expert Runtime SQLite 数据库；任务状态、幂等登记、队列和 Hub 权威事件共享同一事务域。
- Worker 主动建立出站 gRPC server-streaming 连接接收任务通知与控制事件；状态与事件持久化，支持游标补拉，连接不可用时退避轮询。
- 版本化消息 + Artifact 引用；Schema Registry 支持领域命名空间。
- Resource Registry + 共享 / 独占租约。
- 统一 Trace、审计事件和指标，不强制完整 Event Sourcing。
- 统一身份协议 + 可插拔 Secret Provider；Hub 不必存储所有实际 Secret。
- Expert 生成 Knowledge Candidate / Skill Bundle，人工审核后复用现有 Hub 发布流程。

### 1.3 本轮评审修订索引（待第二轮确认）

| 评审项 | 本次修订位置 | 关闭依据 |
|---|---|---|
| F-01 Task / Workflow 契约 | §8.1、§9.2、§20.1–20.2、§25、§26.6 | P0 只使用 taskId / runId；P1 单独引入 workflowId / WorkflowRun。 |
| F-02 Hub–Worker 事件流 | §1.2、§14.1–14.3、§15.1、§20.2、§25、§29 | P0 必需出站 server-streaming、控制 RPC、ACK 游标、补拉和轮询降级。 |
| F-03 执行隔离 | §6.4、§7.2、§23、§24、§26 | 写入 / 构建 / 凭证能力绑定经管理员批准的执行隔离 Profile；不满足要求时失败关闭。 |
| F-04 身份与凭证委托 | §17.3–17.6、§20、§23、§26 | Request Principal、Worker Identity、Task Delegation Grant 分离，并对仓库 / 操作 / 期限做最小授权。 |
| F-05 运行时数据库与恢复 | §1.2、§22.1、§24、§25、§27 | 单 Hub 写实例；Task / Attempt / 幂等 / 队列 / 事件在独立 Expert Runtime SQLite 事务域内。 |
| F-06 事件序号与 ACK | §14.3、§15.1、§22、§26 | 区分 Worker 控制流游标、TaskRun hubSequence 和 Worker sourceSequence；ACK 在持久化后发出。 |
| F-07 插件信任链 | §18.2–18.3、§24、§26 | P0 预装 Adapter 允许列表、版本 / 摘要固定、协议兼容校验与撤销。 |
| F-08 状态机与竞争条件 | §15.3–15.4、§16、§25、§26 | Task 与 TaskRun 状态分离；列出合法迁移、终态、取消竞争和旧 Attempt 规则。 |

第二轮评审 R2-01～R2-07 的修订见 §5.3、§7、§12.1.1、§17.4、§22、§25、§26；重点是 SandboxProvider 与 Broker 职责分离、SourceRepository revision 固定、P0 单仓库和沙箱断线核验。需第三轮审查验证，不宣称自动通过。

此索引只说明设计修订对应关系，不等于第二轮评审已通过；仍需逐项核对实现可行性、章节一致性与验收覆盖。

## 2. 目标场景与非目标

### 2.1 目标场景

- 开发电脑上的 OTA Expert 访问授权的 OTA 源码、工具和测试环境。
- 构建服务器上的 Yocto Expert 使用 BitBake、共享下载缓存和 sstate 缓存。
- 其他节点部署 MsgBox、Kernel、Audio、硬件测试等专家。
- 用户通过 MCP 提交研发问题，Hub 按能力、权限和资源路由任务。
- Expert 自动分析、修改源码、构建、测试和创建 PR。
- Workflow 组织 OTA → Yocto → 集成测试，也支持 DAG 并行验证。
- 执行过程、版本、产物和证据可审计、可恢复；最终合入由人工决定。
- Expert 可从 Hub 获取 Skill / Knowledge，并提交可复用经验作为候选内容。

### 2.2 非目标

- 第一阶段不从零实现通用 LLM 推理引擎。
- 不把所有源码、构建环境、镜像和设备集中迁移到 Hub。
- 不以提示词替代操作系统权限、工具授权或 Git 分支保护。
- 不允许 Agent 绕过 Workflow Engine 自由委派任务或提升权限。
- 不在首期引入多个重叠的 Agent / Workflow 框架。
- 不宣称分布式事件能端到端恰好执行一次。
- 不要求首期实现完整多租户基础设施，但资源模型必须支持组织 / 团队 / 项目作用域。

## 3. 术语与职责边界

| 概念 | 定义 |
|---|---|
| ExpertDefinition | 逻辑领域专家定义：领域、Capabilities、允许的 Adapter / 模型、知识策略、基线权限和版本。 |
| Expert Worker | 常驻执行节点：连接 Hub、领取任务、管理执行生命周期、资源与 Workspace。 |
| ExpertDeployment | Expert 在特定 Worker 上的部署绑定：工具、目录、资源限制、Secret Provider 和实际权限。 |
| Agent Runtime Adapter | 将 Codex、Claude Code、Agents SDK 或自研 Agent 接入统一执行契约的插件。 |
| ExpertTask | 用户可跟踪的逻辑任务，描述目标、输入、约束、能力需求和权限上下文。 |
| ExpertTaskRun | 一次执行尝试，固定运行版本、Workspace、Adapter / 模型、事件流和结果。 |
| WorkflowDefinition | 可复用工作流模板，定义节点、依赖、Gate、资源需求和结果汇聚策略。 |
| WorkflowRun | 一次具体工作流执行，包含 Plan Revision、节点状态、共享上下文、审批与审计。 |
| WorkflowPlanRevision | 某次 WorkflowRun 的不可变计划修订，记录修改前后节点、依赖和原因。 |
| Artifact | 统一元数据引用的交付物，例如 Git commit、补丁、报告、日志、镜像或测试证据。 |
| Verification | 与确定源码版本、依赖、制品和环境绑定的验证结果。 |
| Approval | 对明确版本的人工决策；审批对象改变后，原审批可能失效。 |
| ToolDefinition / ToolBinding | 前者定义工具契约；后者表示特定 Deployment 在特定 Worker 上实际可用的工具和权限。 |
| Resource / ResourceLease | 可调度资源及其在特定时间窗口内的共享或独占租约。 |
| PluginRelease | 插件的身份、版本、兼容性、来源、审核和发布状态。 |
| SchemaDefinition | 消息或 Artifact 的版本化数据契约。 |
| Shared Context | Workflow 级共享的版本化事实、决策、风险和 Artifact 引用。 |
| Private Context | 单个 ExpertTaskRun 的执行细节、模型会话和中间分析，默认不对其他专家开放。 |

**Expert = 谁处理；Skill = 如何执行；Knowledge = 可复用事实和经验；Tool = 执行手段；Runtime = 运行位置；Deployment = 实际权限与环境绑定；Workflow = 如何协调任务。**

关键边界：

- Worker 获准注册不代表其声明的每项能力已经验证。
- 插件审核通过不代表插件自动获得仓库、凭证、文件系统或设备权限。
- 有权调用 Expert 不代表有权读取 Expert 可访问的全部数据。
- Workflow 服务身份不能绕过下游 Expert 的接收策略、资源权限和人工 Gate。

## 4. 总体架构

    MCP Client / Web UI / CLI / Automation
                     |
                     v
             Team Skill Hub Control Plane
    +------------------------------------------------+
    | MCP Task API / Async Status API                 |
    | Expert Registry / Deployment Registry           |
    | Capability Router / Model Policy                |
    | Workflow Planner / Workflow Engine              |
    | Task Queue / Durable State / Event Store         |
    | Schema Registry / Artifact Registry             |
    | Tool Registry / Plugin Registry                  |
    | Resource Registry / Lease Coordinator            |
    | Identity / ACL / Secret Provider                 |
    | Approval / Audit / Trace / Metrics               |
    +------------------------------------------------+
                     |
           Worker 主动建立出站连接
                     |
          +----------+-----------+
          |                      |
          v                      v
      Expert Worker A        Expert Worker B
      开发电脑                构建服务器
      Runtime Manager        Runtime Manager
      Workspace Manager      Workspace Manager
      Resource Agent         Resource Agent
          |                      |
       gRPC / Protobuf       gRPC / Protobuf
          |                      |
      Adapter 进程            Adapter 进程
      OTA / MsgBox            Yocto / Kernel
      Tool Adapter            Build / Test
          |                      |
          +----------+-----------+
                     |
        Local source / CLI / Git / CI / Devices
                     |
                     v
              Git / CI / Artifact Stores
                     |
                     v
            领域负责人批准最终合入

### 4.1 Control Plane 与 Execution Plane

**Hub / Control Plane 负责：**

- Expert、Deployment、Plugin、Schema、Tool、Resource 注册和治理。
- 任务持久化、路由、Workflow 状态、依赖校验、Gate 和审批。
- 访问控制、Workflow 服务身份、Secret Provider 授权。
- Artifact 元数据、事件、审计、Trace、指标。
- MCP 异步提交和状态查询。

**Worker / Execution Plane 负责：**

- 主动连接 Hub、注册、心跳、领取任务和报告结果。
- 启动 / 停止 Adapter 进程，维护独立 Workspace。
- 检查本地工具版本、实际资源状态和环境健康。
- 按任务授权调用 Tool Adapter、Secret Provider 和本地工具。
- 持久化尚未上报的事件，并在断线后补传。
- 在租约或连接异常时核验本地进程，避免数据库状态与真实执行状态不一致。

Hub 不负责运行大型构建，也不要求开发机开放入站端口。

## 5. Expert 定义、注册和部署

### 5.1 Worker 自助注册与管理员审核

1. 开发者安装并启动通用 Worker。
2. Worker 使用受控注册凭证向 Hub 申请注册。
3. Hub 创建待审核的 WorkerRegistration。
4. Worker 上报系统、主机能力、Adapter / Tool 版本和健康检查。
5. 管理员审核机器身份、用途、网络可达性、资源和安全边界。
6. 激活后 Worker 才能领取批准范围内的任务。
7. 新增 ExpertDeployment 或扩大工具权限需要独立授权，不因 Worker 已批准而自动放行。

注册状态建议为 pending_approval、active、suspended、revoked；offline 是连接状态，不应覆盖授权状态。

### 5.2 Expert 与 Deployment 分离

ExpertDefinition 描述逻辑专家，不绑定单台机器。ExpertDeployment 将其绑定到 Worker 和实际环境。一个 Worker 可承载多个 ExpertDeployment，同一 ExpertDefinition 也可部署到多个 Worker。每个任务仍使用独立 Workspace、执行尝试和权限上下文。

示例配置（字段为目标模型示意，不是已存在的配置文件）：

    expert:
      id: ota-expert
      version: 3
      scope: { type: team, id: ota-team }
      domains: [ota, recovery, update-engine]
      capabilities:
        - source.diagnose
        - source.modify
        - ota.build
        - ota.test
      runtimePolicy:
        allowedAdapters: [codex-adapter, claude-code-adapter]
        modelSelectionPolicy: ota-default
      skillPolicy:
        namespaces: [ota, android]
      knowledgePolicy:
        namespaces: [ota, platform]

    deployment:
      id: ota-dev-pc
      expertId: ota-expert
      workerId: dev-worker-01
      workspacePolicy: { mode: per-task }
      toolBindings: [git-read, git-branch, ota-build, ota-test, create-pr]
      resourceLimits: { maxConcurrentRuns: 2 }
      permissions:
        repositories: [ota-repository]
        createPullRequest: true
        mergeProtectedBranch: false

不得允许请求方任意覆盖 Workspace 根目录、工具绑定或权限策略。

### 5.3 独立 Source Repository Registry（源码仓库注册表）

**专家修改代码所用的源码仓库与 Team Skill Hub 用于 Skill / Knowledge 治理及发布的仓库，是两个独立业务领域，不共享配置实体、管理 API、凭证或授权模型。** 可以复用通用 Git Provider 客户端代码，但不复用现有知识发布 Repository 配置。

Expert Platform 独立管理 `SourceRepository`：仓库 ID、Git Provider / 实例、Clone URL、默认分支、允许分支范围、项目作用域、可选本地镜像策略、认证凭证引用、仓库状态和审计元数据。`SourceRepository` 不直接授予专家读写权限。

`ExpertDeploymentRepositoryBinding` 将 Deployment 与 SourceRepository 绑定，并为每个仓库声明只读、创建分支、Push 工作分支、创建 PR、触发 CI 等操作范围。任务通过 `repositoryId` 和不可变 `baseCommit` / 受控分支引用选择目标；请求者不能提交未登记 Git URL，也不能越过 Deployment Binding 访问其他仓库。P0 限定单次 TaskRun 只操作一个 SourceRepository；一个 ExpertDeployment 可绑定多个仓库，但不能让单次 TaskRun 跨仓库变更。P1 通过 Workflow 将多个单仓库 Task 编排为跨仓库工作流，逐仓库校验授权、产出 PR 并处理部分成功及补偿。实际 Clone / Fetch 和凭证使用由受控执行器负责，不把仓库 Token 注入 Agent。

示例（概念配置，非现有 Schema）：

    sourceRepositories:
      - id: ota-source
        provider: github
        cloneUrl: git@github.com:example/ota.git
        defaultBranch: main
        credentialRef: source-git-ota
    deploymentRepositoryBindings:
      - deploymentId: ota-dev-pc
        repositoryId: ota-source
        permissions: [read, branch, push-work-branch, create-pr]

首期 Repository Registry 仅需源码仓库 CRUD、绑定审批、分支约束、凭证引用和审核记录；用户可从已授权仓库选择目标。该系统可以部署在同一个 Hub 进程内，但必须有独立的数据模型和权限边界。

**Repository 安全与版本契约：** `SourceRepository` 与 `ExpertDeploymentRepositoryBinding` 各有不可变 revision。TaskRun 固定两者 revision、Git Provider / 仓库不可变身份、经审核的 remote URL、凭证用途、完整 base commit SHA、目标分支 / 工作分支策略。运行中 Registry 更改仅影响新任务；如安全撤销当前仓库或授权，应中止受影响任务的新副作用操作。允许的 remote host、SSH host key / TLS 信任根、Git protocol、fetch refspec、push refspec、PR base/head 范围由部署策略约束。禁止不经审批的 remote 替换、自动 URL 重定向、新子模块远端、Git hooks 及不受限 Git credential helper。子模块、LFS、fork / 镜像等额外端点需逐一注册或显式授权，未经授权则失败关闭。Git Push / PR 通过受控 Git Broker 再次验证仓库身份、目标 remote、引用和委托授权；任务中的 Git 配置文件不能扩大批准权限。

### 5.4 Capability 声明

Capability 应描述可验证能力，例如 source.diagnose、source.modify、build.yocto、test.ota-upgrade、test.device-validation、git.create-pull-request。语义匹配可以发现候选，但最终调度必须校验声明、环境可用性、授权和资源约束。

## 6. Agent Runtime 插件架构

### 6.1 Adapter 契约

平台不把 Expert 绑定到某个 Agent SDK。Runtime Adapter 至少提供：

- GetManifest：插件版本、协议版本、Capabilities 和依赖。
- HealthCheck：插件和后端环境健康检查。
- StartRun：启动独立执行尝试，输入固定任务契约和授权能力。
- GetRunStatus：查询实际执行状态。
- StreamEvents：提供带序号的执行事件。
- CancelRun：请求协作式取消。
- TerminateRun：超过宽限期后的受控强制终止。
- CollectResult：返回结构化结果、Artifact 引用和验证证据。
- Shutdown：优雅关闭。

Adapter 必须声明其真实支持的恢复能力。有些后端能恢复原会话，有些只能新建 Attempt 并加载持久化上下文。

### 6.2 模型 / Adapter 选择

Expert 可配置多个获准 Adapter / 模型。策略可以综合任务能力、Adapter 可用性、成本预算、延迟、数据处理限制、工具兼容性、取消能力和组织策略。

每个 ExpertTaskRun 固定所选 Adapter、模型标识及可验证版本信息、参数策略和选择原因。启动前选择替代项必须记录原因；执行中切换必须形成新 Attempt，不能静默改变运行环境。

### 6.3 插件独立进程与受限 RPC

插件作为独立进程运行，通过 gRPC + Protocol Buffers 与 Worker 通信。Worker 是能力守门方；插件不能因拥有 RPC 连接而获得任意文件、Shell、凭证或设备权限。

RPC 需支持身份认证、能力授权、请求 / 响应校验、deadline、取消传播、资源限制、错误分类、健康检查、版本协商和 trace ID。RPC 只传递小型结构化数据和 Artifact 引用，不传大型制品。

独立进程提供生命周期和故障隔离，不等于完整安全沙箱。更强隔离按需使用容器、OS 沙箱、受限用户、文件 ACL、网络策略或设备访问代理。

### 6.4 P0 执行隔离基线

P0 的威胁模型将用户任务描述、仓库文件、构建脚本、检索到的 Skill / Knowledge、工具输出和 Agent 生成的计划都视为不可信数据。它们不得更改授权策略，也不得直接授予新的工具或资源权限。

所有可写入代码、运行构建 / 测试或访问凭证的 Deployment 必须绑定经管理员批准的执行隔离 Profile。最低要求为：

- 使用专用的非管理员 OS 用户 / 服务身份；不继承交互式用户的完整权限。
- 每个 TaskRun 使用独立 Workspace，并通过 OS ACL 限制到明确允许的仓库、缓存和输出目录；Git worktree 只用于工作区隔离，不被视为安全沙箱。
- 对 Agent / Adapter 及其子进程实施进程树跟踪、超时终止和 CPU、内存、磁盘等资源限制；不能只杀掉顶层进程。
- 环境变量默认拒绝继承，采用白名单；Worker 注册凭证、管理员凭证和其他任务的 Secret 不得进入 Agent 环境。
- 网络出口按部署 Profile 限制并记录；需要访问 Git、CI、包仓库或设备的目标必须显式授权。若目标平台不能落实部署要求的网络限制，不得执行高风险凭证操作。
- Windows 使用受限服务账户、目录 ACL 和 Job Object / 等效进程管理；WSL2 使用专用 Linux 用户与工作目录，默认不授予对整个 Windows 挂载盘的访问权，不暴露 Docker socket 或不受限 Windows interop；Linux 使用专用 UID、文件权限、进程 / 资源限制，并在可用时增加容器或 OS 沙箱。
- 对无法证明达到其声明隔离级别的 Worker，失败关闭：只允许只读诊断或拒绝任务，不自动降级为宿主高权限执行。

任意 Shell / 构建脚本只能在该隔离 Profile 明确允许的边界内执行。策略引擎必须授权结构化 Tool 操作和参数；字符串正则检查只能作为补充检测，不能代替 OS 权限或工具白名单。

## 7. Tool Registry 与 Tool Adapter

### 7.1 数据边界

- ToolDefinition：工具 ID、版本、能力、输入输出 Schema、风险级别、兼容性。
- ToolAdapterDefinition：对接 CLI、MCP、HTTP、Python 或自定义系统的插件类型。
- ToolBinding：特定 Deployment / Worker 上的实际工具版本、参数模板和权限。
- ToolInvocation：调用者、任务、输入摘要、结果状态、耗时、日志与 Artifact 引用。

### 7.2 调用流程

1. Expert 声明所需 Capability / Tool。
2. Worker 校验工具是否已安装、健康且版本兼容。
3. Policy Engine 基于请求者、TaskRun、委托授权、目标仓库、结构化操作 / 参数、资源租约和执行隔离 Profile 做确定性授权。
4. Worker 只向获准的 Tool Adapter 暴露当前任务的最小能力；命令类工具优先采用 argv / 结构化参数，不允许模型通过自由文本覆盖工具绑定、环境变量或工作目录。执行在已批准的隔离 Profile 内进行。
5. Adapter 返回结构化结果、错误分类和 Artifact 引用。
6. Worker 持久化事件并上报，敏感输入和 Secret 必须脱敏。

不要求所有工具都改造成 MCP。新增 CLI、MCP Server、HTTP API 或内部系统时，通过注册工具定义和对应 Adapter 接入。

### 7.3 自动化边界

自动化仅限 Deployment 已授权能力。普通代码修改、构建和测试可按策略自动执行；生产发布、正式签名或破坏性操作必须由部署策略明确授权。工具风险不能由模型自行决定。

## 8. Workflow Engine 与动态规划

### 8.1 Planner 与 Engine 分工

本节描述 P1 及之后的 Workflow 目标能力。P0 只实现单个 ExpertTask / ExpertTaskRun，不创建 WorkflowRun、不执行跨专家 Handoff；P1 再增加 WorkflowDefinition、WorkflowRun、Plan Revision 和 DAG 编排。

Planner / Agent 根据用户目标、专家能力和已知结果提出计划、依赖、输入输出要求和交接需求。Workflow Engine 对计划做确定性校验：

- 节点、依赖是否合法，DAG 是否有环；
- Capability 是否可满足；
- 输入 / 输出 Schema 是否兼容；
- Workflow 服务身份、Expert ACL、Deployment、Secret、Artifact 权限是否允许；
- 资源、并行度、重试、时限和成本预算是否满足；
- 是否需要人工 Gate。

Planner 不能直接创建有执行效力的任务，也不能自行提升权限。只有 Engine 校验并持久化计划后，任务才进入调度队列。

### 8.2 DAG 与汇聚

WorkflowDefinition 以节点和依赖边描述流程；串行流程只是 DAG 的一种情况。

    OTA 修复与单测
          |
      自动质量 Gate
          |
      Yocto 集成与构建
          |
       +--+----------------+
       |                   |
    OTA 升级验证       Kernel 兼容验证
       |                   |
       +---------+---------+
                 |
             Join Gate
                 |
           人工审核与合入

每个节点有独立 Task、TaskRun、Workspace、资源租约、输入 Artifact 和输出证据。Join Gate 使用明确策略（所有必需节点通过、指定节点通过或允许可选节点失败），不能只拼接专家返回的 PASS 文本。

### 8.3 Workflow 状态

建议状态：planning、ready、running、waiting_resource、paused、awaiting_approval、retry_wait、cancelling、succeeded、failed、blocked、cancelled。节点状态与 WorkflowRun 状态分离；只有所有必需节点和 Gate 满足完成策略时，Workflow 才能成功。

### 8.4 动态调整与 Plan Revision

运行中的 Workflow 可受控新增节点、修改未执行节点的依赖 / 参数 / 资源需求，或暂停、恢复和取消未执行阶段。每次变更生成新的 WorkflowPlanRevision，记录修改者、原因、差异、影响节点和审批记录。

已完成执行和 Artifact 不可原地改写。Engine 重新计算下游影响；上游输入版本变化时，将相关 Verification / Approval 标记为 stale，并要求重新执行必要阶段。

### 8.5 重试和人工介入

默认有限自动重试，失败后人工介入：

- 可重试故障：短暂网络错误、Worker 临时不可用、可恢复基础设施错误。
- 确定性失败：编译错误、测试失败、契约校验失败；保存证据后暂停。
- 设置最大尝试次数、指数退避、随机抖动、总时限和成本预算。
- 外部操作结果未知时先核验，不直接重放。
- 人工处理后可从受影响节点恢复；失效的下游验证不能复用。

P1 的 Workflow 首个版本可以先执行线性模板，但核心数据模型必须表达 DAG；P0 不创建 WorkflowRun。

## 9. 专家交接与版本化数据契约

### 9.1 Handoff

Expert 不硬编码下一位专家的 ID，也不直接调用另一专家。它声明所需 Capabilities、输入 Artifact 类型和版本、期望输出、验证条件及限制。Workflow Engine 校验并匹配目标专家，创建下游任务并授权读取所需输入。

### 9.2 通用消息信封

通用信封建议包含 schemaVersion、messageId、type、producer、taskId、runId、traceId、occurredAt 和 payload；属于 Workflow 的消息可附带 workflowId / workflowPlanRevision。领域 payload 由注册的 Schema 校验。以下为 P1 Workflow 场景示意；P0 单专家 Task 消息不包含 workflowId：

    schemaVersion: "1.0"
    messageId: "msg-unique-id"
    type: "expert.task.completed"
    producer:
      expertId: "ota-expert"
      deploymentId: "ota-dev-pc"
    workflowId: "wf-123"
    taskId: "task-123"
    runId: "run-456"
    traceId: "trace-789"
    payload:
      summary: "修复已完成"
      artifacts: []
      handoff:
        requiredCapabilities: [build.yocto]
        requiredArtifactTypes: [source-change, test-report]

此示例用于解释结构，不是已发布 API。

### 9.3 Schema Registry

Schema Registry 管理 Schema ID、命名空间、版本、所有者、消息 / Artifact 类型、兼容性规则、弃用状态、验证器和发布审核。领域命名空间示例：

- ota.upgrade-report
- yocto.image-manifest
- msgbox.diagnostic-report
- hardware.flash-validation-report

未知类型可以在不理解领域内容时按通用元数据安全传递，但未经注册 / 验证的类型不能作为关键 Gate 的唯一证据。新增领域类型不应要求修改 Workflow Engine 核心。

### 9.4 兼容性规则

- 新增可选字段通常向后兼容。
- 已发布字段编号和名称不得随意复用。
- 破坏性变更使用新主版本或新 Schema ID。
- 消费者声明支持的 Schema 范围，注册时执行兼容性检查。
- 保留期内旧 Schema 与验证器必须可用于历史任务。
- 必要时记录 Schema 内容摘要，不能只凭版本号假设内容相同。

## 10. Artifact Registry 与大文件策略

### 10.1 元数据集中，文件分布式

Hub 的 Artifact Registry 保存身份、版本、来源和访问策略；实际内容可存于 Git、CI 制品库、对象存储或受控本地 Artifact Store。MCP 消息、Workflow 事件和插件 RPC 只传递元数据、摘要、URI 和必要的小型结构化数据。

| 内容 | 交接方式 |
|---|---|
| 源码修改 | Git 仓库 + 完整 commit SHA / PR URL |
| 补丁 | Git commit 或受控 URI + SHA-256 |
| 测试报告 | 结构化摘要 + 报告引用 |
| 构建结果 | Build ID + 日志引用 + 输入版本 |
| Yocto 镜像 | 制品 URI + SHA-256 + manifest，不经 Hub 中转 |
| 大型日志 | 摘要 + 日志引用，按需读取片段 |
| 设备验证 | 测试结果、设备身份、环境信息和证据引用 |

若消费者需要大型文件，直接从获准 Git / Artifact Store / CI 系统读取。只有明确需要并获授权时才传输，使用专用通道，不把文件编码进 JSON、gRPC 事件或 MCP 响应。

### 10.2 Artifact 元数据与完整性

Artifact 至少记录 artifactId、type、schemaRef、URI、媒体类型、可选大小、内容摘要、生产者、TaskRun、源仓库 / commit / manifest、作用域、ACL、创建时间和保留策略。

URI 只是定位符，不自动授予访问权。读取时重新校验 ACL；存储离线、URI 过期或摘要不匹配时明确失败，不静默替换内容。

### 10.3 Verification 绑定

Verification 绑定源码 commit / manifest、依赖和配置、工具链版本、被测 Artifact digest、测试环境 / 设备、测试项、结果、日志引用和验证器版本。上游源码、依赖、镜像或环境变化后，相关 Verification 标记为 stale；审批也绑定明确版本，变更后重新校验审批有效性。

## 11. Workflow 共享上下文与任务私有上下文

### 11.1 分层上下文

**Workflow Shared Context：** 已确认事实、关键决策、未解决问题、风险、阶段验证结论、Artifact 引用、当前计划与依赖版本。

**ExpertTask Private Context：** Agent 会话记录、中间分析、工具执行细节、本地诊断过程和临时数据。

私有上下文默认不向其他专家开放。下游优先读取结构化 Handoff，或通过授权引用按需读取。

### 11.2 更新与可信度

- 共享上下文按版本或追加事件记录，不能由多个专家无条件覆盖同一文档。
- 每条内容记录来源、作者、时间、适用范围和可信度。
- 区分 verified_fact、hypothesis、decision、risk、open_question。
- 并发更新采用版本检查或追加事件，冲突交由确定性规则或人工处理。
- 按需加载，不把完整聊天历史广播给每个专家。
- 同一 Workflow 不代表自动共享所有敏感数据；仍执行 ACL 和字段 / Artifact 级访问策略。

## 12. Workspace 与执行生命周期

### 12.1 每任务独立 Workspace

每个 ExpertTaskRun 创建独立 Workspace。源代码来自 Expert Platform 独立 SourceRepository Registry 中经授权的 `repositoryId`，并固定 `baseCommit`。可信的本地 Git 镜像 / 对象缓存可复用以减少 Clone 成本；Git worktree 只用于工作区复用，**不能替代 OS / 容器沙箱**。非 Git 项目使用独立目录或隔离环境。共享 Git 对象、下载缓存或 Yocto sstate 缓存可以按授权复用，但源码变更、构建输出和任务状态必须隔离。

将 `ExecutionSandbox` 作为独立于 `ExpertWorker`、`AgentRuntimeAdapter` 和 `Workspace` 的抽象：Worker 负责监督和授权，SandboxProvider 负责创建、隔离、运行与销毁代码执行环境，Workspace 负责仓库和文件快照，Adapter 负责 Agent 推理与操作。支持的 SandboxProvider 可为受限本地进程、Docker / OCI 容器、远程隔离执行服务；不同部署按隔离 Profile 选择，不能因 Provider 不可用而静默降级。Agent 的对话 / 模型凭证原则上留在更可信的运行域，不可信代码、构建脚本与 Shell 必须通过受限 Sandbox 内的 Tool Adapter / 进程执行；Tool Adapter 不能绕过 Sandbox。需要访问 Git 凭证、CI、签名或设备的高权限副作用操作，由 Worker 侧 Privileged Tool Broker 在 Sandbox 外执行独立授权、参数检查与外部操作幂等对账；Broker 不接受任意 Shell 命令。

Workspace 元数据包括 Workspace ID、Worker / Deployment / TaskRun、仓库、基础 commit、分支、创建方式、环境版本、状态、保留策略、清理状态和输出 Artifact。

### 12.1.1 Worker、Agent Runtime、SandboxProvider、Workspace 与 Tool Broker 的职责

| 组件 | 独占职责 | 不负责 |
|---|---|---|
| Expert Worker | Claim / lease、权限检查、调度、监督和结果对账；管理 Sandbox / Adapter 生命周期 | 不直接以宿主高权限执行不可信构建脚本 |
| Agent Runtime Adapter | 把领域 Task 映射到 Codex / Claude 等 Agent，处理模型会话、推理、工具请求和结构化结果 | 不自行扩大权限、访问未授权仓库或签发执行凭证 |
| SandboxProvider | 按隔离 Profile 创建 / 挂载 / 启动 / 检查 / 取消 / 销毁隔离执行环境，约束网络、进程和资源 | 不决定业务授权、不管理知识仓库或审查 PR |
| Workspace Manager | 固定仓库及绑定 revision、Clone / Fetch 结果、baseCommit、工作树 / 构建目录与快照；管理文件保留与清理 | 不替代隔离环境或签发 Git 凭证 |
| Tool Adapter | 为 Agent 暴露已授权、类型化的能力接口，校验工具参数，返回结果 / Artifact 引用 | 不因为被调用就豁免 Sandbox 隔离 |
| Privileged Tool Broker | 以最小权限执行经过验证的 Git Push / PR、CI、Secret / 设备等特权副作用，记录幂等键和外部 ID | 不暴露任意 Shell / 原始 Secret 给 Agent |

**P0 SandboxProvider 最小契约：** `PrepareSandbox(profile, runId)`、`MountWorkspace(workspaceSnapshot)`、`Execute(toolInvocation)`、`StreamOutput(cursor)`、`Inspect(sandboxId)`、`Cancel(gracePeriod)`、`Destroy()`，所有调用要有 deadline、身份、版本、资源限制与 fencing 信息。实际 RPC 名称在 proto 评审时冻结。沙箱生命周期 `requested → preparing → ready → running → stopping → stopped → cleaning → destroyed`，异常转 `reconciliation_required`；其生命周期独立于 Workspace 的 `retained / cleaned`。

**执行时序：** Hub 校验任务与 RepositoryBinding → Worker 领取任务并验证委托 → Workspace Manager 生成固定 commit 的受控快照 → SandboxProvider 创建沙箱并只读/读写挂载指定路径 → Adapter 在获准身份下请求工具 → Tool Adapter 在 Sandbox 内执行非特权操作；需要 Git Push / PR / CI / 设备权限时由 Worker 的 Broker 重新授权 → Worker 收集验证与 Artifact 引用，停止并核验沙箱，再按保留策略清理 Workspace。

**断线与恢复：** 每个 Sandbox 有独立 `sandboxId`、`runId`、隔离 Profile、租约 / fencing 代次、Worker 所有权及健康状态。Worker / Hub 失联时，重连必须先 `Inspect` 原沙箱、进程和资源占用；未能证明停止或隔离的旧沙箱不能让新的 Attempt 重用其独占资源。取消与销毁失败需保留证据并转入核验状态；远端沙箱不应仅因数据库租约过期就被视为已销毁。

### 12.2 生命周期

建议生命周期：requested → creating → ready → running → collecting → retained → cleanup_pending → cleaned。异常任务先保存日志、结果和工作区信息，再按策略清理。清理前确认产物已保存、进程已停止且没有有效资源租约。保留期由任务类别、审计和存储策略决定。

### 12.3 Worker 常驻，Expert 按任务启动

Worker 常驻负责连接、调度、健康检查和资源协调。收到任务后启动独立 Adapter / Agent 实例；完成后回收资源并持久化结果。跨专家上下文通过 Workflow Context / Artifact 传递，不依赖模型会话长期驻留。

## 13. Resource Registry 与租约

### 13.1 资源类型

包括 CPU / 内存 / 磁盘配额、构建服务器和槽位、共享下载与 sstate 缓存、测试板、USB / 串口、烧录器、专用测试环境、许可证和外部 CI 并发额度。

资源元数据描述容量、共享 / 独占模式、适用 Capability、健康状态、位置、ACL 和管理者。

### 13.2 租约流程

1. TaskRun 在需要资源的阶段声明需求。
2. Scheduler 选择资源。
3. Lease Coordinator 创建有期限租约，并使用 fencing token 或等效代次标识。
4. Worker / 资源代理确认实际状态并续租。
5. 任务结束后释放租约；异常情况进入核验与回收。

**租约过期不等于资源已安全释放。** 对构建进程和硬件操作，必须确认旧任务已停止或被可靠隔离后，才能重新分配独占资源。设备租约必须防止两个任务同时操作同一设备。

## 14. Hub 与 Worker 通信及持久化任务队列

### 14.1 通信模式

采用持久化任务队列 + Worker 主动出站连接。P0 的规范主通道为 Hub–Worker gRPC + Protocol Buffers：Worker 发起长连接并订阅按 Worker 身份隔离的 Hub server-streaming 控制 / 派发事件；领取、续租、心跳、Hub 事件游标确认、Worker 事件上报 / 确认、取消确认和结果提交使用有 deadline 的控制 RPC。Hub 不要求开发机开放入站端口。

- 服务端事件流必须在 P0 提供，不是可选的后续增强。它用于任务可用通知、取消 / 撤销通知和游标续传；连接本身不代表任务已领取或获得执行权限。
- 任务、租约、状态和事件的权威记录保存在 Hub 持久化存储中。Worker 通过原子领取 / 确认获得执行权，收到通知后仍须调用 Claim 并完成授权检查。
- Worker 断线后必须按最后确认游标补拉事件，并查询权威任务状态；若长连接不可用，可退避轮询 Claim / Status / Events。轮询是降级通道，不得改变事件和状态语义。
- Hub–Worker 与 Worker–Adapter 是两个独立的信任边界。即使都采用 gRPC / Protobuf，也必须分别认证、授权、协商版本并分配独立身份；本地插件 RPC 不得复用 Worker 的 Hub 身份。
- Hub–Worker 使用 TLS 和双向身份验证；消息包含协议版本、Worker 身份、请求关联 ID、deadline / 取消语义及 trace ID。协议版本不兼容时拒绝执行，而不是静默忽略字段。
- P0 不再并行实现第二种长连接协议。若目标环境无法稳定运行 gRPC server-streaming，必须先形成 ADR 并更新本设计；在该 ADR 通过前仅允许退避轮询，不得声称已满足实时事件流要求。

### 14.2 领取与租约

- claim 必须原子化，避免两个 Worker 同时获得同一任务的有效执行权。
- 执行权有租约和代次标识；过期 Worker 的迟到结果不能覆盖新 Attempt。
- Worker 在持久化本地启动记录后才报告开始执行。
- Worker 崩溃后，Hub 检查 Attempt / 进程状态，再决定恢复、重试或转人工。
- 队列允许重复投递；任务和外部操作各自实现幂等性。

### 14.3 P0 事件流、ACK 与断线恢复协议

- 每个 TaskRun 有 Hub 权威事件流，Hub 在持久化事务中分配单调递增的 `hubSequence`；事件 ID 全局唯一，流 ID 与 TaskRun / Attempt 绑定。
- Worker 本地生成的事件另带 `sourceEventId` 和单调 `sourceSequence`。Worker 必须先把待上报事件写入本地持久化 spool，再发送给 Hub；未获得持久化确认前不得删除该事件。
- Hub → Worker 的控制 / 派发流另有每个 Worker 独立的 `workerStreamSequence`，并在 Hub 持久化；未确认的控制事件必须保留并可重复投递。Worker 必须先持久化并应用该条控制事件，再通过控制 RPC 确认 `workerStreamSequence`；重连从最后确认的 Worker 游标继续。此游标与 TaskRun 的 `hubSequence`、Worker 来源的 `sourceSequence` 是三个不同的序列，不能互相替代。
- Hub 在一个事务内验证 Attempt、租约 fencing token 和状态转换，去重来源事件，写入业务事件并更新状态。只有事务提交成功后才 ACK。ACK 语义为“已持久化并应用 / 归档”，不是“网络已接收”。
- Worker 重发相同 `sourceEventId` 时，Hub 返回原处理结果而不重复应用状态迁移。旧 Attempt、过期租约或无效 fencing token 的事件只能进入受审计的拒绝 / 诊断记录，不能改变当前状态。
- 消费者使用 Hub 的 `hubSequence` 游标补拉。序号缺口、游标过期或事件已超过保留期时，Hub 必须返回明确的 `gap / snapshot_required` 结果，并提供权限校验后的权威状态快照；禁止静默跳过缺口。
- Hub 不可用或连接中断时，Worker 不得领取新任务。正在运行的任务只能在现有租约和短期授权仍有效、且其操作策略允许的范围内继续；不能续租或授权到期时，必须停止新的外部副作用并进入安全停止 / reconciliation 流程。
- Worker 本地 spool 需要有容量上限、磁盘满处理和保留策略。无法持久化关键事件时，不得假报成功；应停止产生新的有副作用操作并上报可用的故障信号。

## 15. 事件可靠性与任务状态机

### 15.1 持久化事件 + 序号游标 + 至少一次投递

事件模型区分 Hub 权威事件与 Worker 来源事件。Hub 为每个 TaskRun 流分配单调递增的 `hubSequence`；Worker 来源事件使用 `sourceEventId`、`sourceSequence`、Worker ID 和 Attempt ID 标识。消费者以 Hub 序号推进游标，来源事件 ID 用于 Hub 侧去重。

- 状态迁移与 Hub 事件必须在同一事务内提交；若跨存储无法同事务，必须使用可靠 Outbox，且 Outbox 和权威状态位于同一事务域。
- Hub 只有在状态 / 事件持久化提交后才确认 Worker 的来源事件。客户端收到 ACK 前保留本地 spool，允许至少一次重发。
- ACK 表示 Hub 已持久化并处理该事件，不表示外部 Git、CI 或设备操作恰好执行一次。
- 事件处理必须检查 TaskRun / Attempt ID、当前状态、租约 fencing token 和来源去重键；旧 Attempt 的迟到事件不得覆盖当前状态。
- 事件流中断时，以 Hub 当前状态为准；重连按 Hub 游标补拉。序号缺口或历史过期时必须显式返回 gap 并要求状态快照恢复。
- 对创建分支、PR、触发 CI、烧录设备等外部副作用使用独立幂等键和外部操作 ID。响应丢失或状态未知时先核验外部系统，再决定重试；不能以事件去重替代副作用对账。

### 15.2 外部副作用幂等

创建分支、提交 PR、触发 CI、操作设备等副作用使用独立幂等键并记录外部系统操作 ID。重试前查询外部状态。结果未知时进入 reconciliation_required 或人工核验，不直接重放。

### 15.3 Task 与 TaskRun 状态分离

`ExpertTask` 表示调用方提交的逻辑任务；`ExpertTaskRun` 表示一次具体执行 Attempt。重试不复用旧 TaskRun，而是创建新的 runId / Attempt，并保留旧 Attempt 的最终状态和证据。

逻辑任务状态：`queued`、`running`、`retry_wait`、`awaiting_gate`、`succeeded`、`failed`、`blocked`、`cancelling`、`cancelled`、`expired`、`reconciliation_required`。

单次 TaskRun 状态：`assigned`、`starting`、`running`、`waiting_resource`、`cancelling`、`succeeded`、`failed`、`cancelled`、`lost`、`reconciliation_required`。`retry_wait` 属于逻辑任务，不属于某次 Attempt；等待结束后创建新的 TaskRun。

所有状态由 Hub 状态机验证。Agent、Worker 和 MCP Client 只能请求命令 / 上报事件，不能任意写入状态。每次状态迁移、状态事件和 Attempt 结果必须在同一事务内保持一致。

### 15.4 P0 状态迁移与并发仲裁

| 对象 / 当前状态 | 允许的下一状态 | 触发与约束 |
|---|---|---|
| Task: `queued` | `running`、`blocked`、`cancelled`、`expired` | 领取成功且授权通过后进入 running；取消或排队期限到达可先于领取生效。 |
| Task: `running` | `retry_wait`、`awaiting_gate`、`succeeded`、`failed`、`blocked`、`cancelling`、`reconciliation_required` | 只能由有效 TaskRun 的已验证结果、Gate 或受控管理命令触发。 |
| Task: `retry_wait` | `queued`、`cancelled`、`expired` | 退避和预算检查通过后重新排队，并创建新 TaskRun。 |
| Task: `awaiting_gate` | `queued`、`succeeded`、`blocked`、`cancelled` | 只接受有权审批 / 恢复的主体；审批绑定明确 Artifact / commit / policy revision。 |
| Task: `blocked` | `queued`、`cancelled`、`expired` | 阻塞原因已解决，且有权主体明确恢复后才可重新排队。 |
| Task: `failed` | `retry_wait`、`cancelled` | 仅在策略允许且有权主体请求重试时进入 retry_wait；新尝试必须创建新 TaskRun。 |
| Task: `cancelling` | `cancelled`、`reconciliation_required`、`failed` | 进程已停止且外部副作用已核验后确定最终状态。 |
| Task: `reconciliation_required` | `succeeded`、`retry_wait`、`blocked`、`failed`、`cancelled` | 必须先完成外部操作核验；确认操作已成功时才可转 succeeded，需要重试时按预算创建新 TaskRun。 |
| Task: `succeeded` / `cancelled` / `expired` | 无（终态） | 不允许原地重开；需要再次执行时创建新的逻辑 Task。 |
| TaskRun: `assigned` | `starting`、`cancelled`、`lost` | Worker 持有有效租约和 fencing token；未开始执行的任务可安全撤销。 |
| TaskRun: `starting` | `running`、`failed`、`cancelling`、`lost`、`reconciliation_required` | 进程和 Adapter 状态已核验；启动结果未知时不得直接重放外部操作。 |
| TaskRun: `running` | `waiting_resource`、`succeeded`、`failed`、`cancelling`、`lost`、`reconciliation_required` | 结果必须来自当前 Attempt；等待资源必须记录等待原因与期限。 |
| TaskRun: `waiting_resource` | `running`、`failed`、`cancelling`、`lost` | 重新取得有效资源租约后恢复；不能将租约过期直接视为资源已释放。 |
| TaskRun: `cancelling` | `cancelled`、`reconciliation_required`、`failed` | 只有确认进程停止且必要外部副作用已核验后才能标记 cancelled。 |
| TaskRun: `reconciliation_required` | `succeeded`、`failed`、`cancelled`、`lost` | 只有外部操作与进程状态已核验后才能确定终态；不能仅凭 Worker 超时猜测结果。 |
| TaskRun: `succeeded` / `failed` / `cancelled` / `lost` | 无（终态） | 不允许原地重开；重试必须创建新 Attempt。历史结果只归档。 |

并发规则：

- 每次迁移使用事务 / CAS 检查预期当前状态，并校验 runId、Attempt ID、租约代次和 fencing token。
- 若取消与成功完成竞争，以 Hub 首个合法提交的状态迁移为准；若完成提交先成功，取消请求返回“已终结”，不得伪造 cancelled；若取消先进入 cancelling，后到的成功结果只作为证据保存，必须先核验副作用后再定最终状态。
- Worker 心跳超时或租约到期不会自动证明进程已停止。Hub 将 Attempt 标记为待核验 / lost 候选，确认进程、设备和外部操作后才能重试或释放独占资源。
- 状态命令幂等；重复取消、重复恢复和重复结果上报返回当前权威状态，不重复执行副作用。非法迁移返回稳定错误码并记录审计事件。

## 16. 取消、超时与恢复

### 16.1 协作式取消 + 超时强制终止

1. 将逻辑 Task 标记为 `cancelling`，并把当前 TaskRun / WorkflowNodeRun（若属于 Workflow）标记为 `cancelling`；拒绝新派发和新的副作用操作。
2. 通知 Adapter 和受管理子进程停止接收新工作。
3. 等待安全停止点，收集必要日志与结果，释放可安全释放的资源。
4. 超过宽限期仍未停止时，终止受 Worker 管理的进程或执行隔离动作。
5. 核验进程、设备和外部操作状态。
6. 分别记录取消结果、清理结果和未解决的外部副作用。

取消不等于回滚代码、删除 PR 或撤销已经执行的外部操作。Workflow 取消后，未执行下游阶段不再启动；正在运行的节点分别执行取消流程。

### 16.2 超时层次

区分任务排队超时、资源等待超时、Adapter 启动超时、单次工具调用超时、单阶段执行超时、Workflow 总期限、取消宽限期和 Secret / 资源租约期限。不要压缩为一个 timeout 字段。

### 16.3 恢复策略

- 临时网络或 Worker 故障：有限重试。
- 确定性构建 / 测试失败：保存证据并暂停，等待人工介入。
- Worker 重启：根据持久化状态、进程检查和租约决定恢复方式。
- 旧 Attempt 迟到的成功结果不能覆盖新 Attempt。
- 重试沿用固定配置并创建新 TaskRun / Attempt；只有当任务属于 Workflow 时，计划或输入依赖发生变化才创建显式 Plan Revision 并记录原因。
- 外部操作结果不明时先核验，不自动重复危险操作。

## 17. 身份、ACL 与 Secret Provider

### 17.1 组织 / 团队 / 项目作用域

核心资源具有 scopeType 和 scopeId，支持 Organization、Team、Project。第一版可以只有一个组织，但不得把组织 ID 硬编码为全局常量。

作用域继承仅提供默认策略，不能扩大资源自身权限。跨团队 Workflow 必须明确授权。

### 17.2 权限分层

1. Expert Access Policy：谁可以发现、查看和调用专家。
2. Expert Execution Policy：专家可访问的仓库、工具、目录、设备和环境。
3. Expert Administration Policy：谁能创建、修改、激活或停用专家。
4. Workflow Delegation Policy：Workflow 服务身份在本次运行可委托的专家、仓库、操作和期限。
5. Artifact / Context ACL：谁能读取具体 Artifact 和共享上下文。
6. Secret Policy：任务可申请的 Secret、用途、范围和期限。

### 17.3 Workflow 服务身份

跨专家协作使用经过批准的 Workflow 服务身份。授权上下文记录原始请求者、WorkflowRun、服务身份、策略版本和有效期。P0 尚未交付 WorkflowRun 时，单专家任务仍必须使用同一委托模型的最小子集：请求者身份由 Hub 从已认证 MCP 会话解析，不能由任务 payload 自报；Hub 为已授权 TaskRun 生成任务范围的委托授权，Worker 不直接继承请求者或管理员的全部权限。

每个下游阶段同时检查 Workflow 授权、目标 Expert ACL、Deployment 权限、Artifact ACL 和工具策略。动态规划不能扩大原授权范围；超出范围必须重新授权或人工审批。

### 17.4 Secret Provider

统一身份 / 凭证申请接口，实际凭证由本地代理、企业 Vault、云 Secret Manager 或短期令牌服务提供。

- 凭证最小权限、短期化、可撤销、可轮换。
- Secret 不进入模型提示词、共享上下文、普通任务消息或日志。
- 尽可能由工具适配层直接使用 Secret。
- Hub 记录凭证来源、授权范围和使用结果，不记录凭证内容。
- 模型调用使用独立的 Model Provider 凭证，不能复用 Git / CI / Worker 机器身份。按仓库与项目的数据处理策略限制模型提供商、可发送的源码类别、日志内容及保留范围；敏感源码 / 设备日志默认不得不经批准发送到外部模型。模型上下文预处理、脱敏与授权应在可信控制边界执行，并记录传输目的与使用策略版本。

### 17.5 最终合入边界

Expert 可按授权创建分支、提交 commit、push 工作分支和创建 PR，但不能拥有绕过保护分支的 merge 权限。Git 平台的分支保护、必需 CI 检查和人工审核是最终强制边界。

Approval 绑定明确 commit / PR head SHA、验证证据和策略版本；内容变化后重新校验审批有效性。最终合入由领域负责人或管理员按仓库策略执行。

### 17.6 P0 身份链与凭证委托

P0 明确区分三种身份：

1. **Request Principal**：提交 MCP 请求的用户 / 服务身份，由 Hub 的现有认证层解析并记录。
2. **Worker Identity**：已注册并获管理员批准的 Worker 机器身份，通过 TLS 双向认证证明自身身份；注册凭证只用于注册 / 续期，不能直接用于 Git、CI 或业务工具。
3. **Task Delegation Grant**：Hub 针对某个 TaskRun 签发的短期、受众受限的委托授权，至少包含 `taskId`、`runId`、请求者、组织 / 团队 / 项目作用域、允许的仓库、结构化操作集合、资源范围、策略版本、有效期、唯一 ID 和撤销 / 租约代次信息。Grant 必须使用 Hub 可验证的签名或等效的在线 introspection 机制；Worker 必须校验签发方、受众、有效期、当前 Attempt、租约、本地 Deployment 策略及撤销状态，并支持密钥轮换。

委托授权只能缩小权限，不能扩大 ExpertDeployment 已批准的权限。动态规划或 Agent 输出不能修改授权字段；超出原授权范围时必须重新由 Hub 授权或进入人工 Gate。Worker 断线后不得无限期使用缓存授权；授权或租约到期后停止新的有副作用操作。

Git / CI / 设备凭证采用专用凭证代理或 Tool Adapter 代用机制。优先使用仓库 / 项目级最小权限凭证；创建 PR 的凭证不得拥有受保护分支合入权限。凭证不传给模型，不写入 Prompt、共享上下文、普通日志或 Agent 可任意读取的文件 / 环境变量。读取 Artifact、Skill / Knowledge 或共享上下文时仍需逐资源校验 ACL；知道 ID 或 URI 不构成授权。

## 18. 插件注册、审核、分发和升级

### 18.1 插件注册中心

注册中心管理插件身份、类型、版本、来源、依赖、协议兼容范围、能力声明、发布和撤销状态。适用类型包括 Agent Runtime Adapter、Tool Adapter、Schema Validator / Domain Adapter、Secret Provider、Artifact Store Adapter、Resource Provider、Transport Adapter 和 Model Provider。

### 18.2 审核发布

建议生命周期：submitted → validation → review → approved → released → deprecated / revoked。

发布前检查插件包来源与摘要、协议兼容性、依赖、测试结果、能力声明、权限需求、风险说明、安装 / 升级 / 回滚路径。后续可增加签名制品、来源证明和依赖清单。

插件发布审批与运行时授权是独立控制层。

P0 即使不提供通用插件市场，也必须建立最小信任链：Adapter 由管理员通过受控部署流程预装；Worker 配置精确的 Adapter ID、版本、协议范围、制品摘要和允许列表；启动前核对摘要 / 版本 / 协议兼容性。未知 Adapter、摘要不匹配、协议不兼容或已撤销版本一律拒绝启动。该允许列表是 P0 的运行时授权基础，P2 的 Plugin Registry UI 不能作为首次信任的前置条件。严重安全撤销应阻止新任务，并根据风险策略停止相关运行中的 TaskRun。

### 18.3 版本固定与安全撤销

任务运行时固定 Plugin Release、Adapter、Tool、Schema、模型策略、WorkflowDefinition、Skill / Knowledge revision 和关键环境信息。新任务使用新激活版本。

出现严重安全问题时，可禁止新任务使用问题版本，并按风险策略暂停相关运行任务。不能为版本固定而强制继续运行已知不安全的插件。

## 19. Skill / Knowledge 使用与知识回流

### 19.1 任务知识快照

Expert 在任务开始和需要时通过现有 MCP 获取授权的 Skill / Knowledge，并记录实际使用的版本、修订号或内容摘要、来源和引用。运行中刷新知识应形成显式事件。严格复现的任务固定依赖快照，不能只记录“当时使用最新知识”。

### 19.2 Task Memory 与共享知识分离

- Task Memory：执行历史、工具记录、诊断过程和中间结果，按任务权限和保留策略保存。
- Shared Knowledge / Skill：面向未来任务复用的知识或操作流程，需要审核后发布。

### 19.3 知识候选回流

Expert 可提交根因、修复经验、兼容性说明、排障结论等 Knowledge Candidate，以及可重复操作流程、工具使用方法等 Skill Bundle。

复用现有 Team Skill Hub 候选审核与发布流程。未审核候选不能自动进入共享知识默认检索结果。候选需记录来源 TaskRun、验证证据、适用版本、风险和敏感信息检查结果。

## 20. 异步 MCP API 与客户端交互

### 20.1 逻辑工具

以下为目标接口建议，实施时需与现有 MCP 命名和权限体系核对。P0 的唯一提交主键是 `taskId`，一次执行尝试使用 `runId`；P0 不创建或返回 `workflowId`，也不把 Task 伪装成 WorkflowRun。

**P0 必需工具：**

- `submitExpertTask`：提交单专家逻辑任务，返回 `taskId`、初始状态和查询提示；同一请求重放返回原 `taskId`。
- `getExpertTaskStatus`：查询逻辑任务状态、当前 `runId` / Attempt、事件游标、阶段、阻塞原因和错误摘要。
- `getExpertTaskResult`：获取结构化结论、PR、Artifact 引用和验证证据。
- `cancelExpertTask`：请求取消并返回已接受的取消状态；不承诺外部操作自动回滚。
- `getArtifactMetadata`：查询 Artifact 元数据和经 ACL 检查后允许的读取方式。

**P1 新增工具：** `submitWorkflow`、`getWorkflowStatus`、`resumeWorkflow`、`retryWorkflowStage` 等 Workflow API；它们使用独立的 `workflowId`，并通过 WorkflowNodeRun 关联到 `taskId` / `runId`。P1 不能重新定义或改变 P0 的 Task ID 语义。

所有接口均执行 ACL；知道 taskId、runId、workflowId 或 Artifact URI 不代表有权查看其内容。

### 20.2 幂等提交与状态查询

调用方提供 `idempotencyKey`。唯一约束范围为已认证调用者 / principal + 作用域 + 幂等键；Hub 同时保存规范化请求摘要。相同键与相同摘要返回已有 `taskId`，相同键对应不同摘要返回稳定的冲突错误。创建 Task、登记幂等键、创建初始队列记录和首条业务事件必须原子提交。

状态查询提供当前状态与更新时间、当前 `runId` / Attempt、已完成 / 失败尝试、阻塞原因、重试次数、资源等待信息、PR、Artifact 和 Verification。P0 的响应不得返回未实现的 Workflow 节点或 Plan Revision 字段；P1 增加 Workflow API 后再提供相应字段。日志摘要、事件和 Trace 链接按权限返回。

P0 必须同时支持异步提交、状态查询和 Hub–Worker 服务端事件流。事件流用于及时通知和恢复，不是获取最终状态的唯一方式；断线时仍可通过状态 / 事件查询恢复。

## 21. 可观测性、审计与指标

### 21.1 关联标识

贯穿全链路使用 workflowId、workflowPlanRevision、taskId、runId、traceId、eventId、artifactId、resourceLeaseId 和 approvalId。

### 21.2 数据类型

- 业务事件：状态迁移、计划修订、交接、审批、资源租约和 Artifact 产生。
- 安全审计：认证、授权、凭证申请、权限变更、插件发布、PR 和审批操作。
- 调试日志：模型调用摘要、工具输出、构建诊断等，按更严格访问和保留策略管理。
- 指标：排队时间、执行耗时、重试率、成功率、资源等待、构建时长、成本和错误分类。
- Trace：关联 Hub、Worker、Adapter、Tool、CI 和 Artifact 操作。

审计记录应具备防篡改或可验证完整性机制，并与普通调试日志分开授权。日志必须脱敏，不记录 Token、Secret、敏感环境变量或不必要源码内容。

首期采用统一 Trace + 事件审计 + 指标，不要求完整 Event Sourcing。可接入 OpenTelemetry，但观测后端不能成为业务状态唯一来源。

## 22. 持久化数据模型建议

以下为逻辑实体清单，不是最终数据库 DDL。实施前根据现有数据库、迁移和事务边界做差异分析。

| 实体 | 关键职责 |
|---|---|
| Organization / Team / Project | 三级作用域、成员与默认策略 |
| Worker | 注册状态、机器身份、批准的执行隔离 Profile、主机能力、Adapter 允许列表、最后心跳、协议版本和撤销状态 |
| ExpertDefinition | 版本、领域、Capabilities、ACL、知识策略 |
| ExpertDeployment | Expert / Worker 绑定、工具、SandboxProvider、Workspace、资源和权限 |
| SourceRepository | Expert Platform 独立源码仓库：provider、clone URL、默认分支、scope、凭证引用和状态；不复用 Skill / Knowledge 的 Repository 实体 |
| ExpertDeploymentRepositoryBinding | 某 Deployment 允许操作的 SourceRepository、分支范围和具体 Git / CI 权限 |
| ExecutionSandbox | TaskRun 对应的隔离执行环境：Provider、隔离 Profile、生命周期、Workspace 和资源限制 |
| PluginDefinition / PluginRelease | 插件身份、版本、兼容范围、审核和撤销 |
| ToolDefinition / ToolBinding | 工具契约与实际安装 / 授权绑定 |
| SchemaDefinition | Schema ID、版本、内容摘要、兼容性和发布状态 |
| WorkflowDefinition | 模板版本、DAG、Gate 和默认策略 |
| WorkflowRun | 请求者、服务身份、状态、固定版本和预算 |
| WorkflowPlanRevision | 不可变计划、修改原因、作者和影响节点 |
| WorkflowNodeRun | 节点依赖、状态、结果汇聚信息 |
| ExpertTask / ExpertTaskRun | 逻辑任务与单次 Attempt 分离；调用者 / scope、幂等键及请求摘要、当前 runId、固定版本、委托授权引用、Worker、Adapter、状态、结果与外部副作用对账状态 |
| Workspace | 基础 revision、路径、状态、保留与清理信息 |
| Artifact | 类型、URI、digest、来源、作用域、ACL 和保留策略 |
| Verification | 被测 revision、制品 digest、环境、结果与证据 |
| SharedContextEntry | 内容 / 引用、版本、来源、可信度和 ACL |
| Approval | 审批人、目标 SHA / 版本、结果、理由和策略版本 |
| Resource / ResourceLease | 容量、共享 / 独占模式、持有者、期限、fencing token |
| Event | Hub 权威事件 ID、TaskRun streamId / hubSequence、来源 Worker ID / sourceEventId / sourceSequence、Attempt / fencing 信息、Schema、时间和 payload 引用 |
| WorkerEventSpool | Worker 本地待发事件与消费游标；持久化后保留至 Hub 确认，断线重启后可幂等重发 / 续读 |
| AuditRecord | 操作者、动作、对象、结果、Trace 和完整性信息 |
| SecretBinding | Provider、Secret 引用、用途与授权策略；不存明文 Secret |

### 22.1 一致性边界

- 任务创建、幂等键登记和入队记录原子化，避免任务已创建但未入队或重复创建。
- 状态迁移与业务事件在同一事务完成，或使用可靠 Outbox。
- Artifact 上传和元数据登记采用暂存、校验、确认流程，避免 Registry 指向不完整制品。
- 租约创建、续租、释放使用事务、CAS 或等效并发控制。
- 数据库事务不能覆盖 Git、CI、设备等外部系统；外部副作用需独立幂等和对账。
- P0 采用独立的 Expert Runtime SQLite 文件作为任务运行时的唯一事务域；Task、TaskRun、幂等登记、队列 / Claim 租约、Hub 事件和 Outbox 必须处于同一文件 / 事务边界。Skill / Knowledge 主数据继续由现有 Hub 存储管理，通过 revision / digest 引用，不跨两个数据库宣称原子提交。
- Runtime SQLite 的迁移、备份、恢复和保留策略必须独立登记；P0 仅支持单 Hub 写实例，不宣称多 Hub 并发写或高可用共享队列。备份恢复后，所有进行中的租约 / Attempt 必须先核验 Worker 和外部副作用，再决定续跑、重试或转人工。

## 23. 安全威胁与防护

| 风险 | 必要防护 |
|---|---|
| 未授权调用专家 | Expert ACL、作用域和调用者认证 |
| 通过专家间接越权 | Workflow 服务身份、委托范围、下游独立授权 |
| Agent 任意执行命令 | Tool Registry、工具能力、OS 权限和受限执行环境 |
| 插件供应链风险 | 审核、来源校验、版本固定、撤销与隔离 |
| Secret 泄露 | Secret Provider、短期凭证、最小权限、日志脱敏 |
| 提示注入 / 不可信知识 | 将检索内容视为数据；工具调用仍经策略校验 |
| Artifact 被替换 | 内容摘要、不可变 revision、读取时授权和校验 |
| 旧 Worker 迟到写入 | Lease、fencing token 和 Attempt 校验 |
| 重复外部副作用 | 幂等键、外部操作 ID、先核验后重试 |
| 取消后资源仍占用 | 进程核验、设备代理确认、租约回收检查 |
| 审批对象改变 | 审批绑定 commit / digest / Plan Revision |
| 日志泄露敏感信息 | 脱敏、分级授权、独立保留策略 |
| 动态 Workflow 无限扩张 | 节点数、深度、循环、预算、并行度和时限上限 |
| Worker / Adapter 越权执行 | 独立执行隔离 Profile、结构化 Tool Binding、最小权限 OS 身份和失败关闭 |
| 任务委托凭证伪造 / 重放 | 短期签名 Grant、audience / Attempt / lease 校验、撤销检查和幂等键 |
| 共享资源冲突 | Resource Lease、fencing token、设备独占锁和本地核验 |

## 24. 推荐部署形态

### 24.1 第一阶段

- Hub 继续部署在现有 Team Skill Hub 环境，承担 Control Plane；P0 只支持单 Hub 写实例，暂不宣称多实例高可用。
- Worker 作为独立服务运行在开发电脑、WSL2 或 Linux 构建服务器；只有通过管理员批准的执行隔离 Profile 才能获得写入、构建或凭证能力。
- Adapter 由 Worker 按需启动为独立进程；P0 只允许运行管理员预装、版本与摘要已固定且位于允许列表的 Adapter。
- Artifact 使用 Git、CI 或已有制品存储；Hub 只保存统一元数据与摘要，不中转大型镜像 / 压缩包。
- 设计借鉴 OpenHands 的 Agent / Workspace 分离、SWE-ReX 的执行后端抽象、Container Use 的隔离 Git 工作区、Open SWE 的异步 PR 交付，以及 Temporal 的持久化控制面 / Worker 分离；这些仅作为架构参考，不要求直接引入相应项目依赖。
- P0 使用独立 Expert Runtime SQLite 文件，集中保存任务、Attempt、幂等、租约、事件和 Outbox；其迁移、备份和恢复策略独立于现有 Skill / Knowledge 存储。单个运行时数据库是唯一写入事实源。
- Expert Platform 维护独立 SourceRepository Registry 与 DeploymentRepositoryBinding；不得复用 Skill / Knowledge 发布仓库的 Repository 配置、访问令牌或审核权限。
- Expert Worker 通过 SandboxProvider 创建受限的 ExecutionSandbox；Agent Runtime、执行沙箱与 Workspace 分离，未受信任源码 / 构建命令不得默认在 Worker 宿主高权限环境执行。
- Worker 主动建立出站 gRPC server-streaming 连接；控制 RPC 和事件 ACK 通过同一 Hub–Worker 协议处理。断线按游标补拉并退避轮询；连接 / Worker 身份不能代替 TaskRun 委托授权。
- Git / CI 使用任务范围、仓库范围的最小权限凭证，经凭证代理或 Tool Adapter 使用；创建 PR 的身份不得拥有受保护分支合入权限。最终合入仍走受保护分支与人工审核。

### 24.2 避免过早引入组件

第一阶段不建议同时引入 LangGraph、AutoGen、CrewAI 和 Temporal。

- 先复用现有 Agent Runtime，实现统一 Adapter 契约。
- P0 先用数据库状态机实现可靠异步单专家 Task；P1 再引入 WorkflowRun / 线性 Workflow，随后扩展 DAG。
- 用 DAG 数据模型为并行能力留出基础。
- Workflow 规模和恢复需求增长后，再评估 Temporal 等持久化工作流引擎。
- 事件分发吞吐和多消费者需求明确后，再引入独立消息总线。
- 不要求所有工具都包装成 MCP；统一 Tool Registry + Adapter 可连接 MCP、CLI、HTTP 和自定义接口。

## 25. 分阶段实施计划

### P0：单专家完整闭环与最小运行时治理

1. 对现有 MCP、候选 / 发布流程、数据库、身份和部署脚本做差异分析。
2. 建立 ExpertDefinition、Worker、Deployment 和独立 ExpertTask / ExpertTaskRun 模型；P0 只返回 `taskId` / `runId`，不引入 WorkflowRun。
3. 实现 Worker 注册、管理员审核、机器身份、心跳、撤销和协议版本校验。
4. 实现单一 Runtime Adapter 契约、管理员预装允许列表、版本 / 摘要固定和健康检查。
5. 实现异步任务提交、调用者范围的幂等键、持久化队列、单 Hub 原子 Claim、租约与 fencing token、状态查询。
6. 实现必需的 Hub–Worker 出站 gRPC server-streaming、控制 RPC、事件 ACK / 游标、断线补拉、轮询降级和状态快照恢复。
7. 实现 Hub 权威事件与 Worker 来源事件去重、Worker 本地 spool、状态 + 事件 / Outbox 原子提交。
8. 实现 Task / TaskRun 状态转换表、并发仲裁、协作取消、超时强制终止、未知外部副作用对账和安全恢复。
9. 实现独立 SourceRepository Registry / RepositoryBinding（P0 单 TaskRun 单仓库）、仓库及绑定 revision 固定、受控 Git Broker、每任务 Workspace、SandboxProvider 生命周期、批准的隔离 Profile、结构化 Tool Binding 和任务范围委托授权。
10. 通过现有 MCP 获取 Skill / Knowledge，并固定实际使用的 revision / digest。
11. 在授权与隔离边界内完成自动分析、修改、构建、测试和创建 PR；Git / CI Secret 不暴露给 Agent。
12. 保证最终人工审核和受保护分支合入，完成 Trace、审计、日志脱敏、Runtime DB 备份 / 恢复演练。

**P0 验收：** MCP 提交任务后返回稳定 `taskId`，可异步运行且客户端断开不影响权威状态；Worker 只通过出站连接工作，事件可 ACK / 补拉；重复提交与重复事件不会重复创建任务或重复应用状态；旧 Attempt / 过期租约不能覆盖新结果；不满足隔离或凭证策略的任务失败关闭；结果包含 PR 和测试证据；未授权操作被拒绝；Expert 无法绕过人工审批合入。

### P1：跨专家 Workflow 与可信交接

1. 在不改变 P0 Task API 的前提下引入 WorkflowDefinition / WorkflowRun / Plan Revision，并通过 WorkflowNodeRun 关联 Task / TaskRun。
2. 版本化消息、Schema Registry 和 Artifact Registry。
3. 结构化 Handoff 与能力路由。
4. Workflow 服务身份、跨团队 ACL 和下游独立授权。
5. Shared / Private Context 分层。
6. Resource Registry、租约和设备独占锁。
7. 有限自动重试、失败暂停、取消与恢复。
8. Verification 与源码 / 镜像版本绑定。
9. OTA → Yocto → 集成验证端到端流程。
10. Knowledge Candidate / Skill Bundle 回流。

**P1 验收：** OTA 交付 commit 与测试证据，Yocto 消费准确版本并构建；大镜像不经过 Hub；失败可恢复；输入变化使下游验证失效；阶段可追踪。

### P2：DAG 并行与插件生态

- DAG 并行调度和 Join Gate。
- Plugin Registry 审核发布、版本撤销和兼容性检查。
- 多 Runtime Adapter / 模型策略。
- 多 Artifact Store、Secret Provider、Resource Provider Adapter。
- 跨 TaskRun / 多消费者的高级事件查询、订阅过滤与归档；P0 必需的 Hub–Worker 事件 ACK、游标补拉和重复事件幂等不得延后。
- 成本、资源配额和专家质量指标。
- 按需求接入 OpenTelemetry、消息总线或持久化 Workflow Engine。

### P3：规模化治理

- 更完整的租户隔离和数据保留策略。
- 复杂资源调度与硬件实验室管理。
- 专家能力评测和持续质量评估。
- 受控的外部 A2A / 其他协议适配。
- Workflow 可视化编辑与审计回放。

P3 是演进方向，不应阻塞 P0 / P1 的价值交付。

## 26. 关键验收用例

### 26.1 Worker 与插件

- Worker 未审批时不能领取任务。
- Worker 断线后可重连并恢复状态。
- 插件进程崩溃不会导致整个 Worker 状态丢失。
- 插件协议不兼容时拒绝启动并返回明确错误。
- 旧版本任务不会静默切换到新 Adapter。

### 26.2 幂等与事件

- 相同调用者 / scope / idempotencyKey 与相同请求摘要重复提交返回相同 taskId；相同键不同摘要返回冲突。
- Worker 断线后按 Hub 游标补拉；ACK 只在 Hub 事务提交后返回。
- Worker sourceEventId 重复上报不会重复应用状态迁移；序号缺口返回 gap / snapshot_required。
- 旧 Attempt、过期租约或错误 fencing token 的迟到事件不能覆盖新 Attempt。
- 外部操作响应丢失时先核验，不盲目重试；Worker 本地 spool 未 ACK 的事件在重启后可恢复重发。

### 26.3 Workflow 与 Artifact

- 无依赖冲突的节点可并行，依赖节点不会提前启动。
- Gate 缺少必需证据时不能通过。
- Artifact digest 不匹配时拒绝使用。
- 未授权 Expert 不能被动态 Planner 调用。
- 上游输入变化后相关验证和审批标记失效。
- 动态修改 Workflow 生成新 Plan Revision，历史不可覆盖。

### 26.4 权限与凭证

- 有权调用 Expert 的用户不能因此访问其所有仓库。
- Workflow 服务身份只能在批准作用域和期限内委托。
- Secret 不出现在 Prompt、共享上下文或普通日志。
- Expert / Workflow 服务身份不能绕过分支保护合入。
- 插件发布审批不会自动授予执行权限。
- 伪造的请求者身份、过期 / 撤销的 Task Delegation Grant、错误 audience、其他仓库的 Git 凭证或越权 Artifact 引用均被拒绝。
- Worker 不能读取注册凭证、其他 TaskRun 的 Secret 或宿主未授权目录；Agent 不能访问 Docker socket 或通过继承环境变量获得宿主凭证。

### 26.5 Workspace、资源与取消

- 并发任务拥有不同 Workspace。
- 共享缓存按策略共享，独占设备不能被两个任务同时获得。
- 租约过期但进程仍运行时，不立即把独占资源分配给另一任务。
- 取消后核验进程、设备和外部副作用状态。
- 清理失败时保留诊断信息，不谎报 Workspace 已清理。
- 缺少批准的执行隔离 Profile 时，写入 / 构建 / Secret 操作必须失败关闭；不能通过提示词或字符串规则绕过 Tool Binding。
- 取消与成功完成并发时遵循服务端状态迁移仲裁；终态 TaskRun 不可原地重开，重试创建新 Attempt。
- 修改 SourceRepository Clone URL / Binding 后，运行任务仍锁定旧 revision；仓库安全撤销要阻断新 Push / PR。
- 未授权的 Git 子模块 / LFS 远端、重定向、hooks 和 push refspec 被拒绝；Git Broker 的特权操作不能被 Sandbox 中的任意命令绕过。
- Worker 失联后远端 Sandbox 仍运行时，资源不被重复分配，恢复必须核验进程和设备状态。

### 26.6 OTA → Yocto 端到端

本用例属于 P1 端到端验收，依赖 WorkflowRun API；P0 单专家验收使用 `taskId`，不得把本用例中的 `workflowId` 要求提前到 P0。

1. 用户通过 MCP 提交 OTA 修复请求。
2. Hub 返回 workflowId，客户端可以断开。
3. OTA Expert 在独立 Workspace 修改代码、测试并创建 PR。
4. Workflow 验证输入和证据后，将指定 commit 交给 Yocto Expert。
5. Yocto Expert 在构建机集成该 commit，生成镜像 Artifact 引用和构建报告。
6. 测试阶段从受控存储按需读取镜像，不通过 MCP / Hub 传输镜像。
7. 构建失败按策略有限重试；确定性错误暂停并等待人工介入。
8. 负责人查看变更、测试证据和 PR 后人工批准合入。
9. 各阶段、版本、Artifact、审批和重试均可通过 Trace / Audit 关联查询。

## 27. 实施前必须验证的事项

以下事项不阻塞架构方向，但实施前必须基于现有代码和真实环境验证：

1. 当前 SQLite / 其他数据库的路径、迁移、并发写入、备份 / 恢复和部署卷持久化；独立 Expert Runtime DB 的恢复演练必须验证在途 Attempt 与租约核验。
2. 现有 MCP 工具命名、认证、候选审核、Skill / Knowledge 查询与 revision / digest 标识。
3. Codex / Claude Code 在目标环境中的非交互执行、取消、恢复、认证、子进程跟踪和结果收集能力。
4. WSL2、公司代理、内网与断线重连场景下的 gRPC server-streaming、双向 TLS、事件 ACK / 游标及轮询降级。
5. Windows、WSL2、Linux 构建机和硬件节点的真实权限边界，包括 OS 用户、目录 ACL、网络出口、进程树和资源限制；不能验证的 Profile 不得授予写权限。
6. Git / CI / 制品库能否提供稳定 URI、逐资源 ACL、摘要校验和保留策略。
7. PR、分支保护、必需审核和 CI 检查能否形成最终强制边界；Git 凭证是否确实不具备合入权限。
8. 设备代理能否可靠确认任务停止、外部操作状态和设备释放。
9. Hub–Worker 与 Worker–Adapter 两套独立 .proto 契约的版本协商、兼容性、身份隔离和弃用流程。
10. P0 Adapter 预装 / 允许列表 / 摘要校验 / 撤销、Task Delegation Grant、Secret Provider、日志脱敏和审计保留流程。

在验证完成前，不应声称某个 SDK 已支持所有生命周期能力，也不应假设当前代码已经实现本文描述的全部模型。

## 28. 同类方案的借鉴与取舍

| 参考方案 | 借鉴点 | 本方案取舍 |
|---|---|---|
| LangGraph | Checkpoint、暂停 / 恢复、Agent 内部状态 | 可作为 Adapter 实现，不替代平台级任务治理 |
| Microsoft AutoGen | Agent handoff 与协作模式 | 不把聊天消息当作最终交付事实 |
| CrewAI Flows | 流程编排与任务组织 | 避免重复引入核心状态机 |
| Temporal | 持久化 Workflow、重试和人工信号 | 规模和恢复需求明确后再评估引入 |
| OpenHands | Workspace 与 Agent 执行分离 | 借鉴执行隔离，不绑定其内部实现 |
| OpenAI Agents SDK | 工具、handoff、tracing | 作为可选 Runtime Adapter |
| Agent2Agent (A2A) | 能力描述、任务和 Artifact 契约 | 保留协议 Adapter 扩展点，首期不要求完整接入 |
| GitHub / GitLab | PR、CI、受保护分支 | 作为最终合入治理边界 |
| OpenTelemetry | Trace / Metrics / Logs 标准化 | 作为观测适配，不作为业务状态存储 |

参考文档入口：

- LangGraph：https://docs.langchain.com/oss/python/langgraph/overview
- AutoGen：https://microsoft.github.io/autogen/
- CrewAI：https://docs.crewai.com/
- Temporal：https://docs.temporal.io/
- OpenHands：https://docs.openhands.dev/
- OpenAI Agents SDK：https://openai.github.io/openai-agents-python/
- A2A：https://a2a-protocol.org/
- GitHub protected branches：https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- OpenTelemetry：https://opentelemetry.io/docs/

这些链接用于进一步核对具体能力；本文不表示上述产品已经安装或接入当前项目。

## 29. 已确认的 33 项架构决策

以下为讨论中已确定的决策。后续实现不得在没有明确 ADR 变更的情况下悄悄改变。

| # | 决策 | 确定方向 |
|---:|---|---|
| 1 | Agent 引擎 | 插件化 Runtime Adapter |
| 2 | 专家部署 | 通用 Expert Worker + 多专家实例 |
| 3 | 专家数据交互 | 版本化消息 + Artifact 引用 |
| 4 | 跨专家编排 | Workflow Engine + 动态任务规划 |
| 5 | Workspace | 每个任务独立 Workspace |
| 6 | Artifact 存储与传输 | 元数据集中、文件分布式；原则上不传大型文件 |
| 7 | Handoff | Expert 声明交接需求，Workflow Engine 验证和执行 |
| 8 | 自动化权限 | 自动分析、修改、构建、测试、创建 PR；最终合入人工审批 |
| 9 | 失败恢复 | 有限自动重试，失败后人工介入 |
| 10 | Worker 注册 | Worker 自助注册，管理员审核激活 |
| 11 | Expert 访问控制 | Expert 拥有独立 ACL |
| 12 | 跨专家权限 | 使用经过批准的 Workflow 服务身份 |
| 13 | 版本升级 | 任务运行时固定版本，新任务使用新版本 |
| 14 | 生命周期 | Worker 常驻，Expert 按任务启动 |
| 15 | 知识回流 | Expert 生成知识候选，人工审核后发布 |
| 16 | 模型选择 | Expert 配置多个 Adapter / 模型，由策略选择 |
| 17 | 并行工作流 | DAG 并行与结果汇聚 |
| 18 | Workflow 修改 | 受控动态调整和 Plan Revision |
| 19 | 上下文 | Workflow 共享上下文 + Expert 私有上下文 |
| 20 | 工具体系 | 统一 Tool Registry + Tool Adapter |
| 21 | 资源管理 | Resource Registry + 租约管理 |
| 22 | Hub-Worker 通信 | 持久化任务队列 + Worker 主动出站长连接；P0 使用出站 gRPC server-streaming，连接故障时退避轮询 |
| 23 | 数据契约 | 版本化 Schema Registry + 命名空间扩展 |
| 24 | 身份 / 凭证 | 统一身份与 Secret Provider 插件化 |
| 25 | 资源作用域 | Organization / Team / Project 三级作用域 |
| 26 | 可观测性 | 统一 Trace + 事件审计 + 指标 |
| 27 | MCP 交互 | 异步任务 + 状态查询 |
| 28 | 取消 | 协作式取消 + 超时强制终止 |
| 29 | 插件治理 | 统一插件注册中心 + 审核发布 |
| 30 | 插件隔离 | 独立进程 + 能力受限 RPC |
| 31 | 插件 RPC | gRPC + Protocol Buffers |
| 32 | 长任务事件 | 控制 RPC + 服务端事件流；P0 必须提供 Hub–Worker 事件流，插件 RPC 与 Hub–Worker 身份 / 授权隔离 |
| 33 | 事件可靠性 | Hub 权威序号 + Worker 来源事件 ID / 序号；持久化后 ACK、至少一次投递、游标补拉与幂等消费 |

## 30. 评审结论与下一步

长期架构仍以“稳定协议 + 插件化执行 + 持久化任务 / 工作流 + 版本化交接 + 强治理边界”为主线。本修订版保留 33 项已确认决策，并明确 P0 是单专家 Task 闭环，P1 才引入 WorkflowRun 和跨专家编排；Hub–Worker 事件流、最小执行隔离、任务委托授权、插件允许列表与可靠状态迁移属于 P0 基础，不可作为后续增强延后。

当前文件的状态为“待第二轮设计评审”。下一步应针对本版逐项复核 F-01 至 F-08 的关闭标准，并检查全篇 API、状态、身份、部署拓扑和分期是否一致。只有用户审阅并批准修订后的设计后，才能更新 / 生成正式实施计划；此前已有的 P0 计划属于未批准草稿，不代表设计已通过。未经此评审，不应将本文视为已实现接口或当前系统现状。
