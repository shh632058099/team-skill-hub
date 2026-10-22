# 新增 Expert 和 Worker：手把手操作手册

本文面向第一次使用 Team Skill Hub 专家平台的管理员，介绍如何新增一个专家、配置它可访问的 Git 仓库、注册独立 Worker，并从 Codex CLI/MCP 验证真实任务。所有配置均按当前代码和 Admin 页面实现编写。

> **先理解两个概念：**
>
> - **专家配置（Expert Definition）**：定义“它是谁、擅长什么、用哪个模型”。例如 `ota`、`code-review`。
> - **执行配置（Deployment）**：定义“谁可以调用这个专家、它能访问哪些仓库、使用什么运行环境”。一个专家可以绑定一个或多个仓库。
> - **Worker 执行配置**：Worker 主机上的本地环境文件，定义 Worker 身份、能力、Hub 地址、Docker、Git 凭据和模型凭据映射。它不是 Admin 页面中的 Deployment，也不应把密钥写入数据库或 Git。

下面优先使用 Admin 页面管理专家和执行配置；Worker 的注册/审批/签发凭据目前通过 CLI 完成。

## 0. 准备工作

开始前确认：

- Team Skill Hub 已部署并能打开 Admin 页面。
- Hub 的 Expert Runtime 已启用，且 Hub 与 Worker 使用同一套运行时/Worker 注册数据库。
- 已有可用的 Codex Responses API Provider、模型名称和 API Key。每个专家可选择不同模型配置。
- Worker 主机可以访问 Hub 的 gRPC 地址、Docker Engine 和 Git 仓库；私有仓库还需准备 SSH key 或 HTTPS Token。
- 你知道要允许哪些 MCP 调用者访问该专家。请从已授权的 MCP 会话中调用 `get_server_info` 获取准确的 `principal.id`，不要使用显示名称或 tenant ID 代替。

以下示例使用 `yocto` 专家、`yocto-worker-01` Worker 和 `https://github.com/your-org/yocto-layer.git` 仓库。请将示例仓库、分支、模型和 principal 替换为实际值。不要把 API Key、Worker credential 或 Git Token 粘贴到聊天、文档或命令历史中。

## 1. 打开专家管理页面

1. 登录 Team Skill Hub Admin。
2. 打开 **专家平台**，页面地址通常为 `/admin/experts`。
3. 页面分为 **专家配置** 和 **执行配置** 两部分。
4. 如果页面提示 `EXPERT_RUNTIME_DB_NOT_CONFIGURED`，说明 Hub 未配置专家运行时数据库；先修复 Hub 部署配置，不要尝试反复保存表单。

## 2. 创建专家配置

在“专家配置”区域选择创建专家，填写以下字段：

| 字段              | 示例                                          | 填写原则                                                         |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| 专家 ID           | `yocto`                                       | 稳定、唯一，建议小写英文和连字符；创建后作为调用/路由标识使用    |
| 显示名称          | `Yocto 构建专家`                              | 给管理员和用户看的名称                                           |
| Capabilities      | `yocto,build,linux`                           | 专家能处理的能力标签；多个值用逗号或换行分隔                     |
| Keywords          | `bitbake,recipe,layer,CVE`                    | 描述典型任务的关键词，帮助自动路由                               |
| Provider ID       | `bst`                                         | 与当前 Provider 配置约定一致；不是 API Key                       |
| Model             | `gpt-5.6-luna`                                | 填写你的 Router/Provider 实际支持的模型名                        |
| Base URL          | `https://route.briancs.shop/v1`               | 填写实际 API 入口，不要附带密钥                                  |
| Wire API          | `responses`                                   | 当前 Worker 的 Codex 执行链路使用 Responses API                  |
| Credential Ref    | `bst-router`                                  | 逻辑凭据引用；它不是密钥本身，后续要在 Worker 主机映射到环境变量 |
| Allowed Env Names | `TEAM_SKILL_HUB_API_KEY,HTTPS_PROXY,NO_PROXY` | 允许传入执行容器的环境变量名白名单；不要填写变量值               |
| 启用              | 勾选                                          | 保存后专家配置应处于启用状态                                     |

