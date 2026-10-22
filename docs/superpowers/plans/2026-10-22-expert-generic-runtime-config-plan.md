# Expert 通用运行配置统一计划

> 日期：2026-10-22
> 状态：计划，尚未实施
> 范围：Team Skill Hub Expert Platform 的通用配置加载与运行时注入
> 约束：OTA 只是 Expert 的一个实例，不为 OTA 单独设计配置机制。

## 1. 背景与问题

当前环境存在 `.env.ota-expert`，其中包含 `EXPERT_CODEX_CONFIG_FILE`、`EXPERT_MODEL_ENV_NAMES` 等配置；Worker 启动器则从 `/etc/expert/ota-worker.env`、`/etc/expert/ota-provider.env`、`/etc/expert/ota-git.env` 等文件加载运行时环境。配置入口按 OTA 命名，且分散在项目配置、主机本地文件和启动器逻辑中，容易让后续新增的非 OTA Expert 误以为必须复制一套专属配置。

代码盘点尚未发现现有 Admin 中有可编辑的 AI Router/模型 Provider 默认设置页面。现有 Expert Admin 只维护 Expert Definition 和 Deployment；因此这里的“用现有 AI Router 作为默认值”是指将当前实际使用的 Codex Provider 配置作为初始化种子，而不是复用一个已经存在的 Admin 设置页。当前期望的网关地址为 `https://route.briancs.shop/v1`，模型、协议和认证方式必须从实际生效配置中核实后迁移。

本次只规划通用机制，不将 OTA 的仓库地址、专家 ID、能力、模型偏好或 Git 凭据固化为通用默认值。

## 2. 设计目标

1. 所有 Expert 共用一套可复用的运行配置加载机制。
2. 通用平台配置、单个 Expert 的业务配置、Worker 主机秘密配置有明确边界。
3. 新增 Expert 不需要新增 `.env.<expert-name>` 文件或修改启动器代码。
4. 管理界面中维护的 Expert 配置与执行配置仍是每个 Expert 的权威业务配置；通用环境文件不替代数据库/API 中的配置模型。
5. 保持现有 OTA Worker、Hub 认证、Git 私有仓库访问、Codex 模型网关和模型配置行为不变。
6. 配置缺失或非法时快速失败，错误信息说明缺少的键，但绝不输出秘密值。

## 3. 配置分层与 Admin 信息架构

现有 `src/expert-admin-ui.ts` 已有“专家配置”和“执行配置”两个页面。Expert Definition 目前维护 ID、名称、能力、关键词；Deployment 维护仓库、Principal、Runtime Profile、启用状态。本设计将 AI Router/模型配置放入**每个 Expert 的“专家配置”**，因为不同专家可能需要不同模型、网关或凭据；不再新增运行时唯一的全局 AI Router 配置页。

### 3.1 专家配置：模型/AI Router 设置属于 Expert

扩展 `ExpertDefinition`，为每个 Expert 增加可选的 `modelConfig`（建议独立的版本化对象，而不是散落在环境变量中），字段建议包括：

- `providerId`：例如当前使用的 AI Router/Provider 标识；
- `model`：该专家使用的模型名；
- `baseUrl`：该专家的 API 网关地址；
- `wireApi`：明确 API 协议，例如 `responses`；
- `credentialRef`：引用 Worker 端预先配置的凭据，不存 API Key 明文；Worker 通过 `EXPERT_MODEL_CREDENTIAL_REFS_JSON` 将凭据引用映射到已允许的环境变量名；
- `allowedEnvNames`：执行器允许传入该模型运行的环境变量白名单；
- `configRevision`：配置版本，用于审计和任务重现。

当前期望网关 `https://route.briancs.shop/v1` 作为**现有 Expert 模型配置迁移/初始化的来源值**，不是强制所有 Expert 共用的运行时全局默认值。实际 `model`、协议和认证方式须从真实生效配置核实后再导入。新增 Expert 可以用该配置作为“从现有 AI Router 复制”的模板起步，然后单独调整；更新模板不应自动改写现有 Expert。

