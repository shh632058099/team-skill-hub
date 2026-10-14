# Team Skill Hub SQLite 存储迁移设计

> 状态：实现完成（Ubuntu-24.04 WSL2 + Docker 已完成 SQLite 切换验证）
> 创建时间：2026-10-13
> 目标：将当前以 JSONL 为主的运行观测存储逐步迁移到 SQLite，在不破坏现有 Admin/MCP API 的前提下解决高频写入、历史查询、索引分页、事务一致性和容量治理问题。
> 实施原则：**测试用例先行。任何存储实现、双写、读切换和旧数据迁移，都必须先有失败测试，再实现代码。**

## 1. 背景与现状

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

## 2. 数据库化边界

数据库不是为了替代 Git。

### 第一阶段进入 SQLite

- Client Hook / Client Event；
- MCP Call；
- Session projection；
- Candidate Detection；
- Reuse / Failure 查询；
- Observability retention / maintenance metadata。

### 第二阶段已纳入 SQLite

- Feedback；
- Knowledge Candidate（保留 append-only history 语义）；
- Knowledge Gap management（保留 append-only history 语义）；

### 后续可独立评估
- Repository runtime/governance 状态；
- Audit metadata；
- Managed API Key metadata。

### 继续由 Git / 文件作为 Source of Truth

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

## 3. 技术选择

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

## 4. 核心架构

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

## 5. SQLite 基础配置

建议：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

默认不在高频 maintenance 中执行完整 `VACUUM`。可评估 incremental vacuum，但必须以容量测试结果决定。

## 6. Schema migration

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

## 7. 第一阶段 Schema

### 7.1 client_events

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

### 7.2 mcp_calls

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

### 7.3 sessions projection

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

### 7.4 candidate_detections

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

## 8. JSON 字段原则

```text
需要筛选 / 排序 / join / index → 独立 column
只用于详情展示                → JSON TEXT
```

所有 JSON payload 必须继续复用当前 sanitization/redaction 逻辑，不能因迁移数据库而绕过安全处理。

## 9. 写入事务

### Hook

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

### MCP Call

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

## 10. 查询与分页

Session list 直接查询 `sessions`，不再每次扫描 Hook + MCP 聚合。

Session detail 精确使用：

```text
tenantId + actorId + sessionId
```

完整 timeline 不再受 current JSONL 最近 2000 条限制。

Reuse / Failure 从 `mcp_calls` 派生，不单独复制事实数据。

数据库读切换后逐步改 keyset pagination；底层迁移第一阶段先保持现有 API 兼容，分页协议变化单独做测试和上线。

## 11. Retention / 容量治理

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

## 12. Backup / Restore

WAL 模式下不把简单复制单个 `.sqlite3` 文件作为正式在线备份。

现有 `backup:data` 最终升级为：

```text
SQLite consistent backup
+ remaining DATA_DIR files
+ manifest
+ checksum
```

数据库损坏禁止 silent fallback 到新空库。

## 13. JSONL 历史迁移

提供 CLI，例如：

```bash
npm run migrate:observability
```

导入 current + archive；以稳定 record id 作为 primary key，保证重复执行幂等。

迁移结束后：

- 输出 source / valid / inserted / duplicate / invalid counts；
- 重建 Session projection；
- 抽样 Session 对比 JSONL 和 SQLite 的 eventCount、callCount、failedCallCount、evidenceCount、hasReuse、startedAt、endedAt、status。

## 14. Rollout

禁止一步切换。

### Phase 0：测试基线与 abstraction

只增加 storage interface、SQLite test harness、migration runner、schema、health primitive。线上仍 JSONL。

### Phase 1：dual write

```text
write = JSONL + SQLite
read  = JSONL
```

### Phase 2：shadow read

仍向用户返回 JSONL 结果，后台比较 SQLite 查询结果。

### Phase 3：Admin Observability 逐资源切 SQLite

顺序：Hook → MCP Call → Session → Reuse/Failure → Candidate Detection。每个资源有 rollback flag。

### Phase 4：JSONL current + archive import

导入旧历史并重建 Session。

### Phase 5：SQLite 主写

SQLite 成为在线 Source of Truth；JSONL 仅作为可选 cold export/archive。

### Phase 6：Candidate / Gap / Feedback 数据库化

等 Observability 稳定后再做。

## 15. 测试先行：强制门禁

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

## 16. 第一批必须先创建的测试

