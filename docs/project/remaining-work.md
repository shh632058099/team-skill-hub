# Team Skill Hub — Current Remaining Work

> 更新时间：2026-10-10
> 本文件是当前唯一执行 Backlog。历史记录已归档到 `remaining-work-history.md`。
> 原则：只记录经当前代码核对后仍真实缺失、未完成或尚未做真实环境验收的事项。

## 当前稳定基线

以下能力已经完成，不应重复实现：

- Skill / Prompt / Agent / Tool Registry 基础能力。
- Knowledge / RAG：Markdown、TXT、PDF、DOCX，支持 chunking、FTS、权限过滤、生命周期审计。
- Local / Git Repository Provider、LKG、Revision、Rollback、Webhook、Polling、手动同步。
- API Key Authentication、托管 API Key、Repository 级 read/sync 权限隔离。
- Admin Web、Dashboard、Observability、Trace、Session Analytics、Feedback、Knowledge Gaps。
- Codex / Claude Code Client Event、Hook、Session、Evidence、自动 Knowledge Candidate 基础闭环。
- Candidate exact / near duplicate、relation、Review Inbox、GitLab MR publish/reconcile/retry。
- Evaluation Framework、Retrieval Evaluation、CI gate、baseline regression。
- Backup / Restore / Disaster Recovery 基础工具。
- Codex portable plugin build、Claude Code setup scripts、通用 Agent Adapter Contract v1。
- WSL2 Docker 下当前完整测试：93/93 PASS。
- Knowledge-only Repository readiness、Admin Health/KPI API-Key principal、WSL2 Host allowlist 问题均已修复。

---

# P0 — 近期必须完成

## 1. 建立正式的 Docker 测试入口

### 现状

当前生产 Dockerfile 为运行镜像，会排除 `tests/`，因此直接在生产镜像中执行 `npm test` 会出现 0 tests。当前 WSL2 Docker 全量测试需要临时构造测试镜像并额外复制 `tests/`、`scripts/`，同时安装 Git。

### 待完成

- 新增标准测试镜像，例如 `Dockerfile.test`，或 Compose `test` profile。
- 测试镜像必须包含：
  - `src/`
  - `tests/`
  - `scripts/`
  - Git CLI
  - 完整 devDependencies
- 新增统一入口，例如：

```bash
./scripts/test-docker.sh
```

- 本地和 CI 使用同一套 Docker 测试入口。
- 明确失败条件：0 tests 必须判定为失败。

### 完成标准

- WSL2 上一条命令即可完成 build + 93+ tests。
- 不依赖宿主机 Node/npm。
- CI 与本地执行一致。

---

## 2. 真实 GitLab Sandbox 完整验收

### 现状

代码中已经存在：

```bash
npm run sandbox:acceptance
```

并有自动测试覆盖，但尚未在真实公司/测试 GitLab 项目上完成正式验收。

### 待完成

真实跑通：

```text
Codex/Manual Candidate
  -> Review Approve
  -> GitLab Branch
  -> Merge Request
  -> Human Merge
  -> Webhook / Poll Sync
  -> New Revision
  -> Knowledge Search / RAG 命中
```

同时验证：

- MR closed / merged / conflict 状态 reconcile。
- Branch 删除后的状态。
- Publish retry 幂等。
- Token 权限最小化。
- Webhook secret 和 GitLab API 失败场景。

### 完成标准

保留一次完整真实环境验收记录，包括 MR、merge commit、同步 revision 和检索结果。

---

## 3. GHCR / Release / Rollback 真实验收

### 现状

已有：

```bash
npm run release:registry-acceptance
npm run release:check
```

自动测试存在，但尚未完成真实 GHCR release + rollback 演练。

### 待完成

- 构建并 push version tag + commit SHA tag。
- 验证 image digest 不可变。
- 禁止生产依赖 floating `latest`。
- 使用旧版本 digest 执行 rollback。
- rollback 后验证：
  - `/health/live`
  - `/health/ready`
  - MCP
  - Admin Web
  - Repository sync
  - DATA_DIR 兼容性

