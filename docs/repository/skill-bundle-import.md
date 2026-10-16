# Skill Bundle Import Design

## 1. 目标

Team Skill Hub 的 Skill 发布模型统一采用 Bundle：**Skill 本身就是一个 Bundle**。`SKILL.md` 是必需入口文件，`scripts/`、`references/`、`assets/` 等都是同一个 Skill 的组成部分；单文件 Skill 只是“只包含一个 `SKILL.md` 的最小 Bundle”。Superpowers 这类仓库则是在一个命名空间下包含多个 Skill Bundle。

本设计新增 **Skill Bundle Import** 能力，使开发者可以在 Codex / Claude Code 会话里通过 MCP 提交已有 Skill 集合，也可以由管理员在 Web 页面导入外部 Bundle。两种入口共享同一套后端模型、校验、审核和发布逻辑。

核心约束：

- 一次 Bundle 提交对应一个 Import Batch；
- 一个 Import Batch 可以包含多个 Skill；
- 一个 Import Batch 审核通过后只创建一个 PR/MR；
- Bundle 保留命名空间目录，例如 `skills/superpowers/**`；
- Skill Import 与 Collection Import 都采用 **快照更新**，但快照替换边界不同；
- `skill` import 只替换 `skills/<namespace>/<skill_path>/**`，不会删除同 namespace 的 sibling Skill；
- `collection` import 才替换整个 `skills/<namespace>/**`；
- 快照中不存在的旧文件只会在本次 `replacementRoot` 内体现为删除；
- Team Skill Hub 不引入 namespace owner / binding；
- Team Skill Hub 不自动 merge；新增、修改、删除以及 Git 冲突最终由人工 PR/MR Review 决定。

## 2. 非目标

第一阶段不做：

- 自动合并 PR/MR；
- namespace ownership / lock / reservation；
- 双向同步外部 Git 仓库；
- 定时从上游自动拉取 Bundle；
- 任意服务器本地路径导入；
- 在浏览器中编辑大量 Bundle 文件内容；
- 把 Bundle 拆成多个独立 PR/MR；
- 修改单个 Knowledge Candidate 的发布语义。

Skill 对外提交入口统一为 `submit_skill_bundle`。单文件 Skill 不是另一种业务类型，而是只包含一个 `SKILL.md` 的 Skill Bundle；新的 Skill Creator 无论只生成 `SKILL.md`，还是同时生成 `scripts/`、`references/`、`assets/`，都应产出同一种 Skill Bundle Snapshot。

## 3. 总体流程

```text
Codex / Claude Code                         Admin Web
        |                                      |
        | MCP submit_skill_bundle              | ZIP / Git URL
        |                                      |
        +------------------+-------------------+
                           |
                           v
                  Skill Bundle Import Service
                           |
                  normalize / validate
                           |
                           v
                     Import Batch
                           |
                      Admin Review
                           |
                       approve
                           |
                           v
                  snapshot diff + branch
                           |
                       one PR/MR
                           |
                    human review/merge
                           |
                           v
                    Repository Sync
                           |
                        published
```

MCP 与 Web 的差异只存在于“文件如何进入 Hub”。从规范化后的 Bundle Snapshot 开始，两者必须走同一套 Application Service。

## 4. Bundle 与命名空间

### 4.1 Namespace

每个 Bundle 必须提供 `namespace`，例如：

```text
superpowers
```

对于 `rd-skills`，第一阶段目标根目录固定为：

```text
skills/<namespace>/
```

例如：

```text
skills/superpowers/brainstorming/SKILL.md
skills/superpowers/test-driven-development/SKILL.md
skills/superpowers/systematic-debugging/SKILL.md
```

`namespace` 必须经过严格规范化：

- 非空；
- 只允许稳定的目录安全字符；
- 不允许 `.`、`..`、绝对路径、盘符、反斜杠逃逸或 URL 编码逃逸；
- 规范化后的所有输出路径必须仍位于 `skills/<namespace>/` 内。

本设计不记录“某个 Bundle 拥有某 namespace”。如果目标目录已经存在，快照 diff 仍然可以产生修改或删除，最终由 PR/MR Review 兜底。

### 4.2 Import Type 与 Snapshot 替换边界

`namespace` 只表示逻辑组织目录，不再等同于“完整快照替换边界”。MCP / Web 入口必须明确本次导入是单个 Skill 还是一个 Skill 集合：

```text
import_type = skill | collection
```

两种业务语义统一映射到领域层的 `replacementRoot`：

```text
skill:
  namespace = ota
  skill_path = design
  replacementRoot = skills/ota/design

collection:
  namespace = superpowers
  replacementRoot = skills/superpowers
```

`replacementRoot` 才是 Snapshot 的完整替换边界。发布器只允许在该目录内执行删除、写入和 diff。

`skill_path` 也属于安全敏感路径输入，必须独立规范化：非空、相对路径、不允许 `.` / `..`、绝对路径、Windows drive path、反斜杠逃逸或 URL 编码逃逸。允许多级 `skill_path`（例如 `android/ota/design`），但规范化后的 `replacementRoot` 必须严格位于 `skills/<namespace>/` 下，且不能等于 namespace 根。

