# Team Skill Hub 管理员部署指南

本文给平台管理员一条从“拿到源码”到“团队成员可用”的最短部署路径。完整 GitHub/GitLab、安全、Knowledge、Webhook 和运维细节请继续参考 `deployment-github-gitlab.zh-CN.md`。

## 1. 推荐生产拓扑

```text
GitHub: team-skill-hub 源码
  -> GitHub Actions
  -> GHCR 不可变镜像
  -> 公司部署主机 / Docker Compose
  -> 内部 GitLab Skill / Knowledge 仓库
  -> GitLab Webhook
  -> Team Skill Hub
  -> Codex / Claude Code / 其他 MCP Client
```

建议将 Hub 程序和 Skill/Knowledge 内容仓库分开管理。Hub 镜像按版本发布，团队知识继续通过公司 GitLab 的 Branch/MR/Review 流程维护。

## 2. 部署前准备

至少准备：

- 一台可运行 Docker / Docker Compose 的 Linux 主机；
- 一个可访问的 Team Skill Hub 域名或公司内网地址；
- 内部 GitLab Skill/Knowledge 仓库；
- GitLab 只读 Deploy Key；
- 一个 `ADMIN_API_KEY`；
- 一个 `GITLAB_WEBHOOK_TOKEN`；
- 如需 Knowledge 自动回流，再单独准备 `GITLAB_WRITE_TOKEN`；
- 正式发布时使用 GHCR 不可变版本镜像，例如 `ghcr.io/<org>/team-skill-hub:v0.1.0`。

不要把 API Key、Token、SSH 私钥或 `.env` 提交到 Git。

## 3. 准备 GitLab 只读访问

在部署主机：

```bash
mkdir -p secrets
ssh-keygen -t ed25519 -C "team-skill-hub" \
  -f secrets/gitlab_skillhub_ed25519 -N ""
chmod 600 secrets/gitlab_skillhub_ed25519

ssh-keyscan -t ed25519 gitlab.company.example \
  > secrets/gitlab_known_hosts
chmod 644 secrets/gitlab_known_hosts
```

把公钥添加到对应 GitLab 项目，并保持 **只读**。

验证：

```bash
ssh -i secrets/gitlab_skillhub_ed25519 \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile=secrets/gitlab_known_hosts \
  -o StrictHostKeyChecking=yes \
  -T git@gitlab.company.example
```

## 4. 配置 Repository

复制模板：

```bash
cp config/repositories.gitlab.example.yaml \
   config/repositories.gitlab.yaml
```

至少修改：

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

生产环境建议按 Repository 配置 `visibility` 和 `access.read_roles`，避免内部研发与客户内容互相可见。

## 5. 准备 `.env`

```bash
cp examples/deployment/gitlab.env.example .env
```

最小生产配置示例：

```dotenv
SKILL_HUB_IMAGE=ghcr.io/<org>/team-skill-hub:v0.1.0
AUTH_MODE=api-key
ADMIN_API_KEY=<long-random-admin-key>
GITLAB_WEBHOOK_TOKEN=<long-random-webhook-token>
GITLAB_SSH_KEY_FILE=./secrets/gitlab_skillhub_ed25519
GITLAB_KNOWN_HOSTS_FILE=./secrets/gitlab_known_hosts
SKILL_HUB_API_KEYS_JSON=
```

普通开发者 API Key 不需要写进 `.env`，服务启动后从 Admin Web 创建即可。

## 6. 启动

生产环境：

```bash
docker compose --env-file .env \
  -f docker-compose.gitlab.yml pull

docker compose --env-file .env \
  -f docker-compose.gitlab.yml up -d --no-build
```

验证：

```bash
docker compose -f docker-compose.gitlab.yml ps
curl http://127.0.0.1:8080/health/live
curl http://127.0.0.1:8080/health/ready
curl http://127.0.0.1:8080/metrics
```

`/health/ready` 成功后再继续配置客户端。

## 7. 首次登录 Admin Web

访问：

```text
https://<hub-host>/admin
```

使用 `ADMIN_API_KEY` 登录。

首次建议依次检查：

1. Repository 是否同步成功；
2. Skill/Prompt/Agent 是否可见；
3. Knowledge Source 是否按预期索引；
4. Repository Governance 是否存在错误；
5. Operational Health 是否正常；
6. 再创建普通开发者 API Key。

