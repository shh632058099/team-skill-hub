# Team Skill Hub 用户指南

## 1. 适用对象

本文面向 Team Skill Hub 的开发者、AI 客户端用户和平台管理员。Hub 不代理模型；Codex、Claude Code、ChatGPT 等客户端继续使用自己的模型，Hub 提供团队共享的 Skill、Prompt、Agent 和 Knowledge/RAG 上下文。

## 2. 管理后台

服务启动后访问：

```text
http://<hub-host>:8080/admin
```

输入部署时配置的 `ADMIN_API_KEY`。该 Key 是平台管理员凭据，不应作为普通 MCP 用户 Key 分发。

后台当前支持：

- 用户 API Key 管理；
- Repository 运行配置；
- Knowledge Source / RAG 配置；
- Knowledge 索引状态和搜索测试；
- MCP Observability / Trace；
- Knowledge Review Inbox 审核；
- Knowledge Gaps 查看；
- Revision/Webhook 等通用运行参数。

动态配置保存在：

```text
<data_dir>/config/admin-config.json
```

用户 API Key 记录保存在：

```text
<data_dir>/config/api-keys.json
```

API Key 文件只保存 SHA-256 哈希、末四位和 Principal 信息，不保存可直接使用的明文 Key。

## 3. 创建用户 API Key

在 **用户 API Keys** 区域填写：

- 名称：例如 `biao-codex`；
- User ID：例如 `biao`；
- Tenant：例如 `rd`；
- Roles：例如 `developer, internal`。

点击 **创建 API Key** 后会生成 `skh_...` Key。明文只显示一次，请立即复制并安全保存。

Key 可以随时禁用或删除，修改立即生效，不需要重启 Hub。

普通 MCP 用户不需要修改 `.env`。生产环境推荐只把 `ADMIN_API_KEY` 和 Git/Webhook 等 bootstrap secret 放在部署环境中。

## 4. 使用脚本接入 Codex

Linux / macOS / WSL：

```bash
bash scripts/setup-codex-mcp.sh \
  --url https://<hub-host>/mcp
```

Windows PowerShell：

```powershell
.\scripts\setup-codex-mcp.ps1 `
  -Url https://<hub-host>/mcp
```

脚本会配置 MCP Server 地址，并自动创建/更新全局 `~/.codex/AGENTS.md`。其中的 Team Skill Hub 指令会要求 Codex 在所有工程的非简单任务中主动搜索团队 Skill 和 Knowledge，而不是要求用户每次显式指定 MCP 名称。

API Key 不写入项目文件；使用 `TEAM_SKILL_HUB_API_KEY` 环境变量提供给 Codex。

## 5. 连接 MCP

MCP Endpoint：

```text
https://<hub-host>/mcp
```

客户端可以发送：

```text
Authorization: Bearer <api-key>
```

或者：

```text
x-skill-hub-api-key: <api-key>
```

Repository 的 `readRoles` / visibility 会在搜索结果暴露前执行权限过滤。

## 6. Skill 使用

常用工具：

- `search_skills`：不知道准确 Skill 名称时检索；
- `get_skill`：读取完整 Skill；
- `get_skill_resource`：读取 Skill 附带资源；
- `resolve_skill`：解析 Skill 及依赖。

推荐工作流：

```text
工程任务
  -> search_skills
  -> 选择候选
  -> get_skill
  -> 按 Skill 流程执行
```

Skill 更适合表达“应该怎么做”的流程、规范和专家方法。

## 7. Knowledge / RAG 使用

Knowledge 更适合表达“当前事实是什么”，例如：

- 设计文档；
- API 说明；
- 故障复盘；
- FAQ；
- 测试报告；
- OTA / Yocto 项目文档。

当前支持：

- Markdown：`.md`
- Text：`.txt`
- 文字型 PDF：`.pdf`
- DOCX：`.docx`

当前不做 OCR，因此纯扫描图片 PDF 不会产生可检索正文。

常用 MCP 工具：

- `list_knowledge_sources`
- `search_knowledge`
- `get_knowledge`
- `submit_feedback`
- `submit_knowledge_candidate`

推荐工作流：

```text
问题
  -> search_knowledge
  -> 获取相关 chunk
  -> get_knowledge
  -> 使用原文上下文回答/分析
