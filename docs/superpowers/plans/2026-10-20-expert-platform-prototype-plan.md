# Expert Platform 原型验证计划（问题分析优先）

> 日期：2026-10-20
> 状态：待执行的可演进原型计划（首期只读分析，长期以完整 Expert Platform 为演进目标）
> 架构基线：docs/superpowers/specs/2026-10-19-expert-platform-design.md
> 适用环境：WSL2 Ubuntu 24.04、Node.js 24、TypeScript；Hub 在 WSL2 Docker 中验证
> 说明：本计划只验证“问题交给 Expert 自动分析并返回结论”，不是正式 P0 实施计划，也不改变长期自动修复 / Merge Request 架构方向。

## 1. 核心目标与非目标

**原型业务闭环：用户在真实 Codex CLI 中提出技术问题（可明确指定 Expert，也可不指定）→ Codex CLI 自动调用 Team Skill Hub MCP → Hub 根据任务参数选择“自动匹配”或“指定专家”模式并进行权限 / 能力 / 可用性校验 → Worker 启动真实专家分析 → Hub 保存结构化结果 → Codex CLI 查询并展示结论。**

用户无需持续在线等待；专家可以自主规划分析步骤、检索资料、阅读源码、运行经过授权的只读诊断 / 测试并形成报告。**Team Skill Hub 是任务和完整报告的唯一权威存储，发起任务的原始 Codex CLI 是默认用户展示入口。** 两者不是二选一：CLI 展示摘要与证据，Hub 保存全文、TaskRun、Trace 和 Artifact 引用。

**本原型默认只读，不能修改源码、创建 Commit、Push 分支或提交 Merge Request / Pull Request。** 自动修复、构建部署、创建 MR / PR 是后续独立的能力阶段，不作为本次原型验收条件。

一个可验收的真实例子：

> 在 Codex CLI 中直接说：“OTA 升级过程在写入完成后偶发失败，帮我分析一下根因和调用链。”不告知 Expert ID、Repository ID 或 MCP 工具名称。Codex 判断这属于需要专家分析的任务，自动调用 MCP 分发工具；Hub 路由到 OTA Expert，后者读取获授权源码与知识，返回根因、调用链、证据和建议。
> 或者在 Codex CLI 中明确说：“请交给 OTA Expert 分析 OTA 升级写入完成后偶发失败的原因。”Codex 自动提取指定的 expertId / 专家名称并通过 MCP 下发；Hub **不会重新选择其他专家**，而是验证指定专家、部署、仓库授权及 Worker 可用性。验证失败则返回明确错误或请用户更换专家，不得静默改派。

此例用于说明任务形态，不需要事先指定已知答案；PoC 验证时使用有预期根因的脱敏测试仓库与问题。

## 2. 必须展示的真实能力

1. **Codex CLI 自然语言自动触发**：真实 Codex CLI 使用工具说明自动发现并调用 `submit_expert_task`（以正式 Task API 语义为准，最终 MCP 命名由 CLI 实测确定）。输入以 `problem` 为必填；`expertId` 可选，未指定时 Hub 自动匹配，明确指定时必须按用户意图传递并按指定专家校验；`repositoryId` 也是可选，必须符合所选专家的授权范围。返回 taskId；另提供状态、结果和取消工具。
2. **Hub 支持双模式专家路由**：`expertId` 缺省时，根据问题领域、关键词 / Capability、ExpertDefinition、活跃 Deployment、SourceRepository Binding、请求者 ACL 和 Worker 健康状态自动评分匹配；指定 `expertId` 时跳过候选排序，但仍必须校验专家存在、可访问、具备任务所需能力、部署可用及仓库绑定有效。显式指定失败不能静默降级为自动匹配。两种模式都记录 `selectionMode=auto|explicit`、最终 expertId、选择 / 拒绝原因。
3. **独立源码仓库**：Expert Platform 使用自己的 SourceRepository Registry，不复用 Team Skill Hub 的 Skill/Knowledge 发布仓库配置、凭证或权限模型。原型只需注册一个可访问的只读测试仓库，固定 repository revision 与 baseCommit。
4. **真实 Agent 分析**：使用真实 Codex CLI 或 Claude Code Runtime Adapter，而不是固定脚本伪装推理。Agent 必须能主动选择下一步分析（如查询知识、搜索符号、查看调用关系、运行允许的诊断命令），不是仅生成一次静态回答。
5. **分析工具**：允许只读 Git、grep/rg、阅读文件、必要的安全诊断；如运行测试需要写临时产物，必须限制在临时沙箱，不得改动基线源码或执行 Git 写入。默认禁用 Push/Commit/MR。
6. **结果格式**：保存问题摘要、分析步骤摘要、可能根因、文件/行号和日志证据、证据链接、可信度/不确定性、建议修复方案、尚未验证的假设以及运行状态。不得把推测写成已验证事实。
7. **异步与观测**：MCP 客户端断开后任务继续；状态可查询，至少保留关键事件（已接单、分析中、完成/失败/取消）、任务耗时、Agent 版本和错误原因。Hub 先持久化最终报告，再将其作为 MCP result 供原始 Codex CLI 获取；不能把 CLI 聊天记录当成唯一结果存储。
8. **隔离和权限**：Worker 运行在受控身份下，执行沙箱只暴露批准的仓库与工具；模型凭证、Hub / Worker 凭证不放入日志或任务内容；未授权 repositoryId / Expert / Artifact 被拒绝。

