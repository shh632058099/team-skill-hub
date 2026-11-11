# Team Skill Hub Work Orchestration Design

> 状态：评审通过，可进入 implementation plan；已完成 Superpowers builder-check，并对照 OpenAI Symphony 当前 SPEC / reference implementation 修订。本文只定义目标模型与演进路线，不代表对应能力已实现。
>
> 日期：2026-11-09
>
> 目标：在现有 Team Skill Hub Expert Platform 之上，引入类似 OpenAI Symphony 的“Work Orchestration”思想，把平台从“专家任务执行平台”演进为“研发工作持续推进平台”。

## 1. 执行摘要

当前 Team Skill Hub 已经具备 Expert、Deployment、Worker、Task、Run、Event、MCP、Skill / Knowledge、结果反馈等核心能力，已经可以完成“提交一个问题 -> 路由专家 -> Worker 执行 -> 返回结果 -> 用户反馈”的单次专家闭环。

这一模型解决的是：

> 谁来处理、在哪里执行、用什么模型和工具执行、结果如何返回。

但它还没有完整解决：

> 一件研发工作如何从“待处理”持续推进到“真正完成”。

OpenAI Symphony 的核心价值并不在于“再启动一个 Codex”，而在于把 Issue / Work Item 当成平台级一等对象，通过 Orchestrator 持续管理状态、Workspace、Agent continuation、失败重试、人工 Review、返工、验证证据和最终完成条件。

因此，本设计不建议直接 fork / 嵌入 Symphony，也不建议替换现有 Expert Platform，而是吸收其 Work Orchestration 思想，在 Team Skill Hub 现有能力之上增加独立的工作编排层：

```text
Work Source
  GitHub / GitLab / Jira / MCP / Admin / Automation
                     |
                     v
              Work Orchestrator
          state / retry / rework / gate
                     |
                     v
               Expert Platform
          Expert / Deployment / Router
                     |
                     v
               Execution Layer
       Worker / Workspace / Claude / Codex
                     |
                     v
        Evidence / Feedback / Outcome
```

最终目标是让用户管理“工作”，而不是持续监督每一次 Agent 调用。

---

## 2. 为什么现在需要 Work Orchestration

### 2.1 当前 Expert Platform 已经解决的问题

现有架构已经具备：

- Expert Definition：定义领域能力。
- Deployment：绑定 Expert 与仓库、Executor、模型、MCP Profile、权限。
- Worker：独立执行节点。
- ExpertTask：一次专家任务。
- Run：一次 Worker 执行实例。
- Event：结构化执行事件。
- MCP：Claude / Codex / 外部客户端提交和等待任务。
- Session 去重：避免一个 CLI Session 重复创建相同活跃任务。
- Feedback：记录已采纳 / 部分采纳 / 未采纳 / 是否返工。
- Admin：任务状态、Worker 状态、运行时间线、反馈统计。
- Skill / Knowledge：执行时的领域知识与能力来源。

这些能力已经构成一个可靠的 Expert Execution Platform。

### 2.2 当前模型的缺口

目前的核心对象仍然是 `ExpertTask`。

当 Task 成功时，平台主要判断：

```text
Worker 是否执行完成？
Agent 是否返回结果？
Task 是否 succeeded？
```

但实际研发工作的完成条件通常是：

```text
问题是否真正解决？
代码是否修改完成？
构建是否通过？
测试是否通过？
是否已经创建 PR？
PR Review 是否已处理？
CI 是否通过？
人工是否接受？
是否需要返工？
最终是否已合入？
```

因此：

```text
Task succeeded != Work completed
```

这是引入 Work Orchestration 的根本原因。

### 2.3 具体会出现的问题

如果继续只在 ExpertTask 上扩展，未来会出现以下问题：

1. **Task 状态被迫承载过多语义**
   - succeeded 到底代表 Agent 正常退出，还是工作已验收？
   - failed 是执行失败，还是缺权限，还是等待人工输入？

2. **Retry 语义混乱**
   - Agent crash 后重试。
   - Agent 正常结束但工作未完成，需要 continuation。
   - 人工反馈要求返工。
   - 三者都叫 retry 会失去审计价值。

3. **Workspace 生命周期与 Task/Worker 混在一起**
   - continuation 是否继续使用原 checkout？
   - Worker 重启后如何恢复？
   - 一个 Worker 多任务时源码目录如何隔离？

4. **Feedback 目前只是结果数据**
   - `needsRework=true` 目前不会自动驱动后续工作流。

5. **没有统一 Completion Gate**
   - Agent 说“完成”并不足以证明工作真正完成。

6. **未来接 GitHub/GitLab/Jira 后容易 Tracker 驱动架构失控**
   - 如果每个 Tracker 都直接创建 ExpertTask，会把外部状态机耦合进任务模型。

---

## 3. Symphony 给我们的关键启发

本设计参考 OpenAI Symphony 的整体思想，但不复制其实现。

值得吸收的核心思想有七项。

### 3.1 Work Item 是一等公民

Symphony 管理的是 Issue，而不是某一次 Codex 调用。

Team Skill Hub 应对应引入：

```text
WorkItem
```

WorkItem 表示“需要被平台持续推进到完成的一件工作”。

ExpertTask 则退回为：

> WorkItem 的一次专家执行活动。

### 3.2 Worker 正常退出不等于工作完成

一个 Agent turn 正常结束后，如果 WorkItem 仍处于 active 状态，Orchestrator 可以继续执行后续 turn。

因此需要明确：

```text
Run succeeded
    !=
WorkAttempt completed
    !=
WorkItem completed
```

### 3.3 Continuation 与 Failure Retry 分离

Symphony 明确区分：

- 正常结束，但工作仍需继续：continuation。
- 执行异常退出：failure retry。

Team Skill Hub 还需要增加第三类：

- 人工反馈或 Review 要求重新处理：rework。

