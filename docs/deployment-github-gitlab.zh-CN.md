# GitHub Hub + 公司内部 GitLab Skills 部署指南

## 1. 目标拓扑

```text
GitHub
  team-skill-hub 源码
        |
        | GitHub Actions
        v
GitHub Container Registry (GHCR)
  ghcr.io/<org>/team-skill-hub:<tag>
        |
        | docker pull
        v
公司部署主机
  team-skill-hub 容器
        |
        | SSH Deploy Key（只读）
        v
内部 GitLab
  ai/rd-skills
  ai/customer-skills
        |
        | Push webhook
        v
POST /webhooks/git
        |
        v
validate -> snapshot -> activate
```

Hub 源码可以托管在公开或私有 GitHub 仓库中。Skill 内容无需离开公司内部 GitLab。

## 2. 推荐的安全模型

Skill 仓库访问使用只读 SSH Deploy Key。不要给 Hub 写权限。

以下凭据应相互独立：

- MCP 调用方 API Key：`SKILL_HUB_API_KEYS_JSON`；
- 管理 HTTP Key：`ADMIN_API_KEY`；
- GitLab Webhook Token：`GITLAB_WEBHOOK_TOKEN`；
- GitLab 仓库凭据：SSH Deploy Key；如果无法使用 SSH，则使用 HTTPS Token。

绝不要把私钥、GitLab Token、API Key 或生成后的环境配置文件提交到 GitHub。仓库已忽略 `secrets/` 和 `.env`。

## 3. 从 GitHub 发布 Hub 镜像

仓库包含：

```text
.github/workflows/docker-image.yml
```

Pull Request 时会构建镜像。推送到 `main` 分支以及推送匹配 `v*` 的 Tag 时，会把镜像发布到 GitHub Container Registry。

推荐流程：

1. 创建 GitHub 仓库，例如 `your-org/team-skill-hub`。
2. 将当前 Hub 仓库推送到 GitHub。
3. 确认 GitHub Actions 有权限发布 Packages。
4. 推送到 `main`，或者创建类似 `v0.1.0` 的版本 Tag。
5. 确认 `ghcr.io/your-org/team-skill-hub` 下已经生成 Package。
6. 生产环境使用不可变版本 Tag，不要使用 `latest`。

示例：

```text
SKILL_HUB_IMAGE=ghcr.io/your-org/team-skill-hub:v0.1.0
```

## 4. 准备内部 GitLab Skill 仓库

推荐结构：

```text
GitLab group: ai
├── rd-skills
└── customer-skills
```

开发人员继续使用正常的 GitLab branch/MR/review 流程。Hub 只需要读取权限。

### 4.1 生成独立的只读 Deploy Key

在部署主机执行：

```bash
mkdir -p secrets
ssh-keygen -t ed25519 -C "team-skill-hub" -f secrets/gitlab_skillhub_ed25519 -N ""
chmod 600 secrets/gitlab_skillhub_ed25519
```

将 `secrets/gitlab_skillhub_ed25519.pub` 添加到每个 Skill 项目，并配置为只读 GitLab Deploy Key。

如果公司安全策略要求每个仓库使用独立 Key，则为每个仓库分别生成 Key，并在仓库配置中使用不同的 secret 路径。

### 4.2 固定 GitLab SSH Host Key

不要关闭 SSH 主机校验。

```bash
ssh-keyscan -t ed25519 gitlab.company.example > secrets/gitlab_known_hosts
chmod 644 secrets/gitlab_known_hosts
```

使用前应通过可信渠道向 GitLab 管理员核对 Fingerprint。

测试访问：

```bash
ssh -i secrets/gitlab_skillhub_ed25519 \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile=secrets/gitlab_known_hosts \
  -o StrictHostKeyChecking=yes \
  -T git@gitlab.company.example
```

## 5. 配置 GitLab 仓库

复制 SSH 示例配置：

```bash
cp config/repositories.gitlab.example.yaml config/repositories.gitlab.yaml
```

修改 GitLab 主机名、Group 和项目名称：

```yaml
repositories:
  - id: rd-skills
    provider: git
    git_url: git@gitlab.company.example:ai/rd-skills.git
    branch: main
    webhook_aliases:
      - ai/rd-skills
      - rd-skills
    git_auth:
      type: ssh
      ssh_key_path: /run/secrets/gitlab_ssh_key
      known_hosts_path: /run/secrets/gitlab_known_hosts
```

当 GitLab 项目路径和 Hub 的 Repository ID 不完全一致时，`webhook_aliases` 很有用。

Customer 仓库保持隔离：

```yaml
visibility: [customer]
access:
  read_roles: [customer]
  sync_roles: [admin]
```

R&D 仓库则保持为 internal/developer-only。

## 6. 准备运行时变量

复制模板到本地 `.env` 文件，该文件已被 Git 忽略：

```bash
cp examples/deployment/gitlab.env.example .env
```

替换所有占位值。至少配置：

```text
SKILL_HUB_IMAGE=ghcr.io/your-org/team-skill-hub:v0.1.0
AUTH_MODE=api-key
SKILL_HUB_API_KEYS_JSON=...
ADMIN_API_KEY=...
GITLAB_WEBHOOK_TOKEN=...
GITLAB_SSH_KEY_FILE=./secrets/gitlab_skillhub_ed25519
GITLAB_KNOWN_HOSTS_FILE=./secrets/gitlab_known_hosts
```

