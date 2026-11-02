# 新增 Expert 与部署 Worker：管理员及部署使用手册

本文面向第一次部署专家平台的管理员和 Worker 主机运维人员。**部署者领取发布好的 Worker Runtime 安装包与执行镜像，而不是下载 Hub 源码自行构建。** 按顺序完成资源准备、安装、配置、注册审批和真实任务验收。示例命令按当前代码和安装脚本核对。

> **先理解两个概念：**
>
> - **专家配置（Expert Definition）**：定义“它是谁、擅长什么”，不再绑定模型。例如 `ota`、`code-review`。
> - **执行配置（Deployment）**：定义“谁可以调用这个专家、它能访问哪些仓库，以及 Backend/模型/MCP 策略”。一个专家可以绑定一个或多个仓库。
> - **Worker 执行配置**：Worker 主机上的本地环境文件，定义 Worker 身份、能力、Hub 地址、Docker、Git 凭据和模型凭据映射。它不是 Admin 页面中的 Deployment，也不应把密钥写入数据库或 Git。

日常使用优先通过 Admin 页面管理专家、执行配置以及 Worker 审批。CLI 仅作为维护或排障备用方式。

**希望使用 Claude Code 执行任务**的部署者请参阅 [Claude Worker 执行后端配置](./claude-executor.md)。本手册默认使用 Claude Code，Codex 需显式选择。

**发布管理员 / CI 维护人员**如需制作 Runtime tar.gz、Docker Image tar、SHA-256 校验清单，请使用独立的 [Worker 制品制作与交付手册](./release-worker-artifacts.md)；部署用户继续按照本文操作即可。

## 0. 开始之前：明确需要领取什么、准备什么

**需要使用 Claude Code 作为 Worker 执行后端时，另请参阅 [Claude / Codex 执行器部署手册](./claude-executor.md)。**

**部署者不需要 `team-skill-hub` 源码、npm 构建环境或 Dockerfile。** Worker 由两个相互独立的部分组成：

```text
Team Skill Hub（已有的 Hub 服务和 Admin 页面）
    └─ gRPC 私网地址:7443
         │  注册、心跳、领取任务、回传结果
         ▼
Worker 主机（Linux）
    ├─ Worker Runtime（systemd 常驻服务；读取 worker.env）
    ├─ Docker Engine（由 Worker 调用，不是 Worker 自己的镜像）
    ├─ 任务执行 Image（默认 Claude Code，可手动切换 Codex）
    └─ 专属 Git checkout、日志及必要凭据
```

### 0.1 向发布方领取的交付清单

| 交付物                               | 形式与当前示例文件名                                                       | 部署位置 / 用途                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Worker Runtime 包**                | `worker-runtime-0.1.0.tar.gz`                                              | 安装到 Worker 主机 `/opt/team-skill-hub-worker/`，作为 systemd 常驻服务运行 |
| **Claude Code 任务执行镜像（默认）** | `expert-claude-image-0.1.0.tar`                                            | `docker load` 导入 Worker 主机 Docker Engine，供每次任务创建执行容器        |
| **版本与完整性信息**                 | 发布方提供版本、目标 CPU 架构和 SHA-256 校验值                             | 确保 Runtime 与 Image 配套、文件在传输后未损坏                              |
| **接入参数**                         | Hub 私网 gRPC 地址、Bootstrap Token 的安全交付渠道、Worker ID / capability | 用于连接和自动注册；不要通过 Git、聊天记录传播密钥                          |
| **业务凭据（按需）**                 | 模型 API Key、私有 Git 仓库只读凭据、可信 CA / 代理配置                    | 由部署者在 Worker 主机安全配置，不包含在发行包内                            |

当前代码的示例版本是 **`0.1.0`**。上述两个 tar 文件在开发/发布环境可生成，但 `artifacts/` 被 Git 忽略，**不等于在 GitHub Releases、镜像仓库或任意 URL 已经公开发布**。实际领取地址、版本和 SHA-256 由团队发布方提供；不能通过直接 clone 仓库代替交付。

