# Team Skill Hub Client Integration Update Design

## 1. 背景

当前 Team Skill Hub 通过四套 setup 脚本配置研发机器：

- `scripts/setup-claude-code.sh`
- `scripts/setup-claude-code.ps1`
- `scripts/setup-codex-mcp.sh`
- `scripts/setup-codex-mcp.ps1`

setup 会维护 MCP 配置、Claude/Codex 全局 guidance、hooks、权限以及本地安装状态。当前升级方式仍依赖管理员通知研发人员重新获取 setup 文件，再手工执行 `--upgrade`。当 MCP 接口、guidance、hook 或 permission 变化时，这种模式存在以下问题：研发不知道本地接入组件是否过期；管理员需要人工通知和跟踪升级；setup 文件本身没有稳定自更新入口；服务端、MCP API 与本地 guidance 可能版本不一致；旧客户端可能继续使用已废弃的行为指导。

本设计目标是让 Team Skill Hub 客户端接入组件具备版本发现、会话启动提示、用户确认后自动升级、失败回滚和兼容性管理能力，同时避免静默修改研发机器。

## 2. 目标

### 2.1 用户体验目标

研发启动 Claude Code 或 Codex CLI 后，如果客户端接入组件有新版本，能够收到类似提示：

```text
Team Skill Hub client integration update available: v4 -> v5.
Say "升级 Team Skill Hub" to install it.
```

用户明确确认后，Claude/Codex 可以执行本地升级命令，自动完成更新，不需要重新下载 setup 文件。

如果当前版本低于服务端最低支持版本，则提示必须升级；升级完成后要求重启 CLI，再继续依赖新版 client integration 的 Team Skill Hub 操作。

### 2.2 技术目标

- 服务端与客户端接入包作为同一个 release snapshot 构建和部署。
- 客户端包由 Team Skill Hub 服务端静态托管，不依赖 GitHub/GitLab 可访问性。
- SessionStart 主动检查更新，但使用本地缓存控制检查频率。
- 只在用户明确同意后执行升级，不做静默自动升级。
- 升级采用 side-by-side 安装、transaction journal 和 current pointer 原子切换，失败或中断时恢复到上一 committed 状态。
- MCP API 正确性不依赖 setup guidance。
- 版本源单一，避免 server / hooks / setup / docs 多处版本漂移。

## 3. 非目标

- 不让服务端远程直接修改研发机器文件。
- 不做后台静默自动升级。
- 不让服务器运行时从 GitHub/GitLab `git pull` 最新 setup 文件。
- 不把业务 MCP schema 或 tool existence 依赖客户端 guidance。
- 不引入 Go/Rust/Node 常驻客户端进程。
- 不做复杂的集中式设备管理、强制推送或 MDM。

## 4. 总体架构

采用“服务端版本清单 + 本地 Client Runtime + SessionStart 检查 + 用户确认升级 + side-by-side 安装 + transaction recovery”的方案。

```text
                    Git Repository
                         |
          +--------------+--------------+
          |                             |
   Team Skill Hub Server        Client Integration
      src / config              setup / hooks / guidance
          |                             |
          +--------------+--------------+
                         |
                    Release Build
                         |
          +--------------+--------------+
          |                             |
      server dist              client package vN
                                        |
                                        +-- manifest.json
                                        +-- updater
                                        +-- codex/
                                        +-- claude/
          |                             |
          +--------------+--------------+
                         |
                    Docker Image
                         |
                         v
                  Team Skill Hub
              /mcp
              /client-integration/manifest.json
              /client-integration/releases/<version>/...
```

研发机器：

```text
Claude / Codex SessionStart
          |
          v
team-skill-hub-client session-start
          |
          +-- local cache valid -> local comparison
          |
          +-- cache expired -> GET manifest
                               |
                               v
                         compare versions
                               |
                +--------------+--------------+
                |              |              |
             current        optional       required
             silent         notify         must notify
```

## 5. Client Integration 版本模型

新增统一的 `clientIntegrationVersion`，它是判断“客户端是否需要升级”的唯一主版本。

