# 发布管理员手册：制作和交付 Expert Worker Runtime 与执行镜像

本文仅面向 **Team Skill Hub 发布管理员 / CI 维护者**。管理员在可信构建机上制作、核验并交付两个制品；**Worker 部署用户不需要源码，不需要执行编译或 `docker build`**。部署端请使用 [add-expert.md](./add-expert.md)。

## 1. 产物、责任和交付方式

| 产物                                        | 构建命令                                        | 交付文件（当前示例版本 0.1.0）                           | 由谁使用                       |
| ------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | ------------------------------ |
| **Worker Runtime**（宿主机 systemd daemon） | `npm run build:worker-runtime`                  | `artifacts/worker-runtime/worker-runtime-0.1.0.tar.gz`   | Worker 主机解压安装            |
| **任务执行 Docker Image**（执行 Codex）     | `scripts/build-worker-execution-image.sh 0.1.0` | `artifacts/worker-runtime/expert-worker-image-0.1.0.tar` | Worker 主机 `docker load` 导入 |
| **校验信息**                                | `sha256sum`、`git rev-parse` 等                 | 发布清单 / SHA-256 文件                                  | 部署者比对版本与文件完整性     |

Runtime **不是 Docker image**，Image 也**不是常驻 Worker 服务**。两者通过 `EXPERT_DOCKER_IMAGE=team-skill-hub-expert-worker:0.1.0` 关联。当前发行目录 `artifacts/` 被 Git 忽略：**本地生成不等于已公开发布**。应通过组织批准的制品库/内部文件服务向部署人员提供真实下载地址、校验值和版本；不要编造 GitHub Releases 地址，也不要直接提交大型 tar 到 Git。

> 当前源代码的 `worker-runtime/package.json` 版本为 `0.1.0`。Runtime **由该文件决定版本号**；Image 构建脚本的参数 **独立决定 tag 和 tar 文件名**。打包前务必核对二者相同，不能只改 Image 的版本参数。

## 2. 发布机所需环境

发布机需要：**完整 `team-skill-hub` 仓库 checkout**、Node.js 24.x、npm、Docker Engine（daemon 可用）、`git`、`tar`、`sha256sum` 和可访问 npm registry / Docker 基础镜像仓库的网络；建议使用专用 Linux x86_64 CI/VM。Docker 镜像构建会拉取 `node:24-bookworm-slim`，并从 npm 安装构建时固定的 Codex 版本（当前 Dockerfile 中 `CODEX_VERSION=0.162.1`），构建机需要相应网络/代理。构建机磁盘建议预留数 GiB 以上空间，并为 Docker layer/cache 留余量。

镜像架构以**实际构建结果**为准。已核对的本地 `0.1.0` 示例镜像是 `linux/amd64`；若目标是 ARM64，需要另行制作并验证 ARM64 镜像及配套 Node.js、Codex 支持，不能直接拿 amd64 tar 当 arm64 版本分发。

## 3. 在干净的发布工作区构建

建议先将经过审核的 Git Commit 固定为发布输入（不要在带本地未提交源码修改的工作区制作正式发行版）。以下命令在 **发布机** 的 Hub 仓库根目录执行：

```bash
set -euo pipefail
cd /path/to/team-skill-hub

# 确认来自预期的发布分支/Commit，且没有未提交改动
git branch --show-current
git rev-parse HEAD
test -z "$(git status --porcelain)" || {
  echo '工作区有未提交更改，停止正式发布' >&2
  exit 1
}

# Node 24 + Docker Engine 正常
node --version
npm --version
docker version

# 与 worker-runtime/package.json 保持一致
VERSION=$(node -p 'require("./worker-runtime/package.json").version')
printf 'Release version: %s\n' "$VERSION"

# 安装仓库的构建依赖并执行检查
npm ci
npm run check

# 产物 1：Worker Runtime tar.gz
npm run build:worker-runtime

# 产物 2：Codex 执行镜像 + docker save 的离线 tar
bash scripts/build-worker-execution-image.sh "$VERSION"
```

**实际脚本行为：** `build:worker-runtime` 先用 `tsconfig.worker.json` 编译 Worker 依赖闭包，再运行 `scripts/package-worker-runtime.mjs`；后者将 Worker JS、proto、运行时 `package.json` / lockfile、生产 npm 依赖、`install-worker.sh`、`worker.env.example`、systemd 服务和检查脚本打入 tar.gz。执行镜像由 `docker/expert-worker/Dockerfile` 制作，内含 Node 24、Codex CLI、系统 CA 和独立的执行用户；构建脚本运行 `docker build --pull` 后 `docker save`。

**注意可复现性：** 当前 Dockerfile 的基础镜像用浮动 tag，且构建脚本使用 `--pull`。即使版本号相同，多次构建也可能得到不同 digest；必须记录**实际**镜像 ID、基镜像/构建环境和 tar 的 SHA-256。若需要严格可复现发行，后续应固定基础镜像 digest、构建平台与依赖来源，不能仅凭版本号认定字节一致。

## 4. 发布前核验与生成清单