## 3. 原型架构（最小分析链路）

    Codex CLI：用户直接说问题
                |
       模型自动选择 MCP 工具
                v
        submit_expert_task
                |
                v
       Team Skill Hub (Task API + Expert Router)
         |                 |
         |                 +-- 独立 SourceRepository Registry
         |                 +-- Task / TaskRun / Events
         |                 +-- Knowledge / Skill 只读检索
         |
         v
    Expert Worker (主动领取、心跳、状态)
         |
         v
    Agent Runtime Adapter (真实 Expert)
         |
         v
    ExecutionSandbox + Read-only Workspace
         |               |
         |               +-- 已批准的源码版本
         +-- 只读工具 / 授权知识检索
         |
         v
    结构化分析报告 + 证据引用
         |
         v
    MCP get_expert_task_result
                |
                v
    原始 Codex CLI 展示结论与证据

Worker、Agent Runtime Adapter、ExecutionSandbox、Workspace 是独立概念，但原型只实现一种实际运行方式。不为只读分析提前实现 Privileged Git Broker、合并审批 Gate 或跨仓库事务。

### 3.1 结果保存与客户端交互契约

- **Hub 权威结果**：Expert Worker 上报 TaskRun 结果，Hub 验证并在事务边界内持久化 Task 状态、报告索引、结果摘要和 Artifact 引用。只有存储成功后，`get_expert_task_result` 才返回完成态结果。完整报告按任务 ACL 访问，不能根据 taskId 猜测或越权读取。
- **原始 Codex CLI**：通过 MCP `get_expert_task_result` 获得结果，自动向用户展示关键结论、证据、置信度、未解决问题、taskId 和必要的报告引用；不要求用户跳转 Hub 网页才能看到核心答案。
- **短任务**：在真实 Codex CLI 会话仍活动且工具运行预算允许时，Codex 使用任务提交返回的 taskId 查询状态，按带退避的有限次数轮询，完成后直接输出结论；避免无限轮询或长期占用客户端上下文。
- **长任务**：达到客户端等待预算后，原会话显示已提交任务、当前状态和 taskId，并给出继续查询方法。任务在 Hub/Worker 独立继续，不因 Codex CLI 会话退出而失败。再次打开 Codex CLI 时，可用“查询刚才的 OTA 专家任务 taskId”通过 MCP 获取完整结果。
- **自动返回能力的边界**：不能假设 MCP 能主动唤醒已经结束的 Codex CLI 会话，也不能保证 Codex 模型每次都自主持续轮询。自动等待、轮询和展示必须做真实 CLI 测试；若不支持，原型应明确标记为客户端自动取回能力未通过，而不是伪造完成推送。
- **可追踪关联**：返回的任务附带 taskId、选定 expertId、报告版本、创建者、traceId、完成时间；Hub 可以记录请求客户端标识作为审计信息，但不存储或依赖 Codex 内部会话私有 ID 实现跨会话唤醒。

### 3.2 两种演示路径

**路径 A：原会话直接得到结果（优先验收）。** 用户输入技术问题 → Codex 自动调用 dispatch → Hub 路由和启动 Expert → Codex 在等待预算内自动查询 → Hub 持久化报告 → Codex 在原会话输出结论。

**路径 B：跨会话恢复结果（必须验收）。** 用户提问并获得 taskId → 退出 Codex CLI → Worker 继续分析并由 Hub 保存报告 → 用户重新启动 Codex CLI，查询 taskId → Codex 自动调用 status/result 并展示原报告。路径 B 不应声称后台会主动唤醒已关闭会话。