**模型配置注意事项**

- Provider 必须兼容 Codex CLI 使用的 Responses API；只有 `/chat/completions` 的服务不能直接套用。
- `Credential Ref` 应与 Worker 的 `EXPERT_MODEL_CREDENTIAL_REFS_JSON` 中的 key 完全一致。
- `Allowed Env Names` 只填变量名。密钥实际值由 Worker 主机的受保护环境文件提供。
- 如果不填写模型配置，会走兼容旧 Worker 配置的路径；新建专家建议显式配置模型，避免不同 Worker 意外使用旧默认值。
- 点击保存后，在列表中确认专家 ID、能力、关键词、模型和状态正确。

## 3. 创建执行配置并配置仓库地址

在“执行配置”区域选择创建执行配置，将刚才创建的专家绑定到可访问仓库。

| 字段                    | 示例                                          | 填写原则                                                             |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| 执行配置 ID             | `yocto-default`                               | 唯一、稳定的标识                                                     |
| 专家配置                | `yocto · Yocto 构建专家`                      | 选择第 2 步创建的专家                                                |
| 源码仓库地址            | `https://github.com/your-org/yocto-layer.git` | 填完整 Git clone URL；不要在 URL 中嵌入用户名、Token 或密码          |
| 分支                    | `main`                                        | 与仓库地址逐行对应；留空默认 `main`                                  |
| 仓库凭据引用            | `yocto-github-readonly`                       | 私有仓库填写 Worker 侧配置的凭据引用；公开仓库可留空                 |
| Git 代理地址            | `http://proxy-host:7890`                      | 可选；必须是 Worker 可访问的 HTTP/HTTPS 代理，URL 中不能包含认证信息 |
| 允许调用者 Principal ID | `实际的 principal.id`                         | 每行一个；只授权确实需要使用此 Deployment 的调用者                   |
| Runtime Profile         | `linux-yocto`                                 | 描述所需运行环境的标签，例如 `linux-yocto`、`linux-ota`              |
| 启用执行配置            | 勾选                                          | 只有启用的 Deployment 才能参与任务派发                               |

可以为一个 Deployment 填多组仓库：仓库 URL、分支、凭据引用、代理地址分别按行对应。不要在凭据引用或代理地址字段里填密钥。

点击“保存执行配置”后，确认列表中的专家、仓库 URL、分支、调用者、Runtime Profile 和启用状态正确。

### 仓库 ID 是什么？

仓库地址由 Admin 页面配置，Worker 会在执行任务时自行 clone/fetch。Hub 会根据仓库 URL 和分支生成内部 `repositoryId`，形式类似 `repo-...`；它不是 GitHub 的仓库数字 ID，也不需要人工猜测。

提交 MCP 任务时，`repositoryId` 必须使用该 Deployment 对应的内部仓库标识。请从执行配置 API/CLI 返回的 Deployment 数据中读取 `repositories[].id`，不要把仓库 URL 或 GitHub 仓库 ID 当成 `repositoryId`。如果 Admin 页面列表只展示 URL，可使用下面的 CLI 查看完整 Deployment 数据：

```bash
docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments
```

如果 CLI 提示缺少 `EXPERT_RUNTIME_DB`，请先检查 `docker-compose.expert.yml` 是否已应用并重建/启动 Hub；不要手动指向一个新的空数据库。

## 4. 在 Worker 主机配置 Git 仓库凭据

公开仓库不需要此步骤。私有仓库需要为 Worker 准备只读权限的 Git 凭据。

### 方案 A：SSH key

1. 在 Worker 主机放置专用只读私钥，例如 `/etc/expert/keys/yocto-readonly`。
2. 确认公钥已添加到 GitHub/GitLab 对应账号或 Deploy Key。
3. 限制文件权限：

```bash
sudo install -d -m 700 /etc/expert/keys
sudo chown root:root /etc/expert/keys/yocto-readonly
sudo chmod 600 /etc/expert/keys/yocto-readonly
```

4. 在 Worker 环境配置中设置引用映射：

