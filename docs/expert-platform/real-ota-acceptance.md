# 真实 OTA Expert 验收

> 新增 Expert 的完整搭建步骤和手动测试提示词统一维护在 [`add-expert.md`](./add-expert.md) 第 7 节。本文保留 OTA 专项验收的详细命令和分析场景；日常新增其他 Expert 时，优先使用该操作手册。

本文用于验收真实链路，不以单元测试或模拟 Executor 代替真实模型分析。当前主路径以正式 Worker Runtime + Deployment 模型配置为准；下面保留 OTA/Codex 场景，同时指出与旧原型的差异。

## 验收链路

```text
Codex CLI / MCP
  → submit_expert_task
  → Expert Router
  → 持久化 Task
  → gRPC Worker
  → Deployment snapshot（Backend / Model / MCP）
  → Docker 中的 Codex CLI（只读沙箱）
  → Skill Hub MCP（只读 Skill/Knowledge）
  → get_expert_task_status / get_expert_task_result
```

## 1. 启动 Hub Expert Runtime

在 `team-skill-hub` 仓库根目录执行：

```bash
docker compose -f docker-compose.yml -f docker-compose.expert.yml up -d --build
docker logs team-skill-hub 2>&1 | grep expert.grpc.started
```

同一台 WSL2 主机上的 Worker 使用 `127.0.0.1:7443`。Compose override 默认只把 gRPC 端口发布到本机回环地址。

## 2. 注册 OTA Expert 和 Deployment

当前 WSL2 验收所用 OTA 代码仓库为 `/mnt/d/wsl/.codex/workspace/otalib`，逻辑仓库 ID 使用 `otalib`。如果代码目录不同，后续将 `EXPERT_SOURCE_PATH` 改为实际绝对路径。

```bash
docker exec team-skill-hub node dist/src/cli/expert-admin.js define ota "OTA Expert" ota upgrade,rollback,firmware,power-loss
docker exec team-skill-hub node dist/src/cli/expert-admin.js deploy ota-default ota otalib YOUR_MCP_PRINCIPAL_ID codex-readonly
docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments
```

将 `YOUR_MCP_PRINCIPAL_ID` 替换为发起 MCP 请求的 API Key 对应的 principal `id`，不是 tenant ID。