## 4. 原型阶段与验收 Gate

### PoC-0：验证真实 Expert 分析能力

- 在 WSL2 上验证 Codex CLI / Claude Code 非交互运行、模型认证、限定工作目录、超时和退出码。
- 准备一个脱敏、可重复的测试项目，其中有预先设计的调用链问题或已知缺陷，记录标准答案作为验收依据。
- 让真实 Agent 在只读代码环境里自由选择搜索与阅读操作，完成一次具体问题分析。
- 校验其结论是否有准确的源码证据，而不仅是泛泛描述；记录实际 Agent、模型版本和运行日志摘要。
- **Gate A：** 真实 Agent 能根据问题定位测试仓库中的关键函数 / 文件并形成有依据的结论。失败则停留在 Runtime/Prompt/Tool 适配验证，不提前建设完整 Worker 基础设施。

### PoC-1：MCP 任务提交与 Expert 调度

- 最小 SourceRepository Registry、ExpertDefinition / Deployment 和仓库只读 Binding，均与 Skill/Knowledge 发布仓库独立。
- Hub 新增自动分发（dispatch）、status/result/cancel 最小接口与身份检查；提供模型可理解的工具描述和最小入参，不要求手动指定专家。
- Router 同时支持自动路由与显式指定：无 expertId 时从获授权候选按领域 / Capability / 可用性选择；有 expertId 时严格校验指定专家并保持用户选择，不满足条件时返回错误而非改派。记录 selectionMode、最终 expertId、路由原因和 taskId。
- 一个常驻 Worker 能领取任务并启动路由选出的真实 Agent；任务状态、执行结果、路由日志与诊断证据持久化。
- MCP 客户端断开或重连后仍能看到相同 taskId 的状态与结果；Hub 必须在向客户端报告完成之前持久化分析报告和证据索引。
- **Gate B：** 在真实 Codex CLI 中验证两条路径：①只说问题，Codex 自动调用 MCP、Hub 自动匹配专家；②明确说“交给 OTA Expert”，Codex 自动把 expertId 传到 MCP、Hub 校验后只分配给该专家。两条路径都不手动调用 MCP，也不人工转发执行结果；保留 CLI 调用记录与路由审计。

### PoC-2：Knowledge / Skill 与诊断工具

- 专家根据问题从 Team Skill Hub **只读获取授权的 Knowledge / Skill**，并记录检索来源、revision / digest 和引用；这里仅复用知识检索能力，不复用其源码仓库管理。
- 提供受控只读工具访问仓库源文件、符号、调用路径、版本及用户提供的诊断材料。
- 在结论中区分来自源码、日志、Knowledge / Skill 的事实，以及 Agent 推测。
- 对缺少信息的问题，允许明确回答“证据不足”，指出需要补充的日志 / 复现条件。
- **Gate C：** 对至少两个不同的测试问题，Agent 能基于真实工具返回不同且可追溯的分析结论。

### PoC-3：异步可靠性与安全验证

- 提交重复任务 / 幂等键，检查不重复创建逻辑 Task。
- 检验 Worker 断线、Hub 重启、重复事件、超时、取消与恢复后的状态。
- 验证客户端没有访问未绑定的 SourceRepository、Secret、宿主其他目录或未经许可的外部网络的能力。
- 验证分析过程不会修改 Git 工作树，不会生成 Commit、Push 或 MR；测试临时输出在 Sandbox 内清理。
- **Gate D：** 不发生越权与未批准写入；断线/超时/取消有真实验证记录，结果能通过 MCP 继续查询。

### PoC-4：演示、评估与下一阶段建议

- 运行真实 Codex CLI 的两条完整演示：A）原始 CLI 会话自然语言提问并自动通过 MCP 等待/获取最终结果；B）任务提交后退出 CLI，Hub 保留结果，再启动 CLI 根据 taskId 找回同一份报告。
- 保存操作记录、分析报告、关键源码定位、模型版本、时延、失败案例、日志脱敏情况。
- 对照人工已知根因评价准确性、证据支持程度和 Agent 自主使用工具的能力。
- 输出是否进入“自动修复 + Merge Request”下一阶段的建议，以及缺失的写权限、Git Broker、CI 测试和人工审批条件。
- **Gate E：** 不依赖预写结论或假 Agent，复现至少一个端到端完整成功案例，并如实记录失败或不确定结果。

## 5. 建议的数据契约

