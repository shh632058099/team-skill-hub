# Worker 选择 Codex / Claude 执行器

> 当前实现由 **Deployment 指定 Executor Backend 和模型**，Worker Runtime 只声明自己支持的 Backend / Runtime Profile，并领取与自身能力匹配的任务。Claude CLI（派发者）与 Claude Worker（执行者）是两个不同角色。

## 1. 选择与部署方式

| 后端           | Worker 主机配置                  | 需要导入的任务镜像                   | 模型认证                                                       |
| -------------- | -------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Codex（手动）  | `EXPERT_EXECUTOR_BACKEND=codex`  | `team-skill-hub-expert-worker:0.1.0` | 原有 Codex 或 Worker model credential ref                      |
| Claude（可选） | `EXPERT_EXECUTOR_BACKEND=claude` | `team-skill-hub-expert-claude:0.1.0` | Worker 环境的 `ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_OAUTH_TOKEN` |

发布管理员应在有 Hub 仓库源码的**构建机**运行：

```bash
npm run build:worker-runtime
bash scripts/build-worker-image.sh claude 0.1.0
sha256sum artifacts/worker-runtime/worker-runtime-0.1.0.tar.gz \
  artifacts/worker-runtime/expert-claude-image-0.1.0.tar
```

这两个包应由发布方通过可信的制品库交付；部署者只需要安装 Runtime 包，并执行：

```bash
sudo docker load -i expert-claude-image-0.1.0.tar
sudo docker image inspect team-skill-hub-expert-claude:0.1.0
```

编辑 Worker 主机 `/etc/team-skill-hub-worker/worker.env`，在原有连接 Hub、Worker ID、Git 凭据等设置基础上使用以下 Claude 配置：

```dotenv
EXPERT_EXECUTOR_BACKEND=claude
EXPERT_DOCKER_IMAGE=team-skill-hub-expert-claude:0.1.0
EXPERT_RUNTIME_PROFILES=claude-readonly
EXPERT_MODEL_ENV_NAMES=ANTHROPIC_AUTH_TOKEN,HTTPS_PROXY,NO_PROXY
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"ANTHROPIC_AUTH_TOKEN"}'
ANTHROPIC_AUTH_TOKEN=从安全密钥系统注入的实际值
```

如部署 Codex Worker，应配置 `EXPERT_EXECUTOR_BACKEND=codex`、`EXPERT_RUNTIME_PROFILES=codex-readonly`、导入 `team-skill-hub-expert-worker:0.1.0`，并提供 Deployment 中 `credentialRef` 对应的 Worker 本地凭据映射。Worker Backend 与 Deployment Backend 必须匹配；Hub 不会让 Claude-only Worker 领取 Codex Deployment。

改用 OAuth token 时，将上面的 `ANTHROPIC_API_KEY` 替换为 `CLAUDE_CODE_OAUTH_TOKEN` 并在 `EXPERT_MODEL_ENV_NAMES` 中同步替换。**绝对不要**把密钥写进镜像、Git、发布 tar 包或文档。模型必须是安装的 Claude CLI 认可且当前账户有权限访问的模型 ID；使用代理网关时，所需 `ANTHROPIC_BASE_URL` 等变量也必须在 Worker 环境及 `EXPERT_MODEL_ENV_NAMES` 白名单内显式配置。

```bash
sudo systemctl restart team-skill-hub-worker
sudo journalctl -u team-skill-hub-worker -n 100 --no-pager
```

## 2. 隔离与兼容性

Claude Executor 基础只开放 `Read,Glob,Grep`，并把 Deployment 允许的 Skill Hub MCP 只读工具同时加入 `--tools` 与 `--allowedTools`；使用 `--permission-mode dontAsk`、非 root 执行、只读仓库 bind mount、read-only Docker 文件系统、资源限制和禁用写入工具。结果通过 `claude -p --output-format json` 的成功记录解析；失败时不将模型原始输出记入 Hub 阶段日志。仍应只在可信仓库使用 Worker，并根据组织的 Claude Code 商业许可和认证政策执行。

现在模型配置属于 **Admin → 执行配置（Deployment）**：Codex 使用 `responses`，Claude 使用 `anthropic-messages`。模型名、Base URL、Provider、凭据引用均从 Deployment 的不可变任务快照下发；Worker 只负责按本机受保护映射取得密钥，**不会从 Hub 接收明文密钥**。详细见 [执行配置中的模型与凭据映射](./model-configuration.md)。

Worker 仍需配置本机 `EXPERT_EXECUTOR_BACKEND` 和 `EXPERT_RUNTIME_PROFILES` 来声明自己能执行什么，但这只是 Worker 能力声明，不是任务模型的来源。Hub Claim 时同时校验 Deployment Backend / Runtime Profile 与 Worker 能力。

## 3. Claude CLI 自动派发

