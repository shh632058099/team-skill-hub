# Expert Platform 第二轮架构评审

> 状态：Changes Requested（仍需修订，尚未批准进入编码）
> 日期：2026-10-20
> 被评审文档：`docs/superpowers/specs/2026-10-19-expert-platform-design.md`
> 范围：针对第一轮 F-01～F-08 修订后的整体方案，重点核查新增的 SourceRepository Registry / ExecutionSandbox / SandboxProvider；不改变已经确认的 33 项架构原则。

## 一、结论

**整体方向正确，无需推翻现有 Expert Worker + Runtime Adapter + 持久化 Task / Workflow 架构。**

独立源码仓库注册表的业务边界正确：它与 Team Skill Hub 的 Skill/Knowledge 仓库管理是两个业务领域，不能复用 Repository 配置或权限模型。

执行环境独立化也正确：Worker（控制和监督）、Runtime Adapter（Agent 运行时适配）、SandboxProvider（隔离执行基础设施）、Workspace（源码和构建输出）应保留为可独立替换的抽象。不过当前新增部分仍只是概念性描述，缺少足以保证安全和可恢复性的具体契约。

第一轮 F-01 / F-02 的接口和事件流直接冲突在设计文档中已按 P0 Task、P1 Workflow、P0 server-streaming 进行了消解；F-03～F-08 相关机制也已补写，但其实际可行性仍需后续技术验证。此处不把文档修订等同于实现验证通过。

## 二、第二轮发现

### R2-01 [Blocker] SandboxProvider 生命周期和职责契约不完整

**证据：** 主设计 §12.1（约 488–494 行）引入 ExecutionSandbox / SandboxProvider；§6.1 规定了 Agent Runtime Adapter 的生命周期 RPC；§12.2 规定了 Workspace 生命周期，但没有独立 Sandbox 生命周期与协议。

**风险：** Worker、Adapter、Tool Adapter 和 SandboxProvider 可能分别管理进程、挂载目录、日志、资源和取消，从而出现重复授权、取消无效或状态失真。

**建议修订：** 明确 SandboxProvider 的 `PrepareSandbox`、`MountWorkspace`、`Execute`、`StreamOutput`、`Inspect`、`Cancel`、`Destroy` 等能力契约（具体接口名可调整）。区分 Workspace 内容生命周期与 Sandbox 计算资源生命周期。Sandbox 运行需绑定 `taskId/runId`、隔离 Profile、租约和资源配额。Adapter 不能越过 Worker 直接请求更高权限 Sandbox。

**关闭标准：** 有执行调用时序图、API/契约表和取消/重连/清理失败处理定义。

### R2-02 [Blocker] Tool Adapter 不能成为绕过 Sandbox 的执行通道

**证据：** §7.2 的 Tool Adapter 调用流程、§12.1 的“仅在受限 Sandbox 或经 Tool Adapter 执行”。

**风险：** “或经 Tool Adapter”存在歧义，可能允许未经隔离的构建脚本、Shell 或 Git 命令直接运行在宿主 Worker 高权限用户下。独立进程只提供故障隔离，不自动形成安全边界。

**建议修订：** 凡涉及不可信输入的代码执行、构建、测试和任意命令，必须在获准的 ExecutionSandbox / 等效受限隔离执行器中运行；Tool Adapter 是调用接口，不是豁免隔离的渠道。Git Push/PR、Secret、设备等特殊操作由独立的受控 Broker 执行，每次校验 Task Delegation Grant、RepositoryBinding、参数、目标和副作用幂等键。

**关闭标准：** 清楚区分 Sandbox 内 Tool、Worker 侧 Privileged Broker，并有越权和沙箱逃逸的负向验收测试。

### R2-03 [Blocker] SourceRepository 缺乏任务版本绑定及 Git 安全策略

**证据：** §5.4（约 230–251 行）有独立 SourceRepository 和 Deployment Binding；§12.1 通过 repositoryId/baseCommit 创建 Workspace；§17.6 约束 Task Delegation Grant。

**风险：** 管理员或自动同步修改 Clone URL、默认分支、凭证引用、绑定权限后，任务可能在同一 repositoryId 下使用新的对象；Git URL 重定向、子模块、Git hooks、替换 remote、Push 目标不一致、仓库 fork 等都可能使操作越过原批准目标。

**建议修订：**
- SourceRepository 和 RepositoryBinding 均采用版本化快照或不可变 revision，TaskRun 固定两者及 Git Provider/host/仓库不可变身份。
- 按完整 commit SHA Checkout；明确允许的 remote host、refspec、工作分支前缀、子模块 / LFS / hooks 策略。
- Git 远程访问由受控 Broker 核验 host key / TLS、remote URL 与实际目标；Git 子模块或重定向产生新远端须重新授权。
- Push 和创建 PR 的目标仓库、base branch、head branch 由绑定策略验证；SourceRepository 的编辑不会无声改变正在运行的任务。
- Task 提交只允许引用已注册 repositoryId，未经授权的 Git URL 不进入执行路径。