MCP 提交输入示例（说明性接口，正式字段以代码 / Schema 审核为准）：

    problem: "OTA 库在特定条件下升级失败，请分析根因"
    # expertId 可选，例如 ota-expert；不填则由 Hub 自动匹配
    # repositoryId 可选，须符合所选 Expert 的仓库权限
    context:
      logArtifactId: diagnostic-log-1
    mode: analyze-only

结果示例：

    taskId: task-123
    status: succeeded
    analysis:
      summary: "..."
      hypotheses:
        - description: "..."
          confidence: medium
      findings:
        - description: "..."
          evidence:
            - repositoryId: ota-source
              commit: "<固定源码 commit>"
              file: src/update.c
              line: 128
      suggestedNextSteps:
        - "..."
      unresolvedQuestions:
        - "..."
    execution:
      expertId: ota-expert
      runtime: codex-adapter
      traceId: trace-123

状态 succeeded 表示分析任务按契约完成，不表示报告的所有推测均得到验证。证据不足时必须显式标注不确定性。

## 6. 可扩展性设计约束（首期就必须遵守）

**原型仅收缩业务功能，不临时化核心架构边界。** 采用可运行的纵向切片，未来扩展自动修复、Merge Request、多专家 DAG、多 Worker、插件化 Runtime 时，不重写已有 Task / Router / Worker 核心。

| 领域                | 原型实现                                               | 长期扩展契约                                                                                      |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| MCP / Task          | 自动匹配或显式专家，analyze-only 异步任务              | 固定 taskId/runId；后续增加 executionMode、WorkflowNode 关联，不改变现有任务身份                  |
| Expert Router       | 规则与 Capability、ACL、Deployment 健康检查            | 专家及能力来自注册数据而非 OTA 专用硬编码；路由策略可替换                                         |
| Worker / Transport  | 一个 Worker、持久任务和状态                            | Worker 身份、lease/fencing、事件游标独立；后续多 Worker 无须迁移 Task 语义                        |
| Runtime Adapter     | 一个真实 Codex/Claude Adapter                          | 标准 StartRun/Status/Events/Cancel/Result 接口；新 Runtime 作为插件新增                           |
| Sandbox / Workspace | 一个受限 SandboxProvider、固定 commit 的只读 Workspace | 独立生命周期与工具授权；增加写入 Sandbox 或远程执行无需改 Worker 核心                             |
| SourceRepository    | 独立只读 Registry 与 RepositoryBinding                 | 固定不可变 revision、baseCommit、scope；扩展 Git Broker 和写权限仍与 Skill/Knowledge 发布仓库分离 |
| Knowledge / Tool    | 授权查询与只读工具                                     | Tool Adapter/Binding 独立，未来可加入构建、测试、设备工具；不可绕过权限和 Sandbox                 |
| Result / Artifact   | 结构化分析报告与证据                                   | 带 schemaVersion 和 Artifact 类型；未来追加 patch、verification、merge-request，不破坏旧分析结果  |
| Workflow            | 不实现 WorkflowRun                                     | P1 通过现有 Task/Run 组成 WorkflowRun/DAG，不修改 P0 Task API                                     |

### 6.1 模块边界及依赖规则

- Domain 包含 Task/TaskRun、状态迁移、Expert / Repository 身份及授权契约；Application 包含 TaskService、ExpertRouter、Policy；Infrastructure 实现 SQLite、gRPC、Git、RuntimeAdapter、SandboxProvider。MCP / HTTP 只作为入站适配层。
- 领域逻辑不得直接依赖某个 CLI 命令、固定 Prompt、文件路径、具体数据库或 Docker 命令；通过类型化接口注入实现。
- 原型只实现确有用例的接口，**不提前开发空的 Workflow Engine、Plugin Registry、Schema Registry、复杂管理 UI**；但端口命名、持久化 ID 和 Schema 保持与最终设计一致。
- 不允许在通用 Router / TaskService 中硬编码 ota-expert、测试仓库 URL 或模型名称。增加第二个领域 Expert 应只需新增定义、部署、授权及必要领域 Prompt / Skill。
- SourceRepository、DeploymentRepositoryBinding、TaskRun 必须固定各自 revision、baseCommit、runtimeVersion、policyVersion、traceId，防止后续扩展破坏审计与重放。
- SQLite 使用可迁移 Schema；旧 Task/Run/Result 可读取。结果采用版本化类型，不把所有任务输出固定成 analysis 字段。未知类型明确拒绝或按兼容策略处理，禁止无声丢字段。
- 原型复用正式设计中的 Worker/Adapter/Sandbox/Workspace 分层；实现可以精简，但不能让 Tool Adapter 绕过隔离边界。Git Broker 暂不实现，但扩展接口和凭证隔离边界必须清楚。

