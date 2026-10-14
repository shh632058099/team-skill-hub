# Team Skill Hub Implementation History

Historical implementation notes and completed large refactors. Kept for engineering traceability, not as the source of current product behavior.


## Team Skill Hub — Complete Remaining Work Backlog

> 更新时间：2026-09-30
> 目标：完成“普通用户无感使用 Codex，平台自动记录、自动识别可沉淀知识、进入 Web 审核、通过 GitLab MR 回流，并可持续评估与运营”的闭环。

### 当前已完成基线

以下能力已经完成或基本完成，可作为后续工作的稳定基础：

- Skill / Prompt / Agent Registry。
- Knowledge / RAG：Markdown、TXT、文本型 PDF、DOCX。
- Repository 权限、Git 同步、LKG、Revision、Rollback。
- MCP 认证、托管 API Key、Admin Web。
- MCP Observability、Trace、Feedback、Knowledge Gaps。
- Knowledge Candidate Review Inbox。
- GitLab Knowledge MR 发布与失败重试。
- Codex 全局 MCP + AGENTS.md 接入。
- Codex Hook Framework：
  - SessionStar
  - UserPromptSubmi
  - PreToolUse
  - PostToolUse
  - PreCompac
  - PostCompac
  - Stop
  - SessionEnd
- Client Event API 与持久化。
- Codex Session 与 MCP Call 聚合。
- PostToolUse Evidence 基础提取。
- Knowledge / Skill FTS Repository 权限前置过滤。
- Candidate exact duplicate fingerprint。
- Candidate related Knowledge 检索。
- Stop Hook 自动 Knowledge Candidate Detector 基础版本。
- Knowledge Retrieval Evaluation 指标结构：Hit@1 / Hit@3 / Hit@5 / MRR。
- 当前最近一次全量验证：`npm run check` 通过，`npm test` 55/55 通过；`git diff --check` 通过；Admin 内嵌 JS 可解析。

### 2026-09-30 实现快照

以下原“未完成”项已经在当前工作区完成，不应在后续继续时重复实现：

- 自动 Knowledge 默认开启；Bash `--no-auto-knowledge` / PowerShell `-NoAutoKnowledge` 可显式关闭。
- Setup `--upgrade` / `-Upgrade`、Hook Runtime Version、Hook Schema Version、Web stale runtime 展示已接入。
- Stop Detector 升级为 `stop-evidence-v2`：
  - root-cause / verified-fix / workaround / reusable-constraint 分类。
  - generation reason 与 detector skip reason。
  - 每 Session 与每用户自动候选限流。
  - 过短、低复用价值、模板化/重复 Summary 过滤。
  - structured test evidence 作为强 Evidence。
- Candidate exact duplicate + deterministic near-duplicate：
  - exact duplicate 使用 `duplicateOf`。
  - near duplicate 使用 `possibleDuplicateOf` + `duplicateSimilarity`。
  - 自动候选达到高相似阈值时直接跳过，手工候选保留并在 Review Inbox 提示。
- Candidate Knowledge Relation 已支持：
  - `new
  - `duplicate_of
  - `updates
  - `supersedes
  - `conflicts_with
  - `related_to
- 自动 relation hint 已支持：
  - 明确冲突信号提示 `conflicts_with`。
  - 明确替代信号提示 `supersedes`。
  - 高相关 verified/root-cause 结果提示 `updates`。
  - 最终关系仍由 Reviewer 确认后保存。
- Review Inbox 已展示结构化 Engineering Evidence（type / sourceTool / success / exitCode / test counts / duration / status）。
- Review Inbox 已支持 update/conflict 审阅预览：
  - 对 `updates / supersedes / conflicts_with / related_to` 目标可查看 CURRENT vs PROPOSED。
  - 展示目标 repository/path/revision 与近似增删行统计。
  - `conflicts_with` 显示强提醒，发布前要求 Reviewer 人工确认。
- Auto Candidate Quality 已建立 Reviewer 标签与 Dashboard 指标：
  - Reviewer 原因：`useful / needs_edit / false_positive / duplicate / low_reuse_value / outdated`。
  - Auto Accept / Reject Rate。
  - Quality Label Coverage。
  - Useful Rate / False-positive Rate（仅基于已有 Reviewer 标签）。
  - Duplicate Filtered / Low-value Filtered。
  - Detection 记录 detector version；新记录使用 `stop-evidence-v2`，历史未知版本归为 `legacy`。
  - Admin Observability 支持当前 N 天 vs 前 N 天 baseline 对比。
  - 支持按 Detector 与每日查看 Created / Skipped / Label Coverage / Useful / False-positive / Duplicate / Low-value 趋势。
- GitLab MR status reconcile 已支持：
  - 发布时记录 MR state 与 lastCheckedAt。
  - Admin Review Inbox 可手动刷新 MR 状态。
  - 持久化 opened / merged / closed / locked、mergedAt / closedAt / mergeCommitSha。
- Evaluation Admin Web / CI Gate 已支持：
  - Admin 可加载 EVALUATION.yaml Suite、运行 candidate/baseline 对比并查看历史。
  - Web 展示 failed cases、Hit@1/3/5、MRR 与 regression。
  - `npm run ci:evaluate -- --path <repo> ...` 可直接作为 CI Gate；case failure、regression、baseline suite 丢失均返回非零退出码。
  - 已对当前 `rd-skills` revision 实跑，5/5 cases PASS。
- Retrieval Evaluation 已覆盖 Hit@1 / Hit@3 / Hit@5 / MRR 与 regression 测试。
- Session Timeline、Detector Decisions、基础 KPI、Knowledge Lifecycle Audit、Project Context、Unified Discover、Tool Registry 已存在于当前实现。

本轮顶部优先项已完成。后续继续时以本文下方仍未实现、且经代码核对确认真实缺失的条目为准；不要仅依据旧章节中的历史“未完成”描述重复实现。

---

## P0 — 当前必须继续完成

### 1. 自动 Knowledge Candidate 默认启用策略收尾

#### 当前状态

Stop Detector 已实现，但安装脚本当前仍以“显式开启自动知识回流”为主：

- Bash：`--auto-knowledge
- PowerShell：`-AutoKnowledge

Hook Runtime 只有在 `capture_stop_message=true` 时，才会上传经过本地脱敏和截断后的最后一条 Assistant Summary。

#### 未完成

将普通用户默认行为调整为：

```tex
默认：
capture_stop_message=true
自动候选开启

可选关闭：
--no-auto-knowledge
-NoAutoKnowledge


#### 约束

即使默认开启，也必须继续保证不会自动上传：

- User Prompt 原文。
- Transcript 全文。
- Tool Input 全文。
- Tool Output / stdout 全文。
- 源码正文。
- 文件正文。
- Token / Password / Secret / API Key。

#### 完成标准

- Bash / PowerShell 默认开启一致。
- 提供显式关闭参数。
- README / 中文用户文档 / 开发者文档一致。
- 安装脚本重复运行保持幂等。
- 原有 `AGENTS.md` / `hooks.json` 内容不被覆盖。

---

### 2. Stop Knowledge Candidate Detector 质量加固

#### 当前状态

已有 `stop-evidence-v1`：

```tex
Stop
  -> assistant_result_excerp
  -> Session Timeline
  -> PostToolUse Evidence
  -> Engineering Action
  -> Tests Passed
  -> Candidate


当前要求：

- 有工程动作。
- 有较强测试 Evidence。
- 最终 Assistant Summary 长度达到阈值。
- 同一 Session + Turn 不重复生成。
- exact duplicate 不重复创建自动候选。
- 可推断 Repository。
- 会记录 relatedKnowledge。

#### 未完成

需要继续降低误报和垃圾 Candidate：

- 更可靠地区分：
  - root cause
  - verified fix
  - workaround
  - reusable engineering constrain
  - one-off task resul
- 对仅格式化、简单编译修复、纯重构、无团队复用价值的结果拒绝回流。
- 增加 Candidate 生成原因可解释字段。
- 增加 Detector skip reason 统计，方便调阈值。
- 增加最大每 Session / 每用户自动候选数量限制。
- 增加过短、模板化、重复 Assistant Summary 的过滤。

#### 完成标准

Web Review Inbox 中自动候选具备：

```tex
为什么生成
使用了哪些 Evidence
关联哪个 Codex Session / Turn
推断哪个 Repository
是否存在相关 Knowledge
是否与已有 Candidate 重复


---

### 3. Candidate 去重 / 旧知识更新关系完善

#### 当前状态

已支持：

- exact fingerprint。
- `duplicateOf`。
- related Knowledge Top-N。

#### 未完成

需要增加更明确的语义关系：

```tex
duplicate_of
updates
supersedes
conflicts_with
related_to


当前 related Knowledge 只是检索结果，还不能判断：

- 这是全新知识。
- 这是旧 Knowledge 的补充。
- 这是旧 Knowledge 的替换。
- 新结论与现有 Knowledge 冲突。

#### 建议实现顺序

1. 先 deterministic：
   - 同 Repository。
   - 同 path / title 强匹配。
   - 高检索分数。
2. Web 审核时由管理员确认关系。
3. 后续再考虑模型辅助判断，不作为第一版强依赖。

#### 完成标准

Review Inbox 能明确显示：

```tex
New Knowledge
Possible Duplicate
Update Existing Knowledge
Conflict Review Required


发布 MR 时可以选择：

- 新建 Markdown。
- 更新已有 Markdown。

---

### 4. Knowledge Retrieval Evaluation 专项测试补齐

#### 当前状态

Evaluation Framework 已经支持 Knowledge Search，并开始计算：

- Hit@1
- Hit@3
- Hit@5
- MRR

当前代码结构已经存在，编译问题也已修复。

#### 未完成

需要增加明确的 Retrieval Evaluation Golden Cases 和自动测试。

推荐 `EVALUATION.yaml`：

```yaml
cases:
  - id: ota-power-loss-recovery
    target: knowledge
    operation: search
    query: OTA 升级断电后如何恢复
    expect:
      selected: docs/ota/recovery.md


#### 必须验证

- 正确命中 Top 1。
- 正确命中 Top 3。
- 正确命中 Top 5。
- 未命中时 rank = undefined。
- MRR 计算正确。
- baseline Retrieval Metrics 降低时标记 regression。
- 删除原有通过的 Retrieval Case 时仍判定 regression。

#### 完成标准

CI 可以直接判断：

```tex
Knowledge retrieval quality regressed


而不是只能看整体 Evaluation pass count。

---

## P1 — 下一阶段高价值能力

### 5. Session / Trace Web 体验继续完善

#### 当前状态

已有：

- Codex Session 列表。
- Client Hook Events。
- MCP Trace。
- Session Timeline API。

#### 未完成

Web 需要把这些真正整合成单个“任务详情”：

```tex
Session
  -> UserPromptSubmi
  -> search_skills
  -> get_skill
  -> search_knowledge
  -> get_knowledge
  -> Tool Evidence
  -> Stop
  -> Auto Candidate


#### 建议增强

- Session 页面显示 Candidate。
- Candidate 点击返回 Session Timeline。
- 显示 Knowledge / Skill 使用情况。
- 显示 Tests Passed / Failed。
- 显示自动 Candidate Detector 结果。
- 支持按 User / Repository / Time / Event 过滤。

---

### 6. Evidence 模型继续标准化

> 2026-09-30 状态：已完成。当前 `EngineeringEvidence` 已具备 schemaVersion=1，标准 evidence type、sourceTool、success/exitCode、test counts、duration/status；Hook 只抽取结构化摘要，Detector 统一通过 `normalizeEngineeringEvidence()` 消费该 Contract。

#### 当前状态

PostToolUse 已支持从结构化 Tool Response 中提取：

- exit_code
- success
- tests_run
- tests_passed
- tests_failed
- duration_ms
- status

并且不会上传完整 Tool Output。

#### 未完成

需要形成正式 Evidence Schema，例如：

```tex
build
tes
lin
static-analysis
git-change
reproduction
deploymen
device-tes


示例：

```json
{
  "type": "test",
  "tool": "npm",
  "passed": 46,
  "failed": 0,
  "success": true
}


#### 目标

Detector 不再依赖某几个临时字段，而是依赖稳定的 Evidence Contract。

---

### 7. Knowledge 生命周期元数据

> 2026-09-30 状态：已完成第一版。Markdown Front Matter 已支持 owner/status/tags/created_at/updated_at/valid_from/valid_until/source/supersedes/review_cycle；生命周期 Audit 已覆盖过期、禁用状态、缺 owner、无效日期和 review-overdue。

#### 未完成

为正式 Knowledge 增加：

