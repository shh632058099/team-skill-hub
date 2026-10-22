# Expert Platform 原型验收记录

日期：2026-10-21
工程分支：`feat/expert-platform-prototype`
基线提交：`dc64a53`（本次验收修正尚未提交）

## 1. 验收结论

**自动路由和显式路由均已通过真实 WSL2 Linux Codex CLI + MCP + Hub + Worker + Docker Agent 的端到端验证。** 两个任务都由实际 OTA Expert 执行并最终返回持久化报告，不是测试替身生成的结果。

本次测试使用 WSL2 内的 Linux 原生 Codex 二进制：

```text
/root/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
codex-cli 0.162.1
```

没有使用 Windows Codex CLI。WSL2 Codex 的 `teamSkillHub` MCP 指向 `http://127.0.0.1:8080/mcp`，状态为 enabled。

## 2. 真实端到端证据

| 验收项        | 自动路由                                           | 显式路由                                                      |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| 用户输入      | 只描述 OTA 写入后偶发失败；未指定专家或 MCP 工具   | 明确要求交给 OTA Expert                                       |
| Task ID       | `854a99b7-c65b-45ce-8e06-de3b3694473a`             | `a8c4857c-e02f-439d-91d8-93b196d0fc06`                        |
| Expert        | `ota`                                              | `ota`                                                         |
| repositoryId  | `otalib`                                           | `otalib`                                                      |
| selectionMode | `auto`                                             | `explicit`                                                    |
| 最终状态      | `succeeded`                                        | `succeeded`                                                   |
| 结果获取      | 新的 Codex CLI 进程通过 MCP 查状态并取得已保存报告 | 新的 Codex CLI 进程实际调用 `get_expert_task_result` 取得报告 |

### 自动路由报告

任务检查了 OTA 状态机、分区写入、读回 SHA-256、状态持久化、启动槽切换和断电恢复。主要风险包括：

- 镜像写入、`part_written`、读回校验和 `part_verified` 之间存在非原子窗口；
- `PKG_INSTALLING` 在重启后的恢复路径可能卡住；
- BCB、NOR 参数和 misc 持久化状态没有跨介质事务；
- `ota_persist_write()` 只调用 `fflush()`，缺少掉电持久化屏障。

报告给出了 `ota_core.c`、`ota_install.c`、`ota_flash_blk.c`、`ota_flash_nor.c` 和相关测试的具体行号与调用链。

### 显式路由报告

任务检查 `ota_sm.c` 的状态转换与持久化 hook，确认并指出：

- 持久化 hook 在状态机 mutex 内同步执行，存在重入死锁和 I/O 阻塞风险；
- 状态、BCB、NOR 和 rollback bitmap 之间缺少统一事务；
- 多个上层路径忽略状态转换失败，可能导致 API 返回值、内存状态与持久化状态不一致；
- 需要补充持久化失败、hook 重入、掉电中断和跨介质部分成功的 P0 测试。

## 3. 本次修复

自然语言路由测试暴露了两个可复现问题：

1. MCP 工具描述没有足够明确地告诉 Codex：用户未指定专家时应直接提交并省略 `expertId`。
2. Skill Hub 的 Skill/Agent 目录与 Expert Platform 的 Expert ID 是不同注册表。Codex 可能把 Skill Hub Agent 名称误传为 `expertId`。

因此本次增加了 `list_available_experts`：

- 只返回当前 MCP principal 有权使用的 active Expert；
- 返回准确的 `expertId`、展示名、能力、关键词和已授权的 repository IDs；
- 明确告知 Codex：自动路由时不要调用该目录，直接省略 `expertId`；只有用户明确指定专家或请求专家目录时才查询。

同时更新了 `submit_expert_task`、状态和结果工具的描述，并在 MCP 集成测试中覆盖工具描述、授权过滤、自动路由与显式路由。

### 3.2 执行配置直接声明源码仓库（本轮新增）

执行配置新增 `repositories` 结构，Admin 不再要求新配置手工输入 Hub 仓库注册表中的 ID。管理员按行填写 Git URL、分支和可选 Worker 凭据引用；Hub 根据 URL + branch 稳定生成内部 `repo-<sha256-prefix>` 标识，继续用于现有路由/任务授权协议。旧的 `repositoryIds` 字段和数据库记录继续兼容，旧的 `ota-default` 不会因 schema 迁移丢失。

Worker 收到任务 claim 时会取得对应仓库 URL、分支和凭据引用，在 Worker 管理的 `EXPERT_REPOSITORY_ROOT` 下 clone/fetch，并将工作副本更新到该分支最新 `FETCH_HEAD`。Codex 容器只读挂载准备好的工作副本。任务报告开头会记录 URL、分支和实际 commit SHA。Worker 侧 `EXPERT_GIT_CREDENTIALS_JSON` 可将凭据引用映射到 SSH 私钥文件路径，例如 `{"ota-github-readonly":"/etc/expert/keys/ota-readonly"}`；不把私钥或 Token 放入 Hub 的执行配置。新配置可仅设置 `EXPERT_REPOSITORY_ROOT`，无需预先 clone 源码；未配置 URL 的旧执行配置继续使用现有 `EXPERT_SOURCE_PATH`。

当前基础实现支持 HTTPS Git URL 和标准 `git@host:path` SSH URL；完整的安全 Gate 仍按范围决策暂缓。最后一次重新部署已构建包含该 UI 的镜像，登录后 `/admin/experts` 和两个配置 API 均返回 HTTP 200，旧 `ota-default` 配置与 10 条任务保留。该次部署脚本因 `rd-skills` / `rd-knowledges` 启动同步再次超时而返回非零，Hub 的 readiness 暂时为 503，但服务进程和专家 Admin 页面已启动；这是先前已记录的仓库同步问题，不属于源码仓库配置改造。 根因已进一步确认并临时解决：宿主机与容器访问 GitHub HTTPS 均可成功（容器 HTTPS 返回 200），但 SSH 22 端口连接停在 SSH KEX 阶段；GitHub SSH 443 也有相同现象。将被 `.gitignore` 排除的运行时 `config/repositories.yaml` 中 `rd-skills` 改为匿名 HTTPS，将私有 `rd-knowledges` 改为 HTTPS + 已配置的 `GITHUB_TOKEN`（仅配置环境变量名，不写入 Token），重启 Hub 重新加载配置后，`/health/ready` 已恢复 HTTP 200，三个仓库均为 healthy。该运行配置文件被 Git 忽略，不会作为代码变更提交。Worker 已重新启动使用新协议。私有仓库访问需要 Worker 侧可用的 SSH Agent/默认密钥，或将凭据引用映射到 Worker 本地密钥路径。HTTPS 私有仓库的凭据 helper 仍依赖 Worker 主机自身配置。