### 6.2 可扩展性验收测试

1. 加入第二个 Expert（例如 Yocto）并绑定不同 SourceRepository，不修改通用 Router/TaskService 代码；自动路由和指定路由均通过同一授权路径。
2. 用契约测试替换 RuntimeAdapter 或 SandboxProvider，通用任务服务无需修改；真实 CLI 端到端测试仍须运行真实 Agent。
3. 模拟第二个 Worker 竞争领取，验证原有 taskId/runId、lease、fencing 和事件契约不变。
4. 增加新的结果 / Artifact Schema 并验证旧版分析报告仍可读取；数据库迁移不丢任务状态和审计记录。
5. 给出一张“当前模块 → 后续自动修复/MR/Workflow 所需扩展点”映射表，记录原型简化项、替换成本及技术债，不允许形成第二套并行业务模型。

## 7. 原型代码组织

建议在现有仓库下先隔离原型代码，不污染已投产的 Knowledge / Skill 逻辑：

    prototypes/expert-platform/
      README.md
      proto/
      hub/
      worker/
      runtime-adapters/
      sandbox/
      analysis-tools/
      fixtures/
      tests/

原型以 Node.js 24 + TypeScript 为主，遵循项目的 ESLint、Prettier 和测试风格。服务在 WSL2 Docker 中验证，Agent CLI 在 WSL2 中实际执行。具体沙箱实现由 PoC-0 的真实环境探针确定，但不能以无约束宿主高权限模式替代。

## 8. 原型通过标准

- [x] 自动模式：真实 WSL2 Linux Codex CLI 中只输入技术问题，不指定 expertId 或 MCP 工具名；Hub 自动路由至 `ota`，返回 taskId、`selectionMode=auto` 和真实分析报告。详见 [原型验收记录](../reviews/2026-10-21-expert-platform-prototype-acceptance.md)。
- [x] 指定模式：真实 WSL2 Linux Codex CLI 明确指定 OTA Expert，先通过 `list_available_experts` 获取平台 Expert ID，再提交任务；Hub 返回 `selectionMode=explicit` 并成功执行，没有静默改派。详见 [原型验收记录](../reviews/2026-10-21-expert-platform-prototype-acceptance.md)。
- [ ] 指定了不存在、无权限、能力不符或不可用的专家时，返回清晰错误；自动模式无匹配或多个候选歧义时，也不随意路由或越权。
- [x] 两种模式均保留 selectionMode、最终 expertId 和路由审计证据；本次两条真实任务均可从 MCP 状态/结果工具读取。
- [x] 真实 Agent 在 Worker 的 Docker 执行环境中读取授权源码并完成只读分析，而不是模拟分析结果（Task `8b16dcd4-2b57-4a99-ac56-32dd3880b5f4`，自动路由至 `ota` / `otalib`，由 `ota-worker-01` 执行）。
- [x] 返回结构化结论，包含真实源码文件/行号、风险分析和测试缺口；本次报告记录在 Hub 的持久化 Task Result 中。
- [ ] 不修改源码、不创建 Git Commit、不 Push、不创建 MR/PR。
- [x] 新执行配置通过 Git URL / branch 定义 SourceRepository，Worker 负责 clone/fetch；它与 Skill/Knowledge 发布仓库注册表独立。旧 repositoryIds 继续兼容。完整安全 Gate 仍暂缓。
- [x] 任务状态持久化，CLI 执行超时/结束后，可在新的 WSL2 Codex CLI 进程中按 taskId 重新查询状态和报告。
- [x] Hub 持久化完整报告及其源码证据；新的 CLI 进程可通过 MCP 读取已完成的报告。
- [ ] 在真实 Codex CLI 原会话中验证：任务在有限等待窗口内完成时，CLI 能自动使用 MCP status/result 取回并展示最终结论；记录真实工具调用轨迹，不以人工调用代替。
- [x] 在原始 CLI 进程结束后，新的 Codex CLI 进程已通过 taskId 获取 Hub 已保存的报告；不依赖唤醒原会话。
- [ ] 取消、失败、越权和重要断线场景有测试或真实演练记录。
- [ ] 至少一个有已知根因的问题通过独立人工核查分析质量，另外一个不同问题能够获得非模板式分析。（已有两份不同主题的真实报告，但 OTA 原生测试环境尚未通过，仍需独立核查。）
- [ ] 给出下一阶段自动修复 / Merge Request 的扩展建议，但本次不实现。
- [ ] 新增第二个领域 Expert / 源码仓库不修改通用路由逻辑；自动与显式路由都通过一致的 TaskService。
- [ ] RuntimeAdapter / SandboxProvider 可替换的接口有契约测试，领域代码不依赖单一实现。
- [ ] Task/Run/Event/Result 版本化与数据库迁移可测试，新增修复 / MR Artifact 不破坏旧分析结果。
- [ ] 文档明确从原型升级到完整 Expert Platform 的模块映射、简化项和 ADR，不产生两套重复核心。