```tex
owner
status
created_a
updated_a
valid_from
valid_until
tags
source
supersedes
review_cycle


重点解决：

- OTA / Yocto / CVE 知识过期。
- API 版本变化。
- 项目切换导致旧知识误用。
- 谁负责维护这份知识。

#### 建议

先通过 Markdown Front Matter 实现，不引入独立数据库主数据模型。

---

### 8. Review Inbox 产品化

> 2026-09-30 状态：核心能力已完成。当前已支持 status/repository/sourceType/reviewer/自动候选筛选、结构化 Evidence、关系提示、CURRENT vs PROPOSED 预览、冲突警示、Review History、批量 approve/reject（最多 100 个且强制 review reason）、GitLab MR 发布与状态刷新。

#### 当前状态

已有：

- 新增。
- 编辑。
- Approve / Reject。
- Publish GitLab MR。
- Publish Failed Retry。
- Duplicate 提示。
- Related Knowledge 提示。

#### 未完成

增加：

- 状态筛选。
- Repository 筛选。
- 自动 / 手工 Candidate 筛选。
- Reviewer。
- Owner。
- Candidate Diff。
- Existing Knowledge Diff。
- Duplicate / Update / Conflict 操作。
- 审核历史。
- 批量处理。
- 发布失败筛选。

---

### 9. Observability KPI

#### 未完成

需要从“日志查看器”升级成“平台运营看板”。

建议 KPI：

```tex
Active users / day
Codex sessions / day
MCP calls / session
Skill search hit rate
Knowledge search hit rate
Knowledge no-hit rate
Negative feedback rate
Auto candidate generated
Candidate approval rate
Candidate rejection rate
MR publish rate
MR merge rate
Top Knowledge Gaps
Top used Skills
Top used Knowledge


---

## P2 — 平台扩展能力

### 10. Project / Workspace Contex

#### 目标

SessionStart 根据：

- cwd
- git remote
- repository name

识别当前项目，然后提供：

- Recommended Skills。
- Recommended Knowledge。
- Recommended Prompts。
- Recommended Agents。
- Recommended Tools。

#### 价值

减少每次全局搜索，让 Team Skill Hub 从“搜索平台”进化成“项目上下文平台”。

---

### 11. Unified Discover

新增 MCP：

```tex
discover


一次返回：

- Skills。
- Knowledge。
- Prompts。
- Agents。
- 未来 Tools。

避免客户端自己分别调用多个 search。

---

### 12. Tool Registry

目前 Agent 的 `tools` 仍主要是声明字段，还没有真正 Tool Registry。

未来管理：

- GitLab。
- Jenkins。
- Jira。
- SonarQube。
- Test Farm。
- Device Farm。
- OTA Platform。
- Internal Log Service。

需要支持：

- Tool metadata。
- 权限。
- 环境。
- Owner。
- 调用方式。
- compatibility。

---

### 13. Hook Policy / PreToolUse

当前 `PreToolUse` 已保留入口但未启用。

后续可实现：

- Secret guard。
- Restricted repository guard。
- Destructive operation confirmation。
- Customer data policy。
- Production environment operation policy。

注意：这一阶段如果要阻断，需要由当前 async fail-open 改为明确的同步 policy hook。

---

### 14. Hook Runtime 版本管理 / 升级

当前 Hook Runtime 是 setup 时复制到用户 `~/.codex/hooks/`。

未完成：

- runtime_version。
- hook_schema_version。
- setup `--upgrade`。
- Hub / Client compatibility。
- Web 查看客户端 Runtime 版本。
- 旧版本告警。

---

### 15. Codex Plugin 化

最终形态建议：

```tex
Team Skill Hub Codex Plugin
  ├── MCP
  ├── AGENTS Guidance
  ├── Hooks
  ├── Runtime Version
  └── Setup / Upgrade


目标是减少：

- 手工 setup。
- hooks.json 漂移。
- Runtime 版本不一致。
- 团队 30 人的维护成本。

---

### 16. Claude Code / 其他 Agent Adapter

当前 ClientEvent Schema 已经是 client-agnostic，后续接：

```tex
Codex
Claude Code
CI Agen
IDE Agen
other internal agents
      ↓
ClientEvent API


服务端 Pipeline 不需要重写。

---

## 当前代码收尾事项

以下属于当前工作区必须在下一次提交前检查的事项：

1. 确认自动 Knowledge 默认启用策略最终决定并统一 Bash / PowerShell。
2. 补 Retrieval Metrics 专项测试。
3. 再跑一次：
   ```tex
   npm run build
   npm tes
   git diff --check

4. 再验证 Admin HTML 内嵌 JS 可解析。
5. 再验证 Bash setup / Hook Runtime。
6. 再验证 PowerShell setup / Hook Runtime。
7. 清理测试过程中产生的临时测试文件。
8. 检查 `git status --short`。
9. 提交时继续排除以下本地/设计文件：
   - `config/repositories.gitlab.yaml
   - `docs/repository/project-plan.md
   - `docs/repository/architecture.md
   - `docs/repository/project-plan.md
   - `docs/repository/architecture.md

---

## 推荐继续顺序

建议下一步严格按以下顺序推进：

```tex
1. 自动 Knowledge 默认启用策略收尾
2. Retrieval Evaluation Hit@1/3/5/MRR 专项测试
3. Candidate Update / Conflict 关系
4. Review Inbox 增强
5. Observability KPI
6. Knowledge 生命周期
7. Project Contex
8. Unified Discover
9. Tool Registry
10. Hook Runtime Versioning
11. Codex Plugin
12. Claude Code Adapter


其中近期最重要的目标仍然是：

> 普通开发者只需要正常使用 Codex；平台自动观察 Session，在有明确工程动作和测试 Evidence 的情况下，从最终已脱敏结果中生成高质量 Knowledge Candidate，管理员只负责 Web Review 和 GitLab MR 审核。

---

## 补充：此前未覆盖的全部剩余事项

以下内容补齐当前项目其余所有尚未完全完成的方向。

### 17. Search / RAG Ranking 质量优化

> 2026-09-30 状态：deterministic 第一阶段已完成。当前已有 Title / Path / Content / Tags boost、Exact Title/Content Phrase boost、FTS score、draft penalty、Version Applicability filter，并在 `reason` 中输出各项 score breakdown。Retrieval Evaluation Hit@1/3/5/MRR 全量回归通过。BM25 权重进一步调优和 repository-specific boost 仍需基于更多 golden cases 决定。

当前主要依赖 FTS5 + 中文 bigram。

未完成：

- BM25 参数调优。
- Title boost。
- Heading boost。
- Path boost。
- Exact phrase boost。
- Tags boost。
- Repository-specific boost。
- Version applicability boost。
- Deprecated / expired Knowledge 降权。
- Ranking Explainability。

要求：所有调优必须通过 Retrieval Evaluation 证明有效，不能只靠主观感觉。

---

### 18. Embedding / Hybrid Retrieval

当前未开始，并且不应该在 FTS Evaluation 之前贸然引入。

如果后续 deterministic Evaluation 证明 FTS 无法满足召回质量，再考虑：

```tex
FTS candidate
+
embedding candidate
+
deterministic rerank


未完成：

- embedding provider abstraction。
- embedding cache。
- hybrid retrieval。
- rerank。
- embedding refresh。
- vector persistence。
- evaluation 对比。

暂不建议单独引入大型 Vector DB。

---

### 19. Chunking Evaluation

> 2026-09-30 状态：deterministic 第一阶段已完成。Markdown chunking 已支持 heading/section-aware 分块，超长 section 子块继承 heading；fenced code 与连续 Markdown table 作为结构块处理；已增加长文档 section retrieval 回归测试。chunk size / overlap 系统 benchmark 仍可继续扩展，但当前结构化分块已纳入全量回归。

当前 chunk size / overlap 已可配置，但没有系统评估。

未完成：

- heading-aware chunk。
- Markdown section-aware chunk。
- table handling。
- code block handling。
- Chinese document chunk。
- chunk size benchmark。
- overlap benchmark。
- long document retrieval evaluation。

---

### 20. OCR 决策

当前不支持纯扫描 PDF OCR。

未完成的是产品决策：

- 统计团队扫描 PDF 占比。
- 决定是否值得加入 OCR。
- 若加入，采用独立 OCR pipeline，避免污染当前文档解析路径。

---

### 21. Knowledge Status / 生命周期

> 2026-09-30 状态：第一版治理闭环已完成。Search 已默认隐藏 deprecated/superseded/expired/archived，draft 降权；Lifecycle Audit 支持 expired/deprecated/superseded/archived/draft/missing-owner/invalid date/review-overdue；Web 展示 overdue/owner/review due，并可从风险项创建 pending Review Candidate 进入审核/MR 流程。

除前文 metadata 外，还需要正式状态：

```tex
draf
active
deprecated
superseded
expired
archived


未完成：

- Search 对 deprecated / expired 降权或默认隐藏。
- 生命周期变更历史。
- Web 状态修改。
- 自动 stale 提醒。
- Review cycle。

---

### 22. Knowledge Owner / Review Cycle

> 2026-09-30 状态：owner、updated_at/created_at、review_cycle_days、review due/overdue、owner missing warning 与 Web overdue view 已完成。Backup Owner / Team 等扩展责任模型仍未实现。

未完成：

- Owner。
- Backup Owner。
- Team。
- Review Date。
- review_cycle_days。
- overdue。
- stale flag。
- Web overdue view。
- Owner missing warning。

---

### 23. Version Applicability

> 2026-09-30 状态：第一版已完成。Knowledge Front Matter 的 `applicability` 已支持 product / branch / firmware version / Yocto release / kernel version / API version / hardware revision / variant；`search_knowledge` 支持可选 applicability context。仅当文档声明了对应约束且调用方提供的上下文不匹配时过滤，未提供 context 时保持原搜索行为；版本/branch pattern 支持 `*` 通配。

OTA / Yocto / API / Kernel 类知识需要标记适用范围：

- product。
- branch。
- firmware version。
- Yocto release。
- kernel version。
- API version。
- hardware revision。
- customer/product variant。

避免旧知识被错误应用到新版本。

---

### 24. GitLab MR 状态回写

> 2026-09-30 状态：已完成第一版。MR reconcile 已回写 opened/merged/closed/locked、pipeline status、has_conflicts、detailed merge status、source branch exists、merged/closed time 与 merge commit SHA；Review Inbox 可手动刷新并展示关键状态。

> 2026-09-30 状态：第一版已完成。已持久化 opened / merged / closed / locked、lastCheckedAt / mergedAt / closedAt / mergeCommitSha，并在 reconcile 时读取 pipeline status、has_conflicts、detailed_merge_status 与 source branch 是否存在；Review Inbox 已展示。

当前只记录 MR URL / IID。

未完成：

- opened。
- merged。
- closed。
- pipeline failed。
- merge conflict。
- source branch deleted。

Candidate 最终状态建议区分：

```tex
mr_open
merged
closed
publish_failed


---

### 25. GitLab Publisher Reconcile

> 2026-09-30 状态：已覆盖 branch exists、open MR 重用、merged/closed 状态读取、target file create/update、identical branch content 幂等、duplicate MR 检测、pipeline/conflict/source branch 状态。409 时会查询 all-state MR：open/merged 可复用，closed 明确拒绝并要求新 Candidate revision/branch，避免误标发布成功。Candidate 在 MR open 后直接编辑并复用同一 MR 仍不支持，当前通过 Candidate 状态不可编辑来避免歧义。

> 2026-09-30 状态：基础 reconcile 已完成：branch exists + open MR 幂等复用、MR state 回写、pipeline/conflict/source-branch 检查。仍可继续补 candidate 在 MR open 后被编辑、title/path 变化、target branch moved 等更复杂同步策略。

已有基础幂等，但还需完整覆盖：

- branch exists + MR open。
- branch exists + MR merged。
- branch exists + MR closed。
- target file deleted。
- target branch moved。
- candidate edited after MR open。
- title changed。
- target path changed。
- MR conflict。
- MR pipeline failure。
- duplicate MR detection。

---

### 26. GitHub Publisher

Publisher abstraction 已经存在，但当前只有 GitLab 实现。

未完成：

- GitHub branch create/update。
- Pull Request。
- existing PR reconcile。
- GitHub token policy。
- GitHub review/merge status。
- GitHub webhook。

---

### 27. Knowledge Gap 聚类

> 2026-09-30 状态：第一阶段已完成。当前对 unmatched query / negative feedback 使用 deterministic 归一化、同义时间表达归一、stop words、token overlap 聚类，并保留 cluster members 与 occurrences。

当前 Gap 基于 unmatched query / negative feedback。

未完成：

将相似 query 聚合，例如：

```tex
Yocto CVE six month policy
Yocto CVE 6个月修复
CVE 180 day rule


第一阶段：

