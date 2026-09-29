# 开发者指南：使用 Team Skill Hub MCP

## 1. 适用对象

本文面向通过 Codex 或其他支持 MCP 的开发客户端使用 Team Skill Hub 的普通研发人员。你不需要自己部署或管理 Hub。

正常情况下只需要：

- 团队管理员提供的 MCP 地址；
- 一个 Developer API Key；
- Codex 或其他支持 MCP 的客户端；
- 能够访问 Hub 的网络环境。

Hub 为开发者提供团队统一管理的 Skill、可复用 Prompt、Agent 配置以及确定性的 Evaluation Suite。

## 2. 需要向管理员获取什么

向管理员获取：

~~~text
MCP 地址：
https://<skill-hub-host>/mcp

Developer API Key：
<your-developer-key>
~~~

普通开发者不需要 GitLab Deploy Key、ADMIN_API_KEY、GITLAB_WEBHOOK_TOKEN、服务器 SSH 权限或仓库写入凭据。

### 管理员：如何给多个用户创建 Key

生产环境使用 `AUTH_MODE=api-key`，并单独配置 `ADMIN_API_KEY`。服务启动后，管理员访问：

~~~text
http://<skill-hub-host>:8080/admin
~~~

在 **用户 API Keys** 区域创建用户 Key，并设置 User ID、Tenant 和 Roles。生成的
`skh_...` 明文只显示一次，Hub 只保存哈希和元数据。创建、禁用和删除立即生效，不需要重启。

`SKILL_HUB_API_KEYS_JSON` 仍可作为 bootstrap/兼容配置，但普通用户 Key 的日常生命周期管理应使用后台界面，不再通过修改 `.env` 完成。

## 3. 推荐：使用接入脚本配置 Codex

Linux / macOS / WSL：

~~~bash
bash scripts/setup-codex-mcp.sh \
  --url https://<skill-hub-host>/mcp
~~~

Windows PowerShell：

