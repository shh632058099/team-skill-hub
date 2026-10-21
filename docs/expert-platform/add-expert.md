# 新增 Expert：傻瓜式操作手册

只想新增 OTA / Yocto / MsgBox Expert 时，按下面顺序复制执行即可。示例使用 OTA。

## 0. 先准备

需要：

- Hub 已部署。
- Worker 机器已安装 Docker。
- Worker 机器已有源码目录。
- 一个 Codex 支持的 provider（官方 OpenAI 或自定义 provider），以及该 provider 对应的认证方式。
- 如使用自定义 provider，准备一份独立的 Codex `config.toml`；不要直接挂载宿主机默认的 `~/.codex/config.toml`。

示例：

- capability：`ota`
- Worker ID：`ota-worker-01`
- 源码：`/srv/repos/ota`
- Hub gRPC：`192.168.1.10:7443`

## 1. Hub：开启 Expert Runtime

从项目根目录使用 Expert Compose override 部署。gRPC 端口默认只绑定到 WSL2 本机 `127.0.0.1`，Expert 数据保存在已有的持久化 volume 中：

```bash
docker compose -f docker-compose.yml -f docker-compose.expert.yml up -d --build
```

如需让其他机器上的 Worker 连接，部署前将 `EXPERT_GRPC_PUBLISH_BIND` 设置为 Hub 主机可达的地址，并配置防火墙；不需要远程访问时不要绑定 `0.0.0.0`。

重新部署 Hub 后检查：

```bash
docker logs team-skill-hub 2>&1 | grep expert.grpc.started
```

必须看到类似：

```text
{"event":"expert.grpc.started","address":"0.0.0.0:7443"}
```

看不到就先不要继续。

## 2. Hub：创建 Expert 定义和 Deployment

先创建 OTA Expert：

```bash
docker exec team-skill-hub node dist/src/cli/expert-admin.js define ota "OTA Expert" ota upgrade,rollback,firmware,power-loss
```

再创建 Deployment：

```bash
docker exec team-skill-hub node dist/src/cli/expert-admin.js deploy ota-default ota ota-repo YOUR_USER_ID codex-readonly
```

需要修改：

```text
ota-repo       -> OTA 仓库 ID
YOUR_USER_ID   -> 允许使用这个 Expert 的用户 ID
```

检查：

```bash
docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments
```

## 3. Hub：注册 Worker

注册：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll ota-worker-01 ota
```

应看到 `status: pending`。

审批：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve ota-worker-01
```

应看到 `status: active`。

生成 credential：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential ota-worker-01
```

记下输出里的：

```text
ewc_xxxxxxxxx
```

credential 只显示这一次。

## 4. Worker：构建运行镜像

在 `team-skill-hub` 目录执行：

```bash
docker build -t team-skill-hub-expert-worker:prototype docker/expert-worker
```

验证：

```bash
docker run --rm team-skill-hub-expert-worker:prototype --version
```

应看到：

```text
codex-cli 0.162.1
```

## 5. Worker：创建配置文件

在 Worker 主机的 Linux 文件系统创建环境文件。**不要把 API Key 放在 `/mnt/d` 下的文件中再依赖 `chmod 600`**；WSL 对 Windows 盘的权限显示可能仍是 `777`。在 WSL2 上建议使用 `/etc/expert/ota-worker.env`：

```bash
sudo install -d -m 700 /etc/expert
sudoedit /etc/expert/ota-worker.env
sudo chown root:root /etc/expert/ota-worker.env
sudo chmod 600 /etc/expert/ota-worker.env
```

文件内容示例：

```dotenv
EXPERT_HUB_ADDRESS=192.168.1.10:7443
EXPERT_WORKER_ID=ota-worker-01
EXPERT_WORKER_CREDENTIAL=ewc_xxxxxxxxx
EXPERT_CAPABILITY=ota
EXPERT_ID=ota

EXPERT_SOURCE_PATH=/srv/repos/ota
EXPERT_DOCKER_IMAGE=team-skill-hub-expert-worker:prototype
EXPERT_DOCKER_NETWORK=bridge
EXPERT_DOCKER_SECCOMP_PROFILE=unconfined