专家表单将“基础信息/能力”与“模型与 AI Router”分组展示。未配置模型时可以显式选择“使用部署环境默认 Provider”（兼容模式），但页面必须显示最终解析来源，不能静默猜测或读取任意用户路径下的 `config.toml`。

### 3.2 执行配置：部署和访问差异

Execution Configuration 继续负责“该专家在哪个执行环境里、以什么权限运行”：

- 关联 Expert；
- 源码仓库 URL、分支/固定 revision、凭据引用和 Git 代理；
- Principal/授权范围、Runtime Profile、Worker/运行时约束；
- 不重复保存模型网关、模型名或模型凭据。执行时按 Deployment 关联的 Expert 读取其 `modelConfig`，除非后续明确提出按部署覆盖模型的需求。

这样同一个 Expert 可有多个 Deployment 并共享专家模型配置；不同 Expert 可以使用不同的 AI Router 配置。若未来确实需要同一 Expert 在不同部署使用不同模型，再单独引入明确的 Deployment override，而不是现在就增加双层覆盖复杂度。

### 3.3 创建模板与现有配置迁移

- 现有 AI Router 配置只作为创建/迁移模板。
- 为避免破坏现有运行行为，迁移时应把当前 OTA Expert 实际使用的 Provider、模型、网关和协议写入 OTA Expert 自己的 `modelConfig`。
- 其他已存在 Expert 若没有模型配置，保持兼容模式并在 Admin 标注“未显式配置”，不要未经确认批量套用 OTA 的值。
- 新建 Expert 时允许“从现有 AI Router 配置复制”，复制后为独立值，不建立隐式动态继承关系。

### 3.4 主机本地秘密与 Worker 身份

主机上的秘密仍单独存放在权限受限的位置，例如 `/etc/expert/`，按最小权限拆分用途：

- Hub/Provider API 凭据；
- Worker 身份凭据；
- Git 凭据及 `credentialRef` 到环境变量的映射。

这些秘密通过安全的环境注入或凭据文件交给 Worker；不得复制到专家配置、任务正文、仓库或日志。Admin 仅存 `credentialRef`，并显示凭据引用的配置状态，不读取或回显密钥值。

## 4. 配置加载与优先级

统一使用可测试的配置解析模块，避免每个启动脚本自行解析 `.env`。最终模型运行配置按以下步骤解析：

1. 读取部署环境中的路径、运行时策略和主机秘密来源；
2. 读取任务选中的 Expert Definition，获取该专家自己的 `modelConfig`；
3. 按 `credentialRef` 从管理员预先配置的秘密来源解析凭据；
4. 将该 Expert 获准使用的模型设置与凭据注入对应执行容器；
5. 启动 Codex/Runtime，并记录非秘密配置摘要、来源和版本。

配置优先级必须显式定义：Expert 的显式 `modelConfig` 是该专家模型配置的权威来源；若未配置，才进入明确的兼容模式并使用已配置的部署环境 Provider。不能静默把某个专家的配置覆盖到所有其他 Expert，也不能让任务正文、仓库内容或用户可控字段指定任意 Secret、环境变量或本地文件路径。

`.env.expert`（如最后决定保留）仅用于平台/Worker 部署层的非专家专属运行配置和秘密来源引用，不是专家模型配置的权威副本。OTA 不再拥有专属的通用配置加载代码；其模型配置只是 Expert Definition 的一个实例。

## 5. 迁移方案

