export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Skill Hub Admin</title>
<style>
:root{font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
body{margin:0}.wrap{max-width:1180px;margin:0 auto;padding:28px}.card{background:#fff;border:1px solid #e4e8f0;border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 4px 18px rgba(25,40,70,.05)}
h1{margin:0 0 6px}h2{font-size:18px}label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
input,textarea{box-sizing:border-box;width:100%;border:1px solid #ccd3df;border-radius:8px;padding:10px;font:inherit}textarea{min-height:380px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.actions{display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap}
button{border:0;border-radius:8px;padding:10px 16px;background:#2457d6;color:#fff;font-weight:700;cursor:pointer}.secondary{background:#edf1f8;color:#23324d}.danger{background:#b42318}.small{padding:6px 10px;font-size:12px}
.ok{color:#117a45}.error{color:#b42318}.muted{color:#667085;font-size:13px}code{background:#eef2f7;padding:2px 5px;border-radius:4px}.key-list{display:grid;gap:10px;margin-top:14px}.key-row{border:1px solid #e4e8f0;border-radius:10px;padding:12px}.key-row-top{display:flex;justify-content:space-between;gap:12px;align-items:center}.key-meta{font-size:13px;color:#667085;margin-top:6px}.one-time{display:none;margin-top:14px;padding:14px;border:1px solid #a6c8ff;background:#f1f7ff;border-radius:10px}.one-time input{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.knowledge-sources{display:grid;grid-template-columns:1fr;gap:10px;margin-top:12px}.knowledge-source,.knowledge-result{border:1px solid #e4e8f0;border-radius:10px;padding:12px}.knowledge-result{margin-top:10px}.knowledge-content{white-space:pre-wrap;max-height:180px;overflow:auto;margin-top:8px;font-size:13px;background:#f8fafc;padding:10px;border-radius:8px}.knowledge-config-grid{display:grid;grid-template-columns:2fr 2fr 1fr 1fr 1fr;gap:10px;align-items:end;margin-top:10px}.inline-check{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}.inline-check input{width:auto}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tab{background:#fff;color:#334155;border:1px solid #d9e0ea;padding:8px 12px}.tab.active{background:#172033;color:#fff;border-color:#172033}.view{display:none}.view.active{display:block}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{background:#fff;border:1px solid #e4e8f0;border-radius:12px;padding:16px}.stat-value{font-size:26px;font-weight:800;margin-top:4px}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:10px;border-bottom:1px solid #edf0f5;vertical-align:top}.badge{display:inline-block;padding:3px 8px;border-radius:999px;background:#eef2f7;font-size:12px}.badge.ok{background:#e7f7ef}.badge.error{background:#fff0ee}.review-card{border:1px solid #e4e8f0;border-radius:12px;padding:14px;margin:10px 0}.review-content{white-space:pre-wrap;max-height:220px;overflow:auto;background:#f8fafc;padding:10px;border-radius:8px;margin-top:8px}.candidate-editor{display:grid;grid-template-columns:2fr 1fr 2fr;gap:10px;margin-top:10px}.candidate-editor textarea{grid-column:1/-1;min-height:140px}.trace-detail{margin-top:12px;padding:12px;background:#f8fafc;border-radius:10px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;max-height:320px;overflow:auto}.link{color:#2457d6;text-decoration:none;font-weight:600}@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.knowledge-config-grid{grid-template-columns:1fr 1fr}}@media(max-width:760px){.grid,.stats{grid-template-columns:1fr}.wrap{padding:14px}.knowledge-config-grid{grid-template-columns:1fr}}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.46);display:none;align-items:center;justify-content:center;padding:20px;z-index:1000}.modal-backdrop.open{display:flex}.modal-panel{width:min(520px,100%);max-height:85vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 24px 80px rgba(15,23,42,.25);padding:20px}.modal-panel h3{margin:0 0 8px}.modal-message{white-space:pre-wrap;color:#475467;font-size:14px;margin-bottom:12px}.modal-fields{display:grid;gap:10px}.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.toast-stack{position:fixed;right:20px;bottom:20px;display:grid;gap:10px;z-index:1100;max-width:min(420px,calc(100vw - 40px))}.toast{background:#172033;color:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 12px 30px rgba(15,23,42,.18);font-size:13px}.toast.error{background:#b42318;color:#fff}.toast.ok{background:#117a45;color:#fff}button:disabled{cursor:not-allowed;opacity:.55}
.trend-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.trend-card{border:1px solid #e4e8f0;border-radius:12px;padding:14px;min-width:0}.trend-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.trend-title{font-size:13px;font-weight:700}.trend-value{font-size:22px;font-weight:800}.trend-meta{font-size:11px;color:#667085;margin-top:3px}.trend-svg{display:block;width:100%;height:72px;margin-top:8px;overflow:visible}.trend-empty{height:72px;display:flex;align-items:center;color:#98a2b3;font-size:12px}@media(max-width:900px){.trend-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.trend-grid{grid-template-columns:1fr}}
</style>
</head>
<body><div class="wrap">
<h1>Team Skill Hub</h1><div class="muted">AI 工程中台 · Skill / Knowledge / MCP Observability</div>
<div class="tabs"><button class="tab active" data-tab="dashboard">Dashboard</button><button class="tab" data-tab="observability">Observability</button><button class="tab" data-tab="knowledge">Knowledge</button><button class="tab" data-tab="tools">Tools</button><button class="tab" data-tab="governance">Governance</button><button class="tab" data-tab="evaluation">Evaluation</button><button class="tab" data-tab="review">Review Inbox</button><button class="tab" data-tab="feedback">Feedback</button><button class="tab" data-tab="gaps">Knowledge Gaps</button><button class="tab" data-tab="access">Access</button><button class="tab" data-tab="settings">Settings</button></div>
<div class="view active" data-view="dashboard"><div class="stats"><div class="stat"><div class="muted">MCP Calls</div><div class="stat-value" id="statCalls">-</div></div><div class="stat"><div class="muted">Failures</div><div class="stat-value" id="statFailures">-</div></div><div class="stat"><div class="muted">Avg Latency</div><div class="stat-value" id="statLatency">-</div></div><div class="stat"><div class="muted">Pending Review</div><div class="stat-value" id="statPending">-</div></div><div class="stat"><div class="muted">Active Users</div><div class="stat-value" id="statActiveUsers">-</div></div><div class="stat"><div class="muted">Sessions</div><div class="stat-value" id="statSessions">-</div></div><div class="stat"><div class="muted">No-hit Rate</div><div class="stat-value" id="statNoHit">-</div></div><div class="stat"><div class="muted">Approval Rate</div><div class="stat-value" id="statApproval">-</div></div><div class="stat"><div class="muted">Auto Candidates</div><div class="stat-value" id="statAutoCandidates">-</div></div><div class="stat"><div class="muted">Published</div><div class="stat-value" id="statPublished">-</div></div><div class="stat"><div class="muted">Detector Created</div><div class="stat-value" id="statDetectorCreated">-</div></div><div class="stat"><div class="muted">Detector Skipped</div><div class="stat-value" id="statDetectorSkipped">-</div></div><div class="stat"><div class="muted">Auto Accept Rate</div><div class="stat-value" id="statAutoAccept">-</div></div><div class="stat"><div class="muted">Auto Reject Rate</div><div class="stat-value" id="statAutoReject">-</div></div><div class="stat"><div class="muted">Quality Labels</div><div class="stat-value" id="statQualityCoverage">-</div></div><div class="stat"><div class="muted">Useful Rate</div><div class="stat-value" id="statUsefulRate">-</div></div><div class="stat"><div class="muted">False-positive Rate</div><div class="stat-value" id="statFalsePositiveRate">-</div></div><div class="stat"><div class="muted">Duplicate Filtered</div><div class="stat-value" id="statDuplicateFiltered">-</div></div><div class="stat"><div class="muted">Low-value Filtered</div><div class="stat-value" id="statLowValueFiltered">-</div></div><div class="stat"><div class="muted">P95 Latency</div><div class="stat-value" id="statP95Latency">-</div></div><div class="stat"><div class="muted">MCP Error Rate</div><div class="stat-value" id="statMcpErrorRate">-</div></div><div class="stat"><div class="muted">Negative Feedback</div><div class="stat-value" id="statNegativeFeedback">-</div></div><div class="stat"><div class="muted">Calls / Session</div><div class="stat-value" id="statCallsPerSession">-</div></div><div class="stat"><div class="muted">Evidence / Session</div><div class="stat-value" id="statEvidencePerSession">-</div></div><div class="stat"><div class="muted">Auto Candidates / Session</div><div class="stat-value" id="statCandidatesPerSession">-</div></div><div class="stat"><div class="muted">MR Merge Rate</div><div class="stat-value" id="statMrMergeRate">-</div></div><div class="stat"><div class="muted">Stale Knowledge</div><div class="stat-value" id="statStaleKnowledge">-</div></div></div></div>
<div class="view active" data-view="dashboard"><div class="card"><h2>Active Alerts</h2><div id="alertSummary" class="key-meta">加载中...</div><div id="alertList"></div></div></div>
<div class="view active" data-view="dashboard"><div class="card"><h2>Repository Governance</h2><div id="repositoryGovernanceSummary" class="key-meta">加载中...</div><div class="table-wrap"><table class="table"><thead><tr><th>Repository</th><th>Owners</th><th>Status</th><th>Last Success</th><th>Sync Lag</th><th>Last Good Revision</th><th>Webhook</th><th>Issues</th></tr></thead><tbody id="repositoryGovernanceTable"></tbody></table></div></div></div>
<div class="view active" data-view="dashboard"><div class="card"><div class="actions" style="justify-content:space-between"><div><h2 style="margin:0">14-Day Trends</h2><div class="muted">Calls / Errors / No-hit / Candidates / Approval / Gaps / Active Users / Latency</div></div><button id="reloadDashboardTrends" class="secondary small">刷新趋势</button></div><div id="trendCharts" class="trend-grid" style="margin-top:14px"></div><div id="trendStatus" class="key-meta"></div></div></div>
<div class="view" data-view="access">
<div class="card">
<h2>管理员认证</h2>
<label>Admin API Key</label><input id="key" type="password" autocomplete="current-password" placeholder="ADMIN_API_KEY">
<div class="muted">Key 仅保存在当前浏览器 sessionStorage，不会写入服务端配置文件。</div>
</div>
</div>
<div class="view" data-view="settings">
<div class="card">
<h2>运行参数</h2>
<div class="grid">
<div><label>Revision Retention</label><input id="retention" type="number" min="2"></div>
<div><label>Webhook Dedup Entries</label><input id="dedupEntries" type="number" min="100"></div>
<div><label>Webhook Dedup TTL (s)</label><input id="dedupTtl" type="number" min="3600"></div>
</div>
<label>Default Roles（逗号分隔）</label><input id="roles">
</div>
</div>
<div class="view" data-view="access">
<div class="card">
<h2>用户 API Keys</h2>
<div class="muted">用于 Codex / Claude Code 等客户端连接 MCP。新 Key 明文只显示一次，服务端仅保存哈希。</div>
<div class="grid">
<div><label>名称</label><input id="apiLabel" placeholder="例如：biao-codex"></div>
<div><label>User ID</label><input id="apiUserId" placeholder="例如：biao"></div>
<div><label>Tenant</label><input id="apiTenant" value="default"></div>
</div>
<label>Roles（逗号分隔）</label><input id="apiRoles" value="developer, internal">
<div class="actions"><button id="createApiKey">创建 API Key</button><span id="apiKeyStatus"></span></div>
<div id="oneTimeKey" class="one-time">
<div><b>请立即复制这个 Key，关闭或刷新后将无法再次查看：</b></div>
<div class="actions"><input id="newApiKey" readonly><button id="copyApiKey" class="secondary">复制</button></div>
</div>
<div id="apiKeys" class="key-list"></div>
</div>
</div>
<div class="view" data-view="knowledge">
<div class="card">
<h2>Knowledge / RAG</h2>
<div class="muted">查看当前已索引知识源，并直接测试 FTS5 检索效果。</div>
<div id="knowledgeSources" class="knowledge-sources"></div>
<div class="grid">
<div style="grid-column:span 2"><label>搜索问题</label><input id="knowledgeQuery" placeholder="例如：OTA 升级断电后如何恢复？"></div>
<div><label>Repository（可选）</label><input id="knowledgeRepo" placeholder="rd-skills"></div>
</div>
<div class="actions"><button id="searchKnowledge">测试检索</button><button id="reloadKnowledge" class="secondary">刷新索引状态</button><span id="knowledgeStatus"></span></div>
<div id="knowledgeResults"></div>
<h3>Lifecycle Audit</h3><div class="muted">提示维护风险；deprecated / superseded / expired / archived 默认不参与正常搜索，draft 会降权。风险项可生成 pending Review Candidate。</div><div id="knowledgeAuditSummary" class="key-meta"></div><div class="table-wrap"><table class="table"><thead><tr><th>Risk</th><th>Repository</th><th>Path</th><th>Owner</th><th>Status</th><th>Last Reviewed</th><th>Review Cycle</th><th>Review Due</th><th>Valid Until</th><th>Action</th></tr></thead><tbody id="knowledgeAuditTable"></tbody></table></div>
</div>
</div>
<div class="view" data-view="tools"><div class="card"><h2>Tool Registry</h2><div class="muted">Git 管理的工具元数据；只展示 credential reference，不保存或展示凭据值。</div><div class="grid"><div style="grid-column:span 2"><label>搜索</label><input id="toolQuery" placeholder="例如：git / jenkins / test farm"></div><div><label>Client（可选）</label><input id="toolClient" placeholder="codex"></div></div><div class="actions"><button id="searchTools">搜索 Tools</button><button id="reloadTools" class="secondary">全部</button><span id="toolStatus"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>Tool</th><th>Repository</th><th>Type</th><th>Capabilities</th><th>Environments</th><th>Permissions</th><th>Endpoints</th><th>Auth Reference</th><th>Owner</th></tr></thead><tbody id="toolsTable"></tbody></table></div></div></div>
<div class="view" data-view="governance"><div class="card"><h2>Artifact Governance</h2><div class="muted">Skill / Prompt / Agent 的 owner、版本、兼容性、usage、feedback、evaluation coverage 与治理问题。</div><div id="artifactGovernanceSummary" class="key-meta">加载中...</div><h3>Skills</h3><div class="table-wrap"><table class="table"><thead><tr><th>Skill</th><th>Owner</th><th>Version</th><th>Status</th><th>Usage</th><th>Feedback + / -</th><th>Eval Cases</th><th>Compatibility</th><th>Issues</th></tr></thead><tbody id="skillGovernanceTable"></tbody></table></div><h3>Prompts</h3><div class="table-wrap"><table class="table"><thead><tr><th>Prompt</th><th>Owner</th><th>Version</th><th>Usage</th><th>Feedback + / -</th><th>Eval Cases</th><th>Compatibility</th><th>Issues</th></tr></thead><tbody id="promptGovernanceTable"></tbody></table></div><h3>Agents</h3><div class="table-wrap"><table class="table"><thead><tr><th>Agent</th><th>Owner</th><th>Version</th><th>Usage</th><th>Feedback + / -</th><th>Eval Cases</th><th>Capabilities</th><th>Tool Ready</th><th>Compatibility</th><th>Issues</th></tr></thead><tbody id="agentGovernanceTable"></tbody></table></div><h2>Skill / Knowledge Quality Metrics</h2><div class="muted">仅治理观察，不自动删除内容。Search Rank 当前以 top-1 selection 次数作为可观测代理。</div><div id="contentQualitySummary" class="key-meta">加载中...</div><h3>Skill Quality</h3><div class="table-wrap"><table class="table"><thead><tr><th>Skill</th><th>Status</th><th>Search Top1</th><th>Reuse</th><th>Reuse Rate</th><th>Last Use</th><th>Feedback + / -</th><th>Candidate Updates</th><th>Stale</th></tr></thead><tbody id="skillQualityTable"></tbody></table></div><h3>Knowledge Quality</h3><div class="table-wrap"><table class="table"><thead><tr><th>Knowledge</th><th>Status</th><th>Search Top1</th><th>Reuse</th><th>Reuse Rate</th><th>Last Use</th><th>Feedback + / -</th><th>Review Age / Cycle</th><th>Candidate Updates</th><th>Stale</th></tr></thead><tbody id="knowledgeQualityTable"></tbody></table></div></div></div>
<div class="view" data-view="evaluation"><div class="card"><h2>Evaluation</h2><div class="muted">运行仓库内 EVALUATION.yaml，查看历史结果、Retrieval Hit@K/MRR 与 baseline regression。</div><div class="grid"><div><label>Repository</label><input id="evaluationRepo" placeholder="rd-skills"></div><div><label>Revision（可选）</label><input id="evaluationRevision" placeholder="当前 active revision"></div><div><label>Baseline Revision（可选）</label><input id="evaluationBaseline" placeholder="例如上一稳定 revision"></div><div><label>Suite</label><select id="evaluationSuite"><option value="">先加载 Suites</option></select></div></div><div class="actions"><button id="loadEvaluationSuites" class="secondary">加载 Suites</button><button id="runEvaluation">运行 Evaluation</button><button id="reloadEvaluationRuns" class="secondary">刷新历史</button><label><input id="evaluationFailedOnly" type="checkbox"> 仅失败/回归</label><span id="evaluationStatus"></span></div><div id="evaluationTrend" class="key-meta"></div><div id="evaluationDetail" class="trace-detail" style="display:none"></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>Repository</th><th>Suite</th><th>Revision</th><th>Pass</th><th>Regression</th><th>Retrieval</th></tr></thead><tbody id="evaluationRunsTable"></tbody></table></div></div></div>
<div class="view" data-view="observability"><div class="card"><h2>MCP Observability</h2><div class="actions"><button id="reloadObservability" class="secondary">刷新</button><span id="observabilityStatus"></span></div><div id="operationalHealth" class="review-content">Operational Health 加载中...</div><h3>Session Analytics</h3><div id="sessionAnalytics" class="stats"></div><div id="sessionAnalyticsMeta" class="key-meta"></div><h3>Codex Sessions</h3><div class="grid"><div><label>User</label><input id="sessionFilterUser" placeholder="user id"></div><div><label>Repository</label><input id="sessionFilterRepo" placeholder="rd-skills"></div><div><label>Event</label><select id="sessionFilterEvent"><option value="">全部 Event</option><option>SessionStart</option><option>UserPromptSubmit</option><option>PostToolUse</option><option>Stop</option><option>SessionEnd</option></select></div><div><label>Runtime</label><select id="sessionFilterRuntime"><option value="">全部 Runtime</option><option>current</option><option>outdated</option><option>unknown</option></select></div><div><label>From</label><input id="sessionFilterFrom" type="datetime-local"></div><div><label>To</label><input id="sessionFilterTo" type="datetime-local"></div></div><div class="actions"><button id="applySessionFilters" class="secondary">应用 Session 筛选</button><button id="clearSessionFilters" class="secondary">清除</button></div><div class="table-wrap"><table class="table"><thead><tr><th>开始</th><th>User</th><th>Session</th><th>Project</th><th>Runtime</th><th>Events</th><th>MCP Calls</th><th>Evidence</th><th>Tools</th><th>Status</th></tr></thead><tbody id="sessionsTable"></tbody></table></div><div id="sessionDetail" class="trace-detail" style="display:none"></div><h3>Client Hook Events</h3><div class="actions"><input id="clientEventSearch" placeholder="搜索 Event / User / Session / Metadata"><button id="clientEventSearchButton" class="secondary">搜索</button><button id="clientEventPrev" class="secondary">上一页</button><button id="clientEventNext" class="secondary">下一页</button><span id="clientEventPage" class="muted"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>Event</th><th>User</th><th>Session</th><th>Model</th><th>Metadata</th></tr></thead><tbody id="clientEventsTable"></tbody></table></div><h3>Auto Candidate Decisions</h3><div class="actions"><input id="detectionSearch" placeholder="搜索 Outcome / Reason / User / Session"><button id="detectionSearchButton" class="secondary">搜索</button><button id="detectionPrev" class="secondary">上一页</button><button id="detectionNext" class="secondary">下一页</button><span id="detectionPage" class="muted"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>Outcome</th><th>Reason</th><th>User</th><th>Session</th><th>Evidence</th></tr></thead><tbody id="candidateDetectionsTable"></tbody></table></div><h3>Auto Candidate Quality Trend</h3><div class="actions"><label>窗口天数 <input id="qualityWindowDays" type="number" min="1" max="90" value="7" style="width:90px"></label><button id="reloadQuality" class="secondary">刷新质量趋势</button><span id="qualityStatus"></span></div><div id="qualitySummary" class="key-meta"></div><div class="table-wrap"><table class="table"><thead><tr><th>Detector</th><th>Current Created</th><th>Baseline Created</th><th>Useful</th><th>Baseline Useful</th><th>False Positive</th><th>Baseline FP</th><th>Labels</th></tr></thead><tbody id="qualityDetectorTable"></tbody></table></div><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Created</th><th>Skipped</th><th>Reviewed</th><th>Labels</th><th>Useful</th><th>False Positive</th><th>Duplicate</th><th>Low-value</th></tr></thead><tbody id="qualityTrendTable"></tbody></table></div><h3>Recent Traces</h3><div class="table-wrap"><table class="table"><thead><tr><th>开始</th><th>User</th><th>Calls</th><th>Tools</th><th>Latency</th><th>Result</th></tr></thead><tbody id="tracesTable"></tbody></table></div><div id="traceDetail" class="trace-detail" style="display:none"></div><h3>Recent Calls</h3><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>Tool</th><th>User</th><th>Trace</th><th>Latency</th><th>Result</th></tr></thead><tbody id="callsTable"></tbody></table></div></div></div>
<div class="view" data-view="review"><div class="card"><h2>Knowledge Review Inbox</h2><div class="muted">编辑候选内容后审核；Approved 后可创建 GitLab MR，Merge 后由正常 Repository Sync/RAG 流程生效。</div><div class="actions"><select id="candidateFilterStatus"><option value="">全部状态</option><option>pending</option><option>approved</option><option>rejected</option><option>publish_failed</option><option>published</option></select><input id="candidateFilterRepo" placeholder="Repository 筛选"><input id="candidateFilterSource" placeholder="SourceType，例如 codex-summary"><input id="candidateFilterReviewer" placeholder="Reviewer 筛选"><select id="candidateFilterAuto"><option value="">全部来源</option><option value="true">自动候选</option><option value="false">手工候选</option></select><input id="candidateFilterQ" placeholder="搜索标题 / 正文 / ID"><button id="applyCandidateFilters" class="secondary">筛选</button><button id="candidatePrev" class="secondary">上一页</button><button id="candidateNext" class="secondary">下一页</button><span id="candidatePage" class="muted"></span></div><div class="actions"><button id="bulkApproveCandidates" class="secondary">批量批准已选</button><button id="bulkRejectCandidates" class="danger">批量拒绝已选</button><span id="bulkCandidateStatus" class="muted"></span></div><div class="candidate-editor"><input id="manualCandidateTitle" placeholder="候选标题"><input id="manualCandidateRepo" placeholder="Repository"><input id="manualCandidatePath" placeholder="docs/knowledge/topic.md"><textarea id="manualCandidateContent" placeholder="候选知识正文"></textarea></div><div class="actions"><button id="createManualCandidate">新增候选</button><span id="candidateStatus"></span></div><div id="candidateHistory" class="trace-detail" style="display:none"></div><div id="candidateList"></div></div></div>
<div class="view" data-view="feedback"><div class="card"><h2>Feedback</h2><div class="muted">查看客户端通过 submit_feedback 回流的正/负反馈。</div><div class="actions"><input id="feedbackSearch" placeholder="搜索 User / Rating / Target / Reason"><button id="feedbackSearchButton" class="secondary">搜索</button><button id="feedbackPrev" class="secondary">上一页</button><button id="feedbackNext" class="secondary">下一页</button><span id="feedbackPage" class="muted"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>User</th><th>Rating</th><th>Target</th><th>Reason</th><th>Trace</th></tr></thead><tbody id="feedbackTable"></tbody></table></div></div></div>
<div class="view" data-view="gaps"><div class="card"><h2>Knowledge Gaps</h2><div class="muted">基于未命中查询与负反馈做 deterministic 聚类；可创建 pending Candidate 进入 Review Inbox。可选 LLM Curator 只提供聚类建议，不自动写入。</div><div class="actions"><button id="curateGaps" class="secondary">AI 聚类建议</button><span id="curatorStatus" class="muted">需配置 KNOWLEDGE_CURATOR_URL</span></div><div class="table-wrap"><table class="table"><thead><tr><th>问题/反馈</th><th>次数</th><th>来源</th><th>成员</th><th>最近</th><th>动作</th></tr></thead><tbody id="gapsTable"></tbody></table></div></div></div>
<div class="view" data-view="settings">
<div class="card">
<h2>Repositories</h2>
<div class="muted">编辑仓库运行配置。Git 密钥/Token 推荐继续使用环境变量或 Docker Secret；这里保存的是引用和非敏感配置。</div>
<label>Repository JSON</label><textarea id="repos"></textarea>
<label>Project Registry JSON</label><textarea id="projects"></textarea>
<div class="actions"><button id="save">保存并立即应用</button><button id="reload" class="secondary">重新加载</button><span id="status"></span></div>
</div>
<div class="card">
<h2>Bootstrap / Secrets</h2><div id="bootstrap" class="muted">加载中...</div>
</div>
<div class="card"><h2>Data Governance</h2><div class="muted">本地安全上限：敏感原文类别默认不采集、不持久化；这里只读展示当前策略。</div><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Collect</th><th>Persist</th><th>Retention</th><th>Access</th><th>Audit</th></tr></thead><tbody id="dataGovernanceTable"></tbody></table></div><div id="dataGovernanceInvariants" class="key-meta"></div></div>
</div>
</div>
<div id="adminModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="adminModalTitle"><div class="modal-panel"><h3 id="adminModalTitle"></h3><div id="adminModalMessage" class="modal-message"></div><div id="adminModalFields" class="modal-fields"></div><div class="modal-actions"><button id="adminModalCancel" class="secondary">取消</button><button id="adminModalConfirm">确认</button></div></div></div><div id="toastStack" class="toast-stack" aria-live="polite"></div>
<script>
const key = document.getElementById("key");
key.value = sessionStorage.getItem("skillHubAdminKey") || "";
key.addEventListener("change",()=>sessionStorage.setItem("skillHubAdminKey",key.value));
const statusEl=document.getElementById("status");
const apiKeyStatus=document.getElementById("apiKeyStatus");
const knowledgeStatus=document.getElementById("knowledgeStatus");
const observabilityStatus=document.getElementById("observabilityStatus");
const evaluationStatus=document.getElementById("evaluationStatus");
const selectedCandidates=new Set();
function toast(message,type="ok",duration=3200){
 const stack=document.getElementById("toastStack");const el=document.createElement("div");el.className="toast "+type;el.textContent=String(message);stack.appendChild(el);setTimeout(()=>el.remove(),duration);
}
async function modalForm(options){
 const root=document.getElementById("adminModal");const title=document.getElementById("adminModalTitle");const message=document.getElementById("adminModalMessage");const fields=document.getElementById("adminModalFields");const cancel=document.getElementById("adminModalCancel");const confirm=document.getElementById("adminModalConfirm");
 title.textContent=options.title||"确认";message.textContent=options.message||"";fields.replaceChildren();confirm.textContent=options.confirmText||"确认";confirm.className=options.danger?"danger":"";
 const inputs={};for(const field of options.fields||[]){const wrap=document.createElement("div");const label=document.createElement("label");label.textContent=field.label;let input;if(field.type==="select"){input=document.createElement("select");for(const value of field.options||[]){const option=document.createElement("option");option.value=value;option.textContent=value;input.appendChild(option)}}else{input=document.createElement(field.type==="textarea"?"textarea":"input");if(field.placeholder)input.placeholder=field.placeholder}input.value=field.value||"";wrap.append(label,input);fields.appendChild(wrap);inputs[field.name]=input}
 root.classList.add("open");return await new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;root.classList.remove("open");cancel.onclick=null;confirm.onclick=null;root.onclick=null;document.removeEventListener("keydown",onKey);resolve(value)};const onKey=e=>{if(e.key==="Escape")finish(null)};document.addEventListener("keydown",onKey);cancel.onclick=()=>finish(null);root.onclick=e=>{if(e.target===root)finish(null)};confirm.onclick=()=>{const result={};for(const [name,input] of Object.entries(inputs))result[name]=input.value;finish(result)}})
}
async function withBusy(button,work,label="处理中..."){
 if(!button)return await work();const old=button.textContent;button.disabled=true;button.textContent=label;try{return await work()}finally{button.disabled=false;button.textContent=old}
}
const pageState={events:{},detections:{},candidates:{},feedback:{}};
function replaceRouteQuery(patch){
 const route=parseAdminRoute();const params=route.params;
 for(const [name,value] of Object.entries(patch)){if(value===undefined||value===null||value==="")params.delete(name);else params.set(name,String(value))}
 const next="#"+route.tab+(params.toString()?"?"+params.toString():"");history.replaceState(null,"",next);
}
function renderPager(prefix,page,stateKey){
 pageState[stateKey]=page||{};const el=document.getElementById(prefix+"Page");const prev=document.getElementById(prefix+"Prev");const next=document.getElementById(prefix+"Next");
 if(el)el.textContent=page?"共 "+page.total+" 条 · offset "+page.cursor:"";
 if(prev)prev.disabled=!page?.previousCursor;if(next)next.disabled=!page?.nextCursor;
}
function parseAdminRoute(){
 const raw=(location.hash||"#dashboard").slice(1);const [tabRaw,query=""]=raw.split("?",2);
 const valid=new Set([...document.querySelectorAll(".tab")].map(x=>x.dataset.tab));const tab=valid.has(tabRaw)?tabRaw:"dashboard";
 return {tab,params:new URLSearchParams(query)};
}
function routeHash(tab,params={}){
 const query=new URLSearchParams();for(const [name,value] of Object.entries(params))if(value)query.set(name,String(value));
 return "#"+tab+(query.toString()?"?"+query.toString():"");
}
function navigateTo(tab,params={},replace=false){
 const next=routeHash(tab,params);if(location.hash===next){applyAdminRoute();return}
 if(replace)history.replaceState(null,"",next);else history.pushState(null,"",next);applyAdminRoute();
}
function activateTab(name,params=new URLSearchParams()){
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===name));
  document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.dataset.view===name));
  if(name==="dashboard")loadDashboardTrends();
  if(name==="observability"){document.getElementById("clientEventSearch").value=params.get("eventQ")||"";document.getElementById("detectionSearch").value=params.get("detectionQ")||"";loadObservability(params.get("session")||undefined,params.get("actor")||undefined,params.get("tenant")||undefined);}
 if(name==="tools")loadTools();
 if(name==="governance")loadArtifactGovernance();
 if(name==="evaluation")loadEvaluationRuns();
 if(name==="review"){document.getElementById("candidateFilterStatus").value=params.get("candidateStatus")||"";document.getElementById("candidateFilterRepo").value=params.get("candidateRepo")||"";document.getElementById("candidateFilterSource").value=params.get("candidateSource")||"";document.getElementById("candidateFilterReviewer").value=params.get("candidateReviewer")||"";document.getElementById("candidateFilterAuto").value=params.get("candidateAuto")||"";document.getElementById("candidateFilterQ").value=params.get("candidateQ")||"";loadCandidates(params.get("candidate")||undefined);}
 if(name==="feedback"){document.getElementById("feedbackSearch").value=params.get("feedbackQ")||"";loadFeedback();}
 if(name==="gaps")loadGaps();
}
function applyAdminRoute(){const route=parseAdminRoute();activateTab(route.tab,route.params)}
window.addEventListener("popstate",applyAdminRoute);
window.addEventListener("hashchange",applyAdminRoute);
document.querySelectorAll(".tab").forEach(x=>x.onclick=()=>navigateTo(x.dataset.tab));
function fmtTime(ts){try{return new Date(ts).toLocaleString()}catch{return ts}}
async function loadTools(search){
 const params=new URLSearchParams();const q=(search===false?"":document.getElementById("toolQuery").value.trim());const client=document.getElementById("toolClient").value.trim();if(q)params.set("q",q);if(client)params.set("client",client);params.set("limit","200");
 const status=document.getElementById("toolStatus");status.textContent="加载中...";
 const r=await fetch("/admin/api/tools?"+params.toString(),{headers:headers()});const data=await r.json();
 if(!r.ok){status.textContent=data.error||"加载失败";status.className="error";return}
 const body=document.getElementById("toolsTable");body.replaceChildren();
 for(const item of data.tools){const row=document.createElement("tr");const auth=item.authentication?(item.authentication.type+(item.authentication.reference?" · "+item.authentication.reference:"")):"-";const endpoints=Object.entries(item.endpoints||{}).map(([env,url])=>env+"="+url).join(" · ");[item.name,item.repositoryId,item.type,(item.capabilities||[]).join(", "),(item.environments||[]).join(", "),(item.permissions||[]).join(", "),endpoints,auth,item.owner].forEach(v=>{const td=document.createElement("td");td.textContent=String(v||"-");row.appendChild(td)});body.appendChild(row)}
 status.textContent="共 "+data.tools.length+" 个 Tool";status.className="ok";
}
async function loadArtifactGovernance(){
 const summary=document.getElementById("artifactGovernanceSummary");const r=await fetch("/admin/api/artifact-governance",{headers:headers()});const data=await r.json();
 if(!r.ok){summary.textContent=data.error||"Artifact Governance 加载失败";summary.className="error key-meta";return}
 summary.textContent="Skills "+data.summary.skills+" · Prompts "+data.summary.prompts+" · Agents "+data.summary.agents+" · issues "+data.summary.issues+" · deprecated skills "+data.summary.deprecatedSkills+" · missing version "+data.summary.missingVersion+" · duplicate names "+data.summary.duplicateNames+" · unresolved agent tools "+data.summary.unresolvedAgentTools;summary.className="key-meta";
 const compatibility=value=>Object.entries(value||{}).map(([k,v])=>k+"="+v).join(", ")||"-";
 const feedback=value=>(value?.positive||0)+" / "+(value?.negative||0);
 const issues=value=>(value||[]).join(", ")||"OK";
 const fill=(id,items,mapper)=>{const body=document.getElementById(id);body.replaceChildren();for(const item of items){const row=document.createElement("tr");mapper(item).forEach((value,index)=>{const td=document.createElement("td");td.textContent=String(value??"-");if(index===mapper(item).length-1)td.className=item.issues?.length?"error":"ok";row.appendChild(td)});body.appendChild(row)}};
 fill("skillGovernanceTable",data.skills,item=>[item.repositoryId+":"+item.name,item.owner,item.version||"-",item.status,item.usage,feedback(item.feedback),item.evaluationCases,compatibility(item.compatibility),issues(item.issues)]);
 fill("promptGovernanceTable",data.prompts,item=>[item.repositoryId+":"+item.name,item.owner,item.version||"-",item.usage,feedback(item.feedback),item.evaluationCases,compatibility(item.compatibility),issues(item.issues)]);
 fill("agentGovernanceTable",data.agents,item=>[item.repositoryId+":"+item.name,item.owner,item.version||"-",item.usage,feedback(item.feedback),item.evaluationCases,"skills "+item.capabilities.skills.length+" / prompts "+item.capabilities.prompts.length+" / tools "+item.capabilities.tools.length,item.toolBindingsReady?"YES":"NO",compatibility(item.compatibility),issues(item.issues)]);
 const qr=await fetch("/admin/api/content-quality",{headers:headers()});const quality=await qr.json();const qsummary=document.getElementById("contentQualitySummary");
 if(!qr.ok){qsummary.textContent=quality.error||"Content Quality 加载失败";qsummary.className="error key-meta";return}
 qsummary.textContent="Skills "+quality.summary.skills+" · Knowledge "+quality.summary.knowledge+" · stale skills "+quality.summary.staleSkills+" · stale knowledge "+quality.summary.staleKnowledge+" · review overdue "+quality.summary.reviewOverdue+" · feedback +"+quality.summary.positiveFeedback+" / -"+quality.summary.negativeFeedback;
 const rate=value=>Math.round((value||0)*100)+"%";const lastUse=value=>value?.lastUsedAt?fmtTime(value.lastUsedAt)+(value.daysSinceLastUse!==undefined?" · "+value.daysSinceLastUse+"d":""):"never";
 const skillQuality=document.getElementById("skillQualityTable");skillQuality.replaceChildren();for(const item of quality.skills){const row=document.createElement("tr");[item.repositoryId+":"+item.name,item.status,item.usage.searchTop1,item.usage.reuse,rate(item.usage.reuseRate),lastUse(item.usage),(item.feedback.positive||0)+" / "+(item.feedback.negative||0),item.candidateUpdateCount,item.staleByUsage?"YES":"NO"].forEach((value,index)=>{const td=document.createElement("td");td.textContent=String(value);if(index===8)td.className=item.staleByUsage?"error":"ok";row.appendChild(td)});skillQuality.appendChild(row)}
 const knowledgeQuality=document.getElementById("knowledgeQualityTable");knowledgeQuality.replaceChildren();for(const item of quality.knowledge){const row=document.createElement("tr");const review=item.reviewFreshness.reviewAgeDays===undefined?"-":item.reviewFreshness.reviewAgeDays+"d / "+(item.reviewFreshness.reviewCycleDays??"-")+"d"+(item.reviewFreshness.overdue?" OVERDUE":"");[item.repositoryId+":"+item.path,item.status,item.usage.searchTop1,item.usage.reuse,rate(item.usage.reuseRate),lastUse(item.usage),(item.feedback.positive||0)+" / "+(item.feedback.negative||0),review,item.candidateUpdateCount,item.staleByUsage?"YES":"NO"].forEach((value,index)=>{const td=document.createElement("td");td.textContent=String(value);if(index===7&&item.reviewFreshness.overdue)td.className="error";if(index===9)td.className=item.staleByUsage?"error":"ok";row.appendChild(td)});knowledgeQuality.appendChild(row)}
}
async function loadDashboardTrends(){
 const status=document.getElementById("trendStatus");const root=document.getElementById("trendCharts");status.textContent="加载趋势...";const r=await fetch("/admin/api/dashboard-trends?days=14",{headers:headers()});const data=await r.json();
 if(!r.ok){status.textContent=data.error||"趋势加载失败";status.className="error key-meta";return}
 const configs=[["MCP Calls","calls",""],["Errors","errors",""],["No-hit","noHits",""],["Candidates","candidates",""],["Approvals","approvals",""],["Gap Signals","gapSignals",""],["Active Users","activeUsers",""],["Avg Latency","avgLatencyMs"," ms"]];root.replaceChildren();
 for(const [title,key,suffix] of configs){const values=data.rows.map(row=>Number(row[key]||0));const latest=values.at(-1)||0;const peak=Math.max(0,...values);const card=document.createElement("div");card.className="trend-card";const header=document.createElement("div");header.className="trend-header";const left=document.createElement("div");const name=document.createElement("div");name.className="trend-title";name.textContent=title;const meta=document.createElement("div");meta.className="trend-meta";meta.textContent=data.rows[0]?.date+" → "+data.rows.at(-1)?.date+" · peak "+peak+suffix;left.append(name,meta);const value=document.createElement("div");value.className="trend-value";value.textContent=latest+suffix;header.append(left,value);card.appendChild(header);
  if(values.length){const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 280 72");svg.setAttribute("preserveAspectRatio","none");svg.classList.add("trend-svg");const max=Math.max(1,...values);const points=values.map((v,index)=>{const x=values.length===1?140:index*280/(values.length-1);const y=66-(v/max)*58;return x.toFixed(1)+","+y.toFixed(1)}).join(" ");const base=document.createElementNS("http://www.w3.org/2000/svg","line");base.setAttribute("x1","0");base.setAttribute("x2","280");base.setAttribute("y1","66");base.setAttribute("y2","66");base.setAttribute("stroke","currentColor");base.setAttribute("opacity",".12");const line=document.createElementNS("http://www.w3.org/2000/svg","polyline");line.setAttribute("points",points);line.setAttribute("fill","none");line.setAttribute("stroke","currentColor");line.setAttribute("stroke-width","2.5");line.setAttribute("vector-effect","non-scaling-stroke");svg.append(base,line);card.appendChild(svg)}else{const empty=document.createElement("div");empty.className="trend-empty";empty.textContent="暂无趋势数据";card.appendChild(empty)}root.appendChild(card)}
 status.textContent=data.days+" 天 · "+data.semantics.noHits+" · "+data.semantics.approvals;status.className="key-meta";
}
function sessionFilterQuery(){
 const p=new URLSearchParams({limit:"100"});
 const values=[["actorId","sessionFilterUser"],["repositoryId","sessionFilterRepo"],["event","sessionFilterEvent"],["runtimeStatus","sessionFilterRuntime"]];
 for(const [name,id] of values){const v=document.getElementById(id).value.trim();if(v)p.set(name,v)}
 const from=document.getElementById("sessionFilterFrom").value;if(from)p.set("from",new Date(from).toISOString());
 const to=document.getElementById("sessionFilterTo").value;if(to)p.set("to",new Date(to).toISOString());
 return p.toString();
}
async function loadObservability(focusSessionId,focusActorId,focusTenantId){
 loadAutoCandidateQuality();
  loadOperationalHealth();
  loadAlerts();
  loadRepositoryGovernance();
 observabilityStatus.textContent="加载中...";
 const routeParams=parseAdminRoute().params;
 const eventParams=new URLSearchParams({limit:"50"});const eventQ=routeParams.get("eventQ")||"";const eventCursor=routeParams.get("eventCursor")||"";if(eventQ)eventParams.set("q",eventQ);if(eventCursor)eventParams.set("cursor",eventCursor);
 const detectionParams=new URLSearchParams({limit:"50"});const detectionQ=routeParams.get("detectionQ")||"";const detectionCursor=routeParams.get("detectionCursor")||"";if(detectionQ)detectionParams.set("q",detectionQ);if(detectionCursor)detectionParams.set("cursor",detectionCursor);
 const [r,tr,er,sr,dr,kr,ar]=await Promise.all([fetch("/admin/api/observability?limit=100",{headers:headers()}),fetch("/admin/api/traces?limit=50",{headers:headers()}),fetch("/admin/api/client-events?"+eventParams.toString(),{headers:headers()}),fetch("/admin/api/sessions?"+sessionFilterQuery(),{headers:headers()}),fetch("/admin/api/candidate-detections?"+detectionParams.toString(),{headers:headers()}),fetch("/admin/api/kpis",{headers:headers()}),fetch("/admin/api/session-analytics?limit=500",{headers:headers()})]);const data=await r.json();const traceData=await tr.json();const eventData=await er.json();const sessionData=await sr.json();const detectionData=await dr.json();const kpi=await kr.json();const analytics=await ar.json();
 if(!r.ok){observabilityStatus.textContent=data.error||"加载失败";return}
 document.getElementById("statCalls").textContent=data.summary.total;
 document.getElementById("statFailures").textContent=data.summary.failed;
 document.getElementById("statLatency").textContent=Math.round(data.summary.avgLatencyMs)+" ms";
 if(kr.ok){document.getElementById("statActiveUsers").textContent=kpi.activeUsers;document.getElementById("statSessions").textContent=kpi.sessions;document.getElementById("statNoHit").textContent=Math.round(kpi.noHitRate*100)+"%";document.getElementById("statApproval").textContent=Math.round(kpi.approvalRate*100)+"%";document.getElementById("statAutoCandidates").textContent=kpi.autoCandidates;document.getElementById("statPublished").textContent=kpi.publishedCandidates;document.getElementById("statDetectorCreated").textContent=kpi.detectorCreated;document.getElementById("statDetectorSkipped").textContent=kpi.detectorSkipped;document.getElementById("statAutoAccept").textContent=Math.round(kpi.autoAcceptanceRate*100)+"%";document.getElementById("statAutoReject").textContent=Math.round(kpi.autoRejectionRate*100)+"%";document.getElementById("statQualityCoverage").textContent=Math.round(kpi.autoQualityLabelCoverage*100)+"%";document.getElementById("statUsefulRate").textContent=Math.round(kpi.autoUsefulRate*100)+"%";document.getElementById("statFalsePositiveRate").textContent=Math.round(kpi.autoFalsePositiveRate*100)+"%";document.getElementById("statDuplicateFiltered").textContent=kpi.duplicateFiltered;document.getElementById("statLowValueFiltered").textContent=kpi.lowValueFiltered;document.getElementById("statP95Latency").textContent=Math.round(kpi.p95LatencyMs)+" ms";document.getElementById("statMcpErrorRate").textContent=Math.round(kpi.mcpErrorRate*100)+"%";document.getElementById("statNegativeFeedback").textContent=Math.round(kpi.negativeFeedbackRate*100)+"%";document.getElementById("statCallsPerSession").textContent=kpi.avgCallsPerSession.toFixed(1);document.getElementById("statEvidencePerSession").textContent=kpi.avgEvidencePerSession.toFixed(1);document.getElementById("statCandidatesPerSession").textContent=kpi.autoCandidatesPerSession.toFixed(2);document.getElementById("statMrMergeRate").textContent=Math.round(kpi.mergeRequestMergeRate*100)+"%";document.getElementById("statStaleKnowledge").textContent=kpi.staleKnowledgeCount;}
 if(ar.ok){const root=document.getElementById("sessionAnalytics");root.replaceChildren();const s=analytics.summary;const metrics=[["Avg Duration",s.averageDurationMs<60000?Math.round(s.averageDurationMs/1000)+"s":Math.round(s.averageDurationMs/60000)+"m"],["Tools / Session",s.averageToolsUsedPerSession.toFixed(1)],["Knowledge Calls / Session",s.averageKnowledgeCallsPerSession.toFixed(1)],["Repeated Searches",s.repeatedSearches],["Successful Knowledge Reuse",s.successfulKnowledgeReuse],["Candidates / Session",s.averageCandidatesPerSession.toFixed(2)],["Failed Calls / Session",s.averageFailedCallsPerSession.toFixed(2)],["Evidence / Session",s.averageEvidencePerSession.toFixed(1)]];for(const [label,value] of metrics){const card=document.createElement("div");card.className="stat";const name=document.createElement("div");name.textContent=label;const strong=document.createElement("strong");strong.textContent=String(value);card.append(name,strong);root.appendChild(card)}document.getElementById("sessionAnalyticsMeta").textContent=s.sessionCount+" sessions · failures in "+s.sessionsWithFailures+" · knowledge reuse in "+s.sessionsWithKnowledgeReuse+" · "+analytics.semantics.duration;}
 const sessions=document.getElementById("sessionsTable");sessions.replaceChildren();if(sr.ok){for(const item of sessionData.sessions){const row=document.createElement("tr");row.dataset.sessionId=item.sessionId;row.style.cursor="pointer";row.onclick=()=>navigateTo("observability",{session:item.sessionId,actor:item.actorId,tenant:item.tenantId});[fmtTime(item.startedAt),item.actorId,item.sessionId,item.repositoryId||"",item.runtimeVersion?item.runtimeVersion+" / schema "+(item.hookSchemaVersion||"?")+" · "+item.runtimeStatus:"unknown",String(item.eventCount),String(item.callCount),String(item.evidenceCount),item.tools.join(" → "),item.ended?"ENDED":"ACTIVE"].forEach((v,index)=>{const td=document.createElement("td");td.textContent=v;if(index===4)td.className="badge "+(item.runtimeStatus==="current"?"ok":item.runtimeStatus==="outdated"?"error":"");if(index===9)td.className="badge "+(item.ended?"":"ok");row.appendChild(td)});sessions.appendChild(row)}if(focusSessionId){const target=sessionData.sessions.find(x=>x.sessionId===focusSessionId);if(focusActorId&&focusTenantId)loadSession({sessionId:focusSessionId,actorId:focusActorId,tenantId:focusTenantId});else if(target)loadSession(target);const row=[...sessions.children].find(x=>x.dataset.sessionId===focusSessionId);row?.scrollIntoView({block:"center"})}}
 const events=document.getElementById("clientEventsTable");events.replaceChildren();if(er.ok){renderPager("clientEvent",eventData.page,"events");for(const item of eventData.events){const row=document.createElement("tr");[fmtTime(item.ts),item.event,item.actorId,item.sessionId,item.model||"",JSON.stringify(item.metadata||{})].forEach(v=>{const td=document.createElement("td");td.textContent=v;row.appendChild(td)});events.appendChild(row)}}
 const detections=document.getElementById("candidateDetectionsTable");detections.replaceChildren();if(dr.ok){renderPager("detection",detectionData.page,"detections");for(const item of detectionData.detections){const row=document.createElement("tr");[fmtTime(item.ts),item.outcome,item.reason,item.actorId,item.sessionId,String(item.evidenceCount)].forEach((v,index)=>{const td=document.createElement("td");td.textContent=v;if(index===1)td.className="badge "+(item.outcome==="created"?"ok":"");row.appendChild(td)});detections.appendChild(row)}}
 const body=document.getElementById("callsTable");body.replaceChildren();
 for(const item of data.calls){
  const tr=document.createElement("tr");
  [fmtTime(item.ts),item.tool,item.actorId,item.traceId,Math.round(item.latencyMs)+" ms",item.success?"OK":"ERROR"].forEach((value,index)=>{const td=document.createElement("td");td.textContent=value;if(index===5)td.className="badge "+(item.success?"ok":"error");tr.appendChild(td)});
  body.appendChild(tr);
 }
 const traces=document.getElementById("tracesTable");traces.replaceChildren();
 if(tr.ok){for(const item of traceData.traces){const row=document.createElement("tr");row.style.cursor="pointer";row.onclick=()=>loadTrace(item.traceId);[fmtTime(item.startedAt),item.actorId,String(item.callCount),item.tools.join(" → "),Math.round(item.totalLatencyMs)+" ms",item.failed?"ERROR":"OK"].forEach((value,index)=>{const td=document.createElement("td");td.textContent=value;if(index===5)td.className="badge "+(item.failed?"error":"ok");row.appendChild(td)});traces.appendChild(row)}}
 observabilityStatus.textContent=data.calls.length+" calls";
}
async function loadRepositoryGovernance(){
 const summary=document.getElementById("repositoryGovernanceSummary");const body=document.getElementById("repositoryGovernanceTable");const r=await fetch("/admin/api/repository-governance",{headers:headers()});const data=await r.json();
 body.replaceChildren();if(!r.ok){summary.textContent=data.error||"Repository Governance 加载失败";summary.className="error key-meta";return}
 summary.textContent=data.summary.total+" repositories · missing owner "+data.summary.missingOwner+" · stale "+data.summary.stale+" · webhook errors "+data.summary.webhookErrors;summary.className="key-meta";
 const lag=value=>value===undefined||value===null?"-":value<60?value+"s":value<3600?Math.round(value/60)+"m":Math.round(value/3600)+"h";
 for(const item of data.repositories){const row=document.createElement("tr");const values=[item.id+" · "+item.name,item.owners.length?item.owners.join(", "):"MISSING",item.status,fmtTime(item.lastSuccessAt),lag(item.syncLagSeconds),item.lastGoodRevision||"-",item.webhook.status+(item.webhook.lastEventAt?" · "+fmtTime(item.webhook.lastEventAt):""),item.issues.length?item.issues.join(", "):"OK"];values.forEach((value,index)=>{const td=document.createElement("td");td.textContent=String(value);if(index===1&&!item.owners.length)td.className="error";if(index===2)td.className="badge "+(item.status==="healthy"?"ok":item.status==="error"?"error":"");if(index===6&&(item.webhook.status==="error"||item.webhook.status==="misconfigured"))td.className="error";if(index===7)td.className=item.issues.length?"error":"ok";row.appendChild(td)});body.appendChild(row)}
}
async function loadAlerts(){
 const summary=document.getElementById("alertSummary");const root=document.getElementById("alertList");const r=await fetch("/admin/api/alerts",{headers:headers()});const data=await r.json();
 root.replaceChildren();if(!r.ok){summary.textContent=data.error||"告警加载失败";summary.className="error key-meta";return}
 summary.textContent=data.counts.critical+" critical · "+data.counts.warning+" warning · "+fmtTime(data.generatedAt);summary.className="key-meta";
 if(!data.alerts.length){const ok=document.createElement("div");ok.className="ok key-meta";ok.textContent="当前没有活动告警";root.appendChild(ok);return}
 for(const item of data.alerts){const card=document.createElement("div");card.className="review-card";const title=document.createElement("b");title.textContent=item.severity.toUpperCase()+" · "+item.title;const meta=document.createElement("div");meta.className="key-meta "+(item.severity==="critical"?"error":"");meta.textContent=item.category+" · "+item.detail;card.append(title,meta);root.appendChild(card)}
}

async function loadOperationalHealth(){
 const el=document.getElementById("operationalHealth");const r=await fetch("/admin/api/health",{headers:headers()});const data=await r.json();
 if(!r.ok){el.textContent=data.error||"Operational Health 加载失败";el.className="review-content error";return}
 const disk=data.storage?Math.round(data.storage.usedRatio*100)+"% disk":"disk unknown";
 const lines=[
  "Operational Health · "+(data.ready?"READY":"NOT READY")+" · "+disk,
  "Repositories: healthy "+data.repositories.healthy+"/"+data.repositories.total+" · error "+data.repositories.error+" · stale "+data.repositories.stale.length+" · repeated failures "+data.repositories.repeatedFailures.length,
  "Candidates: pending "+data.candidates.pending+" · approved "+data.candidates.approved+" · publish_failed "+data.candidates.publishFailed+" · publishing "+data.candidates.publishing,
  "Knowledge: documents "+data.knowledge.documents+" · lifecycle issues "+data.knowledge.lifecycleIssues+" · overdue "+data.knowledge.reviewOverdue+" · expired "+data.knowledge.expired+" · missing owner "+data.knowledge.missingOwner
 ];
 if(data.repositories.stale.length)lines.push("Stale repositories: "+data.repositories.stale.map(x=>x.id).join(", "));
 if(data.repositories.repeatedFailures.length)lines.push("Repeated failures: "+data.repositories.repeatedFailures.map(x=>x.id+"("+x.failureCount+")").join(", "));
 el.textContent=lines.join("\\n");el.className="review-content";
}

async function loadAutoCandidateQuality(){
 const days=Math.max(1,Math.min(Number(document.getElementById("qualityWindowDays").value)||7,90));const status=document.getElementById("qualityStatus");status.textContent="加载中...";
 const r=await fetch("/admin/api/auto-candidate-quality?days="+encodeURIComponent(days),{headers:headers()});const data=await r.json();if(!r.ok){status.textContent=data.error||"加载失败";status.className="error";return}
 const pct=v=>Math.round((v||0)*100)+"%";document.getElementById("qualitySummary").textContent="Current "+days+"d vs previous "+days+"d · Useful "+pct(data.current.usefulRate)+" ("+(data.delta.usefulRate>=0?"+":"")+pct(data.delta.usefulRate)+") · False-positive "+pct(data.current.falsePositiveRate)+" ("+(data.delta.falsePositiveRate>=0?"+":"")+pct(data.delta.falsePositiveRate)+") · Label coverage "+pct(data.current.labelCoverage);
 const detectors=document.getElementById("qualityDetectorTable");detectors.replaceChildren();for(const item of data.byDetector){const row=document.createElement("tr");[item.detector,item.current.created,item.baseline.created,pct(item.current.usefulRate),pct(item.baseline.usefulRate),pct(item.current.falsePositiveRate),pct(item.baseline.falsePositiveRate),pct(item.current.labelCoverage)].forEach(v=>{const td=document.createElement("td");td.textContent=String(v);row.appendChild(td)});detectors.appendChild(row)}
 const trend=document.getElementById("qualityTrendTable");trend.replaceChildren();for(const item of data.timeSeries){const row=document.createElement("tr");[item.date,item.created,item.skipped,item.reviewed,pct(item.labelCoverage),pct(item.usefulRate),pct(item.falsePositiveRate),item.duplicateFiltered,item.lowValueFiltered].forEach(v=>{const td=document.createElement("td");td.textContent=String(v);row.appendChild(td)});trend.appendChild(row)}
 status.textContent="已加载";status.className="ok";
}
async function loadSession(item){
 const q=new URLSearchParams({actorId:item.actorId,tenantId:item.tenantId});
 const r=await fetch("/admin/api/sessions/"+encodeURIComponent(item.sessionId)+"?"+q.toString(),{headers:headers()});const data=await r.json();if(!r.ok)return;
 const el=document.getElementById("sessionDetail");el.style.display="block";
 const lines=[];
 lines.push("Session "+data.sessionId+" · "+data.actorId);
 lines.push("Evidence: "+data.evidence.length+" · Asset calls: "+data.assetUsage.length+" · Candidates: "+data.candidates.length+" · Detector decisions: "+data.detections.length);
 if(data.evidence.length){lines.push("\\nEVIDENCE");for(const x of data.evidence)lines.push(fmtTime(x.ts)+"  "+(x.tool||x.event)+"  "+JSON.stringify(x.evidence))}
 if(data.assetUsage.length){lines.push("\\nTEAM ASSETS");for(const x of data.assetUsage)lines.push(fmtTime(x.ts)+"  "+x.tool+"  "+(x.success?"OK":"ERROR")+"  "+JSON.stringify(x.args||{}))}
 if(data.candidates.length){lines.push("\\nCANDIDATES");for(const x of data.candidates)lines.push(x.id+"  "+x.status+"  "+x.title+(x.automation?"  ["+x.automation.detector+"]":""))}
 if(data.detections.length){lines.push("\\nDETECTOR");for(const x of data.detections)lines.push(fmtTime(x.ts)+"  "+x.outcome+"  "+x.reason+"  evidence="+x.evidenceCount)}
 lines.push("\\nTIMELINE");
 for(const x of data.timeline){if(x.kind==="event"){const e=x.event;lines.push(fmtTime(x.ts)+"  HOOK "+e.event+"\\n"+JSON.stringify(e.metadata||{}))}else{const c=x.call;lines.push(fmtTime(x.ts)+"  MCP "+c.tool+"  "+Math.round(c.latencyMs)+"ms  "+(c.success?"OK":"ERROR")+"\\n"+JSON.stringify(c.args||{}))}}
 el.textContent=lines.join("\\n");
}
async function loadTrace(id){
 const r=await fetch("/admin/api/traces/"+encodeURIComponent(id),{headers:headers()});const data=await r.json();if(!r.ok)return;
 const el=document.getElementById("traceDetail");el.style.display="block";
 el.textContent=data.calls.map(x=>fmtTime(x.ts)+"  "+x.tool+"  "+Math.round(x.latencyMs)+"ms  "+(x.success?"OK":"ERROR")+"\\nargs: "+JSON.stringify(x.args||{})+(x.error?"\\nerror: "+x.error:"")).join("\\n\\n");
}
async function loadCandidates(focusCandidateId){
 const routeParams=parseAdminRoute().params;const params=new URLSearchParams({limit:"25"});const status=document.getElementById("candidateFilterStatus").value;const repo=document.getElementById("candidateFilterRepo").value.trim();const source=document.getElementById("candidateFilterSource").value.trim();const reviewer=document.getElementById("candidateFilterReviewer").value.trim();const auto=document.getElementById("candidateFilterAuto").value;const q=document.getElementById("candidateFilterQ").value.trim();if(focusCandidateId)params.set("id",focusCandidateId);if(status)params.set("status",status);if(repo)params.set("repository",repo);if(source)params.set("sourceType",source);if(reviewer)params.set("reviewer",reviewer);if(auto)params.set("automatic",auto);if(!focusCandidateId&&q)params.set("q",q);if(!focusCandidateId&&routeParams.get("candidateCursor"))params.set("cursor",routeParams.get("candidateCursor"));
 const r=await fetch("/admin/api/knowledge-candidates?"+params.toString(),{headers:headers()});const data=await r.json();if(!r.ok)return;
 const root=document.getElementById("candidateList");root.replaceChildren();renderPager("candidate",data.page,"candidates");
 document.getElementById("statPending").textContent=data.candidates.filter(x=>x.status==="pending").length;
 for(const item of data.candidates){
  const card=document.createElement("div");card.className="review-card";card.dataset.candidateId=item.id;
  const top=document.createElement("div");top.className="key-row-top";
  if(["pending","approved","rejected","publish_failed"].includes(item.status)){const select=document.createElement("input");select.type="checkbox";select.checked=selectedCandidates.has(item.id);select.onchange=()=>{if(select.checked)selectedCandidates.add(item.id);else selectedCandidates.delete(item.id);document.getElementById("bulkCandidateStatus").textContent="已选 "+selectedCandidates.size+" 项"};top.appendChild(select)}
  const title=document.createElement("b");title.textContent=item.title;
  const badge=document.createElement("span");badge.className="badge "+(item.status==="approved"||item.status==="published"?"ok":item.status==="rejected"||item.status==="publish_failed"?"error":"");badge.textContent=item.status;
  top.append(title,badge);card.appendChild(top);
  const meta=document.createElement("div");meta.className="key-meta";meta.textContent=item.id+" · "+item.sourceType+" · "+fmtTime(item.updatedAt)+(item.automation?" · AUTO "+item.automation.detector:"");card.appendChild(meta);
   if(item.duplicateOf){const d=document.createElement("div");d.className="key-meta error";d.textContent="可能重复："+item.duplicateOf;card.appendChild(d)}
   if(item.possibleDuplicateOf){const d=document.createElement("div");d.className="key-meta";d.textContent="近似候选："+item.possibleDuplicateOf+" · similarity "+String(item.duplicateSimilarity||"");card.appendChild(d)}
   if(item.relationHint){const h=document.createElement("div");h.className="key-meta";h.textContent="关系建议："+item.relationHint.type+" → "+item.relationHint.target.repositoryId+":"+item.relationHint.target.path+" · "+item.relationHint.confidence+" · "+item.relationHint.reason;card.appendChild(h)}
   if(item.knowledgeRelation?.type==="conflicts_with"||item.relationHint?.type==="conflicts_with"){const warning=document.createElement("div");warning.className="error key-meta";warning.textContent="冲突候选：发布前必须人工确认并解决与现有 Knowledge 的冲突。";card.appendChild(warning)}
  if(item.knowledgeRelation){const kr=document.createElement("div");kr.className="key-meta";kr.textContent="Knowledge 关系："+item.knowledgeRelation.type+(item.knowledgeRelation.target?" → "+item.knowledgeRelation.target.repositoryId+":"+item.knowledgeRelation.target.path:"");card.appendChild(kr)}
  if(item.automation?.reasons?.length){const a=document.createElement("div");a.className="key-meta";a.textContent="自动检测依据："+item.automation.reasons.join(" · ");card.appendChild(a)}
  if(item.automation?.evidence?.length){const evidence=document.createElement("div");evidence.className="review-content";evidence.textContent="Evidence\\n"+item.automation.evidence.map(x=>{const counts=x.counts?["run="+(x.counts.run??"-"),"passed="+(x.counts.passed??"-"),"failed="+(x.counts.failed??"-")].join(" "):"";return [x.type,x.sourceTool,x.success===undefined?"":"success="+x.success,x.exitCode===undefined?"":"exit="+x.exitCode,counts,x.durationMs===undefined?"":"duration="+x.durationMs+"ms",x.status||""].filter(Boolean).join(" · ")}).join("\\n");card.appendChild(evidence)}
  if(item.relatedKnowledge?.length){const rel=document.createElement("div");rel.className="key-meta";rel.textContent="相关现有知识："+item.relatedKnowledge.map(x=>{const m=x.metadata||{};const life=[m.status,m.owner,m.validUntil?"有效至 "+m.validUntil:"",m.supersedes?"替代 "+m.supersedes:""].filter(Boolean).join("/");return x.repositoryId+":"+x.path+" ("+x.score+")"+(life?" ["+life+"]":"")}).join(" · ");card.appendChild(rel)}
  const globalActions=document.createElement("div");globalActions.className="actions";const historyAll=document.createElement("button");historyAll.className="secondary";historyAll.textContent="History";historyAll.onclick=()=>loadCandidateHistory(item.id);globalActions.appendChild(historyAll);if(item.knowledgeRelation?.target||item.relationHint?.target){const preview=document.createElement("button");preview.className="secondary";preview.textContent="Preview Update";preview.onclick=()=>loadCandidatePreview(item.id,card);globalActions.appendChild(preview)}card.appendChild(globalActions);
  if(item.sourceSessionId){const sessionButton=document.createElement("button");sessionButton.className="secondary";sessionButton.textContent="查看 Session";sessionButton.onclick=()=>navigateTo("observability",{session:item.sourceSessionId,actor:item.actorId,tenant:item.tenantId});globalActions.appendChild(sessionButton)}
  const editable=["pending","approved","publish_failed"].includes(item.status);
  if(editable){
   const editor=document.createElement("div");editor.className="candidate-editor";
   const t=document.createElement("input");t.value=item.title;
   const repo=document.createElement("input");repo.value=item.repository||"";repo.placeholder="Repository";
   const p=document.createElement("input");p.value=item.suggestedPath||"";p.placeholder="docs/topic.md";
    const relation=document.createElement("select");for(const value of ["new","duplicate_of","updates","supersedes","conflicts_with","related_to"]){const o=document.createElement("option");o.value=value;o.textContent=value;relation.appendChild(o)}relation.value=item.knowledgeRelation?.type||item.relationHint?.type||"new";
   const target=document.createElement("select");const emptyTarget=document.createElement("option");emptyTarget.value="";emptyTarget.textContent="选择关联 Knowledge";target.appendChild(emptyTarget);
   for(const k of item.relatedKnowledge||[]){const o=document.createElement("option");o.value=k.key;o.textContent=k.repositoryId+":"+k.path+" · "+k.title;target.appendChild(o)}
    if(item.knowledgeRelation?.target?.key)target.value=item.knowledgeRelation.target.key;else if(item.relationHint?.target?.key)target.value=item.relationHint.target.key;
   const c=document.createElement("textarea");c.value=item.content;
   editor.append(t,repo,p,relation,target,c);card.appendChild(editor);
   const actions=document.createElement("div");actions.className="actions";
   const save=document.createElement("button");save.className="secondary";save.textContent="保存";save.onclick=()=>{
    const relTarget=(item.relatedKnowledge||[]).find(x=>x.key===target.value);
    const knowledgeRelation=relation.value==="new"?{type:"new"}:{type:relation.value,target:relTarget?{key:relTarget.key,repositoryId:relTarget.repositoryId,path:relTarget.path,title:relTarget.title}:undefined};
    withBusy(save,()=>saveCandidate(item.id,{title:t.value,repository:repo.value,suggestedPath:p.value,content:c.value,suggestedType:item.suggestedType,knowledgeRelation}),"保存中...");
   };actions.appendChild(save);
   if(item.status==="pending"){const curate=document.createElement("button");curate.className="secondary";curate.textContent="AI 整理建议";curate.onclick=()=>withBusy(curate,()=>curateCandidate(item.id),"整理中...");const approve=document.createElement("button");approve.textContent="批准";approve.onclick=()=>withBusy(approve,()=>reviewCandidate(item.id,"approved"),"处理中...");const reject=document.createElement("button");reject.className="danger";reject.textContent="拒绝";reject.onclick=()=>withBusy(reject,()=>reviewCandidate(item.id,"rejected"),"处理中...");actions.append(curate,approve,reject)}
   if(item.status==="approved"||item.status==="publish_failed"){const publish=document.createElement("button");publish.textContent=item.status==="publish_failed"?"重试发布 MR":"发布到 GitLab MR";publish.onclick=()=>withBusy(publish,()=>publishCandidate(item.id),"发布中...");actions.appendChild(publish)}
   card.appendChild(actions);
  }else{
   const content=document.createElement("div");content.className="review-content";content.textContent=item.content;card.appendChild(content);
   if(item.status==="rejected"){const actions=document.createElement("div");actions.className="actions";const reopen=document.createElement("button");reopen.className="secondary";reopen.textContent="重新批准";reopen.onclick=()=>withBusy(reopen,()=>reviewCandidate(item.id,"approved"),"处理中...");actions.appendChild(reopen);card.appendChild(actions)}
  }
  if(item.publishError){const e=document.createElement("div");e.className="error key-meta";e.textContent="发布失败: "+item.publishError;card.appendChild(e)}
  if(item.publication?.mergeRequestUrl){const publication=document.createElement("div");publication.className="key-meta";publication.textContent="GitLab MR !"+item.publication.mergeRequestIid+" · "+(item.publication.mergeRequestState||"unknown")+" · pipeline "+(item.publication.pipelineStatus||"unknown")+" · merge "+(item.publication.detailedMergeStatus||"unknown")+(item.publication.hasConflicts?" · CONFLICT":"")+(item.publication.sourceBranchExists===false?" · SOURCE BRANCH DELETED":"")+" · checked "+fmtTime(item.publication.lastCheckedAt||item.publication.publishedAt)+(item.publication.mergedAt?" · merged "+fmtTime(item.publication.mergedAt):"");card.appendChild(publication);const row=document.createElement("div");row.className="actions";const a=document.createElement("a");a.className="link";a.href=item.publication.mergeRequestUrl;a.target="_blank";a.rel="noreferrer";a.textContent="打开 GitLab MR · "+item.publication.filePath;row.appendChild(a);const refresh=document.createElement("button");refresh.className="secondary";refresh.textContent="刷新 MR 状态";refresh.onclick=()=>withBusy(refresh,()=>reconcileCandidate(item.id),"刷新中...");row.appendChild(refresh);card.appendChild(row)}
  root.appendChild(card);
 }
 if(focusCandidateId){const card=[...root.children].find(x=>x.dataset.candidateId===focusCandidateId);if(card){card.scrollIntoView({block:"center"});card.style.outline="2px solid currentColor"}}
 if(!data.candidates.length)root.textContent="暂无候选知识";
}
async function loadCandidatePreview(id,card){
 let el=card.querySelector("[data-candidate-preview]");if(el){el.remove();return}
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id)+"/preview",{headers:headers()});const data=await r.json();if(!r.ok){toast(data.error||"Preview 加载失败","error");return}
 el=document.createElement("div");el.dataset.candidatePreview="1";el.className="review-content";
 const summary=data.changeSummary;const target=data.target;
 const header=document.createElement("div");header.className="key-meta";header.textContent=target?"Target "+target.repositoryId+":"+target.path+" @ "+target.revision+" · -"+summary.removedLines+" / +"+summary.addedLines:"New Knowledge";
 const grid=document.createElement("div");grid.className="grid";
 const current=document.createElement("div");const currentTitle=document.createElement("b");currentTitle.textContent="CURRENT";const currentBody=document.createElement("pre");currentBody.className="review-content";currentBody.textContent=target?.content||"(new document)";current.append(currentTitle,currentBody);
 const proposed=document.createElement("div");const proposedTitle=document.createElement("b");proposedTitle.textContent="PROPOSED";const proposedBody=document.createElement("pre");proposedBody.className="review-content";proposedBody.textContent=data.candidate.content;proposed.append(proposedTitle,proposedBody);
 grid.append(current,proposed);el.append(header,grid);card.appendChild(el);
}
async function loadCandidateHistory(id){
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id)+"/history",{headers:headers()});const data=await r.json();if(!r.ok)return;
 const el=document.getElementById("candidateHistory");el.style.display="block";el.textContent=data.history.map(x=>fmtTime(x.updatedAt)+"  "+x.status+(x.reviewer?"  reviewer="+x.reviewer:"")+(x.reviewReason?"  reason="+x.reviewReason:"")+(x.reviewNote?"\\n"+x.reviewNote:"")+(x.knowledgeRelation?"\\nrelation="+x.knowledgeRelation.type:"")).join("\\n\\n");
}
async function bulkReviewCandidates(status){
 const ids=[...selectedCandidates];if(!ids.length){document.getElementById("bulkCandidateStatus").textContent="请先选择候选";return}
 const choices=status==="approved"?["useful","needs_edit"]:["false_positive","duplicate","low_reuse_value","outdated"];
 const form=await modalForm({title:status==="approved"?"批量批准候选":"批量拒绝候选",message:"将对 "+ids.length+" 个候选执行 "+status+"。",danger:status==="rejected",confirmText:status==="approved"?"批准":"拒绝",fields:[{name:"reason",label:"审核原因",type:"select",options:choices,value:choices[0]},{name:"note",label:"审核备注（可选）",type:"textarea"}]});if(!form)return;
 const r=await fetch("/admin/api/knowledge-candidates/bulk-review",{method:"POST",headers:headers(),body:JSON.stringify({ids,status,reviewReason:form.reason,reviewNote:form.note||undefined})});const data=await r.json();
 if(!r.ok){toast(data.error||"批量审核失败","error");return}
 const failed=(data.results||[]).filter(x=>!x.ok);for(const item of data.results||[])if(item.ok)selectedCandidates.delete(item.id);
 document.getElementById("bulkCandidateStatus").textContent="完成 "+((data.results||[]).length-failed.length)+" / "+(data.results||[]).length+(failed.length?"，失败 "+failed.length:"");toast(failed.length?"批量审核部分完成":"批量审核完成",failed.length?"error":"ok");await loadCandidates();
}
async function reviewCandidate(id,status){
 const choices=status==="approved"?["useful","needs_edit"]:["false_positive","duplicate","low_reuse_value","outdated"];
 const form=await modalForm({title:status==="approved"?"批准 Candidate":"拒绝 Candidate",danger:status==="rejected",confirmText:status==="approved"?"批准":"拒绝",fields:[{name:"reason",label:"审核原因",type:"select",options:choices,value:choices[0]},{name:"note",label:"审核备注（可选）",type:"textarea"}]});if(!form)return;
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id)+"/review",{method:"POST",headers:headers(),body:JSON.stringify({status,reviewReason:form.reason,reviewNote:form.note})});
 const data=await r.json();if(!r.ok){toast(data.error||"审核失败","error");return}toast(status==="approved"?"Candidate 已批准":"Candidate 已拒绝");await loadCandidates();
}
async function saveCandidate(id,body){
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id),{method:"PUT",headers:headers(),body:JSON.stringify(body)});const data=await r.json();
 if(!r.ok){toast(data.error||"保存失败","error");return}toast("Candidate 已保存");await loadCandidates();
}
async function publishCandidate(id){
 const confirmed=await modalForm({title:"发布到 GitLab MR",message:"将创建 GitLab 分支、提交文件并创建 Merge Request。Merge 仍需人工完成。",confirmText:"创建 MR"});if(!confirmed)return;
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id)+"/publish",{method:"POST",headers:headers(),body:"{}"});const data=await r.json();
 if(!r.ok){toast(data.error||"发布失败","error");await loadCandidates();return}toast("GitLab MR 已创建");await loadCandidates();
}
async function reconcileCandidate(id){
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id)+"/reconcile",{method:"POST",headers:headers(),body:"{}"});const data=await r.json();
 if(!r.ok){toast(data.error||"MR 状态刷新失败","error");return}toast("MR 状态已刷新");await loadCandidates();
}
async function curateCandidate(id){
 const r=await fetch("/admin/api/knowledge-candidates/"+encodeURIComponent(id)+"/curate",{method:"POST",headers:headers(),body:"{}"});const data=await r.json();if(!r.ok){toast(data.error||"AI 整理失败","error");return}
 const p=data.proposal;const conflict=p.conflictHint?"\\n冲突提示："+(p.conflictHint.targetKey?"["+p.conflictHint.targetKey+"] ":"")+p.conflictHint.reason:"";
 const form=await modalForm({title:"AI 整理建议",message:"模型只提供建议；确认后仍为 pending Candidate，仍需人工审核。"+conflict,confirmText:"应用建议",fields:[{name:"title",label:"标题",value:p.title},{name:"summary",label:"精简正文",type:"textarea",value:p.summary},{name:"category",label:"分类（仅供 Reviewer 参考）",value:p.category||""},{name:"suggestedPath",label:"建议路径",value:p.suggestedPath||""},{name:"suggestedType",label:"类型",type:"select",options:["knowledge","skill"],value:p.suggestedType}]});if(!form)return;
 await saveCandidate(id,{title:form.title,content:form.summary,suggestedPath:form.suggestedPath||undefined,suggestedType:form.suggestedType});toast("已应用 AI 建议；Candidate 仍需人工审核");
}
async function createManualCandidate(){
 const body={title:document.getElementById("manualCandidateTitle").value.trim(),content:document.getElementById("manualCandidateContent").value.trim(),repository:document.getElementById("manualCandidateRepo").value.trim()||undefined,suggestedPath:document.getElementById("manualCandidatePath").value.trim()||undefined,suggestedType:"knowledge"};
 if(!body.title||!body.content){document.getElementById("candidateStatus").textContent="标题和正文必填";return}
 const r=await fetch("/admin/api/knowledge-candidates",{method:"POST",headers:headers(),body:JSON.stringify(body)});const data=await r.json();
 if(!r.ok){document.getElementById("candidateStatus").textContent=data.error||"创建失败";return}
 document.getElementById("manualCandidateTitle").value="";document.getElementById("manualCandidateContent").value="";document.getElementById("candidateStatus").textContent="已创建";await loadCandidates();
}
async function loadFeedback(){
 const routeParams=parseAdminRoute().params;const params=new URLSearchParams({limit:"50"});const q=document.getElementById("feedbackSearch").value.trim();if(q)params.set("q",q);if(routeParams.get("feedbackCursor"))params.set("cursor",routeParams.get("feedbackCursor"));
 const r=await fetch("/admin/api/feedback?"+params.toString(),{headers:headers()});const data=await r.json();if(!r.ok)return;
 const body=document.getElementById("feedbackTable");body.replaceChildren();renderPager("feedback",data.page,"feedback");
 for(const item of data.feedback){const tr=document.createElement("tr");[fmtTime(item.ts),item.actorId,item.rating,item.target||item.targetType,item.reason||"",item.traceId||""].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td)});body.appendChild(tr)}
}
async function loadGaps(){
 const [r,cr]=await Promise.all([fetch("/admin/api/knowledge-gaps",{headers:headers()}),fetch("/admin/api/knowledge-curator",{headers:headers()})]);const data=await r.json();const curator=await cr.json();if(!r.ok)return;
 const curatorStatus=document.getElementById("curatorStatus");if(cr.ok){curatorStatus.textContent=curator.configured?"LLM Curator 已配置 · Human Review 必需":"LLM Curator 未配置 · deterministic 聚类仍正常工作";curatorStatus.className=curator.configured?"ok":"muted"}
 const body=document.getElementById("gapsTable");body.replaceChildren();
 for(const item of data.gaps){const tr=document.createElement("tr");[item.query,String(item.occurrences),item.source,(item.members||[item.query]).join(" · "),fmtTime(item.lastSeenAt)].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td)});const action=document.createElement("td");const button=document.createElement("button");button.className="secondary small";button.textContent="Create Candidate";button.onclick=()=>createCandidateFromGap(item);action.appendChild(button);tr.appendChild(action);body.appendChild(tr)}
}
async function curateGaps(){
 const r=await fetch("/admin/api/knowledge-gaps/curate",{method:"POST",headers:headers(),body:"{}"});const data=await r.json();if(!r.ok){toast(data.error||"AI Gap 聚类失败","error");return}
 const message=(data.clusters||[]).length?(data.clusters||[]).map((cluster,index)=>[(index+1)+". "+cluster.label,"members: "+cluster.memberKeys.join(", "),cluster.suggestedTitle?"title: "+cluster.suggestedTitle:"",cluster.suggestedPath?"path: "+cluster.suggestedPath:"",cluster.category?"category: "+cluster.category:""].filter(Boolean).join("\\n")).join("\\n\\n"):"模型没有建议额外聚类。";
 await modalForm({title:"AI Knowledge Gap 聚类建议",message,confirmText:"关闭"});
}
async function createCandidateFromGap(item){
 const form=await modalForm({title:"从 Knowledge Gap 创建 Candidate",message:item.query,confirmText:"创建",fields:[{name:"repository",label:"目标 Repository（可留空）",placeholder:"rd-skills"},{name:"suggestedPath",label:"建议路径（可留空）",placeholder:"docs/knowledge/topic.md"}]});if(!form)return;
 const r=await fetch("/admin/api/knowledge-gaps/"+encodeURIComponent(item.key)+"/candidate",{method:"POST",headers:headers(),body:JSON.stringify({repository:form.repository||undefined,suggestedPath:form.suggestedPath||undefined})});const data=await r.json();
 if(!r.ok){toast(data.error||"创建 Candidate 失败","error");return}
 toast("已创建 pending Candidate："+data.candidate.id);navigateTo("review",{candidate:data.candidate.id});
}
function renderKnowledgeSources(sources){
 const root=document.getElementById("knowledgeSources");root.replaceChildren();
 if(!sources.length){const empty=document.createElement("div");empty.className="muted";empty.textContent="暂无 Repository";root.appendChild(empty);return}
 for(const source of sources){
  const card=document.createElement("div");card.className="knowledge-source";
  const top=document.createElement("div");top.className="key-row-top";
  const name=document.createElement("div");const title=document.createElement("b");title.textContent=source.repository;
  const meta=document.createElement("div");meta.className="key-meta";
  meta.textContent=source.documents+" documents · "+source.chunks+" chunks"+(source.revision?" · "+source.revision.slice(0,12):"")+(source.publishing?" · Publish "+(source.publishing.config.enabled?(source.publishing.tokenConfigured?"ready":"token missing"):"disabled"):"");
  name.append(title,meta);
  const enabledLabel=document.createElement("label");enabledLabel.className="inline-check";
  const enabled=document.createElement("input");enabled.type="checkbox";enabled.checked=source.config.enabled;
  enabledLabel.append(enabled,document.createTextNode("启用 Knowledge"));
  top.append(name,enabledLabel);

  const grid=document.createElement("div");grid.className="knowledge-config-grid";
  function field(labelText,value,type){
   const wrap=document.createElement("div");const label=document.createElement("label");label.textContent=labelText;
   const input=document.createElement("input");input.type=type||"text";input.value=String(value);
   wrap.append(label,input);grid.appendChild(wrap);return input;
  }
  const include=field("Include（逗号分隔）",source.config.include.join(", "));
  const exclude=field("Exclude（逗号分隔）",source.config.exclude.join(", "));
  const maxBytes=field("Max bytes",source.config.maxDocumentBytes,"number");
  const chunkSize=field("Chunk size",source.config.chunkSizeChars,"number");
  const overlap=field("Overlap",source.config.chunkOverlapChars,"number");

  const actions=document.createElement("div");actions.className="actions";
  const save=document.createElement("button");save.className="small";save.textContent="保存并重建索引";
  save.onclick=()=>updateKnowledgeConfig(source.repository,{
   enabled:enabled.checked,
   include:include.value.split(",").map(x=>x.trim()).filter(Boolean),
   exclude:exclude.value.split(",").map(x=>x.trim()).filter(Boolean),
   maxDocumentBytes:Number(maxBytes.value),
   chunkSizeChars:Number(chunkSize.value),
   chunkOverlapChars:Number(overlap.value)
  });
  actions.appendChild(save);

  const publishTitle=document.createElement("h3");publishTitle.textContent="Knowledge Publishing";
  const publishHint=document.createElement("div");publishHint.className="muted";publishHint.textContent="审核通过后通过 GitLab 分支 + Merge Request 发布；写 Token 仅从环境变量读取。";
  const publishConfig=source.publishing?.config||{enabled:false,provider:"gitlab",baseUrl:"",projectPath:"",tokenEnv:"GITLAB_WRITE_TOKEN",targetBranch:"main",branchPrefix:"skill-hub-knowledge"};
  const publishTop=document.createElement("div");publishTop.className="key-row-top";
  const publishEnabledLabel=document.createElement("label");publishEnabledLabel.className="inline-check";
  const publishEnabled=document.createElement("input");publishEnabled.type="checkbox";publishEnabled.checked=Boolean(publishConfig.enabled);
  publishEnabledLabel.append(publishEnabled,document.createTextNode("启用 GitLab MR 发布"));
  const publishState=document.createElement("span");publishState.className="badge "+(source.publishing?.tokenConfigured?"ok":"");
  publishState.textContent=source.publishing?.tokenConfigured?"Write token ready":"Write token not configured";
  publishTop.append(publishEnabledLabel,publishState);
  const publishGrid=document.createElement("div");publishGrid.className="knowledge-config-grid";
  function publishField(labelText,value){
   const wrap=document.createElement("div");const label=document.createElement("label");label.textContent=labelText;
   const input=document.createElement("input");input.value=value||"";wrap.append(label,input);publishGrid.appendChild(wrap);return input;
  }
  const baseUrl=publishField("GitLab Base URL",publishConfig.baseUrl||"");
  const projectPath=publishField("Project Path",publishConfig.projectPath||"");
  const tokenEnv=publishField("Write Token Env",publishConfig.tokenEnv||"GITLAB_WRITE_TOKEN");
  const targetBranch=publishField("Target Branch",publishConfig.targetBranch||"main");
  const branchPrefix=publishField("Branch Prefix",publishConfig.branchPrefix||"skill-hub-knowledge");
  const publishActions=document.createElement("div");publishActions.className="actions";
  const savePublishing=document.createElement("button");savePublishing.className="secondary small";savePublishing.textContent="保存发布配置";
  savePublishing.onclick=()=>updatePublishingConfig(source.repository,{
   enabled:publishEnabled.checked,provider:"gitlab",baseUrl:baseUrl.value.trim(),projectPath:projectPath.value.trim(),
   tokenEnv:tokenEnv.value.trim(),targetBranch:targetBranch.value.trim(),branchPrefix:branchPrefix.value.trim()
  });
  publishActions.appendChild(savePublishing);
  card.append(top,grid,actions,publishTitle,publishHint,publishTop,publishGrid,publishActions);root.appendChild(card);
 }
}
async function updateKnowledgeConfig(repository,config){
 knowledgeStatus.textContent="保存并重建中...";knowledgeStatus.className="";
 const r=await fetch("/admin/api/knowledge/"+encodeURIComponent(repository)+"/config",{
  method:"PUT",headers:headers(),body:JSON.stringify(config)
 });
 const data=await r.json();
 if(!r.ok){knowledgeStatus.textContent=data.error||"保存失败";knowledgeStatus.className="error";return}
 knowledgeStatus.textContent="已保存并重建 "+repository;knowledgeStatus.className="ok";
 await loadKnowledge();
}
async function updatePublishingConfig(repository,config){
 knowledgeStatus.textContent="保存发布配置中...";knowledgeStatus.className="";
 const r=await fetch("/admin/api/knowledge/"+encodeURIComponent(repository)+"/publishing",{method:"PUT",headers:headers(),body:JSON.stringify(config)});
 const data=await r.json();
 if(!r.ok){knowledgeStatus.textContent=data.error||"保存发布配置失败";knowledgeStatus.className="error";return}
 knowledgeStatus.textContent="发布配置已保存 "+repository;knowledgeStatus.className="ok";await loadKnowledge();
}
async function loadKnowledge(){
 const [r,ar]=await Promise.all([fetch("/admin/api/knowledge",{headers:headers()}),fetch("/admin/api/knowledge/lifecycle-audit",{headers:headers()})]);const data=await r.json();const audit=await ar.json();
 if(!r.ok){knowledgeStatus.textContent=data.error||"加载失败";knowledgeStatus.className="error";return}
 renderKnowledgeSources(data.sources);knowledgeStatus.textContent="";knowledgeStatus.className="";
 const summary=document.getElementById("knowledgeAuditSummary");const body=document.getElementById("knowledgeAuditTable");body.replaceChildren();
 if(ar.ok){summary.textContent=audit.documents+" documents · "+audit.issues.length+" lifecycle issues"+(Object.keys(audit.byKind||{}).length?" · "+Object.entries(audit.byKind).map(([k,v])=>k+":"+v).join(" · "):"");for(const item of audit.issues){const row=document.createElement("tr");[item.kind,item.repositoryId,item.path,item.owner||"-",item.status||"-",item.lastReviewedAt||"-",item.reviewCycleDays?item.reviewCycleDays+"d":"-",item.reviewDueAt||"-",item.validUntil||"-"].forEach((value,index)=>{const td=document.createElement("td");td.textContent=String(value);if(index===0&&["expired","deprecated","superseded","archived","invalid-valid-until","invalid-updated-at","review-overdue"].includes(item.kind))td.className="badge error";row.appendChild(td)});const action=document.createElement("td");const button=document.createElement("button");button.className="secondary small";button.textContent="Create Review Candidate";button.onclick=()=>withBusy(button,()=>createLifecycleReviewCandidate(item),"创建中...");action.appendChild(button);row.appendChild(action);body.appendChild(row)}}else{summary.textContent=audit.error||"Lifecycle audit 加载失败"}
}
async function createLifecycleReviewCandidate(item){
 const r=await fetch("/admin/api/knowledge/lifecycle-review-candidate",{method:"POST",headers:headers(),body:JSON.stringify({repositoryId:item.repositoryId,path:item.path,kind:item.kind})});const data=await r.json();
 if(!r.ok){toast(data.error||"创建 Review Candidate 失败","error");return}
 toast("已创建 pending Review Candidate："+data.candidate.id);navigateTo("review",{candidate:data.candidate.id});
}
async function searchKnowledge(){
 const q=document.getElementById("knowledgeQuery").value.trim();
 const repo=document.getElementById("knowledgeRepo").value.trim();
 if(!q){knowledgeStatus.textContent="请输入搜索问题";knowledgeStatus.className="error";return}
 const params=new URLSearchParams({q,limit:"5"});if(repo)params.set("repository",repo);
 knowledgeStatus.textContent="搜索中...";knowledgeStatus.className="";
 const r=await fetch("/admin/api/knowledge/search?"+params.toString(),{headers:headers()});const data=await r.json();
 if(!r.ok){knowledgeStatus.textContent=data.error||"搜索失败";knowledgeStatus.className="error";return}
 const root=document.getElementById("knowledgeResults");root.replaceChildren();
 for(const item of data.results){
  const card=document.createElement("div");card.className="knowledge-result";
  const title=document.createElement("b");title.textContent=item.title+" · "+item.repository;
   const meta=document.createElement("div");meta.className="key-meta";const life=item.metadata||{};const lifeParts=[life.status,life.owner,life.validUntil?"有效至 "+life.validUntil:"",life.supersedes?"替代 "+life.supersedes:""].filter(Boolean);meta.textContent=item.path+" · chunk "+item.chunkIndex+" · score "+Number(item.score).toFixed(2)+(lifeParts.length?" · "+lifeParts.join(" · "):"");
  const content=document.createElement("div");content.className="knowledge-content";content.textContent=item.content;
  card.append(title,meta,content);root.appendChild(card);
 }
 if(!data.results.length){const empty=document.createElement("div");empty.className="muted";empty.textContent="没有匹配结果";root.appendChild(empty)}
 knowledgeStatus.textContent="找到 "+data.results.length+" 条结果";knowledgeStatus.className="ok";
}
function apiRoles(){return document.getElementById("apiRoles").value.split(",").map(x=>x.trim()).filter(Boolean)}
function renderApiKeys(keys){
 const root=document.getElementById("apiKeys"); root.replaceChildren();
 if(!keys.length){const empty=document.createElement("div");empty.className="muted";empty.textContent="暂无后台管理的用户 API Key";root.appendChild(empty);return}
 for(const item of keys){
  const row=document.createElement("div");row.className="key-row";
  const top=document.createElement("div");top.className="key-row-top";
  const title=document.createElement("div");title.innerHTML="<b></b> <code></code>";
  title.querySelector("b").textContent=item.label;
  title.querySelector("code").textContent="••••"+item.keyLast4;
  const actions=document.createElement("div");
  const toggle=document.createElement("button");toggle.className="secondary small";toggle.textContent=item.enabled?"禁用":"启用";
  toggle.onclick=()=>updateApiKey(item.id,{enabled:!item.enabled});
  const remove=document.createElement("button");remove.className="danger small";remove.textContent="删除";
  remove.onclick=()=>deleteApiKey(item.id);
  actions.append(toggle,remove);top.append(title,actions);
  const meta=document.createElement("div");meta.className="key-meta";
  meta.textContent="User: "+item.principal.id+" · Tenant: "+item.principal.tenantId+" · Roles: "+item.principal.roles.join(", ")+" · "+(item.enabled?"Enabled":"Disabled");
  row.append(top,meta);root.appendChild(row);
 }
}
async function loadApiKeys(){
 const r=await fetch("/admin/api/api-keys",{headers:headers()}); const data=await r.json();
 if(!r.ok){apiKeyStatus.textContent=data.error||"加载失败";apiKeyStatus.className="error";return}
 renderApiKeys(data.keys);apiKeyStatus.textContent="";
}
async function createApiKey(){
 try{
  const body={label:document.getElementById("apiLabel").value,principal:{id:document.getElementById("apiUserId").value,tenantId:document.getElementById("apiTenant").value,roles:apiRoles()}};
  const r=await fetch("/admin/api/api-keys",{method:"POST",headers:headers(),body:JSON.stringify(body)});const data=await r.json();
  if(!r.ok)throw new Error(data.error||"创建失败");
  document.getElementById("newApiKey").value=data.apiKey;document.getElementById("oneTimeKey").style.display="block";
  apiKeyStatus.textContent="创建成功";apiKeyStatus.className="ok";await loadApiKeys();
 }catch(e){apiKeyStatus.textContent=e.message||String(e);apiKeyStatus.className="error"}
}
async function updateApiKey(id,body){
 const r=await fetch("/admin/api/api-keys/"+encodeURIComponent(id),{method:"PUT",headers:headers(),body:JSON.stringify(body)});const data=await r.json();
 if(!r.ok){apiKeyStatus.textContent=data.error||"更新失败";apiKeyStatus.className="error";return}
 await loadApiKeys();
}
async function deleteApiKey(id){
 const confirmed=await modalForm({title:"删除 API Key",message:"删除后客户端会立即失效，此操作不可撤销。",danger:true,confirmText:"删除"});if(!confirmed)return;
 const r=await fetch("/admin/api/api-keys/"+encodeURIComponent(id),{method:"DELETE",headers:headers(false)});const data=await r.json();
 if(!r.ok){apiKeyStatus.textContent=data.error||"删除失败";apiKeyStatus.className="error";toast(data.error||"删除失败","error");return}
 toast("API Key 已删除");await loadApiKeys();
}
async function loadEvaluationSuites(){
 const repo=document.getElementById("evaluationRepo").value.trim();const revision=document.getElementById("evaluationRevision").value.trim();
 if(!repo){evaluationStatus.textContent="请输入 Repository";evaluationStatus.className="error";return}
 const params=new URLSearchParams();if(revision)params.set("revision",revision);
 evaluationStatus.textContent="加载 Suites...";
 const r=await fetch("/repositories/"+encodeURIComponent(repo)+"/evaluations/suites?"+params.toString(),{headers:headers()});const data=await r.json();
 if(!r.ok){evaluationStatus.textContent=data.error||"加载 Suites 失败";evaluationStatus.className="error";return}
 const select=document.getElementById("evaluationSuite");select.replaceChildren();
 for(const suite of data.suites){const o=document.createElement("option");o.value=suite.id;o.textContent=suite.id+" · "+suite.cases.length+" cases · "+suite.description;select.appendChild(o)}
 if(!data.suites.length){const o=document.createElement("option");o.value="";o.textContent="无 Evaluation Suite";select.appendChild(o)}
 evaluationStatus.textContent="已加载 "+data.suites.length+" 个 Suite";evaluationStatus.className="ok";
 await loadEvaluationRuns();
}
function renderEvaluationDetail(run){
 const el=document.getElementById("evaluationDetail");el.style.display="block";
 const lines=[run.repositoryId+" / "+run.suiteId+" @ "+run.revision,"Pass: "+run.passed+"/"+run.total+" ("+Math.round(run.passRate*100)+"%)","Regression: "+(run.regression?"YES":"NO")+(run.baselineRevision?" · baseline "+run.baselineRevision:"")];
 if(run.retrievalMetrics){const m=run.retrievalMetrics;lines.push("Retrieval: Hit@1 "+Math.round(m.hitAt1*100)+"% · Hit@3 "+Math.round(m.hitAt3*100)+"% · Hit@5 "+Math.round(m.hitAt5*100)+"% · MRR "+m.mrr.toFixed(3))}
 if(run.baselineRetrievalMetrics){const m=run.baselineRetrievalMetrics;lines.push("Baseline Retrieval: Hit@1 "+Math.round(m.hitAt1*100)+"% · Hit@3 "+Math.round(m.hitAt3*100)+"% · Hit@5 "+Math.round(m.hitAt5*100)+"% · MRR "+m.mrr.toFixed(3))}
 if(run.removedBaselineCases?.length)lines.push("Removed baseline cases: "+run.removedBaselineCases.join(", "));
 const failedOnly=document.getElementById("evaluationFailedOnly").checked;const cases=failedOnly?(run.cases||[]).filter(x=>!x.passed):(run.cases||[]);
 if(cases.length){lines.push("\\nCASE DETAIL");for(const x of cases){lines.push((x.passed?"PASS":"FAIL")+" · "+x.id+(x.rank?" · rank #"+x.rank:"")+" · "+x.message);lines.push("  expected: "+JSON.stringify(x.expected||{}));lines.push("  actual: "+JSON.stringify(x.actual??null))}}
 el.textContent=lines.join("\\n");
}
async function loadEvaluationRun(id){
 const r=await fetch("/evaluations/runs/"+encodeURIComponent(id),{headers:headers()});const data=await r.json();if(!r.ok){evaluationStatus.textContent=data.error||"加载 Evaluation 失败";return}renderEvaluationDetail(data);
}
async function loadEvaluationRuns(){
 const params=new URLSearchParams({limit:"100"});const repo=document.getElementById("evaluationRepo").value.trim();const suite=document.getElementById("evaluationSuite").value;if(repo)params.set("repository",repo);if(suite)params.set("suite",suite);
 const r=await fetch("/evaluations/runs?"+params.toString(),{headers:headers()});const data=await r.json();if(!r.ok){evaluationStatus.textContent=data.error||"加载历史失败";return}
 const body=document.getElementById("evaluationRunsTable");body.replaceChildren();const failedOnly=document.getElementById("evaluationFailedOnly").checked;const visible=(data.runs||[]).filter(run=>!failedOnly||run.failed>0||run.regression);
 for(const run of visible){const row=document.createElement("tr");row.style.cursor="pointer";row.onclick=()=>loadEvaluationRun(run.runId);const retrieval=run.retrievalMetrics?"H1 "+Math.round(run.retrievalMetrics.hitAt1*100)+"% / MRR "+run.retrievalMetrics.mrr.toFixed(2):"-";[fmtTime(run.ts),run.repositoryId,run.suiteId,run.revision,run.passed+"/"+run.total,run.regression?"REGRESSION":"OK",retrieval].forEach((v,index)=>{const td=document.createElement("td");td.textContent=String(v);if(index===5)td.className="badge "+(run.regression?"error":"ok");row.appendChild(td)});body.appendChild(row)}
 const trend=(data.runs||[]).slice(0,10).reverse();document.getElementById("evaluationTrend").textContent=trend.length?"Recent trend: "+trend.map(run=>new Date(run.ts).toLocaleDateString()+" "+run.suiteId+" "+Math.round(run.passRate*100)+"%"+(run.regression?"!":"")).join(" → "):"";
 if(!visible.length)evaluationStatus.textContent=failedOnly?"暂无失败/回归记录":"暂无 Evaluation 历史";
}
async function runEvaluation(){
 const repo=document.getElementById("evaluationRepo").value.trim();const suite=document.getElementById("evaluationSuite").value;const revision=document.getElementById("evaluationRevision").value.trim();const baseline=document.getElementById("evaluationBaseline").value.trim();
 if(!repo||!suite){evaluationStatus.textContent="Repository 和 Suite 必填";evaluationStatus.className="error";return}
 evaluationStatus.textContent="运行中...";evaluationStatus.className="";
 const r=await fetch("/repositories/"+encodeURIComponent(repo)+"/evaluations/run",{method:"POST",headers:headers(),body:JSON.stringify({suite,revision:revision||undefined,baseline_revision:baseline||undefined})});const data=await r.json();
 if(!r.ok){evaluationStatus.textContent=data.error||"Evaluation 失败";evaluationStatus.className="error";return}
 renderEvaluationDetail(data);evaluationStatus.textContent=data.failed===0&&!data.regression?"PASS":"FAIL / REGRESSION";evaluationStatus.className=data.failed===0&&!data.regression?"ok":"error";await loadEvaluationRuns();
}
function headers(json=true){const value={"x-skill-hub-admin-key":key.value};if(json)value["content-type"]="application/json";return value}
async function loadDataGovernance(){
 const r=await fetch("/admin/api/data-governance",{headers:headers()});const data=await r.json();if(!r.ok)return;
 const body=document.getElementById("dataGovernanceTable");body.replaceChildren();
 for(const rule of data.rules||[]){const tr=document.createElement("tr");[rule.classification,rule.collect?"yes":"no",rule.persist?"yes":"no",rule.retentionDays+"d",rule.access,rule.audited?"yes":"no"].forEach((value,index)=>{const td=document.createElement("td");td.textContent=String(value);if((index===1||index===2)&&value==="no")td.className="badge error";tr.appendChild(td)});body.appendChild(tr)}
 document.getElementById("dataGovernanceInvariants").textContent=(data.invariants||[]).join(" · ");
}
async function load(){
 statusEl.textContent="加载中..."; statusEl.className="";
 const r=await fetch("/admin/api/config",{headers:headers()});
 const data=await r.json();
 if(!r.ok){statusEl.textContent=data.error||"加载失败";statusEl.className="error";return}
 document.getElementById("retention").value=data.config.revisionRetentionMax;
 document.getElementById("dedupEntries").value=data.config.webhookDedupMaxEntries;
 document.getElementById("dedupTtl").value=data.config.webhookDedupTtlSeconds;
 document.getElementById("roles").value=data.config.defaultRoles.join(", ");
 document.getElementById("repos").value=JSON.stringify(data.config.repositories,null,2);
 document.getElementById("projects").value=JSON.stringify(data.config.projects||[],null,2);
 document.getElementById("bootstrap").innerHTML=
   "Admin API Key: <b>"+(data.bootstrap.adminKeyConfigured?"已配置":"未配置")+"</b>　"+
   "Webhook Secret: <b>"+(data.bootstrap.webhookSecretConfigured?"已配置":"未配置")+"</b>　"+
   "GitLab Token: <b>"+(data.bootstrap.gitlabTokenConfigured?"已配置":"未配置")+"</b>";
 statusEl.textContent="已加载";statusEl.className="ok";
 await loadApiKeys();
 await loadKnowledge();
 await loadTools(false);
 await loadEvaluationRuns();
 await loadObservability();
 await loadCandidates();
 await loadFeedback();
 await loadGaps();
 await loadDataGovernance();
 await loadRepositoryGovernance();
 if(!location.hash)history.replaceState(null,"","#dashboard");
 applyAdminRoute();
}
async function save(){
 try{
  sessionStorage.setItem("skillHubAdminKey",key.value);
  const body={
   defaultRoles:document.getElementById("roles").value.split(",").map(x=>x.trim()).filter(Boolean),
   revisionRetentionMax:Number(document.getElementById("retention").value),
   webhookDedupMaxEntries:Number(document.getElementById("dedupEntries").value),
   webhookDedupTtlSeconds:Number(document.getElementById("dedupTtl").value),
   repositories:JSON.parse(document.getElementById("repos").value),
   projects:JSON.parse(document.getElementById("projects").value)
  };
  statusEl.textContent="保存中...";statusEl.className="";
  const r=await fetch("/admin/api/config",{method:"PUT",headers:headers(),body:JSON.stringify(body)});
  const data=await r.json();
  if(!r.ok)throw new Error(data.error||"保存失败");
  statusEl.textContent="已保存并应用";statusEl.className="ok";
  await load();
 }catch(e){statusEl.textContent=e.message||String(e);statusEl.className="error"}
}
document.getElementById("bulkApproveCandidates").onclick=()=>bulkReviewCandidates("approved");
document.getElementById("bulkRejectCandidates").onclick=()=>bulkReviewCandidates("rejected");
document.getElementById("applyCandidateFilters").onclick=()=>{replaceRouteQuery({candidate:null,candidateStatus:document.getElementById("candidateFilterStatus").value,candidateRepo:document.getElementById("candidateFilterRepo").value.trim(),candidateSource:document.getElementById("candidateFilterSource").value.trim(),candidateReviewer:document.getElementById("candidateFilterReviewer").value.trim(),candidateAuto:document.getElementById("candidateFilterAuto").value,candidateQ:document.getElementById("candidateFilterQ").value.trim(),candidateCursor:null});loadCandidates()};
document.getElementById("createManualCandidate").onclick=createManualCandidate;
document.getElementById("applySessionFilters").onclick=loadObservability;
document.getElementById("clearSessionFilters").onclick=()=>{for(const id of ["sessionFilterUser","sessionFilterRepo","sessionFilterEvent","sessionFilterRuntime","sessionFilterFrom","sessionFilterTo"])document.getElementById(id).value="";loadObservability()};
document.getElementById("reloadQuality").onclick=loadAutoCandidateQuality;
document.getElementById("reloadObservability").onclick=loadObservability;
document.getElementById("reloadDashboardTrends").onclick=()=>withBusy(document.getElementById("reloadDashboardTrends"),loadDashboardTrends,"刷新中...");
document.getElementById("clientEventSearchButton").onclick=()=>{replaceRouteQuery({eventQ:document.getElementById("clientEventSearch").value.trim(),eventCursor:null});loadObservability()};
document.getElementById("clientEventPrev").onclick=()=>{replaceRouteQuery({eventCursor:pageState.events.previousCursor});loadObservability()};
document.getElementById("clientEventNext").onclick=()=>{replaceRouteQuery({eventCursor:pageState.events.nextCursor});loadObservability()};
document.getElementById("detectionSearchButton").onclick=()=>{replaceRouteQuery({detectionQ:document.getElementById("detectionSearch").value.trim(),detectionCursor:null});loadObservability()};
document.getElementById("detectionPrev").onclick=()=>{replaceRouteQuery({detectionCursor:pageState.detections.previousCursor});loadObservability()};
document.getElementById("detectionNext").onclick=()=>{replaceRouteQuery({detectionCursor:pageState.detections.nextCursor});loadObservability()};
document.getElementById("candidatePrev").onclick=()=>{replaceRouteQuery({candidate:null,candidateCursor:pageState.candidates.previousCursor});loadCandidates()};
document.getElementById("candidateNext").onclick=()=>{replaceRouteQuery({candidate:null,candidateCursor:pageState.candidates.nextCursor});loadCandidates()};
document.getElementById("feedbackSearchButton").onclick=()=>{replaceRouteQuery({feedbackQ:document.getElementById("feedbackSearch").value.trim(),feedbackCursor:null});loadFeedback()};
document.getElementById("feedbackPrev").onclick=()=>{replaceRouteQuery({feedbackCursor:pageState.feedback.previousCursor});loadFeedback()};
document.getElementById("feedbackNext").onclick=()=>{replaceRouteQuery({feedbackCursor:pageState.feedback.nextCursor});loadFeedback()};
document.getElementById("curateGaps").onclick=()=>withBusy(document.getElementById("curateGaps"),curateGaps,"聚类中...");
document.getElementById("searchTools").onclick=()=>loadTools(true);
document.getElementById("reloadTools").onclick=()=>loadTools(false);
document.getElementById("searchKnowledge").onclick=searchKnowledge;
document.getElementById("reloadKnowledge").onclick=loadKnowledge;
document.getElementById("createApiKey").onclick=createApiKey;
document.getElementById("copyApiKey").onclick=async()=>{await navigator.clipboard.writeText(document.getElementById("newApiKey").value);apiKeyStatus.textContent="已复制";apiKeyStatus.className="ok"};
document.getElementById("evaluationFailedOnly").onchange=loadEvaluationRuns;
document.getElementById("loadEvaluationSuites").onclick=loadEvaluationSuites;
document.getElementById("runEvaluation").onclick=runEvaluation;
document.getElementById("reloadEvaluationRuns").onclick=loadEvaluationRuns;
document.getElementById("save").onclick=save;
document.getElementById("reload").onclick=load;
load();
</script>
</body></html>`;