使用公司认可的密钥管理机制生成足够长的随机值。

## 7. 使用 Docker Compose 启动

```bash
docker compose --env-file .env -f docker-compose.gitlab.yml pull
docker compose --env-file .env -f docker-compose.gitlab.yml up -d
```

检查状态：

```bash
docker compose -f docker-compose.gitlab.yml ps
curl http://127.0.0.1:8080/health/live
curl http://127.0.0.1:8080/health/ready
curl http://127.0.0.1:8080/metrics
```

启动时，Hub 会克隆每个启用的 Skill 仓库，校验全部 Skills，创建 validated snapshot，并以原子方式激活。Docker Named Volume 会在容器替换后继续保存 Registry 状态、审计历史、Git 工作副本以及已验证 Revision。

## 8. 配置 GitLab Webhook

对每个 Skill 仓库：

1. 打开 **Settings -> Webhooks**。
2. URL 设置为 `https://<skill-hub-host>/webhooks/git`。
3. Secret Token 配置为与 `GITLAB_WEBHOOK_TOKEN` 相同的值。
4. 启用 **Push events**。
5. 保持 SSL verification 开启。

Secret Token 模式下，GitLab 会通过 `X-Gitlab-Token` 发送该值，Hub 在同步前会进行校验。

一次正常更新流程为：

```text
Developer merge/push
   -> GitLab Push Hook
   -> resolve project.path_with_namespace
   -> git fetch/reset
   -> Skill validation
   -> validated snapshot
   -> atomic Registry activation
```

如果新 Revision 无效，之前的 Last Known Good Revision 会继续保持激活状态。Polling 会继续作为 Webhook 丢失时的兜底机制。

## 9. HTTPS Token 备选方案

如果不允许使用 SSH：

```bash
cp config/repositories.gitlab-https.example.yaml config/repositories.gitlab.yaml
```

配置：

```text
GITLAB_USERNAME=oauth2
GITLAB_TOKEN=<read-only-token>
```

Token 不会写入 `git_url`。Git Provider 会通过动态生成的 askpass helper 传递凭据，同时禁用终端交互式提示。

优先使用权限范围最小、符合公司安全要求的只读 Token，并按照公司策略定期轮换。

## 10. 通过 HTTPS 暴露 MCP

生产 MCP Endpoint：

```text
https://<skill-hub-host>/mcp
```

在容器前放置 HTTPS Reverse Proxy / Load Balancer。不要把明文 HTTP 8080 端口暴露到不可信网络。

MCP 调用方发送以下任一种凭据：

```text
Authorization: Bearer <api-key>
```

或者：

```text
x-skill-hub-api-key: <api-key>
```

Developer 凭据应只包含 developer/internal roles。Customer 凭据应只包含 customer roles。

## 11. Codex 集成

配置 Codex 使用：

```text
https://<skill-hub-host>/mcp
```

如果客户端 MCP 配置支持自定义 Header，则将 Developer API Key 作为 HTTP Authorization Header 一并配置。

`AUTH_MODE=development` 只适用于本地开发。对于任何可以通过网络访问的生产服务，都不要使用 development 模式。

## 12. Hub 与 Skills 独立升级

发布新的 Hub 镜像后：

```bash
# 将 .env 中的 SKILL_HUB_IMAGE 修改为不可变版本 Tag
docker compose --env-file .env -f docker-compose.gitlab.yml pull
docker compose --env-file .env -f docker-compose.gitlab.yml up -d
curl http://127.0.0.1:8080/health/ready
```

不需要重新构建 Skill 仓库。Skills 继续在 GitLab 中独立版本管理。

## 13. 运维接口

```text
GET  /health/live
GET  /health/ready
GET  /metrics
GET  /audit
POST /repositories/<id>/sync
GET  /repositories/<id>/revisions
POST /repositories/<id>/rollback
```

管理接口需要：

```text
x-skill-hub-admin-key: <ADMIN_API_KEY>
```

建议重点告警 readiness failure，以及 `repository_sync_total{result="failed"}` 的增长。

## 14. 网络要求

```text
部署主机/容器的出站访问：
  -> 内部 GitLab SSH 22，或使用 Token 鉴权的 HTTPS 443
  -> GHCR HTTPS 443，用于拉取镜像

通过反向代理进入的入站访问：
  <- MCP 客户端 HTTPS 443
  <- GitLab Webhook HTTPS 443
```

如果内部 GitLab 只能从公司网络访问，则 Skill Hub 应部署在能够访问内部 GitLab 的主机或网络区域。GitHub Actions 不需要访问 Skill 仓库，因为 Skill 内容不会被打包到 Hub 镜像中。

## 15. 推荐的生产环境配置

```text
Hub source          GitHub
Hub image           GHCR + immutable version tag
Skill source        公司内部 GitLab
Git auth            只读 SSH Deploy Key
Skill update        GitLab Push Webhook + polling fallback
MCP auth            初期使用 request-scoped API key
Admin auth          独立的 admin key
Persistent state    Docker named volume
External transport  HTTPS reverse proxy
```

这种方式可以让 Hub 软件生命周期与公司内部 Skill 内容和凭据完全解耦。