### 完成标准

至少完成一次真实“升级 -> 验证 -> 回滚 -> 再验证”演练。

---

## 4. 正式部署升级 / 数据恢复演练

### 待完成

在真实或等价 staging 环境执行：

```text
backup
 -> upgrade container
 -> repository sync
 -> smoke test
 -> restore/rollback
 -> verify data integrity
```

覆盖：

- Observability JSONL。
- Candidate / Review history。
- API Key persistence。
- Evaluation history。
- Repository revision history。

### 完成标准

形成可重复执行的 deployment runbook，而不是只依赖单元测试。

---

## 5. WSL2 / LAN Host Allowlist 配置收尾

### 当前状态

已经支持：

```text
SKILL_HUB_ALLOWED_HOSTS
```

可解决 WSL2 IP 访问时的 `Invalid Host`。

### 待完成

- 在部署文档和用户使用文档补充该变量。
- 提供多 Host 示例：

```env
SKILL_HUB_ALLOWED_HOSTS=172.26.23.136,skill-hub.company.local
```

- 明确 DNS rebinding 安全边界，不建议无条件关闭 Host validation。
- 可选：启动日志打印允许的 Host 数量，但不要输出敏感配置。

---

# P1 — 产品能力与可靠性

## 6. Admin Web API 请求层统一与局部失败隔离

### 当前问题

Admin UI 中多个页面仍直接：

```javascript
const data = await response.json()
```

Observability 也会并行加载多个 API。某一个 endpoint 返回 HTML、代理错误或非 JSON 时，可能导致整个区域出现笼统的 `Internal Server Error` 或 JS 异常。

### 待完成

增加统一前端请求层：

- `requestJson()` / `readResponse()`。
- JSON / text fallback。
- HTTP status + endpoint 可诊断错误。
- Observability 子模块局部失败，不阻断其它正常模块。
- Dashboard / Governance / Evaluation 复用同一套错误处理。

---

## 7. Managed API Key 持久化事务一致性

### 当前状态

Delete 已改为“persist 成功后再替换内存状态”。

### 待确认 / 待完成

检查 Create / Update 是否仍存在：

```text
先改内存 -> persist 失败 -> 内存与磁盘不一致
```

统一为事务式状态切换，并增加 persist failure 回归测试。

---

## 8. Knowledge Publisher Provider 扩展

### 当前状态

生产 publish 只支持：

```text
Git repository + GitLab MR publisher
```

Local repository 调 `/publish` 会明确失败，这是当前设计限制。

### 可选扩展

优先考虑：

- `local-git` publisher：用于离线开发、Docker E2E、内部 sandbox。
- GitHub Pull Request publisher：只有团队真实需要时再做。

要求继续保持：

- 人工 merge boundary。
- Source of Truth 仍是 Git。
- Publisher 接口不与 Admin UI 强绑定 GitLab 文案。

---

## 9. Tool Registry 模型收尾

### 当前状态

`ota-expert` 中 `git` / `repository-read` 依赖目前暂时注释，原因是 `rd-skills` 尚未正式维护对应 Tool artifact。

### 待完成

确定团队 Tool Registry 的正式策略：

- 哪些是逻辑 capability，哪些是可执行 Tool。
- `git` / `repository-read` 是否需要独立 `TOOL.yaml`。
- Tool owner / environment / authentication / permission 的最低要求。
- Agent 引用 Tool 时的跨 Repo 规则。

确认后再恢复 `ota-expert` 的 Tool binding 和 Evaluation 断言。

---

## 10. Semantic / Hybrid Retrieval 第二阶段

### 当前状态

现阶段 SQLite FTS5 + metadata ranking 对约 30 人内部使用足够。

### 触发条件

当 Knowledge 数量、同义词搜索、跨语言查询导致 FTS 召回明显不足时，再增加：

```text
metadata filter
 -> FTS/BM25 recall
 -> embedding recall
 -> reranker
 -> permission filter
 -> top-k
```

### 原则

暂不为了“架构先进”提前引入 Vector DB。

