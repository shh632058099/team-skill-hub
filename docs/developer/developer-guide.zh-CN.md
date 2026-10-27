# Team Skill Hub 普通开发者指南

本文只面向使用 Team Skill Hub 的普通开发者。部署、管理员配置、Repository 运维、Evaluation 和内部实现请查看 `../deployment/` 与 `../repository/`。

## 1. 你需要向管理员获取什么

只需要两项：

```text
MCP URL: https://<skill-hub-host>/mcp
Developer API Key: skh_...
```

API Key 只放在本机环境变量 `TEAM_SKILL_HUB_API_KEY` 中，不要写进项目仓库、聊天、日志或工单。

## 2. 快速接入 Codex

Linux / macOS / WSL：

```bash
export TEAM_SKILL_HUB_API_KEY='skh_...'
bash scripts/setup-codex-mcp.sh --url https://<skill-hub-host>/mcp
codex mcp list
```

Windows PowerShell：

```powershell
$env:TEAM_SKILL_HUB_API_KEY='skh_...'
.\scripts\setup-codex-mcp.ps1 -Url https://<skill-hub-host>/mcp
codex mcp list
```

接入脚本会自动完成 MCP 接入和知识回流所需配置，普通开发者不需要手工维护内部 Hook 或 Agent 配置。

自动知识候选默认开启。如果团队不希望启用，可在安装时增加 `--no-auto-knowledge`，PowerShell 使用 `-NoAutoKnowledge`。

### 手工配置 Codex

如果不使用接入脚本，在 `~/.codex/config.toml` 中增加：

```toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
```

然后重新启动 Codex。

## 3. 快速接入 Claude Code

Linux / macOS / WSL：

```bash
export TEAM_SKILL_HUB_API_KEY='skh_...'
bash scripts/setup-claude-code.sh --url https://<skill-hub-host>/mcp
claude mcp get teamSkillHub
```

Windows PowerShell：

```powershell
$env:TEAM_SKILL_HUB_API_KEY='skh_...'
.\scripts\setup-claude-code.ps1 -Url https://<skill-hub-host>/mcp
claude mcp get teamSkillHub
```

## 4. Client Integration 更新

setup 脚本会完成一次性的本地 Team Skill Hub Client Runtime bootstrap。完成后，Hub 接入逻辑再次变化时，正常情况下**不需要**研发重新下载并执行新的 setup 文件。

Codex/Claude 在 SessionStart 可能提示有新版本。检查使用缓存并且 fail-open，不会静默升级。只有用户明确要求升级时，客户端才应执行：

Linux / macOS / WSL：

```bash
~/.team-skill-hub/bin/team-skill-hub-client upgrade
```

Windows PowerShell：

```powershell
& "$HOME\.team-skill-hub\bin\team-skill-hub-client.ps1" upgrade
```

如果提示为 required update，升级成功后需要重启 CLI。排查和恢复时使用同一个 launcher 路径并传入 `doctor` 或 `rollback`。旧的 setup `--upgrade` / `-Upgrade` 仅保留给首次迁移或 launcher 损坏时的灾难恢复。