**关闭标准：** SourceRepository / Binding version pinning、Git 外部副作用规则和仓库篡改测试均有设计定义。

### R2-04 [High] P0 与“多仓库任务”能力界线模糊

**证据：** §5.4 写明“多仓库任务逐仓库校验，跨仓库变更逐个生成证据和 PR”；§25 的 P0 仅定义单专家闭环，未明确多仓库原子性、失败恢复及审批语义。

**风险：** 在一个 TaskRun 中操作多个仓库可能产生部分 Push/PR 成功、其他仓库失败的情况；跨仓库不存在简单的事务。

**建议修订：** P0 支持一个任务一个 SourceRepository；ExpertDeployment 可以关联多个仓库，但单 TaskRun 只能指定一个目标。多仓库原子变更/协作在 P1 Workflow 中由多个 Task 及明确的补偿/对账流程完成，不承诺跨 Git 仓库事务。

**关闭标准：** §5.4、§20 和 §25 对 P0 仓库选择基数一致。

### R2-05 [High] 模型与代码执行平面的凭证隔离仍需明确

**证据：** §12.1 主张 Agent 推理与执行环境分离；§17.6 定义任务委托授权和 Git/CI 凭证，但没有说明外部模型网络和本地源代码访问的敏感数据边界。

**风险：** 即使 Git 凭证不交给 Agent，模型可能从读取的源码 / 工具输出中接触敏感信息；如果模型在宿主进程执行，它可能直接使用宿主其他环境凭证。

**建议修订：** 指定 Runtime Adapter 可读取的数据分类、模型输入过滤和 Secret 防泄露策略；模型使用的账号/Token 与 Git/CI Token 分离；明确用户可选择或管理员可限制的模型提供商和数据处理策略。不允许未授权的任意源码片段或设备日志发送给外部模型。

**关闭标准：** 数据流图标注模型调用边界、凭证边界和源代码流向，形成负向测试。

### R2-06 [High] Worker / Sandbox 失联时的资源与状态协调有缺口

**证据：** §14～16 规定 Hub 任务租约、Worker spool 和旧 Attempt fencing；§12.1 新增远程 Sandbox，但没有明确 Sandbox 自身的 run lease 和远端孤儿进程核验。

**风险：** Worker 失联可能使远端 Sandbox 和构建任务继续运行，造成重复构建、设备竞争和磁盘资源泄漏。

**建议修订：** Sandbox 具有独立 identity、lease、health 与 destroy/inspect 机制；Hub TaskRun Lease 与 Sandbox Lease 在状态机中关联。Worker 重连或被替换时先查询原 Sandbox 实际状态，必要时隔离旧实例，不能仅凭 Hub 租约过期重新分配同一独占设备。

**关闭标准：** 失联/重连/取消/远端 Sandbox 崩溃的时序与验收测试明确。

### R2-07 [Medium] 文档局部组织和术语需整理

**证据：** §5.4 排在 §5.3 前；Worker/Runtime/Sandbox/Workspace 的职责在 §4、6、7、12 各有重叠；§22 的 P0 与 P1 实体未区分。

**建议修订：** 按 §5.3 Capability、§5.4 Repository 顺序排版；新增“架构层组件与责任矩阵”，并给数据实体标注 P0/P1/P2 引入时间。不要求额外抽象层数。

## 三、主要推荐

保持现有核心方向，同时明确：

1. **独立 SourceRepository Registry**：与 Skill/Knowledge Repository 完全分离，仅在底层复用无状态的 Git Provider 工具代码。
2. **SandboxProvider 独立**：生命周期由 Worker 管理，不能替代 Tool Registry / Repository ACL / Artifact Registry。
3. **Tool Adapter 不是权限边界**：高权限 Git/CI/Secret 调用经 Worker 侧 Broker，运行不可信代码必须走隔离执行环境。
4. **P0 先交付单仓库单专家闭环**；P1 再处理多仓库跨专家 Workflow 和部分失败。
5. 不引入第二套 Workflow Engine 或 Agent 内部推理框架。

## 四、评审状态

**第二轮结论：Changes Requested。**

发现 3 个 Blocker、3 个 High、1 个 Medium。建议先修订主设计解决 R2-01～R2-07，再做针对性的第三轮一致性检查。主设计 33 项既有架构决策无需重选；本次仅要求细化它们的执行与权限契约。尚未批准实施 P0。
