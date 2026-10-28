# Worker 选择 Codex / Claude 执行器

> 当前实现采用**每个独立 Worker Runtime 指定一个执行后端**。未设置 `EXPERT_EXECUTOR_BACKEND` 时默认 Claude Code；需要 Codex 时须显式设置 `codex`。Claude CLI（派发者）与 Claude Worker（执行者）是两个不同角色。

## 1. 选择与部署方式

| 后端           | Worker 主机配置                  | 需要导入的任务镜像                   | 模型认证                                                       |
| -------------- | -------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Codex（手动）  | `EXPERT_EXECUTOR_BACKEND=codex`  | `team-skill-hub-expert-worker:0.1.0` | 原有 Codex 或 Worker model credential ref                      |
| Claude（可选） | `EXPERT_EXECUTOR_BACKEND=claude` | `team-skill-hub-expert-claude:0.1.0` | Worker 环境的 `ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_OAUTH_TOKEN` |

发布管理员应在有 Hub 仓库源码的**构建机**运行：

```bash
npm run build:worker-runtime
bash scripts/build-worker-claude-image.sh 0.1.0
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
EXPERT_CLAUDE_MODEL=sonnet
EXPERT_MODEL_ENV_NAMES=ANTHROPIC_API_KEY,HTTPS_PROXY,NO_PROXY
ANTHROPIC_API_KEY=从安全密钥系统注入的实际值
```

如需改回 Codex，可设置 `EXPERT_EXECUTOR_BACKEND=codex`、导入 `team-skill-hub-expert-worker:0.1.0` 并设置对应的 `EXPERT_DOCKER_IMAGE`、Codex 凭据映射。已经在运行的旧 Worker 无需添加后端字段也继续使用 Codex，但不应仅靠旧镜像名推断后端。

改用 OAuth token 时，将上面的 `ANTHROPIC_API_KEY` 替换为 `CLAUDE_CODE_OAUTH_TOKEN` 并在 `EXPERT_MODEL_ENV_NAMES` 中同步替换。**绝对不要**把密钥写进镜像、Git、发布 tar 包或文档。模型必须是安装的 Claude CLI 认可且当前账户有权限访问的模型 ID；使用代理网关时，所需 `ANTHROPIC_BASE_URL` 等变量也必须在 Worker 环境及 `EXPERT_MODEL_ENV_NAMES` 白名单内显式配置。

```bash
sudo systemctl restart team-skill-hub-worker
sudo journalctl -u team-skill-hub-worker -n 100 --no-pager
```

## 2. 隔离与兼容性

Claude Executor 仅开放 `Read,Glob,Grep`，使用 `--permission-mode dontAsk`、非 root 执行、只读仓库 bind mount、read-only Docker 文件系统、资源限制和禁用写入工具。结果通过 `claude -p --output-format json` 的成功记录解析；失败时不将模型原始输出记入 Hub 阶段日志。仍应只在可信仓库使用 Worker，并根据组织的 Claude Code 商业许可和认证政策执行。

当前 **Expert `modelConfig` 中的 `wireApi=responses` 是 Codex 专用配置**；Claude Worker 不使用该配置的模型 Provider/Base URL，也不自动读取宿主机的 Claude 登录态。Claude 通过 Worker 自身明确配置的模型、API Key / OAuth token 和环境变量连接服务。这个方案不会将 Codex 的 API Key 隐式复用为 Claude 的密钥。

当前后端选择属于**Worker 部署配置**，尚非 Admin 中每条 Deployment 动态选择。若需 OTA 固定 Claude、code-review 固定 Codex，请为对应专家分别配置独立 Worker 身份、`EXPERT_ID`、capability、镜像与 backend。Hub 现有任务路由和 Worker 能力匹配保持不变。以后可以在 Deployment 增加期望 Backend 并由 Hub 在 Claim 时强校验。

## 3. Claude CLI 自动派发

Hub 新增 `submit_expert_task_auto`，仅需 `problem` 和新任务的 `idempotencyKey`，**不接受** `expertId`、占位值或 `selectionMode`。例如，在已连接 `teamSkillHub` MCP 的 Claude CLI 会话中：

> 请通过 Team Skill Hub 的 `submit_expert_task_auto` 只读分析 OTA 断电恢复相关源码。请使用新的 idempotencyKey；返回实际 taskId。任务执行完成后，通过 `get_expert_task_status` 和 `get_expert_task_result` 查询结果。

普通 `submit_expert_task` 保留用于显式指定专家和需要指定具体 Repository ID 的场景。若自动路由遇到 `AMBIGUOUS_EXPERT`、`REPOSITORY_REQUIRED`，应让用户明确目标而非猜测。

## 4. 验收口径

必须分别验证：Claude CLI 实际调用了 `submit_expert_task_auto`、返回真实 Task ID；Hub 中选中的 Expert 正确、Worker 正确领取；Worker 使用导入的 Claude 镜像而非 Codex 镜像；分析成功且源码仓库没有变更；Admin → 专家平台 → 任务运行记录可查看 `repository`、`container`、`claude`（Claude 执行阶段）与 `execution` 的阶段事件。Codex Worker 和历史任务应保持可用。