### 3.1 Admin 专家管理界面（本轮新增）

Admin 新增 `/admin/experts` 页面，统一使用“专家配置”和“执行配置”术语。专家配置管理 ID、显示名称、能力、路由关键词和启用状态；执行配置管理关联专家、源码仓库、允许调用者、Runtime Profile 和启用状态。现有 CLI 入口保留不变。

页面 API 直接读取/写入 `EXPERT_RUNTIME_DB`，与 MCP/Worker 使用相同的 ExpertStore 数据库；未配置该环境变量时，界面明确显示配置缺失，不创建另一份隐式数据库。当前支持创建、编辑、列表和启停；暂不提供硬删除，以免破坏已有任务对专家/部署标识的引用。

部署时修正了运行时配置耦合及数据库路径：Compose 默认将 `EXPERT_RUNTIME_DB` 指向持久化卷内的 `/var/lib/team-skill-hub/expert-runtime.sqlite`，与 `docker-compose.expert.yml`、Worker 注册表所使用的现有运行时数据库保持一致，避免 Admin/MCP 误用一个全新的空数据库。仅配置共享数据库不再强制启动 Worker gRPC；只有显式配置 `EXPERT_GRPC_ADDRESS` 才启动 gRPC 服务，且 gRPC 地址存在但数据库缺失仍会失败关闭。`deploy-local-wsl2.sh` 现在同时使用主 Compose 文件和 Expert override，因此部署后会保留本机回环绑定的 `127.0.0.1:7443`。

部署验证：`./deploy-local-wsl2.sh` 成功重建容器；`/health/ready` 返回 HTTP 200，三个仓库均 healthy，容器状态为 healthy；日志确认 `expert.grpc.started`，gRPC 仅发布在本机回环地址。未登录访问 `/admin/experts` 返回登录重定向，未登录访问专家配置 API 返回 403，确认管理入口仍受现有 Admin 认证保护。核对共享数据库后确认已有 `ota` 专家、`ota-default` 执行配置和 9 条历史任务均保留，未覆盖或迁移旧数据。

## 4. 自动化验证

- `npm run build`：通过。
- `node --import tsx --test tests/expert-platform-admin-e2e.test.ts tests/expert-platform-*.test.ts`：本轮执行 62 项通过，0 项失败（包含 Admin 专家配置端到端测试）。
- `git diff --check`：通过。
- Hub Docker 镜像已从当前工作区重建并通过 health check。
- 真实 Codex CLI → `teamSkillHub` MCP → `submit_expert_task` → 自动路由 → `ota-worker-01` → Docker 内真实 Codex CLI → MCP 状态/结果查询：通过。`get_server_info` 确认 principal 为 `biao.sun`；Task ID `8b16dcd4-2b57-4a99-ac56-32dd3880b5f4`，`expertId=ota`、`selectionMode=auto`、`repositoryId=otalib`、`status=succeeded`，任务记录的 `worker_id=ota-worker-01`。报告含真实源码路径、函数和行号；执行为只读分析，没有实施自动修复或 PR。

## 5. 测试限制与未通过项

> **范围决策（2026-10-21）：安全 Gate 暂缓实施，仅记录为未完成项，本轮不开展沙箱加固或安全 Gate 实作。** 当前 `unconfined` seccomp 等限制继续明确记录，不得据此宣称安全验收通过；在后续允许处理不可信源码或扩大 Worker 执行权限前，仍必须重新排期并完成安全 Gate。

真实 Worker 中的 Codex 尝试执行 OTA 原生测试时，运行环境未能完成测试验证：

- `ctest --test-dir build-verify --output-on-failure` 因运行环境没有 `ctest` 而无法执行；
- `ota_unit_tests` 有 33 个 suite 失败，日志显示部分测试依赖固定的绝对 fixture 路径，且 `ota_cli` 缺少 `libcrypto.so.1.1`。

因此，本次可以证明真实专家路由、异步执行和报告持久化成功，但**不能把 OTA 原生测试套件视为通过，也不能把报告中的每项代码判断视为已由测试独立证实**。下一步应修复 Worker 测试环境或为专家提供受控、可复现的验证容器。

其他尚未完成的 Gate：

- 自然语言自动路由和显式路由尚未各重复运行 5 次，成功率统计不足；
- 本次还未完成取消、Worker 断线、Hub 重启期间的故障注入；
- 未完成 seccomp、网络外传、路径穿越等沙箱安全验收；当前 WSL2 Worker 配置的 `EXPERT_DOCKER_SECCOMP_PROFILE=unconfined` 仍是明确的安全限制；
- 尚未在另一台物理/虚拟主机上完成跨主机 Worker 验收；
- 尚未接入第二个领域 Expert，也未完成 Knowledge 访问专项验收。

## 6. Worker 当前运行方式

本次为继续验收，在 WSL2 内使用 tmux 启动了 Worker 会话 `ota-worker`：

```bash
tmux attach -t ota-worker
# 分离但保留后台运行：Ctrl+B，然后按 D
```

Hub 在 Docker 中运行。WSL 关闭或 Worker 退出后，需要重新启动 Worker；当前 WSL 未启用 systemd 服务管理。

## 7. 后续工作清单（按优先级）