发布方应明确告知：镜像导入后的 tag（当前示例为 `team-skill-hub-expert-claude:0.1.0`）、CPU 架构、兼容的 Hub 版本、升级/回滚制品和密钥交付方式。部署者只需核对并安装制品。 **当前本地可核验的 `0.1.0` Docker 镜像为 `linux/amd64`；ARM64 主机不能直接使用这份镜像，需要发布方提供对应架构的镜像。**

### 0.2 Worker 主机资源与依赖

| 类别      | 基线与检查事项                                                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统      | 支持 Node.js 24 和 Docker Engine 的 Linux 主机；systemd **可选**。有 systemd 时使用 `team-skill-hub-worker@<instance>.service`，无 systemd 时使用 `worker-control.sh <instance> start`；CPU 架构需与交付镜像一致     |
| CPU / RAM | **起步容量建议**：专用主机至少 2 vCPU、4 GiB RAM；构建/大型仓库、多个 Worker instance 或多个并行执行容器需要增加资源。这不是系统强制最小值，实际以任务并发和镜像资源限制压测决定                                     |
| 磁盘      | **起步容量建议**：至少预留 10 GiB 空闲空间，另按 Git 仓库大小、Docker 镜像/层、执行日志与并发任务增加容量；不要把存储大小固定等同于示例包大小                                                                        |
| 软件      | Node.js **24.x**、Docker Engine（服务运行、可通过本机 Docker socket 访问）、`tar`、`git`；安装时需要 sudo/root 权限。安装器会解析一个 `expert-worker` 可执行的 Node.js 24 并固定到 `/opt/team-skill-hub-worker/node` |
| 网络      | Worker → Hub gRPC（示例 TCP 7443）；Worker → Git 仓库；**执行容器** → 所选模型 API / MCP；如需代理/DNS/CA，分别验证                                                                                                  |
| 安全      | 专用可信主机或隔离 VM；Docker `docker` 组权限近似 root；私网 ACL / 防火墙，跨不可信网络使用 TLS/mTLS                                                                                                                 |
| 数据目录  | `/opt/team-skill-hub-worker`（共享版本化 Runtime）、`/etc/team-skill-hub-worker`（instance 配置和私钥）、`/var/lib/team-skill-hub-worker`（instance credential、仓库 checkout、日志）                                |

**常见部署模式：** 一台 Worker 主机只安装一套共享 Runtime，但可以创建并同时运行多个独立 Worker instance。每个 instance 有独立的 `EXPERT_WORKER_ID`、credential、key 文件、日志和 Git checkout，例如同一台主机同时运行 `claude-01` 与 `codex-01`。任务执行容器仍由各 Worker instance 按任务拉起。**Hub 与 Worker 不必同机**，也不需要把 Hub 的 Docker Compose 或源码放到 Worker 主机。

在 Worker 主机提前检查环境：

```bash
uname -m
node --version            # 期望 v24.x
docker version            # Docker daemon 必须可用
command -v git tar sha256sum
command -v systemctl      # 可选：仅 systemd 主机需要
```

若 Hub 已部署但无法打开 Admin、专家 Runtime 数据库未初始化或 gRPC 端口未能从 Worker 主机访问，先由 **Hub 管理员**修复服务；Worker 主机部署者不负责构建或修复 Hub 源码。

以下示例使用 `yocto` 专家、`yocto-worker-01` Worker 和 `https://github.com/your-org/yocto-layer.git` 仓库。请将示例仓库、分支、模型、credential ref 和 principal 改为本地实际值。不要把 API Key、Worker credential 或 Git Token 粘贴到聊天、文档或命令历史中。

## 1. 打开专家管理页面

