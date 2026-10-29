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

| 类别      | 基线与检查事项                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 系统      | 支持目标 Node.js 和 Docker Engine 的 Linux 主机；当前安装方式依赖 **systemd**；x86_64 或 ARM64 需与交付镜像架构一致                                                      |
| CPU / RAM | **起步容量建议**：专用主机至少 2 vCPU、4 GiB RAM；构建/大型仓库或多个并行执行容器需要增加资源。这不是系统强制最小值，实际以任务并发和镜像资源限制压测决定                |
| 磁盘      | **起步容量建议**：至少预留 10 GiB 空闲空间，另按 Git 仓库大小、Docker 镜像/层、执行日志与并发任务增加容量；不要把存储大小固定等同于示例包大小                            |
| 软件      | Node.js **24.x**（systemd 单元当前固定使用 `/usr/bin/node`）、Docker Engine（服务运行、可通过本机 Docker socket 访问）、`tar`、`git`、systemd；安装时需要 sudo/root 权限 |
| 网络      | Worker → Hub gRPC（示例 TCP 7443）；Worker → Git 仓库；**执行容器** → 所选模型 API；如需代理/DNS/CA，三条路径分别验证                                                    |
| 安全      | 专用可信主机或隔离 VM；Docker `docker` 组权限近似 root；私网 ACL / 防火墙，跨不可信网络使用 TLS/mTLS                                                                     |
| 数据目录  | `/opt/team-skill-hub-worker`（版本化 Runtime）、`/etc/team-skill-hub-worker`（配置和私钥）、`/var/lib/team-skill-hub-worker`（credential、仓库 checkout）                |

**常见部署模式：** 一台 Worker 主机安装一个 Runtime 服务，并可由它派生多个任务执行容器（最终并发由 Hub 租约调度、Worker 能力和主机资源决定）；扩容时为另一台主机或另一套独立部署配置新的 Worker ID，不共享同一 Git checkout。**Hub 与 Worker 不必同机**，也不需要把 Hub 的整个 Docker Compose 或源码放到 Worker 主机。

在 Worker 主机提前检查环境：

```bash
uname -m
node --version            # 期望 v24.x
/usr/bin/node --version   # 供 systemd 使用，必须同为 v24.x
docker version            # Docker daemon 必须可用
systemctl --version       # 需要 systemd
command -v git tar sha256sum
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

| 字段              | 示例                                          | 填写原则                                                         |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| 专家 ID           | `yocto`                                       | 稳定、唯一，建议小写英文和连字符；创建后作为调用/路由标识使用    |
| 显示名称          | `Yocto 构建专家`                              | 给管理员和用户看的名称                                           |
| Capabilities      | `yocto,build,linux`                           | 专家能处理的能力标签；多个值用逗号或换行分隔                     |
| Keywords          | `bitbake,recipe,layer,CVE`                    | 描述典型任务的关键词，帮助自动路由                               |
| 启用              | 勾选                                          | 保存后专家配置应处于启用状态                                     |

**模型已迁至 Deployment。** 新建专家仅管理能力、关键词、启停；历史 Expert.modelConfig 暂为 V1 兼容数据。

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
| Backend / Model         | `codex` + Responses 或 `claude` + Anthropic Messages | 每个 Deployment 单独配置 Backend、Provider、Model、Base URL 和环境变量名 |
| 模型 Credential Ref     | `model-readonly`                              | Worker 本地模型凭据映射，不存 Key 明文 |
| MCP Profile            | `default`                                     | Admin 全局 Profile，可由 Deployment 引用/覆盖 |
| MCP URL                | `http://hub.internal:8080/mcp`                | 必须从任务容器网络可达；不能用 127.0.0.1 指向外部 Hub |
| MCP Credential Ref     | `skillhub-readonly`                           | 独立只读 API Key 的本地文件映射 |
| MCP Allowed Tools      | `search_skills,get_skill,search_knowledge,get_knowledge` | 只读工具白名单；禁止管理、发布、派发 |
| MCP Required           | 按需                                        | Key/URL 不可用时是否直接失败 |

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

