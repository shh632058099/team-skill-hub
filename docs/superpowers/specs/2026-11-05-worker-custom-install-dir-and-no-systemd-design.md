# Worker 自定义安装目录与手动运行模式设计

## 目标

Worker Runtime 安装器支持指定程序安装目录；安装后的 `worker-control.sh` 根据自身真实位置定位当前 Runtime，不依赖调用者当前目录。安装器支持显式 `--no-systemd`，即使主机运行 systemd，也完全跳过 systemd unit 的安装、修改、daemon-reload、enable、start、stop 和清理。

## CLI

```bash
sudo ./install-worker.sh worker-runtime.tar.gz [--install-dir PATH] [--no-systemd]
```

- 默认安装目录保持 `/opt/team-skill-hub-worker`。
- `--install-dir PATH` 支持绝对路径、相对路径及包含空格的路径；相对路径在安装开始时相对调用者当前目录解析为绝对路径。
- 未指定 `--no-systemd` 时，保持当前自动检测策略：可用 systemd 则安装并管理 unit；否则提供手动运行方式。
- `--no-systemd` 优先级最高，绝不执行任何 systemctl 操作，也不创建、覆盖、删除 unit 文件。
- 未知参数、缺失参数值、空路径应明确报错并退出非零。

## 安装布局与路径

程序、Node runtime、releases 和 `current` symlink 全部位于指定安装目录。`worker-control.sh` 通过 `readlink -f`/等价方式解析自身路径，找到 release/current 根目录及同目录 Node；调用者 cwd 不参与路径解析。安装器生成的 systemd unit 必须使用本次解析后的绝对安装路径，不再依赖固定 `/opt`。

保持配置目录 `/etc/team-skill-hub-worker` 和数据目录 `/var/lib/team-skill-hub-worker` 不变，避免影响凭据、实例配置和运行数据。

## systemd 行为

- 自动模式沿用现有多实例 unit 命名、启动/停止和旧 unit 安全检查/清理逻辑；unit 中的 `ExecStart`、`ExecStop`、`WorkingDirectory`、Node 路径指向实际安装目录。
- `--no-systemd` 不调用 systemctl（包括探测状态），不触碰任何现存 unit；不把手动模式实例注册到 systemd。已有 unit 保持原样，不自动停用或删除。
- 无 systemd 主机仍按现有手动模式工作。

## 手动控制

安装完成时打印可复制命令，路径需正确 shell-quote：

```bash
<install-dir>/current/worker-control.sh init <instance>
<install-dir>/current/worker-control.sh <instance> start
<install-dir>/current/worker-control.sh list
```

具体子命令顺序以现有 `worker-control.sh` CLI 为准，文档和输出必须与实际接口一致。手动运行通过该脚本管理，不要求切换 cwd。

## 升级与兼容

- 不传 `--install-dir` 时维持旧默认路径及既有升级行为。
- 同一路径重复安装/升级仍通过 release + current symlink 机制；不覆盖 `/etc`、`/var/lib` 用户数据。
- 自定义目录的后续升级必须显式传同一 `--install-dir`；不允许从源码仓库目录推断安装目录。
- systemd 自动模式更新 unit 指向新 release/current；`--no-systemd` 不改 unit，即便此前存在 systemd unit。

## 非目标

不迁移配置/数据目录，不改变 Worker 注册、认证、MCP、任务派发协议，不改变现有实例命名和凭据格式。

## 验收标准

1. 默认路径安装行为兼容。
2. 自定义绝对/相对路径安装后，control 从任意 cwd 可执行。
3. 路径含空格时安装、Node 调用、控制命令均正常。
4. systemd 自动模式 unit 的所有路径指向自定义目录。
5. 在有 systemd 的主机传 `--no-systemd` 时，systemctl 调用次数为零，unit 文件保持字节级不变。
6. `--no-systemd` 输出准确的 init/start/list 命令。
7. 配置和数据目录保持原样，重复安装/升级不丢数据。