1. 登录 Team Skill Hub Admin。
2. 打开 **专家平台**，页面地址通常为 `/admin/experts`。
3. 页面分为 **专家配置** 和 **执行配置** 两部分。
4. 如果页面提示 `EXPERT_RUNTIME_DB_NOT_CONFIGURED`，说明 Hub 未配置专家运行时数据库；先修复 Hub 部署配置，不要尝试反复保存表单。

## 2. 创建专家配置

在“专家配置”区域选择创建专家，填写以下字段：

| 字段         | 示例                       | 填写原则                                                      |
| ------------ | -------------------------- | ------------------------------------------------------------- |
| 专家 ID      | `yocto`                    | 稳定、唯一，建议小写英文和连字符；创建后作为调用/路由标识使用 |
| 显示名称     | `Yocto 构建专家`           | 给管理员和用户看的名称                                        |
| Capabilities | `yocto,build,linux`        | 专家能处理的能力标签；多个值用逗号或换行分隔                  |
| Keywords     | `bitbake,recipe,layer,CVE` | 描述典型任务的关键词，帮助自动路由                            |
| 启用         | 勾选                       | 保存后专家配置应处于启用状态                                  |

**模型已迁至 Deployment。** 新建专家仅管理能力、关键词、启停；历史 Expert.modelConfig 暂为 V1 兼容数据。

## 3. 创建执行配置并配置仓库地址

在“执行配置”区域选择创建执行配置，将刚才创建的专家绑定到可访问仓库。

| 字段                    | 示例                                                     | 填写原则                                                                 |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| 执行配置 ID             | `yocto-default`                                          | 唯一、稳定的标识                                                         |
| 专家配置                | `yocto · Yocto 构建专家`                                 | 选择第 2 步创建的专家                                                    |
| 源码仓库地址            | `https://github.com/your-org/yocto-layer.git`            | 填完整 Git clone URL；不要在 URL 中嵌入用户名、Token 或密码              |
| 分支                    | `main`                                                   | 与仓库地址逐行对应；留空默认 `main`                                      |
| 仓库凭据引用            | `yocto-github-readonly`                                  | 私有仓库填写 Worker 侧配置的凭据引用；公开仓库可留空                     |
| Git 代理地址            | `http://proxy-host:7890`                                 | 可选；必须是 Worker 可访问的 HTTP/HTTPS 代理，URL 中不能包含认证信息     |
| 允许调用者 Principal ID | `实际的 principal.id`                                    | 每行一个；只授权确实需要使用此 Deployment 的调用者                       |
| Runtime Profile         | `linux-yocto`                                            | 描述所需运行环境的标签，例如 `linux-yocto`、`linux-ota`                  |
| 启用执行配置            | 勾选                                                     | 只有启用的 Deployment 才能参与任务派发                                   |
| Backend / Model         | `codex` + Responses 或 `claude` + Anthropic Messages     | 每个 Deployment 单独配置 Backend、Provider、Model、Base URL 和环境变量名 |
| 模型 Credential Ref     | `model-readonly`                                         | Worker 本地模型凭据映射，不存 Key 明文                                   |
| MCP Profile             | `default`                                                | Admin 全局 Profile，可由 Deployment 引用/覆盖                            |
| MCP URL                 | `http://hub.internal:8080/mcp`                           | 必须从任务容器网络可达；不能用 127.0.0.1 指向外部 Hub                    |
| MCP Credential Ref      | `skillhub-readonly`                                      | 独立只读 API Key 的本地文件映射                                          |
| MCP Allowed Tools       | `search_skills,get_skill,search_knowledge,get_knowledge` | 只读工具白名单；禁止管理、发布、派发                                     |
| MCP Required            | 按需                                                     | Key/URL 不可用时是否直接失败                                             |

可以为一个 Deployment 填多组仓库：仓库 URL、分支、凭据引用、代理地址分别按行对应。不要在凭据引用或代理地址字段里填密钥。