在 `/etc/team-skill-hub-worker/worker.env` 设置：

```dotenv
EXPERT_HUB_ADDRESS=hub.internal.example:7443
EXPERT_WORKER_ID=yocto-worker-01
EXPERT_CAPABILITY=yocto
EXPERT_WORKER_BOOTSTRAP_TOKEN=与 Hub 配置相同的部署级 Token
EXPERT_WORKER_CREDENTIAL_FILE=/var/lib/team-skill-hub-worker/worker-credential
```

保留该文件为 root 所有、权限 `600`。Bootstrap Token 只用于首次登记/审批后的凭据交换；Worker 成功保存正式 credential 后，会从当前进程环境中清除该 Token，并优先使用凭据文件。确认凭据文件已生成后，建议从 `worker.env` 删除 `EXPERT_WORKER_BOOTSTRAP_TOKEN`，以免长期保留引导凭据；之后重启会直接复用凭据文件。凭据文件默认由 `expert-worker` 用户持有、权限 `600`。不要把正式 credential 写入 Git、工单或日志。

### 5.3 网页审批和状态管理

1. 打开 `/admin/experts`，切换到 **Worker 管理**。
2. Worker 首次启动后会自动出现在列表中，状态为 `pending`。
3. 核对 Worker ID 和 capabilities 后点击“批准”。
4. Worker 会自动轮询注册接口，在激活后交换并保存正式 credential，随后开始正常心跳和领取任务；管理员不需要手工复制 credential。
5. 不再使用某个 Worker 时，确认没有任务正在运行，再点击“吊销”。

### 5.4 备用方式：手动 CLI

Bootstrap 不适用或需要运维排障时，仍可使用 CLI 手动注册、审批和签发凭据。在 Hub 主机执行：

```bash
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js enroll yocto-worker-01 yocto
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js approve yocto-worker-01
docker exec team-skill-hub node dist/src/cli/expert-worker-admin.js issue-credential yocto-worker-01
```

CLI 签发的凭据可通过 `EXPERT_WORKER_CREDENTIAL` 提供给 Worker，或按运维流程安全写入 `EXPERT_WORKER_CREDENTIAL_FILE`。若正式 credential 丢失且 Hub 已保存其 hash，需由管理员重新签发并更新 Worker 本地凭据文件；Bootstrap 不会覆盖已有的有效凭据。

## 6. 领取并校验运行包 / 执行镜像（不构建）

由团队发布方将 **同一批次的两个制品** 安全传到 Worker 主机，例如 `/tmp/team-skill-hub-worker-release/`。以下用版本 `0.1.0` 演示；升级时应使用发布方提供的实际版本，**不要把示例版本当作永远固定的最新版**。

```bash
cd /tmp/team-skill-hub-worker-release
ls -lh worker-runtime-0.1.0.tar.gz expert-claude-image-0.1.0.tar
sha256sum worker-runtime-0.1.0.tar.gz expert-claude-image-0.1.0.tar
# 人工与发布方通过受信任渠道交付的 SHA-256 清单逐一比对，不匹配即停止
```

该发行包的职责必须区分：

- `worker-runtime-0.1.0.tar.gz` **不是容器镜像**：它安装成 Worker 主机的 systemd 服务，负责连接 Hub、注册、领任务、管理工作区和启动 Docker 容器。
- `expert-claude-image-0.1.0.tar` **不是 Worker daemon**：这是每个专家任务默认使用的 Claude Code 执行镜像，导入 Docker 后由 Runtime 按需调用。

如果发布方改为提供私有镜像仓库地址而非 `.tar`，应同时给出可验证的镜像 digest、架构和拉取凭据。当前下面的安装步骤按**离线 tar 制品**展开；不要求 Worker 主机运行任何 `docker build` 或 `npm run build`。

## 7. 在 Worker 主机安装（最短可执行流程）

### 7.1 安装 Worker Runtime

