# 执行配置中的模型与凭据映射

Expert Platform 当前的模型配置属于 **Deployment（执行配置）**，而不是 Expert Definition。

职责边界：

- **Expert Definition**：定义专家身份、能力、关键词和启停状态。
- **Deployment**：定义仓库、调用授权、Runtime Profile、Executor Backend、模型配置和 Skill Hub MCP 策略。
- **Worker Runtime**：声明自己支持的 Backend / Runtime Profile，解析本机受保护凭据，并启动任务容器。
- **Task**：提交时固化所选 Deployment ID、配置版本和不可变快照；排队期间 Admin 后续修改不会改变该任务的执行语义。

## Deployment 模型配置

Admin → 专家平台 → 执行配置中维护：

- `executor.backend`：`codex` 或 `claude`
- `executor.modelConfig.providerId`
- `executor.modelConfig.model`
- `executor.modelConfig.baseUrl`
- `executor.modelConfig.wireApi`
- `executor.modelConfig.credentialRef`
- `executor.modelConfig.allowedEnvNames`

协议必须匹配执行器：

- Codex：`wireApi=responses`
- Claude Code：`wireApi=anthropic-messages`

协议不匹配时保存或调度直接失败，不会静默替换模型。

一个 Expert 可以有多个 Deployment，因此同一个专家可以按仓库、调用者或环境绑定不同 Backend/Model。**最终任务使用哪个模型，由本次选中的 Deployment 决定。**

## Worker 凭据引用映射

Hub 只保存逻辑引用，不保存模型密钥明文。例如 Deployment：

```yaml
executor:
  backend: codex
  modelConfig:
    providerId: bst
    model: gpt-5.6-luna
    baseUrl: https://router.example/v1
    wireApi: responses
    credentialRef: bst-router
    allowedEnvNames:
      - TEAM_SKILL_HUB_API_KEY
```

Worker 主机通过：

```dotenv
EXPERT_MODEL_ENV_NAMES=TEAM_SKILL_HUB_API_KEY,HTTP_PROXY,HTTPS_PROXY,NO_PROXY
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"TEAM_SKILL_HUB_API_KEY"}'
TEAM_SKILL_HUB_API_KEY=由安全渠道注入的真实密钥
```

`EXPERT_MODEL_CREDENTIAL_REFS_JSON` 只允许保存“引用 → 环境变量名”，不得放 Token/API Key 明文。映射目标必须同时出现在 `EXPERT_MODEL_ENV_NAMES` 白名单中。

## Claude Code

Claude Deployment 使用 `backend=claude` 和 `wireApi=anthropic-messages`。Worker 可将 Deployment 的 `credentialRef` 映射到 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN`。

模型名和 Base URL 均来自 **Deployment 快照**，不是 `EXPERT_CLAUDE_MODEL`。正式 V2 Worker 不应依赖 `EXPERT_CLAUDE_MODEL` 来决定任务模型。

Claude 任务容器只开放基础只读工具和 Deployment 允许的 Skill Hub MCP 只读工具，并同时通过 `--tools` 与 `--allowedTools` 收敛权限。

## Codex

Codex Deployment 使用 `backend=codex` 和 `wireApi=responses`。Worker 为每个任务生成独立临时 Codex 配置：

- Provider、Model、Base URL 来自 Deployment 快照。
- Provider credential 只通过本机环境变量映射注入。
- Skill Hub MCP 使用独立只读 credential。
- Deployment 允许的 MCP tools 写入 `enabled_tools`，同时设置 `approval_mode="approve"`；未列入的工具不可调用。

在部分 WSL2 环境中，Codex 的内部只读 sandbox 需要 `EXPERT_DOCKER_SECCOMP_PROFILE=unconfined` 才能创建所需 namespace。该设置是主机兼容性选项，不应作为所有 Linux 主机的默认值。

## Skill Hub MCP 与模型凭据分离

下面三类身份必须分开：

1. Worker → Hub gRPC：Worker credential（`ewc_...`）
2. Task Container → 模型 Provider：Deployment `credentialRef` 对应的模型密钥
3. Task Container → Skill Hub MCP：只读 MCP credential，例如 `skillhub-readonly`

它们不能互相代替，也不能复用 Admin API Key。

MCP 策略同样属于 Deployment：`mcp.profileRef`、`mcp.urlOverride`、`mcp.credentialRef`、`mcp.allowedTools`、`mcp.required`。Worker 只负责把该策略转换成任务级 Claude/Codex 配置。

## 临时配置文件与权限

Worker 以安全 `umask=0077` 运行。模型/MCP 临时配置不包含密钥明文，但任务容器 UID 需要读取，因此 Runtime 在创建后显式设置为 `0644`，再只读挂载进容器。凭据值只通过环境变量注入。

任务结束后临时配置删除；不要把宿主 `~/.claude`、`~/.codex` 或个人 MCP 配置直接挂入任务容器。

## 当前真实验收状态（2026-10-29）

已经完成两条真实链路：

- Claude Deployment：Claude CLI → Hub MCP → Deployment → Claude Worker → Claude Docker → 模型 → Skill Hub MCP → succeeded。
- Codex Deployment：Codex CLI → Hub MCP → Deployment → Codex Worker → Codex Docker → 模型 → Skill Hub MCP → succeeded。

两种任务都验证了 Deployment 级 Backend/Model 下发、Git 仓库准备、容器只读执行、Skill/Knowledge MCP 只读工具调用，以及结果/Commit SHA/阶段事件回传。

因此，旧文档中“模型归属于 Expert Definition”“Worker 用 `EXPERT_CLAUDE_MODEL` 决定模型”“Claim 时从 Expert 读取模型”的描述均属于 V1/迁移前行为，不再代表当前 V2 主路径。