点击“保存执行配置”后，确认列表中的专家、仓库 URL、分支、调用者、Runtime Profile 和启用状态正确。

### 仓库 ID 是什么？

仓库地址由 Admin 页面配置，Worker 会在执行任务时自行 clone/fetch。Hub 会根据仓库 URL 和分支生成内部 `repositoryId`，形式类似 `repo-...`；它不是 GitHub 的仓库数字 ID，也不需要人工猜测。

提交 MCP 任务时，`repositoryId` 必须使用该 Deployment 对应的内部仓库标识。请从执行配置 API/CLI 返回的 Deployment 数据中读取 `repositories[].id`，不要把仓库 URL 或 GitHub 仓库 ID 当成 `repositoryId`。如果 Admin 页面列表只展示 URL，可使用下面的 CLI 查看完整 Deployment 数据：

```bash
docker exec team-skill-hub node dist/src/cli/expert-admin.js list-deployments
```

如果 CLI 提示缺少 `EXPERT_RUNTIME_DB`，请先检查 `docker-compose.expert.yml` 是否已应用并重建/启动 Hub；不要手动指向一个新的空数据库。

### V2 Worker 只读 MCP 安装与测试

1. 在 Admin 的 API Key 页面创建专属身份，roles **仅** `worker-mcp-readonly`，不要复用 Admin Key。Hub 服务端仅注册只读 Skill/Knowledge 工具。
2. 安全保存密钥于 Worker 本地受权限保护的文件（`0600`、Worker 可读取），如 `/etc/team-skill-hub-worker/keys/skillhub-readonly`；不要写入 Git、Hub 数据库、任务日志。
3. 在 `worker.env` 设置 `EXPERT_MCP_CREDENTIAL_FILES_JSON='{"skillhub-readonly":"/etc/team-skill-hub-worker/keys/skillhub-readonly"}'`、`EXPERT_MCP_URL=http://hub.internal:8080/mcp`、`EXPERT_RUNTIME_PROFILES=linux-yocto`，并选择匹配 Docker 镜像的 `EXPERT_EXECUTOR_BACKEND`。
4. 执行配置选择 Admin 全局 MCP Profile（默认 `default`）或按 Deployment 覆盖。覆盖不允许扩大 Profile 的只读工具权限。Worker 会在每个任务中生成隔离的 Claude/Codex MCP 配置，而不挂载个人配置或运行开发者 Hook。
5. 发布前从**实际任务容器**测试 Hub DNS/网络、TLS/代理、MCP `tools/list`、Skill/Knowledge 检索，并验证提交/发布/专家再次派发工具不可用；同时测试无 Key、撤销 Key、协议不匹配、旧 Worker 不领取 V2 等负路径。

> 现有版本化 Worker Runtime 是独立发布包，无须 Hub 源码。任务容器不复用开发者完整 Setup，而是由 Worker Runtime 按 Deployment 动态生成最小只读 Claude/Codex MCP 配置。Claude 与 Codex 两种 Backend 的真实 MCP 端到端链路均已验收通过；自动升级/版本分发仍应由发布流程单独管理。

## 4. 在 Worker 主机配置 Git 仓库凭据

公开仓库不需要此步骤。私有仓库需要为 Worker 准备只读权限的 Git 凭据。

### 方案 A：SSH key

1. 在 Worker 主机放置专用只读私钥，例如 `/etc/team-skill-hub-worker/keys/yocto-readonly`。
2. 确认公钥已添加到 GitHub/GitLab 对应账号或 Deploy Key。
3. 首次放置私钥时先仅允许 root 访问。若 Worker 尚未安装，先使用以下命令安全保存密钥：

```bash
sudo install -d -o root -g root -m 700 /etc/team-skill-hub-worker/keys
sudo chown root:root /etc/team-skill-hub-worker/keys/yocto-readonly
sudo chmod 600 /etc/team-skill-hub-worker/keys/yocto-readonly
```