- lowercase。
- punctuation normalize。
- stop words。
- token overlap。
- deterministic clustering。

后续才考虑模型辅助。

---

### 28. Knowledge Gap -> Candidate

> 2026-09-30 状态：Create Candidate 已完成。Web 可从 Gap 创建 pending Knowledge Candidate，并跳转 Review Inbox；生成内容包含 Gap evidence / occurrences / related queries，仍需 Reviewer 补充已验证知识后批准。

Web 上尚未实现：

```tex
Gap
 -> Create Candidate
 -> Assign Owner
 -> Create Task


还应支持：

- dismiss。
- merge gaps。
- mark covered。
- link existing Knowledge。

---

### 29. Observability KPI Dashboard

> 2026-09-30 状态：核心 KPI 已完成。Dashboard 已包含 MCP calls/failures/avg+p95 latency/error rate、active users/sessions、calls/evidence/auto-candidates per session、no-hit、approval/auto-quality、negative feedback、MR merge rate、stale knowledge、duplicate/low-value filtering 等。

当前主要还是日志查看。

未完成 KPI：

- active users/day。
- sessions/day。
- MCP calls/session。
- Skill search hit rate。
- Knowledge search hit rate。
- no-hit rate。
- avg latency。
- p95 latency。
- error rate。
- negative feedback rate。
- auto candidate generated。
- candidate approval rate。
- candidate rejection rate。
- MR publish rate。
- MR merge rate。
- top gaps。
- top used Skills。
- top used Knowledge。
- stale knowledge count。

---

### 30. Session Analytics

未完成：

- average task duration。
- tools used/session。
- Knowledge calls/session。
- repeated searches。
- successful knowledge reuse。
- candidate/session。
- failed tasks/session。
- evidence/session。

---

### 31. Observability Retention / Rotation

> 2026-09-30 状态：第一版已完成。Observability JSONL 默认支持 30 天 retention、5MB size-based rotation、archive 清理、maxEntries 保底裁剪，以及损坏/截断 JSONL 行容错恢复；参数可由 Store 构造选项覆盖。

当前 JSONL 只有基础 compact。

未完成正式策略：

- retention days。
- max file size。
- size-based rotation。
- time-based rotation。
- archive。
- export。
- corrupted last line recovery。
- privacy cleanup。
- old event purge。

---

### 32. Central Logging

当前不需要立即做，但仍属于长期未完成：

- Loki。
- Elasticsearch。
- ClickHouse。
- 公司内部日志平台。

30 人阶段 SQLite + JSONL 仍可继续使用。

---

### 33. Evaluation Admin Web

> 2026-09-30 状态：第一版已完成。Web 已支持 latest/history、baseline/regression、Hit@1/3/5、MRR、repository/suite filter、failed/regression-only 过滤、case expected/actual/rank 详情，以及最近运行 pass-rate 趋势。

未完成：

- latest run。
- baseline。
- regression。
- case detail。
- expected result。
- actual rank。
- Hit@K。
- MRR。
- repository filter。
- failed case filter。
- trend。

---

### 34. Evaluation CI Gate

> 2026-09-30 状态：第一版已完成。CLI/CI Gate 支持 blocking 与 warning threshold：pass rate、Hit@1/3/5、MRR；warning 不影响退出码，blocking 返回非零；baseline regression 与 baseline suite 丢失仍始终阻断。Repository-specific baseline 可通过 `--baseline-path / --baseline-revision` 指定。Baseline update approval 流程仍可继续产品化。

未完成：

```tex
Repository change
 -> Hub evaluation
 -> retrieval regression?
 -> fail / warn MR


需要支持：

- blocking threshold。
- warning threshold。
- repository-specific baseline。
- baseline update approval。

---

### 35. Auto Candidate Quality Evaluation

未完成：

- precision。
- rejection rate。
- duplicate rate。
- useful rate。
- false positive rate。
- missing candidate rate。
- detector version comparison。

这是判断自动回流是否真正可用的关键指标。

---

### 36. Project Identification

> 2026-09-30 状态：第一版已完成。Hook Runtime 1.1.0 在 SessionStart fail-open 采集 git remote/root/branch；服务端优先以 canonical git remote 匹配 Repository，再回退 local path / cwd basename / cwd segment，并将识别结果写入 project_context。Bash / PowerShell setup+upgrade 与 runtime stale 检测均已验证。

SessionStart 尚未自动根据：

- cwd。
- git remote。
- repository root。
- branch。

识别当前 Project。

---

### 37. Project Registry

> 2026-09-30 状态：第一版已完成。新增可选 `projects` 配置模型，支持 repository patterns / owners / preferred skill repositories / preferred knowledge repositories / tools / environments / product / aliases；支持 YAML、Admin Config 持久化和运行时热更新。Project 推荐会使用 profile 偏好，但始终与调用者可见 Repository 求交集。

未完成正式数据模型：

```tex
Projec
- id
- repository patterns
- owners
- preferred skill repositories
- preferred knowledge repositories
- tools
- environments
- produc
- aliases


---

### 38. Project Context Recommendation

> 2026-09-30 状态：第一版已完成。新增 MCP `project_recommendations`：根据 cwd/git remote/root/branch 识别项目，使用 task（无 task 时用 repository/branch 上下文）调用统一 discover，并仅在当前 principal 可见且识别出的 Repository 内返回少量 Skills / Knowledge / Prompts / Agents / Tools，保留 ranking reason。

SessionStart 自动推荐尚未完成：

- Skills。
- Knowledge。
- Prompts。
- Agents。
- Tools。

要求：

- 轻量。
- 不一次塞大量上下文。
- 可解释推荐原因。
- Respect role / tenant / repository permission。

---

### 39. Unified Discover

> 2026-09-30 状态：已完成。MCP `discover` 已统一返回 Skills / Knowledge / Prompts / Agents / Tools，并复用现有 role/tenant/repository 权限过滤。

尚未增加统一 MCP：

```tex
discover


目标：

输入：

- task。
- project。
- repository。
- role。

一次返回统一 ranking：

- Skills。
- Knowledge。
- Prompts。
- Agents。
- Tools。

---

### 40. Tool Registry

> 2026-09-30 状态：第一版已完成。Repository Tool artifact 已具备 type/owner/environments/auth reference/permissions/capabilities/endpoints/version/compatibility，并有 MCP 与 Admin Web 查询入口；凭据仅保存引用，不保存值。

正式 Tool Registry 未完成。

需要数据模型：

```tex
Tool
- id
- name
- type
- owner
- environments
- authentication
- permissions
- capabilities
- endpoints
- version
- compatibility


候选内部 Tool：

- GitLab。
- Jenkins。
- Jira。
- SonarQube。
- Test Farm。
- Device Farm。
- SLT platform。
- OTA backend。
- Log platform。
- Release service。

---

### 41. Agent -> Tool Resolve

> 2026-09-30 状态：第一版解析链已完成。新增 MCP `resolve_agent_tools`，支持 Agent 声明 Tool → caller Repository/visibility/Tool-role permission → client compatibility → environment resolve，并明确返回 resolved / not-visible / environment-mismatch / ambiguous。该入口只返回元数据，不直接 invoke 外部 Tool；实际执行留给后续受控 Adapter。

当前 Agent 的 `tools` 主要仍是声明字段。

未完成：

```tex
Agen
 -> resolve Tool Registry
 -> permission check
 -> environment resolve
 -> invoke


---

### 42. PreToolUse Policy

> 2026-09-30 状态：Policy Engine 第一版已完成，真实 Codex 阻断 Hook 暂不启用。当前已有同步 deterministic allow/deny evaluator 与 Admin simulation API，覆盖 literal secret、destructive command、production confirmation、customer repository write、restricted environment write。现有 observability Hook 继续 async/fail-open，PreToolUse matcher 仍保持 reserved；待确认 Codex 官方同步阻断返回契约后再接薄适配层。

入口已保留但未启用。

未来可实现：

- secret detection。
- destructive command guard。
- production environment confirmation。
- customer repository guard。
- restricted environment guard。

必须明确：

```tex
observability hook:
async + fail-open

policy hook:
sync + explicit allow / deny


不能混用。

---

### 43. Hook Runtime Versioning

> 2026-09-30 状态：第一版已完成。runtime_version / hook_schema_version / setup upgrade / stale runtime detection / Web 展示均已落地。

未完成：

- runtime_version。
- hook_schema_version。
- compatible_hub_version。
- setup --upgrade。
- stale client warning。
- Web 展示 Runtime Version。
- incompatible client warning。

---

### 44. Remote Hook Policy

未来可以由 Hub 提供：

- enabled events。
- sampling。
- limits。
- auto knowledge policy。

但必须保证：

> Hub 不能静默扩大本地数据采集范围。

任何更高采集等级都应由客户端安装配置明确允许。

---

### 45. Codex Plugin 化

> 2026-09-30 状态：第一版已完成。已按 OpenAI 当前 portable Agent Plugins 规范实现版本化构建器 `npm run plugin:build`：生成 root plugin.json、portable mcp.json、Team Skill Hub Skill、跨平台 hooks/hooks.json 与 Hook Runtime/config；MCP bearer token 仅引用环境变量，不写入包。构建器可同时生成 `.agents/plugins/marketplace.json` + `plugins/team-skill-hub` repo marketplace，可通过 `codex plugin marketplace add/upgrade` 分发与更新。Plugin version 直接使用 package.json semantic version；Hook Runtime 支持 PLUGIN_ROOT 下的 plugin-mode 配置，同时保留原 standalone setup 脚本兼容。

当前边界：

- Plugin hooks 安装后仍需按 Codex 官方 trust 流程由用户或管理员信任。
- Hub URL 在构建 package 时注入，避免把 localhost/占位 URL 作为正式分发包。
- 真实企业 managed marketplace / MDM hook trust / 大规模 rollout 仍需在目标企业环境验收。
- 现有 setup-codex-mcp.sh / .ps1 继续作为无 marketplace 环境的兼容安装入口。

---

### 46. Claude Code Adapter

> 2026-09-30 状态：第一版已完成。新增 /client-events/claude-code 原生 HTTP Hook Adapter，把 Claude Code 的 SessionStart / UserPromptSubmit / PostToolUse / Stop / SessionEnd 转换为共享 Client Event v1；PostToolUse 只提取白名单 Evidence，不持久化原始 tool_input/tool_response，UserPromptSubmit 不持久化原始 prompt，Stop 复用现有自动 Candidate Detector。Bash / PowerShell 安装器可幂等合并 ~/.claude/settings.json，并使用用户级 MCP + headersHelper 动态读取 API Key，不把 token 明文写入配置。Session / Evidence / Candidate / Gap / Observability 全部复用现有后端。

后续增强：

- 覆盖更多 Claude lifecycle event，例如 PostToolUseFailure / Subagent。
- 企业 managed settings / managed MCP rollout。
- Claude Plugin package 化。

---

### 47. 其他 Agent / IDE Adapter

> 2026-10-04 状态：通用 Adapter Contract 第一版已完成。`GET /client-events/schema` 现在公开 Agent Adapter contract v1（通用 endpoint、认证策略、稳定 client id 规则、支持事件、metadata policy、Evidence field）；VS Code / JetBrains / CI / internal coding agent 只要能生成共享 Client Event v1 envelope，就直接 POST `/client-events`，不再为每个产品复制后端。新增 `ci_agent` E2E，验证非 Codex / Claude 客户端可复用 Project Context、Evidence、server-side secret redaction 与 Session pipeline。正式契约见 `docs/repository/client-integration.md`。

后续产品接入：

- VS Code Agent：实现 IDE lifecycle -> Client Event v1 的薄客户端 adapter。
- JetBrains Agent：同上。
- CI Agent：按 pipeline/job lifecycle 直接发送通用 v1 event。
- internal coding agent：优先原生输出通用 v1 envelope。
- ChatGPT Work：只有在产品侧存在可用 lifecycle/connector contract 时再实现；当前不伪造不可用接口。

原则：只有上游固定原生 payload/响应契约无法直接输出 v1 时，才增加类似 Claude Code 的服务端专属 adapter。

---

### 48. 数据分类

> 2026-09-30 状态：第一版已完成。平台已定义 metadata / engineering-evidence / knowledge-candidate / source-code / customer-data / sensitive-credential / personal-data / aggregate-metrics / audit 九类数据，并明确 collect / persist / retention / access / audit 属性。source-code、customer-data、sensitive-credential、personal-data 原文默认不采集、不持久化；Admin Settings 可只读审计当前本地安全上限。

尚未形成正式数据分类：

```tex
metadata
engineering evidence
knowledge candidate
source code
customer data
secre
PII


需要定义：

- 是否可采集。
- 是否可持久化。
- retention。
- access control。
- audit。