Hub 新增 `submit_expert_task_auto`，仅需 `problem` 和新任务的 `idempotencyKey`，**不接受** `expertId`、占位值或 `selectionMode`。例如，在已连接 `teamSkillHub` MCP 的 Claude CLI 会话中：

> 请通过 Team Skill Hub 的 `submit_expert_task_auto` 只读分析 OTA 断电恢复相关源码。请使用新的 idempotencyKey；返回实际 taskId。任务执行完成后，通过 `get_expert_task_status` 和 `get_expert_task_result` 查询结果。

普通 `submit_expert_task` 保留用于显式指定专家和需要指定具体 Repository ID 的场景。若自动路由遇到 `AMBIGUOUS_EXPERT`、`REPOSITORY_REQUIRED`，应让用户明确目标而非猜测。

## 4. 验收口径

必须分别验证：Claude CLI 实际调用了 `submit_expert_task_auto`、返回真实 Task ID；Hub 中选中的 Expert 正确、Worker 正确领取；Worker 使用导入的 Claude 镜像而非 Codex 镜像；分析成功且源码仓库没有变更；Admin → 专家平台 → 任务运行记录可查看 `repository`、`container`、`claude`（Claude 执行阶段）与 `execution` 的阶段事件。Codex Worker 和历史任务应保持可用。

## 在 Claude CLI 中自动查看远程 Expert Worker 进度

提交专家任务后，MCP 的 `submit_expert_task_auto` / `submit_expert_task` 会立即返回 `taskId`，不会直接等待远程 Worker 分析完成。

**推荐给 Claude CLI 的单次指令：**

> 通过 Team Skill Hub MCP 把以下问题下发给适合的 Expert，并持续等待执行进度：先调用 `submit_expert_task_auto` 获取真实 taskId；然后反复调用 `wait_expert_task`（每次 15 秒，传入上一轮 `nextEventId`），及时告诉我 Worker 正在同步仓库、启动模型或使用哪些只读工具，直到任务结束；只有 succeeded 才调用 `get_expert_task_result` 返回完整报告。如果客户端不支持实时进度通知，也要通过 `wait_expert_task` 的返回数据定时反馈，不要让我手动反复问状态。问题：……

`wait_expert_task` 最长允许等待 30 秒、默认 15 秒；无 `progressToken` 时有新事件即返回，带 token 的活动调用内可发送 MCP `notifications/progress`。实际 Claude CLI 是否原生展示通知取决于其版本，不能把服务器已发通知等同于客户端一定可见。断线后保留 `taskId`、`nextEventId` 即可续查；取消等待不会取消实际 Worker Task。

Worker 默认启用增量流式活动（Claude `stream-json --verbose` / Codex `--json`），遇到旧版模型 CLI 兼容问题可以在**独立 Worker 环境**中临时设定 `EXPERT_ACTIVITY_STREAM_ENABLED=0` 回退原有最终报告解析行为。Hub 无需打开此开关。Hub/Worker 均升级后才会传输工具活动；旧版 Worker 仍可报告生命周期阶段。工具活动仅包含类型和计数，不上传源码、模型思考或完整文件路径。

### 真实调用方验收样例（2026-10-28）

已用 Claude CLI 2.1.308 连接 `teamSkillHub`，单次提示提交 OTA 只读任务并要求循环调用 `wait_expert_task`。任务 `bcf7fdef-c53d-422a-b2ae-c7c2fb342550` 在真实 Codex Worker `ota-worker-01` 上执行成功；Claude CLI 的三轮游标推进为 `0 → 127 → 130 → 134`，Hub 确认 7 条工具活动记录与最终源码 Commit。该测试验证的是**Claude CLI 作为调用者**，并非 Claude Worker 模型后端；MCP 通知在 Claude CLI 终端中的独立渲染效果仍应单独评估。

### Claude CLI 重复任务复用（客户端 Session）

Claude Code 2.1.308 的 HTTP MCP 不会自动传递 `x-skill-hub-session-id` 或 `mcp-session-id`。**现在推荐安装 `scripts/claude/expert-session-hook.py` 的 Claude `PreToolUse` Hook**：Hook 使用 Claude Code 通过 stdin 提供的原生 `session_id`，自动写入 MCP 提交工具已有的 `clientSessionId`，无需生成额外 UUID 或在提示词中说明 Session ID。若已有 HTTP Session Header，Hub 优先使用 Header。未安装 Hook 的客户端仍可显式提供 `clientSessionId` 作为兼容方案。

推荐输入示例：

> 请通过 `teamSkillHub` 的 `submit_expert_task_auto` 分析 OTA 恢复逻辑，使用新的 `idempotencyKey`。如当前 Claude 会话里有相同且尚未完成的任务，请复用原 Task ID，不重复执行。