当前已有的 `HOOK_RUNTIME_VERSION` 和 `HOOK_SCHEMA_VERSION` 继续保留，但只用于子组件诊断和兼容性判断，不作为整体升级版本。

推荐单一版本源：`client-integration/release.json`。

```json
{
  "schemaVersion": 1,
  "version": 5,
  "minimumSupportedVersion": 4,
  "hookRuntimeVersion": "1.2.0",
  "hookSchemaVersion": 2
}
```

client package manifest、`get_server_info` 中的 client integration 信息、构建产物版本目录、setup 安装时写入的本地版本和 CI 版本检查都从这个文件派生。不允许在 SH、PowerShell、TypeScript 和文档中分别硬编码主版本。

## 6. 服务端托管模型

### 6.1 构建阶段生成客户端接入包

新增构建步骤：

```text
npm run build:client-integration
```

从当前 repository snapshot 收集 setup 脚本、Codex/Claude hooks、managed guidance templates、client launcher、versioned updater 和 release metadata，生成：

```text
dist/client-integration/
├── manifest.json
└── releases/
    └── 5/
        ├── linux.tar.gz
        ├── windows.zip
        └── checksums.json
```

### 6.2 Docker 与服务端同版本发布

Docker build 必须在客户端包生成后执行，并将其打入同一个镜像：

```text
COPY dist/client-integration /app/client-integration
```

服务端直接静态托管：

```text
GET /client-integration/manifest.json
GET /client-integration/releases/5/linux.tar.gz
GET /client-integration/releases/5/windows.zip
```

第一阶段 manifest/package endpoint 在受信任内网中作为只读发行资源，不要求 API Key；这样即使 MCP API Key 未注入或已失效，客户端仍能发现并修复自身版本。package 不包含 secret。若未来需要收紧访问控制，应作为独立部署策略增加，不改变本地 updater 的版本/事务模型。

服务端不在 runtime 阶段从 Git 仓库拉取 setup 或 updater。这样 `Server API + Client integration package + MCP compatibility` 始终来自同一个 release snapshot。

### 6.3 历史版本保留策略

镜像不无限保存所有历史版本，至少保留 `latest` 和 `minimum supported`。例如 latest=v5、minimum=v4 时保留 v4/v5；最低支持版本提升后可在后续 release 移除更老版本。服务端历史包仅用于升级/修复，不承担客户端 rollback 的 previous package 持久化责任；客户端本机负责保留 current + previous。

## 7. Manifest 设计

```json
{
  "schema_version": 1,
  "version": 5,
  "minimum_supported_version": 4,
  "released_at": "2026-10-15T11:30:00+08:00",
  "server_compatibility": {
    "min": "0.1.0",
    "max": "0.1.x"
  },
  "restart_required": true,
  "summary": "Unify Skill submission through submit_skill_bundle",
  "packages": {
    "linux": {
      "path": "releases/5/linux.tar.gz",
      "sha256": "..."
    },
    "windows": {
      "path": "releases/5/windows.zip",
      "sha256": "..."
    }
  }
}
```

是否属于 required update 不单独存成可矛盾字段，而是由 `installed_version < minimum_supported_version` 确定。`restart_required` 表示升级后当前 CLI 是否需要重启才能保证所有 guidance/hooks/MCP 配置生效。

`packages.*.path` 必须是相对于当前 manifest URL 的相对路径，由标准 URL resolution 生成下载 URL；禁止用字符串拼接根路径，以支持反向代理 path prefix。

## 8. 本地 Client Runtime

首次 setup 不再只复制 hooks，而是安装一个稳定的本地 launcher：

```text
~/.team-skill-hub/
├── bin/
│   └── team-skill-hub-client
├── state.json
├── cache/
│   └── manifest.json
├── releases/
│   ├── v4/
│   └── v5/
└── current -> releases/v5
```

Windows 使用语义相同的目录和 PowerShell launcher；若符号链接不可靠，使用 current pointer 文件，不要求 symlink。

Launcher 必须保持极小和稳定，只负责读取 state、定位 Hub、获取 manifest、下载 package、校验 SHA-256、解压到临时目录、调用版本化 updater、成功后切换 current，并在启动时恢复未完成的升级事务。复杂迁移逻辑全部放在版本化 updater 中。