- [x] Admin 提供“专家配置”和“执行配置”管理入口，支持创建、编辑、列表和启停；界面与 MCP/Worker 共用 `EXPERT_RUNTIME_DB`，CLI 管理入口继续保留。详见 Admin 专家配置端到端测试。

## 9. Review 修订：冻结的最小契约与安全边界

> 本节是 PoC-0 至 PoC-4 的强制实施约束，优先于前文说明性示例。原型只缩小功能范围，不引入与正式 P0 不兼容的临时业务模型。落地前核对现有代码的接口/迁移版本；未经验证的实现细节不作为既成事实。

### 9.1 MCP 与 Task API 映射

- 领域服务采用正式设计的 `submitExpertTask`、`getExpertTaskStatus`、`getExpertTaskResult`、`cancelExpertTask`、`getArtifactMetadata` 语义；MCP 暴露的工具可按现有 snake_case 惯例命名为 `submit_expert_task`、`get_expert_task_status`、`get_expert_task_result`、`cancel_expert_task`、`get_expert_artifact_metadata`。早期文中的 `dispatch_expert_problem` 仅是说明性别名，**不得作为另一套任务 API 实现**。最终名称以真实 Codex CLI 的 MCP 发现测试确认，统一文档、工具描述和测试。
- 提交必填 `problem`；可选 `expertId`、`repositoryId`、授权 `context`；服务端固定 `mode=analyze-only`。正式请求还必须有 `idempotencyKey`（由 MCP 客户端或入站适配层生成并在重试时稳定复用），绑定认证 principal/scope；只允许引用预登记的日志 Artifact，不接受任意本地路径/URL 或可执行命令。
- 提交返回 `taskId`、初始状态、`selectionMode` 和查询提示；执行尝试使用独立 `runId`。所有响应提供 `schemaVersion`，结果及 Artifact 必须带版本。不要在 P0 原型生成 `workflowId`。
- 强制稳定错误码：`INVALID_REQUEST`、`IDEMPOTENCY_CONFLICT`、`EXPERT_NOT_FOUND`、`EXPERT_FORBIDDEN`、`EXPERT_INCAPABLE`、`EXPERT_UNAVAILABLE`、`REPOSITORY_FORBIDDEN`、`AMBIGUOUS_EXPERT`、`TASK_NOT_FOUND_OR_FORBIDDEN`、`TASK_NOT_READY`、`TASK_CANCELLED`、`RESULT_UNAVAILABLE`；错误不得泄露未经授权的资源是否存在。
- 查询、取消、报告和 Artifact 读取均以请求者身份及 task scope 重新授权；taskId 不充当访问令牌。Codex 自动调用不等于模型能自行授予仓库权限。

### 9.2 状态、幂等与 Worker–Hub 交互