```

## 8. Knowledge Source 配置

管理员可在 **Knowledge / RAG** 区域按 Repository 配置：

- Enabled；
- Include；
- Exclude；
- Max document bytes；
- Chunk size；
- Chunk overlap。

默认值：

```yaml
knowledge:
  enabled: true
  include:
    - "**/*.md"
    - "**/*.txt"
    - "**/*.pdf"
    - "**/*.docx"
  exclude: []
  max_document_bytes: 2097152
  chunk_size_chars: 1400
  chunk_overlap_chars: 180
```

建议内部研发仓库优先显式限制目录，例如：

```yaml
include:
  - docs/**
  - design/**
  - README.md

exclude:
  - archive/**
  - generated/**
  - docs/private/**
```

保存后 Hub 会立即重新同步该 Repository 并重建 Knowledge 索引。

## 9. 后台测试 RAG

在 **Knowledge / RAG** 页面可以直接输入搜索问题，并可指定 Repository。

结果显示：

- Repository；
- Revision；
- 文档路径；
- 标题；
- Chunk Index；
- Score；
- 命中的正文。

该功能适合调试 Include/Exclude 和观察 FTS5 的召回效果。

## 10. MCP Observability 与 Trace

Hub 会为 MCP Tool 调用记录轻量 Trace，包括：

- Tool 名称；
- 用户 / Tenant；
- Trace ID / Session ID（客户端提供时）；
- 调用耗时；
- 成功/失败；
- 脱敏后的参数摘要。

默认不会保存 API Key 明文，也不会把 Tool 的完整返回正文复制到调用日志中。

管理员可以在 Web 后台的 **Observability** 页面查看调用数量、失败数、平均延迟和最近调用。

## 11. 知识回流与 Web 审核

知识回流遵循：

```text
MCP 使用 / 故障排查
  -> submit_feedback / submit_knowledge_candidate
  -> Knowledge Review Inbox
  -> 管理员编辑标题 / 正文 / Repository / 目标路径
  -> Approve
  -> Publish to GitLab MR
  -> GitLab 正常 Review / Merge
  -> Webhook 或 Polling 触发 Repository Sync
  -> 校验通过后重新建立 Knowledge 索引
```

Review Inbox 支持以下状态：

```text
pending
approved
rejected
publishing
published
publish_failed
```

其中 **Approved 不等于已经进入正式知识库**。只有管理员明确点击发布后，Hub 才会使用独立的 GitLab 写凭据创建分支、提交 Markdown 并创建 Merge Request。Hub **不会自动合并 MR**；仍然使用团队正常的 GitLab Code Review / Merge 流程。

发布失败会保存脱敏后的错误原因，并允许管理员修改候选内容后重试。重试是幂等的：如果候选分支和文件已经创建，Hub 会复用已有分支/打开的 MR，而不是反复制造重复提交。

当前自动发布只支持 **Knowledge -> Markdown**。如果候选类型是 Skill，则继续由 Review Inbox 做人工审核，后续再通过标准 Skill 仓库流程落库。

**Feedback** 页面用于查看显式正/负反馈；**Knowledge Gaps** 页面会聚合未命中查询和负反馈，帮助管理员发现高频知识缺口。

## 12. Skill 与 Knowledge 的边界

建议保持：

```text
Skill     = Procedure / 怎么做
Knowledge = Context / 当前事实
```

例如：

- Skill：如何 Review OTA 升级实现；
- Knowledge：当前 OTA 状态机、接口文档、回滚设计。

不要把全部项目文档都复制进 Skill，也不要只依赖 RAG 来表达必须遵循的工程流程。

## 13. Repository 更新与一致性

Repository 同步成功后，Skill/Prompt/Agent/Knowledge 会一起切换到新的 validated revision。

如果新 revision 校验失败：

- 当前 Last Known Good 继续生效；
- 不激活失败 revision；
- Knowledge 也不会提前切到未验证版本。

Rollback 时 Knowledge 会跟随 Repository revision 一起回滚。

## 14. 常见问题

### 搜不到文档

检查：

1. Repository 是否启用；
2. Knowledge 是否 Enabled；
3. Include 是否覆盖文档路径；
4. Exclude 是否误排除；
5. 文件是否超过 Max document bytes；
6. PDF 是否为扫描件；
7. 当前 API Key 是否有该 Repository 的读取权限。

### 修改 Knowledge 配置后需要重启吗？

不需要。保存会立即重新同步并重建该 Repository 索引。

### 用户 API Key 修改后需要重启吗？

不需要。创建、禁用和删除立即生效。

### 是否已经使用向量数据库？

没有。当前 RAG V1 使用 SQLite FTS5 + 轻量打分。后续根据真实召回效果再决定是否加入 embedding / hybrid search。
