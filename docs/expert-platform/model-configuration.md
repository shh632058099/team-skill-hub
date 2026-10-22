# 专家模型配置与凭据映射

每个 Expert 的 AI Router/模型设置由 Admin 的“专家配置”维护。配置包括 Provider ID、模型名、Base URL、Responses API 协议、凭据引用（可选）和允许传入执行容器的环境变量名称。API Key 本身不会写入 Expert 数据库或随任务下发。

## Worker 凭据引用映射

当专家配置填写了 `credentialRef` 时，Worker 主机必须在受保护的 Worker 环境配置中设置 `EXPERT_MODEL_CREDENTIAL_REFS_JSON`，将该引用映射到主机已有的环境变量名。例如：

```bash
EXPERT_MODEL_ENV_NAMES=TEAM_SKILL_HUB_API_KEY,NO_PROXY
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"TEAM_SKILL_HUB_API_KEY"}'
```

`EXPERT_MODEL_CREDENTIAL_REFS_JSON` 的值只包含“凭据引用 → 环境变量名”的映射，不得包含 Token/API Key 明文。例如现有 Router 凭据引用为 `bst-router`，映射到 Worker 已加载的 `TEAM_SKILL_HUB_API_KEY`。映射目标必须同时出现在 `EXPERT_MODEL_ENV_NAMES` 白名单中。主机进程环境中必须实际存在对应变量，Docker 才能将其传给执行容器。

如果 `credentialRef` 为空，兼容逻辑会从专家配置的 `allowedEnvNames` 中选择第一个非代理环境变量作为 Codex `env_key`。建议正式部署显式配置凭据引用，以便运维和审计。

## 运行行为

- 每个任务根据选中的 Expert 生成独立的临时 Codex 配置；其中只包含模型配置和环境变量名称，不包含密钥值。
- 临时配置以只读方式挂载到容器，任务完成或失败后从 Worker 主机删除。文件权限为 `0644`，因为容器内 UID 10001 必须读取它；文件仅含模型名、Provider、Base URL 和环境变量名，不含密钥值。凭据只通过允许的环境变量传入。
- 专家配置未设置 `modelConfig` 时，继续使用现有 Worker `EXPERT_CODEX_CONFIG_FILE`，用于兼容旧配置。
- Provider ID 仅允许字母、数字、下划线和连字符；当前首版只支持 Codex Responses API。

## 当前验收配置（2026-10-22）

- `ota`：Provider `bst`，模型 `gpt-5.6-luna`，凭据引用 `bst-router`。
- `code-review`：Provider `bst`，模型 `gpt-5.6-sol`，凭据引用 `bst-router`。
- Router Base URL：`https://route.briancs.shop/v1`，协议为 Responses API。
- Worker 通过 `/etc/expert/ota-worker.env` 读取 `EXPERT_MODEL_CREDENTIAL_REFS_JSON`；Provider 密钥来自权限受限的 `/etc/expert/ota-provider.env`。密钥没有写入项目 `.env`、专家数据库或文档。
- `gpt-5.6-sol` 已通过真实 Codex 容器调用 Router 的 smoke test；`gpt-5.5` 返回当前 ChatGPT 账户不支持的 400，因此未用作第二专家模型。
- Hub gRPC 端口 `7443` 仅绑定 `127.0.0.1`，不对局域网直接开放。

## Worker 常驻与 WSL 启动恢复

当前 WSL 使用 systemd=false，因此没有用 systemd unit 管理 Worker。两个 Worker 通过独立 tmux 会话运行：

- ota-expert-worker：身份 ota-worker-01，仅有 ota capability。
- code-review-expert-worker：身份 code-review-worker-01，仅有 review capability。

已安装 /usr/local/sbin/start-skillhub-expert-workers 启动脚本，并在 /etc/wsl.conf 的 [boot] 中配置 command=/usr/local/sbin/start-skillhub-expert-workers。启动脚本会等待 Docker Engine、确认 Hub readiness、再以幂等方式恢复两个 Worker 会话；日志写入 /var/log/skillhub-expert-workers-startup.log。