- 使用独立 Expert Runtime SQLite 文件作为 Task、TaskRun、幂等、队列、lease、事件及 Outbox 的**唯一事务域**；与 Skill/Knowledge 主数据库只通过 revision/digest 引用，不宣称跨库事务。首期仅一个 Hub 写实例，数据库迁移必须可重复测试、保留旧记录。
- `(principal, scope, idempotencyKey)` 唯一，额外保存规范化请求 digest；同键同请求返回原 taskId，同键不同请求返回 `IDEMPOTENCY_CONFLICT`。Task 创建、幂等记录、队列项和首条 Event 必须在同一事务提交。
- Task 与 TaskRun 分离。最小 Task 状态：`queued → running → succeeded|failed|cancelled`，另允许 `queued → cancelled`；重试生成新 runId/attempt 而不是覆盖旧记录。任何非法迁移必须拒绝并审计。超时是失败类别，不直接冒充正常完成。
- 任务领取通过原子 CAS/事务 + 有效期 lease + 单调 fencing token；所有续租、状态、事件与最终报告写入都校验 workerId/runId/attempt/fencing。过期 Worker 的迟到成功不得覆盖新 Attempt。恢复之前要先核验旧 Agent 进程与运行副作用，禁止不加判断地并发重启。
- Worker 使用独立、可撤销机器身份；一次性短时 Enrollment 经管理员审核后激活，pending/suspended/revoked Worker 不能领取任务；Worker 不复用个人/管理员 API Key。TLS 和机器认证是必需项；替代 mTLS 的方案需要 ADR 解释轮换和撤销。
- 对齐正式设计：Worker **主动出站**建立 gRPC + Protobuf 连接，Hub–Worker 必须提供控制 RPC、服务端事件流、ACK、事件游标/补拉和断线退避轮询降级。事件同时有 Hub 单调序号与 Worker sourceEventId/sourceSequence；Hub 持久化成功后才 ACK，重复事件去重，序号缺口触发补拉/快照恢复。Worker 未 ACK spool 在重启后可重发。
- 取消请求只表示已接受：向当前有效 Attempt 发送协作取消、到期强制杀进程树并核验，再释放租约与沙箱；取消/完成并发由事务状态机仲裁，不承诺撤销外部副作用。

### 9.3 只读 Sandbox 的强制约束

> **范围决策（2026-10-21）：本轮安全 Gate 暂缓实施，仅保留为未完成的后续验收项。** 当前不开展沙箱加固或安全 Gate 实作，也不得把现有沙箱视为已通过安全验收。以下约束仍是未来处理不可信源码、扩大 Worker 执行权限或进入更广泛部署前的强制门槛；重新排期前应避免将其误解为本轮实施任务。


- Prompt 中的“只读”不能当作隔离手段。PoC-0 首先探针验证 SandboxProvider；达不到隔离要求不得运行真实不可信源码。
- 每个 TaskRun 使用独立 Workspace；指定 commit 的源码快照以文件系统权限**只读挂载**，临时写目录和缓存单独隔离；低权限用户运行 Agent，限制进程、内存、CPU、时长和输出体积。根文件系统/宿主其他目录不可写且不可读未经授权内容。
- Tool Adapter 只允许经 Deployment Binding 授权的结构化操作；不得把任意 shell 命令、路径、环境变量或网络目标透传给 Agent。构建/测试即使会写临时产物，也只能在批准的临时沙箱内执行；不能修改源码基线。
- 默认拒绝外网访问，必要的模型 API/Hub/知识服务经过明确定义的网络出口与域名策略；模型凭证只能由隔离的 Provider 提供，不能出现在工具输出、Prompt、日志或 Artifact。所有外部材料视为不可信输入，防止提示注入绕过授权。
- Gate D 增加路径穿越、符号链接逃逸、Git 写操作、子进程遗留、环境变量窃取、网络外传和越权 Artifact 查询的否定测试；验证源码树 `git status` 无修改且基准 commit 不变。

### 9.4 Expert Router 的可复现规则

1. 根据 principal/scope、仓库授权、必要 Capability、Deployment、Worker 健康检查与执行策略执行硬过滤；不满足立即拒绝，禁止将过滤项靠高评分抵消。
2. `expertId` 显式提供时仅校验该专家，不做自动兜底；名称映射有歧义时返回稳定错误并提示允许的选择。
3. 自动模式仅对获授权候选根据固定的领域/关键词/Capability 权重评分；初期配置在版本化路由策略中，阈值及 top1-top2 差值需使用测试语料校准。无合格候选拒绝，差值不足视为 `AMBIGUOUS_EXPERT`，不得任意选第一名。
4. 每次决策记录 `selectionMode`、policyVersion、候选及过滤原因（敏感信息按 ACL 脱敏）、最终 expertId、固定 Deployment/Repository revision。第二专家/不同仓库接入不得修改 Router/TaskService 通用代码。

### 9.5 报告持久化、终态与 CLI 边界

- Worker 先暂存完整报告和证据 Artifact，检查 schemaVersion、内容 digest、证据引用、仓库 commit 和任务 ACL；确认可读取之后，在 Hub 单一事务内提交报告索引、Artifact 元数据、Task/Run 终态及事件。只有上述步骤全部成功才向查询方返回 `succeeded`。暂存文件失败/报告写入失败必须保持非成功状态并可安全重试或报告失败。
- 结构化报告将 `verifiedFinding` 与 `hypothesis` 分开，并引用精确文件/行号/commit、日志摘要、Knowledge digest、置信度及未验证事项；`succeeded` 只表示分析执行成功，不保证每一项假设为真。
- CLI 仅有限次数、有退避地查询；达到等待预算时仅返回 taskId 和继续查询说明。关闭的原 Codex CLI 会话不会被 MCP 自动唤醒。真实测试必须分别验证原会话可自动取回，以及重新启动 CLI 后根据 taskId 手动发问并自动调用查询工具取回。