1. 盘点现有 Expert Definition/Deployment 字段、当前 AI Router/Codex Provider 配置、`.env.ota-expert`、Worker 启动器、Docker 执行器及所有环境变量消费者。
2. 定义 `ExpertDefinition.modelConfig` schema 与版本化存储/迁移策略；核实当前 OTA 实际生效的模型、网关、协议和凭据引用。
3. 在 Admin 的“专家配置”表单中新增“模型与 AI Router”分组，支持编辑、校验、从现有 AI Router 配置复制；不新增全局运行时默认配置页。
4. 将现有 OTA 的当前运行配置迁移到 OTA Expert 自身；其他现有 Expert 未配置时保留兼容模式并明确标注，不批量猜测迁移值。
5. 实现配置解析模块和 Worker/容器配置注入，确保执行器按任务所选 Expert 读取对应模型配置，并添加版本记录与秘密脱敏测试。
6. 统一启动器使用的部署层配置入口；保留受保护的本地秘密文件，不将专家配置权威副本放入 `.env`。
7. 用 OTA Expert 回归，并新增一个使用不同模型配置的非 OTA 测试 Expert，证明模型配置按 Expert 隔离。
8. 更新部署脚本、示例配置、中文使用文档和故障排查说明。

## 6. 安全要求

- 部署层 `.env.expert`（如保留）不含秘密，并加入 `.gitignore`；提交 `.env.expert.example`。
- 每个 Expert 的 AI Router/模型配置必须随 Expert Definition 持久化并版本化；不能只写入某个 Worker 的本地文件。
- Admin 页面不得读取或回显 API Key 明文，只显示 Secret 引用、环境变量名和配置是否可用。
- Worker Credential、Hub API Key、Git Token 不输出到日志、诊断结果或任务报告。
- 启动日志只列出已加载的配置源和键名，不打印值。
- 检查符号链接、文件权限和路径边界，防止从非预期路径读取配置。
- `credentialRef` 只能引用管理员预先配置的凭据条目；不得接受任意环境变量名或路径作为用户可控输入。
- 配置迁移不得更改 Expert 仓库授权、任务 ACL、沙箱策略或当前安全 Gate 范围。本计划不实现此前暂缓的安全 Gate。

## 7. 测试与验收标准

### 单元测试

- 平台配置表首次初始化、读取、更新、revision 递增和并发更新冲突。
- 通用配置文件存在/缺失、必需键缺失、非法值、重复键与覆盖优先级。
- 只输出键名和错误代码，不输出 Token/密码。
- 新增一个非 OTA 的示例 Expert 时不需要新增专属 `.env.<name>` 文件或修改启动器。
- 每个 Expert 可配置独立的 AI Router、模型、协议和凭据引用。
- 从现有 AI Router 配置创建新 Expert 时复制为独立配置；之后修改源模板不会改写该 Expert。
- 同一 Expert 的多个 Deployment 使用该 Expert 的模型配置；不同 Expert 的模型配置互不影响。
- 未配置模型的旧 Expert 进入明确的兼容模式，Admin 会显示实际配置来源。
- 配置解析返回生效来源和版本，日志不包含秘密值。
- 未授权 `credentialRef`、仓库或模型秘密注入被拒绝。

### 集成测试

- Admin 保存的每个 Expert 的 `modelConfig` 经持久化后随 gRPC Claim 下发到对应 Worker。
- Worker 按该 Expert 的 `modelConfig` 生成临时 Codex `config.toml`，校验模型、Provider、Base URL、Responses 协议和凭据引用映射；临时文件在任务结束后删除。
- 不同 Expert 的模型配置隔离，配置 A 不得泄漏或影响配置 B。
- 用通用加载模块启动现有 OTA Worker，确认 Hub 身份认证成功、领取任务、心跳与任务完成。
- 通过真实 MCP 提交只读任务，确认 Hub 自动路由仍能选择 OTA Expert、Worker 检出配置的仓库并完成分析、结果持久化并可读取。
- 确认实际 Codex 配置文件、模型网关 URL 与 `EXPERT_MODEL_ENV_NAMES` 对应环境变量的来源未被意外改写。
- 检查 Docker 执行容器只收到该 Expert 本次任务获准的配置和凭据。
- 验证部署脚本可从干净环境安装，且 `.env.expert.example` 足够说明必需设置。

### 验收门槛

- OTA 作为回归实例通过，但配置代码不包含 OTA 特判。
- 至少一个非 OTA 的测试 Expert 能复用同一加载机制。
- 真实 MCP → Hub → Worker → Codex → 持久化报告链路通过。
- `npm run check`、相关配置测试及部署脚本检查通过。
- 变更经 review 后再提交；本计划阶段不执行实现、不轮换秘密、不重启服务。