本地安装路径不能在后续升级时重新根据当前环境猜测。首次 setup/bootstrap 必须记录实际解析后的 Codex/Claude 配置目录，例如 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 或默认目录的最终绝对路径；后续 updater 始终以 state 中的已安装路径为准。

### 8.1 Launcher 自更新与 bootstrap 兼容

`bin/team-skill-hub-client` 是稳定 shim，不承载业务迁移逻辑。版本化 runtime/package 可以携带新版 shim；升级时先将其写为旁路文件（例如 `team-skill-hub-client.next`），完成 package apply 和 current 切换后再安全替换。Windows 若当前进程锁定脚本，则记录 `pending_launcher_version`，由下一次启动在执行 runtime 前完成替换。

从第一版开始，shim 必须理解 `state.json`、current pointer、manifest schema v1 和 pending launcher replacement。服务端在仍存在受支持的旧客户端时，manifest schema v1 必须保持向后兼容；如果未来必须升级 manifest schema，旧 schema endpoint 至少保留到对应 `minimumSupportedVersion` 淘汰完成。这样 updater/runtime 可以频繁演进，而 bootstrap shim 很少需要人工重新安装。

如果本地 shim 已损坏或其支持的协议低于服务器仍可提供的兼容协议，`setup-*.sh/.ps1 --upgrade` 作为灾难恢复入口保留，但不属于正常升级路径。

### 8.2 命令接口

```text
team-skill-hub-client version
team-skill-hub-client check-update
team-skill-hub-client session-start --client codex
team-skill-hub-client session-start --client claude
team-skill-hub-client upgrade
team-skill-hub-client rollback
team-skill-hub-client doctor
```

`upgrade` 只在用户明确同意后执行。`rollback` 只回退到上一个成功安装版本。`doctor` 不输出 API Key。

## 9. 本地状态模型

```json
{
  "schema_version": 1,
  "installed_version": 5,
  "previous_version": 4,
  "hub_base_url": "http://127.0.0.1:8080",
  "api_key_env": "TEAM_SKILL_HUB_API_KEY",
  "clients": {
    "codex": {
      "enabled": true,
      "config_home": "/home/user/.codex",
      "server_name": "teamSkillHub"
    },
    "claude": {
      "enabled": true,
      "config_home": "/home/user/.claude",
      "server_name": "teamSkillHub"
    }
  },
  "last_update_check_at": "2026-10-15T03:30:00Z",
  "last_successful_upgrade_at": "2026-10-15T03:35:00Z"
}
```

只保存配置元数据，不保存 API Key 或 token。

默认假设同一台机器上的 Codex 和 Claude 指向同一个 Team Skill Hub base URL。bootstrap 如果检测到两个客户端现有配置指向不同 Hub，不得静默合并为一个 state；第一阶段直接给出明确错误并要求用户选择统一目标，后续如确有需求再扩展为多 profile 模型。

`hub_base_url` 表示部署基址，不包含 `/mcp`。package URL 必须使用相对于 manifest 的相对路径并通过标准 URL resolution 解析，避免反向代理部署在 `/skill-hub/` 等 path prefix 下时丢失前缀。

## 10. SessionStart 更新检查

Codex 与 Claude 都在 SessionStart 调用：

```text
team-skill-hub-client session-start --client <codex|claude>
```

要求：快速返回、不阻断正常开发、网络失败静默降级、不执行升级。

SessionStart 采用明确的执行预算：缓存命中路径目标小于 50 ms；网络检查 connect/read 使用短超时，单次 manifest 检查总预算默认不超过 800 ms；整个 SessionStart runtime 必须在客户端 hook timeout 之前主动结束。manifest 设置合理的最大响应尺寸，SessionStart 不下载 package、不解压、不执行 updater。

默认使用 12 小时缓存。缓存有效时不访问服务器；缓存过期才请求 `/client-integration/manifest.json`。更新检查使用 non-blocking `update-check.lock`；如果其他 session 正在刷新 manifest，则当前 session 直接使用旧缓存或静默继续，不等待锁。

无更新时不输出。可选更新时提示：