---

## 11. Registry 级跨 Repository dependency / cycle validation

### 当前状态

同 Repository 依赖校验已经存在；跨 Repo dependency 和循环依赖没有完整 Registry 级验证。

### 待完成

- qualified dependency resolution。
- cross-repo visibility 检查。
- dependency cycle detection。
- missing dependency diagnostics。
- validated revision activation 前 fail-closed。

---

## 12. OAuth / OIDC / 企业 SSO

### 当前状态

现在主要使用 API Key -> Principal，Provider 接口已经为未来认证方式保留扩展点。

### 触发条件

当团队需要企业身份、人员离职自动回收、Group/Role 映射时实现：

- OIDC login / bearer validation。
- Group -> Role 映射。
- Tenant / repository policy 映射。
- API Key 保留给 CI / service account。

---

## 13. Codex / Claude Code 企业分发增强

当前插件和 setup script 已可用，后续可根据真实 rollout 反馈增加：

- 统一版本升级策略。
- Runtime stale 自动修复提示。
- 企业级安装源 / 内部 marketplace。
- 客户端版本使用率 Dashboard。
- 安装/升级失败诊断。

不要在没有真实 rollout 反馈前继续堆安装器功能。

---

## 14. Candidate Quality 闭环继续优化

当前已有 Reviewer label、accept/reject、false-positive、duplicate、low-value 趋势。

下一阶段重点不是增加更多指标，而是：

- 用真实 Review 数据确定 threshold 是否需要调整。
- 找出高频 false-positive pattern。
- 找出长期无人批准的 Candidate 类型。
- 对 detector version 做前后效果比较。

只有数据证明必要时再调整 Detector 规则。

---

# P2 — 规模化后再做

## 15. PostgreSQL Registry

触发条件：单实例内存/SQLite/本地 JSONL 成为明显瓶颈，或需要多实例共享 Registry 状态。

迁移对象：

- Repository State。
- Artifact metadata/index。
- Audit metadata。
- Revision metadata。
- Candidate / review metadata（视实际需要）。

Git 继续作为 Skill / Knowledge Source of Truth。

---

## 16. Redis / Distributed Lock

只有进入多实例部署后再引入，用于：

- distributed sync lock。
- hot metadata cache。
- rate limit。
- event fanout。

不作为 Source of Truth。

---

## 17. Horizontal Scaling

目标形态：

```text
Load Balancer
  -> Team Skill Hub instance N
       -> PostgreSQL
       -> Redis
       -> shared revision/object storage
```

目前约 30 人内部团队规模下不建议提前实现。

---

## 18. 更多 Agent Adapter

通用 Agent Adapter Contract v1 已完成，因此 VS Code / JetBrains / internal CI agent 等客户端原则上只需要薄适配层。

只有出现明确客户端需求时，再增加：

- VS Code extension adapter。
- JetBrains adapter。
- CI Agent adapter packaging。
- 其它内部 coding agent adapter。

不要为不存在的客户端预先复制后端 lifecycle 实现。

---

# 推荐实施顺序

当前建议按以下顺序继续：

1. **Docker 标准测试入口**。
2. **真实 GitLab sandbox acceptance**。
3. **真实 GHCR release / rollback acceptance**。
4. **staging upgrade / backup / restore 演练**。
5. **Admin API 请求层可靠性**。
6. **Managed API Key Create/Update 事务一致性**。
7. **Tool Registry 策略收尾**。
8. 根据真实团队反馈决定 Publisher、SSO、Semantic Search、Adapter 扩展。
9. PostgreSQL / Redis / Horizontal Scaling 最后做。

# 当前不建议立即做

以下功能当前没有足够收益，不应优先：

- 为 30 人规模提前迁移 PostgreSQL。
- 提前部署 Redis。
- 为了“RAG”标签强行引入 Vector DB。
- 未有真实需求就开发多个 IDE Adapter。
- 自动 merge Knowledge MR，绕过人工审核。
- 将模型 gateway 合并进 Team Skill Hub。