### 3.4 Blocked 是正式状态

缺少权限、Secret、工具、审批、人工输入时，不应统一归类为 failed。

应该进入：

```text
blocked
```

并记录明确的 blocker reason。

### 3.5 Workspace 是一等运行对象

一个 WorkItem / WorkAttempt 应拥有可追踪 Workspace。

Continuation 默认复用当前 Workspace，而不是每次重新 clone。

### 3.6 Proof of Work 比“Agent 说完成了”更重要

工作完成应依赖 Evidence：

- build
- tests
- lint
- CI
- PR
- review status
- artifact
- runtime validation

### 3.7 Workflow Contract 是独立配置

Symphony 使用 `WORKFLOW.md` 描述运行规则和 Prompt。

Team Skill Hub 应吸收“Workflow 是一等公民”的思想，但把机器可验证规则结构化，而不是全部堆进 Markdown。

---

## 4. 本设计不照搬 Symphony 的部分

### 4.1 不以 Tracker 作为唯一 Source of Truth

Symphony 偏向：

```text
Tracker Issue = Work
```

Team Skill Hub 的来源更广：

- MCP
- Claude CLI
- Codex CLI
- Admin
- GitHub Issue
- GitLab Issue
- Jira
- Automation

因此应由 Team Skill Hub 自己维护 `WorkItem`，Tracker 只是 Adapter。

### 4.2 不限制为 Codex

现有平台已经支持 Executor 抽象：

- Claude
- Codex
- 未来其他 Runtime

Work Orchestrator 不应绑定某一个模型或 CLI。

### 4.3 不直接复制 Elixir / OTP 实现

Symphony 的参考实现是 prototype。

Team Skill Hub 保持现有 TypeScript / Worker / gRPC / SQLite 架构，吸收语义和状态机即可。

### 4.4 不把所有机器规则塞进一个巨型 WORKFLOW.md

建议：

```text
WorkflowDefinition
├── structured policy
└── agent instructions
```

其中：

- 状态机
- retry
- validation
- workspace policy
- review gate
- completion policy

使用结构化配置。

只有 Agent Instruction / Prompt Template 使用 Markdown。

### 4.5 与 Symphony 的明确差异

| 主题 | Symphony | Team Skill Hub 选择 |
|---|---|---|
| 顶层工作对象 | Tracker Issue | Hub-owned WorkItem，可来自 Tracker / MCP / Admin / Automation |
| Orchestrator 状态 | 允许 running / blocked / retry 等主要驻留内存，靠 Tracker + filesystem 重发现 | WorkItem / WorkAttempt / blocked / retry / claim / completion 必须 durable |
| Executor | Codex-centric | Claude / Codex / future executor |
| Workspace | deterministic per-issue workspace，跨 run 保留 | deterministic logical workspace + owner Worker + physical location |
| continuation | same thread / same workspace 多 turn，之后可 continuation retry | same Run multi-turn 优先；进程级 continuation 新 Run；仍属于同一 WorkAttempt |
| retry | attempt 计数覆盖 continuation / failure retry | failure retry 是 Run 级；Human/Review rework 是 WorkAttempt 级 |
| Tracker | 主要工作真相来源 | Adapter / signal source，不直接拥有 Hub 内部状态机 |
| Evidence | 主要通过 workflow / tracker / agent proof 表达 | 结构化 Evidence + 复用 Verification revision binding + stale 规则 |
| Human control | workflow-defined Human Review / Merging 等状态 | ReviewDecision / Approval 独立权限对象，受保护 Gate 不由 Feedback 替代 |
| 去重 / claim | single authoritative orchestrator + claimed/running | durable claim + state revision + fencing / idempotency |

因此，本设计的原则不是“复制 Symphony”，而是：

> 使用 Symphony 已验证的调度、continuation、workspace、reconciliation 思路，叠加 Team Skill Hub 已有的持久化、权限、Worker、Deployment、Verification、MCP 与审计能力。

---

## 5. 目标架构

```text
                  Work Sources
       +-------------+-------------+
       |             |             |
      MCP         Tracker        Admin
       |      GitHub/GitLab/Jira   |
       +-------------+-------------+
                     |
                     v
              Work Intake Layer
                     |
                     v
                 WorkItem
                     |
                     v
              Work Orchestrator
       +-------------+-------------+
       | state machine             |
       | continuation / retry      |
       | blocked / review / gate   |
       | completion policy         |
       +-------------+-------------+
                     |
                     v
               WorkflowDefinition
                     |
                     v
               Expert Platform
          Expert Router / Deployment
                     |
                     v
                WorkAttempt
                     |
                     v
               ExpertTask
                     |
                     v
                   Run
                /    |    \
           Turn 1  Turn 2  ...
                     |
                     v
                 Worker
                     |
                     v
                Workspace
                     |
              Claude / Codex
                     |
                     v
                 Evidence
                     |
                     v
                  Outcome
                     |
           Feedback / Rework / Done
```

---

## 6. 核心对象模型

## 6.1 WorkItem

WorkItem 是新的顶层逻辑对象。

建议字段：

```text
work_item_id
source_type
source_scope
source_ref
source_url
idempotency_key
principal_id
scope
title
description
status
state_revision
workflow_id
active_work_attempt_id
orchestration_epoch
priority
created_at
updated_at
completed_at
```

语义：

- 一件真实需要完成的研发工作。
- 生命周期可跨多个 ExpertTask。
- 可来自 Tracker，也可来自 MCP / Admin。
- WorkItem 自己拥有最终状态。
- `source_type + source_scope + source_ref` 对 Tracker 类来源形成稳定外部身份；去重边界必须与 Work 的授权/租户边界一致，因此同一 `principal_id + scope` 内同一 source tuple 不能创建多个有效 WorkItem，不跨授权边界复用 WorkItem。
- `idempotency_key` 用于 MCP / Admin / Automation 创建请求的重试去重。
- `state_revision + orchestration_epoch` 用于 CAS / fencing；`active_work_attempt_id` 是当前方案级执行的 durable pointer。