1. **恢复 Hub readiness**：单独排查 Docker 容器到 GitHub SSH 的连接在 KEX 阶段停滞的问题；恢复 `rd-skills` 和 `rd-knowledges` 同步并确认 `/health/ready` 为 200。不要用关闭 readiness 检查或禁用仓库来掩盖问题。
2. **真实远程仓库验收**：用管理员实际提供的 URL/分支保存一条 SourceRepository 配置，在 Worker 侧验证 SSH 凭据映射、首次 clone、后续 fetch、commit SHA 和 Docker 工作目录挂载。当前只用本地 Git 测试仓库验证了 clone/fetch 流程。
3. **修复 Worker 原生测试环境**：为 OTA 配置可复现的测试镜像/依赖，解决缺少 `ctest`、固定 fixture 路径和 `libcrypto.so.1.1` 问题；在测试实际通过后再把测试结论标记为已验证。
4. **真实路由重复性**：自动路由与显式路由分别运行 5 次，记录 Task ID、选择模式、耗时、结果和失败原因。
5. **生命周期/恢复测试**：验证原 CLI 自动轮询状态和结果、新 CLI 按 taskId 取回报告，以及取消、Worker 断线、Hub 重启后的任务恢复。
6. **分析质量与扩展性**：人工核查至少一个已知根因问题；新增第二个领域 Expert 并确认不修改通用 Router/TaskService；补齐 RuntimeAdapter/SandboxProvider 契约和数据库迁移测试。
7. **安全 Gate 暂缓**：按既定范围决策，本轮不实施；未来扩大不可信源码执行范围前必须单独排期。

## 8. 下一步详细记录

1. 修复 Worker 内 OTA 原生测试工具链和 fixture 路径，使分析结果能运行相关测试。
2. 自动与显式路由各重复运行 5 次，保存 Task ID、selectionMode、耗时和失败原因。
3. 验证原 CLI 会话自动取回、关闭 CLI 后从新会话取回同一报告，以及 Hub 重启和 Worker 断线恢复。
4. **安全 Gate 暂缓，本轮不实施**；保留 `unconfined` 等安全限制记录，不得将其标记为通过。跨主机 Worker 和第二个 Expert 另行排期，并在扩大不可信代码执行范围前完成安全 Gate。

### 2026-10-21：配置真实 OTA 源码仓库

- 已通过 GitHub API 确认 `shh632058099/otalib` 是私有仓库，默认分支为 `master`。
- 已更新共享运行时数据库中的 `ota-default`，将源码仓库配置为 `https://github.com/shh632058099/otalib.git`、分支 `master`，并生成稳定内部 ID `repo-348fc59a6e5026e57e35`。
- 保留原有专家 `ota`、允许主体 `bst` / `biao.sun`、执行配置 `codex-readonly` 和启用状态；仅替换 `ota-default` 的仓库关联，没有改动历史任务。
- 验证限制：从当前 WSL 环境运行无交互 `git ls-remote` 访问该私有 HTTPS 仓库，12 秒超时（exit 124），尚未成功 clone/fetch。当前 Worker 源码仓库凭据机制只支持通过 `credentialRef` 选择 SSH 私钥；`/root/.ssh` 当前没有可用私钥，且 Hub 的 GitHub 仓库同步也存在 `rd-skills` / `rd-knowledges` fetch 错误，readiness 当前为 `not-ready`（1/3 healthy）。因此不能声称真实仓库已检出或端到端任务已通过。
- 后续阻塞项：为 Worker 配置可访问该私有仓库的 GitHub SSH deploy key（并确认网络可完成 SSH 握手），或扩展 Worker 的 HTTPS Token 凭据支持；同时修复 Hub 现有两个仓库同步失败。凭据应通过受控环境配置提供，不应写入仓库或普通配置 JSON。

### 2026-10-21：进一步定位 GitHub Git HTTPS 传输

- 已确认宿主 WSL 的 `gh auth status` 有效，GitHub API 能读取私有 `otalib` 元数据，仓库 `master` HEAD 为 `ae46ce477699157de6eccb53f9b222b89d344461`。
- 普通 Git HTTPS 请求会超时；强制 `git -c http.version=HTTP/1.1 ls-remote ...` 后成功返回上述 HEAD。当前最明确的传输问题是 Git 默认 HTTP 协商路径在该环境下挂起，HTTP/1.1 可绕过。
- Hub 容器未安装 `curl`，并且之前在容器内尝试 token + HTTP/1.1 的 Git 探测未在限定时间内结束。因此尚未证明容器内网络与凭据链可用，也未进行源码 clone。
- 下一步应在 Hub/Worker 执行 Git 的环境中强制 HTTP/1.1，并实现显式 HTTPS token credentialRef/credential helper（不能假设容器继承宿主机 `gh auth git-credential`）；随后用有时限的 `ls-remote`、clone 和 fetch 验证。不要把宿主机测试成功误记为 Worker 端到端通过。

### 2026-10-21：Worker HTTPS Token 支持实现进展

- Worker 凭据配置扩展为兼容旧的 SSH 私钥路径字符串，同时支持 `{ "type": "https-token", "tokenEnv": "EXPERT_GITHUB_READ_TOKEN" }`。Token 只从 Worker 进程环境读取，通过临时权限为 0700 的 askpass 脚本提供给 Git；临时文件在操作结束后删除，Token 不写入 URL 或 Git 配置。
- Worker Git 操作强制 `http.version=HTTP/1.1`，clone/fetch 改为 shallow（depth 1），Git 子进程最多运行 90 秒，避免网络异常导致 Worker 永久卡住。
- `npm run build` 通过，完整专家平台测试 69 项全部通过，`git diff --check` 通过。
- 真实远程验证仍失败：宿主机 GitHub API 可访问并能返回私有仓库元数据；但针对 `github.com:443` 的 Git Smart HTTP 请求在 TCP/TLS 连接阶段超时（包括使用 askpass Token 和 HTTP/1.1），不能归因于仓库权限。之前一次 HTTP/1.1 `ls-remote` 曾成功返回 HEAD，但无法稳定复现。真实 clone 已中止并清理了不完整目录。
- Hub readiness 最新状态仍为 1/3 healthy；此项与 Worker Git 传输不同，尚未恢复。尚未重启 Worker 使用新的 Token 配置，也尚未完成真实 Codex OTA 任务。

### 2026-10-21：Admin 可配置源码 Git 代理