```dotenv
EXPERT_GIT_CREDENTIALS_JSON='{"yocto-github-readonly":"/etc/expert/keys/yocto-readonly"}'
```

SSH key 路径必须是 Worker 主机上的绝对路径；仓库地址应使用 `git@github.com:org/repo.git` 形式。

### 方案 B：HTTPS Token

在 Worker 受保护的环境文件中设置 Token 环境变量，并将凭据引用映射到变量名。下面的值只是变量名示例，不是 Token：

```dotenv
YOCTO_GIT_TOKEN=在本机安全地设置实际Token
EXPERT_GIT_CREDENTIALS_JSON='{"yocto-github-readonly":{"type":"https-token","tokenEnv":"YOCTO_GIT_TOKEN"}}'
```

Deployment 的仓库 URL 必须使用 `https://`。Token 本身不要写进 JSON、Git URL 或本手册；`tokenEnv` 只能填写环境变量名。建议 Token 仅有目标仓库只读权限。

如果配置了 Git 代理，代理地址必须从 Worker 主机/Docker 所在网络可达；Windows 上的代理设置不会自动让 WSL2 或 Docker 使用该代理。

## 5. 注册、审批 Worker 并签发凭据

Worker 注册管理目前通过 CLI 操作。在运行 Hub 的主机上执行以下命令；命令由容器内环境读取 `EXPERT_WORKER_REGISTRY_DB`，确保已使用 `docker-compose.expert.yml` 启动运行时。

### 5.1 注册 Worker

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll yocto-worker-01 yocto
```

参数含义：`enroll <worker-id> <capabilities>`。Worker ID 应唯一且稳定；capability 必须与它实际能执行的任务一致。若一个 Worker 只服务 Yocto 专家，使用 `yocto` 即可。

### 5.2 审批 Worker

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve yocto-worker-01
```

### 5.3 签发 Worker credential

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential yocto-worker-01
```

命令会返回一次性显示的 credential。立即复制到 Worker 主机受保护的环境文件中，不要提交 Git、不要粘贴到聊天或终端工单。若遗失，应重新签发并更新 Worker 配置；旧 credential 会失效。

可以检查注册状态，但不要在共享日志中保留 credential：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll yocto-worker-01 yocto
```

如果 Worker 已存在，按实际返回错误处理，不要反复 enroll 同名 Worker。当前 Worker Admin CLI 没有独立的 list 子命令；请查看 Hub 注册数据库/现有运维查询方式，或使用已知 Worker ID 执行 approve、issue-credential 等有明确用途的操作，不要用重复注册来探测状态。

## 6. 准备 Worker 主机和 Docker 镜像

在 Worker 所在的 Linux/WSL2 主机准备项目代码与 Node.js 运行环境。Worker 可与 Hub 在同一台主机，也可运行在另一台主机；跨主机时必须使用 Worker 能访问的 Hub 地址，而不是 `127.0.0.1`。

在 Team Skill Hub 仓库根目录构建 Worker 镜像：

```bash
docker build -t team-skill-hub-expert-worker:prototype docker/expert-worker
docker run --rm team-skill-hub-expert-worker:prototype --version
```

Worker 运行进程通过 `npm run expert-worker` 启动；Docker 镜像用于执行任务的 Codex 环境，两者用途不同。

## 7. 创建 Worker 本地环境文件

在 Worker 主机 Linux 文件系统创建配置文件。不要把带密钥的文件放在 `/mnt/c`、`/mnt/d` 等 Windows 挂载盘后依赖 `chmod 600`；建议使用 `/etc/expert/`。

```bash
sudo install -d -m 700 /etc/expert
sudoedit /etc/expert/yocto-worker.env
sudo chown root:root /etc/expert/yocto-worker.env
sudo chmod 600 /etc/expert/yocto-worker.env
```

填写下面的模板并替换示例值。不要把此文件提交到 Git：