在**已安装 Node.js 24、Docker Engine 的 Linux Worker 主机**执行（systemd 可选）。安装器会创建 `expert-worker` 系统用户、版本化安装目录，并仅在 systemd 运行时注册服务单元，首次生成 `worker.env` 配置模板。

```bash
cd /tmp/team-skill-hub-worker-release
mkdir -p /tmp/team-skill-hub-worker-bootstrap
tar -xzf worker-runtime-0.1.0.tar.gz -C /tmp/team-skill-hub-worker-bootstrap
sudo /tmp/team-skill-hub-worker-bootstrap/install-worker.sh   /tmp/team-skill-hub-worker-release/worker-runtime-0.1.0.tar.gz
```

安装完成后应有：

```text
/opt/team-skill-hub-worker/current/         # 指向当前版本运行包
/etc/team-skill-hub-worker/worker.env       # 私有配置文件，root:root，0600
/etc/team-skill-hub-worker/keys/           # 可选的 Git SSH 私钥目录
/var/lib/team-skill-hub-worker/            # Worker credential、私有仓库副本
/etc/systemd/system/team-skill-hub-worker.service
```

> 仅安装 Runtime **不会**自动为你配置 Hub 地址或模型密钥；在完成第 8 节前不要启动服务。

### 7.2 导入配套的 Docker 执行镜像

```bash
cd /tmp/team-skill-hub-worker-release
sudo docker load -i expert-claude-image-0.1.0.tar
sudo docker image inspect team-skill-hub-expert-claude:0.1.0   --format '{{.RepoTags}} {{.Os}}/{{.Architecture}}'
```

**校验的 tag 必须与后面 `EXPERT_DOCKER_IMAGE` 完全一致**，架构需与目标机器兼容；检查失败则联系发布方重新获取正确制品，部署者不需要自己构建镜像。

### 7.3 没有 systemd 的主机

`install-worker.sh` 不要求 systemd。检测到运行中的 systemd 时，它会注册 `team-skill-hub-worker.service`；没有 systemd（例如部分容器/WSL）则跳过服务注册，保留完整安装。

配置完成后，如果主机**没有运行 systemd**，使用安装包自带的脚本手动管理：

```bash
sudo /opt/team-skill-hub-worker/current/worker-control.sh start
sudo /opt/team-skill-hub-worker/current/worker-control.sh status
sudo /opt/team-skill-hub-worker/current/worker-control.sh logs
sudo /opt/team-skill-hub-worker/current/worker-control.sh stop
sudo /opt/team-skill-hub-worker/current/worker-control.sh restart
```

手动运行以 `expert-worker` 身份启动，不需要复制 Hub 源码；日志保存在 `/var/lib/team-skill-hub-worker/worker.log`。**无 systemd 时不会自动重启崩溃进程，也不会自动开机启动**，长期部署可结合外部进程管理器。不要同时用 systemd 和手动脚本启动同一 Worker。第 8 节中 `systemctl` / `journalctl` 命令仅适用于 systemd 主机。

## 8. 配置 Worker、自动注册和启动

### 8.1 编辑受保护环境文件

```bash
sudoedit /etc/team-skill-hub-worker/worker.env
sudo chown root:root /etc/team-skill-hub-worker/worker.env
sudo chmod 600 /etc/team-skill-hub-worker/worker.env
```

按发布方提供的 Hub 接入信息和 Admin 专家配置填写。**下面是示例，不是可以不修改就直接运行的配置**：