## 8. 创建普通用户 API Key

在 **用户 API Keys** 中为每位用户创建独立 Key，例如：

```text
Name: biao-codex
User ID: biao
Tenant: rd
Roles: developer, internal
```

生成的 `skh_...` 明文只显示一次，应通过公司的安全渠道交给对应用户。

不要把 `ADMIN_API_KEY` 发给普通开发者。

## 9. 配置 GitLab Webhook

对每个内容仓库配置：

```text
URL: https://<hub-host>/webhooks/git
Secret Token: <GITLAB_WEBHOOK_TOKEN>
Event: Push events
SSL verification: enabled
```

验证一次正常 Merge/Push 后，Hub 应完成：

```text
GitLab Push
 -> Webhook
 -> Repository fetch/reset
 -> validation
 -> validated snapshot
 -> atomic activation
 -> Knowledge re-index
```

如果新 Revision 校验失败，Last Known Good 应继续生效。

## 10. 可选：开启 Knowledge 回流

先确认只读检索链路正常，再开启写入能力。

Repository 示例：

```yaml
knowledge_publishing:
  enabled: true
  provider: gitlab
  base_url: https://gitlab.company.example
  project_path: ai/rd-skills
  token_env: GITLAB_WRITE_TOKEN
  target_branch: main
  branch_prefix: skill-hub-knowledge
```

部署环境：

```dotenv
GITLAB_WRITE_TOKEN=<separate-write-token>
```

必须保持：

```text
Repository Sync credential = 只读
Knowledge Publishing token = 独立写凭据
```

Hub 只创建 Branch/MR，不自动 Merge。

## 11. 给开发者的最短接入信息

管理员只需要发给普通开发者两项：

```text
MCP URL:
https://<hub-host>/mcp

Developer API Key:
skh_...
```

然后让用户按 `user-guide.zh-CN.md` 配置 Codex 或 Claude Code。

## 12. 发布前最小验收

正式推广前至少完成：

- `/health/live` 通过；
- `/health/ready` 通过；
- Admin Web 可登录；
- Repository 首次同步成功；
- 普通 Developer Key 可以访问允许的 Repository；
- 无权限 Repository 不可见；
- `discover` 或 `search_skills` 可返回结果；
- `search_knowledge` 可返回预期内容；
- GitLab Webhook 推送后自动同步；
- Codex 或 Claude Code 至少完成一次真实 MCP 调用；
- Named Volume 已持久化；
- 备份/恢复方案已验证。

如果启用 Knowledge 回流，再额外验证：

- 自动/手工 Candidate 可以进入 Review Inbox；
- Approve 后可以创建 GitLab MR；
- Hub 不会自动 Merge；
- MR Merge 后 Repository 能通过 Webhook 同步并重新建立索引。

## 13. 升级

修改 `.env` 中的不可变镜像版本后：

```bash
docker compose --env-file .env \
  -f docker-compose.gitlab.yml pull

docker compose --env-file .env \
  -f docker-compose.gitlab.yml up -d --no-build

curl http://127.0.0.1:8080/health/ready
```

升级后至少检查 Admin、Repository 状态和一次代表性的 MCP 查询。

## 14. 回滚

保留上一个可用的不可变镜像版本，例如：

```text
v0.0.9 -> 已知可用
v0.1.0 -> 当前发布
```

出现应用级问题时，将 `.env` 的 `SKILL_HUB_IMAGE` 切回上一版本，再执行 `pull` 和 `up -d --no-build`。

内容仓库自身的问题优先使用 Hub 的 validated revision rollback，不要改写 Git 历史。

## 15. 相关文档

- 完整部署说明：`deployment-github-gitlab.zh-CN.md`
- 普通用户快速使用：`user-guide.zh-CN.md`
- 开发者 MCP 详细说明：`developer-mcp-guide.zh-CN.md`
- Codex Plugin 分发：`codex-plugin-distribution.md`
- Claude Code Adapter：`claude-code-adapter.md`
- Release / Registry 验收：`release-guide.md`
- 备份、恢复和生产验收请以仓库中对应运维文档及 `remaining-work.md` 的最新状态为准。