```text
Team Skill Hub client integration update available: v4 -> v5.
Say "升级 Team Skill Hub" to install it.
```

低于最低支持版本时提示：

```text
Team Skill Hub client integration v3 is no longer supported.
Minimum required version: v4.
Please upgrade before using Team Skill Hub operations that depend on the new client integration.
```

网络失败、manifest 不可达、缓存解析失败默认不打断用户工作；错误只进入本地诊断信息。

`session-start` 内部只生成结构化决策：`none | optional_update | required_update`，不假设向 stdout 打印任意文本就一定能被 Claude/Codex 正确展示。Codex 与 Claude 分别由 client-specific renderer 按各自 SessionStart hook 输出协议呈现提示。实现前 acceptance 必须验证两端的 stdout/stderr/结构化 hook output 行为，避免把提示误解释为 hook control output。

## 11. Claude 与 Codex 集成

### 11.1 Codex

现有 Codex telemetry hook 保持职责不变。SessionStart 增加独立 client runtime hook：

```text
team-skill-hub-hook.*
-> lifecycle telemetry

team-skill-hub-client session-start
-> version/update notification
```

### 11.2 Claude Code

当前 Claude SessionStart 主要使用 HTTP hook。新版 setup 同时安装一个最小本地 SessionStart command hook，仅执行：

```text
team-skill-hub-client session-start --client claude
```

原 HTTP lifecycle hook 保持不变，不把 updater 逻辑塞进 Stop hook。

Codex 和 Claude 的 SessionStart update notice 共享同一决策逻辑，但输出适配分离。runtime 不直接绑定某个客户端的 hook 输出格式。

### 11.3 Managed Guidance

Claude `CLAUDE.md` 和 Codex `AGENTS.md` managed block 增加统一规则：

- SessionStart 提示更新时，不自动升级。
- 用户明确要求升级 Team Skill Hub 时，执行本地 `team-skill-hub-client upgrade`。
- required 更新完成后提示重启 CLI。
- 不自行从 GitHub/GitLab 下载 setup 文件。

## 12. 用户确认与执行边界

```text
SessionStart 可以自动检查
SessionStart 不可以自动升级
```

只有用户明确表达升级意图，Claude/Codex 才执行 `team-skill-hub-client upgrade`。不新增“服务端 MCP tool 直接远程修改本机”的能力。

## 13. 升级流程

```text
1. 获取全局 `upgrade.lock`；已被其他 upgrade/rollback 持有时直接提示并退出
2. GET manifest
3. 检查 installed < latest
4. 选择 platform package
5. 下载到临时文件
6. 校验 SHA-256
7. 解压到 releases/vN.tmp
8. 校验包内 manifest 与服务端 manifest 一致
9. 创建 upgrade transaction journal，记录 from/to version、目标客户端、受管文件和恢复信息
10. 备份即将修改的 Team Skill Hub managed 状态
11. 将事务状态写为 `applying`
12. 执行 vN updater apply
13. updater 自检
14. 将事务状态写为 `applied`
15. rename vN.tmp -> vN
16. 切换 current pointer
17. 更新 state.json，保留 previous_version
18. 将事务标记为 `committed`
19. 清理 transaction backup 和临时文件
20. 输出成功与 restart 要求
```

只有 updater apply 与自检成功后才允许切换 current。

升级不是单文件原子操作，因此必须通过 transaction journal 保证 crash recovery。launcher 每次执行任何命令前先检查未完成事务：如果事务停在 `applying/applied` 且尚未 committed，则根据 journal 恢复升级前的 managed 状态和 previous current/state，再继续正常命令。事务 journal 与 `state.json` 自身都使用临时文件 + 原子 rename 写入。

`upgrade` 与 `rollback` 共享同一把全局 exclusive mutation lock，避免多个 Codex/Claude session 同时改写 `AGENTS.md`、`CLAUDE.md`、hooks、MCP 配置和 state。

## 14. Updater 修改范围

版本化 updater 可以修改：Claude MCP registration、Claude Team Skill Hub permission allow rule、Claude managed `CLAUDE.md` block、Claude hooks、Codex MCP managed block、Codex managed `AGENTS.md` block、Codex hooks、Team Skill Hub hook config 和 `~/.team-skill-hub/state.json`。