因此两个独立 Skill 可以安全共享 namespace：

```text
skills/ota/design/**
skills/ota/usage/**
```

提交 `ota/design` 时只能影响 `skills/ota/design/**`；后续提交 `ota/usage` 不能删除 `design`。只有显式的 `collection` import 才拥有整个 `skills/ota/**` 的替换语义。

`import_type = skill` 还有一个强领域约束：Snapshot 必须恰好包含一个 Skill root，且唯一的 `SKILL.md` 必须位于 Snapshot 根，即 `files[].path` 中必须存在且只能存在一个 `SKILL.md`。`nested/SKILL.md`、多个 `SKILL.md` 或只有子目录中的 `SKILL.md` 都应拒绝。`collection` import 才允许在 Snapshot 内递归包含多个 Skill root。

Collection import 示例：一次提交携带该 namespace 的完整目标快照。

假设仓库当前有：

```text
skills/superpowers/a/SKILL.md
skills/superpowers/b/SKILL.md
skills/superpowers/old/reference.md
```

新快照只有：

```text
a/SKILL.md
b/SKILL.md
c/SKILL.md
```

则 PR/MR 应表现为：

- `a/SKILL.md`：按内容判断 unchanged / modified；
- `b/SKILL.md`：按内容判断 unchanged / modified；
- `c/SKILL.md`：added；
- `old/reference.md`：deleted。

Hub 不因为删除数量较多而自动拒绝，但 Admin Review 必须清晰展示预计删除数量和路径。

## 5. 数据模型

Skill 发布领域采用 **Bundle-first** 模型：所有 Skill 都以 Snapshot Bundle 表示，不再把“单文件 Skill”和“多文件 Bundle”设计成两种并列业务类型。单文件 Skill 只是文件集合中只有一个 `SKILL.md` 的 Bundle；多文件 Skill 可以包含同一 Skill root 下的资源；Superpowers 这类集合则由一个 namespace Snapshot 同时包含多个 Skill root。

`KnowledgeCandidate` 保持 Knowledge 专用的单内容模型；Skill 不再通过 Candidate MCP API 提交，而统一使用 Skill Bundle / Skill Snapshot 模型。历史内部兼容代码可在不影响旧持久化数据的前提下暂时保留，但不得作为客户端可见入口继续暴露。

建议核心类型：

```ts
type SkillBundleImportStatus =
  | "pending"
  | "approved"
  | "review_stale"
  | "rejected"
  | "publishing"
  | "publish_failed"
  | "published"
  | "published_drifted";

interface SkillBundleFile {
  path: string;
  content: string;
  sha256: string;
  sizeBytes: number;
  mode: "0644" | "0755";
}

interface SkillBundleSkillSummary {
  name: string;
  rootPath: string;
  skillFilePath: string;
}

interface SkillBundleSnapshot {
  id: string;
  files: SkillBundleFile[];
  skills: SkillBundleSkillSummary[];
  sha256: string;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
}

interface SkillBundleReview {
  reviewer: string;
  reviewedAt: string;
  // approved review 才有以下审核基线；rejected 只保存 reviewer/time/reason
  targetRevision?: string;
  targetTreeSha256?: string;
  diffSha256?: string;
  added?: number;
  modified?: number;
  deleted?: number;
  reason?: string;
}

interface SkillBundlePullRequestPublication {
  kind: "pull-request";
  expectedTreeSha256: string;
  finalTreeSha256?: string;
  finalTreeVerifiedAt?: string;
  provider: "github" | "gitlab";
  projectPath: string;
  branch: string;
  targetBranch: string;
  targetRoot: string;
  mergeRequestIid: number;
  mergeRequestUrl: string;
  mergeRequestState: "opened" | "merged" | "closed" | "locked";
  added: number;
  modified: number;
  deleted: number;
  pullRequestCreatedAt: string;
  lastCheckedAt: string;
  mergedAt?: string;
  closedAt?: string;
  mergeCommitSha?: string;
}

interface SkillBundleNoopPublication {
  kind: "no-op";
  targetRevision: string;
  targetRoot: string;
  checkedAt: string;
}

type SkillBundlePublication =
  | SkillBundlePullRequestPublication
  | SkillBundleNoopPublication;

interface SkillBundleImport {
  id: string;
  revision: number;
  namespace: string;
  importType: "skill" | "collection";
  skillPath?: string;
  replacementRoot: string;
  collection: "rd-skills";
  repository: string;
  sourceType: "mcp" | "web-files" | "web-zip" | "web-git";
  sourceMetadata?: Record<string, string>;
  snapshotId: string;
  snapshotSha256: string;
  status: SkillBundleImportStatus;
  submitter?: string;
  review?: SkillBundleReview;
  publication?: SkillBundlePublication;
  publishError?: string;
  createdAt: string;
  updatedAt: string;
}
```