## 8. 明确不在本次范围内

- 不为 OTA 增加独有的通用配置体系。
- 不重构 ExpertDefinition/执行配置的业务语义，除非盘点发现通用加载无法消费现有契约；如需调整，另行设计。
- 不把所有 Expert 的仓库或凭据放入同一个全局环境文件。
- 不新增运行时唯一的全局 AI Router 配置页；模型配置归属每个 Expert。
- 不把 AI Router 默认值写死在 OTA 专家逻辑中；当前 AI Router 只作为创建/迁移模板。
- 不在没有验证的情况下更改当前网关、模型协议或认证行为。
- 不实现自动修复、提交/推送、MR/PR 或此前暂缓的安全 Gate。

## 9. 实施顺序

1. 配置来源与消费点盘点，确认当前生效的 Codex `model`、`model_provider`、`base_url`、`wire_api`、`env_key` 及密钥实际注入位置；只输出非秘密字段。
2. 定义 `ExpertDefinition.modelConfig` schema、持久化迁移和 revision 契约。
3. 在 Admin 专家配置页新增模型/AI Router 分组，支持从当前 Router 配置复制并独立编辑。
4. 迁移现有 OTA Expert 的有效模型配置，保留其他专家未配置时的兼容行为。
5. 实现统一解析模块与 Worker/容器配置注入，完成单元测试。
6. 新增不同模型配置的非 OTA 测试 Expert，验证配置隔离。
7. 真实 MCP → Hub → Worker → Codex → 报告端到端验收。
8. 更新部署脚本、示例配置、中文使用文档，删除确认不再使用的旧配置入口并 review。

## 10. 当前实现进度（2026-10-22）

已实现并通过自动化测试的部分：

- `ExpertDefinition.modelConfig` 的类型、SQLite `model_config_json` 迁移、读取/保存和每个 Expert 独立持久化。
- Admin 专家配置表单增加 Provider、模型、Base URL、Responses API、凭据引用和环境变量白名单字段；新建表单以当前 AI Router 配置（`bst`、`gpt-5.6-luna`、`https://route.briancs.shop/v1`）作为可独立编辑的初始值。
- Admin API 对模型配置进行 URL、Provider ID、协议和危险环境变量名称校验；不接收 API Key 明文。
- gRPC Claim 将所选 Expert 的模型配置传给对应 Worker。
- Worker 为该 Expert 生成权限受限的临时 Codex `config.toml`，只把配置允许且 Worker 已全局允许的环境变量传入容器；任务结束后删除临时文件。
- 新增 `EXPERT_MODEL_CREDENTIAL_REFS_JSON` 引用到环境变量名的映射，映射目标必须在 `EXPERT_MODEL_ENV_NAMES` 白名单中。
- 新增 `docs/expert-platform/model-configuration.md` 说明运行方式与凭据映射。
- `npm run check` 全量质量门禁通过（format、lint、build 和 431 项测试）。

已完成的真实部署与端到端验收：

1. Worker 主机 `/etc/expert/ota-worker.env` 已配置 `EXPERT_MODEL_CREDENTIAL_REFS_JSON`；凭据引用 `bst-router` 映射到已有的 `TEAM_SKILL_HUB_API_KEY` 环境变量。密钥值没有写入数据库、项目 `.env` 或日志。
2. 已部署并通过真实 Admin 登录会话验证 `/admin/experts` 页面；模型字段和编辑回填逻辑均已在部署页面确认。Admin API 对 `ota` 配置保存/读取成功，并创建了 `code-review` 与 `review-default`。
3. `ota` 使用 `gpt-5.6-luna` 的真实 MCP → Hub → Worker → Codex 任务成功，报告经 `get_expert_task_result` 取回；后续在常驻 Worker 运行状态下提交的 OTA 任务也成功。
4. `code-review` 使用不同模型 `gpt-5.6-sol` 的真实 MCP → Hub → Worker → Codex 任务成功，报告经 MCP 取回。模型由 Router 真实调用确认可用；`gpt-5.5` 返回 400（当前 ChatGPT 账户不支持），因此选择 `gpt-5.6-sol`。
5. 发现并修复临时 Codex 配置文件权限缺陷：原先 `0600` 导致容器 UID 10001 无法读取，现改为 `0644`（配置不含密钥），并添加回归测试。
6. Hub 当前 readiness 为 HTTP 200，gRPC 端口 `7443` 仅绑定 `127.0.0.1`。完整 `npm run check` 通过，431 项测试全部通过。