### 为什么不能直接复用 ExpertTask

因为 ExpertTask 表示：

> 一次明确的专家执行请求。

而 WorkItem 表示：

> 一个可能需要多个专家、多次尝试、多个验证步骤才能完成的工作目标。

二者生命周期不同。

---

## 6.2 WorkflowDefinition

WorkflowDefinition 定义：

> WorkItem 应该如何被持续推进到完成。

这里不新增第二套 WorkflowDefinition。应扩展原 Expert Platform Design 已定义的 WorkflowDefinition，使它同时表达“生命周期策略”和未来的 DAG / Gate。

Phase 1 只使用单节点 graph；Phase 3 再扩展到多节点 DAG。

建议结构：

```yaml
id: code-fix-default
version: 1

lifecycle:
  attempt:
    maxWorkAttempts: 5
    maxReworks: 3

  continuation:
    maxTurnsPerRun: 20

  retry:
    failure:
      enabled: true
      maxRuns: 3
      backoff: exponential

  blocked:
    timeoutPolicy: manual

execution:
  workspace:
    strategy: isolated
    reuseOnContinuation: true
    cleanup: on_terminal

validation:
  required:
    - build
    - unit_test

review:
  humanReview: true

completion:
  require:
    - latest_work_attempt_succeeded
    - required_evidence_passed
    - no_unresolved_blocker
    - review_accepted

graph:
  mode: single-node

agentInstructions: |
  ...
```

未来 DAG 版本仍使用同一个 WorkflowDefinition：

```text
WorkflowDefinition
├── lifecyclePolicy
│   ├── retry
│   ├── continuation
│   ├── blocked
│   ├── review
│   └── completion
│
├── executionPolicy
│   └── workspace / timeout / concurrency
│
├── validationPolicy
│
├── graph
│   ├── Phase 1: single-node
│   └── Phase 3: DAG
│
└── agentInstructions
```

### 为什么要独立于 Expert

Expert 回答：

> 谁来做。

Workflow 回答：

> 怎么推进到完成。

Deployment 回答：

> 在哪里、用什么 Runtime、模型、工具和权限做。

三者职责必须分开。

### Workflow 版本固定

WorkAttempt 创建时必须固定：

```text
workflow_id
workflow_version
expert_id
deployment_id
deployment_config_version
```

运行中的 WorkAttempt 不受 WorkflowDefinition 热更新影响。配置变化只影响后续新建的 WorkAttempt / ExpertTask，不能静默改变正在执行的工作。

这吸收了 Symphony 在 Agent Session 启动时绑定当前 tracker/settings、避免运行中配置漂移的思想，并与现有 Deployment configVersion 机制保持一致。

---

## 6.3 WorkAttempt、ExpertTask、Run 与 Agent Turn

为避免把“方案重做”“进程重试”“同一会话继续工作”混成一个 Attempt，本设计明确四层语义：

```text
WorkItem
└── WorkAttempt
    └── ExpertTask
        └── Run
            └── Agent Turn(s)
```

### 6.3.1 WorkAttempt

WorkAttempt 表示：

> 针对 WorkItem 的一次方案级解决尝试。

建议字段：

```text
work_attempt_id
work_item_id
sequence
reason
status
expert_id
deployment_id
workspace_id
workflow_id
workflow_version
deployment_config_version
started_at
finished_at
parent_work_attempt_id
```

reason：

```text
initial
human_rework
review_rework
policy_replan
```

WorkAttempt 不用于记录普通 continuation 或瞬时执行故障。

### 6.3.2 ExpertTask

现有 ExpertTask 保留。

未来语义收敛为：

> WorkAttempt 内的一次专家任务。

推荐新增可空引用：

```text
work_item_id
work_attempt_id
workflow_id
workflow_version
```

现有 MCP 直接提交 ExpertTask 的模式继续支持。

如果没有 WorkItem：

```text
Standalone ExpertTask
```

保持现有行为，以保证向后兼容。

### 6.3.3 Run

现有 Run 保留。

职责限定为：

> Worker 对某个 ExpertTask 的一次实际执行实例。

Run 负责：

- worker_id
- fencing / run epoch
- runtime
- execution events
- started / stopped
- executor exit
- failure retry sequence

Run 不负责判断 WorkItem 是否完成。

### 6.3.4 Agent Turn

一个 Run 内允许 Agent 在同一 live session / thread / Workspace 中连续执行多个 Turn。

这直接借鉴 Symphony：

```text
Turn #1 正常结束
      |
      v
重新判断工作是否仍 active
      |
      +-- yes --> same session + same workspace --> Turn #2
      |
      +-- no ---> Run 结束
```

因此三个概念必须区分：

```text
Continuation
  = 同一 Run 内继续 Agent Turn，优先 same session / same workspace

Failure Retry
  = 当前 Run 因可恢复执行故障结束，创建新 Run
    但通常仍属于同一个 WorkAttempt

Rework
  = 人工反馈 / Review / Validation 触发方案级重新处理
    创建新的 WorkAttempt
```

### 为什么这样分层

Symphony 的 Run Attempt 同时承担 retry / continuation 计数，适合轻量单 Agent orchestrator；Team Skill Hub 已经有 ExpertTask、Run、Worker Event 和多 Runtime，因此需要更清晰的层级，否则后续审计、Admin 展示和恢复逻辑会再次混淆。

---

## 6.4 Workspace

Workspace 提升为一等对象，但必须区分逻辑身份和物理位置：

```text
Workspace logical identity
    !=
Workspace physical location
```

建议字段：

```text
workspace_id
workspace_key
work_item_id
work_attempt_id
owner_worker_id
repository_url
branch
base_commit
path
state
created_at
last_used_at
cleanup_policy
```