### 9.6 实验固定配置及验收矩阵

- 固定并记录 Codex CLI/模型版本、MCP tools 列表及描述、RuntimeAdapter 版本、Sandbox Profile、Repository commit、路由规则版本、测试提示词、预期根因；使用脱敏且具有标准答案的 fixture，保留真实 CLI 工具调用轨迹。
- 最少覆盖：自然语言自动匹配、显式专家、两个不同领域的问题、无匹配、歧义、越权、幂等冲突、双 Worker 争抢、旧 lease 结果拒绝、重复事件、Worker 断线、Hub 重启、取消和完成并发、报告持久化失败、跨会话恢复、沙箱逃逸否定测试。
- 模型触发属于非确定行为。自动/指定模式均至少重复运行 5 次，记录分母、成功次数、失败原因、耗时及真实工具调用；不能用人工直接调用 MCP 代替 Codex 自动工具选择。若原会话轮询不能稳定自动完成，标记 Gate B/E 未通过而不是声称支持自动推送。

## 10. Superpowers 实施计划拆分（执行前必须细化）

本文件保留为 PoC 总体设计与 Gate；实际执行前需按 `superpowers:writing-plans` 形成单独、可执行的 implementation plan。每个 Task 必须写明精确文件路径（基于当前源码确认）、接口输入输出、先失败再通过的测试代码、具体运行命令和预期结果、独立 Review Gate，禁止 TBD/占位实现。按 `superpowers:executing-plans` 或 `subagent-driven-development` 逐任务执行；不因本计划存在而授权部署、commit 或 push。

| Task                          | 独立交付                                                            | 关键验收                                 |
| ----------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| 0. Runtime Spike              | 真实 CLI 非交互调用、受限 Sandbox 探针、结构化输出和进程树取消      | 有可重复命令/日志；隔离验证不过不得前进  |
| 1. Task 契约及 SQLite         | Task/Run/Event/Result/Artifact Schema、事务、迁移、幂等、状态机     | 幂等冲突、重开恢复、非法迁移测试         |
| 2. Worker 通道                | Enrollment、独立身份、gRPC/Protobuf、Lease/Fencing、ACK/Spool、重连 | 双 Worker 竞争、旧 Attempt、断线补拉测试 |
| 3. Router 与 SourceRepository | 独立 Registry/Binding、显式与自动模式、ACL、路由版本                | 第二专家接入无通用代码修改               |
| 4. Sandbox 与 Agent           | 真实 Runtime Adapter、工具授权、只读 Workspace、报告/证据           | 真实 Agent 诊断与越权否定测试            |
| 5. MCP 与 Codex CLI           | 提交/status/result/cancel 工具及真实客户端配置                      | CLI 自主发现、自动分发、查询与取消       |
| 6. 完整 Gate                  | 端到端自动/指定模式、报告一致性、重启恢复、度量和 ADR               | Gate A–E 逐条有证据，未通过项如实记录    |

执行顺序遵循依赖关系：Task 0 先行；Task 1–2 为异步基础；Task 3–5 形成纵向链路；Task 6 最终验收。原型只分析不创建 PR；日后加入修复/MR 必须复用这些 Task/Run、Worker 和 Sandbox 边界，不建立第二套核心。

## 11. 下一阶段：自动修复与 Merge Request（非本次 PoC）

待原型通过后，在相同 Task / Worker / Runtime / Sandbox 基础上增加：

- analyze-only 与 propose-fix / apply-fix 等更高权限的任务模式，默认仍为只读；
- ExpertDeploymentRepositoryBinding 的写入授权与逐任务的 Task Delegation Grant；
- 代码修改、独立工作分支、单元 / 集成测试、Patch / Diff 审查；
- Git Broker 处理受控 Push、创建 GitLab Merge Request / GitHub Pull Request；
- 持续集成验证、人工批准与受保护分支合入；
- 后续再扩展多专家 Workflow。

**范围原则：先证明 Expert 能接单并把问题分析正确，再扩大到自动修复与交付。**