4. 安装 Worker 后，Worker 服务以 `expert-worker` 用户和组运行。要让它读取私钥，同时保持 root 管理权，在第 8 节安装完成后执行该节提供的授权命令。不要把私钥设置为全局可读。

5. 在 Worker 环境配置中设置引用映射：

```dotenv
EXPERT_GIT_CREDENTIALS_JSON='{"yocto-github-readonly":"/etc/team-skill-hub-worker/keys/yocto-readonly"}'
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

## 5. Worker 自动注册、审批与凭据

推荐使用 Bootstrap Token 自动注册。首次启动时 Worker 会向 Hub 注册；默认状态为 `pending`，管理员在 Admin 网页批准后，Worker 自动取得正式 credential 并保存到本机凭据文件。Worker 会先在本机受保护目录生成待交换凭据，再通过配置的 gRPC 连接将凭据提交给 Hub；Hub 只保存凭据的哈希。若交换请求因网络中断未收到响应，Worker 会使用同一个待交换凭据重试，不会因响应丢失而卡死。后续重启不需要再手工复制 `ewc_...`。

### 5.1 配置 Hub 的 Bootstrap Token

在 Hub 部署环境（例如项目根目录受保护的 `.env`）设置一个随机、高熵的部署级 Token：

可在受信任的管理终端生成随机值（不要把生成结果贴到聊天或提交到 Git）：

```bash
openssl rand -hex 32
```

```dotenv
EXPERT_WORKER_BOOTSTRAP_TOKEN=替换为随机生成的长随机字符串
EXPERT_WORKER_BOOTSTRAP_AUTO_APPROVE=false
EXPERT_WORKER_BOOTSTRAP_ALLOWED_CAPABILITIES=ota,yocto
```

`EXPERT_WORKER_BOOTSTRAP_AUTO_APPROVE` 默认必须为 `false`，新 Worker 需要在网页审批。只有在可信的内网部署中，明确设置为 `true` 时才自动激活；自动激活必须同时配置 `EXPERT_WORKER_BOOTSTRAP_ALLOWED_CAPABILITIES`，并且 Worker 申请的所有 capability 都在白名单内。Bootstrap Token 是部署级秘密，不要提交 Git 或写入日志；建议使用 TLS/mTLS 保护跨主机 gRPC 连接。

配置后按项目正常流程重建/启动 Hub，使 gRPC 服务读取这些环境变量。不要在已有生产服务上未经安排直接重启。

### 5.2 Worker 主机配置

Worker Runtime 是宿主机级安装；实际可运行配置必须按 instance 存放：

```text
/etc/team-skill-hub-worker/workers/<instance>.env
```

例如先创建一个 Yocto/Claude Worker：

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh init yocto-claude-01
sudoedit /etc/team-skill-hub-worker/workers/yocto-claude-01.env
sudo chmod 600 /etc/team-skill-hub-worker/workers/yocto-claude-01.env
```

填写：

```dotenv
EXPERT_HUB_ADDRESS=hub.internal.example:7443
EXPERT_WORKER_ID=yocto-worker-01
EXPERT_CAPABILITY=yocto
EXPERT_WORKER_BOOTSTRAP_TOKEN=与 Hub 配置相同的部署级 Token
EXPERT_EXECUTOR_BACKEND=claude
EXPERT_RUNTIME_PROFILES=claude-readonly
```

`EXPERT_WORKER_INSTANCE` 由 controller/systemd 自动注入，不要在 env 中手工配置。默认 credential、source、repositories 路径分别位于：

```text
/var/lib/team-skill-hub-worker/<instance>/worker-credential
/var/lib/team-skill-hub-worker/<instance>/source
/var/lib/team-skill-hub-worker/<instance>/repositories
```

Bootstrap Token 只用于首次登记/审批后的凭据交换。正式 credential 保存后，从该实例 env 中删除 `EXPERT_WORKER_BOOTSTRAP_TOKEN`。