---

### 49. Retention Policy

> 2026-09-30 状态：第一版已完成。Observability JSONL 不再统一使用一个 retention：client events / MCP metadata 默认 30 天，engineering evidence 90 天，candidate/audit 365 天；测试仍可显式覆盖 retention。归档清理与 compact 均复用同一分类 retention。

不同数据类型保留周期尚未正式定义。

例如：

- ClientEvent。
- MCP call metadata。
- Evidence。
- aggregate metrics。
- audit。
- candidate history。

---

### 50. Redaction 规则扩展

> 2026-09-30 状态：第一版已完成。Observability 与 Usage Analytics 已覆盖 email、GitHub/GitLab/Skill Hub token、AWS access key、Bearer、JWT、PEM private key、URL credential、数据库 connection string 与常见 password/token/secret/api-key 字段；已有专项回归测试。

现有基础规则还应覆盖：

- JWT。
- private key。
- AWS Access Key。
- GitLab PAT。
- GitHub PAT。
- bearer token。
- URL credential。
- DB connection string。
- cloud credentials。
- customer identifiers。

---

### 51. Admin Authorization

当前主要依赖 Admin Key。

未来如进入正式生产，需要考虑：

- SSO。
- RBAC。
- reviewer role。
- publisher role。
- auditor role。
- read-only admin。

---

### 52. Backup / Restore

> 2026-09-30 状态：第一版已完成。新增 `npm run backup:data -- --out <dir>` 与 `npm run restore:data -- --backup <dir>`。备份覆盖整个 DATA_DIR（含 admin config、API key hashes、observability、candidate history、revisions、evaluation runs 等），带 manifest + 每文件 SHA-256；恢复前完整校验，默认拒绝覆盖非空 DATA_DIR，`--force` 会先保留旧目录为 pre-restore 快照，支持 `--verify-only`。

正式流程未完成。

需要覆盖：

- DATA_DIR。
- admin config。
- managed API key hashes。
- observability。
- candidate history。
- revisions。
- evaluation baseline。
- Knowledge review metadata。

---

### 53. Disaster Recovery

未完成：

- volume lost。
- rebuild from Git。
- restore config。
- restore candidate state。
- restore audit。
- restore evaluation baseline。
- restore API key metadata。

---

### 54. Health Check 扩展

> 2026-09-30 状态：第一版已完成。保留现有 live/ready 语义，新增 Admin Operational Health：repository stale / repeated failures、Candidate backlog、Knowledge lifecycle issues / review-overdue / expired / missing-owner，以及 DATA_DIR 磁盘使用率；Observability Web 已展示。

已有 live / ready。

还可增加：

- GitLab connectivity。
- repository stale。
- write token readiness。
- FTS DB status。
- disk usage。
- webhook last seen。
- publishing queue。
- candidate backlog。

---

### 55. Alerting

> 2026-09-30 状态：第一版已完成。Admin API / Dashboard 会基于保守阈值生成 warning / critical 活动告警，覆盖 repository repeated sync failures / stale、repeated publish failures、MCP error rate、no-hit rate、negative feedback、DATA_DIR disk usage、candidate backlog 与最新 Evaluation regression。外部通知通道仍可后续扩展。

未完成：

- repository sync failures。
- webhook failures。
- repeated publish failures。
- MCP error rate。
- no-hit rate。
- high negative feedback。
- disk usage。
- stale repositories。
- candidate backlog。
- evaluation regression。

---

### 56. 30 人规模压测

> 2026-09-30 状态：第一版可重复 Capacity Harness 已完成。新增 `npm run benchmark:capacity`，默认 30 virtual users / 10k Knowledge chunks，覆盖并发 FTS search 与 Observability metadata 写入，并输出 QPS/p50/p95/写错误/持久化条数。Observability append+compact 已增加串行写队列，30-user correctness test 验证无丢写。当前环境 10k/600 searches 约 101 QPS、p50 9.6 ms、p95 11.2 ms，90 writes 0 error/0 loss。

未完成：

- concurrent MCP requests。
- concurrent search。
- webhook + search。
- candidate submission。
- Admin dashboard。
- evaluation workload。
- publishing request。
- multiple active Codex sessions/user。

---

### 57. SQLite Capacity 验证

> 2026-09-30 状态：第一版 10k/50k/100k Knowledge chunk 容量基线已完成，Benchmark 同时输出 index build time、SQLite page count/page size/approx bytes 与 process heap used。当前环境：50k chunks 构建约 2.2s、FTS ~19.4 MB、p95 ~67.6 ms；100k chunks 构建约 5.0s、FTS ~36.8 MB、heap ~166 MB、p95 ~119 ms（30 users，小查询轮次）。后续应在目标部署机器上持续记录趋势，而不是把这些环境数值硬编码成 CI 阈值。

需要测试：

- FTS corpus size。
- concurrent readers。
- write contention。
- evaluation workload。
- JSONL + SQLite 同时写。
- large repository sync。

---

### 58. JSONL Compaction 正式化

> 2026-09-30 状态：已完成第一版。当前支持 classification-specific time retention、size-based rotate、archive、corruption-tolerant read/repair、recovery test、并发写串行队列；compact 主文件与 archive 均使用同目录临时文件 + rename 原子替换，并验证不会残留 temp 文件。

未完成：

- atomic rotate。
- size-based rotate。
- time-based rotate。
- archive。
- corruption handling。
- recovery test。

---

### 59. Web Navigation

> 2026-09-30 状态：第一版已完成。Admin Web 使用 hash route 保存 Tab 状态，支持 browser back/forward；Candidate 支持 `#review?candidate=<id>` 精确 deep-link（服务端按 id 查询），Session 支持 `#observability?session=<id>&actor=<id>&tenant=<id>` 直接打开详情。现有顶部 Tab 保留，sidebar 属于后续纯布局优化。

当前有 Tab，但未完成：

- sidebar。
- route state。
- URL deep-link。
- browser back/forward。
- direct open candidate/session。

---

### 60. Web Large Datase

> 2026-09-30 状态：第一版已完成。Client Events、Auto Candidate Decisions、Feedback、Review Candidates 支持统一 `limit + cursor + q` 服务端分页/搜索；Review 原有 status/repository/source/reviewer/automatic 继续服务端过滤；Admin Web 提供上一页/下一页、总数与搜索，并把 q/cursor/filter 写入 URL hash query，刷新及浏览器前进/后退可恢复状态。当前单页限制为 Candidate 25 条、其他高增长列表 50 条，因此首版用 bounded paging 控制 DOM 数量，不额外引入复杂 virtual-list；若未来单页规模提高再增加虚拟化。

当前部分页面仍一次性加载。

未完成：

- pagination。
- server-side filtering。
- server-side search。
- virtual list。
- query state。

---

### 61. Web 操作体验

> 2026-09-30 状态：第一版已完成。Admin 新增统一 modal、toast、危险确认和可取消表单；Review 审核原因使用 select、备注使用 textarea，GitLab 发布/API Key 删除使用明确确认；Gap/Lifecycle Candidate 创建及 Preview/Review/Publish/Reconcile 错误统一 toast。原生 `alert/confirm/prompt` 已清零；Candidate 保存、批准/拒绝、重新批准、发布、MR 刷新和 Lifecycle Candidate 创建在请求期间会 disable 按钮并显示 busy 文案，降低重复提交风险。

当前部分功能仍使用浏览器原生：

- prompt。
- alert。
- confirm。

未完成统一：

- modal。
- toast。
- inline validation。
- loading state。
- retry。
- optimistic/disabled states。

---

### 62. Dashboard Charts

> 2026-09-30 状态：第一版已完成。新增 `dashboard-trends` Admin/v1 API，支持 7–90 天按日汇总 MCP Calls、Errors、No-hit、Candidates、Approvals、Knowledge Gap Signals、Active Users、Avg Latency；Dashboard 默认展示 14 天趋势，使用原生响应式 SVG sparkline，无额外图表依赖。Approval 当前按已批准/发布候选最近 `updatedAt` 聚合，No-hit/Gap/Latency 等口径由 API `semantics` 明示。focused E2E、build、Admin JS 解析及全量 `npm run check` 均通过，当前 78/78 PASS。

未完成趋势图：

- calls/day。
- errors/day。
- no-hit/day。
- candidates/day。
- approval trend。
- gaps trend。
- active users。
- latency。

---

### 63. OpenAPI

> 2026-09-30 状态：第一版已完成。提供 `/openapi.json`（OpenAPI 3.1），覆盖 REST v1 metadata、health、admin health/alerts/KPI/knowledge-gaps 与 client-event schema discovery；后续可继续补全所有写 API 的 request/response schema 和 SDK 生成。

当前没有正式 OpenAPI。

未完成：

- request schema。
- response schema。
- admin API docs。
- client event API docs。
- generated SDK possibility。

---

### 64. API Versioning

> 2026-09-30 状态：第一版已完成。新增 `/api/v1` 稳定读接口（meta、health、admin health/alerts/KPI/knowledge-gaps），旧路径继续兼容，并通过 `x-skill-hub-api-version` 返回版本。

未完成正式：

```tex
/api/v1


目前主要使用现有路径。

---

### 65. Client Event Schema Version

> 2026-09-30 状态：已完成 v1 兼容策略。显式 v1 正常接收；历史缺省版本按 v1 兼容；显式未知/非法版本拒绝并返回支持范围；提供 `/client-events/schema` 与 `/api/v1/client-events/schema` discovery。

已有 schemaVersion 字段，但未完成：

- version validation。
- backward compatibility。
- unsupported version handling。
- upgrade policy。

---

### 66. Repository Governance

> 2026-09-30 状态：第一版已完成。Repository 配置支持可选 `owners`；Admin Governance 汇总展示全部配置仓库（包括 disabled）、last sync / last success / last good revision、sync lag、failure count、webhook 配置与最近 webhook 结果，并对 missing-owner / sync-lag / webhook error 给出治理问题提示。提供 legacy 与 `/api/v1` Admin API，并在 Dashboard 展示。

未完成：

- Repository Owner。
- last sync。
- last good revision。
- sync lag。
- webhook health。
- validation errors。
- allowed Skill paths。
- allowed Knowledge paths。
- publishing allowed。
- required reviewer。

---

### 67. Skill Governance

> 2026-09-30 状态：第一版治理视图已完成。Skill 已有强制 owner、maturity（含 deprecated）、version、compatibility、depends_on；Governance 汇总 usage、正/负 feedback、evaluation coverage、duplicate-name、missing-version 与 deprecated 状态。后续仍可深化 supersedes、stale policy 和低价值清理规则。

未完成：

- Skill Owner。
- status。
- deprecated。
- version compatibility。
- supersedes。
- stale detection。
- usage analytics。
- duplicate Skill。
- low-value cleanup。

---

### 68. Prompt Governance

> 2026-09-30 状态：第一版治理视图已完成。Prompt 已有强制 owner、version、compatibility，重复 name 在 Repository activation 前校验；Governance 汇总 usage、正/负 feedback、evaluation coverage、duplicate-name 与 missing-version。后续仍需正式 deprecated/status schema。

未完成：

- Prompt version。
- owner。
- usage。
- evaluation。
- deprecated。
- compatibility。
- duplicate Prompt。

---

### 69. Agent Governance

> 2026-09-30 状态：第一版治理视图已完成。Agent 已有强制 owner、version、compatibility、skills/prompts/tools bindings；Tool Registry resolve 与 permission/environment filtering 已实现。Governance 汇总 usage、feedback、evaluation coverage、capability 数量、tool binding readiness、duplicate-name 与 missing-version。后续仍可深化正式 status/deprecation schema。

未完成：

- Agent owner。
- capabilities。
- Tool Registry resolve。
- permissions。
- version。
- compatibility。
- evaluation。
- usage。

---

### 70. Knowledge / Skill 统一质量指标

> 2026-09-30 状态：第一版已完成。Governance 页面统一展示 Skill / Knowledge 的 top-1 search selection、resolve/load reuse、reuse rate、last-use age、positive/negative feedback、stale-by-usage；Knowledge 额外展示 review age/cycle/overdue 与 Candidate update count。指标只用于治理观察，明确不自动删除内容，也不把代理指标包装成主观质量分。

可增加：

- usage。
- positive feedback。
- negative feedback。
- search rank。
- reuse rate。
- stale age。
- review freshness。
- candidate update count。

这些只作为治理指标，不自动删除内容。

---

### 71. LLM-assisted Knowledge Curation

> 2026-09-30 状态：第一版已完成，并保持 opt-in。新增 vendor-neutral HTTP Curator contract，通过 `KNOWLEDGE_CURATOR_URL` 启用、token 仅由 `KNOWLEDGE_CURATOR_TOKEN_ENV` 指向环境变量；支持 pending Candidate 的标题/精简正文/分类/建议路径/Skill-vs-Knowledge/conflict hint，以及 Knowledge Gap clustering。所有模型输出先经过 deterministic guard（schema、长度、安全路径、类型、Gap membership/唯一性），UI 必须由 Reviewer 明确“应用建议”；应用后 Candidate 仍为 pending，不能自动 approve/publish，也没有 direct Knowledge write。未配置 Curator 时 deterministic detector/Gap clustering 完全不受影响。Curator 单测 4/4，Admin E2E/build/JS 与全量 `npm run check` 均通过；加入 Claude Code Adapter、Codex portable plugin、通用 Agent Adapter Contract、Sandbox/Registry acceptance harness 后当前全量为 91/91 PASS。

后续可以增加模型辅助：

- Candidate title。
- concise summary。
- category。
- suggested path。
- Skill vs Knowledge。
- conflict hint。
- Gap clustering。

约束：

- deterministic guard。
- Human Review。
- LLM 不直接写正式 Knowledge。

---

### 72. 缺失文档

> 2026-09-30 状态：清单中的 12 份专项文档已补齐：
> `client-integration.md`、`client-integration.md`、`client-integration.md`、`evaluation-and-candidates.md`、`evaluation-and-candidates.md`、`../developer/developer-guide.zh-CN.md`、`../developer/developer-guide.zh-CN.md`、`../deployment/deployment-guide.md`、`../deployment/deployment-guide.md`、`../deployment/deployment-guide.md`、`../developer/developer-guide.zh-CN.md`、`release-guide.md`。内容以当前实现、命令和实际安全边界为准。

还应新增：

- Hook Architecture。
- Client Event Schema。
- Evidence Schema。
- Auto Candidate Policy。
- Retrieval Evaluation Guide。
- Knowledge Lifecycle Guide。
- Review Workflow。
- Backup / Restore。
- Disaster Recovery。
- Upgrade Guide。
- Troubleshooting Guide。
- Release Guide。

---

### 73. 测试体系补全

> 2026-09-30 状态：关键缺口已补齐。Unit 新增 Client Event 自然键幂等与 Timeline 顺序测试；E2E 验证重复 Stop 返回同一 event_id 且不会重复触发 Candidate；Integration 新增完整闭环：SessionStart/PostToolUse/Stop -> 自动 Candidate -> Reviewer approve -> GitLab MR mock -> 模拟人工 merge -> 真实 Git Repository Sync -> 新 Knowledge 可检索/加载。当前 `npm run check` 为 91/91 PASS。后续仍可按真实故障复盘继续扩充边界测试，但不再是当前主阻塞项。

#### Uni

还需：

- candidate relation。
- conflict。
- lifecycle metadata。
- event ordering。
- event duplicate。
- hook schema version。
- project context。
- discover ranking。

#### Integration

还需：

- full session。
- evidence。
- auto candidate。
- review。
- GitLab mock publish。
- simulated merge。
- repository sync。
- retrieval after publish。

#### E2E

最终至少要有：

```tex
Codex-like Hook events
 -> MCP search
 -> test evidence
 -> Stop
 -> auto Candidate
 -> Admin approve
 -> GitLab mock MR
 -> simulated merge
 -> repo sync
 -> search new Knowledge
 -> Evaluation


