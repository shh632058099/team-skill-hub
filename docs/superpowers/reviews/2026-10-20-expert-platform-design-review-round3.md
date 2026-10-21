# Expert Platform 第三轮设计一致性评审

> 日期：2026-10-20
> 对象：docs/superpowers/specs/2026-10-19-expert-platform-design.md
> 结论：Conditional Pass（文档层面条件通过；正式实施前需完成 Runtime、安全与协议的真实验证）

## 第二轮问题复查

| 问题 | 修订结果 | 状态 |
|---|---|---|
| R2-01 SandboxProvider 职责 | §12.1.1 新增组件职责表、生命周期、执行时序和取消 / 核验契约 | 文档层面关闭 |
| R2-02 Tool Adapter 绕过隔离 | §12.1 规定不可信命令在 Sandbox 内执行；特权 Git/CI/设备操作交 Broker 二次授权 | 文档层面关闭 |
| R2-03 SourceRepository 安全与版本固定 | §5.3 新增独立 revision、remote/host/refspec、hooks/submodule/LFS 和 Git Broker 规则 | 文档层面关闭 |
| R2-04 多仓库边界 | §5.3、§25 明确 P0 单 TaskRun 单仓库，P1 多仓库 Workflow | 文档层面关闭 |
| R2-05 模型凭证与数据 | §17.4 规定模型凭证独立、外发源码分类策略 | 原则已补充，策略 Schema 待定 |
| R2-06 失联沙箱 | §12.1.1 新增 Sandbox ID、独立租约、Inspect 和孤儿进程核验 | 文档层面关闭 |
| R2-07 术语 / 章节 | §5.3/5.4 顺序及 §12.1.1 责任矩阵已调整 | 基本关闭 |

## 方向性判断

- Expert Worker 专注调度、身份与监督；Agent Runtime Adapter 专注 Agent 执行契约；SandboxProvider 专注计算与 OS 隔离；Workspace Manager 专注代码与文件快照；Tool Adapter 专注类型化工具接口；特权 Broker 专注 Git/CI/Secret/设备副作用。
- Expert Platform 的 SourceRepository Registry 独立于 Team Skill Hub Skill/Knowledge 发布仓库，不复用业务配置和凭证。
- P0 单专家单仓库；P1 多专家多仓库 Workflow。33 项原先的架构决策继续保持。
- 未发现需要推翻总体架构的根本问题；仍不能把文档层面的边界定义当作已经验证的隔离能力。

## 在正式实施计划之前必须验证

1. Codex / Claude 的非交互运行、工具限制、子进程取消、模型与 Git 凭证隔离。
2. Git 仓库身份、revision、remote/refspec、子模块、hooks、LFS 和 PR Broker 的安全路径。
3. Node.js gRPC streaming 与 Worker 机器认证、游标 / ACK、租约 / fencing 及 SQLite 事务。
4. Worker / Sandbox 失联、远程孤儿进程和资源回收。
5. Expert Runtime 数据库备份恢复、模型数据策略和日志脱敏。

## 结论

第三轮对文档的一致性检查为**条件通过**：允许以此版本作为后续验证和 P0 计划修订的架构基线，但不是对真实执行或安全性的最终验收。之前保存的 P0 实施计划仍是早期草稿；需要根据最新 SandboxProvider、独立源码仓库、Git Broker 重新编制并经用户确认后，方可实施。