这里必须区分三个层次：一个 `Skill` 是一个以 `SKILL.md` 为入口的 Skill root；一个 `SkillBundleSnapshot` 是某个 `replacementRoot` 的不可变完整物理快照，可以包含一个或多个 Skill root；一次提交、审核和发布流程则由 `SkillBundleImport` 表示。单 Skill / 单 `SKILL.md` 只是 `SkillBundleSnapshot` 的退化形式，不形成另一套业务模型或发布协议。

Snapshot 一旦创建即不可变并按内容寻址；Import 状态历史只引用 `snapshotId`，不能在每次 `pending -> approved -> publishing -> published` 状态变化时重复保存整个 Bundle 文件集合。`snapshotSha256` 必须使用稳定 canonical 算法计算，例如按规范化 `path` 排序后依次哈希 `path + mode + contentSha256`；不要依赖 JSON 字段顺序或文件枚举顺序。`namespace` / `replacementRoot` 属于 Import 目标语义，不参与内容 Snapshot hash。

Import 本身使用单调递增的 `revision` 做 optimistic concurrency control。任何状态更新必须基于调用方读取到的旧 revision 执行 compare-and-swap；如果期间已有其他管理员或发布任务更新了该 Import，则本次写入返回 state conflict，不能用旧对象覆盖新状态。该约束用于阻止并发 Approve / Reject、重复 Publish 和 Reconcile 的 last-write-wins。

所有 tree hash（包括 `targetTreeSha256`、`expectedTreeSha256`、`finalTreeSha256`）必须使用同一 canonical 编码：路径统一为 `/` 分隔并按 UTF-8 byte order 排序；每个文件按 `relativePath + "\0" + mode + "\0" + contentSha256 + "\n"` 参与哈希。`contentSha256` 基于实际要写入 Git 的 UTF-8 bytes 计算，不自动做 CRLF/LF 归一化，避免 Preview、发布和最终校验出现不同内容语义。

### 5.1 Bundle 大小限制

MCP 请求不能无限携带文本。第一阶段必须设置服务端限制，并通过配置集中管理。建议默认值：

- 单文件最大 512 KiB；
- Bundle 文件数最大 500；
- Bundle 文本总量最大 10 MiB；
- Skill 数最大 100。

超限时整个提交原子失败，不创建半成品 Import Batch。

## 6. MCP：`submit_skill_bundle`

新增 MCP tool：

```text
submit_skill_bundle
```

Hub Server 通常无法访问 Codex / Claude Code 所在机器的本地文件系统，因此 MCP 参数不能只传 `root_path`。Codex 应负责读取本地文件，再把规范化的文件集合传给 MCP tool。

建议输入：

```ts
type SubmitSkillBundleInput =
  | {
      namespace: string;
      import_type: "skill";
      skill_path: string;
      skill_collection: "rd-skills";
      files: Array<{ path: string; content: string; mode?: "0644" | "0755" }>;
      source?: { repository_url?: string; revision?: string };
      note?: string;
      submission_key?: string;
    }
  | {
      namespace: string;
      import_type: "collection";
      skill_collection: "rd-skills";
      files: Array<{ path: string; content: string; mode?: "0644" | "0755" }>;
      source?: { repository_url?: string; revision?: string };
      note?: string;
      submission_key?: string;
    };
```

`import_type: "skill"` 时，`skill_path` 是 namespace 内目标 Skill 目录，例如 `design`，服务端计算 `replacementRoot = skills/<namespace>/<skill_path>`；此时 `files[].path` 是该 Skill root 内相对路径，例如 `SKILL.md`、`references/foo.md`。`import_type: "collection"` 时没有 `skill_path`，`replacementRoot = skills/<namespace>`，`files[].path` 是 namespace 内相对路径，例如 `brainstorming/SKILL.md`。`mode` 省略时按 `0644` 处理；客户端检测到本地可执行普通文本文件时可传 `0755`。`skill_collection` 第一阶段只接受 `rd-skills`。

Codex / Claude Code 应优先按业务语义选择 `import_type`，而不是让用户理解底层 `replacementRoot`：检测到一个明确 Skill root 时默认 `skill`；用户明确要求导入/同步一组 Skills 或整个 namespace 时使用 `collection`。如果本地目录结构存在歧义，应在会话侧澄清，不允许 MCP Server 根据文件数量猜测并扩大替换边界。

成功返回 Import ID、`pending` 状态、namespace、repository、target root、Skill 数、文件数和可选 review URL。MCP 提交永远不会直接创建 PR/MR。

`submission_key` 用于客户端重试去重：同一 authenticated principal + key + 相同内容返回已有 Import Batch；内容不同则返回冲突。