仍需完成的收尾项：

- 已完成 `code-review-worker-01` 独立注册、审批和凭据签发；其 capability 仅为 `review`。独立环境与启动器已安装，运行在 `code-review-expert-worker` tmux 会话中。重启前真实 MCP 任务 `d87798fc-9e59-497d-ad2b-418dfb56988a` 已成功。
- 已增加 /usr/local/sbin/start-skillhub-expert-workers 和 /etc/wsl.conf boot command。模拟 tmux server/Worker 进程丢失后，脚本成功恢复两个 Worker 会话；Hub readiness 保持 HTTP 200。
- 已定位并修复真实 MCP 任务 EXECUTION_FAILED 的根因：启动脚本的 umask 077 将临时 Codex 配置文件权限收紧为 0600，执行容器 UID 10001 无法读取。创建后现在显式 chmod 0644，并新增 umask 077 回归测试。Worker 连接 Hub 的瞬时 gRPC 错误也改为脱敏记录并自动重试。
- 修复后真实 MCP 端到端验证通过：code-review 任务 `9d811623-7460-4ca5-ba61-00c741cc3a02` 与 OTA 任务 `55499f38-bb54-4e05-a564-e07eb015c066` 均 succeeded，结果持久化读取成功；Hub readiness HTTP 200，3 个仓库健康。
- 尚未执行真正的 `wsl --shutdown` 冷启动验收；目前通过模拟 tmux server/Worker 进程丢失验证恢复脚本可重建两个 Worker 会话。
- 单独验证未设置 `modelConfig` 的旧专家仍能通过 `EXPERT_CODEX_CONFIG_FILE` 兼容路径正常执行。
- 更新部署/安装脚本，使本地 gRPC 端口、Worker 凭据映射和 Worker 常驻进程的配置步骤可以重复部署。

### 实际部署补充（2026-10-22）

- 已执行 `scripts/redeploy-local.sh` 构建并重建 `team-skill-hub` 容器。初次部署时仓库同步因容器未配置 Git HTTP(S) 代理而失败，导致 readiness HTTP 503。现已在 docker-compose.yml 增加可选的 `SKILL_HUB_GIT_PROXY` 注入，并在被 `.gitignore` 忽略的本机 `.env` 中配置现有代理；容器重建后 `rd-skills` 与 `rd-knowledges` 均同步成功，readiness 恢复 HTTP 200，3 个仓库全部健康。
- 已使用正常 Admin 登录会话完成模型配置 UI/API 保存与读取验收；Hub gRPC 端口仍仅绑定 `127.0.0.1:7443`。
- 已启用仅绑定 `127.0.0.1:7443` 的 gRPC 监听，并运行 OTA 与 code-review 两个独立 Worker。完整 `npm run check`（format、lint、build、434 项测试）及 `git diff --check` 均通过。真实 MCP → Hub → Worker → Codex → 持久化报告链路已在两个 Expert 上分别成功验证。

### 仓库工作区隔离决策（2026-10-22）

采用简单的 Worker 独享模式，不引入共享 Git 缓存、worktree 池或跨 Worker 锁。`EXPERT_REPOSITORY_ROOT` 作为根目录，配置解析器自动追加稳定的 `EXPERT_WORKER_ID`，使每个 Worker 独立 clone/fetch 自己的仓库副本。当前每个 Worker 的主循环串行执行任务；不同 Worker 的 checkout/reset/clean 不会相互影响。需要确保并行 Worker 的 ID 唯一。