### 5.3 网页审批和状态管理

1. 打开 `/admin/experts`，切换到 **Worker 管理**。
2. Worker 首次启动后会自动出现在列表中，状态为 `pending`。
3. 核对 Worker ID 和 capabilities 后点击“批准”。
4. Worker 自动交换并保存正式 credential，随后开始正常心跳和领取任务。
5. 不再使用某个 Worker 时，确认没有任务正在运行，再点击“吊销”。

### 5.4 备用方式：手动 CLI

Bootstrap 不适用或需要运维排障时，可在 Hub 主机使用：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll yocto-worker-01 yocto
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve yocto-worker-01
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential yocto-worker-01
```

CLI 签发的凭据可安全写入对应 instance 的 credential 文件。不要在多个 Worker ID 之间共用 credential。

## 6. 领取并校验运行包 / 执行镜像（不构建）

由团队发布方将 **同一批次的 Runtime 与执行镜像** 安全传到 Worker 主机，例如：

```bash
cd /tmp/team-skill-hub-worker-release
sha256sum worker-runtime-0.1.0.tar.gz expert-claude-image-0.1.0.tar
```

Worker 主机只需要制品，不需要 Hub 源码。

## 7. 在 Worker 主机安装共享 Runtime

### 7.1 安装一次 Runtime

```bash
cd /tmp/team-skill-hub-worker-release
mkdir -p /tmp/team-skill-hub-worker-bootstrap
tar -xzf worker-runtime-0.1.0.tar.gz -C /tmp/team-skill-hub-worker-bootstrap
sudo /tmp/team-skill-hub-worker-bootstrap/install-worker.sh \
  /tmp/team-skill-hub-worker-release/worker-runtime-0.1.0.tar.gz
```

安装完成后核心布局为：

```text
/opt/team-skill-hub-worker/current/
/etc/team-skill-hub-worker/worker.env.example
/etc/team-skill-hub-worker/workers/
/etc/team-skill-hub-worker/instances/
/var/lib/team-skill-hub-worker/
/etc/systemd/system/team-skill-hub-worker@.service   # systemd 主机
```

安装器不会自动创建或启动 Worker instance。旧 `/etc/team-skill-hub-worker/worker.env` 不再被读取；若旧固定 `team-skill-hub-worker.service` 仍 active/enabled，安装器会直接停止并要求先 `systemctl disable --now team-skill-hub-worker.service`，避免旧配置继续运行。安装器还会解析一个 `expert-worker` 可执行的 Node.js 24，并固定为 `/opt/team-skill-hub-worker/node`。

### 7.2 导入执行镜像

```bash
sudo docker load -i expert-claude-image-0.1.0.tar
sudo docker image inspect team-skill-hub-expert-claude:0.1.0 \
  --format '{{.RepoTags}} {{.Os}}/{{.Architecture}}'
```

### 7.3 创建一个或多个 Worker instance

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh init claude-01
sudo /opt/team-skill-hub-worker/current/worker-control.sh init codex-01
sudo /opt/team-skill-hub-worker/current/worker-control.sh list
```

配置文件分别是：

```text
/etc/team-skill-hub-worker/workers/claude-01.env
/etc/team-skill-hub-worker/workers/codex-01.env
```

密钥文件放在各自：

```text
/etc/team-skill-hub-worker/instances/<instance>/keys/
```

不要让不同 instance 指向同一个 repository checkout。

默认情况下，位于 `/var/lib/team-skill-hub-worker` 下的显式 credential/source/repository 路径必须属于当前 instance。迁移旧部署时如必须短期引用旧全局路径，可显式设置 `EXPERT_ALLOW_MANAGED_PATH_OVERRIDES=true`；迁移完成后应删除该开关。

## 8. 配置、启动和日常管理

### 8.1 配置实例

示例：