`submission_key` 的幂等作用域固定为 authenticated principal + key，第一阶段不设置短 TTL，至少覆盖 Import 的整个生命周期。服务端必须保存请求语义摘要，至少覆盖 `repository`、`skill_collection`、`namespace`、`import_type`、规范化 `skill_path` 和 `snapshotSha256`。同一 principal + key 只有在这些语义完全一致时才能返回已有 Import；任一字段不同都返回幂等冲突。Import 无论处于 pending、rejected、published 或 `published_drifted`，该 key 都不能被重新解释为另一笔提交。幂等命中应在重新 materialize / preview target repository 之前返回已有 Import，使网络重试不受提交后 target 漂移影响；数据库唯一约束仍作为最终并发仲裁，发生竞争时重新读取相同 key 并校验语义。审计区分 `skill_bundle.import.created` 与 `skill_bundle.import.reused`，避免重试虚增创建统计。

## 7. Web Import

Admin Web 新增入口：`导入 Skill Bundle`。第一阶段支持 ZIP 上传和 Git Repository URL + 可选 revision，并要求选择 `import_type = skill | collection`。`skill` 模式需要 `skill_path`；`collection` 模式以 namespace 为替换边界。Web 还允许选择或填写 `source_root`，用于指出外部归档/仓库中哪个子目录代表本次 Snapshot 输入源。`source_root` 为空时只能在结构无歧义时自动推断，例如 ZIP 仅有一个包装根目录；存在多个可能 Skill 根时必须要求用户明确选择，不能把整个外部仓库的 README、`.github/`、docs 等无关文件自动纳入 Snapshot。

ZIP 导入必须拒绝 zip-slip、符号链接和特殊文件，只接受 UTF-8 文本，并执行与 MCP 相同的大小、路径和 Skill 校验。单 entry 大小限制必须在解压流读取过程中执行，一旦超过单文件上限立即中止该 stream，不能先把超大 entry 全量 materialize 到内存再 reject。只有 ZIP entry 明确保留了可信 Unix executable mode 时才映射为 `0755`；普通 Windows ZIP 或缺失 mode 信息的 entry 一律规范化为 `0644`，不能凭扩展名猜 executable。

Git 导入第一阶段只允许 `https://`，禁止 `file://`、`ssh://` 和裸本地路径，并且只允许访问管理员配置的 Git host allowlist（例如 `github.com`、企业 GitLab 域名）。解析 DNS 后必须拒绝 loopback、link-local、RFC1918/ULA 等非允许网段，并把校验通过的解析结果绑定到实际 Git/libcurl 请求，避免“校验时公网 IP、clone 时重新解析到内网”的 DNS rebinding 窗口；第一阶段关闭 HTTP redirect，而不是允许 Git/libcurl 自行跳转。clone 使用 shallow/no-tags，不初始化 submodule，不自动获取 Git LFS，并配置 clone timeout。clone / fetch 运行期间持续监控临时目录大小，超出配额立即终止整个 Git 进程组，同时在命令完成后再次检查磁盘占用；checkout 后继续执行文件数、单文件和总文本大小上限。revision 最终记录解析后的 commit SHA。私有仓库凭据另行设计，不接受用户任意传入凭据。

Web Import 在创建 Import Batch 前提供 preview，显示 namespace、目标、Skill 数、文件数、文件树、校验错误和预计 added / modified / deleted；删除项必须明显提示。用户确认后才持久化为 `pending`。

## 8. Bundle 校验

MCP 与 Web 共用同一校验器：先将 Web 的 `source_root` 剥离并规范化为与 MCP 相同的 Bundle-relative file set，再拒绝空/绝对/逃逸路径、Windows drive path、规范化重复、case collision。`skill` import 的最终路径必须全部位于 `skills/<namespace>/<skill_path>/`；`collection` import 的最终路径必须全部位于 `skills/<namespace>/`。

递归寻找 `SKILL.md`，每个文件对应一个 Skill root。`skill` import 必须恰好发现一个 `SKILL.md`，且其 Bundle-relative path 必须就是 `SKILL.md`；`collection` import 才允许发现多个 Skill root，并要求至少一个有效 Skill。Collection 中不同 Skill root 之间禁止形成祖先/后代嵌套关系，例如 `design/SKILL.md` 与 `design/internal/SKILL.md` 同时出现时整个 Import 拒绝，以避免资源归属和替换语义模糊。Skill 内容校验不再维护一套 Import 专用简化 schema，而是直接复用当前目标 Repository 的 Skill parser、`scanSkills` / `validateSkills` 与现有 validation rules；因此除了 `schema_version: 1`、`name`、`metadata`，还必须满足当前 RequiredFields、UniqueName、Dependency、Visibility 等规则。

验证上下文必须是“Snapshot 应用后的完整目标 Repository”，而不是只验证导入文件本身：基于当前 target revision 构造临时虚拟工作树，只用 Snapshot 替换本次 `replacementRoot` 后运行 repository Skill scan/validation。这样 `skill` import 不会移除同 namespace 的 sibling Skill，`UniqueNameRule` 仍能看到其他 namespace / sibling 的现有 Skill，同仓库 `depends_on` 也能解析到 Snapshot 外但仍存在于目标仓库中的 Skill。Preview 必须记录这次验证所基于的 target revision；Publish 漂移检查通过后可以复用相同语义重新验证最新最终树。