setup 会记录实际解析后的 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`，后续升级继续修改原安装位置。state 只保存 API Key 的环境变量名称，不保存 API Key 值。

## 5. 验证连接

让客户端执行：

```text
使用 teamSkillHub 的 get_server_info 检查连接，
然后列出我当前可以访问的 Repository。
```

成功后即可正常使用 Team Skill Hub。

## 6. 日常怎么使用

不知道该用什么时，优先让客户端使用 `discover`。

简单理解：

- 找团队操作流程、规范和经验方法：Skill
- 找设计、接口、故障记录和项目事实：Knowledge
- 找可复用任务指令：Prompt
- 找团队预定义工作角色：Agent

普通开发者不需要记完整 MCP 工具清单，让客户端根据任务选择即可。

### 示例：代码 Review

```text
使用 teamSkillHub 查找适合当前代码 Review 的团队 Skill 和 Knowledge，
加载真正相关的内容后再开始 Review。
```

### 示例：查项目设计

```text
在 teamSkillHub 中搜索当前 OTA 断电恢复设计，
使用最相关的 Knowledge 作为依据回答。
```

### 示例：复杂任务

```text
先使用 teamSkillHub discover 查找与当前任务相关的 Skill、Knowledge、Prompt 或 Agent，
只加载真正需要的内容。
```

建议按需加载，不要一开始把所有 Skill、Knowledge 和资源全部塞进上下文。

## 7. 如何创建 Skill

当一次任务形成了稳定、可复用、已经验证的操作流程时，可以整理成 Skill。

先让客户端生成并验证完整 Skill 目录，检查后再作为 Skill Bundle 提交。即使只有一个 `SKILL.md`，也仍然是 Bundle。例如：

```text
把刚才已经验证通过的流程整理成一个可复用 Skill。
先生成完整 SKILL.md 给我检查，不要直接发布。
确认后使用 teamSkillHub 的 submit_skill_bundle，并设置 import_type=skill。
提交完整 Skill 根目录，包括 SKILL.md 以及可选的 scripts/、references/、assets/ 等文件。
```

提交只会创建待管理员审核的 Skill Bundle Import，不会直接写正式仓库。

## 8. 如何回流 Knowledge

Knowledge 适合沉淀“当前事实”，例如设计说明、接口说明、故障根因、测试结论和项目约束。

### 自动回流

使用 Codex 接入脚本时，自动知识候选默认开启。系统只会在任务包含明确工程动作和验证证据、并满足可复用条件时创建 Candidate。

自动候选仍然必须经过管理员审核，不会直接发布。
新的 Knowledge Candidate 会与同仓库已发布的 Markdown 文档进行匹配。唯一且高置信度的匹配会指向原文档路径，供管理员审核更新 Diff；存在歧义时仅给出建议，不自动覆盖。管理员可明确选择新建。Skill Bundle 的匹配结果仅作为预览建议，不会覆盖提交时指定的 namespace/skillPath。

### 手工回流

如果本次任务产生了稳定、可复用、已经验证的新知识，可以使用 `submit_knowledge_candidate`。

不要在客户端或自己的提示词里长期保存固定章节、标题长度或正文长度。管理员可以在服务端调整 Knowledge Submission Spec，因此每次提交前应先调用 `get_knowledge_submission_spec`，按返回的当前模板和规则整理内容，并把返回的 `spec_version` 一起传给 `submit_knowledge_candidate`。

建议流程：

```text
1. 调用 get_knowledge_submission_spec 获取当前规则、模板和 spec_version。
2. 按当前模板整理本次已经验证的结论，不要补写 unknown / N/A / 未验证内容。
3. 调用 submit_knowledge_candidate，并传入刚刚获取的 spec_version。
4. 不要包含 Token、密码、客户敏感信息或未经验证的推测。
```

如果服务端返回 `KNOWLEDGE_SPEC_OUTDATED`，说明提交期间规则已经升级；重新调用 `get_knowledge_submission_spec`，按最新规则重新整理后再提交。
## 9. 如何反馈已有内容有问题

如果发现 Knowledge 或 Skill 已经过期、错误或质量较差，可以使用 `submit_feedback`，写清楚可验证的原因。

如果已有资产完全不适用，也可以按类型提交新的 Knowledge Candidate 或 Skill Bundle。

## 10. 如何找管理员审批

提交 Candidate 后，把 **Candidate ID** 发给管理员即可。

管理员会在 Review Inbox 中查找并审核。Knowledge 和 Skill 共用同一套主要状态：

```text
pending（待审核）
  -> approved（已批准）
  -> publishing（PR/MR 已创建，等待合并）
  -> published（PR/MR 已合并）