- 执行配置表单新增“Git 代理地址”，按仓库逐行填写，与仓库 URL / 分支 / 凭据引用对应；编辑已有执行配置时会回填。
- 代理配置保存于 `repositories_json` 的仓库对象中，通过 Worker Claim 的 `repository_git_proxy_url` 字段传递给 Worker，最终仅作用于该次仓库 clone/fetch 的 Git 子进程。
- 允许 `http://` 和 `https://` 代理 URL；禁止用户名、密码、query、fragment，避免把代理凭据保存在执行配置数据库。代理地址必须能从 Worker 所在网络访问；`localhost` 指 Worker 自己的网络命名空间，不是浏览器或 Hub。
- Git 操作使用进程级 Git config 强制 HTTP/1.1，并按需设置 `http.proxy`，不将代理写入仓库本地 `.git/config`。Token 仍通过 Worker 的临时 askpass 机制读取环境变量，不进入代理配置。
- 2026-10-21 回归验证：TypeScript build 通过；完整专家平台测试 70 项通过；Admin 页面内联 JS 语法、配置 API 和 gRPC Claim 的代理字段均加入测试。
- 真实 `otalib` clone 仍需要一个实际可访问的代理地址后才能验证；当前未推测代理地址，也未把未完成的 clone 标为成功。

- 部署结果：已重新构建并重建 `team-skill-hub` 容器。启动期间短暂出现连接重置，随后 `/health/ready` 返回 HTTP 200，三个仓库均 healthy；未登录管理 API 返回 403、管理页面重定向登录，认证保护保持生效。Admin 页面 / API 的代理配置功能由 E2E 测试验证。

### 2026-10-22：验证 Admin 配置的 Git 代理可从 Docker 容器访问

- 从共享运行时数据库读取 `ota-default`，确认仓库 `https://github.com/shh632058099/otalib.git` / `master` 已保存代理 `http://192.168.0.57:8180`。不记录或输出 Token。
- 在运行中的 `team-skill-hub` Docker 容器内，对 `192.168.0.57:8180` 做 TCP 探测成功（connected）。
- 在同一容器中，使用已配置代理、HTTP/1.1 和容器现有 `GITHUB_TOKEN` 做真实 `git ls-remote` 成功，HEAD 为 `ae46ce477699157de6eccb53f9b222b89d344461`。
- 随后在容器内经相同代理执行真实 shallow clone（`master`，depth 1）成功，检出 HEAD 与上述 SHA 一致，工作树包含 76 个非 `.git` 文件。测试目录和临时 askpass 文件均已删除。
- 测试后 Hub readiness 为 HTTP 200，3/3 仓库 healthy。
- 结论：当前 Docker Hub 容器能访问已配置代理，并可通过代理读取/克隆私有 `otalib` 仓库。此测试验证容器网络与 Git 认证链；尚未通过 MCP 派发实际专家任务，因此完整 Worker/Codex 端到端任务仍需单独验收。

### 2026-10-22：开始真实 MCP → Worker → Codex 端到端验收

- 真实 MCP Streamable HTTP 初始化成功，`list_available_experts` 返回 OTA Expert（`expertId=ota`）及仓库 `repo-348fc59a6e5026e57e35`。因此 MCP HTTP 鉴权和专家目录查询链路正常。
- 读取 `ota-default` 当前配置：`otalib` / `master` / 代理 `http://192.168.0.57:8180`。为私有仓库访问将该仓库的 `credentialRef` 配置为 `ota-github-readonly`；Worker 端仍需具备与该引用对应的 Git Token 环境配置。
- 尝试启动当前配置的 `ota-worker-01` 时，Worker gRPC Claim 返回 `16 UNAUTHENTICATED: WORKER_UNAUTHENTICATED`。因此 Worker 尚未成功认证注册，未提交会留下排队记录的真实任务。诊断显示 `/etc/expert/ota-worker-credential.json` 中的凭据与 Hub `expert-workers.sqlite` 中保存的 credential hash 不匹配，需要通过受支持的 Worker 凭据轮换/重新下发流程修复；本轮未打印或导出凭据。
- 同时 Hub `/health/ready` 当前返回 HTTP 503（1/3 healthy），日志显示 `rd-skills` 和 `rd-knowledges` 的定期 Git fetch 失败；这与已经验证成功的容器内 `otalib` 代理克隆是不同的仓库同步路径。
- 端到端尚未完成：需要先修复 Worker credential mismatch，确保 Worker 启动后，再通过 MCP 提交一次 OTA 只读分析任务，轮询状态并读取结果。当前未伪造成功结果。

### 2026-10-22：真实 MCP → OTA Worker → Docker Codex 端到端任务成功

- 已通过受支持的 `expert-worker-admin issue-credential ota-worker-01` 重新签发 Worker 凭据，并以原子替换更新 `/etc/expert/ota-worker-credential.json`（权限 `0600`）；没有在日志或文档中输出凭据值。
- 为 Worker 的私有 HTTPS 仓库访问建立 root-only `/etc/expert/ota-git.env`（权限 `0600`），从现有 `gh auth` 凭据获取 Token；`/usr/local/bin/ota-expert-worker` 启动器加载该文件，将 `ota-github-readonly` 映射到 `EXPERT_GITHUB_READ_TOKEN`。Token 不写入仓库、Hub 执行配置或 Git URL。
- 第一次 MCP 任务因 Worker 尚未配置 Git 凭据映射而快速失败（Task ID `2f26cf00-2893-47b5-9b37-eb9f1c407f8b`，`EXECUTION_FAILED`）；此任务作为失败诊断记录保留。修复配置后使用新的 idempotency key 重提，未复用失败任务的 key。
- 第二次真实 MCP 提交成功：Task ID `61d74796-2288-48b1-a5ff-77c2217ceac9`，`expertId=ota`、`selectionMode=auto`、`repositoryId=repo-348fc59a6e5026e57e35`、`worker_id=ota-worker-01`、最终状态 `succeeded`。
- 已另行调用 `get_expert_task_result` 取回 Hub 持久化报告；报告记录源码仓库 `https://github.com/shh632058099/otalib.git`、分支 `master`、实际 commit `ae46ce477699157de6eccb53f9b222b89d344461`，并包含源码路径、函数/行号、掉电一致性风险和 P0/P1 测试建议。分析过程只读，没有修改源码、执行破坏性操作或创建 PR。
- 任务完成后再次检查 Hub readiness：HTTP 200，3/3 仓库 healthy、0 error。此前短暂的 503 已自行恢复，不能据此认为同步故障仍在持续。
- Worker 目前由 WebCodex 的 detached Job 管理，最长运行时间受 Runner 限制为 1 小时；这不是 systemd 常驻服务，Runner/Job 结束后需要重新启动。

### 2026-10-22：真实 Codex CLI 原生调用验收（阻塞）