手动检查/启动：

    /usr/local/sbin/start-skillhub-expert-workers
    tmux -L skillhub list-sessions
    tail -50 /var/log/skillhub-expert-workers-startup.log

已通过模拟 tmux 进程丢失验证：清除旧 tmux server 后执行启动脚本，两个 Worker 会话均被重新创建。此测试不等同于真正执行 wsl --shutdown 后的 Windows/WSL 冷启动验收。

冷启动恢复后的真实 MCP 任务最初出现 EXECUTION_FAILED。诊断发现启动脚本的 umask 077 会将临时 Codex 配置文件收紧为 0600，导致执行容器内 UID 10001 无法读取。现已在创建后显式 chmod 0644，并添加在 umask 077 下验证权限的回归测试。另已将 Worker 连接 Hub 的瞬时 gRPC 错误改为脱敏记录并按 poll 间隔重试，避免 Hub 重启时 Worker 进程直接退出。

已完成修复后的真实 MCP 端到端验证：

- code-review 任务 9d811623-7460-4ca5-ba61-00c741cc3a02：succeeded，报告成功持久化并经 get_expert_task_result 读取。
- OTA 任务 55499f38-bb54-4e05-a564-e07eb015c066：succeeded。
- Hub readiness 为 HTTP 200，3 个仓库健康；两个独立 Worker 会话均运行。

仍未执行真正的 wsl --shutdown 冷启动验收；目前完成的是模拟 tmux server/Worker 进程丢失后的恢复测试。

### Worker 独享源码仓库

`EXPERT_REPOSITORY_ROOT` 是仓库缓存的**父目录**，不是所有 Worker 共用的 checkout。Worker 启动配置会自动追加经过校验的 `EXPERT_WORKER_ID`，例如：

- `/srv/expert-repositories/ota-worker-01/`
- `/srv/expert-repositories/code-review-worker-01/`

每个 Worker 在自己的目录下按 repository ID clone/fetch，并独享该工作区；不同 Worker 不会操作同一份 `.git` 或工作树。当前 Worker 主循环逐个处理任务，因此同一 Worker 内的仓库更新和 Codex 执行是串行的。部署时必须为每个并行 Worker 分配唯一、稳定的 Worker ID。

### Worker 故障恢复与日常运维

每个 Worker 必须使用唯一且稳定的 `EXPERT_WORKER_ID`。`EXPERT_REPOSITORY_ROOT` 是父目录，配置解析后会自动追加 Worker ID；不要把两个 Worker 配置成同一个 ID，也不要手工将某个 Worker 的 clone 目录挂载给另一个 Worker。仓库目录由 Worker 自己维护，不要在 Worker 正执行任务时手动执行 `git checkout`、`git reset --hard` 或 `git clean`。

检查两个 Worker 会话：

```bash
tmux -L skillhub list-sessions
tail -n 100 /var/log/skillhub-expert-workers-startup.log
curl -i http://127.0.0.1:8080/health/ready
```

恢复步骤：

1. 先查看启动日志与 Hub readiness；若 Hub 未就绪，先恢复 Hub，不要反复重启 Worker。
2. 在确认配置文件和凭据引用存在后，执行 `/usr/local/sbin/start-skillhub-expert-workers`。脚本按稳定 Worker ID 幂等恢复会话。
3. 使用 `tmux -L skillhub list-sessions` 确认会话，再通过 MCP 查询之前任务的状态。不要因客户端超时就用新的 idempotency key 重复提交同一任务。
4. 租约过期后 Hub 可让另一 Worker 重新领取任务；旧 run 会记为 `expired`，迟到的旧执行结果会被 fencing 校验拒绝。
5. 只有在确认没有任务运行且保留必要日志后，才清理 Worker 专属 clone 目录。不要删除共享父目录或其他 Worker 的目录来排障。

Worker 凭据、Git Token 和模型 API Key 不应写入此文档、命令行参数、Git URL 或仓库文件。排障时仅记录脱敏后的 Worker ID、Task ID、run 状态、错误码和 readiness。