```bash
set -euo pipefail
VERSION=$(node -p 'require("./worker-runtime/package.json").version')
OUT="artifacts/worker-runtime"
RUNTIME="$OUT/worker-runtime-$VERSION.tar.gz"
IMAGE_TAR="$OUT/expert-worker-image-$VERSION.tar"
IMAGE_TAG="team-skill-hub-expert-worker:$VERSION"

test -s "$RUNTIME" && test -s "$IMAGE_TAR"

# 安装器、服务配置和启动文件必须存在
for f in ./install-worker.sh ./worker.env.example ./team-skill-hub-worker.service ./check-worker-config.js ./src/cli/expert-worker.js; do
  tar -tzf "$RUNTIME" | grep -Fx -- "$f" >/dev/null || {
    echo "Runtime 缺少 $f" >&2
    exit 1
  }
done

# 校验 Docker image tag、OS/架构和镜像 ID
docker image inspect "$IMAGE_TAG" \
  --format 'tag={{index .RepoTags 0}} os={{.Os}} arch={{.Architecture}} id={{.Id}}'

# 非特权、无凭据的基础烟测：打印 Codex 版本
docker run --rm "$IMAGE_TAG" --version

# 生成交付物的 SHA-256；部署端必须独立核对
(
  cd "$OUT"
  sha256sum "worker-runtime-$VERSION.tar.gz" "expert-worker-image-$VERSION.tar" \
    > "worker-artifacts-$VERSION.sha256"
)
cat "$OUT/worker-artifacts-$VERSION.sha256"

# 保存源码 Commit 以便追溯（不要把密钥写进清单）
printf 'source_commit=%s\nversion=%s\nimage_tag=%s\n' \
  "$(git rev-parse HEAD)" "$VERSION" "$IMAGE_TAG" \
  > "$OUT/worker-artifacts-$VERSION.release.txt"
```

检查通过后，至少交付**四个文件**：

```text
worker-runtime-0.1.0.tar.gz
expert-worker-image-0.1.0.tar
worker-artifacts-0.1.0.sha256
worker-artifacts-0.1.0.release.txt
```

还应在交付说明中写明镜像 `OS/Architecture`、Hub 兼容版本、Codex 版本、Worker gRPC 端口/连接方案、是否需要代理或 CA、维护/回滚联系人，以及制品真正的组织下载地址。SHA-256 只能检查完整性；**必须通过可信发布渠道核对校验清单来源**。

## 5. 分发与部署验收

1. 将四个文件上传到经批准的私有制品库或内部文件服务；为同一版本保留历史文件，限制上传/修改权限。若使用镜像仓库交付，应额外提供镜像 digest 和拉取权限；本文默认交付离线 tar。
2. **不要**将模型 API Key、Hub bootstrap token、Worker credential、Git 私钥或实际 `worker.env` 放入包中。秘密由 Hub 管理员和 Worker 部署者分别通过安全渠道配置。
3. 向部署者提供 [add-expert.md](./add-expert.md)，其第 6～8 节只负责领取、`tar`/安装、`docker load`、配置与管理员审批。
4. 发布管理员确认 Worker 已注册、审批、在线，随后由真实 MCP 客户端下发**只读任务**，确认执行使用正确仓库、模型与镜像，结果回传到 Hub，且未修改 Git 仓库。

部署端若需要多个 Worker：每个 Worker 必须有不同 `EXPERT_WORKER_ID` 和独立 credential / Git 工作区。不要因为主机相同就复用相同的 Worker 身份。

## 6. 升级、回滚和常见问题

- **构建完成但找不到 tar：** 检查 `artifacts/worker-runtime/`；它是被 `.gitignore` 排除的本地输出，不会自动推送 GitHub。
- **Runtime 与 Image 版本不一致：** 核对 `worker-runtime/package.json`、构建脚本参数、导入后的 Image tag 和 `EXPERT_DOCKER_IMAGE`；不要仅修改 tar 文件名来伪装版本。
- **Docker build 失败：** 检查 daemon 权限、`node:24-bookworm-slim` 拉取、npm registry / Codex 包、代理与 CA。不要把构建机的私有模型密钥注入 Docker image。
- **目标主机架构不同：** 为目标架构构建并测试镜像，记录架构；不能只靠 `docker tag` 转换 CPU 架构。
- **升级：** 发布新版本两类制品和 SHA-256，先在测试 Worker 完成任务验收，再滚动升级生产 Worker；排空任务，避免中途销毁在运行的容器。
- **回滚：** 保留旧 Runtime、旧镜像 tag、兼容的配置/数据备份。Runtime 安装器按版本安装并切换 `current`，但只恢复目录软链接并不能自动恢复旧镜像/数据库/协议兼容性。

**职责边界：** 本手册是发布管理员/CI 的“制作和交付”流程；`add-expert.md` 是管理员/部署用户的“领取和使用”流程。需要正式一键发布或公开下载时，应在 CI/制品仓库实现可审计的上传、签名与版本管理，而不是让部署用户执行源码构建。
