# 仓库设计与计划

本目录面向 Team Skill Hub 仓库维护者。当前保留以下主文档：

- [Architecture](architecture.md)：总体平台背景、Team Skill Hub 核心架构与设计。
- [Client Integration](client-integration.md)：Agent Adapter、Client Event、Evidence、Hook、Codex / Claude Code 接入设计。
- [Evaluation and Candidates](evaluation-and-candidates.md)：Evaluation、Retrieval 回归和自动 Candidate 策略。
- [Skill Bundle Import](skill-bundle-import.md)：多 Skill / 多文件 Bundle 的 MCP + Web 导入、快照更新、审核和单 PR/MR 发布设计。
- [Project Plan](project-plan.md)：当前实现计划、Roadmap 与仍待完成事项。
- [Implementation History](implementation-history.md)：已完成的大型重构、SQLite 迁移、Admin UI 重构及历史 backlog。

判断规则：描述“系统现在为什么这样设计”的内容放前三份；描述“下一步做什么”的内容放 `project-plan.md`；已经完成的过程性记录放 `implementation-history.md`。