EXPERT_CODEX_CONFIG_FILE=/etc/expert/ota-codex.toml
EXPERT_MODEL_ENV_NAMES=MY_ROUTER_API_KEY,HTTPS_PROXY,NO_PROXY
EXPERT_HEARTBEAT_MS=10000
EXPERT_POLL_MS=3000
EXPERT_TASK_TIMEOUT_MS=120000

MY_ROUTER_API_KEY=你的_provider_API_Key
```

先准备独立的 provider 配置文件。可从 `docs/expert-platform/codex-provider.example.toml` 复制为 `/etc/expert/ota-codex.toml`，并按 provider 文档修改 `model`、`base_url`、`wire_api` 和 `env_key`。当前 Worker 镜像的 Codex CLI 使用 Responses API；provider 必须兼容该 API，只有 `/chat/completions` 接口的服务不能直接套用此示例。API Key 只放在受保护的环境文件中，不要写进 TOML。

Worker 镜像安装了系统 `ca-certificates`，供 Codex 的原生 HTTPS 客户端验证服务端证书。`EXPERT_DOCKER_SECCOMP_PROFILE` 默认使用 Docker 默认 seccomp；若 WSL2 下 Codex 报告 `bwrap: No permissions to create a new namespace`，可显式设置为 `unconfined`，让内层只读沙箱创建用户命名空间。外层容器仍禁用 capabilities、使用只读根文件系统和只读源码挂载，但 `unconfined` 会降低 seccomp 这一层防护，应只在理解权衡后启用。

```bash
sudo install -d -m 700 /etc/expert
sudo install -m 600 docs/expert-platform/codex-provider.example.toml /etc/expert/ota-codex.toml
sudoedit /etc/expert/ota-codex.toml
```

只改这些项：

1. `EXPERT_HUB_ADDRESS`
2. `EXPERT_WORKER_CREDENTIAL`
3. `EXPERT_SOURCE_PATH`
4. `EXPERT_CODEX_CONFIG_FILE`：该 Worker 专属的 Codex 配置文件绝对路径
5. `EXPERT_MODEL_ENV_NAMES`：把 provider 配置中的 `env_key` 对应环境变量名列入白名单，并按需加入代理变量
6. 对应的 provider API Key 环境变量

例如，另一个 Worker 可以设置自己的 `EXPERT_CODEX_CONFIG_FILE`、`model_provider`、`base_url`、`wire_api` 和 API Key 环境变量。不同 Worker 不需要共享同一个 provider。

如果使用 Codex 登录认证而非 API Key，可通过 `EXPERT_CODEX_AUTH_FILE` 指定独立 `auth.json` 文件；认证文件和 provider 配置文件分开挂载。不要把认证文件提交到 Git。

如果 Worker 与 Hub 在同一个 WSL2：

```bash
EXPERT_HUB_ADDRESS=127.0.0.1:7443
```

## 6. Worker：启动

```bash
set -a
source /etc/expert/ota-worker.env
set +a

npm run expert-worker
```

命令会一直运行，这是正常的。停止时按 `Ctrl+C`。

## 7. 手动端到端测试（推荐）

这一步验证完整真实链路，而不只是 Provider 能返回 HTTP 200：

```text
Windows Codex CLI
  → teamSkillHub MCP
  → submit_expert_task
  → Hub 按当前 MCP principal 自动路由到 Expert
  → Worker 通过 gRPC 领取任务
  → Docker 内的真实 Codex CLI 分析只读源码
  → get_expert_task_status / get_expert_task_result
```

### 7.1 检查 Codex MCP 配置和 Hub

在你平常使用 Codex 的 Windows PowerShell 中执行：

```powershell
codex mcp list
```

确认列表中有 `teamSkillHub`，URL 指向 `http://127.0.0.1:8080/mcp`（或你实际配置的 Hub 地址），状态为 `enabled`。不要输出或截图暴露 Bearer Token / API Key。

确认 Hub 健康、Worker 仍在运行：

```bash
curl -fsS http://127.0.0.1:8080/health/ready
docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments
```

还要通过 Hub 管理界面、Worker 管理命令或 Hub 日志确认 Worker 为 `active`，不要只凭进程存在就认为 Worker 已连接。

在提交任务前记录源码仓库状态。这样即使仓库原本就有未提交文件，也能比较测试前后是否发生变化：

```bash
git -C "$EXPERT_SOURCE_PATH" status --short > /tmp/ota-status-before.txt
```

### 7.2 在真实 Codex CLI 会话中提交任务