- 在 `/mnt/d/wsl/.codex/config.toml` 中加入 `teamSkillHub` Streamable HTTP MCP server，地址为 `http://127.0.0.1:8080/mcp`，鉴权通过 `TEAM_SKILL_HUB_API_KEY` 环境变量引用；未将 API key 写入配置文件。`CODEX_HOME=/mnt/d/wsl/.codex` 下 `codex mcp list` 能显示该服务器 `enabled`，认证方式为 Bearer token。
- 使用已存在的 Codex CLI `0.162.1` 和现有 ChatGPT 登录态，执行只读、ephemeral 的自然语言 `codex exec --json` 验收。CLI 进程已启动，但在模型请求阶段反复遇到 `403 unsupported_country_region_territory`，无法刷新登录 Token，并出现网络重连；没有观察到 `submit_expert_task` 调用，也没有产生新 Hub Task。为避免无效重试，已停止该 CLI Job。
- 这不是 Team Skill Hub MCP 鉴权错误：同一 Hub MCP endpoint 的独立 Streamable HTTP 调用和专家任务提交/取回已成功。当前未通过的明确门槛是 **真实 Codex CLI 模型认证/网络请求**，因此不能把“原始 Codex CLI 自然语言自动触发”记为通过。
- 下一步应先在用户正常、受支持且已认证的 Codex CLI 运行环境中重试，不应通过改变地区或绕过服务可用性限制来规避该错误。确认 CLI 可正常完成普通模型请求后，再验证 MCP 自动工具调用、自动路由、状态等待和原会话报告展示。

### 2026-10-22：后续健康检查补充

- `/mnt/d/wsl/.codex/config.toml` 中已配置 `teamSkillHub`，`codex mcp list` 可识别服务器和环境变量鉴权引用；这只验证配置解析，不代表真实模型已成功调用 MCP。
- 最新 readiness 为 HTTP 503：3 个仓库中 1 healthy、2 error、0 syncing。容器日志显示 `rd-skills` 的 `master` 与 `rd-knowledges` 的 `main` 同步失败，`customer-skills` 同轮同步成功。未重启 Hub 或修改仓库同步配置。
- 真实 Codex CLI E2E 仍受前述登录 Token 刷新 `403 unsupported_country_region_territory` 阻塞。下一轮应在受支持、正常认证的 CLI 环境重试，并单独处理两个仓库的同步错误。

### Worker 源码仓库隔离决策（2026-10-22）

不采用跨 Worker 共享 clone/cache。每个 Worker 独立 clone 并独享自己的仓库工作区。`EXPERT_REPOSITORY_ROOT` 表示根目录，Worker 配置解析时会追加 `EXPERT_WORKER_ID`，最终目录形如 `<EXPERT_REPOSITORY_ROOT>/<workerId>/<repositoryId>`；未显式配置根目录时，也会从 `EXPERT_SOURCE_PATH` 的父目录推导根目录后追加 Worker ID。部署必须保证并行 Worker 使用唯一、稳定的 ID。Worker 当前串行领取/执行任务，因此同一 Worker 复用自己的 clone；不同 Worker 的 fetch/checkout/reset/clean 不会操作同一个工作树。已增加配置测试验证相同根目录下不同 Worker ID 得到不同 clone 根目录。

### 2026-10-22：多仓库默认选择修复

- 修复 `ExpertDispatchService` 在调用者未指定仓库时静默选择第一个 URL-backed 仓库的问题。
- 当专家当前授权范围内只有一个已配置 URL 仓库时，可以安全推断该仓库，保持单仓库专家的调用体验。
- 当可用 URL 仓库多于一个且请求未指定 `repositoryId` 时，现在返回 `REPOSITORY_REQUIRED`，要求调用者明确选择，不再依赖部署顺序。
- 显式仓库选择仍经过同一 Deployment 的 principal/repository 授权校验。新增回归测试覆盖单仓库自动推断、多仓库拒绝隐式选择及显式选择成功。
- 当前全量任务结果仍将 URL、分支和实际 commit SHA 写入持久化报告正文；commit SHA 尚未作为独立的结构化 Task 字段保存和查询，列为后续可追溯性改进。

### 2026-10-22：任务结果结构化源码元数据

- `expert_tasks` 增加可空 `repository_url`、`repository_branch`、`commit_sha` 字段，使用幂等列迁移兼容现有 SQLite 数据库。
- Worker 完成任务时，Hub 从当前版本 Docker Codex executor 生成的标准源码头部提取仓库 URL、分支和 40 位 commit SHA，并与任务结果在同一事务中持久化。原始报告正文不变，旧 Worker/旧任务没有该头部时元数据保持为空。
- `get_expert_task_status` 和 `get_expert_task_result` 使用共享 `TaskRecord` 返回结构化字段，无需额外协议调用。
- 回归测试验证元数据被持久化、重新打开数据库后仍可读取；task-store、真实 gRPC completion 和 MCP E2E 定向测试均通过。
- 当前实现为了保持 gRPC 完成协议向后兼容，元数据由固定报告头部解析而来；如果后续执行器种类增多，建议再把元数据升级为 `CompleteTask` 显式结构字段，避免依赖报告格式。

### 2026-10-22：租约过期与重领的执行历史

- 发现并修复：任务租约过期后可以被另一个 Worker 重新领取，但旧 `expert_runs` 记录仍保持 `running`，导致执行历史与任务实际状态不一致。
- 重新领取时，现在会在同一 SQLite 事务中将旧 run 标记为 `expired` 并写入 `lease_expired` 事件，然后创建新的 run 和 fencing token。
- 新增测试覆盖租约边界（到期时间戳仍有效，超过后可重领）、旧 run 状态、迟到结果被 `STALE_ATTEMPT` 拒绝，以及新 run 结果最终获胜。
- 定向 task-store、真实 gRPC、MCP E2E 测试通过。
- 运行中任务取消仍明确返回 `CANCEL_UNAVAILABLE`，不伪装成已取消；当前没有实现对正在运行的 Docker/Codex 进程的远程终止，这作为后续能力保留。

### 2026-10-22：租约恢复测试补强与 Worker 运维文档