```dotenv
# Hub 的 gRPC 地址。同机运行时可用 127.0.0.1；跨主机时填写 Hub 主机名/IP 和可达端口。
EXPERT_HUB_ADDRESS=127.0.0.1:7443
EXPERT_WORKER_ID=yocto-worker-01
EXPERT_WORKER_CREDENTIAL=替换为刚签发的credential
EXPERT_CAPABILITY=yocto
EXPERT_ID=yocto

# 关键：此处是仓库父目录，不是多个 Worker 共用的 checkout。
# Worker 会自动在其下追加自己的 ID，并为每个仓库 ID 建立独立 clone。
EXPERT_REPOSITORY_ROOT=/srv/expert-repositories

EXPERT_DOCKER_IMAGE=team-skill-hub-expert-worker:prototype
EXPERT_DOCKER_NETWORK=bridge
EXPERT_DOCKER_SECCOMP_PROFILE=default

# 允许传入执行容器的环境变量名白名单，不是密钥值。
EXPERT_MODEL_ENV_NAMES=TEAM_SKILL_HUB_API_KEY,HTTPS_PROXY,NO_PROXY
# Expert 配置中的 credentialRef -> Worker 上真实存在的环境变量名。
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"TEAM_SKILL_HUB_API_KEY"}'

# 私有 Git 仓库需要时设置；公开仓库可不设置。
EXPERT_GIT_CREDENTIALS_JSON='{"yocto-github-readonly":"/etc/expert/keys/yocto-readonly"}'

EXPERT_HEARTBEAT_MS=10000
EXPERT_POLL_MS=3000
EXPERT_TASK_TIMEOUT_MS=120000

# 可选代理：必须是 Worker 主机能访问的代理。
HTTPS_PROXY=http://proxy-host:7890
NO_PROXY=127.0.0.1,localhost
TEAM_SKILL_HUB_API_KEY=在本机安全地设置实际APIKey
```

说明：

- `EXPERT_MODEL_CREDENTIAL_REFS_JSON` 只映射“凭据引用 → 环境变量名”，不能包含 API Key 明文。映射目标必须同时出现在 `EXPERT_MODEL_ENV_NAMES` 中。
- `TEAM_SKILL_HUB_API_KEY`、`HTTPS_PROXY` 等值在 Worker 进程环境中提供。使用 `source` 加载配置时，确保 JSON 字符串被正确引用；含特殊字符的密钥不要直接拼进 shell 命令。
- 如果不用 Git 私钥，把 `EXPERT_GIT_CREDENTIALS_JSON` 整行删掉即可。若使用 HTTPS Token，则按第 4 节的 JSON 格式配置，并确保 Token 环境变量在 Worker 进程中可用。
- 新建专家已在 Admin 的专家配置中填写 `modelConfig` 时，Worker 会按所选专家动态生成本次任务的 Codex 模型配置；通常不需要设置 `EXPERT_CODEX_CONFIG_FILE`。该变量用于未配置 `modelConfig` 的兼容旧路径。若你确实使用静态 TOML，可复制 `docs/expert-platform/codex-provider.example.toml`，并确保 `env_key` 指向 Worker 白名单中的环境变量；不要把密钥写进 TOML。
- `EXPERT_REPOSITORY_ROOT` 会自动追加 Worker ID，例如最终目录是 `/srv/expert-repositories/yocto-worker-01/`。不同 Worker 必须使用不同 ID，不要共享同一份 `.git` 或工作树。
- 若 Worker 位于另一台主机，Hub gRPC 默认的 `127.0.0.1:7443` 发布地址不可从远端访问。需通过 `EXPERT_GRPC_PUBLISH_BIND` 将端口绑定到受控的私有网卡地址，并配置仅允许该 Worker 主机访问的防火墙规则；不要为了省事将服务无条件暴露到公网。TLS 参数要么全部配置，要么全部省略；跨不可信网络建议启用 TLS/mTLS。

## 8. 启动 Worker

确保 `/etc/expert/yocto-worker.env` 的权限正确，并且环境变量已安全注入。交互式手动启动示例：

```bash
set -a
source /etc/expert/yocto-worker.env
set +a
npm run expert-worker
```