Skill root 下的 `scripts/`、`references/`、`templates/`、`examples/` 和其他普通文本文件都作为快照保留。第一阶段不接受二进制文件和 symlink。文件 mode 规范化为 `0644` 或 `0755`，以保留脚本可执行语义；其他 Unix mode 不进入领域模型。

任一文件或 Skill 校验失败，整个 Bundle 原子失败，不进入 `pending`。

## 9. Preview 与 Snapshot Diff

后端提供统一 diff：比较当前 target branch 的 `replacementRoot/**` 与本次 Snapshot，返回 `added`、`modified`、`deleted`、`unchanged` 路径集合。`skill` import 的 diff 不得扫描或删除 sibling Skill；`collection` import 才比较整个 `skills/<namespace>/**`。

Preview 只用于审核辅助；真正发布时必须基于最新 target branch 重新计算 diff，不能复用旧 preview。

Approve 时必须把审核所基于的 `targetRevision`、`replacementRoot` tree hash 和 diff hash 一并写入审核记录。`diffSha256` 必须覆盖每个 changed path 的 change type、审核时 before/after content hash 与 file mode，不能只 hash added / modified / deleted 的路径集合。Publish 时如果最新 target branch 的 `replacementRoot` tree hash 与审核记录中的 `targetTreeSha256` 不同，就不得继续发布，而是把 Import 标记为 `review_stale` 并要求管理员重新 Preview / Approve。第一阶段不尝试用“重新计算后的 diff 看起来等价”绕过 stale，因为 Snapshot 是完整替换语义，审核基线本身就是安全边界。`diffSha256` 仍用于审核身份、审计和展示，但不能作为 target tree 已变化时的放行条件。这样既能避免审核后别人修改本次替换边界内的文件而产生未经审核的删除/覆盖，也不会因为 replacementRoot 外的 sibling Skill 独立变更让一个 `skill` import 无意义地失效。

## 10. 审核模型

Skill 的审核对象统一为 Bundle Snapshot，不再区分“单文件 Skill Candidate”和“Bundle Candidate”。审核列表/详情显示 Import ID、namespace、来源、submitter、repository / target root、Skill 数和文件数、Skill 列表、文件树、preview diff、note/source metadata、审核历史、PR/MR 地址与状态。只有一个 `SKILL.md` 时，界面自然表现为 1 Skill / 1 File。

`pending` 支持 Approve / Reject。`review_stale` 必须重新 Preview 后再次 Approve 才能发布。PR/MR 创建前必须存在针对当前 target tree/diff 的明确审核通过记录。

## 11. 发布器

Skill Publisher 应升级为 Bundle Publisher。现有单文件 Skill 发布也走该 Publisher，只是 Snapshot 中只有一个 Skill root / 一个文件。Knowledge 单文件发布逻辑暂不需要强制迁移。

发布时先把 target branch 解析为一个确定 commit SHA，并针对该 SHA 执行审核漂移检查；只有该 commit 上当前 `replacementRoot` tree 与审核记录一致时，才从同一个已校验 commit 创建/重建确定性 Import branch。target branch 在 PR/MR 创建以后继续前进属于正常 Git 集成并发，由 PR/MR 冲突和人工 Review 处理。有实际 diff 时只创建一个 commit、一个 branch、一个 PR/MR，并记录 diff counts。

GitLab Bundle Publisher 复用 Knowledge Publishing 的 `token_env` / REST API 认证模型：通过 Repository Tree / Files API 读取审核基线，通过 Commits API 的批量 `actions[]` 原子应用 create/update/delete/chmod，并用 `start_sha + force` 从已校验 target revision 确定性重建 Import branch，最后调用 MR API。GitLab 发布与 merge 后 final-tree 校验均不依赖 SSH clone/push。GitHub Bundle Publisher 仍可使用临时 clone/worktree + filesystem Snapshot + `git add -A -- <replacementRoot>` + push，再调用 GitHub PR API。

创建 publication 时同时保存 `expectedTreeSha256`，它表示把本次 Snapshot materialize 到 `replacementRoot` 后按规范化 path/mode/content hash 计算出的期望最终树 hash，供 merge 后 reconciliation 做精确校验。

推荐 commit：`feat: sync skill bundle <namespace> from <import-id>`；PR/MR title：`Sync Skill Bundle: <namespace>`。

如果最新 target branch 与 Snapshot 完全一致，则不创建空 PR/MR，直接进入 `published`，写入 `kind: "no-op"` 的 publication outcome，并记录目标 revision 与 no-op 审计信息。

发布重试必须幂等：branch 名由 Import ID 稳定派生；远端 open PR/MR 可复用，但 Import branch 必须被视为可重建产物。每次 publish/retry 都应先获取并校验当前 approved target revision，再从该 revision 重新应用完整 `replacementRoot` Snapshot。GitLab 使用 Commits API 的 `start_sha + force` 重建 Import branch；GitHub 更新已存在的远端 Import branch 时仍使用绑定明确 expected SHA 的 `--force-with-lease=refs/heads/<branch>:<observed-sha>`。`publish_failed` 可重试。