---

### 74. 真实 GitLab Sandbox 验收

> 2026-10-04 状态：真实环境验收仍未执行，但仓库内已新增两阶段 `npm run sandbox:acceptance` 验收 CLI 与 mock E2E。`prepare` 会通过 Hub 创建 manual Knowledge Candidate、人工审批、使用真实 GitLab write token 创建 branch/MR，并输出 MR URL/marker；脚本不会自动 merge。人工 merge 后运行 `verify`：先 reconcile MR 状态，要求 audit 中存在 merge 时间之后的成功 webhook sync，再执行 manual read-only repository sync，最后用 Admin Knowledge Search 验证唯一 marker 可被 RAG 检索，并回读 Candidate publication merged 状态。这样首次真实 sandbox 执行可以产出机器可复核证据，同时保留 Human Merge 治理边界。

Mock 测试通过不等于生产闭环完成。

需要在 sandbox Repository 完成：

- real read-only clone。
- real webhook。
- real write token。
- real branch。
- real MR。
- human merge。
- merge webhook。
- Hub sync。
- RAG search。
- Candidate 状态回写。

第一次不能直接在生产 Knowledge Repository 验证。

推荐执行：

```bash
export ADMIN_API_KEY='<sandbox-admin-key>'
npm run sandbox:acceptance -- --phase prepare --hub-url https://sandbox-skill-hub.example.com --repository rd-skills
## 在 GitLab Web UI 审核并人工 merge 输出的 MR
npm run sandbox:acceptance -- --phase verify --hub-url https://sandbox-skill-hub.example.com --repository rd-skills --candidate-id <id> --marker <marker>


只有第二阶段在真实 GitLab sandbox 上成功后，才能把本项标记为完成。

---

### 75. Release / Versioning

> 2026-10-04 补充：新增 `npm run release:registry-acceptance` Registry 验收 harness。真实 tag 发布后，它会 pull release tag / SHA tag / rollback tag，校验 release 与 SHA 指向同一 content-addressed image ID、三者存在 RepoDigest、release 镜像内部 package version 正确、rollback 镜像仍可获取。仓库测试只验证 harness 逻辑，不能替代实际 GHCR/Registry 验收。

> 2026-09-30 状态：仓库内第一版 Release 流程已完成。项目使用 package.json semantic version；新增 CHANGELOG.md、逐版本 migration notes、`npm run release:check`；Docker workflow 在构建镜像前执行 `npm run check`，`v*` tag 发布时强制校验 tag 与 package version 一致，并继续发布 tag/SHA immutable image references。`v0.1.0` 校验通过，当前全量测试 91/91 PASS。首次真实 tag -> registry image -> rollback image 的 CI/Registry 验收仍属于部署环境验收项，但现在已有可重复执行的 Registry acceptance harness。

仓库内已完成：

- semantic version。
- changelog。
- migration notes。
- immutable tag/SHA image workflow。
- release checklist / `release:check`。
- Registry acceptance harness。

外部环境仍待验收：

- 真实 Git tag 触发 GitHub Actions 并成功发布 GHCR image。
- 运行 `release:registry-acceptance` 验证 release tag / SHA tag / rollback image。
- 在实际部署主机完成一次升级到新 immutable image，再切回 rollback image 并验证 ready/MCP 基础功能。

---

## 完整最终完成标准

项目只有达到以下体验才算核心目标完成。

#### 普通开发者

只需要：

```tex
打开 Codex
正常提需求
正常开发


无需主动说：