启动你平常使用的 Codex CLI（不要换成临时 API 客户端），将下面这段提示词发给它：

```text
请使用 teamSkillHub MCP 做一次真实 Expert 端到端验收。

1. 先调用 get_server_info，记录返回的 principal.id、tenant_id。
2. 调用 submit_expert_task，提交一个只读的 OTA 升级与断电恢复分析任务，repositoryId 使用 otalib；不要传 expertId，以验证 Hub 自动路由。
3. 本次 idempotencyKey 使用一个全新的值，例如 ota-manual-20261021-1400；每次重新测试都换一个唯一值，避免幂等键复用旧任务。
4. 提交成功后，记下 taskId，并报告 taskId、principal.id、expertId、selectionMode、repositoryId。
5. 本轮先停止，不要高频轮询状态，也不要提前调用 get_expert_task_result。

分析要求：检查 otalib 中 OTA 状态机、升级写入、完整性校验、启动槽切换、持久化和断电恢复路径，指出有证据支持的风险和测试缺口。严禁修改文件、配置、Git 历史或远程仓库。必须实际调用上述 MCP 工具，不要模拟结果，也不要只给我命令。
```

提交后等约 30～60 秒，再在**同一个 Codex 会话**发送下面的后续提示词；如果状态仍为 `running`，再等一会儿重复查询，不要快速连续轮询：

```text
请使用 teamSkillHub MCP 查询 taskId=替换成上一步返回的真实 taskId。

调用一次 get_expert_task_status，并报告 status、expertId、selectionMode 和 repositoryId。
- 如果 status=succeeded，继续调用 get_expert_task_result，概括实际报告，并列出报告引用的真实文件路径/函数。
- 如果 status=running，只告诉我稍后需要再次查询，不要连续轮询。
- 如果 status=failed，报告可见的失败信息和下一步排查方向。

不要修改任何文件、配置、Git 历史或远程仓库；不要编造任务状态或结果。
```

### 7.3 判断是否真正跑通

必须同时满足以下条件，才算端到端验收通过：

1. `get_server_info` 返回当前 Codex 实际使用的 `principal.id`。
2. `submit_expert_task` 返回 `taskId`，且 `expertId=ota`、`selectionMode=auto`、`repositoryId=otalib`。
3. Worker 确实领取该任务；最终状态为 `succeeded`，不是只创建成功或一直 `running`。若第一次查询仍是 `running`，等待 30～60 秒后再查，不要高频轮询。
4. `get_expert_task_result` 返回非空的实际分析报告，包含可在源码中核对的路径、函数或测试。
5. 比较测试前后的仓库状态，确认没有新增变化：

   ```bash
   git -C "$EXPERT_SOURCE_PATH" status --short > /tmp/ota-status-after.txt
   diff -u /tmp/ota-status-before.txt /tmp/ota-status-after.txt
   ```

   `diff` 没有输出且退出码为 `0` 表示状态列表一致。Worker 的 Docker Executor 还应以只读方式挂载源码；如果仓库本来就有未提交变更，不要为了验收而清理或重置它们。

**注意：** 仅 `codex mcp list` 显示 enabled、`get_server_info` 成功、Provider HTTP 200，或者 MCP 返回一个 `taskId`，都不能单独算作端到端成功。必须等 Worker 执行完成并取回结果。

### 7.4 常见错误如何处理