```dotenv
# Hub 的私网 gRPC 地址；跨主机不要写 127.0.0.1
EXPERT_HUB_ADDRESS=hub.internal.example:7443
EXPERT_WORKER_ID=yocto-worker-01
EXPERT_CAPABILITY=yocto
EXPERT_ID=yocto
EXPERT_WORKER_BOOTSTRAP_TOKEN=与Hub部署方安全交付的Token
EXPERT_WORKER_CREDENTIAL_FILE=/var/lib/team-skill-hub-worker/worker-credential

# Runtime 自动为每个 Worker ID 创建隔离的 Git checkout 目录
EXPERT_SOURCE_PATH=/var/lib/team-skill-hub-worker/source
EXPERT_REPOSITORY_ROOT=/var/lib/team-skill-hub-worker/repositories

# 每个 Worker 只声明一个执行后端；模型由 Deployment 决定
EXPERT_EXECUTOR_BACKEND=claude
EXPERT_RUNTIME_PROFILES=claude-readonly
EXPERT_DOCKER_IMAGE=team-skill-hub-expert-claude:0.1.0
EXPERT_DOCKER_NETWORK=bridge
EXPERT_DOCKER_SECCOMP_PROFILE=default

# 对应 Admin 执行配置 executor.modelConfig.credentialRef
EXPERT_MODEL_ENV_NAMES=ANTHROPIC_AUTH_TOKEN,HTTPS_PROXY,NO_PROXY
EXPERT_MODEL_CREDENTIAL_REFS_JSON='{"bst-router":"ANTHROPIC_AUTH_TOKEN"}'
ANTHROPIC_AUTH_TOKEN=在Worker主机通过安全方式配置真实模型密钥

# 私有 Git 仓库才需要以下映射（公开仓库可不填）
# EXPERT_GIT_CREDENTIALS_JSON='{"git-readonly":"/etc/team-skill-hub-worker/keys/git-readonly"}'
# HTTPS_PROXY=http://proxy.internal:7890
# NO_PROXY=127.0.0.1,localhost
```

配置时确认：

- `EXPERT_WORKER_ID` 在 Hub 注册表内唯一；`EXPERT_CAPABILITY` 与目标 Expert 的能力标签匹配。
- 模型名、Provider、Base URL、协议来自 **Deployment**；Worker 只声明 Backend / Runtime Profile，并通过 `EXPERT_MODEL_CREDENTIAL_REFS_JSON` 把 Deployment 的 `credentialRef` 映射到本机受保护环境变量。Claude 可使用 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN`，Codex 使用其 Deployment 允许的 Provider 环境变量。
- 如果使用私有仓库，在 `/etc/team-skill-hub-worker/keys/` 安全放入**只读 Git key**，按第 4 节配置 SSH/HTTPS 凭据映射；不要复制整个 Hub `.env`。
- 需要跨主机连接时，Hub 管理员负责发布可达的私网 gRPC 地址，设置 `EXPERT_GRPC_PUBLISH_BIND`、防火墙白名单及必要的 TLS/mTLS；不应把 gRPC 端口暴露到公网。
- 不要直接把密钥复制进文档或版本库。`EXPERT_DOCKER_SECCOMP_PROFILE=unconfined` 仅用于复现沙箱不兼容后的受控排障，默认保持 `default`。

### 8.2 启动并通过 Admin 批准

```bash
sudo systemctl enable --now team-skill-hub-worker
sudo systemctl status team-skill-hub-worker --no-pager
sudo journalctl -u team-skill-hub-worker -n 80 --no-pager
```

在 Hub 的 `/admin/experts` → **Worker 管理**中观察 `yocto-worker-01`：

1. 首次启动自动注册，状态先变成 `pending`（默认不开启自动批准）。
2. 管理员核对 Worker ID 和 capabilities，点击 **批准**。
3. Worker 自动交换并保存正式 credential，开始心跳与领任务；不需要手工执行 `enroll` 或复制 credential。
4. 在 Worker 主机确认 `/var/lib/team-skill-hub-worker/worker-credential` 已生成并受保护；随后**移除 `worker.env` 中的 Bootstrap Token**，重启后应继续使用凭据文件。

旧版手动注册/签发 CLI 仍可作故障排查备用，见第 11 节。

### 8.3 日常检查、升级与回滚

```bash
sudo systemctl status team-skill-hub-worker --no-pager
sudo journalctl -u team-skill-hub-worker -f
sudo docker image ls team-skill-hub-expert-worker
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