不得删除非 Team Skill Hub 管理的用户配置，不得覆盖用户 Markdown 非 managed 内容，不得将 API Key 写入 package/state。所有配置写入继续使用 merge/managed block 语义，并使用临时文件 + 原子替换。

Updater 只能使用 state 中记录的实际 client install path，不得因为升级进程当前未设置 `CODEX_HOME` 或 `CLAUDE_CONFIG_DIR` 而回退到默认目录。

## 15. Optional 与 Required 更新

### 15.1 Optional

条件：`installed >= minimum_supported && installed < latest`。

SessionStart 提示可升级；用户可以暂时忽略。升级后若 `restart_required=false` 可继续当前会话；为 true 时提示建议重启，但不阻断普通本地开发。

### 15.2 Required

条件：`installed < minimum_supported`。

SessionStart 明确提示必须升级。升级完成后要求重启 Claude/Codex；在重启前，不继续执行依赖新版 client integration 的 Team Skill Hub 操作。普通本地编码工作不因 updater 被阻断。

Required update 是客户端接入层状态，不可作为服务端 API 正确性的唯一保护。breaking MCP 变更仍必须由服务端自身的 schema/tool compatibility window、明确拒绝策略或版本化 contract 保证；旧 guidance 即使未升级，也不能使服务端进入未定义行为。

## 16. MCP API 与 Client Integration 职责边界

原则：

```text
MCP schema / tool description / tool existence = API contract
Client integration guidance                    = behavior enhancement
```

因此 tool 是否存在、schema、deprecated tool 移除和 breaking API fail-closed 都由服务端保证。setup guidance 不承担 API 正确性保证。

## 17. `get_server_info` 扩展

增加只读诊断信息：

```json
{
  "server_version": "0.1.0",
  "client_integration": {
    "latest_version": 5,
    "minimum_supported_version": 4,
    "manifest_path": "/client-integration/manifest.json"
  }
}
```

该字段用于诊断和模型可见信息，不作为 SessionStart 更新检查的唯一机制；主要版本判断由本地 runtime 与 HTTP manifest 完成。

## 18. 安全设计

- Team Skill Hub 运行在受信任内网环境，本设计不针对恶意服务端或网络中间人建立独立软件签名信任链。
- package 必须有 SHA-256，hash 不匹配立即终止；SHA-256 用于检测下载损坏、传输异常和错误构建产物，不作为恶意发布源对抗机制。
- 客户端只允许从当前配置的 Team Skill Hub base URL 下载更新。
- 第一版不允许 manifest 指向第三方 host。
- manifest、package、state 均不包含 API Key。
- 日志不得打印 API Key 环境变量值。
- updater 只修改声明的 Team Skill Hub managed 文件/区块。

## 19. 失败与回滚

- 检查更新失败：不影响 CLI 启动；有有效缓存则使用缓存，无缓存静默继续。
- 下载失败：不修改 current，删除不完整临时包。
- Hash 失败：不执行包内脚本，保留旧版本。
- updater apply 失败：不切换 current，使用 transaction backup 精确恢复 apply 前 managed 配置。
- 进程在 apply/current/state 任意中间阶段异常退出：下一次 launcher 启动先根据 transaction journal 恢复到上一 committed 状态。
- 新版运行异常：`team-skill-hub-client rollback` 回到 `previous_version`。主动 version rollback 由目标版本 reconciliation/migration 逻辑恢复该版本应有的 managed 状态，不假设“重新执行旧 updater apply”天然等价于完整反向迁移。
- 本机至少保留 current + previous 两个成功版本；rollback 不依赖服务端仍能下载 previous package。升级成功后可清理更老的本地 release。

## 20. 构建与版本防护

CI 增加 client integration version gate。当以下内容变化：

```text
scripts/setup-claude-*
scripts/setup-codex-*
scripts/team-skill-hub-hook*
client-integration/**
managed guidance templates
```

而 `client-integration/release.json` 的 `version` 未提升时，CI 失败。

构建还要验证 package manifest 与 release.json 一致、linux/windows 包存在、SHA-256 可重算、包内 required files 完整、无 secret-like 文件。