其中：

- `workspace_id`：Hub 内逻辑身份。
- `workspace_key`：可确定性重新计算的稳定 key。
- `owner_worker_id + path`：实际物理位置。

状态建议：

```text
allocating
ready
in_use
retained
cleaning
removed
failed
```

核心规则：

1. 一个活跃 WorkAttempt 有明确 Workspace。
2. 同一 Run 内 continuation 必须复用当前 Workspace。
3. failure retry 默认优先复用当前 Workspace，由 Workflow Policy 控制。
4. human/review rework 可以复用，也可以要求 fresh workspace。
5. terminal 后按 cleanup policy 清理。
6. workspace_key 必须 deterministic 且避免清洗后的名称碰撞，可采用稳定 hash suffix。
7. 不能根据路径存在就假定 Workspace 有效；必须结合 owner、revision 和状态核验。

### Worker affinity

Phase 1 明确：

```text
Continuation / retry
       |
       v
preferred worker = owner_worker_id
       |
       +-- owner online and workspace valid
       |       -> reuse
       |
       +-- owner unavailable / workspace missing
               -> blocked(workspace_unavailable)
```

第一阶段不自动把本地 Workspace“猜测迁移”到另一台 Worker。

后续可引入：

- git branch / commit checkpoint
- artifact snapshot
- workspace checkpoint
- rehydrate

再支持跨 Worker 恢复。

### 为什么 Workspace 必须独立于 Worker

```text
Worker != Workspace
```

一个 Worker 可以同时或连续承载多个 Workspace。

Worker 是执行节点。

Workspace 是某个 WorkAttempt 的执行上下文。

这与 Symphony “deterministic per-issue workspace + preserve across runs”的设计一致，但 Team Skill Hub 额外持久化 Workspace 的逻辑身份和 Worker 归属。

---

## 6.5 Evidence / Verification

Evidence 是证明工作状态的结构化证据，但不能退化原 Expert Platform Design 已定义的 Verification 版本绑定语义。

建议将 Evidence 作为通用信封：

```text
evidence_id
work_item_id
work_attempt_id
task_id
run_id
type
status
source
summary
artifact_ref
subject
provenance
stale
created_at
```

type 示例：

```text
build
unit_test
integration_test
lint
ci
pull_request
review
runtime_validation
artifact
manual_check
```

status：

```text
pending
passed
failed
unknown
```

source 至少区分：

```text
agent_reported
worker_verified
ci_verified
human_verified
external_verified
```

### Evidence 必须绑定验证对象

对于可作为 Completion Gate 的验证类 Evidence，必须绑定：

```text
source repository revision
dependency / manifest revision
artifact digest
workspace snapshot / base
toolchain version
environment / device identity
verifier identity + version
```

因此可以理解为：

```text
Evidence
└── VerificationEvidence
    ├── subject revision
    ├── environment identity
    ├── verifier identity
    └── result
```

一旦上游源码、依赖、Artifact、环境或关键配置发生变化：

```text
old Evidence -> stale
```

Completion Gate 不得使用 stale Evidence。

Evidence 不应只存在于 Agent 最终文本中；Agent 自报证据默认不能等价于 Worker/CI/Human 可验证证据。

---

## 6.6 Feedback、ReviewDecision 与 Approval

现有 ExpertTask Feedback 保留：

```text
adopted
partially_adopted
not_adopted
needs_rework
reason
```

但必须明确三个不同概念：

```text
TaskFeedback
    !=
ReviewDecision
    !=
Approval
```

### TaskFeedback

评价某次专家输出对调用者是否有用。

它可以作为 Orchestrator signal，但默认不具有高权限审批语义。

### ReviewDecision

针对当前 WorkAttempt / PR / Result 的工作流决策：

```text
accepted
rework
rejected
```

它可以驱动：

```text
waiting_review -> rework
waiting_review -> completion gate
```

### Approval

针对明确 revision / Evidence / Artifact 的授权 Gate。

至少绑定：

```text
actor
role
scope
subject_type
subject_revision
decision
created_at
```

代码 Owner Review、Merge Approval、权限扩大等不得由普通 TaskFeedback 替代。

### Feedback 如何驱动 Rework

初期可以由 Workflow Policy 做映射：

```text
adopted + needsRework=false
    -> signal only / eligible for review

partially_adopted + needsRework=true
    -> propose WorkItem.rework

not_adopted
    -> rework or waiting_review
```

但只有具备对应权限的 ReviewDecision / Approval 才能通过受保护的 Completion / Merge Gate。

---

## 7. WorkItem 状态机

建议第一版：

```text
queued
  |
  v
running
  |
  +------> blocked
  |           |
  |           +------> running
  |
  +------> waiting_review
  |              |
  |              +------> rework
  |              |           |
  |              |           +------> running
  |              |
  |              +------> completed
  |
  +------> failed
  |
  +------> cancelled
```

状态定义：

| 状态 | 含义 |
|---|---|
| queued | 已接收，等待编排 |
| running | 当前 WorkAttempt 正在推进 |
| blocked | 缺少外部条件，当前无法继续 |
| waiting_review | 自动执行完成，等待人工或外部 Review |
| rework | Review / Feedback 要求重新规划或重新处理 |
| completed | Completion Gate 全部满足 |
| failed | Workflow 判定无法继续 |
| cancelled | 被人工或上游取消 |

### 7.1 Blocked Reason

建议标准化：

```text
missing_permission
missing_secret
missing_tool
operator_input
approval_required
repository_access
dependency
external_service
resource_unavailable
workspace_unavailable
policy_blocked
unknown
```

Blocked 记录必须持久化：

```text
blocked_reason
blocked_context
blocked_at
resume_condition
blocked_by_type
blocked_by_ref
```

Blocked 表示：