| 错误 / 现象                   | 检查方式与处理                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPERT_UNAVAILABLE`          | 在 Codex 中调用 `get_server_info`，确认 `principal.id`；再看 `list-deployments` 中对应 Deployment 的 `principals` 是否包含该 ID、Deployment 是否 active、`otalib` 是否在仓库列表中，以及问题描述是否包含 OTA 的相关关键词。不要用显示名称或 tenant ID 代替 principal ID。 |
| `EXPERT_FORBIDDEN`            | 指定的 Expert 不允许当前 principal 使用。自动路由测试应省略 `expertId`，并检查部署授权。                                                                                                                                                                                  |
| 提交失败，没有 `taskId`       | 没有任务可轮询；先修复提交错误，不要继续调用状态/结果工具。                                                                                                                                                                                                               |
| 状态一直 `running`            | 检查 Worker 进程、Hub lease/心跳、Docker 容器日志和任务超时设置。不要把 running 当作成功。                                                                                                                                                                                |
| `failed` / `EXECUTION_FAILED` | 检查 Provider 的 `base_url`、`wire_api=responses`、`env_key` 与 `EXPERT_MODEL_ENV_NAMES`、API Key、代理、CA 证书和 Codex 沙箱日志。                                                                                                                                       |
| `TASK_NOT_READY`              | 任务尚未 succeeded；先继续查询状态，不能提前取结果。                                                                                                                                                                                                                      |

如需把新的 MCP principal 加入允许列表，先确认它来自 `get_server_info`，然后用 `deploy` 更新完整授权列表。例如：

```bash
# 第四个参数是完整 allowlist；更新时必须保留所有仍应有权限的现有 ID。
docker exec team-skill-hub node dist/src/cli/expert-admin.js deploy ota-default ota otalib developer,YOUR_MCP_PRINCIPAL_ID codex-readonly
docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments
```

不要为了消除 `EXPERT_UNAVAILABLE` 而关闭授权检查或把不必要的用户加入列表。

### 7.5 不使用 Codex CLI 时的辅助检查

可以直接查看 Worker 镜像和源码挂载是否可用，但这些只是诊断步骤，不能替代 7.2 的真实 MCP 测试：

```bash
docker run --rm team-skill-hub-expert-worker:prototype --version
test -d "$EXPERT_SOURCE_PATH" && echo SOURCE_OK || echo SOURCE_MISSING
docker logs team-skill-hub 2>&1 | grep expert.grpc.started
```

## 8. 怎么判断成功

满足下面 5 条：

```text
[ ] Hub 日志有 expert.grpc.started
[ ] Worker 已 active
[ ] npm run expert-worker 持续运行
[ ] Worker 能 Claim task
[ ] Task 最终 succeeded
```

如果前 4 项通过、最后是 `EXECUTION_FAILED`：

```bash
test -n "$MY_ROUTER_API_KEY" && echo PROVIDER_KEY_OK || echo PROVIDER_KEY_MISSING
```

优先检查 provider 配置文件、`env_key` 与 `EXPERT_MODEL_ENV_NAMES` 是否一致，以及 API Key 和代理。

如果 Provider 需要代理，必须确认代理端口实际在监听，并且能从 Worker 所在的 WSL2/Docker 网络访问；仅设置 Windows 系统代理并不会自动让 Docker Worker 获得可用的 `HTTPS_PROXY`。

## 9. 常见错误

### INVALID_WORKER_CONFIG

```bash
env | grep '^EXPERT_'
```

检查环境变量是否缺失。

### WORKER_UNAUTHENTICATED

重新签发 credential：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential ota-worker-01
```

然后更新 `.env.ota-expert`。旧 credential 立即失效。

### Worker 连不上 Hub

Worker 上：

```bash
nc -vz 192.168.1.10 7443
```

Hub 上：

```bash
docker logs team-skill-hub 2>&1 | grep expert.grpc.started
```

### Docker Codex 起不来

```bash
docker run --rm team-skill-hub-expert-worker:prototype --version
test -d "$EXPERT_SOURCE_PATH" && echo SOURCE_OK || echo SOURCE_MISSING
```

## 10. 新增 Yocto / MsgBox

重复步骤 2～5，并替换：

```text
ota
ota-worker-01
/srv/repos/ota
```

例如 Yocto：

```text
yocto
yocto-worker-01
/srv/repos/yocto
```

不需要复制 Worker 代码。

## 11. 吊销 Worker

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js revoke ota-worker-01
```

立即生效。

## 12. 流程跑通后再开 mTLS

Hub：

```bash
EXPERT_GRPC_TLS_CA_PATH=/etc/team-skill-hub/expert-ca.pem
EXPERT_GRPC_TLS_CERT_PATH=/etc/team-skill-hub/expert-server.pem
EXPERT_GRPC_TLS_KEY_PATH=/etc/team-skill-hub/expert-server-key.pem
```

Worker：

```bash
EXPERT_TLS_CA_PATH=/etc/expert/ca.pem
EXPERT_TLS_CERT_PATH=/etc/expert/worker.pem
EXPERT_TLS_KEY_PATH=/etc/expert/worker-key.pem
```

3 个 Worker TLS 参数必须一起配置。

---

一句话：**新增 Expert = 创建 ExpertDefinition/Deployment + 注册 Worker + 配置受保护的 Worker 环境文件 + 启动 `npm run expert-worker`。**
