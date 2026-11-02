# 仓库设计与计划

本目录面向 Team Skill Hub 仓库维护者。当前保留以下主文档：

- [Architecture](architecture.md)：总体平台背景、Team Skill Hub 核心架构与设计。
- [Client Integration](client-integration.md)：Agent Adapter、Client Event、Evidence、Hook、Codex / Claude Code 接入设计。
- [Evaluation and Candidates](evaluation-and-candidates.md)：Evaluation、Retrieval 回归和自动 Candidate 策略。
- [Artifact Bundle](artifact-bundle.md)：当前 Skill / Knowledge 统一 Bundle、Merge / Replace、Snapshot、审核和发布语义。\n- [Skill Bundle Import (Historical)](skill-bundle-import.md)：统一 Artifact Bundle 之前的 Skill-only 设计，保留作历史参考。
- [Project Plan](project-plan.md)：当前实现计划、Roadmap 与仍待完成事项。
- [Implementation History](implementation-history.md)：已完成的大型重构、SQLite 迁移、Admin UI 重构及历史 backlog。

判断规则：描述“系统现在为什么这样设计”的内容放前三份；描述“下一步做什么”的内容放 `project-plan.md`；已经完成的过程性记录放 `implementation-history.md`。