此终端应保持运行。生产环境建议用受控的 service/supervisor 管理进程，避免把密钥放进命令行参数或日志。当前 WSL2 示例环境使用独立 tmux 会话与启动脚本维护已有 Worker；新增 Worker 时先确认该脚本是否已显式纳入新 Worker，不要假设所有 Worker 会自动启动。

启动前可只检查变量是否存在，不要打印变量值：

```bash
test -n "${EXPERT_WORKER_CREDENTIAL:-}" && echo WORKER_CREDENTIAL_PRESENT || echo WORKER_CREDENTIAL_MISSING
test -n "${TEAM_SKILL_HUB_API_KEY:-}" && echo MODEL_KEY_PRESENT || echo MODEL_KEY_MISSING
test -d "${EXPERT_REPOSITORY_ROOT:-/nonexistent}" && echo REPOSITORY_ROOT_PRESENT || echo REPOSITORY_ROOT_WILL_BE_CREATED
docker run --rm "$EXPERT_DOCKER_IMAGE" --version
```

只有在当前 WSL2/Docker 环境确认 Codex 的 `bwrap` 沙箱无法启动，且理解其降低 seccomp 防护的影响后，才考虑将 `EXPERT_DOCKER_SECCOMP_PROFILE=unconfined`。优先使用默认 `default`。

## 9. 端到端验收：用 Codex CLI 发一个只读任务

先在已连接 Team Skill Hub MCP 的 Codex CLI 会话中调用 `get_server_info`，确认当前 principal；再通过 Admin 执行配置列表或 API 结果取得对应的 `repositories[].id`。不要猜测仓库 ID。

提交任务时使用实际生成的 `repositoryId`，并且先做只读分析：

```json
{
  "problem": "请只读分析这个仓库的目录结构、主要模块、构建方式和测试组织，并指出三个有具体源码依据的技术风险。每个结论必须引用真实文件路径和函数；不要修改文件、构建、运行测试、提交代码或创建 PR。",
  "idempotencyKey": "yocto-readonly-review-请替换为本次唯一值",
  "repositoryId": "替换为Deployment中repositories[].id的实际值"
}
```

调用 `submit_expert_task` 时**不要传 `expertId`**，用于验收自动路由。然后：

1. 记录返回的 `taskId`、`expertId`、`selectionMode` 和 `repositoryId`。
2. 轮询 `get_expert_task_status`，直到 `succeeded` 或 `failed`。
3. 只有任务 `succeeded` 后才调用 `get_expert_task_result`。
4. 检查结果是否引用真实文件路径、函数和行号，并确认分析使用了预期分支/Commit。
5. 检查仓库没有被修改。只读任务不应触发修复、提交或 PR。

### 通过标准

- [ ] Admin 中专家配置和执行配置均启用。
- [ ] Worker 已注册、审批并使用有效 credential 连接 Hub。
- [ ] Worker 领取了任务，任务状态经历 `queued → running → succeeded`。
- [ ] 未指定 `expertId` 时返回 `selectionMode=auto`，且自动选择的是预期专家。
- [ ] 返回的仓库标识与执行配置一致，结果引用真实源码。
- [ ] 仓库没有被修改。

若 `selectionMode=explicit`，说明调用时显式指定了专家，不能算自动路由验收成功。

## 10. 常见问题排查

### 页面报 `EXPERT_RUNTIME_DB_NOT_CONFIGURED`

检查 Hub 是否使用 `docker-compose.expert.yml`，以及容器内 `EXPERT_RUNTIME_DB` 是否指向预期数据库。不要通过新建空数据库绕过问题。

### 任务返回 `EXPERT_UNAVAILABLE`

依次检查：专家是否 active、Deployment 是否 active、`principals` 是否包含 `get_server_info` 返回的准确 `principal.id`、仓库是否绑定、Worker capability 是否匹配。

### `repositoryId` 不匹配

从 `list-deployments` 的返回数据中读取 `repositories[].id`。仓库 ID 根据 URL 与分支生成；改动 URL 或分支后应重新读取当前 Deployment 数据。

### Worker 返回 `WORKER_UNAUTHENTICATED`