> 当前条件不满足，但工作本身仍然有效。

Failed 表示：

> Workflow 已经无法或不应继续推进。

两者的恢复和运营处理完全不同。

### 7.2 并发与终态 invariant

Phase 1 必须满足：

1. 一个 WorkItem 最多只有一个 active WorkAttempt。
2. 一个 WorkAttempt 最多只有一个 active ExpertTask。
3. terminal WorkItem 不允许创建新的 WorkAttempt。
4. 旧 WorkAttempt / Run 的迟到结果不能推进当前 WorkItem。
5. cancel 必须传播给当前 active ExpertTask / Run。
6. 所有状态推进必须使用 expected revision / fencing / CAS 语义。
7. 当前 active WorkAttempt 必须能通过 durable reference 唯一确定。
8. retry / continuation 在执行前必须重新确认 WorkItem 仍可继续。

---

## 8. WorkAttempt / Run 生命周期

```text
WorkAttempt #1
   |
   v
ExpertTask
   |
   v
Run #1
   |
   +-- Turn #1
   +-- Turn #2 continuation
   |
   +-- transient failure
           |
           v
        Run #2 failure_retry
           |
           v
        succeeds
           |
           +-- Review accepted ------> completion gate
           |
           +-- Human rework ---------> WorkAttempt #2
```

### 8.1 Continuation

适用于：

- Agent Turn 正常返回。
- 没有运行错误。
- 当前工作仍 active。
- 当前 Workspace / live session 仍有效。

优先在：

```text
same Run
same Agent session/thread
same Workspace
```

中继续下一 Turn，直到 Workflow 的 maxTurnsPerRun。

只有 Agent 进程已退出但同一方案仍需继续时，才创建新的 Run continuation；它仍属于当前 WorkAttempt。

### 8.2 Failure Retry

适用于：

- Worker / Executor 异常退出。
- 临时网络失败。
- Runtime 可恢复错误。

Failure Retry：

- 创建新的 Run。
- 默认仍属于同一个 WorkAttempt。
- 使用 retry policy + backoff。
- 执行前必须 reconciliation，不能只依赖旧 timer。
- 外部操作结果未知时先核验，不直接重放。

### 8.3 Rework

适用于：

- 具备权限的 ReviewDecision 要求修改。
- 用户 Feedback 经 Workflow Policy 转化为 rework 请求并获得必要决策。
- Validation 失败后需要重新规划。
- Human Review 拒绝。

Rework 创建新的 WorkAttempt，并记录：

```text
origin_work_attempt_id
reason
review_context
what_should_change
created_by
```

---

## 9. Completion Gate

WorkItem 完成不能简单绑定：

```text
ExpertTask.status == succeeded
```

而应由 Completion Gate 决定。

示例：

```yaml
completion:
  require:
    - latest_work_attempt_succeeded
    - required_evidence_passed
    - no_unresolved_blocker
    - review_accepted
```

代码修复类 WorkItem 可能要求：

```text
Build           PASS (current revision)
Unit Test       PASS (current revision)
CI              PASS (current revision)
PR              exists
Review          accepted
Approval        valid for current revision
```

TaskFeedback 的 `adopted` 可以作为产品/用户体验信号，但除非 Workflow 明确允许且 principal 具有相应权限，否则不能替代 ReviewDecision / Approval。

只有 Gate 满足：

```text
WorkItem -> completed
```

### Completion Gate 的重新计算

Gate 必须基于当前有效 revision 重新计算。

如果发生：

- 新 WorkAttempt。
- source revision 改变。
- artifact digest 改变。
- Workflow / Deployment 关键输入改变。
- Approval 所绑定对象变化。

则相关 Evidence / Approval 需要标记 stale 或失效。

### 为什么需要 Completion Gate

它把：

> Agent 自我声明完成

升级为：

> 平台基于当前版本、可验证证据和授权决策判断完成。


---

## 10. Tracker Adapter

未来支持：

```text
GitHubIssueAdapter
GitLabIssueAdapter
JiraAdapter
ManualAdapter
McpAdapter
AutomationAdapter
```

统一转换成：

```text
WorkItem
```

Adapter 负责：

- 发现候选 Work。
- 标准化外部 ID。
- 读取当前外部状态。
- 写回必要的状态 / 评论 / Link。
- 接收外部 Review 变化。

Orchestrator 不直接依赖 GitHub / GitLab / Jira 的字段模型。

### 为什么不让 Tracker 直接创建 ExpertTask

否则：

```text
GitHub 状态机
GitLab 状态机
Jira 状态机
MCP 状态机
```

都会侵入 ExpertTask。

WorkItem 提供统一内部状态模型。

---

## 11. Credential / Tool 边界

吸收 Symphony 的 Host-side Tool 思想。

原则：

```text
Agent 持有 capability
Host 持有 credential
```

例如：

```text
Agent
  |
  | github_api(...)
  v
Capability Proxy / MCP
  |
  | token
  v
GitHub
```

继续沿用现有 Team Skill Hub MCP / API Key / Principal / Role / Deployment 授权体系。

不要把 Tracker Token、GitHub PAT、GitLab PAT 直接注入模型环境，除非某个 Runtime 明确需要并且有独立审批策略。

---

## 12. 与现有 Expert Platform 的兼容映射