## 12. PR/MR 合并后的状态

```text
pending -> approved ----------------> publishing
   |          |                          |
   |          +-> review_stale           +-> PR closed/unmerged -> publish_failed -> retry
   |                -> re-review         |
   +-> rejected                          +-> PR merged -> final tree verify
                                                     |-> matches -> published
                                                     +-> differs -> published_drifted
```

创建 PR/MR 不等于 `published`。reconciliation 确认 remote PR/MR 已 merged 后，还必须读取 target branch 最新 `replacementRoot`，计算 canonical tree hash，并与本次 Snapshot 的 `expectedTreeSha256` 比较。完全一致才进入 `published`；如果 PR 已 merged 但最终树不同，则进入 `published_drifted`，记录 `finalTreeSha256` / `finalTreeVerifiedAt` 和差异摘要。`published_drifted` 表示 Git merge 已成功但完整快照语义没有精确落地，不应伪装成 `publish_failed`。closed but unmerged 才进入 `publish_failed`。polling/reconciliation 必须覆盖 Bundle publication 和 merge 后最终树验证。

Reconcile 的传输/API 暂时失败不能改写已经确认的 terminal publication outcome。`published` / `published_drifted` 再次 reconcile 遇到 GitHub/GitLab 超时或 5xx 时保持原状态，只返回本次 reconcile 错误；只有尚处于发布流程中的 Import 才允许因 reconciliation failure 进入失败状态。

`published_drifted` 不自动创建修复 PR，也不回滚已经 merge 的提交；管理员可以基于最新 target tree 重新 Preview / Import，显式决定是否再次把期望 Snapshot 应用到该 `replacementRoot`。

## 13. 后续快照更新

同一 namespace 可以存在多条历史 Import Batch，不覆盖旧记录，也不建立 namespace binding。不同 `skill_path` 的 `skill` Import 拥有不同 `replacementRoot`，例如 `ota/design` 与 `ota/usage` 可以并行演进而不会互相删除。

两个用户可以同时提交同一 namespace 的不同 Snapshot，甚至创建两个 PR/MR；只有 `replacementRoot` 重叠时才存在覆盖性 diff / 审核漂移风险。潜在冲突交给人工 Review 与 Git merge rules，Hub 不实现“最后写入者自动胜出”。`collection` import 因替换整个 namespace，应被视为与该 namespace 下所有 `skill` import 的 `replacementRoot` 重叠。

发布前 `review_stale` 只能防止“创建 PR 时审核基线已经过期”，不能保证多个重叠 PR 后续按任意顺序 merge 后仍保持某个 Collection Snapshot 的最终树。因此 merge 后必须执行上一节的 final tree verification。典型场景是 collection PR 先创建，随后 sibling `skill` PR merge，再合并 collection PR；Git 可能保留后加入的 sibling，而不会自动产生删除，这时 collection Import 应进入 `published_drifted`。

## 14. Bundle 删除

第一阶段不提供 `delete_skill_bundle` MCP tool，也禁止空 Bundle，因此不会因误提交空文件列表删除整个 namespace。未来可以由 Admin 页面增加“删除 Bundle”并生成删除整个 namespace 的 PR/MR。

## 15. HTTP / Admin API

建议独立 API：

```text
POST /admin/api/skill-bundles/preview
POST /admin/api/skill-bundles/import
GET  /admin/api/skill-bundles
GET  /admin/api/skill-bundles/:id
POST /admin/api/skill-bundles/:id/approve
POST /admin/api/skill-bundles/:id/reject
POST /admin/api/skill-bundles/:id/publish
POST /admin/api/skill-bundles/:id/reconcile
```

ZIP 与 Git source 最终必须转换成同一 `SkillBundleSnapshot` 再调用 Application Service。

Web preview/import 请求体在 HTTP 层使用与 Bundle 领域约束一致的 discriminated schema 校验 `import_type`、`skill_path`、source type、file mode 与基础长度；不能依赖 `Body: any` 后再隐式解释。由于合法 Bundle 总量可超过 Fastify 的通用默认 body limit，只有这两个 Bundle POST 路由单独设置足以承载上限及 base64 开销的 body limit，其他 API 不随之放宽。

## 16. 存储

Import Batch 使用当前 storage abstraction 持久化，并支持当前 JSONL / SQLite 方向。Snapshot 至少在 PR/MR merge 后 final tree verification 完成前必须可靠保留，服务重启后仍可发布/重试/校验；不能只放进程内存或临时目录；通用 observability event 不复制 Bundle 全文。

Snapshot 与 Import 状态历史必须物理分离。第一阶段允许把文本 Snapshot 保存在业务数据库，但 Snapshot 必须是 immutable、只保存一次，状态/history 只保存 `snapshotId` / hash 和状态元数据，不能像当前 Candidate history 那样每次状态变化都复制整个 `files[]`。建议至少形成 `skill_bundle_import`、`skill_bundle_snapshot`、`skill_bundle_file`、`skill_bundle_import_history` 四个逻辑存储单元；未来把 snapshot/file 内容迁移到 blob/artifact storage 时不改变 Import 领域模型。

