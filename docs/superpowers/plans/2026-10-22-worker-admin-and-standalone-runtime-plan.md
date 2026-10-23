# Worker 管理界面与独立运行包计划

> 日期：2026-10-22
> 状态：实现与本地验收完成；真实部署验收待 Hub 恢复 Ready 后执行
> 约束：不重启现有 Worker，不执行 WSL shutdown，不 push，不实现暂缓的 Security Gate。

## 1. 目标

用户新增 Expert 后，不应再通过手工 CLI 注册 Worker。Admin 应提供 Worker 生命周期管理入口；Worker 主机也不应 clone 完整 `team-skill-hub` 源码仓库，而应安装一份最小化的、可版本化的 Worker 运行包和 Docker 执行镜像。

## 2. 术语和边界

- **Expert Definition**：能力、路由关键词、每个专家的模型/Provider 配置。
- **Deployment**：专家、仓库 URL/分支、Principal 授权、Runtime Profile。
- **Worker Registry**：Hub 管理 Worker ID、capability、pending/active/revoked 状态和 credential hash。
- **Worker Runtime Package**：Worker 主机实际安装的程序，只包含 `expert-worker` 入口及其传递依赖、生产依赖清单、配置模板和安装/升级脚本。它不包含 Admin UI、MCP Server、知识库/候选管理等 Hub 源码。
- **Execution Image**：Worker 每个任务通过 Docker 启动的 Codex 执行容器；与运行 Worker daemon 的 Node.js 运行包是两层不同的东西。

## 3. Admin Worker 管理流程

1. Admin 页面增加“Worker 管理”标签，列出 Worker ID、capabilities、状态，不显示 credential hash 或 credential。
2. 表单新增 Worker：输入稳定且唯一的 Worker ID、capabilities；创建后初始状态为 `pending`。
3. 管理员显式点击“批准”，状态变为 `active`。不能在创建时隐式批准。
4. 管理员点击“签发凭据”，Hub 只返回一次明文 `ewc_...`，前端立即显示复制/下载提示；不自动保存到浏览器存储，不写日志，不回显旧 credential。重新签发会使旧 credential 失效，必须二次确认。
5. 支持吊销 Worker；吊销后 Worker 不得领取/提交任务。
6. 所有接口复用现有 `hasAdminAccess` 校验和 `EXPERT_WORKER_REGISTRY_DB`；Admin API 不得新建空数据库或暴露秘密。
7. 单元/路由测试覆盖未授权、重复 ID、无效 capability、未批准签发、一次性返回、吊销和列表脱敏。

## 4. Worker 主机运行/部署模型

Worker 主机不需要完整 Hub 源码，也不需要 Admin/MCP 服务代码。推荐交付物：

- `worker-runtime/`：由独立 `tsconfig.worker.json` 构建的 Node.js JS 模块，仅包括 `src/cli/expert-worker.ts` 的传递依赖。
- 最小 `package.json` / lockfile：仅列运行时真实需要的生产依赖，不复用 Hub 的全量开发依赖。
- `worker.env.example`：仅模板/变量说明，不含任何实际 credential。
- `install-worker.sh` / `upgrade-worker.sh`：安装版本化运行包、校验配置、安装/更新执行镜像并配置 systemd 或其他 supervisor；不克隆 Hub 仓库。
- 独立的 `team-skill-hub-expert-worker:<version>` 执行镜像：包含 Codex CLI、CA 证书和入口脚本；Worker runtime daemon 在宿主机运行并通过 Docker 启动任务容器。

可接受的部署方式：从发布附件/内部制品库下载 Worker runtime archive 与执行镜像，校验版本/摘要，安装到 `/opt/team-skill-hub-worker/<version>`，由 `/etc/team-skill-hub-worker/worker.env` 和 systemd 服务运行。开发者在 Hub 仓库构建制品；部署主机只需制品、Docker/Node.js（或后续容器化 Worker daemon）和配置，不需要 Hub 源码。

## 5. 分阶段实现

### 阶段 A：Admin 注册/审批/签发/吊销

- 为 `PersistentWorkerRegistry` 增加只读列表方法。
- 在 Hub Admin API 增加受 `hasAdminAccess` 保护的 Worker list/enroll/approve/issue-credential/revoke 端点。
- credential 仅在 issue 响应中出现一次；不持久化明文。
- Admin UI 增加 Worker 管理表单、状态列表和显式操作。
- 更新 `add-expert.md`，把 CLI 作为应急/自动化 fallback，而不是日常必经步骤。

### 阶段 B：独立 Worker 运行包

### 阶段 C：Worker Bootstrap 自动注册

- Hub gRPC 增加 Bootstrap Token 认证的注册 RPC；Token 仅从部署环境读取，不存入 Worker Registry。
- 默认注册后进入 `pending`，Admin 批准后 Worker 轮询并交换正式 credential。
- 正式 credential 保存到 Worker 主机受保护文件，后续启动复用；保留旧的手动 credential 作为兼容路径。
- 自动激活默认关闭；开启时必须同时设置 capability allowlist。
- 覆盖无效 Token、重复 Worker ID/配置不匹配、pending→active、revoked、重复签发和自动激活白名单测试。