| 现有对象 | 新模型中的位置 | 是否保留 |
|---|---|---|
| ExpertDefinition | 谁处理工作 | 保留 |
| ExpertDeployment | 实际执行配置 | 保留 |
| Worker | 执行节点 | 保留 |
| ExpertTask | WorkAttempt 内一次专家执行 | 保留 |
| Run | Worker 的一次实际运行 / failure retry 单位 | 保留 |
| Event | Task/Run 运行事件 | 保留 |
| Feedback | Task 结果采纳反馈 | 保留并升级为 Orchestrator signal |
| Verification / Approval / Artifact | Evidence 与 Completion Gate 的强验证基础 | 保留并复用 |
| MCP | Work / Task 提交入口与工具面 | 保留 |
| Skill / Knowledge | Agent 执行能力与知识 | 保留 |
| WorkItem | 顶层工作目标 | 新增 |
| WorkflowDefinition | 扩展现有定义，补充 lifecycle / execution / validation policy；未来继续承载 DAG | 扩展，不新建第二套 |
| WorkAttempt | 方案级解决尝试 | 新增 |
| Workspace | 独立执行上下文 | 从隐式概念提升为一等对象 |
| Evidence | 通用完成证据信封，Verification 是其强验证语义 | 新增 |
| ReviewDecision | 工作流 Review 决策 | 新增 |
| TrackerAdapter | 外部 Work 来源 | 新增 |
| WorkOrchestrator | 持久化工作状态机与推进器 | 新增 |

---

## 13. 现有调用方式如何兼容

### 13.1 当前 MCP ExpertTask 模式保持不变

```text
Claude CLI
   |
submit_expert_task
   |
ExpertTask
```

仍然有效。

这种任务称为：

```text
Standalone Expert Task
```

不强制创建 WorkItem。

### 13.2 新增 Work 模式

未来增加：

```text
submit_work
get_work
wait_work
review_work
```

调用链：

```text
Client
  |
submit_work
  |
WorkItem
  |
WorkflowDefinition(version pinned)
  |
WorkAttempt
  |
ExpertTask
```

### 13.3 渐进迁移

不做一次性大迁移。

现有 Task 表、Run、Worker、MCP 都继续使用。

Work Orchestration 是新增上层，不是重写现有底层。

---

## 14. Feedback 如何接入 Orchestrator

当前 Feedback 已经有：

```text
disposition
reason
needsRework
```

下一阶段最自然的增强是：

```text
Task succeeded
    |
    v
Feedback
    |
    +-- adopted / no rework --------> review/completion gate
    |
    +-- partial + rework -----------> WorkItem.rework
    |
    +-- not adopted ---------------> WorkItem.rework / waiting_review
```

Orchestrator 根据 Workflow Policy 决定是否：

- 创建新的 WorkAttempt。
- 复用或重建 Workspace。
- 重新路由 Expert。
- 继续同一 Expert。
- 创建 ReviewDecision 请求。
- 进入人工 Review。

这样 Feedback 从“统计数据”升级成“工作流控制信号”。

---

## 15. Admin UI 目标

Work Orchestration 引入后，Admin 不应只显示 Task 列表。

建议新增：

```text
Work Items
Workflows
Work Attempts
Workspaces
Evidence
```

WorkItem 详情建议：

```text
Work #W-1024
────────────────────────────
状态          Waiting Review
来源          GitHub #123
Workflow      code-fix-default
Expert        ota
Deployment    ota-codex
Workspace     ws-xxx

Work Attempts
  #1 initial          succeeded
     Run #1 · 2 turns
     Run #2 · failure retry
  #2 human_rework     running

Evidence
  Build               PASS
  Unit Test           PASS
  CI                  PASS
  PR                  #456
  Review              pending

Feedback
  部分采纳
  需要返工

Completion Gate
  4 / 5 passed
────────────────────────────
```

用户关注的核心应该从：

> 这个 Run 有没有结束？

转为：

> 这件工作现在为什么还没完成？

---

## 16. 观测与审计

WorkItem 需要独立于 Task Event 的高层事件：

```text
work.created
work.started
work_attempt.created
work_attempt.completed
run.continued
run.retry_scheduled
work.blocked
work.resumed
evidence.recorded
evidence.staled
review.requested
review.decided
approval.invalidated
rework.started
work.completed
work.cancelled
```

Task/Run Event 继续用于底层执行观测。

两层事件不要混为一体。

### 16.1 Durable Orchestration

这里明确选择比 Symphony 更强的持久化模型。

Symphony 可以依赖 Tracker + filesystem 在服务重启后重新发现工作，并允许部分 scheduler / blocked / retry 状态只存在内存；Team Skill Hub 自己就是 WorkItem 的权威状态源，又承担多用户、权限、审计和多 Worker，因此不能采用同样取舍。

Phase 1 必须持久化：

```text
WorkItem
active WorkAttempt reference
WorkAttempt
Workflow version binding
Workspace identity + owner
blocked state + reason
retry / next-action schedule
ReviewDecision / Approval linkage
Completion Gate state
orchestration events
```

WorkItem -> WorkAttempt -> ExpertTask 的创建必须具备事务性或等价的幂等恢复语义。Hub 在任意中间点 crash 后，重启不能因为“上一步是否成功未知”而重复创建新的有效任务。

推荐继续沿用现有 Expert Runtime 的方向：

```text
single Hub writer
+ durable SQLite transaction domain
+ idempotency key
+ CAS / fencing
+ reconciliation
```

Orchestrator 是 durable state machine，不是仅依赖内存 timer / set 的 scheduler。

### 16.2 Reconciliation Before Dispatch

直接吸收 Symphony 的关键原则：

> Reconciliation runs before dispatch.

每轮调度或 retry / continuation 到期时，先核验当前事实，再执行动作：

```text
1. reconcile WorkItem current revision/status
2. reconcile active WorkAttempt
3. reconcile active ExpertTask / Run
4. reconcile Worker lease / heartbeat / fencing
5. reconcile Workspace owner + existence + revision
6. reconcile external source state（存在 Tracker 时）
7. reconcile due retry / rework action
8. only then dispatch
```

禁止因为旧 timer、旧内存状态或迟到 Event 直接创建新执行。

### 16.3 Claim / Fencing

Symphony 使用单一 authoritative orchestrator + claimed/running 集合避免重复派发；Team Skill Hub 应将其升级为 durable claim。

Phase 1 invariant：