Admin Bundle list 的 `status` / `repository` / `namespace` / `import_type` / text query、排序和 cursor/limit 分页必须下推到 SQLite，再执行 `LIMIT/OFFSET`；不能先截取固定数量的最新 Import 后在内存过滤，否则历史记录超过截断阈值后会产生“实际存在但筛选为空”的错误结果。

`published_drifted` 的修复不能复用原 Import。Admin 至少提供“查看最终差异”和“基于最新 target 重新导入”入口；重新导入创建新的 Import Batch，并可引用原 Import ID 作为 provenance。acknowledge 只表示管理员确认现状，不改变仓库内容，也不把旧 Import 状态改成 `published`。

### 16.1 授权模型

Bundle Import 必须复用现有 Principal / repository visibility 与 publishing route 权限模型，而不是因为增加了新 API 就绕开 `allowedRepositories(principal)` 一类约束。MCP principal 只能向其可见且允许 Skill publishing 的 repository 提交和 preview；普通提交者不能 approve / reject / publish。Admin Web 的 approve、reject、publish、retry、reconcile 和 `published_drifted` acknowledge 使用现有 Admin session/auth 能力，并在 Application Service 再次做服务端授权校验，不能只依赖前端隐藏按钮。Repository 不可见、Skill publishing 未启用或 publishing target 不允许时必须在创建 Import 前失败。

## 17. 安全边界

重点防止 path traversal、zip-slip、symlink escape、Git URL SSRF/local protocol、DNS rebinding/redirect 到非允许地址、clone/pack 磁盘耗尽、超大请求、重复路径/case collision、恶意文件名进入 shell、branch/commit message 注入，以及 Admin HTML 未转义文件内容。所有 Git 命令继续使用参数数组，不拼接 shell command string；Git Import 禁止 submodule/LFS 自动拉取，并受 host allowlist、网络地址校验、timeout 和磁盘/文件数量配额约束。

## 18. Admin Web 信息架构

建议增加 `Skill Bundle` 管理页，内部包含 Import、Pending Review、History 三个二级入口或 tab。Import 页负责 ZIP/Git 输入与 preview；Review/History 管理已创建 Import Batch。

列表优先显示操作列，并直接暴露本次替换边界，避免管理员只看 namespace 误以为整个目录都会被覆盖：

```text
操作 | Namespace | Import Type | Replacement Root | 状态 | 来源 | Skill | Files | Diff | Submitter | 更新时间 | PR/MR
```

## 19. 与现有能力的关系

Skill 侧统一采用 Bundle-first，唯一客户端提交入口是 `submit_skill_bundle`。`import_type=skill` 表示一个明确 Skill root，`import_type=collection` 表示用户明确选择的多 Skill namespace Snapshot；服务端不得根据“文件少”或“只有一个 SKILL.md”把单 Skill降级到另一套 Candidate 协议，也不得因为输入歧义扩大 replacement boundary。

Skill Creator 应直接生成完整 Skill 目录并调用 `submit_skill_bundle`，因此不再存在单独的“单文件 Skill 发布”协议。

现有 `list_skills`、`search_skills`、`resolve_skill`、`get_skill`、`get_skill_resource` 不需要改变；Bundle merge 并 Repository Sync 后，各 Skill 仍作为普通 Skill 被索引和消费。

## 20. 可观测性与审计

至少记录 Import created/reused、validation failed、approved/rejected、review stale、publish started/failed、PR/MR created/reused、remote merged/closed、final tree verified/drifted、published/published_drifted/no-op，以及 source type、namespace、import type、replacement root、snapshot hash、expected/final tree hash、target revision、submitter、reviewer、Skill/File 数量和 diff counts。Git Import 还应记录 `repository_url`、用户请求的 revision、解析后的 commit SHA、`source_root`；ZIP Import 记录 archive SHA-256。审计事件引用 Snapshot ID/hash，不复制 Bundle 全文。

## 21. 验收场景

至少覆盖：