**边界**：只有相同 Principal、Tenant、Client、Session、Expert、Repository、Problem，且原 Task 为 `queued/running` 才自动复用；已完成任务可以重新执行。即使没有 `clientSessionId`，传入同一 `idempotencyKey` 的幂等重试仍然有效。使用原生 Session Hook 后无需模型主动传 `clientSessionId`；未安装 Hook 或客户端不支持该 Hook 时仍不能保证会话级自动复用。

### 2026-10-28 真实 Claude CLI 重复拦截验收

- 修复前：Claude CLI 2.1.308 的两次相同 problem、不同 idempotencyKey 提交，因 `source_session_id=NULL`，生成两个不同 Task（`fd6dbc4f-...`、`63170c62-...`），均独立执行；重试相同 idempotencyKey 可正常返回原 Task。
- 修复后：提交工具增加可选 `clientSessionId` UUID，调用时优先使用已有 HTTP Session Header，否则使用此工具参数。MCP 集成测试覆盖同会话复用、不同会话隔离与缺少 Session 不跨会话复用。
- 实际在 Claude CLI 单次调用中，`--session-id 57fa17ba-1e37-4f5d-b504-d7aa9c3c89df`，对两次 `submit_expert_task_auto` 明确传入相同 `clientSessionId`，使用不同 idempotencyKey、逐字相同 problem。两次返回完全相同 Task ID `6d30dd54-7dbd-4413-b13e-a75bdfed5d45`。
- Hub SQLite 单独核验该 UUID 仅创建 **1 Task / 1 Run**，`source_client=claude-code/2.1.308 (sdk-cli)`，`source_session_id` 与请求一致。Worker 按正常任务执行一次。
- 仍需注意：Claude CLI 未原生自动透传 HTTP Session ID；在未要求 Claude CLI 传入 `clientSessionId` 的对话中，不应宣称自动复用总是生效。新对话必须使用新的 UUID；同一对话后续调用必须保留 UUID；不要用固定的全局 Session ID。

### 原生 Claude Session ID 自动传递：PreToolUse Hook（2026-10-28）

Claude Code `PreToolUse` Hook 原生输入包含 `session_id`。项目脚本 `scripts/claude/expert-session-hook.py` 只匹配 `mcp__teamSkillHub__submit_expert_task` 和 `mcp__teamSkillHub__submit_expert_task_auto`，向 `updatedInput` 写入真实 `session_id`，保留任务和幂等键原样，**不会设置 `permissionDecision=allow`**。无需使用不稳定的 Claude 内部会话文件或全局固定 UUID。

在当前 WSL2 的 `/root/.claude/settings.json` 已安装匹配这两个工具的用户级 Hook；其他主机可参考以下配置（把脚本路径替换为该主机实际路径，并与已有 `hooks` 合并，而不是覆盖全部设置）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__teamSkillHub__(submit_expert_task|submit_expert_task_auto)",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/team-skill-hub/scripts/claude/expert-session-hook.py",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

真实 Claude CLI 2.1.308 测试：启动 `--session-id c0dd3eaf-0c5f-4880-b36e-fb16b958e6a9` 的对话，仅要求两次同问题、不同 `idempotencyKey` 的 `submit_expert_task_auto` 调用，**提示词没有指定 `clientSessionId`**。两次返回相同 Task ID `b10bc8be-582a-447d-bf0a-f0026a666f56`；Hub SQLite 独立核验 `source_session_id` 与 Claude 原生 ID 一致，只存在 **1 Task、1 Run**。不同 Claude 会话的 ID 本身不同，保持隔离。

### 标准客户端 Release v8（自动安装）

从 Hub 下载 `setup-claude-code.sh` 或 `setup-claude-code.ps1` 后，脚本会自动下载客户端 Release v8，内含 Linux `scripts/claude/expert-session-hook.py` 和 Windows `scripts/claude/expert-session-hook.ps1`。Setup 将 Hook 复制到用户 Claude `hooks` 目录并注册只匹配两个 Expert 提交工具的 `PreToolUse`，重复执行不叠加 Hook，不覆盖其他 Hooks。以后客户端升级需重启 Claude Code 才能确保新 Hooks 生效。此能力适用于默认 MCP 名称 `teamSkillHub`；使用自定义 MCP server name 时当前不会安装该专用 Hook。Linux 需要 `python3`；Windows 使用 PowerShell，不要求 Python。

### Claude 任务最大回合数

Worker 环境变量 `EXPERT_CLAUDE_MAX_TURNS` 用来配置 Claude CLI 的 `--max-turns`，默认 `12`（兼容原有行为），允许 `1`～`1000` 的整数；非法值在 Worker 启动时拒绝。此参数适用于默认 Claude Model 和 Hub 下发的 Claude AI Router Model，Codex 后端不受影响。其限制不同于任务整体超时 `EXPERT_TASK_TIMEOUT_MS`，两者可独立设置。修改 Worker 环境变量后需要重启 Worker 才会生效。