## 3. 注册并审批 Worker

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll ota-worker-01 ota
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve ota-worker-01
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential ota-worker-01
```

Credential 只显示一次。把它填入下面的本地 Worker 配置，不要发送到聊天或提交到 Git。

## 4. 配置真实 Codex Worker

在 Worker 所在的 WSL2 Linux 文件系统创建 `/etc/expert/ota-worker.env`。不要把密钥保存在 `/mnt/d` 下并依赖 `chmod 600`，因为 Windows 盘的 WSL 权限显示可能仍为 `777`。

```bash
sudo install -d -m 700 /etc/expert
sudoedit /etc/expert/ota-worker.env
sudo chown root:root /etc/expert/ota-worker.env
sudo chmod 600 /etc/expert/ota-worker.env
```

环境文件应包含：

```dotenv
EXPERT_HUB_ADDRESS=127.0.0.1:7443
EXPERT_WORKER_ID=ota-worker-01
EXPERT_WORKER_CREDENTIAL_FILE=/var/lib/team-skill-hub-worker/worker-credential
EXPERT_CAPABILITY=ota
EXPERT_ID=ota
EXPERT_SOURCE_PATH=/var/lib/team-skill-hub-worker/source
EXPERT_REPOSITORY_ROOT=/var/lib/team-skill-hub-worker/repositories
EXPERT_EXECUTOR_BACKEND=codex
EXPERT_RUNTIME_PROFILES=codex-readonly
EXPERT_DOCKER_IMAGE=team-skill-hub-expert-worker:0.1.0
EXPERT_DOCKER_NETWORK=bridge
EXPERT_DOCKER_SECCOMP_PROFILE=unconfined
EXPERT_MODEL_ENV_NAMES=TEAM_SKILL_HUB_API_KEY,HTTPS_PROXY,NO_PROXY
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"TEAM_SKILL_HUB_API_KEY"}'
EXPERT_MCP_URL=http://team-skill-hub:8080/mcp
EXPERT_MCP_CREDENTIAL_FILES_JSON='{"skillhub-readonly":"/etc/team-skill-hub-worker/keys/skillhub-readonly"}'
EXPERT_HEARTBEAT_MS=10000
EXPERT_POLL_MS=3000
EXPERT_TASK_TIMEOUT_MS=120000
TEAM_SKILL_HUB_API_KEY=填入你为当前Provider准备的APIKey
```

不再要求运维人员维护固定 `/etc/expert/ota-codex.toml`。Provider、Model、Base URL、协议和 MCP 策略来自 Deployment 快照；Worker 每任务生成临时 Codex 配置。长期密钥只保存在 Worker 受保护环境或 key 文件中。

确认本机已配置密钥，但不要打印密钥值：

```bash
set -a
source /etc/expert/ota-worker.env
set +a
test -n "${TEAM_SKILL_HUB_API_KEY:-}" && echo PROVIDER_KEY_PRESENT || echo PROVIDER_KEY_MISSING
test -d "$EXPERT_SOURCE_PATH" && echo OTA_SOURCE_PRESENT || echo OTA_SOURCE_MISSING
docker run --rm "$EXPERT_DOCKER_IMAGE" --version
```

正式部署应使用发布管理员交付的 `worker-runtime-<version>.tar.gz` 和 `expert-worker-image-<version>.tar`，Worker 主机无需 Hub 源码。没有 systemd 时使用 `/opt/team-skill-hub-worker/current/worker-control.sh` 或受控进程管理器启动；有 systemd 时使用 `team-skill-hub-worker.service`。

Docker Codex Executor 将源码以只读方式挂载，容器禁用新增 Linux capabilities、使用只读根文件系统和受限资源。此验收不允许 Expert 自动修改或提交 OTA 仓库。

Worker 镜像必须包含系统 CA 证书。WSL2 的 Docker 默认 seccomp 可能阻止 Codex 的 `bwrap` 只读沙箱创建用户命名空间；这种环境下将 `EXPERT_DOCKER_SECCOMP_PROFILE` 显式设为 `unconfined`。这会降低 seccomp 防护，但外层容器仍保持非特权、只读根文件系统和只读源码挂载。其他支持嵌套用户命名空间的主机可以省略该项，使用 Docker 默认 seccomp。

## 5. 从 MCP 提交真实 OTA 分析任务

使用已连接 Team Skill Hub 的 Codex CLI 调用 `submit_expert_task`，参数示例：

```json
{
  "problem": "请只读分析 otalib 的 OTA 安装与升级状态机：追踪断电发生在镜像写入、完整性校验、启动槽切换和状态持久化各阶段时的处理路径；指出可能的状态不一致、回滚风险及测试缺口。结论必须引用仓库中的真实文件路径和函数，不要修改文件。",
  "idempotencyKey": "otalib-power-loss-review-2026-10-21",
  "repositoryId": "otalib"
}
```

Hub 应自动路由到 `ota` Expert，并返回 `taskId`。随后调用：

1. `get_expert_task_status`，传入返回的 `taskId`，直到 `status` 为 `succeeded` 或 `failed`。
2. 只有 `status` 为 `succeeded` 时调用 `get_expert_task_result`，获取真实分析报告。

当前执行镜像已经包含 `git`，因此任务容器可以在只读仓库上执行 `git status/log/diff/show/branch` 等分析；clone/fetch/reset/clean 仍由宿主 Worker 在领取任务后完成。

## 验收标准

- [ ] Hub 日志出现 `expert.grpc.started`。
- [ ] MCP 返回的 `expertId=ota`、`selectionMode=auto`、`repositoryId=otalib`。
- [ ] Worker 通过真实 gRPC 领取该 Task。
- [ ] Docker 内的真实 Codex CLI 成功完成只读分析。
- [ ] MCP 查询到 `succeeded`，结果引用 `otalib` 中真实存在的代码路径。
- [ ] OTA 仓库工作区没有被 Expert 修改。

如果 Provider 需要代理，必须将可从 WSL2/Docker 网络访问的代理地址配置到 `HTTPS_PROXY`，并确认端口正在监听。如果缺少 Provider 凭据或网络不可达，只能完成 MCP/gRPC 集成测试，不能把模拟 Executor 的结果算作真实 Codex 验收。