```text
tests/storage/sqlite-database.test.ts
tests/storage/schema-migrations.test.ts
tests/storage/sqlite-observability-repository.test.ts
tests/storage/sqlite-session-projection.test.ts
tests/storage/observability-parity.test.ts
```

### SQLite runtime tests

- 临时 DB 创建；
- WAL 生效；
- foreign_keys 生效；
- busy_timeout 生效；
- close/reopen 数据仍在；
- DB parent directory 自动创建；
- 实际 Node 24 / Docker 环境兼容。

### Migration runner tests

- fresh DB 0 → latest；
- migration 按顺序；
- migration 只执行一次；
- migration failure rollback；
- schema_migrations 正确；
- newer/unknown schema 拒绝启动；
- old schema upgrade 不丢数据。

### Transaction tests

- Hook insert + Session update 同事务；
- MCP insert + Session update 同事务；
- projection 更新失败时 facts 也 rollback；
- duplicate primary key 不造成 projection double count。

## 17. Observability 核心测试矩阵

### Client Event

- sanitized metadata；
- credential/source code 不落库；
- duplicate lifecycle natural key；
- actor/tenant/session 隔离；
- event/repository/from/to filter；
- inclusive time boundaries。

### MCP Call

- args/error 脱敏；
- success/failure；
- tool/actor/session/trace filter；
- duplicate id；
- reuse classification 与 `isReuseMcpTool()` 一致。

### Session projection

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

### Session rebuild

- projection 可从 facts 重建；
- rebuild 前后业务结果一致；
- rebuild 幂等；
- rebuild 不修改 facts；
- 10k / 100k 数据下内存有界。

## 18. Parity Test：读切换前硬门禁

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

## 19. Retention / 并发 / 容量测试

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

## 20. 故障测试

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

## 21. Backup / Restore 测试

修改现有 backup 代码之前先有：

- 写入期间备份一致；
- backup 后 integrity/quick check；
- restore 到空 DATA_DIR；
- restore overwrite protection 不退化；
- restored DB 可继续 migration；
- WAL 下不漏 committed transaction；
- manifest/hash 能检测篡改。

## 22. JSONL Import 测试

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

## 23. Feature Flags / 回滚

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

## 24. Admin / 运维可见性

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

## 25. PostgreSQL 演进边界

以下情况重新评估 PostgreSQL：

- 多副本；
- HA；
- Kubernetes 横向扩展；
- 几百到上千持续活跃开发者；
- 更长在线历史分析；
- 跨实例事务/队列需求。

Repository abstraction 应保证切换 PostgreSQL 时不重写 Admin/MCP 业务层。

## 26. 实施任务清单

### P0 - 测试基础设施

- [x] SQLite compatibility tests；
- [x] temporary DB fixture；
- [x] migration runner tests；
- [x] transaction rollback tests；
- [x] repository contract/parity harness；
- [x] Ubuntu-24.04 WSL2 + Docker Node 24 双环境验证。

### P1 - Storage foundation

- [x] `ObservabilityRepository`；
- [x] legacy JSONL repository adapter；
- [x] SQLite bootstrap；
- [x] migration 001；
- [x] DB health；
- [x] P0 全绿。

### P2 - SQLite write + projection

- [x] Client Event transaction；
- [x] MCP Call transaction；
- [x] Candidate Detection；
- [x] Session projection；
- [x] rebuildSessions；
- [x] sanitization/isolation/concurrency tests。

### P3 - Dual write / parity

- [x] dual-write flag；
- [x] write failure metrics；
- [x] parity fixture；
- [x] shadow read；
- [x] 30-user capacity SQLite run。

### P4 - Read cutover

- [x] Hook API；
- [x] MCP API；
- [x] Session API；
- [x] Reuse/Failure；
- [x] Candidate Detection；
- [x] Admin HTTP E2E；
- [x] rollback flag。

### P5 - Import / retention / backup

- [x] JSONL current + archive importer；
- [x] idempotent import tests；
- [x] retention worker；
- [x] storage metrics；
- [x] SQLite-aware backup/restore；
- [x] 100k / 1M benchmark。

### P6 - Stop JSONL realtime storage

- [x] production observation period（本地 Docker 切换/重启/在线查询已验证；生产环境继续按发布窗口观察）；
- [x] write backend 切 SQLite；
- [x] JSONL 仅 cold export；
- [x] 删除 append-every-time compact 主路径；
- [x] 更新运维/部署文档。

## 27. 每个 Phase 的 Definition of Done

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

## 28. 第一批实际开发顺序

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

## 29. 实施结果（2026-10-14）

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