```dotenv
EXPERT_HUB_ADDRESS=hub.internal.example:7443
EXPERT_WORKER_ID=yocto-worker-01
EXPERT_CAPABILITY=yocto
EXPERT_ID=yocto
EXPERT_WORKER_BOOTSTRAP_TOKEN=与Hub部署方安全交付的Token
EXPERT_EXECUTOR_BACKEND=claude
EXPERT_RUNTIME_PROFILES=claude-readonly
EXPERT_DOCKER_IMAGE=team-skill-hub-expert-claude:0.1.0
EXPERT_CLAUDE_MAX_TURNS=12
EXPERT_DOCKER_NETWORK=bridge
EXPERT_DOCKER_SECCOMP_PROFILE=default
EXPERT_MODEL_ENV_NAMES=ANTHROPIC_AUTH_TOKEN,HTTPS_PROXY,NO_PROXY
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"ANTHROPIC_AUTH_TOKEN"}'
ANTHROPIC_AUTH_TOKEN=通过安全方式配置真实模型密钥

# MCP API Key 不直接写入 env。这里仅配置 credentialRef -> key 文件路径：
EXPERT_MCP_URL=http://team-skill-hub:8080/mcp
EXPERT_MCP_CREDENTIAL_FILES_JSON='{"skillhub-readonly":"/etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly"}'

# 可选 Git credential：
# EXPERT_GIT_CREDENTIALS_JSON='{"git-readonly":"/etc/team-skill-hub-worker/instances/claude-01/keys/git-readonly"}'
```

默认 credential/source/repositories 会自动使用 instance-local 路径，通常无需显式填写。

Claude Worker 可通过 `EXPERT_CLAUDE_MAX_TURNS` 控制单个任务允许的 Claude CLI 最大回合数，对应 CLI 参数 `--max-turns`。默认值为 `12`，合法范围为 `1`～`1000`；非法值会在 Worker 配置加载阶段被拒绝。它只影响 Claude 后端，与任务整体超时 `EXPERT_TASK_TIMEOUT_MS` 相互独立。修改后需重启对应 Worker instance 才会生效。

#### 8.1.1 配置 MCP API Key

假设 Admin 中执行配置的 MCP credentialRef 为：

```text
skillhub-readonly
```

则 `claude-01` 的 env 中配置：

```dotenv
EXPERT_MCP_URL=http://team-skill-hub:8080/mcp
EXPERT_MCP_CREDENTIAL_FILES_JSON='{"skillhub-readonly":"/etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly"}'
```

真正的 API Key 写入 instance 私有文件，不放到 env：

```bash
sudo install -d -o root -g expert-worker -m 0750 \
  /etc/team-skill-hub-worker/instances/claude-01/keys

printf '%s\n' '实际的 Skill Hub API Key' | \
  sudo tee /etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly >/dev/null

sudo chown expert-worker:expert-worker \
  /etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly
sudo chmod 600 \
  /etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly
```

映射关系是：

```text
Deployment.mcp.credentialRef = skillhub-readonly
            ↓
EXPERT_MCP_CREDENTIAL_FILES_JSON
            ↓
/etc/team-skill-hub-worker/instances/claude-01/keys/skillhub-readonly
            ↓
实际 MCP API Key
```

如果创建的是 `codex-01`，路径也必须替换成 `/instances/codex-01/keys/...`。不同 Worker instance 不应共用同一个 key 文件路径。

### 8.2 systemd 主机

```bash
sudo systemctl enable --now team-skill-hub-worker@claude-01
sudo systemctl status team-skill-hub-worker@claude-01 --no-pager
sudo journalctl -u team-skill-hub-worker@claude-01 -n 80 --no-pager
```

多个 instance 可独立启停。

### 8.3 无 systemd 主机

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 start
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 status
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 logs
sudo /opt/team-skill-hub-worker/current/worker-control.sh claude-01 stop
```

查看整机 Worker：

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh list
sudo /opt/team-skill-hub-worker/current/worker-control.sh list --json
```