```text
一个 WorkItem 同时最多一个 orchestration owner
一个 WorkItem 同时最多一个 active WorkAttempt
```

建议 WorkItem / WorkAttempt 带：

```text
state_revision
active_work_attempt_id
claim_epoch / orchestration_epoch
```

所有推进操作使用 expected revision / transaction / fencing。旧 epoch 的 Worker/Run/Event 即使迟到，也不能推进新的 WorkAttempt。

### 16.4 Source Identity 与幂等

外部来源必须有稳定身份：

```text
source_type
source_scope
source_ref
```

Tracker 类 WorkItem 的 source tuple 在当前 Work 授权/租户边界内必须唯一。当前模型中该边界由 `principal_id + scope` 表达，因此持久化约束应满足等价于：

```text
UNIQUE(principal_id, scope, source_type, source_scope, source_ref)
```

如果未来引入独立的 tenant/workspace 主键，应以该稳定租户边界替代 `principal_id + scope`，但不得因为全局 source tuple 去重而跨授权边界复用或暴露 WorkItem。

MCP / Admin / Automation 创建 WorkItem 使用 idempotency key，避免重试、客户端断线或 webhook + polling 并发导致重复 WorkItem。


---

## 17. Phase 1：内部 Work Model

第一阶段不接外部 Tracker，不做自动扫 Issue。

目标是把内部模型打稳。

### 范围

1. 新增 WorkItem 与 durable state revision / claim。
2. 扩展现有 WorkflowDefinition，加入 lifecycle / execution / validation policy，并固定 workflow version。
3. 新增 WorkAttempt，明确 WorkAttempt / ExpertTask / Run / Agent Turn 层级。
4. Workspace 一等化，并记录 deterministic key、owner Worker 与 affinity。
5. 新增持久化 blocked 语义。
6. 新增 Evidence 通用信封，复用 Verification 的 revision / environment binding。
7. Completion Gate + stale Evidence / Approval 失效规则。
8. Feedback / ReviewDecision / Approval 分离，并支持 Feedback -> rework signal。
9. Reconciliation-before-dispatch + durable retry / continuation scheduling。
10. Source identity / WorkItem idempotency。
11. Admin WorkItem 详情。
12. 保留全部现有 ExpertTask API。

### 验收目标

可以通过 Admin 或 MCP 创建一个 WorkItem：

```text
WorkItem
  -> WorkAttempt #1
  -> ExpertTask
  -> Run #1
  -> Turn continuation
  -> transient failure
  -> Run #2 failure retry
  -> result / evidence
  -> feedback / review decision
  -> rework
  -> WorkAttempt #2
  -> current-revision evidence
  -> waiting_review
  -> completed
```

且全过程可追踪、可恢复。

---

## 18. Phase 2：Tracker Adapter

优先：

1. GitHub Issues。
2. GitLab Issues。

之后再考虑：

- Jira
- Linear
- Asana

### 能力

- 轮询候选 Work。
- 创建 / 更新 WorkItem。
- 映射 Tracker 状态。
- 写回评论 / Link / PR。
- 接收 Review 结果。
- Tracker terminal / ineligible 变化作为 reconciliation 输入，由 WorkOrchestrator 按 source policy 停止、取消或进入 Review；Adapter 不直接越过 Hub 状态机终结 WorkItem。

### 原则

Tracker Adapter 不直接调 Expert。

Tracker 也不直接拥有 WorkItem 状态。外部状态变化先标准化为 source observation / signal，再由 Orchestrator 结合当前 WorkItem revision、Workflow Policy 和 active Run 状态决定迁移。对于 terminal source，必须先停止或取消 active execution 并完成 reconciliation，不能只改数据库状态后遗留 Worker 继续运行。

始终：

```text
Tracker
  -> WorkItem
  -> Orchestrator
  -> Expert Platform
```

---

## 19. Phase 3：Autonomous Engineering Loop

第三阶段形成完整自动闭环。

```text
Todo
  |
  v
WorkItem
  |
  v
Plan / Expert Routing
  |
  v
Workspace
  |
  v
Implement
  |
  v
Build / Test
  |
  v
PR
  |
  v
Review Sweep
  |
  +---- feedback ----> Rework
  |
  v
Human Review
  |
  v
Merge
  |
  v
Done
```

包括：

- 自动 continuation。
- failure retry + backoff。
- PR review sweep。
- CI gate。
- Human Review gate。
- rework loop。
- merge gate。
- terminal cleanup。

---

## 20. 风险

### 20.1 WorkItem 与 ExpertTask 边界不清

风险：

两个对象职责重叠，最终成为两套 Task。

规避：

- WorkItem 只管理业务工作生命周期。
- ExpertTask 只管理一次专家执行请求。

### 20.2 状态机过早复杂化

风险：

一次性实现 Symphony 完整能力，导致项目变重。

规避：

Phase 1 只支持：

```text
queued
running
blocked
waiting_review
rework
completed
failed
cancelled
```

不先做 DAG 和复杂多专家编排。

### 20.3 Workspace 恢复复杂

需要明确：

- Worker 重启。
- Workspace 残留。
- Hub 状态与文件系统状态不一致。
- continuation 时 Workspace 不存在。

第一版应失败关闭并记录 blocker，不做隐式猜测恢复。

### 20.4 Evidence 被 Agent 伪造

Evidence 必须区分来源：

```text
agent_reported
worker_verified
ci_verified
human_verified
```

Completion Gate 默认优先使用可验证来源。

### 20.5 自动 Rework 无限循环

Workflow 必须定义：

```text
maxWorkAttempts
maxReworks
maxRunsPerWorkAttempt
maxTurnsPerRun
```

超过阈值进入：

```text
waiting_review
```

或 failed。

---

## 21. 非目标

Phase 1 不做：