- 盘点 worker daemon 的传递依赖，增加 worker-only TypeScript build 配置。
- 生成仅含 worker runtime JS 的 staging 目录，确保不包含 `server.ts`、Admin UI、MCP/知识管理模块。
- 计算最小生产依赖，生成锁文件并在干净临时目录安装验证。
- 新增包构建、校验、安装/升级脚本与 systemd 示例；版本固定，支持回滚。
- 从干净 Ubuntu/Debian 容器/VM 验证：只拿 Worker 制品和 env 配置即可连接 Hub、独立 clone 仓库并执行只读任务。

## 6. 测试与验收

- Worker Admin API 的管理员权限、状态迁移和 credential 一次性返回测试。
- UI 不将 credential 写入 localStorage/sessionStorage，不把它拼进日志或普通状态文字；关闭/刷新页面后不再可见。
- worker-only 构建检查只包含 Worker 依赖闭包；制品内无 Hub UI/MCP/管理路由代码。
- 在没有 `team-skill-hub` checkout 的干净环境中启动 Worker runtime；能连接 Hub、按 Worker ID 使用私有工作区、执行只读任务。
- 不触碰现有 Worker 会话，不重启现有 Hub 服务，不运行 WSL shutdown。

## 7. 当前验收记录（2026-10-23）

- 全量测试基线：454 passed，0 failed；修复 Docker 参数后已再次执行相关专项测试。
- `npm run build:worker-runtime`、Prettier 和 `git diff --check` 通过；执行镜像 `team-skill-hub-expert-worker:0.1.0` 可正常运行 `codex-cli 0.162.1`。
- Worker runtime 包不包含 Hub 的 server、Admin UI、MCP 或知识管理入口源码。
- **独立制品注册生命周期验收：5/5 通过。** 从打包制品启动 Worker 进程，连接隔离 gRPC Hub，验证 pending 注册、审批后凭据安全落盘、daemon 持续运行、重启复用凭据，以及吊销后 gRPC 拒绝旧凭据。临时数据库、凭据和目录均已清理。
- **真实任务链路验收：通过。** 从打包制品启动 Worker，向隔离 Hub 提交只读任务；Worker 自动注册、审批、通过 gRPC 领取任务，启动 Docker Codex CLI 容器读取临时 workspace 的 `README.md`，并通过 gRPC 回传结果；Hub 将任务状态更新为 `succeeded`，结果中的标记 `ORANGE-ORBIT-731` 与文件内容一致。
- 该真实任务暴露并修复了 Docker 参数生成 bug：`buildCodexDockerArgs` 多生成了一个孤立的 `--env`，导致 Docker 以退出码 125 拒绝启动。已删除重复参数，并加强单元测试以确认 `HOME` 和 `CODEX_HOME` 的 `--env` 参数配对正确。
- 当前 WSL2 环境中，Docker 默认 seccomp 配置下 Codex 无法完成文件读取；显式配置 `EXPERT_DOCKER_SECCOMP_PROFILE=unconfined` 后，隔离任务成功。部署示例继续默认 `default`，并记录仅在复现沙箱初始化问题后才显式测试 `unconfined` 的安全取舍；不将其静默设为全局默认。
- **多 Worker 并发任务验收：通过。** 两个独立 Worker 进程同时连接隔离 Hub，4 个只读任务全部进入 `succeeded`，每个任务的结果都包含预期标记 `PARALLEL-ORANGE-842`。任务结果均由 Hub 持久化；测试使用临时 workspace、临时数据库及临时凭据，完成后清理。
- **专项回归：43/43 通过。** 覆盖任务领取/租约续期、租约过期重领、旧 run fencing、执行期间取消确认、Worker 连接重试、Worker ID 对应独立 repository root、Codex 进程超时与取消清理、gRPC 认证和任务完成。
- **管理端与凭据回归：7/7 通过。** 覆盖 Admin 专家配置 UI、Worker 注册/审批/签发/吊销、凭据重启持久化、凭据轮换和旧凭据失效。
- **真实 Hub 管理端部分验收：通过。** 先确认现有 Hub readiness 为 ready、数据位于原有 Docker named volume；使用当前工作区重新构建并更新 `team-skill-hub` 容器后，readiness 恢复 ready，Admin 登录和 `/admin/api/expert-workers` JSON 接口均正常。通过真实 Admin API 创建测试 Worker，验证 `pending` 状态持久化、人工审批转为 `active`，随后将测试 Worker 吊销并复查为 `revoked`。测试 Worker ID 为 `live-admin-e2e-20261023-01`，能力为 `acceptance-probe-20261023-01`；注册表没有删除接口，因此保留一条已吊销的测试记录。
- **真实 Hub 凭据签发及运行时重启复用尚未完成。** 尝试通过 Admin API 签发测试凭据时，执行环境的安全检查阻止了该操作；没有获取或输出任何凭据，也没有启动无有效凭据的测试 Worker。因此首次启动与重启复用只在隔离 Hub 测试中通过，真实 Hub 这两步仍待完成。Hub 仓库同步仍按用户要求暂不处理。
- 最终构建制品 SHA-256：
  - Runtime: `59ae1c52f5c7cc6174e19ae4366734d1e341afe51c5b998dcc55a6225eb27811`
  - Execution image: `0e3f497b41ddb3cf70407200e45774fcb71d8a0ad2886760d240a869fd8f6556`