1. MCP 以 `import_type=collection` 提交包含多个 `SKILL.md` 和 references 的 Superpowers 风格 Bundle，产生一个 `pending` Import Batch；
2. Web ZIP 导入相同目录结构，走相同校验与 Snapshot 语义；
3. Web Git URL 导入公开仓库指定 revision，并记录解析后的 revision；
4. Admin preview 显示新增、修改、删除；
5. Approve + publish 只创建一个 PR/MR；
6. PR/MR 创建后状态是 `publishing`；
7. remote merge 后 reconcile 只有在最终 `replacementRoot` tree 与 Snapshot 完全一致时才进入 `published`；
8. closed-unmerged 进入 `publish_failed`；
9. 同 `replacementRoot` 新版本采用快照更新并删除该边界内旧文件；
10. 完全相同 Snapshot no-op，不创建空 PR/MR；
11. path traversal、zip-slip、symlink、重复路径、case collision、超限输入被拒绝；
12. 重试不会重复创建 PR/MR；
13. 服务重启后 pending/approved/publishing Bundle 仍可继续；
14. Approve 后本次 `replacementRoot` 内新增/修改/删除任意文件时，publish 不会直接覆盖，而是进入 `review_stale` 并要求重新审核；
15. Git Import 对未允许 host、loopback/private/link-local 地址、redirect 绕过、submodule/LFS 和资源超限输入拒绝；
16. Snapshot 状态多次变化不会在持久化层重复保存全部文件正文；
17. Git/MCP 提供 executable mode、或 ZIP entry 明确保留可信 Unix executable mode 时，`0755` 文本脚本发布后仍保持 executable；缺失 mode 的 ZIP 文件按 `0644`；
18. MCP `tools/list` 暴露 `submit_skill_bundle`，且不再暴露 `submit_skill_candidate`；`submit_knowledge_candidate` 的 schema 不接受 Skill 专用字段；
19. 先提交 `namespace=ota, import_type=skill, skill_path=design`，再提交 `namespace=ota, import_type=skill, skill_path=usage`，第二个 PR 不得删除或修改 `skills/ota/design/**`；
20. `namespace=superpowers, import_type=collection` 仍可对整个 `skills/superpowers/**` 执行完整快照更新；
21. `import_type=skill` 只接受 Snapshot 根的唯一一个 `SKILL.md`，包含 `nested/SKILL.md` 或多个 `SKILL.md` 时原子拒绝；
22. `skill_path` 的 traversal、绝对路径、drive path 和逃逸输入被拒绝，多级安全相对路径可以生成预期 `replacementRoot`；
23. collection PR 创建后，如果同 namespace 的 sibling skill PR 先 merge，collection PR 随后 merge 且最终 tree 与 Snapshot 不同，reconcile 进入 `published_drifted` 而不是 `published` / `publish_failed`；
24. `publish_failed` 或 re-review 后重试时，Import branch 从当前 approved target revision 重建，不复用旧 branch base 做增量写入；
25. 当前 legacy `ota/design/SKILL.md` 能确定性映射为 `namespace=ota, skill_path=design`，而无法确定 skill path 的 legacy 路径不会被错误提升成 collection；
26. collection 中出现祖先/后代嵌套 Skill root 时原子拒绝；
27. 相同 `submission_key` 只有在 repository / collection / namespace / import type / skill path / snapshot 全部一致时幂等返回已有 Import，否则冲突；
28. 无权限 principal 不能向不可见或未启用 Skill publishing 的 repository 创建 Import；
29. `published_drifted` 的重新同步必须创建新 Import，旧 Import 状态和审核记录保持不可变；
30. 合并同步后，各 Skill 仍能通过现有 Skill MCP tools 正常使用；
31. 两个管理员基于同一旧 revision 并发 Approve/Reject 或 Publish 时，只有一个 CAS 更新成功，另一方得到 state conflict，不会覆盖新状态或重复启动发布；
32. 已存在 Import branch 的 retry 使用观测到的远端 branch SHA 作为显式 force-with-lease expected value；远端 branch 被第三方改写时 push 安全失败；
33. ZIP 单 entry 解压输出超过 512 KiB 时在 streaming 阶段立即中止，不先完整占用对应内存；
34. Git URL DNS 校验通过后，实际 clone/fetch 绑定同一批已验证公网地址，且 clone/fetch 期间临时目录超过磁盘配额会快速终止整个进程组；
35. 已经 `published` / `published_drifted` 的 Import 在后续 reconcile 遇到暂时性 remote failure 时保持原 publication 状态；
36. Admin Bundle 的筛选先在 SQLite 执行再分页，超过 1000 条历史后仍能找到较早的 pending/rejected 等记录；
37. 同一 `submission_key` 的重试返回旧 Import 并记录 reused event，不重复 preview target，也不重复统计 created；
38. 合法但 HTTP JSON 大于通用默认 body limit 的 Bundle preview/import 可以通过 Bundle 专用 body limit 到达领域校验，其他 API 的 body limit 不被放宽。

## 22. 实施边界

实现优先复用现有 repository publishing config、GitHub/GitLab request/auth、PR/MR reconciliation、Admin session/auth、storage abstraction、Skill parser/validator 和 Repository Sync。

Skill 侧以 Bundle Snapshot 作为唯一发布抽象：单文件 Skill、多文件 Skill、多 Skill collection 都使用同一数据结构和 Publisher；差异只体现在 `importType` / `replacementRoot`。不要给 `KnowledgeCandidate` 增加 Skill Bundle 专用字段，也不要重新增加第二个 Skill 提交入口。

当前实现按本设计及 `docs/superpowers/plans/2026-10-14-skill-bundle-import.md` 以 TDD 顺序落地；后续变更继续以本文件的 replacement boundary、审核基线、CAS、幂等和安全边界为契约。