一个坏配置只会显示为 `invalid-config`，不会阻塞其他 Worker inventory。列表绝不显示 token、credential 或 key 内容。

### 8.4 首次批准后

在 Hub 的 `/admin/experts` → **Worker 管理**批准 Worker 后，确认对应实例：

```text
/var/lib/team-skill-hub-worker/<instance>/worker-credential
```

已生成，然后从该实例 env 移除 Bootstrap Token。

日常检查示例：

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh list
sudo systemctl status team-skill-hub-worker@claude-01 --no-pager
sudo journalctl -u team-skill-hub-worker@claude-01 -f
```

升级需要发布方提供**新版本 Runtime 包与配套 Image**，由管理员安排任务排空/维护窗口后重复第 6～7 节；先导入新镜像，确认环境中的 `EXPERT_DOCKER_IMAGE` 指向新 tag，再重启 Worker 服务并完成一条只读任务验收。安装器使用 `/opt/team-skill-hub-worker/releases/<version>/` 与 `current` 软链接，便于保留旧 Runtime 作为回滚候选，但**切换旧版本前需一并恢复与其兼容的镜像 tag、配置和所需数据库/协议兼容性**，不能只改软链接就认定完成回滚。

完成注册后，在 Admin → **专家平台** → **任务运行记录** 中可查看任务状态、Run、Worker 及执行阶段（需要最新 Worker Runtime 上报）。详细说明参见 [任务运行观测手册](./task-observability.md)。

## 9. 端到端验收：用 Claude CLI 或 Codex CLI 发一个只读任务

先在已连接 Team Skill Hub MCP 的 Claude CLI 或 Codex CLI 会话中调用 `get_server_info`，确认当前 principal；再通过 Admin 执行配置列表或 API 结果取得对应的 `repositories[].id`。不要猜测仓库 ID。

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

### Worker 被强制退出后的 Docker 容器回收

每个真实任务的 Docker 执行容器带有 `team-skill-hub.expert-managed`、`team-skill-hub.task-id`、`team-skill-hub.run-id` 和 `team-skill-hub.fencing` 标签。当旧 Worker 意外退出而无法运行进程退出清理时，**同一 Docker daemon 上**重新领取该任务的 Worker 会在启动新执行容器前，检查同任务、且 fencing 小于当前值的受管容器，并强制回收。当前或更高 fencing 的容器以及其他任务容器不会被删除。Docker 列表失败会拒绝启动新执行，避免在容器状态未知时重复执行。

**限制**：此清理发生在任务被重新领取后，不是崩溃瞬间；并且只能回收当前 Worker 可以访问的 Docker daemon 上的容器。如果跨不同主机接管，旧主机上的孤儿容器无法由新主机直接删除，需要旧主机启动时的本地巡检或独立宿主机清理服务。不要在不同主机间共享 Docker socket。

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

# CLI 创建基础专家定义（Expert 本身不包含执行模型配置）
docker exec team-skill-hub node dist/src/cli/expert-admin.js define yocto "Yocto 构建专家" yocto,build,linux bitbake,recipe,layer,CVE

# Worker 注册、审批、签发凭据

docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll yocto-worker-01 yocto
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve yocto-worker-01
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential yocto-worker-01

# 吊销 Worker credential/注册状态

docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js revoke yocto-worker-01
```

CLI 的 `define` 命令只创建 Expert Definition；模型、Backend、MCP 策略均属于 Deployment，应在 Admin → **执行配置** 中维护。CLI 的 `deploy` 命令仍偏向旧式 `repositoryIds` 参数，不覆盖 Admin 页面直接填写仓库 URL、分支、Git 凭据引用、代理、Executor/Model 和 MCP 策略的完整体验，因此新建执行配置应优先使用 Admin 页面。

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