重新签发 credential，并同步更新 Worker 的受保护环境文件。旧 credential 失效后应重启/重载对应 Worker 进程使新值生效；不要把 credential 写入日志。

### `SOURCE_REPOSITORY_CREDENTIAL_NOT_CONFIGURED`

检查 Deployment 中的 `credentialRef` 是否与 `EXPERT_GIT_CREDENTIALS_JSON` 的 key 完全一致、SSH key 文件是否存在，或 HTTPS Token 环境变量是否由 Worker 进程实际继承。不要打印 Token 来排查。

### Clone/fetch 失败或超时

从 Worker 主机检查 Git URL、分支、DNS、TLS/CA、代理连通性及凭据类型。SSH key 对应 SSH URL；HTTPS Token 对应 HTTPS URL。代理 URL 不能包含用户名、密码或 Token。

### `INVALID_WORKER_CONFIG`

检查必需变量 `EXPERT_HUB_ADDRESS`、`EXPERT_WORKER_ID`、`EXPERT_WORKER_CREDENTIAL`、`EXPERT_CAPABILITY`、`EXPERT_DOCKER_IMAGE`、`EXPERT_DOCKER_NETWORK`、`EXPERT_MODEL_ENV_NAMES`，并确认 JSON 环境变量语法有效。排障时打印变量名或脱敏状态，不要输出秘密值。

### `EXECUTION_FAILED`

检查 Worker 日志、Docker 镜像、Codex 配置文件、Responses API 兼容性、API Key 环境变量映射和网络代理。不要把失败任务直接标成验收通过；记录实际错误码并复测。

### Worker 能连接 Hub，但拿不到任务

确认 Worker 已审批、capability 与专家匹配、Deployment 启用、调用者 principal 有权限、目标仓库 ID 正确。不要通过放宽全部授权或关闭权限校验来解决。

## 11. CLI 备用操作

Admin 页面用于日常维护专家配置和执行配置。以下 CLI 主要用于 Worker 注册/审批/凭据操作，以及在需要时查询或兼容旧式 Deployment 数据。

```bash
# 查看执行配置

docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments

# CLI 创建基础专家定义（不包含 Admin 页面中的 modelConfig）
docker exec team-skill-hub node dist/src/cli/expert-admin.js define yocto "Yocto 构建专家" yocto,build,linux bitbake,recipe,layer,CVE

# Worker 注册、审批、签发凭据

docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll yocto-worker-01 yocto
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve yocto-worker-01
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential yocto-worker-01

# 吊销 Worker credential/注册状态

docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js revoke yocto-worker-01
```

CLI 的 `define` 命令只创建基础定义，不支持完整模型配置表单；建议在 Admin 页面创建/编辑专家模型设置。CLI 的 `deploy` 命令使用旧式 `repositoryIds` 参数，不支持 Admin 页面直接填写仓库 URL、分支、Git 凭据引用和代理的完整体验，因此新建执行配置应优先使用 Admin 页面。

## 12. 新增第二个 Worker 的注意事项

若为同一个专家增加并行 Worker：

- 给新 Worker 使用新的、唯一的 `EXPERT_WORKER_ID`，例如 `yocto-worker-02`。
- 单独执行 enroll、approve、issue-credential。
- 为它准备独立的环境文件与本地 clone 根目录；不要复制第一台 Worker 的 credential。
- 可使用同一个 capability，但每个 Worker 的 Git/模型凭据应按最小权限单独配置。
- 验证两个 Worker 的实际仓库路径分别位于 `.../yocto-worker-01/` 与 `.../yocto-worker-02/`，绝不能共享同一个 `.git` 目录。
- 若使用 WSL 启动脚本或 systemd/supervisor，必须显式配置新 Worker 的启动和日志管理。

## 13. 撤销与清理

不再使用 Worker 时，先确认没有任务正在运行，再执行：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js revoke yocto-worker-01
```

随后停止对应 Worker 进程，并按组织的密钥轮换流程删除主机上的旧 credential/Git Token。清理仓库 clone 前，必须确认任务已结束并且日志/证据已保留；只清理该 Worker 自己的目录，不要删除其他 Worker 的工作区。