- 补充验证过期或已被新 run 取代的 claim 不能续租，也不能把新任务执行标记为失败；新 run 完成后任务仍为 `succeeded` 且保留新结果。task-store 定向测试 7/7 通过。
- 更新 `docs/expert-platform/model-configuration.md`，明确 Worker 稳定 ID、独享 clone 目录、会话/readiness 检查、恢复步骤、租约过期后的行为以及禁止共享/手工修改正在使用的工作区。文档不包含凭据明文。
- 原始 Codex CLI 自然语言自动调用仍未验收通过：此前实际 CLI 请求被 `403 unsupported_country_region_territory` 阻断，没有观察到 MCP 工具调用。MCP 独立 E2E 和真实 Worker/Codex 任务成功不等于原始 CLI 自动触发通过；需在正常且受支持的 CLI 登录环境重新运行验收。没有通过规避区域限制来绕过此阻塞。
- 运行中任务取消仍未实现远程进程终止，当前明确返回 `CANCEL_UNAVAILABLE`。

### 2026-10-22：本轮后续验收汇总

- 增加运行中任务取消的存储层回归测试：直接调用取消接口不会将 running 任务错误标记为 cancelled；MCP 工具层会对运行中任务返回 `CANCEL_UNAVAILABLE`。这明确了当前产品行为，但不代表运行中取消已实现。
- 补齐 stale claim 的续租、失败操作测试：旧 claim 无法 renew，也无法将新 run 标记为 failed。
- 更新 Worker 运维文档，覆盖稳定 Worker ID、独享 clone 路径、会话/readiness 检查和租约恢复步骤。
- 最终 `npm run check` 通过：443 tests passed，0 failed；`git diff --check` 通过。
- 本轮没有提交或推送。原始 Codex CLI 自动触发仍被之前记录的模型认证 `403 unsupported_country_region_territory` 阻塞；未将其伪报为通过。安全 Gate 仍然暂缓。

### 2026-10-22：双 Worker 租约接管集成测试

- 新增 `tests/expert-platform-worker-loop.test.ts` 集成测试，使用独立临时 SQLite 数据库模拟 Worker 1 失联且不再续租，等待短租约过期后由 Worker 2 重新领取。
- 测试确认旧 run 标记为 `expired`、新 run 为 `succeeded`；Worker 1 的迟到 completion 返回 `STALE_ATTEMPT`，最终任务结果仅保留 Worker 2 的结果。定向测试 4/4 通过。
- 这是可重复的存储/租约故障注入集成测试，不是对当前正在运行的生产 Worker 进程做强杀测试；当前两个共享环境 Worker 未被中断。真实进程级故障注入仍列为运维验收项。

### 2026-10-22：运行中任务取消链路（本轮新增）

- MCP `cancel_expert_task` 不再对 running 任务直接返回 `CANCEL_UNAVAILABLE`，而是持久化 `cancellation_requested=1` 并返回当前任务记录；请求者需继续查询状态，直到 Worker 确认停止后状态变为 `cancelled`。排队中的任务仍即时取消。
- 为兼容既有 SQLite 数据库，新增可空迁移的 `cancellation_requested INTEGER NOT NULL DEFAULT 0` 字段，没有更改现有 status CHECK 约束。
- gRPC `RenewLease` 返回 `LeaseResponse.cancellation_requested`。Worker 心跳收到取消请求后触发 `AbortController`；Docker/Codex executor 将 signal 传递给 `runCodexProcess`，由其终止对应的 Docker CLI 子进程进程组。Worker 随后通过现有 `FailTask` 的 `TASK_CANCELLED` 确认取消，Hub 将 task/run 记为 `cancelled`。
- completion 写入条件包含 `cancellation_requested=0`，因此取消请求与迟到 completion 竞争时，迟到结果不能覆盖取消状态。
- 定向 task-store、worker-loop、gRPC、MCP E2E 测试 17/17 通过；测试覆盖运行中请求、心跳通知、执行器 abort、取消确认及迟到 completion 拒绝。
- 限制：取消通知依赖 Worker 下一次成功心跳，延迟上限通常约为 heartbeat 间隔加网络延迟；Worker 与 Hub 网络断开时无法即时终止执行，租约过期/fencing 仍是兜底。尚未对真实 Docker 容器做运行时取消故障注入，需在全量验证后单独验收。

### 2026-10-22：取消进程树测试与显式源码元数据协议

- 增加 `runCodexProcess` 进程树取消测试：测试父进程启动一个子进程后触发 AbortSignal，验证整个进程组退出。定向 codex-process 测试 5/5 通过。这使用本地测试子进程，不会启动或终止现有 Worker/Docker 容器。
- 检查发现 Docker daemon 可用（Docker 29.8.0），但当前为避免干扰已有 `ota-expert-worker` 和 `code-review-expert-worker`，本轮没有执行真实 Docker 任务取消或重启 Worker。真实容器取消的端到端验收仍未完成。
- `CompleteTaskRequest` 增加可选 `repository_url`、`repository_branch`、`commit_sha` 字段；`RemoteWorkerClient.completeTask` 支持传递结构化来源元数据，Docker executor 返回结果与来源元数据分离，gRPC 服务显式保存到任务字段，不再要求新 Worker 把来源信息编码进报告正文。
- 为兼容旧 Worker/调用方：新字段为空时仍允许旧协议请求，存储层保留旧报告头部解析作为迁移兼容路径。真实 gRPC TCP 测试验证显式字段正确持久化。
- 定向取消/执行器/gRPC/MCP 测试通过；进程树 abort 测试 5/5，gRPC 测试 3/3。最终 `npm run check` 通过：446 tests passed，0 failed；TypeScript build 与 `git diff --check` 均通过。

### 2026-10-22：真实 Docker 容器取消验收与修复