~~~powershell
.\scripts\setup-codex-mcp.ps1 `
  -Url https://<skill-hub-host>/mcp
~~~

脚本会自动完成两件事：

1. 更新 `~/.codex/config.toml` 中的 `teamSkillHub` MCP Server 地址；
2. 创建或更新 **全局 `~/.codex/AGENTS.md`**，告诉 Codex 在所有工程中适合的任务里主动使用 Team Skill Hub。

全局 `~/.codex/AGENTS.md` 中的 Team Skill Hub 内容使用 BEGIN/END 标记管理，因此重复执行脚本不会重复追加，也不会覆盖用户已经存在的其他全局指令。

脚本不会把 API Key 明文写进 `config.toml` 或项目仓库。Codex 配置只引用环境变量 `TEAM_SKILL_HUB_API_KEY`。

注意：这里配置的是 **Codex 全局 `~/.codex/AGENTS.md`**，不是项目根目录的 `AGENTS.md`，也不是 `agent.md`。项目自己的 `AGENTS.md` 仍然可以保留项目特定规则，并会叠加在全局规则之上。

配置完成后设置 API Key。

Linux/macOS/WSL：

~~~bash
export TEAM_SKILL_HUB_API_KEY='<developer-api-key>'
~~~

PowerShell：

~~~powershell
$env:TEAM_SKILL_HUB_API_KEY="<developer-api-key>"
~~~

然后重新启动 Codex，并验证：

~~~bash
codex mcp list
~~~

## 4. 手工配置 Codex

Codex CLI 与 Codex IDE 扩展共用配置。

将 API Key 保存在环境变量中。

Linux/macOS：

~~~bash
export TEAM_SKILL_HUB_API_KEY='<developer-api-key>'
~~~

PowerShell：

~~~powershell
$env:TEAM_SKILL_HUB_API_KEY="<developer-api-key>"
~~~

在 ~/.codex/config.toml 中增加：

~~~toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
~~~

仅针对无鉴权的本地开发 Hub，也可以使用：

~~~bash
codex mcp add teamSkillHub --url http://127.0.0.1:18080/mcp
~~~

共享生产 Hub 不要使用无鉴权的 development 方式。

## 5. 验证连接

查看 MCP Server：

~~~bash
codex mcp list
~~~

然后让 Codex 执行：

~~~text
使用 teamSkillHub 的 get_server_info，告诉我当前账号可以使用哪些能力。
~~~

再验证 Repository 可见范围：

~~~text
使用 teamSkillHub 列出我可以访问的 Repository。
~~~

普通内部开发者通常应该可以看到 rd-skills。不属于当前角色权限的 Repository 会被主动隐藏。

## 6. 全局 AGENTS.md 指令

如果使用第 3 节脚本，不需要每个项目重复维护 Team Skill Hub 指令。脚本会把下面的规则写入 `~/.codex/AGENTS.md`：

~~~text
当任务可能受益于团队特定的工程知识时，
在开始实质性工作前优先使用 teamSkillHub MCP。

首先搜索或解析适合当前任务的 Skill 或 Agent。
仅在需要时加载选中的 Skill/Prompt。
按需逐步加载引用资源，不要一次性加载所有内容。

当团队领域资产和通用指导同时存在时，优先使用团队领域资产。
除非用户明确要求执行运维操作且当前账号具备权限，
否则不要调用 Repository 同步、回滚或其他管理操作。
~~~

Codex 会先加载 `~/.codex/AGENTS.md` 的全局指令，再叠加当前项目目录中的 `AGENTS.md`。因此 Team Skill Hub 这种跨项目的通用规则放在全局文件中更合适。

## 7. 开发者可以使用的主要资产

### Skill

Skill 描述团队可复用的工程知识和操作流程。

常用工具：

~~~text
list_skills
search_skills
resolve_skill
get_skill
get_skill_resource
~~~

推荐流程：

~~~text
任务
  -> resolve_skill
  -> get_skill
  -> 只有需要时才 get_skill_resource
  -> 执行工程任务
~~~

### Prompt

Prompt 是团队统一沉淀的可复用任务指令。

~~~text
list_prompts
search_prompts
get_prompt
~~~

### Agent

Agent 是声明式团队角色，将 Skill、Prompt 和允许使用的 Tool 名称组合在一起。

~~~text
list_agents
search_agents
resolve_agent
get_agent
~~~

Hub 不负责选择或代理语言模型，模型仍由开发客户端自己使用。

### Knowledge / RAG

Knowledge 用于保存“当前事实”，而不是可复用流程。当前可以从 Repository 中索引 Markdown、TXT、文字型 PDF 和 DOCX。

~~~text
list_knowledge_sources
search_knowledge
get_knowledge
~~~

设计文档、API 说明、故障复盘、FAQ、测试说明等内容优先使用
`search_knowledge`。命中后需要精确原文时，再调用 `get_knowledge` 读取指定
Chunk 或完整文档。当前不做 OCR，因此纯扫描图片 PDF 不会产生可检索正文。

## 8. 日常典型工作流

### OTA 代码 Review

~~~text
使用 teamSkillHub 查找最适合当前 OTA 实现 Review 的 Skill。
重点检查不必要的接口、过长调用链、重复抽象，
并且每个修改建议都要给出删除/修改风险。
加载选中的 Skill，并按照 Skill 要求 Review 当前仓库。
~~~

预期流程：

~~~text
resolve_skill
  -> ota-code-review
  -> get_skill
  -> 可选 get_skill_resource
  -> Review 当前仓库
~~~

### 项目文档 / RAG

~~~text
在 teamSkillHub Knowledge 中搜索当前 OTA 断电恢复设计。
使用最相关的 Chunk 作为依据，并在回答前用 get_knowledge
加载最终选中的文档/Chunk。
~~~

预期流程：

~~~text
search_knowledge
  -> Repository 中的相关 Chunk
  -> get_knowledge
  -> 基于原文分析
~~~

### 可复用 Prompt

~~~text
使用 teamSkillHub 查找 OTA API/代码 Review 对应的可复用 Prompt，
加载后应用到当前仓库。
~~~

### 团队 Agent

~~~text
使用 teamSkillHub 为 OTA 代码 Review 和调试解析最合适的 Agent。
加载 Agent 定义，然后按需加载它引用的 Skill 和 Prompt。
~~~

### Yocto/CVE 类任务

~~~text
在 teamSkillHub 中搜索与 Yocto CVE 管理有关的 Skill、Prompt 或 Agent。
如果存在合适的团队资产，加载后用于制定实现计划。
如果没有任何匹配，请先明确告诉我没有团队资产命中，再继续分析。
~~~

未命中的 Query 可以帮助团队决定后续应该新增哪些资产。

## 9. Search 与 Resolve 如何选择

希望浏览多个候选时使用 search：

~~~text
在 teamSkillHub 中搜索 OTA Review 相关 Skill，并展示最相关的几个结果。
~~~

有明确任务、希望直接选择最佳资产时使用 resolve：

~~~text
为“精简 OTA 实现”解析最合适的 Skill。
~~~

大多数日常工作优先从 resolve_skill 或 resolve_agent 开始。

## 10. 按需逐步加载

不要在任务开始时一次性加载所有 Skill 和 Resource。

推荐模式：

~~~text
1. 先 search/resolve 元数据
2. 加载选中的 Skill/Prompt/Agent
3. 任务执行到需要时再加载 references/resources
~~~

Skill 示例：

~~~text
resolve_skill
      |
      v
get_skill
      |
      +--> 上下文已足够 -> 开始工作
      |
      \`--> 还需要细节 -> get_skill_resource
~~~

## 11. Client Compatibility

Skill、Prompt、Agent 可以声明客户端兼容性。

使用 Codex 时使用：

~~~text
client = codex
~~~

自然语言示例：

~~~text
在 teamSkillHub 中搜索兼容 Codex 的 OTA Review Skill。
~~~

明确标记为不兼容 codex 的资产会被过滤。

## 12. Evaluation Suite

Evaluation Suite 是和团队资产一起保存的确定性 Golden Regression Test。

列出 Suite：

~~~text
使用 teamSkillHub 列出 rd-skills 中的 Evaluation Suite。
~~~

运行 Active Revision：

~~~text
使用 teamSkillHub 运行 rd-skills 的 ota-core-regression Evaluation，
如果有失败，只总结失败 Case。
~~~

相关工具：

~~~text
list_evaluation_suites
run_evaluation
list_evaluation_runs
get_evaluation_run
~~~

Evaluation 不调用语言模型，它验证确定性的路由结果、必须保留的内容和 Agent 绑定关系。

普通编码任务不需要每次运行 Evaluation。团队资产发生修改时，GitLab CI 会运行 Regression Suite。

## 13. 权限行为

Hub 会先在服务端执行权限过滤，再返回 Repository 或资产。

如果看不到预期的 Repository 或资产：

1. 确认使用的是正确的 Developer API Key；
2. 调用 get_server_info 查看解析出的 Role；
3. 调用 list_skill_repositories 查看当前可见 Repository；
4. 如果仍然缺失，联系 Hub 管理员。

不要通过索要 GitLab 凭据或服务器直接访问的方式绕过权限过滤。

## 14. 普通开发者通常不应该执行的操作

运维工具包括：

~~~text
sync_skill_repository
rollback_repository_revision
list_sync_audit
~~~

正常开发应该走：

~~~text
GitLab MR
  -> Review
  -> Merge
  -> Webhook/Polling
  -> Hub Validation
  -> Activate
~~~

Rollback 是故障恢复操作，不是普通开发工作流。

## 15. 常见问题

### codex mcp list 中没有 teamSkillHub

检查 ~/.codex/config.toml：

~~~toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
~~~

修改 MCP 配置后新建 Codex Session。

### 鉴权失败

检查启动 Codex 的同一个进程环境中是否存在环境变量。

Linux/macOS：

~~~bash
test -n "$TEAM_SKILL_HUB_API_KEY" && echo configured || echo missing
~~~

PowerShell：

~~~powershell
if ($env:TEAM_SKILL_HUB_API_KEY) { "configured" } else { "missing" }
~~~

不要把真实 API Key 打印或粘贴到聊天、日志、工单或源码中。

### MCP 已配置但不可达

确认机器可以访问：

~~~text
https://<skill-hub-host>/mcp
~~~

如果 Hub 只能从公司内网访问，请先连接公司网络/VPN。

### Search 没有结果

优先使用任务描述，而不是只有一个很短的产品名。

信息不足：

~~~text
OTA
~~~

更好：

~~~text
Review OTA implementation for unnecessary interfaces and long call chains.
~~~

如果确实没有命中，可以继续正常工程分析，但应明确说明没有团队资产命中。

### Skill Resource 无法加载

只加载被选中 Skill 明确引用的 Resource。Skill 根目录以外或超出当前权限范围的资源会被服务端阻止。

### Evaluation 失败

让 Codex 返回失败 Case：

~~~text
运行 ota-core-regression，并只解释失败的 Golden Case，
包括 expected 与 actual 的差异。
~~~

不要为了通过 Evaluation 而直接删除 Golden Case。应修复对应资产；如果期望行为确实有意改变，则通过正常 GitLab Review 流程更新期望值。

## 16. 安全使用建议

- Developer API Key 放在环境变量或公司认可的 Secret Store 中。
- 不要把 API Key 提交到配置文件、项目文件、脚本或 Git。
- 领域流程优先使用团队维护的 Skill、Prompt 和 Agent。
- MCP 指导不能绕过代码 Review、安全策略或发布流程。
- 执行生成的代码和命令前仍然需要 Review。
- 按需逐步加载 Resource，减少无关上下文。
- 不要把 Sync/Rollback 当成绕过 GitLab Review 的捷径。
- 如果团队资产过时，应通过 GitLab 更新源资产。

## 17. 快速参考

连接：

~~~toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
~~~

验证：

~~~bash
codex mcp list
~~~

日常最常用工具：

~~~text
get_server_info
list_skill_repositories
search_skills
resolve_skill
get_skill
get_skill_resource
search_prompts
get_prompt
search_agents
resolve_agent
get_agent
list_evaluation_suites
run_evaluation
~~~

进入项目后的推荐首条指令：

~~~text
在开始实质性工作之前，使用 teamSkillHub 检查当前任务是否存在相关的
团队 Skill 或 Agent。如果存在，加载并按照它执行。
~~~