## 21. 测试策略

### 21.1 Unit tests

覆盖版本比较、minimum/latest 决策、TTL cache、manifest schema、SHA-256、state 读写、platform package 选择、optional/required/restart_required 决策、relative package URL resolution、自定义 client config_home、update-check lock 和 upgrade lock 决策。

### 21.2 Updater integration tests

使用临时 HOME 覆盖首次安装、v4->v5、保留用户原配置、managed block 更新、hook 替换、permission 合并、幂等、下载失败、hash 错误、apply 失败回滚、apply 后进程中断恢复、current/state 切换中断恢复、并发 upgrade 拒绝、rollback 恢复，以及自定义 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 在后续升级中保持不变。

### 21.3 Server tests

覆盖 manifest/package endpoint、content type、path traversal 拒绝、`get_server_info` client integration 字段，以及 Docker build 中 package 确实存在。

### 21.4 Real CLI acceptance

WSL2 Ubuntu 24.04 验证：Codex/Claude SessionStart 都能按各自 hook output contract 看到 update notice；无更新无噪声；缓存有效期内不重复请求；并发 session 不重复阻塞更新检查；用户确认后 upgrade；并发 upgrade 只有一个获得 mutation lock；required update 后提示重启；重启后新 guidance/hooks/MCP config 生效；自定义 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 能正确升级原安装位置。

Windows PowerShell 路径执行同等 setup/updater integration tests。

## 22. 发布流程

```text
修改 server / client integration
        |
        v
若 client integration 变化 -> bump release.json version
        |
        v
npm run build:client-integration
        |
        v
npm run build
npm test
        |
        v
CI client-version gate
        |
        v
Docker build
        |
        v
部署 Team Skill Hub
        |
        v
新 manifest/package 与新 server 同时上线
```

不存在单独“复制 setup 到服务器”的运维步骤。

## 23. 初始迁移策略

现有研发机器没有 `team-skill-hub-client`，因此新机制第一次上线仍需一次 bootstrap 迁移：

1. 新版 `setup-claude-code.*` / `setup-codex-mcp.*` 安装 launcher 和初始 release。
2. 现有 `--upgrade` 保留，用于这一次迁移和灾难恢复。
   bootstrap 时读取并保存每个客户端实际解析后的配置目录；如果 Claude/Codex 现有配置指向不同 Hub，则停止并提示用户先选择统一目标，不做隐式合并。
3. 完成 bootstrap 后，后续升级统一走 `team-skill-hub-client upgrade`。

也就是说，只接受“一次最后的 setup 升级”，之后不再把 setup 文件分发作为日常升级机制。

## 24. 第一阶段实现边界

第一阶段实现最小闭环：

1. `client-integration/release.json` 单一版本源。
2. client package build。
3. Docker 静态托管 manifest/package。
4. `team-skill-hub-client` launcher。
5. `state.json`。
6. `check-update` / `session-start` / `upgrade` / `rollback` / `doctor`。
7. Claude/Codex SessionStart 接入。
8. setup bootstrap/迁移。
9. CI version gate。
10. unit/integration/WSL acceptance tests。

第一阶段不引入管理后台设备列表、强制推送、远程执行或多 channel release。

## 25. 成功标准

- 修改 Team Skill Hub 客户端接入逻辑后，不再需要管理员逐个通知研发重新下载 setup 文件。
- 新版本随 Team Skill Hub image 一起发布，版本不会与 server API 漂移。
- Claude/Codex 在 SessionStart 能感知更新。
- 用户不确认时不会自动修改本机配置。
- 用户确认后能通过一条稳定命令自动升级。
- 更新失败不会破坏现有可用环境。
- 可以回滚到上一个成功版本。
- 进程在升级中途退出后，下次 launcher 启动能恢复到上一 committed 状态。
- 多个 Claude/Codex session 并发启动或请求升级时不会并发改写 managed 配置。
- 自定义 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 安装在后续升级中不会被重置到默认目录。
- breaking update 能明确要求升级和重启。
- MCP API correctness 继续由服务端保证，不依赖 guidance 是否最新。