- 发现实际缺陷：仅向 Docker CLI 进程组发送 SIGKILL 会让 CLI 退出，但不会停止 Docker daemon 中已启动的容器。通过独立临时容器复现；该临时容器随后被显式清理并确认不存在，未影响任何现有 Worker。
- 修复方式：每个 Codex Docker 执行现在使用由 taskId/runId/fencing 派生的唯一容器名；`runCodexProcess` 在 AbortSignal 或执行超时时先调用 `onAbort` 清理钩子，再终止本地进程组。Docker executor 的钩子通过 `docker stop --time 2 <container>` 停止对应容器，最后以进程组终止作为兜底。容器名有严格字符校验，避免把不可信输入拼入 Docker 参数。
- 真实执行器验收：使用现有 `team-skill-hub-expert-worker-prototype:latest` 镜像启动独立、带测试 label 的临时容器；容器确认处于 running 后触发 AbortSignal。执行器返回 `CODEX_CANCELLED`，容器自动移除，`docker inspect` 验证不存在。随后把同一真实容器执行器接入隔离 SQLite + 真实 gRPC Worker 流程，Task ID `d7cf8f99-06c1-4ce9-a0ec-5f88b3d1324f`：取消请求先记录为 running + `cancellationRequested=true`，Worker 心跳收到请求后终止 Docker 容器，最终 task=`cancelled`、run=`cancelled`，容器已移除。全链路测试通过。所有测试均使用临时数据库、临时 Worker credential 和独立容器，没有触碰现有 Worker。
- 补充修复取消启动竞态：如果取消到达时 Docker 容器仍在创建，清理钩子会在 5 秒内重试查找并删除容器；之后才以本地进程组终止作为兜底。
- 原始 Codex CLI 非变更性 MCP 验收再次尝试：`codex mcp list` 显示 `teamSkillHub` enabled 且使用 `TEAM_SKILL_HUB_API_KEY` 环境变量引用。`codex exec --json --ephemeral` 仍连续报 `403 unsupported_country_region_territory`，35 秒后超时，没有观察到 MCP 工具调用或新任务。未尝试规避地区限制。
- 全量 `npm run check`、定向取消/元数据/MCP 测试及 `git diff --check` 已执行；最终结果见本次验收记录末尾。

### 当前原型验收状态（2026-10-22）

| 项目                                                      | 状态                                                       | 证据/限制                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin 专家配置与执行配置分离、按专家配置模型路由          | 已实现，回归测试覆盖                                       | 真实管理界面和配置 API 已有 E2E 测试                                                                                                        |
| 每个 Worker 独立 clone                                    | 已实现，配置与仓库测试覆盖                                 | 不跨 Worker 共享工作树                                                                                                                      |
| Hub MCP → OTA Expert → Worker → Docker Codex → 持久化报告 | 已真实通过                                                 | 任务 `61d74796-2288-48b1-a5ff-77c2217ceac9`；只读分析，未修改仓库                                                                           |
| 结构化仓库 URL/分支/commit SHA                            | 已实现，真实 gRPC 与 MCP 测试覆盖                          | 新 CompleteTask 字段；旧报告头解析保留兼容                                                                                                  |
| 运行中任务取消                                            | 代码与集成测试已实现；真实 Docker 停止钩子通过隔离容器测试 | 尚未对在线 Worker 执行一次完整“提交任务→MCP 取消→查询 cancelled”的验收                                                                      |
| Worker 断线、租约过期和旧结果 fencing                     | 自动化测试通过                                             | 双 Worker 测试为隔离 SQLite/Worker 模拟，不是杀掉在线 Worker 的故障注入                                                                     |
| 原始 Codex CLI 自动调用 MCP                               | 未通过/外部阻塞                                            | 之前 CLI 模型请求返回 `403 unsupported_country_region_territory`；当前本 WSL shell 也找不到 `codex` 可执行文件，不能声称完成新一轮 CLI 验收 |
| 多领域 Expert 的真实任务验收                              | 部分                                                       | code-review Worker 会话存在，但本轮未另发真实任务以避免额外模型消耗；通用路由和 dispatch 有测试覆盖                                         |
| Worker 原生 OTA 测试套件                                  | 未通过/环境阻塞                                            | 缺少 `ctest`、固定 fixture 路径及 `libcrypto.so.1.1` 等问题，既有记录未证明原生套件通过                                                     |
| readiness 与同步仓库健康                                  | 本轮检查时 HTTP 200，3/3 healthy                           | 历史同步失败有恢复记录；仍需持续监测                                                                                                        |
| 安全 Gate                                                 | 暂缓，按用户决策                                           | 未实施；`seccomp=unconfined` 等限制不得视为安全验收通过                                                                                     |
| 跨物理/虚拟主机 Worker                                    | 未完成                                                     | 需要第二主机与独立网络/凭据验收环境                                                                                                         |

本轮未提交或推送代码，没有运行 WSL shutdown，没有重启或终止已有 Worker，也未实施 Security Gate。

### 2026-10-22：最终回归结果

- 真实隔离 E2E（临时 SQLite + 真实 gRPC TCP + Worker 心跳 + 真实 Docker 容器）通过：Task `d7cf8f99-06c1-4ce9-a0ec-5f88b3d1324f` 最终 task/run 均为 `cancelled`，对应容器已删除。此 ID 只存在于测试临时数据库，不是共享 Hub 任务。
- 本轮最终 `npm run check`：448 项测试通过、0 失败；TypeScript build 通过，格式检查通过，ESLint 0 errors（已有 warnings），`git diff --check` 通过。额外定向执行 31 项取消、容器参数、进程树、gRPC、task-store、Worker loop 与 MCP E2E 测试，31/31 通过。
- Hub readiness 最终为 HTTP 200（3/3 仓库 healthy）；现有 `ota-expert-worker` 与 `code-review-expert-worker` tmux 会话仍存在，未重启或终止。
- 原始 Codex CLI 调用依旧受登录 Token 刷新 403 阻塞；这是唯一无法在当前环境自行消除的主要原型验收阻塞。另有 Worker 原生 OTA 测试工具链、跨主机 Worker、安全 Gate（按用户要求暂缓）尚未完成。

### 2026-10-22：修复自动专家路由的 MCP 调用契约