- 不重写 Expert Platform。
- 不替换现有 MCP Task API。
- 不引入 Elixir。
- 不强制 GitHub / GitLab / Jira。
- 不实现复杂 DAG Planner。
- 不实现多个 Agent 自由互相派生任务。
- 不允许 Agent 自主提升权限。
- 不允许绕过人工 Merge Gate。
- 不把所有 Runtime Secret 暴露给 Agent。
- 不把 WorkItem 和 Tracker Issue 强绑定。

---

## 22. 推荐实施顺序

建议严格按以下顺序：

```text
1. WorkItem data model + source identity + idempotency
2. Durable WorkItem state machine + revision / claim / fencing
3. Extend existing WorkflowDefinition + version pinning
4. WorkAttempt / ExpertTask / Run / Agent Turn hierarchy
5. Workspace first-class model + deterministic key + Worker affinity
6. persistent blocked semantics
7. Evidence envelope + reuse Verification binding/staleness
8. ReviewDecision / Approval separation
9. Completion Gate
10. reconciliation-before-dispatch + durable retry/continuation scheduling
11. Feedback -> Rework signal
12. Admin WorkItem UI
13. MCP Work API
14. GitHub Adapter
15. GitLab Adapter
16. Auto polling / dispatch
17. PR review loop
18. CI / Human Review / Merge gate
```

不要先实现 Tracker polling。

否则外部 Tracker 状态会过早反向定义内部模型。

---

## 23. 与原 Expert Platform Design 的关系

现有 Expert Platform 设计中的：

```text
WorkflowDefinition
WorkflowRun
WorkflowPlanRevision
Workspace Manager
Verification
Approval
Artifact
```

已经预留了部分未来方向。

本设计不是推翻原设计，而是对“Workflow / Work”层进一步收敛：

### 原来的重点

```text
多专家 DAG 编排
```

### 本设计优先级调整为

```text
单个 WorkItem 可靠闭环
    |
    v
continuation / retry / blocked / rework
    |
    v
evidence / completion gate
    |
    v
再扩展多专家 DAG
```

即：

> 先把一个工作可靠地做完，再解决多个专家如何协同完成复杂工作。

这与 Symphony 的实践经验一致，也更符合 Team Skill Hub 当前成熟度。

---

## 24. 关键设计决策

### D-01：Symphony 作为设计参考，不作为依赖

不嵌入、不 fork、不把其 Runtime 直接接入 Hub。

### D-02：新增 WorkItem，保留 ExpertTask

避免破坏现有 Expert Platform。

### D-03：Workflow 与 Expert / Deployment 分离

Expert = 谁。

Workflow = 怎么做完。

Deployment = 在哪里、用什么能力做。

### D-04：Task success 不代表 Work complete

Completion 必须经过独立 Gate。

### D-05：WorkAttempt / Run / Turn 分层

WorkAttempt 表示方案级尝试；continuation 优先发生在同一 Run 的 Agent Turn；可恢复执行故障创建新 Run；Human / Review Rework 创建新 WorkAttempt。

### D-06：Blocked 是正式状态

不把需要人工或外部资源的问题伪装成 failed。

### D-07：Workspace 独立于 Worker

Continuation 优先复用 Workspace。

### D-08：Evidence 是完成条件的一部分

不能只依赖 Agent 最终文本；Completion Gate 使用的 Evidence 必须绑定当前 source/artifact/environment/verifier revision，并在输入变化后 stale。

### D-09：Feedback 是 Orchestrator signal，但不是 Approval

`needsRework` 可以驱动 rework signal；TaskFeedback、ReviewDecision、Approval 三者分离，受保护 Gate 只能由具备相应权限且绑定明确 revision 的 Decision / Approval 通过。

### D-10：Tracker 只是 Adapter

Team Skill Hub 自己拥有 WorkItem 权威状态。

### D-11：Phase 1 不做复杂 DAG

先建立单 WorkItem 的可靠自治闭环。

### D-12：保留人工最终控制

PR Merge、敏感权限扩大、关键 Approval 不由 Agent 自主绕过。

### D-13：Durable Orchestration

不同于 Symphony 可接受部分 scheduler / blocked 状态仅在内存中，Team Skill Hub 的 WorkItem、WorkAttempt、blocked、retry、claim、Completion State 必须持久化，并通过事务、幂等、reconciliation 恢复。

### D-14：Execution-time Configuration Pinning

每个 WorkAttempt 固定 workflow version、Expert、Deployment 和 deployment config version。运行中配置变更不得静默影响当前 Attempt；新版本只作用于后续新建执行。

### D-15：Reconciliation Before Dispatch

每次 dispatch、retry、continuation、resume 前先重新核验 WorkItem、Task/Run、Worker、Workspace 与外部 source 当前事实，旧 timer / stale event 不具备直接推进权。

### D-16：Workspace Affinity First

Phase 1 continuation / retry 优先回到 Workspace owner Worker；无法核验原 Workspace 时进入 blocked，而不是自动跨 Worker 猜测迁移。

### D-17：Source Identity Is Idempotent

Tracker Work 使用稳定 source tuple 在 Work 的授权/租户边界内去重；MCP / Admin / Automation 创建 Work 使用 idempotency key。source 去重不得跨授权边界复用 WorkItem，Work 层也不能重新引入 ExpertTask 已解决过的重复提交问题。

---

## 25. 最终目标

Team Skill Hub 当前定位可以概括为：

```text
Skill / Knowledge Platform
        +
Expert Execution Platform
```

引入 Work Orchestration 后，目标演进为：

```text
Skill / Knowledge Platform
        +
Expert Platform
        +
Engineering Work Orchestration
```

平台最终管理的不再只是：

> 一次 AI 专家调用。

而是：

> 一件研发工作从进入系统，到被分析、执行、验证、Review、返工、接受和最终完成的完整生命周期。

这也是本设计引入 Symphony 思想所要解决的核心问题。