```

被拒绝后可以重新批准；发布失败后可以重试发布。

需要特别注意：

- `approved` 不等于已经正式发布；
- PR/MR 创建成功也不等于正式发布；
- 只有 PR/MR 合并后，Candidate 才进入 `published`。

如果管理员拒绝 Candidate，会给出审核原因；开发者可以修改内容后重新提交，或者让管理员重新批准现有 Candidate。

## 11. 权限和职责边界

如果预期的 Repository、Skill 或 Knowledge 看不到：

1. 确认使用的是正确的 Developer API Key；
2. 用 `get_server_info` 查看当前账号能力；
3. 确认查询关键词正确；
4. 仍然找不到时联系管理员。

普通开发者不应该通过索要仓库写凭据、服务器权限或管理员凭据来绕过权限控制。

Repository 同步、回滚、发布配置、生命周期治理和 Evaluation 属于管理员或平台维护工作，不是普通开发者的日常操作。

## 12. 常见问题

### `codex mcp list` 中没有 teamSkillHub

检查 `~/.codex/config.toml` 是否存在 `teamSkillHub` 配置，然后重新启动 Codex。

### 鉴权失败

确认启动客户端的环境中存在：

```bash
TEAM_SKILL_HUB_API_KEY
```

不要打印真实 Key。

### MCP 已配置但无法连接

确认当前机器可以访问管理员提供的 MCP URL。如果服务只在公司内网开放，请先连接公司网络或 VPN。

### 搜不到 Knowledge / Skill

先换成更具体的任务描述和关键词。如果仍然找不到，把查询内容和预期资产名称发给管理员确认权限或内容状态。

### 自动 Knowledge Candidate 没有生成

自动候选不是每个会话都会产生。只有满足可复用性和验证条件的任务才会生成。

如果你认为本次内容应该沉淀，直接使用 `submit_knowledge_candidate` 手工提交即可。

### Client Integration 需要升级

如果管理员通知客户端接入组件版本过旧，或者 SessionStart 提示有新版本，应使用 stable launcher 升级，不需要重新下载新的 setup 文件：

Linux / macOS / WSL：

```bash
~/.team-skill-hub/bin/team-skill-hub-client upgrade
```

PowerShell：

```powershell
& "$HOME\.team-skill-hub\bin\team-skill-hub-client.ps1" upgrade
```

如果是 required update，升级后重新启动 Codex 或 Claude Code。只有 stable launcher 丢失或损坏时，才使用原 setup 的 `--upgrade` / `-Upgrade` 作为灾难恢复手段。
## 13. 安全使用原则

- Developer API Key 只放在环境变量或公司认可的 Secret Store 中；
- 不要把 API Key、Token、密码或客户敏感信息提交给 Team Skill Hub；
- 不要把未经验证的推测提交为 Knowledge；
- MCP 提供的团队指导不能绕过代码 Review、安全策略或发布流程；
- 执行 AI 生成的代码和命令前仍然需要 Review 和验证。

普通开发者日常只需要记住一条主线：**接入 MCP → 使用团队资产 → 完成并验证任务 → 必要时提交 Knowledge Candidate 或 Skill Bundle → 把对应 ID 给管理员审批。**

### 运行观测：Knowledge / Skill Reuse

管理员在 `/admin/observability/reuse` 查看 MCP 复用记录。新版 MCP 调用记录中 `reuse` 字段只保存最多五个资产的仓库、路径、标题、分数等摘要，**不保存检索返回的正文**；可按 HIT、MISS、LOAD、资产、用户、会话及时间筛选。统计接口 `/admin/api/reuse/summary` 提供完整范围内的事件计数及最常见资产（受用户、工具、时间筛选影响）。

- **HIT**：搜索返回匹配项；Knowledge 在配置了 `knowledgeMatchMinScore` 时还须达到阈值。
- **MISS**：搜索为空，或者 Knowledge 搜索最高分未达到阈值。
- **LOAD**：`get_knowledge`、`get_skill` 或 `get_skill_resource` 成功读取指定资产。
- **未识别**：升级前的历史调用或未带结果元数据的调用；不会推断其是否命中。

搜索命中、资产加载和 Agent 确认使用是不同事件。HIT/LOAD 不能证明任务结果使用了对应资产；真正的使用效果应关联用户反馈或明确的执行证据。列表和详情仍可通过 `traceId` / `sessionId` 关联 MCP 调用和会话。统计不对旧记录进行历史补算。

注意：统计卡中的 HIT 为**命中调用次数**，常见资产的“检索出现”则是该资产出现在返回列表中的次数；一次检索可能出现多个资产，这两个指标不能直接相加比较。