```tex
搜索 Skill
搜索 Knowledge
上传知识
生成 Candidate


#### Agen

自动：

- 识别 Project。
- 使用团队资产。
- 记录 Evidence。
- 发现 Knowledge Gap。
- 发现过期/冲突知识。
- 提交高质量 Candidate。

#### 管理员

主要关注：

- Review Inbox。
- Conflict。
- Knowledge Gap。
- Retrieval Regression。
- Platform Health。

#### Gi

继续作为 Source of Truth。

#### Hub

继续不承担 Model Gateway。

---

## 完整推荐开发顺序

### Phase A — 当前收尾

1. 自动 Knowledge 默认行为统一。
2. Retrieval Evaluation 专项测试。
3. Candidate update / supersede / conflict。
4. 当前工作区 diff review。
5. build/test。
6. commit/push。

### Phase B — 自动知识质量

7. Evidence Schema。
8. Detector reason / skip reason。
9. rate limit。
10. near duplicate。
11. conflict detection。
12. existing Knowledge update flow。

### Phase C — Web / Governance

13. Review Inbox 产品化。
14. Session Timeline。
15. KPI Dashboard。
16. Knowledge Lifecycle。
17. MR status reconcile。

### Phase D — Project Contex

18. Project Registry。
19. SessionStart Project Detection。
20. Recommendation。
21. Unified Discover。

### Phase E — Platform

22. Tool Registry。
23. Agent -> Tool Resolve。
24. PreToolUse Policy。
25. Runtime Versioning。
26. Upgrade mechanism。

### Phase F — Distribution

27. Codex Plugin。
28. Claude Code Adapter。
29. Other Agent Adapter。

### Phase G — Production Maturity

30. Backup / Restore。
31. DR。
32. Alerting。
33. Load Test。
34. SSO/RBAC（如需要）。
35. Release Process。


## Admin UI 信息架构与多级页面重构任务

> 状态：已完成（核心范围）（已完成观测与 Candidate Review / Knowledge Gaps / Repository Governance 的稳定一级、二级、三级入口及 bounded API；旧 hash UI 仍兼容；Knowledge/Eval/Access legacy migration remains future work）
> 创建时间：2026-10-13
> 目标：解决 Admin UI 随用户数、Session、Hook、Candidate、Knowledge Gap 等数据增长后页面过长、信息拥挤、定位困难的问题。

### 1. 背景

当前实现说明：`/admin/observability` 返回稳定的模块索引；Sessions、Hooks、Candidate detections、MCP calls 使用稳定资源 API（默认分页 20，最大 100），旧 `/admin` hash-tab 入口继续兼容。JSONL 存储仍保留，详情读取保持 bounded scan 语义，不引入数据库。

本轮补充：所有 `/admin/observability/*` pathname 路由使用独立 no-store UI shell，列表通过 URL 驱动服务端过滤/分页，详情直接请求按 ID API。新增 `reuse`（从既有 MCP calls 派生 discover/search/get knowledge/skill 调用）和 `failures`（当前仅失败 MCP calls）稳定列表/详情 API；两者均支持 q/tool/actorId/sessionId/from/to。Candidate Review、Knowledge Gaps、Repository Governance 也已切换为独立 no-store 模块 shell：根路径只展示入口卡片，候选、缺口、仓库治理分别提供列表和按 ID 详情 API；默认分页 20、上限 100，服务端执行状态/关键词过滤。旧 `/admin` hash-tab 入口继续兼容。

当前 Admin Web 多个模块把“统计、筛选、长列表、详情、操作、原始数据”集中在同一个一级页面中。

典型问题：

- `运行观测` 中 Codex Session 数量增长后页面会非常长；
- Hook、自动候选判定、MCP 调用、Evidence 等信息继续增长后会进一步挤压页面；
- Candidate、Knowledge Gap、Repository Governance、Evaluation、Access Control 等模块也存在同类扩展性问题；
- 一级页面承担了过多职责，用户进入模块后很难快速找到真正想看的数据类型；
- 当前部分列表缺少完善的服务端分页、组合过滤、URL 状态保持和详情页。

本次重构原则不是简单“给现有长表加分页”，而是统一 Admin UI 的信息架构。

### 2. 核心设计原则

采用统一的三级结构：

```text
一级：功能清单 / 模块入口 + 少量摘要统计
  ↓
二级：某类数据的筛选 + 分页列表
  ↓
三级：单条记录完整详情
```

#### 2.1 一级页面

一级页面不直接展示完整数据列表，只展示该模块下面有哪些能力、每个入口的少量关键摘要统计，以及进入二级页的入口。数据量增加时一级页高度应基本稳定。

示例：

```text
运行观测

[Codex 会话]
26 sessions · 2 active · 1 failure · 最近 16:23

[Hook 执行]
120 executions · 3 failed · 最近 16:20

[自动候选判定]
45 detections · 6 accepted · 12 ignored

[MCP 调用]
1,250 calls · 8 failed

[Knowledge Reuse]
64 reuses · 18 sessions

[错误与失败]
12 unresolved
```

一级页不要渲染完整 Session/Hook/Candidate 表格。

#### 2.2 二级页面

二级页面用于某一类资源的检索和列表浏览：服务端分页、多条件过滤、统一搜索、默认按最近时间倒序、行可点击进入三级详情，并通过 URL 保存过滤和分页状态。

#### 2.3 三级详情页

三级详情页展示完整信息和关联信息，包括基本元数据、Timeline / Events、关联实体、Evidence、错误、原始数据和必要操作按钮。详情页优先使用稳定 URL，而不是只使用弹窗。

### 3. 运行观测重构

一级入口 `运行观测` 建议包含以下功能清单。

#### 3.1 Codex 会话

路由建议：

```text
/admin/observability/sessions
/admin/observability/sessions/:sessionId
```

二级列表支持：User、Repository、Runtime、Event、Status（ALL / ACTIVE / ENDED / FAILED）、开始/结束时间、Project、Session ID、关键字搜索、仅有 MCP 调用、仅有 Evidence、仅有 Knowledge reuse。

列表建议列：

```text
开始时间 | User | Session | Repository | Runtime | Events | MCP | Evidence | Status | 操作
```

要求：

- Session ID 缩短显示，保留复制完整 ID；
- 每页默认 20 条，支持 20 / 50 / 100；
- 默认开始时间倒序；
- 服务端分页，不允许一次加载所有 Session；
- 显示总数或至少稳定的 next/previous cursor；
- 点击行进入详情。

三级 Session 详情至少包含：

```text
Overview
Timeline / Events
MCP Calls
Evidence
Knowledge / Skill Reuse
Errors
Raw Data
```

#### 3.2 Hook 执行

路由建议：

```text
/admin/observability/hooks
/admin/observability/hooks/:id
```

二级过滤：Hook 类型、User、Session、Project、Status、是否产生 Candidate、时间范围。

三级详情：trigger、来源、input/output 摘要、执行耗时、成功/失败、错误原因、关联 Session、Candidate、Evidence、Raw Event。

#### 3.3 自动候选判定

路由建议：

```text
/admin/observability/candidate-detections
/admin/observability/candidate-detections/:id
```

二级过滤：User、Session、suggestedType、判定结果（candidate / ignored / rejected / duplicate）、repository、sourceType、confidence/score、时间范围。

三级详情重点展示为什么触发自动候选判定、score/confidence、命中/未通过规则、suggestedType、recommended repository、source session/hook/evidence、是否最终创建 Candidate、Candidate ID、被忽略/拒绝原因和原始 detection payload。

目标是让管理员能解释“为什么这一条被系统判定为值得回流”。

#### 3.4 MCP 调用

路由建议：

```text
/admin/observability/mcp-calls
/admin/observability/mcp-calls/:id
```

过滤：tool、user、session、repository、success/failure、latency、时间范围。

详情：tool 名称、调用时间、脱敏参数摘要、result 摘要、latency、error、关联 Session、Knowledge / Skill、Raw event。

#### 3.5 Knowledge / Skill Reuse

路由建议：

```text
/admin/observability/reuse
/admin/observability/reuse/:id
```

用于回答哪些 Knowledge / Skill 真正被使用、谁在使用、在哪个 Session 使用、discover/get_skill/get_knowledge 链路，以及复用后是否继续产生 Candidate / Feedback。

#### 3.6 错误与失败

路由建议：

```text
/admin/observability/failures
/admin/observability/failures/:id
```

聚合 Session failure、Hook failure、MCP failure、Candidate publish failure、Repository sync failure、Evaluation failure，并支持来源类型、时间、用户、仓库、错误关键字过滤。

### 4. 其他一级模块的多级页面设计

#### 4.1 候选审核

一级页面改为功能清单：待审核、已批准、已拒绝、发布失败、已发布。

二级显示对应状态 Candidate 列表；三级显示 Candidate 完整详情，包括 title/type/collection、repository/path、完整正文、source/session/trace、Evidence、duplicate/relation、review 信息、publication、PR/MR、reconcile 和审核/发布历史。一级/二级页不要直接展开完整正文。

#### 4.2 知识缺口

一级可包含：活跃缺口、已生成 Candidate、已解决、忽略项。

二级支持 query、repository、occurrence、source、status、时间范围、是否有关联 Candidate 等过滤；三级展示 gap key、occurrences、firstSeen/lastSeen、相关 queries、关联 sessions/Evidence/Candidate 和 lifecycle history。

#### 4.3 治理

一级建议入口：仓库治理、同步记录、发布记录、PR/MR 状态、配置检查。

仓库治理二级显示 Repository 清单；三级显示 revision、health、branch、provider、last sync、sync history、最近错误、资产数量、publishing config 摘要、最近 Candidate、最近 PR/MR。`立即同步` 可以保留在列表页。

#### 4.4 知识库

一级入口建议：Knowledge、Skill、Prompt、Agent、Repository。

二级为资产搜索列表；三级为资产详情，包括 metadata、repository/path、revision/version、正文、最近命中、reuse 统计、来源 Candidate、关联资产。

#### 4.5 评测

一级入口：Evaluation Runs、Retrieval Evaluation、Regression、Baselines。

二级为 run 列表；三级展示 evaluation metadata、cases、pass rate、failed cases、asset version、baseline comparison、regression details。

#### 4.6 用户反馈

一级可按待处理、已处理、负向反馈、资产反馈拆分；三级详情关联 user、session、Knowledge / Skill、Candidate、原始 feedback 和后续处理动作。

#### 4.7 访问控制

一级入口：用户、API Key、Role、Repository 权限。

二级使用列表 + 搜索 + 分页；三级展示 identity、roles、repository access、API key 状态、最近访问、失败访问、audit history。敏感 key 内容不得显示。

#### 4.8 系统设置

系统设置不强制使用三级资源页面，更适合 section / tabs，例如 General、Repository、Publishing、Authentication、Observability、Advanced。

### 5. 通用 UI 组件要求

不要为每一个模块重复实现一套列表逻辑，建议统一：

- `ModuleIndex / EntryCard`：title、description、count、warning/failure count、recent timestamp、target route；
- `FilterBar`：keyword、select、date/time range、boolean quick filters、Apply、Clear；
- `Pagination`：默认 20，支持 20/50/100，prev/next，total 可选；
- `DetailPage`：breadcrumb、back link、title、status badge、metadata grid、tabs/sections、raw JSON、related entities；
- `StatusBadge`：成功态、中性态、错误态、进行态统一视觉。

过滤条件必须同步到 URL query，刷新后保持，从三级详情返回二级页时恢复原过滤状态。

### 6. 后端 API 设计要求

必须优先做服务端过滤和分页，避免“API 返回全部数据，浏览器再过滤”。

推荐统一参数：

```text
limit
cursor 或 page
q
status
user
repository
runtime
sourceType
from
until
sort
order
```

特定模块可增加 `hasMcp`、`hasEvidence`、`hasReuse`、`tool`、`suggestedType`、`candidateResult`、`hasCandidate` 等参数。

建议统一返回：

```json
{
  "items": [],
  "page": {
    "limit": 20,
    "nextCursor": "...",
    "previousCursor": "...",
    "total": 123
  }
}
```

如果底层不适合提供 total，则 total 可选，不要为了 total 强制全量扫描大 JSONL。

#### 6.1 单条详情 API

不要让三级详情页通过“加载 2000 条再 find(id)”实现。逐步增加按 ID 获取接口，例如：

```text
GET /admin/api/sessions/:id
GET /admin/api/hooks/:id
GET /admin/api/candidate-detections/:id
GET /admin/api/mcp-calls/:id
GET /admin/api/knowledge-candidates/:id
GET /admin/api/knowledge-gaps/:id
GET /admin/api/repositories/:id
```

### 7. 路由实现注意事项

当前 Admin Web 主要由 `src/admin-ui.ts` 输出单页 HTML，需要先评估：

1. 保持单 HTML + hash route：改动小，但 URL 不自然且 `admin-ui.ts` 继续膨胀；
2. 服务端支持 `/admin/*` fallback + History API：推荐优先考虑，可使用 `/admin/observability/sessions/:id`；
3. 如果 `admin-ui.ts` 继续显著膨胀，再评估独立 frontend build。本次不要求强制引入 React/Vue/Next.js。

### 8. 性能与可扩展性要求

目标场景至少考虑：

```text
30+ users
10,000+ sessions
100,000+ MCP/client events
10,000+ Hook records
1,000+ candidates
持续增长的 JSONL observability 数据
```

要求：一级页不能依赖加载全部明细；二级页不能一次返回所有记录；时间过滤尽量服务端完成；搜索有合理上限；详情 API 只读取目标记录；不破坏当前 observability 写入格式；如需索引，必须兼容旧数据。

### 9. 错误处理要求

与 `project-plan.md` 中 Admin Web API 请求层统一事项协同实现。统一使用 `requestJson()` / `readResponse()`，保证 endpoint 和 HTTP status 可诊断、非 JSON 返回不导致整页崩溃、局部统计失败不阻断其他入口，并统一 loading / empty / error 状态。

### 10. 安全要求

- 不显示 API key/token/Authorization；
- Raw Data 继续使用服务端脱敏结果；
- URL query 不得放 token；
- 用户只能看到有权限访问的 Repository 相关记录；
- 三级详情 API 必须执行与列表相同的权限检查；
- MCP 参数和 Hook payload 继续脱敏。

### 11. 推荐实施顺序

#### Phase 1：公共框架

Admin `/admin/*` routing、ModuleIndex/EntryCard、FilterBar、Pagination、DetailPage、StatusBadge、URL query state、统一 requestJson/readResponse。

#### Phase 2：运行观测

Codex Sessions -> Hook Executions -> Candidate Detections -> MCP Calls -> Knowledge Reuse -> Failures。

#### Phase 3：Candidate / Gap

候选审核、Knowledge Gap、用户反馈。

#### Phase 4：Governance / Knowledge / Eval / Access

Repository Governance、Knowledge / Skill、Evaluation、Access Control。

#### Phase 5：清理旧 UI

删除被新二级页替代的旧长表和重复筛选/分页逻辑，清理无用 CSS/JS，更新 Admin 用户文档。

### 12. 兼容要求

- 现有 `/admin` 入口继续可用；
- API Key Admin Authentication 不变；
- Repository sync / publish / review 等现有操作能力不丢失；
- 现有数据无需人工迁移即可查看；
- 旧 API 在新 UI 切换完成前不要过早删除；
- 页面缓存继续保持 `no-store`。

### 13. 测试要求

Backend 至少覆盖分页、搜索、组合过滤、时间过滤、单条详情 404、ACL、Admin access denied、大数据量返回上限。

Frontend/HTML 至少覆盖一级入口、一级无长列表、二级列表加载、Apply/Clear、URL query 恢复、Pagination、detail navigation、Back 恢复过滤、empty/error/loading、状态 badge。

WSL2 Docker 真实 smoke 至少验证：

```text
/admin
/admin/observability
/admin/observability/sessions
/admin/observability/sessions/:id
```

并验证真实 Session、ACTIVE/ENDED、MCP/Evidence，以及分页不会造成页面无限增长。

### 14. 非目标

暂不要求为了 UI 重构迁移 Observability 到大型数据库、强制引入前端框架、重写 MCP/Knowledge 核心逻辑、改变 Candidate 审核策略、改变 Repository 配置格式或引入复杂图表库。

### 15. 完成标准

- `运行观测` 一级页只显示功能清单和摘要，不再显示长 Session 表；
- Codex Session、Hook、自动候选判定至少形成“一级入口 -> 二级列表 -> 三级详情”；
- 二级列表使用服务端过滤和分页；
- URL 可保存筛选条件；
- 单条详情不通过加载全量列表实现；
- 候选审核、Knowledge Gap、治理等主要模块迁移到相同信息架构，或至少完成明确迁移入口；
- 30+ 用户、万级 Session 情况下 Admin 页面不会因 DOM 全量渲染持续增长；
- Docker build、相关测试和实际 Admin smoke test 通过；
- 更新用户/Admin 文档。

### 16. 新会话建议提示词

```text
使用 WebCodex，在 team-skill-hub 项目中实现 docs/repository/implementation-history.md。

要求：
1. 使用 WSL2 Ubuntu-24.04 完成测试、构建、Git 操作。
2. 先阅读该文档和当前 src/admin-ui.ts、src/server.ts、observability/admin API 实现，再给出分阶段改造计划。
3. 不要一次性盲目重写 Admin UI，先建立公共 routing/filter/pagination/detail 基础，再优先实现运行观测：Codex 会话、Hook、自动候选判定。
4. 一级页面只显示功能清单和摘要统计，不直接显示长数据列表。
5. 二级页面使用服务端分页和过滤；三级页面提供单条详情。
6. 保持当前 Admin auth、ACL、Repository sync、Candidate review/publish 等行为兼容。
7. 每个阶段使用 WSL2 Docker 验证，确认无回归后再继续。
8. 实现完成后 review diff，再 commit + push。
```


## Team Skill Hub SQLite 存储迁移设计

> 状态：实现完成（Ubuntu-24.04 WSL2 + Docker 已完成 SQLite 切换验证）
> 创建时间：2026-10-13
> 目标：将当前以 JSONL 为主的运行观测存储逐步迁移到 SQLite，在不破坏现有 Admin/MCP API 的前提下解决高频写入、历史查询、索引分页、事务一致性和容量治理问题。
> 实施原则：**测试用例先行。任何存储实现、双写、读切换和旧数据迁移，都必须先有失败测试，再实现代码。**

### 1. 背景与现状

当前 `McpObservabilityStore` 将运行观测数据写入 `<DATA_DIR>/observability/*.jsonl`，主要包括 `client-events.jsonl`、`mcp-calls.jsonl`、`candidate-detections.jsonl` 等。

Codex Session 目前不是独立持久化实体，而是从 Client Event 和 MCP Call 按：

```text
tenantId + actorId + sessionId
```

动态聚合得到。

现有 JSONL 方案已经具备：

- 单进程 `writeQueue` 串行写入；
- 敏感字段脱敏；
- 默认 `maxEntries = 10000`；
- 默认 `maxFileBytes = 5 MiB`；
- metadata 默认保留 30 天；
- archive rotation；
- current JSONL 读取最多最近 2000 条；
- 损坏 JSON 行容错。

主要问题：

```text
每次 append
  ↓
读完整 current JSONL
  ↓
parse / retention / trim
  ↓
rotation 判断
  ↓
重写 current JSONL
```

随着用户数和 Hook/MCP 调用量增长，会产生明显写放大；同时 Admin 当前不查询 archive，因此磁盘上存在的历史不等于在线可查询历史。

### 2. 数据库化边界

数据库不是为了替代 Git。

#### 第一阶段进入 SQLite

- Client Hook / Client Event；
- MCP Call；
- Session projection；
- Candidate Detection；
- Reuse / Failure 查询；
- Observability retention / maintenance metadata。

#### 第二阶段已纳入 SQLite

- Feedback；
- Knowledge Candidate（保留 append-only history 语义）；
- Knowledge Gap management（保留 append-only history 语义）；

#### 后续可独立评估
- Repository runtime/governance 状态；
- Audit metadata；
- Managed API Key metadata。

#### 继续由 Git / 文件作为 Source of Truth

- Skill；
- Knowledge 正文；
- Prompt；
- Agent；
- Repository Git 内容；
- 最终发布的知识资产。

原则：

```text
数据库 = 平台运行状态 / 查询状态
Git     = 团队知识资产真源
```

### 3. 技术选择

第一阶段采用 SQLite。

推荐数据库路径：

```text
<DATA_DIR>/db/team-skill-hub.sqlite3
```

Docker 默认：

```text
/var/lib/team-skill-hub/db/team-skill-hub.sqlite3
```

项目要求 Node >= 24，优先通过测试评估 Node 内置 `node:sqlite`，避免第一阶段直接引入额外 native dependency。

实现前必须先用 compatibility tests 验证实际 WSL2 / Docker Node 24 环境中的：

- open / close；
- prepared statements；
- transactions；
- WAL；
- busy timeout；
- close/reopen persistence；
- backup 或一致备份替代路径。

如果测试证明内置 API 不满足要求，再选其他 driver；不能先选 driver 再补测试。

SQLite backend 明确限制为：

```text
team-skill-hub replicas = 1
```

未来需要多副本、HA、Kubernetes 横向扩展时切 PostgreSQL，不允许多个实例通过 NFS/SMB/共享 volume 共同写一个 SQLite 文件。

### 4. 核心架构

业务代码不直接散落 SQL。

建议结构：

```text
src/storage/
├── database.ts
├── migrations/
├── observability-repository.ts
├── sqlite-observability-repository.ts
├── sqlite-session-projection.ts
├── retention.ts
├── health.ts
└── migration/
```

核心抽象：

```ts
interface ObservabilityRepository {
  recordClientEvent(...): Promise<...>;
  recordMcpCall(...): Promise<...>;
  recordCandidateDetection(...): Promise<...>;

  listClientEvents(...): Promise<...>;
  getClientEvent(...): Promise<...>;
  listMcpCalls(...): Promise<...>;
  getMcpCall(...): Promise<...>;

  listSessions(...): Promise<...>;
  getSession(...): Promise<...>;
  getSessionTimeline(...): Promise<...>;

  listReuse(...): Promise<...>;
  listFailures(...): Promise<...>;
}
```

未来可实现：

```text
ObservabilityRepository
├── JsonlObservabilityRepository
├── SqliteObservabilityRepository
└── PostgresObservabilityRepository
```

`server.ts`、`application.ts`、Admin API 不直接依赖 SQLite。

### 5. SQLite 基础配置

建议：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

默认不在高频 maintenance 中执行完整 `VACUUM`。可评估 incremental vacuum，但必须以容量测试结果决定。

### 6. Schema migration

第一天就建立正式 migration runner：

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);
```

要求：

- migration 严格按 version 执行；
- 单个 migration 在事务中完成；
- 失败必须 rollback；
- 已执行 migration 不重复执行；
- newer/unknown schema version 不静默启动；
- 支持旧 schema → 新 schema upgrade tests。

### 7. 第一阶段 Schema

#### 7.1 client_events

```sql
CREATE TABLE client_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event TEXT NOT NULL,
    client TEXT,
    turn_id TEXT,
    repository_id TEXT,
    cwd TEXT,
    model TEXT,
    permission_mode TEXT,
    runtime_version TEXT,
    hook_schema_version INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_client_events_ts
ON client_events(ts DESC);

CREATE INDEX idx_client_events_session
ON client_events(tenant_id, actor_id, session_id, ts);

CREATE INDEX idx_client_events_actor_ts
ON client_events(tenant_id, actor_id, ts DESC);

CREATE INDEX idx_client_events_event_ts
ON client_events(event, ts DESC);

CREATE INDEX idx_client_events_repository_ts
ON client_events(repository_id, ts DESC);
```

#### 7.2 mcp_calls

```sql
CREATE TABLE mcp_calls (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    trace_id TEXT NOT NULL,
    transport_session_id TEXT,
    session_id TEXT,
    actor_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    repository_id TEXT,
    client TEXT,
    tool TEXT NOT NULL,
    latency_ms REAL NOT NULL,
    success INTEGER NOT NULL,
    error TEXT,
    args_json TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_mcp_calls_ts
ON mcp_calls(ts DESC);

CREATE INDEX idx_mcp_calls_session
ON mcp_calls(tenant_id, actor_id, session_id, ts);

CREATE INDEX idx_mcp_calls_tool_ts
ON mcp_calls(tool, ts DESC);

CREATE INDEX idx_mcp_calls_success_ts
ON mcp_calls(success, ts DESC);

CREATE INDEX idx_mcp_calls_actor_ts
ON mcp_calls(tenant_id, actor_id, ts DESC);

CREATE INDEX idx_mcp_calls_trace
ON mcp_calls(trace_id, ts);
```

#### 7.3 sessions projection

Session 主键继续严格使用：

```text
tenantId + actorId + sessionId
```

```sql
CREATE TABLE sessions (
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    client TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_activity_at INTEGER NOT NULL,
    repository_id TEXT,
    runtime_version TEXT,
    hook_schema_version INTEGER,
    event_count INTEGER NOT NULL DEFAULT 0,
    call_count INTEGER NOT NULL DEFAULT 0,
    failed_call_count INTEGER NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    has_mcp INTEGER NOT NULL DEFAULT 0,
    has_evidence INTEGER NOT NULL DEFAULT 0,
    has_reuse INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    PRIMARY KEY (tenant_id, actor_id, session_id)
);

CREATE INDEX idx_sessions_activity
ON sessions(last_activity_at DESC);

CREATE INDEX idx_sessions_actor_activity
ON sessions(tenant_id, actor_id, last_activity_at DESC);

CREATE INDEX idx_sessions_repository_activity
ON sessions(repository_id, last_activity_at DESC);

CREATE INDEX idx_sessions_status_activity
ON sessions(status, last_activity_at DESC);
```

Session 是 projection，不是事实真源：

```text
client_events + mcp_calls = facts
sessions                  = rebuildable projection
```

必须保留 `rebuildSessions()`。

#### 7.4 candidate_detections

```sql
CREATE TABLE candidate_detections (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    session_id TEXT,
    detector TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    candidate_id TEXT,
    created_at INTEGER NOT NULL
);
```

### 8. JSON 字段原则

```text
需要筛选 / 排序 / join / index → 独立 column
只用于详情展示                → JSON TEXT
```

所有 JSON payload 必须继续复用当前 sanitization/redaction 逻辑，不能因迁移数据库而绕过安全处理。

### 9. 写入事务

#### Hook

```text
BEGIN
  INSERT client_events
  UPSERT sessions
    event_count += 1
    last_activity_at = event.ts
    SessionStart → started_at
    SessionEnd   → ended_at / ENDED
COMMIT
```

#### MCP Call

```text
BEGIN
  INSERT mcp_calls
  UPSERT sessions
    call_count += 1
    has_mcp = 1
    failed → failed_call_count += 1
    evidence → evidence_count / has_evidence
    reuse → has_reuse = 1
COMMIT
```

Session status 继续遵守现有核心测试：

```text
failed_call_count > 0 → FAILED
否则 ended_at != null → ENDED
否则 → ACTIVE
```

Reuse 判定必须继续调用唯一实现 `isReuseMcpTool()`，禁止数据库层出现第二份 hard-coded tool list。

### 10. 查询与分页

Session list 直接查询 `sessions`，不再每次扫描 Hook + MCP 聚合。

Session detail 精确使用：

```text
tenantId + actorId + sessionId
```

完整 timeline 不再受 current JSONL 最近 2000 条限制。

Reuse / Failure 从 `mcp_calls` 派生，不单独复制事实数据。

数据库读切换后逐步改 keyset pagination；底层迁移第一阶段先保持现有 API 兼容，分页协议变化单独做测试和上线。

### 11. Retention / 容量治理

SQLite 后停止“每次写入都 compact”。建议 maintenance：

```text
每 10 分钟执行一次
每次最多删除 5000 条过期数据
```

metadata 默认仍 30 天。

新增指标：

- DB size；
- WAL size；
- Client Event count；
- MCP Call count；
- Session count；
- oldest event；
- retention days；
- last cleanup；
- cleanup deleted rows。

建议配置：

```yaml
storage:
  type: sqlite
  sqlite:
    path: /var/lib/team-skill-hub/db/team-skill-hub.sqlite3
    busy_timeout_ms: 5000

observability:
  retention_days: 30
  cleanup_interval_minutes: 10
  cleanup_batch_size: 5000
  max_database_size_mb: 2048
```

### 12. Backup / Restore

WAL 模式下不把简单复制单个 `.sqlite3` 文件作为正式在线备份。

现有 `backup:data` 最终升级为：

```text
SQLite consistent backup
+ remaining DATA_DIR files
+ manifest
+ checksum
```

数据库损坏禁止 silent fallback 到新空库。

### 13. JSONL 历史迁移

提供 CLI，例如：

```bash
npm run migrate:observability
```

导入 current + archive；以稳定 record id 作为 primary key，保证重复执行幂等。

迁移结束后：

- 输出 source / valid / inserted / duplicate / invalid counts；
- 重建 Session projection；
- 抽样 Session 对比 JSONL 和 SQLite 的 eventCount、callCount、failedCallCount、evidenceCount、hasReuse、startedAt、endedAt、status。

### 14. Rollout

禁止一步切换。

#### Phase 0：测试基线与 abstraction

只增加 storage interface、SQLite test harness、migration runner、schema、health primitive。线上仍 JSONL。

#### Phase 1：dual write

```text
write = JSONL + SQLite
read  = JSONL
```

#### Phase 2：shadow read

仍向用户返回 JSONL 结果，后台比较 SQLite 查询结果。

#### Phase 3：Admin Observability 逐资源切 SQLite

顺序：Hook → MCP Call → Session → Reuse/Failure → Candidate Detection。每个资源有 rollback flag。

#### Phase 4：JSONL current + archive import

导入旧历史并重建 Session。

#### Phase 5：SQLite 主写

SQLite 成为在线 Source of Truth；JSONL 仅作为可选 cold export/archive。

#### Phase 6：Candidate / Gap / Feedback 数据库化

等 Observability 稳定后再做。

### 15. 测试先行：强制门禁

数据库迁移的每一个功能都必须遵循：

```text
1. 先写测试
2. 验证测试因实现缺失而失败
3. 写最小实现
4. 定向测试通过
5. JSONL / SQLite parity test
6. npm run build
7. npm test
8. 容量 / 故障测试
9. 才进入下一个功能
```

禁止“先把数据库写完，再统一补测试”。

### 16. 第一批必须先创建的测试

```text
tests/storage/sqlite-database.test.ts
tests/storage/schema-migrations.test.ts
tests/storage/sqlite-observability-repository.test.ts
tests/storage/sqlite-session-projection.test.ts
tests/storage/observability-parity.test.ts
```

#### SQLite runtime tests

- 临时 DB 创建；
- WAL 生效；
- foreign_keys 生效；
- busy_timeout 生效；
- close/reopen 数据仍在；
- DB parent directory 自动创建；
- 实际 Node 24 / Docker 环境兼容。

#### Migration runner tests

- fresh DB 0 → latest；
- migration 按顺序；
- migration 只执行一次；
- migration failure rollback；
- schema_migrations 正确；
- newer/unknown schema 拒绝启动；
- old schema upgrade 不丢数据。

#### Transaction tests

- Hook insert + Session update 同事务；
- MCP insert + Session update 同事务；
- projection 更新失败时 facts 也 rollback；
- duplicate primary key 不造成 projection double count。

### 17. Observability 核心测试矩阵

#### Client Event

- sanitized metadata；
- credential/source code 不落库；
- duplicate lifecycle natural key；
- actor/tenant/session 隔离；
- event/repository/from/to filter；
- inclusive time boundaries。

#### MCP Call

- args/error 脱敏；
- success/failure；
- tool/actor/session/trace filter；
- duplicate id；
- reuse classification 与 `isReuseMcpTool()` 一致。

#### Session projection

- SessionStart → ACTIVE；
- SessionEnd → ENDED；
- failed MCP → FAILED；
- FAILED 优先于 ENDED；
- eventCount；
- callCount；
- failedCallCount；
- evidenceCount；
- hasMcp；
- hasEvidence；
- hasReuse；
- repository/runtime metadata；
- same sessionId 不同 actor 不串；
- same sessionId 不同 tenant 不串；
- list identity 精确映射 detail；
- ambiguous sessionId 不允许猜测。

#### Session rebuild

- projection 可从 facts 重建；
- rebuild 前后业务结果一致；
- rebuild 幂等；
- rebuild 不修改 facts；
- 10k / 100k 数据下内存有界。

### 18. Parity Test：读切换前硬门禁

同一 fixture 同时写 JSONL 和 SQLite，比较：

- list/get Client Event；
- list/get MCP Call；
- list/get Session；
- Session timeline；
- Reuse；
- Failure；
- Candidate Detection。

门禁：

```text
核心业务 parity = 100%
```

JSONL 已知缺陷（archive 不可查、current 最多 2000 rows）不需要在 SQLite 中复制，应作为 expected improvement 明确测试。

### 19. Retention / 并发 / 容量测试

Retention 测试使用固定 clock，不靠真实 sleep：

- 30 天边界；
- 每批最多 N 条；
- 多批最终清理；
- 新数据不删；
- cleanup 与写并发；
- Session projection 不产生空悬挂。

并发至少：

- 30 并发 Hook；
- 30 并发 MCP；
- 混合读写；
- 同 Session 并发 update；
- busy timeout；
- 不出现 `database is locked` 风暴。

容量：

```text
CI 快速：10k events + 10k calls + 1k sessions
Release：100k rows / 1M rows
```

初始性能目标：

| 场景 | 目标 |
| --- | ---: |
| Hook write p95 | < 10 ms |
| MCP write p95 | < 10 ms |
| Session 首屏 20 条 | < 100 ms |
| indexed filter | < 100 ms |
| Session detail 1000 events | < 200 ms |
| 30 并发开发者 | 0 storage errors |

性能目标必须记录机器和数据规模，不作为跨硬件绝对 SLA。

### 20. 故障测试

必须覆盖：

- DB 不存在；
- parent directory 不存在；
- read-only filesystem；
- migration 中断；
- malformed database / health check failure；
- WAL 存在时重启；
- transaction 中异常；
- disk full / SQLITE_FULL 可模拟场景；
- busy/lock timeout；
- duplicate ID；
- serialization failure；
- SQLite init 失败时 readiness/alert 行为。

禁止 storage failure 被静默吞掉而服务仍宣称完全健康。

### 21. Backup / Restore 测试

修改现有 backup 代码之前先有：

- 写入期间备份一致；
- backup 后 integrity/quick check；
- restore 到空 DATA_DIR；
- restore overwrite protection 不退化；
- restored DB 可继续 migration；
- WAL 下不漏 committed transaction；
- manifest/hash 能检测篡改。

### 22. JSONL Import 测试

fixture 至少包含：

- current JSONL；
- 多个 archive；
- duplicate rows；
- corrupted line；
- old data；
- same sessionId different actor/tenant；
- failed/reuse/evidence calls。

验证：

- import 幂等；
- corrupted line 被统计而不是崩溃；
- archive 历史能进入 SQLite；
- record count 正确；
- Session rebuild 正确；
- import 中断后重跑安全；
- 原 JSONL 不被修改。

### 23. Feature Flags / 回滚

建议：

```text
OBSERVABILITY_WRITE_BACKEND=jsonl|dual|sqlite
OBSERVABILITY_READ_BACKEND=jsonl|sqlite
```

阶段：

```text
Phase 0: write=jsonl, read=jsonl
Phase 1: write=dual,  read=jsonl
Phase 2: write=dual,  read=jsonl + shadow sqlite
Phase 3: write=dual,  read=sqlite
Phase 5: write=sqlite, read=sqlite
```

回滚不要求 schema downgrade，优先切回 JSONL read backend。

### 24. Admin / 运维可见性

后续建议在治理/系统页面展示：

```text
Storage backend
Journal mode
DB size
WAL size
Client events
MCP calls
Sessions
Oldest event
Retention
Last cleanup
Last backup
Database check
```

数据库异常进入现有 Active Alerts。

### 25. PostgreSQL 演进边界

以下情况重新评估 PostgreSQL：

- 多副本；
- HA；
- Kubernetes 横向扩展；
- 几百到上千持续活跃开发者；
- 更长在线历史分析；
- 跨实例事务/队列需求。

Repository abstraction 应保证切换 PostgreSQL 时不重写 Admin/MCP 业务层。

### 26. 实施任务清单

#### P0 - 测试基础设施

- [x] SQLite compatibility tests；
- [x] temporary DB fixture；
- [x] migration runner tests；
- [x] transaction rollback tests；
- [x] repository contract/parity harness；
- [x] Ubuntu-24.04 WSL2 + Docker Node 24 双环境验证。

#### P1 - Storage foundation

- [x] `ObservabilityRepository`；
- [x] legacy JSONL repository adapter；
- [x] SQLite bootstrap；
- [x] migration 001；
- [x] DB health；
- [x] P0 全绿。

#### P2 - SQLite write + projection

- [x] Client Event transaction；
- [x] MCP Call transaction；
- [x] Candidate Detection；
- [x] Session projection；
- [x] rebuildSessions；
- [x] sanitization/isolation/concurrency tests。

#### P3 - Dual write / parity

- [x] dual-write flag；
- [x] write failure metrics；
- [x] parity fixture；
- [x] shadow read；
- [x] 30-user capacity SQLite run。

#### P4 - Read cutover

- [x] Hook API；
- [x] MCP API；
- [x] Session API；
- [x] Reuse/Failure；
- [x] Candidate Detection；
- [x] Admin HTTP E2E；
- [x] rollback flag。

#### P5 - Import / retention / backup

- [x] JSONL current + archive importer；
- [x] idempotent import tests；
- [x] retention worker；
- [x] storage metrics；
- [x] SQLite-aware backup/restore；
- [x] 100k / 1M benchmark。

#### P6 - Stop JSONL realtime storage

- [x] production observation period（本地 Docker 切换/重启/在线查询已验证；生产环境继续按发布窗口观察）；
- [x] write backend 切 SQLite；
- [x] JSONL 仅 cold export；
- [x] 删除 append-every-time compact 主路径；
- [x] 更新运维/部署文档。

### 27. 每个 Phase 的 Definition of Done

每个阶段必须同时满足：

```text
新增测试先出现预期失败
        ↓
实现完成
        ↓
定向测试全绿
        ↓
现有 Admin 核心回归全绿
        ↓
npm run build
        ↓
完整 npm test 无新增失败
        ↓
WSL2 / Docker 环境验证
        ↓
无数据格式/安全语义回退
```

当前仓库已有一个独立 Knowledge workflow 已知失败项；数据库改造不得引入新的 unrelated failure，也不得通过削弱已有断言来“修绿”。

### 28. 第一批实际开发顺序

严格顺序：

```text
1. tests/storage/sqlite-database.test.ts
2. tests/storage/schema-migrations.test.ts
3. tests/storage/sqlite-observability-repository.test.ts
4. tests/storage/sqlite-session-projection.test.ts
5. tests/storage/observability-parity.test.ts

先确认测试因实现缺失而失败

6. src/storage/database.ts
7. src/storage/migrations/001-observability.*
8. src/storage/observability-repository.ts
9. src/storage/sqlite-observability-repository.ts
10. src/storage/sqlite-session-projection.ts
```

不先碰 Admin UI，不先删除 JSONL，不先改变线上默认 backend。

第一批实现完成后，先得到一个可独立验证的 SQLite storage layer，再进入 dual-write。

### 29. 实施结果（2026-10-14）

已完成：

- Node 24 `node:sqlite`、WAL、busy timeout、事务、future-schema fail-closed；
- Client Event / MCP Call / Candidate Detection / Session projection SQLite 主存储；
- Feedback / Knowledge Candidate history / Knowledge Gap management history SQLite 化；
- JSONL current + archive 幂等导入，旧 JSONL 保留用于回滚；
- SQLite read/write backend、dual-write、shadow parity、write failure metrics；
- Admin Session/Hook/MCP/Reuse/Failure/Candidate Detection/Candidate/Feedback 查询下推；
- retention worker、quick_check、DB/row metrics、Admin health 展示；
- SQLite-aware online backup、cold gzip JSONL export；
- 30-user concurrency、100k / 1M 容量 benchmark；
- Docker volume 实际迁移并切换到 `write=sqlite, read=sqlite`；
- 第二轮 code review 后完成存储硬化：
  - SQLite retention 默认按 Data Governance 分类执行：metadata 30 天、engineering-evidence 90 天、audit / knowledge-candidate 365 天；
  - retention 不再周期性全量 rebuild Session，只重建被过期事实影响的 `tenantId + actorId + sessionId`，并与删除事实放在同一事务中，失败整体回滚；
  - `OBSERVABILITY_WRITE_BACKEND` / `OBSERVABILITY_READ_BACKEND` 运行时严格校验，配置错误 fail-closed；
  - JSONL importer 只将 JSON parse 错误计为 invalid，SQLite 写失败立即中止迁移；
  - readiness 增加 SQLite 可写检查，maintenance failure 有计数/最后错误并进入 Admin health / Active Alerts；
  - SQLite backup 支持自定义 `.db` 文件名，通过文件头识别并使用 online backup；配置库位于 DATA_DIR 外时拒绝生成不完整备份；
  - Session keyset cursor 使用 `last_activity_at + tenant_id + actor_id + session_id` 唯一排序键；
  - Session projection 对乱序 Hook/Event 使用 `last_event_ts` 保护，不允许旧事件覆盖最新结束状态和 runtime metadata；
  - storage size 包含 main database、WAL、SHM，不再低估实际磁盘占用；
- 第三轮兼容性 review 同时覆盖既有业务功能：
  - 强制 `write=sqlite/read=sqlite` 运行 Codex/Claude Hook、Client Event、Session、Candidate/Gap、Feedback、MCP Knowledge、GitHub/GitLab publishing、Repository sync/rollback、API Key/Data Governance 等旧功能回归，58/58 通过；
  - SQLite Admin SQL 下推的 `q`、`success`、`automatic` 行为与原内存筛选保持一致，`q` 继续 trim 且仅搜索旧 API 定义的用户可见字段；
  - Admin Observability 非法时间筛选统一返回 HTTP 400，不再从 SQLite timestamp parser 冒成 500；
  - Admin Session OFFSET 分页使用 `last_activity_at + tenant_id + actor_id + session_id` 稳定排序；
  - backup 只排除实际 SQLite 主库对应的 `-wal/-shm` sidecar，普通同后缀文件继续进入备份。

容量基准（Ubuntu-24.04 WSL2）：

```text
100k rows: ~48.5k rows/s write, indexed 100-row query < 0.6 ms
1M rows:   ~34.6k rows/s write, indexed 100-row query < 0.5 ms
```

实际 Docker volume 迁移后：

```text
clientEvents:                  163
mcpCalls:                       56
candidateDetections:            22
sessions:                       26
candidateHistory:              638
knowledgeCandidates:             4
knowledgeGapManagementHistory:   3
knowledgeGapsManaged:             1
quick_check:                   true
journal_mode:                   wal
```

全量测试命令已修正为让 Node 自己展开递归 glob，避免新增 `tests/storage/` 后 Bash 只执行一层子目录测试。第三轮兼容性 review 补齐旧 API parity 与 backup 边界后，真正全量测试为 176 个：175 通过，唯一失败仍是改造前已存在的 `knowledge-workflow-integration.test.ts` 中 `5 !== 0`，SQLite 改造未新增 unrelated failure。
