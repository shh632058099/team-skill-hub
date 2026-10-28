# Expert Platform 任务运行观测（Admin）

在 Team Skill Hub Admin → **专家平台** → **任务运行记录** 查看任务列表、Worker、状态、自动/显式路由、Run 历史、结构化阶段事件以及最终报告。页面按 10 秒周期更新，也可手动刷新；支持状态、Expert ID、Worker ID、任务 ID/仓库过滤与分页。

## 数据来源与接口

- `GET /admin/api/expert-tasks?limit=20&offset=0&status=running&expertId=ota&workerId=ota-worker-01`：管理员权限，返回分页的任务摘要，不包含模型报告正文。
- `GET /admin/api/expert-tasks/:id`：管理员权限，返回一个任务的状态/原始问题/报告、所有 Run（含 Worker 和 fencing）及最近最多 1000 条事件。
- Hub SQLite 共用 `EXPERT_RUNTIME_DB` 中的 `expert_tasks`、`expert_runs`、`expert_events`；旧数据库在初始化时自动追加 `expert_events.details` 字段和索引，不会删除旧事件。
- Worker 通过受身份认证的 gRPC `ReportTaskStage` 上报 `repository`、`container`、`codex` / `claude`、`execution` 阶段的 `started/completed/failed`。Hub 校验 `taskId + runId + workerId + fencing + 有效租约`，避免旧 Worker 写入新一轮 Run。
- Worker 运行时只上传**固定阶段标识与白名单错误代码**，不收集模型的原始 stdout/stderr、Token、Prompt、环境变量、Git 凭据或完整 Codex JSONL；原始报告仍通过现有任务成功结果机制存储。
- 每个 Run 的结构化事件限制在 200 条；管理员详情最多读取 1000 条。历史旧任务只有 `queued/running/succeeded/failed/lease_expired` 等生命周期事件，不会伪造执行阶段日志。

## 上线及回滚

Hub 与 Worker 都必须更新到支持 `ReportTaskStage` 的版本，才会看到完整阶段事件。**更新 Hub 本身不会使已经部署的旧 Worker 自动上报阶段。** 使用 `npm run build:worker-runtime` 重新制作独立 Worker Runtime，交付并升级 Worker 主机（见 [发布管理员手册](./release-worker-artifacts.md)）。旧 Worker 的原有 claim/heartbeat/complete/fail gRPC 路径仍然可用，但没有新增的阶段日志。

出现异常时在 Worker 主机用 `journalctl -u team-skill-hub-worker` 检查本地进程故障；Admin 中的结构化事件是跨主机诊断摘要，不替代主机级系统日志。执行阶段事件上报为 best-effort，网络抖动或 Hub 不可用时不应该改变任务成功与否。进行大规模部署前还应按组织数据保留政策制定任务和事件的历史归档/清理周期。