- Codex CLI 的真实验收报告确认：任务执行链路成功，但模型把 `__AUTO__`、`auto`、`AUTO_SELECT`、`automatic` 当作 `expertId` 传入，Hub 因而返回 `EXPERT_NOT_FOUND`；随后改用 `expertId=ota` 才完成任务。该任务的 `selectionMode=explicit`，不能算自动路由成功。
- 检查后确认路由引擎本身支持省略 `expertId` 自动选专家，缺口是 MCP 契约只隐式要求“省略 expertId”，没有可直接表达的 `selectionMode` 字段，模型容易误把自动选择标识当作专家 ID。
- `submit_expert_task` 现在显式公开 `selectionMode: "auto" | "explicit"`。自动路由必须传 `selectionMode="auto"` 并省略 `expertId`；工具说明明确禁止把 `__AUTO__`、`auto`、`AUTO_SELECT`、`automatic` 等值作为专家 ID。显式模式仍需真实 `expertId`。为兼容现有客户端，省略 `selectionMode` 时继续采用旧行为：有 `expertId` 为 explicit，无 `expertId` 为 auto。矛盾输入（auto 同时传 expertId，或 explicit 缺少 expertId）会清晰报错。
- 回归测试：MCP E2E 使用显式 `selectionMode="auto"` 提交任务，路由到 OTA 专家并完成任务；路由单测覆盖 auto 模式、显式模式、错误组合。定向测试 6/6 通过。
- 注意：以上是本地源码与测试的验证。已运行的 Hub/MCP 服务需部署/重启服务进程后，真实 Codex CLI 才能看到新增的 `selectionMode` 工具参数；本轮未重启 Hub 或任何 Worker，避免干扰现有服务。部署后需要再做一次真实 Codex CLI 自动路由验收，确认结果的 `selectionMode` 为 `auto`。

### 2026-10-22：部署后真实 Codex CLI 自动路由验收通过

- 按 `./deploy-local-wsl2.sh` 既有流程仅重建并替换 `team-skill-hub` Compose 服务；没有停止、重启或终止两个独立 tmux Worker。部署后 Hub readiness HTTP 200，3/3 repositories healthy；`ota-expert-worker` 和 `code-review-expert-worker` 会话均仍存在。
- 直接读取部署后 MCP `tools/list`，`submit_expert_task` 的 live input schema 已公开 `selectionMode` enum `auto|explicit`，必填项仍只有 `problem` 与 `idempotencyKey`，确保旧客户端兼容。
- 使用原始 Codex CLI 执行 `codex exec --json --ephemeral`，明确要求 `selectionMode="auto"` 且省略 `expertId`，没有调用 `list_available_experts` 代替 Hub 路由。CLI 实际调用 `submit_expert_task`、`get_expert_task_status` 和 `get_expert_task_result`，并最终输出任务成功。
- 真实任务 ID：`4eabd0ce-784b-4c43-a070-cfd865806fc2`。独立通过已部署 MCP 再次查询持久化状态，确认 `status=succeeded`、`expertId=ota`、`selectionMode=auto`、`repositoryId=repo-348fc59a6e5026e57e35`，仓库 URL=`https://github.com/shh632058099/otalib.git`，branch=`master`，commit SHA=`ae46ce477699157de6eccb53f9b222b89d344461`；`get_expert_task_result` 可读取约 2.9 KB 持久化报告。
- 报告为只读架构分析，指出 `src/ota_diff.c` 中通过 `system()` 执行拼接路径的命令注入风险、`src/ota_partition.c` 分区写入边界校验风险、`src/ota_package.c` ZIP 大小驱动分配的拒绝服务风险。Worker 声明未修改仓库、未构建/运行测试、未提交或创建 PR。
- Codex CLI 输出中仍有后台 token refresh `403 unsupported_country_region_territory` 日志，但本次任务的 MCP 工具调用、状态轮询、结果读取和 `turn.completed` 均成功；不应把该背景认证日志误报为本次自动路由失败，也不能据此认定其他模型请求均无认证问题。
- **验收结论：自动专家路由真实 E2E 通过。** 原始 Codex CLI → live MCP → `selectionMode=auto` → Hub 路由到 OTA 专家 → Worker 执行 → 持久化结果返回 Codex CLI 的链路已得到实际运行证据。

### 2026-10-22：多专家自动路由真实验收

- 再次使用原始 Codex CLI（`codex exec --json --ephemeral`）提交只读代码审查请求，明确 `selectionMode="auto"` 且不传 `expertId`。Hub 真实创建并执行任务 `f2a27553-8b00-4025-b61b-09e0959f2866`，最终状态 `succeeded`，返回 `expertId=code-review`、`selectionMode=auto`。
- 通过已部署 MCP 独立复查持久化记录：仓库 `https://github.com/shh632058099/otalib.git`、branch `master`、commit `ae46ce477699157de6eccb53f9b222b89d344461`，报告长度约 1.9 KB。报告指出 GPT/GPT header size 越界读取风险（`src/ota_partition.c:214`）、ZIP 解析错误/回调失败可能仍返回成功（`src/zip_reader.c:118-152`）、测试脚本可能吞掉失败状态（`tests/run_tests.sh:41`）。Worker 声明只读，没有构建、运行测试或修改仓库。
- 路由单测增加 `code-review` 专家 fixture，覆盖“review 请求 → code-review 自动选择”和“无关键词匹配 → `EXPERT_UNAVAILABLE`”；既有测试继续覆盖 OTA 自动选择、无权限、歧义匹配以及 explicit/auto 参数矛盾。定向 router 测试 6/6 通过。
- 目前已有两个真实自动路由 E2E 证据：OTA 问题自动路由到 `ota`（任务 `4eabd0ce-784b-4c43-a070-cfd865806fc2`），代码审查问题自动路由到 `code-review`（任务 `f2a27553-8b00-4025-b61b-09e0959f2866`）。这证明已配置的两类专家均能通过 Hub 的自动路由、Worker 执行及持久化结果链路；不代表对任意自然语言的语义分类准确率已全面评估。

### 2026-10-22：多专家验收后的全量回归与运行态注意事项

- 新增代码审查专家路由单测后，`npm run format:check`、`npm run lint`、`npm run build` 均退出成功；lint 保留仓库既有 warnings（209 warnings，0 errors）。完整 `npm run check` 中测试阶段报告 451 passed、0 failed。`git diff --check` 通过。
- 回归期间发现当前 Hub readiness 从此前的 HTTP 200 变为 HTTP 503，响应为 3 个仓库中 2 healthy、1 error。日志显示定时同步 GitHub 时 `rd-skills` / `rd-knowledges` 的 `git fetch` 出现 GnuTLS/TLS 连接错误；另一次同步仍成功更新其中一个仓库。该问题与本轮路由单测变更没有直接关联，但当前服务应标记为 readiness degraded，不能沿用旧的 3/3 healthy 结论。
- 为避免扩大影响，没有重启 Hub/Worker，没有更改代理或仓库配置；两个 Worker tmux 会话仍在。需要后续单独排查 Docker 内 GitHub 代理/TLS 稳定性，并在 readiness 恢复后复验。
