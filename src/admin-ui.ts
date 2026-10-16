export const ADMIN_LOGIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin 登录</title><style>body{margin:0;background:#f5f7fb;color:#172033;font:14px system-ui,sans-serif}.wrap{min-height:100vh;display:grid;place-items:center;padding:20px}.card{width:min(420px,100%);box-sizing:border-box;background:#fff;border:1px solid #e4e8f0;border-radius:16px;padding:28px;box-shadow:0 16px 50px rgba(15,23,42,.1)}h1{margin:0 0 8px}p{color:#667085}label{display:block;font-weight:700;margin:16px 0 6px}input,button{width:100%;box-sizing:border-box;padding:11px;border-radius:8px;font:inherit}input{border:1px solid #ccd3df}button{margin-top:18px;border:0;background:#2457d6;color:white;font-weight:800;cursor:pointer}.error{color:#b42318;margin-top:12px}.muted{font-size:12px;color:#667085;margin-top:14px}</style></head><body><main class="wrap"><form class="card" id="loginForm"><h1>管理员登录</h1><p>Team Skill Hub Admin</p><label>用户名</label><input id="username" name="username" autocomplete="username" required><label>密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button id="submit" type="submit">登录</button><div id="error" class="error"></div><div class="muted">登录成功后使用 HttpOnly Session Cookie，不会把密码保存在浏览器存储中。</div></form></main><script>const form=document.getElementById('loginForm'),error=document.getElementById('error'),button=document.getElementById('submit');form.onsubmit=async e=>{e.preventDefault();error.textContent='';button.disabled=true;button.textContent='登录中...';try{const q=new URLSearchParams(location.search);const r=await fetch('/admin/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:form.username.value,password:form.password.value,next:q.get('next')||'/admin'})});const d=await r.json();if(!r.ok)throw Error(d.error||('HTTP '+r.status));location.assign(d.next||'/admin')}catch(e){error.textContent=e.message||String(e);button.disabled=false;button.textContent='登录'}}</script></body></html>`;

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
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tab{background:#fff;color:#334155;border:1px solid #d9e0ea;padding:8px 12px}.tab.active{background:#172033;color:#fff;border-color:#172033}.view{display:none}.view.active{display:block}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{background:#fff;border:1px solid #e4e8f0;border-radius:12px;padding:16px}.stat-value{font-size:26px;font-weight:800;margin-top:4px}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:10px;border-bottom:1px solid #edf0f5;vertical-align:top}.badge{display:inline-block;padding:3px 8px;border-radius:999px;background:#eef2f7;font-size:12px}.badge.ok{background:#e7f7ef}.badge.error{background:#fff0ee}.review-card{border:1px solid #e4e8f0;border-radius:12px;padding:14px;margin:10px 0}.candidate-compact{padding:12px 14px}.candidate-main{display:flex;align-items:center;gap:10px;min-width:0}.candidate-main input[type=checkbox]{width:auto;margin:0;flex:0 0 auto}.candidate-title{border:0;background:transparent;color:#172033;padding:0;font-size:14px;font-weight:700;text-align:left;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.candidate-title:hover{color:#2457d6;text-decoration:underline}.candidate-spacer{flex:1}.candidate-meta{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;color:#667085;font-size:12px;margin-top:8px}.candidate-meta .meta-separator{color:#c2c8d0}.candidate-actions{display:flex;align-items:center;gap:8px;margin-left:auto}.candidate-actions button{margin:0}.badge.type{background:#eef4ff;color:#2d55a6}.badge.collection{background:#f2f4f7;color:#475467}.review-content{white-space:pre-wrap;max-height:220px;overflow:auto;background:#f8fafc;padding:10px;border-radius:8px;margin-top:8px}.candidate-editor{display:grid;grid-template-columns:2fr 1fr 2fr;gap:10px;margin-top:10px}.candidate-editor textarea{grid-column:1/-1;min-height:140px}.trace-detail{margin-top:12px;padding:12px;background:#f8fafc;border-radius:10px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;max-height:320px;overflow:auto}.link{color:#2457d6;text-decoration:none;font-weight:600}@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.knowledge-config-grid{grid-template-columns:1fr 1fr}}@media(max-width:760px){.grid,.stats{grid-template-columns:1fr}.wrap{padding:14px}.knowledge-config-grid{grid-template-columns:1fr}.candidate-main{align-items:flex-start;flex-wrap:wrap}.candidate-spacer{display:none}.candidate-actions{width:100%;margin-left:28px}.candidate-title{max-width:calc(100vw - 150px)}}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.46);display:none;align-items:center;justify-content:center;padding:20px;z-index:1000}.modal-backdrop.open{display:flex}.modal-panel{width:min(520px,100%);max-height:85vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 24px 80px rgba(15,23,42,.25);padding:20px}.modal-panel h3{margin:0 0 8px}.modal-message{white-space:pre-wrap;color:#475467;font-size:14px;margin-bottom:12px}.modal-fields{display:grid;gap:10px}.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.candidate-review-backdrop{z-index:900}.candidate-review-panel{width:min(1080px,calc(100vw - 40px));max-height:88vh;padding:0;overflow:hidden}.candidate-review-header{display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid #e4e8f0}.candidate-review-header h3{margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.candidate-review-close{background:#edf1f8;color:#23324d;padding:7px 11px}.candidate-review-body{padding:18px 22px;max-height:calc(88vh - 70px);overflow:auto}.candidate-review-body>.review-card{border:0;padding:0;margin:0}.candidate-review-body textarea{min-height:320px}.toast-stack{position:fixed;right:20px;bottom:20px;display:grid;gap:10px;z-index:1100;max-width:min(420px,calc(100vw - 40px))}.toast{background:#172033;color:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 12px 30px rgba(15,23,42,.18);font-size:13px}.toast.error{background:#b42318;color:#fff}.toast.ok{background:#117a45;color:#fff}button:disabled{cursor:not-allowed;opacity:.55}
.trend-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.trend-card{border:1px solid #e4e8f0;border-radius:12px;padding:14px;min-width:0}.trend-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.trend-title{font-size:13px;font-weight:700}.trend-value{font-size:22px;font-weight:800}.trend-meta{font-size:11px;color:#667085;margin-top:3px}.trend-svg{display:block;width:100%;height:72px;margin-top:8px;overflow:visible}.trend-empty{height:72px;display:flex;align-items:center;color:#98a2b3;font-size:12px}@media(max-width:900px){.trend-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.trend-grid{grid-template-columns:1fr}}
.page-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.page-heading h2{margin-right:auto}.help-box{margin:10px 0 16px;padding:12px 14px;border:1px solid #dbe4f0;background:#f8fbff;border-radius:10px;font-size:13px;line-height:1.65;color:#475467}.help-box b{color:#172033}.term{font-size:12px;color:#667085;font-weight:500}
.module-index{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:16px}.module-entry{display:block;color:inherit;text-decoration:none;background:#fff;border:1px solid #e4e8f0;border-radius:12px;padding:16px;min-height:112px}.module-entry:hover{border-color:#2457d6;box-shadow:0 4px 16px rgba(36,87,214,.12)}.module-entry h3{margin:0 0 8px;font-size:16px}.module-entry p{margin:0;color:#667085;font-size:13px;line-height:1.5}.module-entry .route{display:block;margin-top:12px;color:#2457d6;font-size:12px;font-weight:700}@media(max-width:760px){.module-index{grid-template-columns:1fr}}
</style>
</head>
<body><div class="wrap">
<h1>Team Skill Hub</h1><div class="muted">AI 工程中台 · Skill / Knowledge / MCP Observability</div><div class="actions"><a class="tab" href="/admin/review">审核中心</a><a class="tab" href="/admin/skill-bundles">Skill Bundle 导入</a></div>
<div class="tabs"><button class="tab active" data-tab="dashboard">概览</button><button class="tab" data-tab="observability">运行观测</button><button class="tab" data-tab="knowledge">知识库</button><button class="tab" data-tab="tools">工具</button><button class="tab" data-tab="governance">治理</button><button class="tab" data-tab="evaluation">评测</button><button class="tab" data-tab="review">审核中心</button><button class="tab" data-tab="feedback">用户反馈</button><button class="tab" data-tab="gaps">知识缺口</button><button class="tab" data-tab="access">访问控制</button><button class="tab" data-tab="settings">系统设置</button></div>
<div class="view active" data-view="dashboard"><div class="stats"><div class="stat"><div class="muted">MCP 调用</div><div class="stat-value" id="statCalls">-</div></div><div class="stat"><div class="muted">失败</div><div class="stat-value" id="statFailures">-</div></div><div class="stat"><div class="muted">平均延迟</div><div class="stat-value" id="statLatency">-</div></div><div class="stat"><div class="muted">待审核</div><div class="stat-value" id="statPending">-</div></div><div class="stat"><div class="muted">活跃用户</div><div class="stat-value" id="statActiveUsers">-</div></div><div class="stat"><div class="muted">会话数</div><div class="stat-value" id="statSessions">-</div></div><div class="stat"><div class="muted">未命中率</div><div class="stat-value" id="statNoHit">-</div></div><div class="stat"><div class="muted">批准率</div><div class="stat-value" id="statApproval">-</div></div><div class="stat"><div class="muted">自动候选</div><div class="stat-value" id="statAutoCandidates">-</div></div><div class="stat"><div class="muted">已发布</div><div class="stat-value" id="statPublished">-</div></div><div class="stat"><div class="muted">检测器创建</div><div class="stat-value" id="statDetectorCreated">-</div></div><div class="stat"><div class="muted">检测器跳过</div><div class="stat-value" id="statDetectorSkipped">-</div></div><div class="stat"><div class="muted">自动接受率</div><div class="stat-value" id="statAutoAccept">-</div></div><div class="stat"><div class="muted">自动拒绝率</div><div class="stat-value" id="statAutoReject">-</div></div><div class="stat"><div class="muted">质量标签</div><div class="stat-value" id="statQualityCoverage">-</div></div><div class="stat"><div class="muted">有效率</div><div class="stat-value" id="statUsefulRate">-</div></div><div class="stat"><div class="muted">误报率</div><div class="stat-value" id="statFalsePositiveRate">-</div></div><div class="stat"><div class="muted">重复项过滤</div><div class="stat-value" id="statDuplicateFiltered">-</div></div><div class="stat"><div class="muted">低价值过滤</div><div class="stat-value" id="statLowValueFiltered">-</div></div><div class="stat"><div class="muted">P95 延迟</div><div class="stat-value" id="statP95Latency">-</div></div><div class="stat"><div class="muted">MCP 错误率</div><div class="stat-value" id="statMcpErrorRate">-</div></div><div class="stat"><div class="muted">负反馈</div><div class="stat-value" id="statNegativeFeedback">-</div></div><div class="stat"><div class="muted">每会话调用数</div><div class="stat-value" id="statCallsPerSession">-</div></div><div class="stat"><div class="muted">每会话证据数</div><div class="stat-value" id="statEvidencePerSession">-</div></div><div class="stat"><div class="muted">每会话自动候选</div><div class="stat-value" id="statCandidatesPerSession">-</div></div><div class="stat"><div class="muted">PR/MR 合并率</div><div class="stat-value" id="statMrMergeRate">-</div></div><div class="stat"><div class="muted">陈旧知识</div><div class="stat-value" id="statStaleKnowledge">-</div></div></div></div>
<div class="view active" data-view="dashboard"><div class="card"><h2>活跃告警 <span class="term">Active Alerts</span></h2><div id="alertSummary" class="key-meta">加载中...</div><div id="alertList"></div></div></div>
<div class="view active" data-view="dashboard"><div class="card"><div class="actions" style="justify-content:space-between"><div><h2 style="margin:0">14 天趋势</h2><div class="muted">Calls / Errors / No-hit / Candidates / Approval / Gaps / Active Users / Latency</div></div><button id="reloadDashboardTrends" class="secondary small">刷新趋势</button></div><div id="trendCharts" class="trend-grid" style="margin-top:14px"></div><div id="trendStatus" class="key-meta"></div></div></div>
<div class="view" data-view="access">
<div class="card">
<h2>管理员登录</h2>
<div id="adminLoginStatus" class="key-meta">加载登录状态...</div>
<div class="actions"><button id="adminLogout" class="danger">退出当前登录</button><button id="reloadAdminSessions" class="secondary">刷新登录会话</button><button id="revokeOtherAdminSessions" class="secondary">退出其他会话</button></div>
<div class="table-wrap"><table class="table"><thead><tr><th>用户</th><th>创建时间</th><th>最近活动</th><th>到期</th><th>来源</th><th>操作</th></tr></thead><tbody id="adminSessionsTable"></tbody></table></div>
<details style="margin-top:16px"><summary>兼容 / 应急 Admin API Key</summary><label>Admin API Key</label><input id="key" type="password" autocomplete="current-password" placeholder="ADMIN_API_KEY"><div class="muted">仅用于旧脚本或应急访问；浏览器日常管理建议使用上面的登录 Session。</div></details>
</div>
</div>
<div class="view" data-view="settings">
<div class="card">
<h2>运行参数</h2>
<div class="grid">
<div><label>Revision 保留数量</label><input id="retention" type="number" min="2"></div>
<div><label>Webhook 去重记录数</label><input id="dedupEntries" type="number" min="100"></div>
<div><label>Webhook 去重有效期（秒）</label><input id="dedupTtl" type="number" min="3600"></div>
</div>
<label>默认角色（Default Roles，逗号分隔）</label><input id="roles">
</div>
</div>
<div class="view" data-view="access">
<div class="card">
<h2>用户 API Keys</h2>
<div class="muted">用于 Codex / Claude Code 等客户端连接 MCP。新 Key 明文只显示一次，服务端仅保存哈希。</div>
<div class="grid">
<div><label>名称</label><input id="apiLabel" placeholder="例如：biao-codex"></div>
<div><label>用户 ID</label><input id="apiUserId" placeholder="例如：biao"></div>
<div><label>租户（Tenant）</label><input id="apiTenant" value="default"></div>
</div>
<label>角色（Roles，逗号分隔）</label><input id="apiRoles" value="developer, internal">
<div class="actions"><button id="createApiKey">创建 API Key</button><span id="apiKeyStatus"></span></div>
<div id="oneTimeKey" class="one-time">
<div><b>API Key 明文（管理员之后也可以再次查看）：</b></div>
<div class="actions"><input id="newApiKey" readonly><button id="copyApiKey" class="secondary">复制</button></div>
</div>
<div id="apiKeys" class="key-list"></div>
</div>
</div>
<div class="view" data-view="knowledge">
<div class="card">
<div class="page-heading"><h2>知识库检索 <span class="term">Knowledge / RAG</span></h2></div>
<div class="help-box"><b>用途：</b>查看哪些仓库已经进入知识索引，并测试 Codex 实际会搜到什么。<br><b>推荐流程：</b>输入问题 → 测试检索 → 查看结果分数；如果刚合并知识但搜不到，可点“刷新索引状态”确认仓库 revision。<br><b>生命周期审计：</b>用于发现过期、废弃或待复审知识，不会自动删除内容。</div>
<div id="knowledgeScoreSummary" class="key-meta">Top1 Score 观测加载中...</div>
<div id="knowledgeSources" class="knowledge-sources"></div>
<div class="grid">
<div style="grid-column:span 2"><label>搜索问题</label><input id="knowledgeQuery" placeholder="例如：OTA 升级断电后如何恢复？"></div>
<div><label>知识仓库（Repository，可选）</label><input id="knowledgeRepo" placeholder="例如 rd-knowledges"></div>
</div>
<div class="actions"><button id="searchKnowledge">测试检索</button><button id="reloadKnowledge" class="secondary">刷新索引状态</button><span id="knowledgeStatus"></span></div>
<div id="knowledgeResults"></div>
<h3>知识生命周期审计 <span class="term">Lifecycle Audit</span></h3><div class="muted">提示维护风险；deprecated / superseded / expired / archived 默认不参与正常搜索，draft 会降权。风险项可生成待审核知识候选。</div><div id="knowledgeAuditSummary" class="key-meta"></div><div class="table-wrap"><table class="table"><thead><tr><th>Risk</th><th>Repository</th><th>Path</th><th>Owner</th><th>Status</th><th>Last Reviewed</th><th>Review Cycle</th><th>Review Due</th><th>Valid Until</th><th>Action</th></tr></thead><tbody id="knowledgeAuditTable"></tbody></table></div>
</div>
</div>
<div class="view" data-view="tools"><div class="card"><h2>工具注册表 <span class="term">Tool Registry</span></h2><div class="muted">Git 管理的工具元数据；只展示 credential reference，不保存或展示凭据值。</div><div class="grid"><div style="grid-column:span 2"><label>搜索</label><input id="toolQuery" placeholder="例如：git / jenkins / test farm"></div><div><label>Client（可选）</label><input id="toolClient" placeholder="codex"></div></div><div class="actions"><button id="searchTools">搜索工具</button><button id="reloadTools" class="secondary">全部</button><span id="toolStatus"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>Tool</th><th>Repository</th><th>Type</th><th>Capabilities</th><th>Environments</th><th>Permissions</th><th>Endpoints</th><th>Auth Reference</th><th>Owner</th></tr></thead><tbody id="toolsTable"></tbody></table></div></div></div>
<div class="view" data-view="evaluation"><div class="card"><h2>评测 <span class="term">Evaluation</span></h2><div class="muted">运行仓库内 EVALUATION.yaml，查看历史结果、Retrieval Hit@K/MRR 与 baseline regression。</div><div class="grid"><div><label>仓库（Repository）</label><input id="evaluationRepo" placeholder="rd-skills"></div><div><label>Revision（可选）</label><input id="evaluationRevision" placeholder="当前 active revision"></div><div><label>Baseline Revision（可选）</label><input id="evaluationBaseline" placeholder="例如上一稳定 revision"></div><div><label>Suite</label><select id="evaluationSuite"><option value="">先加载评测集</option></select></div></div><div class="actions"><button id="loadEvaluationSuites" class="secondary">加载评测集</button><button id="runEvaluation">运行评测</button><button id="reloadEvaluationRuns" class="secondary">刷新历史</button><label><input id="evaluationFailedOnly" type="checkbox"> 仅失败/回归</label><span id="evaluationStatus"></span></div><div id="evaluationTrend" class="key-meta"></div><div id="evaluationDetail" class="trace-detail" style="display:none"></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>Repository</th><th>Suite</th><th>Revision</th><th>Pass</th><th>Regression</th><th>Retrieval</th></tr></thead><tbody id="evaluationRunsTable"></tbody></table></div></div></div>
<div class="view" data-view="feedback"><div class="card"><h2>用户反馈 <span class="term">Feedback</span></h2><div class="muted">查看客户端通过 submit_feedback 回流的正/负反馈。</div><div class="actions"><input id="feedbackSearch" placeholder="搜索 User / Rating / Target / Reason"><button id="feedbackSearchButton" class="secondary">搜索</button><button id="feedbackPrev" class="secondary">上一页</button><button id="feedbackNext" class="secondary">下一页</button><span id="feedbackPage" class="muted"></span></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>User</th><th>Rating</th><th>Target</th><th>Reason</th><th>Trace</th></tr></thead><tbody id="feedbackTable"></tbody></table></div></div></div>
<div class="view" data-view="settings">
<div class="card">
<div class="page-heading"><h2>仓库配置 <span class="term">Repositories</span></h2></div>
<div class="help-box"><b>用途：</b>配置 Skill/Knowledge 仓库、同步方式和发布目标。保存后会立即应用并触发同步。<br><b>注意：</b>这里不要填写真实 GitHub/GitLab Token；凭据请通过环境变量或 Docker Secret 提供。</div>
<div class="muted">编辑仓库运行配置。Git 密钥/Token 推荐继续使用环境变量或 Docker Secret；这里保存的是引用和非敏感配置。</div>
<label>仓库配置 JSON（Repository JSON）</label><textarea id="repos"></textarea>
<label>项目注册表 JSON（Project Registry JSON）</label><textarea id="projects"></textarea>
<div class="actions"><button id="save">保存并立即应用</button><button id="reload" class="secondary">重新加载</button><span id="status"></span></div>
</div>
<div class="card">
<h2>启动检查与凭据状态 <span class="term">Bootstrap / Secrets</span></h2><div id="bootstrap" class="muted">加载中...</div>
</div>
<div class="card"><h2>数据治理 <span class="term">Data Governance</span></h2><div class="muted">本地安全上限：敏感原文类别默认不采集、不持久化；这里只读展示当前策略。</div><div class="table-wrap"><table class="table"><thead><tr><th>Class</th><th>Collect</th><th>Persist</th><th>Retention</th><th>Access</th><th>Audit</th></tr></thead><tbody id="dataGovernanceTable"></tbody></table></div><div id="dataGovernanceInvariants" class="key-meta"></div></div>
</div>
</div>
<div id="adminModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="adminModalTitle"><div class="modal-panel"><h3 id="adminModalTitle"></h3><div id="adminModalMessage" class="modal-message"></div><div id="adminModalFields" class="modal-fields"></div><div class="modal-actions"><button id="adminModalCancel" class="secondary">取消</button><button id="adminModalConfirm">确认</button></div></div></div><div id="toastStack" class="toast-stack" aria-live="polite"></div>
<script>
const key = document.getElementById("key");
const originalAdminPath=location.pathname;const historyModule=originalAdminPath.startsWith("/admin/")?originalAdminPath.slice(7):"";if(historyModule){const tab=historyModule.startsWith("observability")?"observability":historyModule.startsWith("review")?"review":historyModule.startsWith("gaps")?"gaps":historyModule.startsWith("governance")?"governance":"dashboard";history.replaceState(null,"",location.pathname+location.search);navigateTo(tab,{},true)}
key.value = sessionStorage.getItem("skillHubAdminKey") || "";
key.addEventListener("change",()=>sessionStorage.setItem("skillHubAdminKey",key.value));
const statusEl=document.getElementById("status");
const apiKeyStatus=document.getElementById("apiKeyStatus");
const knowledgeStatus=document.getElementById("knowledgeStatus");
const evaluationStatus=document.getElementById("evaluationStatus");
function statusLabel(status){return ({pending:"待审核",approved:"已批准",rejected:"已拒绝",publishing:"等待合并",publish_failed:"发布失败",published:"已发布",active:"待处理",ignored:"已忽略",resolved:"已解决",current:"当前",outdated:"已过期",unknown:"未知"})[status]||status}
function setupTooltips(){
 const tips={
  reloadDashboardTrends:"重新计算并刷新最近 14 天趋势；只读取统计数据，不会修改仓库。",
  key:"管理员 API Key。仅保存在当前浏览器 sessionStorage，用于访问受保护的管理接口。",
  retention:"保留的仓库历史 Revision 数量；数量越大，可回滚范围越长，但会占用更多磁盘空间。",
  dedupEntries:"Webhook 去重记录的最大条数，用于避免同一个事件被重复处理。",
  dedupTtl:"Webhook 去重记录的有效时间（秒）；过期后相同事件 ID 可再次被处理。",
  roles:"未显式指定角色时使用的默认角色集合。",
  apiLabel:"给 API Key 起一个便于识别的名称，例如某位开发者或某台 Codex 客户端。",
  apiUserId:"该 API Key 代表的用户 ID，会记录到审计、反馈和会话数据中。",
  apiTenant:"租户标识；单团队部署通常保持 default 即可。",
  apiRoles:"该 API Key 拥有的角色权限，影响可读取仓库及可执行操作。",
  createApiKey:"创建一个新的客户端 API Key。管理员之后可以在此页面再次查看明文。",
  copyApiKey:"复制当前显示的 API Key 明文。",
  toolQuery:"按工具名称、能力等关键词筛选 Tool Registry。",
  toolClient:"可按客户端类型筛选工具，例如 codex；留空表示不过滤客户端。",
  searchTools:"按当前条件查询工具注册表；只读取数据。",
  reloadTools:"清空工具搜索关键词并重新显示全部工具。",
  evaluationRepo:"选择要运行 EVALUATION.yaml 的仓库。",
  evaluationRevision:"指定被评测的 Revision；留空时通常使用当前 active revision。",
  evaluationBaseline:"可选的基线 Revision，用于判断本次评测是否发生回归。",
  evaluationSuite:"选择仓库 EVALUATION.yaml 中定义的评测集。",
  loadEvaluationSuites:"读取所选仓库可用的评测集，不会执行评测。",
  runEvaluation:"执行所选评测集，可能需要一些时间；结果会写入评测历史。",
  reloadEvaluationRuns:"重新读取历史评测结果。",
  evaluationFailedOnly:"只显示失败或相对 baseline 出现回归的评测记录。",
  reloadObservability:"刷新会话、MCP 调用、Hook、自动候选和运行健康数据；不会修改业务数据。",
  sessionFilterUser:"只查看指定用户产生的 Codex/Claude Code 会话。",
  sessionFilterRepo:"只查看与指定 Repository 相关的会话。",
  sessionFilterEvent:"按客户端生命周期 Hook 事件筛选会话。",
  sessionFilterRuntime:"current 表示运行时版本符合预期，outdated 表示客户端/运行时版本可能过旧。",
  sessionFilterFrom:"只查看该时间之后的会话。",
  sessionFilterTo:"只查看该时间之前的会话。",
  applySessionFilters:"应用当前会话筛选条件。",
  clearSessionFilters:"清空所有会话筛选条件并重新加载。",
  clientEventSearch:"搜索客户端 Hook 事件中的用户、Session、Event 或 Metadata。",
  clientEventSearchButton:"按输入条件搜索客户端 Hook 事件。",
  detectionSearch:"搜索系统是否创建自动知识候选及其判定原因。",
  detectionSearchButton:"按输入条件搜索自动候选判定记录。",
  qualityWindowDays:"自动候选质量统计窗口；例如 7 表示统计最近 7 天。",
  reloadQuality:"重新计算自动候选的 useful / false-positive 等质量趋势。",
  candidateFilterStatus:"按候选状态筛选；默认同时展示待处理和历史记录。",
  candidateFilterType:"按 Candidate 类型筛选 Knowledge 或 Skill。",
  candidateFilterCollection:"Skill 分类：rd-skills 为团队正式共享，custom-skills 为自定义 Skill。",
  candidateFilterRepo:"只查看指定 Repository 的 Candidate。",
  candidateFilterSource:"按候选来源筛选，例如 codex-summary。",
  candidateFilterReviewer:"按审核人筛选 Candidate。",
  candidateFilterAuto:"区分系统自动产生和人工创建的 Candidate。",
  candidateFilterQ:"在候选标题、正文和 Candidate ID 中搜索。",
  applyCandidateFilters:"应用当前候选审核筛选条件。",
  bulkApproveCandidates:"将已勾选的待审核 Candidate 批量批准；批准后仍需发布 PR/MR 才会进入对应正式仓库。",
  bulkRejectCandidates:"将已勾选候选批量拒绝，并记录审核原因。",
  manualCandidateTitle:"手工创建 Candidate 时填写标题。",
  manualCandidateRepo:"目标 Repository，可留空；系统会根据 Candidate 类型，从 knowledge_publishing.project_path 或 skill_publishing.project_path 自动选择。显式填写时必须与对应发布目标一致。",
  manualCandidatePath:"Candidate 建议写入路径，例如 docs/knowledge/topic.md 或 domain/name/SKILL.md。",
  manualCandidateContent:"待审核的 Knowledge 正文或完整 SKILL.md；创建后仍可在 Review Detail 中继续编辑。",
  createManualCandidate:"手工创建一条待审核 Candidate，不会直接发布到 Git。",
  feedbackSearch:"搜索用户反馈中的用户、评分、目标或原因。",
  feedbackSearchButton:"按当前关键词搜索用户反馈。",
  searchKnowledge:"使用和客户端相同的知识检索能力测试当前问题会命中哪些内容。",
  reloadKnowledge:"重新读取知识源和索引状态；不会强制修改知识内容。",
  save:"保存 Repository / Project 配置并立即应用；可能触发仓库重新同步。",
  reload:"放弃尚未保存的页面编辑，重新读取服务端当前配置。",
  curateGaps:"使用可选的 LLM Curator 生成知识缺口聚类建议；不会自动发布知识。"
 };
 for(const [id,text] of Object.entries(tips)){const el=document.getElementById(id);if(el)el.title=text}
 const tabTips={dashboard:"查看整体运行情况、趋势、告警和仓库健康状态。",observability:"排查客户端会话、MCP 调用和运行异常。",knowledge:"查看 RAG 索引并测试知识检索结果。",tools:"查看客户端可使用的工具注册信息。",governance:"查看 Skill / Prompt / Agent / Knowledge 的质量与治理状态。",evaluation:"运行并查看仓库评测与回归结果。",review:"统一审核 Knowledge / Skill Candidate，并在批准后发布 PR/MR。",feedback:"查看用户对 Team Skill Hub 返回结果的正负反馈。",gaps:"查看未命中问题形成的知识缺口，并转为待审核 Knowledge Candidate。",access:"管理管理员认证和客户端 API Key。",settings:"修改仓库、项目、同步与数据治理相关配置。"};
 document.querySelectorAll(".tab").forEach(el=>{if(tabTips[el.dataset.tab])el.title=tabTips[el.dataset.tab]});
 const statTips={statCalls:"统计窗口内 MCP 调用总次数。",statFailures:"MCP 调用失败次数。",statLatency:"MCP 调用平均耗时。",statPending:"当前待人工审核的 Candidate 数量。",statActiveUsers:"近期产生有效活动的用户数。",statSessions:"记录到的客户端会话数量。",statNoHit:"知识检索未命中的比例。",statApproval:"Candidate 被批准的比例。",statAutoCandidates:"由系统自动检测并创建的 Candidate 数量。",statPublished:"已经发布并进入发布流程的 Candidate 数量。",statP95Latency:"95% 的 MCP 调用耗时低于该值，用于观察长尾性能。",statMcpErrorRate:"MCP 调用发生错误的比例。",statNegativeFeedback:"用户提交的负反馈数量。",statStaleKnowledge:"超过复审周期或有效期的知识数量。"};
 for(const [id,text] of Object.entries(statTips)){const el=document.getElementById(id);if(el?.parentElement)el.parentElement.title=text}
}
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
const pageState={feedback:{}};
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
const migratedModuleRoutes={observability:"/admin/observability",review:"/admin/review",gaps:"/admin/gaps",governance:"/admin/governance"};
function navigateTo(tab,params={},replace=false){
 const stableRoute=migratedModuleRoutes[tab];if(stableRoute){location.href=stableRoute;return}
 const next=routeHash(tab,params);if(location.hash===next){applyAdminRoute();return}
 if(replace)history.replaceState(null,"",next);else history.pushState(null,"",next);applyAdminRoute();
}
function activateTab(name,params=new URLSearchParams()){
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===name));
  document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.dataset.view===name));
  if(name==="dashboard")loadDashboardTrends();
 if(name==="tools")loadTools();
 if(name==="evaluation")loadEvaluationRuns();
 if(name==="feedback"){document.getElementById("feedbackSearch").value=params.get("feedbackQ")||"";loadFeedback();}
}
function applyAdminRoute(){const route=parseAdminRoute();const stableRoute=migratedModuleRoutes[route.tab];if(stableRoute){location.replace(stableRoute);return}activateTab(route.tab,route.params)}
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
async function requestJson(url,options={}){
 const response=await fetch(url,{...options,headers:{...headers(),...(options.headers||{})}});
 const text=await response.text();let data;try{data=text?JSON.parse(text):{}}catch{data={error:"请求 "+url+" 返回了非 JSON 响应（HTTP "+response.status+"）"}}
 if(!response.ok)throw new Error(data.error||("请求 "+url+" 失败（HTTP "+response.status+"）"));return data;
}
async function loadDashboardSummary(){
 const [or,kr,hr]=await Promise.all([fetch("/admin/api/observability?limit=1",{headers:headers()}),fetch("/admin/api/kpis",{headers:headers()}),fetch("/admin/api/health",{headers:headers()})]);
 const obs=await or.json();const kpi=await kr.json();const health=await hr.json();
 if(or.ok){document.getElementById("statCalls").textContent=obs.summary.total;document.getElementById("statFailures").textContent=obs.summary.failed;document.getElementById("statLatency").textContent=Math.round(obs.summary.avgLatencyMs)+" ms";}
 if(kr.ok){document.getElementById("statActiveUsers").textContent=kpi.activeUsers;document.getElementById("statSessions").textContent=kpi.sessions;document.getElementById("statNoHit").textContent=Math.round(kpi.noHitRate*100)+"%";document.getElementById("statApproval").textContent=Math.round(kpi.approvalRate*100)+"%";document.getElementById("statAutoCandidates").textContent=kpi.autoCandidates;document.getElementById("statPublished").textContent=kpi.publishedCandidates;document.getElementById("statDetectorCreated").textContent=kpi.detectorCreated;document.getElementById("statDetectorSkipped").textContent=kpi.detectorSkipped;document.getElementById("statAutoAccept").textContent=Math.round(kpi.autoAcceptanceRate*100)+"%";document.getElementById("statAutoReject").textContent=Math.round(kpi.autoRejectionRate*100)+"%";document.getElementById("statQualityCoverage").textContent=Math.round(kpi.autoQualityLabelCoverage*100)+"%";document.getElementById("statUsefulRate").textContent=Math.round(kpi.autoUsefulRate*100)+"%";document.getElementById("statFalsePositiveRate").textContent=Math.round(kpi.autoFalsePositiveRate*100)+"%";document.getElementById("statDuplicateFiltered").textContent=kpi.duplicateFiltered;document.getElementById("statLowValueFiltered").textContent=kpi.lowValueFiltered;document.getElementById("statP95Latency").textContent=Math.round(kpi.p95LatencyMs)+" ms";document.getElementById("statMcpErrorRate").textContent=Math.round(kpi.mcpErrorRate*100)+"%";document.getElementById("statNegativeFeedback").textContent=Math.round(kpi.negativeFeedbackRate*100)+"%";document.getElementById("statCallsPerSession").textContent=kpi.avgCallsPerSession.toFixed(1);document.getElementById("statEvidencePerSession").textContent=kpi.avgEvidencePerSession.toFixed(1);document.getElementById("statCandidatesPerSession").textContent=kpi.autoCandidatesPerSession.toFixed(2);document.getElementById("statMrMergeRate").textContent=Math.round(kpi.mergeRequestMergeRate*100)+"%";document.getElementById("statStaleKnowledge").textContent=kpi.staleKnowledgeCount;}
 if(hr.ok)document.getElementById("statPending").textContent=health.candidates.pending;
 await loadAlerts();
}
async function loadDashboardTrends(){
 const status=document.getElementById("trendStatus");const root=document.getElementById("trendCharts");status.textContent="加载趋势...";const r=await fetch("/admin/api/dashboard-trends?days=14",{headers:headers()});const data=await r.json();
 if(!r.ok){status.textContent=data.error||"趋势加载失败";status.className="error key-meta";return}
 const configs=[["MCP Calls","calls",""],["Errors","errors",""],["No-hit","noHits",""],["Candidates","candidates",""],["Approvals","approvals",""],["Gap Signals","gapSignals",""],["Active Users","activeUsers",""],["Avg Latency","avgLatencyMs"," ms"]];root.replaceChildren();
 for(const [title,key,suffix] of configs){const values=data.rows.map(row=>Number(row[key]||0));const latest=values.at(-1)||0;const peak=Math.max(0,...values);const card=document.createElement("div");card.className="trend-card";const header=document.createElement("div");header.className="trend-header";const left=document.createElement("div");const name=document.createElement("div");name.className="trend-title";name.textContent=title;const meta=document.createElement("div");meta.className="trend-meta";meta.textContent=data.rows[0]?.date+" → "+data.rows.at(-1)?.date+" · peak "+peak+suffix;left.append(name,meta);const value=document.createElement("div");value.className="trend-value";value.textContent=latest+suffix;header.append(left,value);card.appendChild(header);
  if(values.length){const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 280 72");svg.setAttribute("preserveAspectRatio","none");svg.classList.add("trend-svg");const max=Math.max(1,...values);const points=values.map((v,index)=>{const x=values.length===1?140:index*280/(values.length-1);const y=66-(v/max)*58;return x.toFixed(1)+","+y.toFixed(1)}).join(" ");const base=document.createElementNS("http://www.w3.org/2000/svg","line");base.setAttribute("x1","0");base.setAttribute("x2","280");base.setAttribute("y1","66");base.setAttribute("y2","66");base.setAttribute("stroke","currentColor");base.setAttribute("opacity",".12");const line=document.createElementNS("http://www.w3.org/2000/svg","polyline");line.setAttribute("points",points);line.setAttribute("fill","none");line.setAttribute("stroke","currentColor");line.setAttribute("stroke-width","2.5");line.setAttribute("vector-effect","non-scaling-stroke");svg.append(base,line);card.appendChild(svg)}else{const empty=document.createElement("div");empty.className="trend-empty";empty.textContent="暂无趋势数据";card.appendChild(empty)}root.appendChild(card)}
 status.textContent=data.days+" 天 · "+data.semantics.noHits+" · "+data.semantics.approvals;status.className="key-meta";
}
async function loadAlerts(){
 const summary=document.getElementById("alertSummary");const root=document.getElementById("alertList");const r=await fetch("/admin/api/alerts",{headers:headers()});const data=await r.json();
 root.replaceChildren();if(!r.ok){summary.textContent=data.error||"告警加载失败";summary.className="error key-meta";return}
 summary.textContent=data.counts.critical+" critical · "+data.counts.warning+" warning · "+fmtTime(data.generatedAt);summary.className="key-meta";
 if(!data.alerts.length){const ok=document.createElement("div");ok.className="ok key-meta";ok.textContent="当前没有活动告警";root.appendChild(ok);return}
 for(const item of data.alerts){const card=document.createElement("div");card.className="review-card";const title=document.createElement("b");title.textContent=item.severity.toUpperCase()+" · "+item.title;const meta=document.createElement("div");meta.className="key-meta "+(item.severity==="critical"?"error":"");meta.textContent=item.category+" · "+item.detail;card.append(title,meta);root.appendChild(card)}
}

async function loadFeedback(){
 const routeParams=parseAdminRoute().params;const params=new URLSearchParams({limit:"50"});const q=document.getElementById("feedbackSearch").value.trim();if(q)params.set("q",q);if(routeParams.get("feedbackCursor"))params.set("cursor",routeParams.get("feedbackCursor"));
 const r=await fetch("/admin/api/feedback?"+params.toString(),{headers:headers()});const data=await r.json();if(!r.ok)return;
 const body=document.getElementById("feedbackTable");body.replaceChildren();renderPager("feedback",data.page,"feedback");
 for(const item of data.feedback){const tr=document.createElement("tr");[fmtTime(item.ts),item.actorId,item.rating,item.target||item.targetType,item.reason||"",item.traceId||""].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.appendChild(td)});body.appendChild(tr)}
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
  const publishHint=document.createElement("div");publishHint.className="muted";publishHint.textContent="审核通过后通过 GitLab MR 或 GitHub PR 发布；Token 仅从环境变量读取，GitHub Git 内容写入可通过 SSH key 完成。";
  const publishConfig=source.publishing?.config||{enabled:false,provider:"gitlab",baseUrl:"",projectPath:"",tokenEnv:"GITLAB_WRITE_TOKEN",targetBranch:"main",branchPrefix:"skill-hub-knowledge"};
  const publishTop=document.createElement("div");publishTop.className="key-row-top";
  const publishEnabledLabel=document.createElement("label");publishEnabledLabel.className="inline-check";
  const publishEnabled=document.createElement("input");publishEnabled.type="checkbox";publishEnabled.checked=Boolean(publishConfig.enabled);
  publishEnabledLabel.append(publishEnabled,document.createTextNode("启用 Knowledge 发布"));
  const publishState=document.createElement("span");publishState.className="badge "+(source.publishing?.tokenConfigured?"ok":"");
  publishState.textContent=source.publishing?.tokenConfigured?"Write token ready":"Write token not configured";
  publishTop.append(publishEnabledLabel,publishState);
  const publishGrid=document.createElement("div");publishGrid.className="knowledge-config-grid";
  function publishField(labelText,value){
   const wrap=document.createElement("div");const label=document.createElement("label");label.textContent=labelText;
   const input=document.createElement("input");input.value=value||"";wrap.append(label,input);publishGrid.appendChild(wrap);return input;
  }
  const providerWrap=document.createElement("div");const providerLabel=document.createElement("label");providerLabel.textContent="Provider";const provider=document.createElement("select");for(const value of ["gitlab","github"]){const option=document.createElement("option");option.value=value;option.textContent=value;option.selected=publishConfig.provider===value;provider.appendChild(option)}providerWrap.append(providerLabel,provider);publishGrid.appendChild(providerWrap);
  const baseUrl=publishField("Base URL",publishConfig.baseUrl||"");
  const projectPath=publishField("Project Path",publishConfig.projectPath||"");
  const tokenEnv=publishField("Write Token Env",publishConfig.tokenEnv||"GITLAB_WRITE_TOKEN");
  const targetBranch=publishField("Target Branch",publishConfig.targetBranch||"main");
  const branchPrefix=publishField("Branch Prefix",publishConfig.branchPrefix||"skill-hub-knowledge");
  const publishActions=document.createElement("div");publishActions.className="actions";
  const savePublishing=document.createElement("button");savePublishing.className="secondary small";savePublishing.textContent="保存发布配置";
  savePublishing.onclick=()=>updatePublishingConfig(source.repository,{
   enabled:publishEnabled.checked,provider:provider.value,baseUrl:baseUrl.value.trim(),projectPath:projectPath.value.trim(),
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
 const [r,ar,sr]=await Promise.all([fetch("/admin/api/knowledge",{headers:headers()}),fetch("/admin/api/knowledge/lifecycle-audit",{headers:headers()}),fetch("/analytics/summary?limit=50",{headers:headers()})]);const data=await r.json();const audit=await ar.json();const scoreSummary=await sr.json();
 if(!r.ok){knowledgeStatus.textContent=data.error||"加载失败";knowledgeStatus.className="error";return}
 renderKnowledgeSources(data.sources);knowledgeStatus.textContent="";knowledgeStatus.className="";
 const scoreEl=document.getElementById("knowledgeScoreSummary");
 if(sr.ok){const s=scoreSummary.knowledgeTopScore||{};const threshold=scoreSummary.knowledgeMatchMinScore;const fmt=value=>typeof value==="number"?value.toFixed(2):"-";scoreEl.textContent="Matched 阈值："+(typeof threshold==="number"?fmt(threshold):"关闭（仅观测）")+" · Top1 samples "+(s.count||0)+" · min "+fmt(s.min)+" · p25 "+fmt(s.p25)+" · p50 "+fmt(s.p50)+" · p75 "+fmt(s.p75)+" · p90 "+fmt(s.p90)+" · max "+fmt(s.max)}else{scoreEl.textContent="Top1 Score 观测加载失败"}
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
  const toggle=document.createElement("button");toggle.className="secondary small";toggle.textContent=item.enabled?"禁用":"启用";toggle.title=item.enabled?"禁用后使用该 API Key 的客户端将无法继续访问 MCP；Key 记录仍保留。":"重新启用该 API Key，使对应客户端恢复访问。";
  toggle.onclick=()=>updateApiKey(item.id,{enabled:!item.enabled});
  const reveal=document.createElement("button");reveal.className="secondary small";reveal.textContent="查看";reveal.disabled=!item.revealable;reveal.title=item.revealable?"解密并显示该 API Key 明文；仅管理员可执行。":"这是旧版本创建的 Key，当时未保存可解密密文；请先重新生成一次。";reveal.onclick=()=>revealApiKey(item.id,item.label);
  const rotate=document.createElement("button");rotate.className="secondary small";rotate.textContent="重新生成";rotate.title="生成新的 API Key 并立即使旧 Key 失效；新 Key 之后仍可由管理员查看。";rotate.onclick=()=>rotateApiKey(item.id,item.label);
  const remove=document.createElement("button");remove.className="danger small";remove.textContent="删除";
  remove.title="永久删除该 API Key；对应客户端会立即失效且无法恢复。";remove.onclick=()=>deleteApiKey(item.id);
  actions.append(toggle,reveal,rotate,remove);top.append(title,actions);
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
async function revealApiKey(id,label){
 const r=await fetch("/admin/api/api-keys/"+encodeURIComponent(id)+"/reveal",{headers:headers(false)});const data=await r.json();
 if(!r.ok){apiKeyStatus.textContent=data.error||"查看失败";apiKeyStatus.className="error";toast(data.error||"查看失败","error");return}
 document.getElementById("newApiKey").value=data.apiKey;document.getElementById("oneTimeKey").style.display="block";
 apiKeyStatus.textContent="正在查看："+label;apiKeyStatus.className="ok";
}
async function rotateApiKey(id,label){
 const confirmed=await modalForm({title:"重新生成 API Key",message:"将为「"+label+"」生成新 Key，并立即使旧 Key 失效。新 Key 之后管理员仍可再次查看。",danger:true,confirmText:"重新生成"});if(!confirmed)return;
 const r=await fetch("/admin/api/api-keys/"+encodeURIComponent(id)+"/rotate",{method:"POST",headers:headers(false)});const data=await r.json();
 if(!r.ok){apiKeyStatus.textContent=data.error||"重新生成失败";apiKeyStatus.className="error";toast(data.error||"重新生成失败","error");return}
 document.getElementById("newApiKey").value=data.apiKey;document.getElementById("oneTimeKey").style.display="block";
 apiKeyStatus.textContent="已重新生成，旧 Key 已失效";apiKeyStatus.className="ok";toast("API Key 已重新生成");await loadApiKeys();
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
 evaluationStatus.textContent="加载评测集...";
 const r=await fetch("/repositories/"+encodeURIComponent(repo)+"/evaluations/suites?"+params.toString(),{headers:headers()});const data=await r.json();
 if(!r.ok){evaluationStatus.textContent=data.error||"加载评测集 失败";evaluationStatus.className="error";return}
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
async function loadAdminLogin(){
 const status=document.getElementById("adminLoginStatus"),body=document.getElementById("adminSessionsTable");if(!status||!body)return;body.replaceChildren();
 const current=await fetch("/admin/api/auth/session",{headers:headers(false)});const data=await current.json();if(!current.ok){status.textContent=data.error||"未登录";status.className="error key-meta";return}
 status.textContent="认证方式: "+data.authType+" · 用户: "+(data.session?.username||data.username||"admin");status.className="ok key-meta";
 const r=await fetch("/admin/api/auth/sessions",{headers:headers(false)});const d=await r.json();if(!r.ok){status.textContent=d.error||"登录会话加载失败";status.className="error key-meta";return}
 for(const item of d.sessions||[]){const tr=document.createElement("tr");const source=[item.remoteAddress||"-",item.userAgent||"-"].join(" · ");[item.username+(item.current?" · 当前":""),fmtTime(item.createdAt),fmtTime(item.lastSeenAt),fmtTime(item.expiresAt),source].forEach(v=>{const td=document.createElement("td");td.textContent=String(v);tr.appendChild(td)});const action=document.createElement("td");const button=document.createElement("button");button.className=item.current?"danger small":"secondary small";button.textContent=item.current?"退出":"撤销";button.onclick=async()=>{const x=await fetch("/admin/api/auth/sessions/"+encodeURIComponent(item.id),{method:"DELETE",headers:headers(false)});if(item.current&&x.ok){location.assign("/admin/login");return}await loadAdminLogin()};action.appendChild(button);tr.appendChild(action);body.appendChild(tr)}
 if(!(d.sessions||[]).length){const tr=document.createElement("tr");tr.innerHTML='<td colspan="6" class="muted">当前通过 API Key / development 模式访问，没有浏览器 Session。</td>';body.appendChild(tr)}
}
async function logoutAdmin(){await fetch("/admin/api/auth/logout",{method:"POST",headers:headers(false)});sessionStorage.removeItem("skillHubAdminKey");location.assign("/admin/login")}
async function revokeOtherAdminSessions(){await fetch("/admin/api/auth/sessions/revoke-others",{method:"POST",headers:headers(false)});await loadAdminLogin()}
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
 await loadAdminLogin();
 await loadApiKeys();
 await loadKnowledge();
 await loadTools(false);
 await loadEvaluationRuns();
 await loadDashboardSummary();
 await loadFeedback();
 await loadDataGovernance();
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
document.getElementById("reloadDashboardTrends").onclick=()=>withBusy(document.getElementById("reloadDashboardTrends"),loadDashboardTrends,"刷新中...");
document.getElementById("feedbackSearchButton").onclick=()=>{replaceRouteQuery({feedbackQ:document.getElementById("feedbackSearch").value.trim(),feedbackCursor:null});loadFeedback()};
document.getElementById("feedbackPrev").onclick=()=>{replaceRouteQuery({feedbackCursor:pageState.feedback.previousCursor});loadFeedback()};
document.getElementById("feedbackNext").onclick=()=>{replaceRouteQuery({feedbackCursor:pageState.feedback.nextCursor});loadFeedback()};
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
document.getElementById("adminLogout").onclick=logoutAdmin;
document.getElementById("reloadAdminSessions").onclick=loadAdminLogin;
document.getElementById("revokeOtherAdminSessions").onclick=revokeOtherAdminSessions;
setupTooltips();
load();
</script>
</body></html>`;

const ADMIN_OBSERVABILITY_CSS = `body{margin:0;background:#f5f7fb;color:#172033;font:14px system-ui,sans-serif}.wrap{max-width:1180px;margin:auto;padding:28px}.card{background:#fff;border:1px solid #e4e8f0;border-radius:12px;padding:18px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}label{font-size:12px;font-weight:700}.field-help{display:block;margin-top:2px;color:#667085;font-size:11px;font-weight:400;line-height:1.35}input,select,button{box-sizing:border-box;padding:9px;border:1px solid #ccd3df;border-radius:7px;font:inherit}input,select{width:100%;margin-top:4px}button{background:#2457d6;color:#fff;border:0;font-weight:700;cursor:pointer}.secondary{background:#edf1f8;color:#23324d}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:10px;border-bottom:1px solid #edf0f5;white-space:nowrap}.table tbody tr{cursor:pointer}.table tbody tr:hover{background:#f8fbff}.muted{color:#667085}.error{color:#b42318}.empty{padding:28px;text-align:center;color:#667085}.module-index{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:18px}.module-entry{display:block;color:inherit;text-decoration:none;background:#fff;border:1px solid #e4e8f0;border-radius:12px;padding:16px;min-height:100px}.module-entry:hover{border-color:#2457d6}.module-entry h2{margin:0 0 8px;font-size:16px}.detail{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.detail div{background:#f8fafc;padding:10px;border-radius:7px}.raw{white-space:pre-wrap;overflow:auto;background:#f8fafc;padding:12px;max-height:520px;font:12px monospace}@media(max-width:800px){.grid,.detail,.module-index{grid-template-columns:1fr 1fr}}@media(max-width:520px){.grid,.detail,.module-index{grid-template-columns:1fr}}`;

export const ADMIN_OBSERVABILITY_INDEX_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>运行观测</title><style>${ADMIN_OBSERVABILITY_CSS}</style></head><body><main class="wrap"><p><a href="/admin">← Admin</a></p><h1>运行观测</h1><p class="muted">模块摘要与入口。列表数据仅在二级页面按需加载。</p><div class="module-index" data-admin-module-index="observability"><a class="module-entry" href="/admin/observability/sessions"><h2>Codex 会话</h2><p>服务端筛选、分页和时间线详情</p></a><a class="module-entry" href="/admin/observability/hooks"><h2>Hook / 客户端事件</h2><p>生命周期事件和详情</p></a><a class="module-entry" href="/admin/observability/candidate-detections"><h2>自动候选判定</h2><p>检测结果、原因和证据</p></a><a class="module-entry" href="/admin/observability/mcp-calls"><h2>MCP 调用</h2><p>工具调用、状态和延迟</p></a><a class="module-entry" href="/admin/observability/reuse"><h2>Knowledge / Skill Reuse</h2><p>由 MCP 调用派生的复用链路</p></a><a class="module-entry" href="/admin/observability/failures"><h2>错误与失败</h2><p>失败 MCP 调用（当前范围）</p></a></div></main><script>sessionStorage.getItem("skillHubAdminKey")</script></body></html>`;

export const ADMIN_OBSERVABILITY_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>运行观测</title><style>${ADMIN_OBSERVABILITY_CSS}</style></head><body><main class="wrap" id="app"><p><a href="/admin/observability">← 运行观测</a></p><h1 id="title">运行观测</h1><div id="content" class="card">加载中...</div></main><script>
const keyName="skillHubAdminKey";const headers=()=>{const k=sessionStorage.getItem(keyName);return k?{"x-skill-hub-admin-key":k}:{};};
async function readResponse(response,endpoint){const type=response.headers.get("content-type")||"";let body;try{body=type.includes("json")?await response.json():await response.text()}catch{body="Unable to read response"}if(!response.ok){const detail=typeof body==="string"?body:(body?.error||JSON.stringify(body));throw new Error(endpoint+" HTTP "+response.status+": "+detail)}return body}
async function requestJson(endpoint,options={}){return readResponse(await fetch(endpoint,{...options,headers:{...headers(),...(options.headers||{})}}),endpoint)}
const resourceNames={sessions:"Codex 会话",hooks:"Hook / 客户端事件","candidate-detections":"自动候选判定","mcp-calls":"MCP 调用",reuse:"Knowledge / Skill Reuse",failures:"错误与失败"};
const filterFields={
 sessions:[['q','关键字','搜索用户、会话、仓库等'],['actorId','用户 / Actor ID','精确筛选调用用户'],['repositoryId','仓库','Repository ID'],['status','会话状态','ACTIVE / ENDED / FAILED'],['runtimeStatus','运行时状态','current / outdated / unknown'],['event','Hook 事件','例如 SessionStart、PostToolUse'],['hasMcp','包含 MCP 调用','是否发生过 MCP 调用','boolean'],['hasEvidence','包含证据','是否产生过 evidence','boolean'],['hasReuse','发生知识复用','是否复用了 Knowledge / Skill','boolean'],['from','开始时间（从）','只看此时间之后的数据','datetime-local'],['to','结束时间（到）','只看此时间之前的数据','datetime-local']],
 hooks:[['q','关键字','搜索事件、用户、会话或元数据'],['event','Hook 事件','例如 SessionStart、UserPromptSubmit'],['user','用户','用户 / Actor ID'],['session','会话 ID','客户端 Session ID'],['from','开始时间（从）','只看此时间之后的数据','datetime-local'],['until','结束时间（到）','只看此时间之前的数据','datetime-local']],
 'candidate-detections':[['q','关键字','搜索判定结果、原因、用户或会话'],['outcome','判定结果','created / skipped'],['user','用户','用户 / Actor ID'],['session','会话 ID','来源 Session ID'],['from','开始时间（从）','只看此时间之后的数据','datetime-local'],['until','结束时间（到）','只看此时间之前的数据','datetime-local']],
 'mcp-calls':[['q','关键字','搜索工具、错误、用户或会话'],['tool','MCP 工具','例如 search_knowledge'],['success','调用结果','成功或失败','boolean'],['actorId','用户 / Actor ID','精确筛选调用用户'],['sessionId','会话 ID','关联 Session ID'],['from','开始时间（从）','只看此时间之后的数据','datetime-local'],['to','结束时间（到）','只看此时间之前的数据','datetime-local']],
 reuse:[['q','关键字','搜索工具、仓库、知识或会话'],['tool','MCP 工具','触发复用的工具'],['actorId','用户 / Actor ID','精确筛选调用用户'],['sessionId','会话 ID','关联 Session ID'],['from','开始时间（从）','只看此时间之后的数据','datetime-local'],['to','结束时间（到）','只看此时间之前的数据','datetime-local']],
 failures:[['q','关键字','搜索工具、错误、用户或会话'],['tool','MCP 工具','失败的工具名'],['actorId','用户 / Actor ID','精确筛选调用用户'],['sessionId','会话 ID','关联 Session ID'],['from','开始时间（从）','只看此时间之后的数据','datetime-local'],['to','结束时间（到）','只看此时间之前的数据','datetime-local']]
};
const apiFor={sessions:"/admin/api/sessions",hooks:"/admin/api/hooks","candidate-detections":"/admin/api/candidate-detections","mcp-calls":"/admin/api/mcp-calls",reuse:"/admin/api/reuse",failures:"/admin/api/failures"};
function esc(v){const e=document.createElement("span");e.textContent=v==null?"":String(v);return e.innerHTML}function fmt(v){return v?new Date(v).toLocaleString():"—"}
function route(){const parts=location.pathname.split("/").filter(Boolean);return {resource:parts[2],id:parts[3]?decodeURIComponent(parts[3]):undefined}}
function formFor(resource,params){return filterFields[resource].map(([name,label,help,type='text'])=>{const value=params.get(name)||'';let control;if(type==='boolean'){control="<select name='"+name+"'><option value=''>全部</option><option value='true' "+(value==='true'?'selected':'')+">是</option><option value='false' "+(value==='false'?'selected':'')+">否</option></select>"}else control="<input name='"+name+"' type='"+type+"' value='"+esc(value)+"'>";return "<label>"+esc(label)+"<span class='field-help'>"+esc(help)+"</span>"+control+"</label>"}).join("")}
function getItems(data,resource){return data[resource==="sessions"?"sessions":resource==="hooks"?"events":resource==="candidate-detections"?"detections":resource==="mcp-calls"?"calls":"rows"]||[]}
function row(resource,item){const id=item.id||item.sessionId;let cols=resource==="sessions"?[fmt(item.startedAt),item.actorId,item.sessionId,item.repositoryId,item.eventCount,item.callCount,item.failedCallCount>0?"FAILED":item.ended?"ENDED":"ACTIVE"]:resource==="hooks"?[fmt(item.ts),item.event,item.actorId,item.sessionId,item.client]:resource==="candidate-detections"?[fmt(item.ts),item.outcome,item.reason,item.actorId,item.sessionId]:[fmt(item.ts),item.tool,item.actorId,item.sessionId,item.success?"OK":"FAILED",item.error||item.args?.repository||item.args?.query||item.latencyMs+"ms"];const context=resource==="sessions"?' data-actor="'+esc(item.actorId)+'" data-tenant="'+esc(item.tenantId)+'"':'';return '<tr data-id="'+esc(id)+'"'+context+'>'+cols.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>'}
async function list(resource){const p=new URLSearchParams(location.search);if(!p.has("limit"))p.set("limit","20");const content=document.getElementById("content");document.getElementById("title").textContent=resourceNames[resource];content.innerHTML="<div class='card'><form id='filters' class='grid'>"+formFor(resource,p)+"<label>每页数量<span class='field-help'>每页最多显示多少条记录</span><select name='limit'><option>20</option><option>50</option><option>100</option></select></label></form><div class='actions'><button id='apply'>筛选</button><button type='button' class='secondary' id='clear'>清除</button><span id='status' class='muted'>加载中...</span></div></div><div class='table-wrap'><table class='table'><thead><tr>"+(resource==="sessions"?"<th>开始</th><th>用户</th><th>会话</th><th>仓库</th><th>事件数</th><th>MCP 调用</th><th>状态</th>":resource==="hooks"?"<th>时间</th><th>事件</th><th>用户</th><th>会话</th><th>客户端</th>":resource==="candidate-detections"?"<th>时间</th><th>判定</th><th>原因</th><th>用户</th><th>会话</th>":"<th>时间</th><th>工具</th><th>用户</th><th>会话</th><th>结果</th><th>详情 / 延迟</th>")+"</tr></thead><tbody id='rows'></tbody></table></div><div class='actions'><button class='secondary' id='prev'>上一页</button><button class='secondary' id='next'>下一页</button><span id='page' class='muted'></span></div>";document.querySelector("select[name=limit]").value=p.get("limit");for(const input of document.querySelectorAll("input"))input.value=p.get(input.name)||"";document.getElementById("apply").onclick=e=>{e.preventDefault();const q=new URLSearchParams(new FormData(document.getElementById("filters")));history.pushState({},"","/admin/observability/"+resource+"?"+q);list(resource)};document.getElementById("clear").onclick=()=>{history.pushState({},"","/admin/observability/"+resource);list(resource)};try{const data=await requestJson(apiFor[resource]+"?"+p);const items=getItems(data,resource);document.getElementById("rows").innerHTML=items.length?items.map(x=>row(resource,x)).join(""):"<tr><td colspan='8' class='empty'>暂无数据</td></tr>";for(const tr of document.querySelectorAll("#rows tr[data-id]"))tr.onclick=()=>{const q=new URLSearchParams({return:location.pathname+location.search});if(resource==="sessions"){q.set("actorId",tr.dataset.actor);q.set("tenantId",tr.dataset.tenant)}location.href="/admin/observability/"+resource+"/"+encodeURIComponent(tr.dataset.id)+"?"+q};const page=data.page||{};document.getElementById("page").textContent="共 "+(page.total??0)+" 条 · 当前偏移 "+(page.cursor??0)+" · 每页 "+page.limit;document.getElementById("prev").disabled=!page.previousCursor;document.getElementById("next").disabled=!page.nextCursor;document.getElementById("prev").onclick=()=>{p.set("cursor",page.previousCursor);history.pushState({},"","?"+p);list(resource)};document.getElementById("next").onclick=()=>{p.set("cursor",page.nextCursor);history.pushState({},"","?"+p);list(resource)};document.getElementById("status").textContent=items.length?"已加载":"空结果"}catch(e){document.getElementById("status").className="error";document.getElementById("status").textContent=e.message}}
function redactAdminValue(value,key){if(key&&/(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(key))return "[redacted]";if(Array.isArray(value))return value.map(item=>redactAdminValue(item));if(value&&typeof value==="object"){const copy={};for(const [childKey,childValue] of Object.entries(value))copy[childKey]=redactAdminValue(childValue,childKey);return copy}return value}
function safeReturnPath(value,fallback,prefix){if(!value)return fallback;try{const u=new URL(value,location.origin);if(u.origin!==location.origin||!u.pathname.startsWith(prefix))return fallback;return u.pathname+u.search+u.hash}catch{return fallback}}
async function detail(resource,id){const content=document.getElementById("content");document.getElementById("title").textContent=resourceNames[resource]+" · detail";content.innerHTML="加载中...";try{const params=new URLSearchParams(location.search);let endpoint=resource==="sessions"?"/admin/api/sessions/"+encodeURIComponent(id)+"?"+new URLSearchParams({actorId:params.get("actorId")||"",tenantId:params.get("tenantId")||""}):apiFor[resource]+"/"+encodeURIComponent(id);const data=await requestJson(endpoint);const value=redactAdminValue(data.session||data.event||data.detection||data.call||data);content.innerHTML="<p><a href='"+esc(safeReturnPath(params.get("return"),"/admin/observability/"+resource,"/admin/observability/"))+"'>← Back to list</a></p><div class='detail'>"+Object.entries(value).map(([k,v])=>"<div><b>"+esc(k)+"</b><br>"+esc(typeof v==="object"?JSON.stringify(v):v)+"</div>").join("")+"</div><h3>Sanitized record</h3><pre class='raw'>"+esc(JSON.stringify(value,null,2))+"</pre>"}catch(e){content.innerHTML="<p class='error'>"+esc(e.message)+"</p>"}}
async function boot(){const r=route();if(!r.resource||!resourceNames[r.resource]){location.href="/admin/observability";return}r.id?detail(r.resource,r.id):list(r.resource)}addEventListener("popstate",boot);boot();
</script></body></html>`;

const ADMIN_MODULE_CSS = `${ADMIN_OBSERVABILITY_CSS}.subnav{display:flex;gap:8px;margin:14px 0}.subnav a{display:inline-block;padding:8px 12px;border-radius:7px;background:#edf1f8;color:#23324d;text-decoration:none;font-weight:700}.subnav a.active{background:#172033;color:#fff}.governance-spec-action{display:inline-flex;align-items:center;padding:9px 12px;border:1px solid #b8c5dc;border-radius:7px;background:#fff;color:#2457d6;text-decoration:none;font-weight:700;box-shadow:0 1px 2px rgba(16,24,40,.05)}.governance-spec-action:hover{background:#f8fbff;border-color:#2457d6}.candidate-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.candidate-summary>div{background:#f8fafc;padding:10px;border-radius:7px}.candidate-summary .wide{grid-column:1/-1}.candidate-content{white-space:pre-wrap;line-height:1.65}.history-list{display:grid;gap:10px}.history-item{border:1px solid #e4e8f0;border-radius:10px;padding:12px}.history-meta{color:#667085;font-size:12px;margin-top:6px}@media(max-width:800px){.candidate-summary{grid-template-columns:1fr}}`;
export const ADMIN_GOVERNANCE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>仓库治理</title><style>${ADMIN_MODULE_CSS}</style></head><body><main class="wrap"><p><a href="/admin">← Admin</a></p><div class="actions" style="justify-content:space-between"><div><h1 style="margin-bottom:6px">仓库治理</h1><p class="muted" style="margin:0">集中查看仓库健康状态、Owner、同步延迟、Webhook 和治理问题。</p></div><div class="actions"><a class="governance-spec-action" href="/admin/knowledge-submission-spec">Knowledge 回流规范</a><button class="secondary" id="refresh">刷新</button><button id="syncAll">同步全部仓库</button></div></div><div class="card"><div id="summary" class="muted">加载中...</div></div><div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>操作</th><th>仓库</th><th>Owner</th><th>状态</th><th>最后成功</th><th>同步延迟</th><th>最后有效 Revision</th><th>Webhook</th><th>问题</th></tr></thead><tbody id="rows"></tbody></table></div></div></main><script>
const keyName='skillHubAdminKey';const headers=()=>{const k=sessionStorage.getItem(keyName);return k?{'x-skill-hub-admin-key':k}:{};};
function fmt(v){return v?new Date(v).toLocaleString():'—'}function lag(v){return v===undefined||v===null?'—':v<60?v+'s':v<3600?Math.round(v/60)+'m':Math.round(v/3600)+'h'}
async function readJson(r){const data=await r.json();if(!r.ok)throw Error(data.error||('HTTP '+r.status));return data}
async function load(){const summary=document.getElementById('summary'),body=document.getElementById('rows');summary.textContent='加载中...';summary.className='muted';body.replaceChildren();try{const data=await readJson(await fetch('/admin/api/repository-governance',{headers:headers()}));summary.textContent='共 '+data.summary.total+' 个仓库 · 缺少 Owner '+data.summary.missingOwner+' · 陈旧 '+data.summary.stale+' · Webhook 异常 '+data.summary.webhookErrors;for(const item of data.repositories){const row=document.createElement('tr');const values=[item.id+' · '+item.name,item.owners.length?item.owners.join(', '):'未配置',item.status,fmt(item.lastSuccessAt),lag(item.syncLagSeconds),item.lastGoodRevision||'—',item.webhook.status+(item.webhook.lastEventAt?' · '+fmt(item.webhook.lastEventAt):''),item.issues.length?item.issues.join(', '):'OK'];const action=document.createElement('td');const button=document.createElement('button');button.className='secondary';button.textContent='立即同步';button.onclick=()=>syncOne(item.id,button);action.appendChild(button);row.appendChild(action);for(const value of values){const td=document.createElement('td');td.textContent=String(value);row.appendChild(td)}body.appendChild(row)}if(!data.repositories.length){body.innerHTML='<tr><td colspan="9" class="empty">暂无仓库</td></tr>'}}catch(e){summary.className='error';summary.textContent=e.message}}
async function syncOne(id,button){const old=button.textContent;button.disabled=true;button.textContent='同步中...';try{await readJson(await fetch('/repositories/'+encodeURIComponent(id)+'/sync',{method:'POST',headers:headers(),body:'{}'}));await load()}catch(e){const summary=document.getElementById('summary');summary.className='error';summary.textContent=id+' 同步失败：'+e.message}finally{button.disabled=false;button.textContent=old}}
async function syncAll(){const button=document.getElementById('syncAll');button.disabled=true;button.textContent='同步中...';try{const data=await readJson(await fetch('/admin/api/repository-governance',{headers:headers()}));const results=await Promise.all(data.repositories.map(async item=>{try{await readJson(await fetch('/repositories/'+encodeURIComponent(item.id)+'/sync',{method:'POST',headers:headers(),body:'{}'}));return true}catch{return false}}));const failed=results.filter(x=>!x).length;await load();if(failed){const summary=document.getElementById('summary');summary.className='error';summary.textContent+=' · '+failed+' 个仓库同步失败'}}finally{button.disabled=false;button.textContent='同步全部仓库'}}
document.getElementById('refresh').onclick=load;document.getElementById('syncAll').onclick=syncAll;load();
</script></body></html>`;

export const ADMIN_KNOWLEDGE_SUBMISSION_SPEC_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Knowledge 回流规范</title><style>${ADMIN_MODULE_CSS}
.spec-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.spec-grid .wide{grid-column:1/-1}.sections{display:grid;gap:10px}.section-row{display:grid;grid-template-columns:140px 1fr 2fr 100px;gap:8px;align-items:end;border:1px solid #e4e8f0;border-radius:8px;padding:10px}.checks{display:flex;gap:16px;flex-wrap:wrap}.checks label{display:flex;gap:6px;align-items:center}.checks input{width:auto}.raw{white-space:pre-wrap;max-height:360px;overflow:auto}.history-actions{display:flex;gap:8px;align-items:center}@media(max-width:850px){.spec-grid,.section-row{grid-template-columns:1fr}.spec-grid .wide{grid-column:auto}}</style></head><body><main class="wrap"><p><a href="/admin">← Admin</a></p><div class="actions" style="justify-content:space-between"><div><h1>Knowledge 回流规范</h1><p class="muted">服务器是 Knowledge Submission Spec 的唯一真源；保存会创建新 spec_version 并立即生效。</p></div><button class="secondary" id="reload">刷新</button></div>
<div class="card"><div id="version" class="key-meta">加载中...</div><h2>基础规则</h2><div class="spec-grid"><label>标题最大长度<input id="titleMax" type="number" min="1"></label><label>推荐最小长度<input id="titleMin" type="number" min="1"></label><label>推荐最大长度<input id="titleRecommendedMax" type="number" min="1"></label><label>正文最大长度<input id="contentMax" type="number" min="1"></label></div><h2>Sections</h2><div id="sections" class="sections"></div><h2>安全/质量规则</h2><div id="requirements" class="checks"></div><div class="actions"><button id="save">保存为新版本</button><span id="state" class="muted"></span></div></div>
<div class="card"><h2>模板预览</h2><pre id="preview" class="raw"></pre></div>
<div class="card"><h2>版本历史</h2><div class="table-wrap"><table class="table"><thead><tr><th>spec_version</th><th>schema_version</th><th>标题上限</th><th>正文上限</th><th>操作</th></tr></thead><tbody id="history"></tbody></table></div></div></main><script>
const keyName='skillHubAdminKey';const authHeaders=()=>{const k=sessionStorage.getItem(keyName);return k?{'x-skill-hub-admin-key':k}:{};};
async function req(url,options={}){const r=await fetch(url,{...options,headers:{...authHeaders(),...(options.headers||{})}});const type=r.headers.get('content-type')||'';const body=type.includes('json')?await r.json():await r.text();if(!r.ok)throw Error(typeof body==='string'?body:(body.error||JSON.stringify(body)));return body}
let current=null;const requirementLabels={durable:'必须是可复用持久知识',verified:'必须已验证',reject_speculation:'禁止猜测性结论',reject_secrets:'禁止 secrets/credentials',reject_customer_sensitive_data:'禁止客户敏感数据'};
function render(spec,template){current=structuredClone(spec);document.getElementById('version').textContent='spec_version v'+spec.spec_version+' · schema_version '+spec.schema_version;document.getElementById('titleMax').value=spec.title.max_chars;document.getElementById('titleMin').value=spec.title.recommended_min_chars;document.getElementById('titleRecommendedMax').value=spec.title.recommended_max_chars;document.getElementById('contentMax').value=spec.content.max_chars;document.getElementById('sections').innerHTML=spec.sections.map((x,i)=>'<div class="section-row"><div><b>'+x.id+'</b></div><label>Heading<input data-section="'+i+'" data-field="heading" value="'+escapeHtml(x.heading)+'"></label><label>Description<input data-section="'+i+'" data-field="description" value="'+escapeHtml(x.description||'')+'"></label><label><input type="checkbox" data-section="'+i+'" data-field="required" '+(x.required?'checked':'')+'> Required</label></div>').join('');document.getElementById('requirements').innerHTML=Object.entries(spec.requirements).map(([k,v])=>'<label><input type="checkbox" data-requirement="'+k+'" '+(v?'checked':'')+'>'+escapeHtml(requirementLabels[k]||k)+'</label>').join('');document.getElementById('preview').textContent=template||makeTemplate(spec)}
function escapeHtml(v){const e=document.createElement('span');e.textContent=String(v??'');return e.innerHTML}
function makeTemplate(spec){return ['# Title',...spec.sections.flatMap(x=>['','## '+x.heading,x.description?'<'+x.description+'>':'<content>'])].join('\\\\n')}function collect(){const spec=structuredClone(current);spec.title.max_chars=Number(document.getElementById('titleMax').value);spec.title.recommended_min_chars=Number(document.getElementById('titleMin').value);spec.title.recommended_max_chars=Number(document.getElementById('titleRecommendedMax').value);spec.content.max_chars=Number(document.getElementById('contentMax').value);document.querySelectorAll('[data-section]').forEach(el=>{const x=spec.sections[Number(el.dataset.section)],field=el.dataset.field;if(field==='required')x.required=el.checked;else x[field]=el.value});document.querySelectorAll('[data-requirement]').forEach(el=>spec.requirements[el.dataset.requirement]=el.checked);return spec}
async function load(){const state=document.getElementById('state');state.textContent='加载中...';try{const [d,h]=await Promise.all([req('/admin/api/knowledge-submission-spec'),req('/admin/api/knowledge-submission-spec/history')]);render(d.spec,d.template);document.getElementById('history').innerHTML=h.specs.map(x=>'<tr><td>v'+x.spec_version+'</td><td>'+x.schema_version+'</td><td>'+x.title.max_chars+'</td><td>'+x.content.max_chars+'</td><td class="history-actions">'+(x.spec_version===d.spec.spec_version?'当前':'<button class="secondary small" data-rollback="'+x.spec_version+'">回滚</button>')+'</td></tr>').join('');document.querySelectorAll('[data-rollback]').forEach(b=>b.onclick=()=>rollback(Number(b.dataset.rollback)));state.textContent='已加载'}catch(e){state.className='error';state.textContent=e.message}}
async function save(){const b=document.getElementById('save'),state=document.getElementById('state');b.disabled=true;state.className='muted';state.textContent='保存中...';try{const d=await req('/admin/api/knowledge-submission-spec',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(collect())});state.textContent='已保存 v'+d.spec.spec_version;await load()}catch(e){state.className='error';state.textContent=e.message}finally{b.disabled=false}}
async function rollback(version){if(!confirm('确认回滚到 v'+version+' 的规则内容？系统会创建一个新的 spec_version。'))return;const state=document.getElementById('state');state.textContent='回滚中...';try{const d=await req('/admin/api/knowledge-submission-spec/rollback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version})});state.textContent='已创建回滚版本 v'+d.spec.spec_version;await load()}catch(e){state.className='error';state.textContent=e.message}}
document.getElementById('save').onclick=save;document.getElementById('reload').onclick=load;document.addEventListener('input',()=>{if(current)document.getElementById('preview').textContent=makeTemplate(collect())});load();
</script></body></html>`;

export const ADMIN_SKILL_BUNDLES_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Skill Bundle 导入</title><style>${ADMIN_MODULE_CSS}
.bundle-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.bundle-grid .wide{grid-column:1/-1}.bundle-help{display:block;margin:4px 0 0;color:#667085;font-size:12px;font-weight:400;line-height:1.45}.bundle-target{grid-column:1/-1;padding:12px 14px;border:1px solid #dbe4f0;border-radius:9px;background:#f8fbff}.bundle-target code{font-size:14px;font-weight:700}.diff-list{font-family:ui-monospace,monospace;white-space:pre-wrap;max-height:300px;overflow:auto}button:disabled{cursor:not-allowed;opacity:.55}@media(max-width:900px){.bundle-grid{grid-template-columns:1fr}}
</style></head><body><main class="wrap"><p><a href="/admin">← Admin</a></p><div class="actions" style="justify-content:space-between"><div><h1>Skill Bundle 导入</h1><p class="muted">这里只负责创建/import Bundle；审核统一进入审核中心。</p></div><a class="link" href="/admin/review">审核中心 →</a></div><div class="card"><h2>导入 Skill Bundle</h2><form id="bundleForm" class="bundle-grid"><label>目标仓库<span class="bundle-help">通常保持 rd-skills。</span><input name="repository" value="rd-skills" placeholder="rd-skills"></label><label class="skill-target-field">目标 Skill 路径<span class="bundle-help">相对于 skills/ 的目录，例如 skill-creator 或 ota/design。</span><input name="target_path" placeholder="例如 skill-creator 或 ota/design"></label><label class="collection-field">Namespace<span class="bundle-help">仅同步整个 Collection 时填写，例如 superpowers。</span><input name="namespace" placeholder="例如 superpowers"></label><label>导入范围<span class="bundle-help">单个 Skill 选 skill；同步整个 Namespace 才选 collection。</span><select name="import_type"><option value="skill">单个 Skill</option><option value="collection">整个 Collection / Namespace</option></select></label><label>导入来源<span class="bundle-help">上传 ZIP、从 Git 拉取，或直接提供 Files JSON。</span><select name="source_type"><option value="zip">ZIP 文件</option><option value="git">Git URL</option><option value="files">Files JSON</option></select></label><label class="source-root-field">Source Root（可选）<span class="bundle-help">ZIP/Git 有包装目录时填写。</span><input name="source_root" placeholder="通常留空"></label><label class="git-field">Git URL<span class="bundle-help">只支持允许列表中的 HTTPS Git 地址。</span><input name="git_url" placeholder="https://github.com/org/repo.git"></label><label class="git-field">Revision（可选）<span class="bundle-help">Branch、Tag 或 Commit SHA。</span><input name="revision" placeholder="main / v1.0 / commit sha"></label><label class="zip-field wide">ZIP 文件<span class="bundle-help">包含 SKILL.md 及 resources。</span><input id="bundleZip" type="file" accept=".zip,application/zip"></label><label class="wide files-field">Files JSON<span class="bundle-help">高级用法：path/content/mode 数组。</span><textarea name="files_json" rows="9" placeholder='[{"path":"SKILL.md","content":"...","mode":"0644"}]'></textarea></label><div class="bundle-target"><div class="muted">Replacement Root / 最终写入目录</div><code id="bundleTargetPath">请填写目标 Skill 路径</code></div><label class="wide">幂等键（可选）<span class="bundle-help">同一次提交重试时复用。</span><input name="submission_key" placeholder="例如 ota-design-v1"></label></form><div class="actions"><button id="previewBundle" type="button">预览变更</button><button id="importBundle" type="button">创建 Import</button><span id="importState" class="muted"></span></div><div id="previewResult" class="detail"></div></div></main><script>
const keyName='skillHubAdminKey';const authHeaders=()=>{const k=sessionStorage.getItem(keyName);return k?{'x-skill-hub-admin-key':k}:{};};
function esc(v){const e=document.createElement('span');e.textContent=v==null?'':String(v);return e.innerHTML}
async function req(url,options={}){const r=await fetch(url,{...options,headers:{...authHeaders(),...(options.headers||{})}});const t=r.headers.get('content-type')||'';const b=t.includes('json')?await r.json():await r.text();if(!r.ok)throw Error(typeof b==='string'?b:(b.error||JSON.stringify(b)));return b}
function updateImportFields(){const form=document.getElementById('bundleForm');const d=new FormData(form);const source=String(d.get('source_type')||'zip'),kind=String(d.get('import_type')||'skill'),targetPath=String(d.get('target_path')||'').trim(),namespace=String(d.get('namespace')||'').trim();document.querySelectorAll('.git-field').forEach(x=>x.style.display=source==='git'?'':'none');document.querySelectorAll('.zip-field').forEach(x=>x.style.display=source==='zip'?'':'none');document.querySelectorAll('.files-field').forEach(x=>x.style.display=source==='files'?'':'none');document.querySelectorAll('.source-root-field').forEach(x=>x.style.display=source==='files'?'none':'');document.querySelectorAll('.skill-target-field').forEach(x=>x.style.display=kind==='skill'?'':'none');document.querySelectorAll('.collection-field').forEach(x=>x.style.display=kind==='collection'?'':'none');document.getElementById('bundleTargetPath').textContent=kind==='skill'?(targetPath?'skills/'+targetPath:'请填写目标 Skill 路径'):(namespace?'skills/'+namespace:'请填写 Namespace')}
for(const name of ['source_type','import_type','target_path','namespace']){const el=document.querySelector('[name='+name+']');el.addEventListener(name==='target_path'||name==='namespace'?'input':'change',updateImportFields)}updateImportFields();
async function fileBase64(file){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary)}
async function payload(){const f=document.getElementById('bundleForm');const d=new FormData(f);const type=String(d.get('source_type')||'files'),kind=String(d.get('import_type')||'skill');const p={repository:String(d.get('repository')||'')||undefined,import_type:kind,source_type:type,source_root:String(d.get('source_root')||'')||undefined,submission_key:String(d.get('submission_key')||'')||undefined};if(kind==='skill')p.target_path=String(d.get('target_path')||'').trim();else p.namespace=String(d.get('namespace')||'').trim();if(type==='files'){try{p.files=JSON.parse(String(d.get('files_json')||'[]'))}catch{throw Error('Files JSON 格式错误')}}else if(type==='zip'){const file=document.getElementById('bundleZip').files[0];if(!file)throw Error('请选择 ZIP');p.zip_base64=await fileBase64(file)}else{p.git_url=String(d.get('git_url')||'');p.revision=String(d.get('revision')||'')||undefined}return p}
function renderPreview(v){const d=v.diff||{};const lines=['Added',...(d.added||[]),'','Modified',...(d.modified||[]),'','Deleted',...(d.deleted||[])];document.getElementById('previewResult').innerHTML='<div class="candidate-summary"><div><b>Replacement Root</b><br>'+esc(v.replacementRoot)+'</div><div><b>Target Revision</b><br>'+esc(v.targetRevision)+'</div><div><b>Tree Hash</b><br>'+esc(v.expectedTreeSha256)+'</div></div><h3>Diff</h3><div class="diff-list">'+lines.map(esc).join('<br>')+'</div>'}
const previewButton=document.getElementById('previewBundle'),importButton=document.getElementById('importBundle'),importState=document.getElementById('importState');
async function preview(){previewButton.disabled=true;importState.className='muted';importState.textContent='Preview...';try{const d=await req('/admin/api/skill-bundles/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await payload())});renderPreview(d);importState.textContent='Preview 完成'}catch(e){importState.textContent=e.message;importState.className='error'}finally{previewButton.disabled=false}}
async function createImport(){importButton.disabled=true;importState.className='muted';importState.textContent='创建中...';try{const d=await req('/admin/api/skill-bundles/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await payload())});importState.textContent='已创建 '+d.import.id;location.assign('/admin/review/items/skill-bundle/'+encodeURIComponent(d.import.id))}catch(e){importState.textContent=e.message;importState.className='error'}finally{importButton.disabled=false}}
previewButton.onclick=preview;importButton.onclick=createImport;
</script></body></html>`;

export const ADMIN_MODULE_INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin module</title><style>${ADMIN_MODULE_CSS}.module-count{display:inline-block;margin-top:10px;font-weight:800;color:#2457d6}</style></head><body><main class="wrap"><p><a href="/admin">← Admin</a></p><h1 id="heading">Admin</h1><p class="muted" id="intro">模块入口；列表和详情按需加载。</p><div class="module-index" id="cards"></div></main><script>
const p=location.pathname;const review=p.startsWith('/admin/review');
const reviewCards=[['/admin/review/items','全部审核项','Knowledge Candidate 与 Skill Bundle 的统一列表','total'],['/admin/review/items?status=pending','待审核','等待人工审核','pending'],['/admin/review/items?status=approved','已批准','已通过审核，等待发布','approved'],['/admin/review/items?status=publishing','等待合并','PR/MR 已创建，等待合并','publishing'],['/admin/review/items?status=rejected','已拒绝','审核未通过','rejected'],['/admin/review/items?status=publish_failed','发布失败','创建或刷新发布状态失败','publish_failed'],['/admin/review/items?status=published','已发布','PR/MR 已合并','published'],['/admin/review/items?status=deleting','等待删除合并','删除 PR/MR 已创建','deleting'],['/admin/review/items?status=delete_failed','删除失败','创建删除 PR/MR 失败','delete_failed'],['/admin/review/items?status=deleted','已删除','删除 PR/MR 已合并','deleted'],['/admin/review/items?status=review_stale','审核已过期','Bundle 审核基线已变化','review_stale'],['/admin/review/items?status=published_drifted','发布内容漂移','Bundle 合并结果与审核 Snapshot 不一致','published_drifted'],['/admin/review/history','历史记录','按 Candidate / Skill Bundle 来源查看历史','history']];
const gapCards=[['/admin/gaps/items?status=active','活跃缺口','需要处理的未命中问题'],['/admin/gaps/items?status=resolved','已解决','已完成治理的缺口'],['/admin/gaps/items?status=ignored','已忽略','不再跟踪的缺口']];
const configs=review?{title:'审核中心',intro:'统一查看 Knowledge Candidate、旧 Skill Candidate 与 Skill Bundle；分类卡片只是状态快捷筛选。',cards:reviewCards}:{title:'知识缺口',intro:'按状态查看知识缺口。',cards:gapCards};document.getElementById('heading').textContent=configs.title;document.getElementById('intro').textContent=configs.intro;document.getElementById('cards').innerHTML=configs.cards.map(x=>'<a class="module-entry" href="'+x[0]+'"><h2>'+x[1]+'</h2><p>'+x[2]+'</p>'+(review&&x[3]&&x[3]!=='history'?'<span class="module-count" data-status="'+x[3]+'">—</span>':'')+'</a>').join('');
if(review){fetch('/admin/api/review-summary').then(r=>r.ok?r.json():Promise.reject()).then(d=>document.querySelectorAll('[data-status]').forEach(el=>{const key=el.dataset.status;el.textContent=key==='total'?String(d.total??0):String(d.counts?.[key]??0)})).catch(()=>{})}
</script></body></html>`;

export const ADMIN_MODULE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin module</title><style>${ADMIN_MODULE_CSS}
button:disabled{cursor:not-allowed;opacity:.55}.review-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.review-kind{font-size:12px;font-weight:700;padding:3px 7px;border-radius:999px;background:#eef2f7}.review-list-actions{display:flex;gap:6px}.diff-list{font-family:ui-monospace,monospace;white-space:pre-wrap;max-height:320px;overflow:auto}.detail-error{padding:18px;border:1px solid #f0b4ad;background:#fff7f5;border-radius:10px}.history-source-note{padding:12px;background:#f8fbff;border:1px solid #dbe4f0;border-radius:9px;margin:12px 0}
</style></head><body><main class="wrap" id="app"><p><a id="back" href="/admin">← Admin</a></p><h1 id="title">Admin</h1><div id="content" class="card">加载中...</div></main><script>
const keyName='skillHubAdminKey';const headers=()=>{const k=sessionStorage.getItem(keyName);return k?{'x-skill-hub-admin-key':k}:{};};
async function readResponse(r,endpoint){const type=r.headers.get('content-type')||'';let body;try{body=type.includes('json')?await r.json():await r.text()}catch{body='Unable to read response'}if(!r.ok){const detail=typeof body==='string'?body:(body?.error||JSON.stringify(body));const err=Error(detail);err.status=r.status;err.endpoint=endpoint;throw err}return body}
async function requestJson(url,options={}){return readResponse(await fetch(url,{...options,headers:{...headers(),...(options.headers||{})}}),url)}
function esc(v){const e=document.createElement('span');e.textContent=v==null?'':String(v);return e.innerHTML}
function redact(v,k){if(k&&/(token|secret|password|authorization|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(k))return'[redacted]';if(Array.isArray(v))return v.map(x=>redact(x));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([a,b])=>[a,redact(b,a)]));return v}
function fmt(v){return v?new Date(v).toLocaleString():'—'}
function safeDecode(v){try{return decodeURIComponent(v)}catch{return v}}
function safeReturnPath(value,fallback,prefix='/admin/review/'){if(!value)return fallback;try{const u=new URL(value,location.origin);if(u.origin!==location.origin||!u.pathname.startsWith(prefix))return fallback;return u.pathname+u.search+u.hash}catch{return fallback}}
function externalPublicationUrl(value){try{const u=new URL(String(value||''));return u.protocol==='http:'||u.protocol==='https:'?u.href:''}catch{return ''}}
function publicationLink(publication){const url=externalPublicationUrl(publication?.mergeRequestUrl);return url?'<a class="link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">打开 PR/MR</a>':'-'}
function statusLabel(v){return({pending:'待审核',approved:'已批准',rejected:'已拒绝',publishing:'等待合并',publish_failed:'发布失败',published:'已发布',deleting:'等待删除合并',delete_failed:'删除失败',deleted:'已删除',review_stale:'审核已过期',published_drifted:'发布内容漂移'})[v]||v||'-'}
function sourceLabel(v){return({'troubleshooting':'故障排查','codex-summary':'Codex 会话摘要','mcp-session':'MCP 会话',manual:'手工创建','skill-creator':'Skill Creator','web-files':'Web Files','web-zip':'Web ZIP','web-git':'Web Git',mcp:'MCP'})[v]||v||'-'}
function contentTypeLabel(v){return({knowledge:'Knowledge','legacy-skill':'Legacy Skill','skill-bundle-skill':'Skill Bundle · Skill','skill-bundle-collection':'Skill Bundle · Collection'})[v]||v||'-'}
function queryUrl(patch={}){const q=new URLSearchParams(location.search);for(const [k,v] of Object.entries(patch)){if(v===undefined||v==='')q.delete(k);else q.set(k,String(v))}return q}
function replaceQuery(q){history.pushState({},'',location.pathname+(q.toString()?'?'+q:''));boot()}
function labeledInput(name,label,help,q){return '<label>'+esc(label)+'<span class="field-help">'+esc(help)+'</span><input name="'+name+'" value="'+esc(q.get(name)||'')+'"></label>'}
const path=location.pathname;const parts=path.split('/').filter(Boolean);const review=path.startsWith('/admin/review');const gaps=path.startsWith('/admin/gaps');const base=review?'/admin/review':'/admin/gaps';document.getElementById('back').href=base;document.getElementById('title').textContent=review?'审核中心':'知识缺口';
function legacyReviewRedirect(){if(!path.startsWith('/admin/review/candidates'))return false;const suffix=path.slice('/admin/review/candidates'.length);const q=new URLSearchParams(location.search);if(!suffix||suffix==='/'){q.set('kind','candidate');location.replace('/admin/review/items?'+q);return true}const seg=suffix.split('/').filter(Boolean);const candidateId=seg[0];const history=seg[1]==='history';const target='/admin/review/items/candidate/'+encodeURIComponent(safeDecode(candidateId))+(history?'/history':'')+(q.toString()?'?'+q:'');location.replace(target);return true}
function reviewRoute(){if(path==='/admin/review/items')return{kind:'list'};if(path==='/admin/review/history')return{kind:'history'};const prefix='/admin/review/items/';if(path.startsWith(prefix)){const seg=path.slice(prefix.length).split('/').filter(Boolean);if((seg[0]==='candidate'||seg[0]==='skill-bundle')&&seg[1])return{kind:'detail',reviewKind:seg[0],id:safeDecode(seg[1]),history:seg[2]==='history'}}return{kind:'unknown'}}
function reviewFilters(q){const statuses={pending:'待审核',approved:'已批准',publishing:'等待合并',rejected:'已拒绝',publish_failed:'发布失败',published:'已发布',deleting:'等待删除合并',delete_failed:'删除失败',deleted:'已删除',review_stale:'审核已过期',published_drifted:'发布内容漂移'};const types={knowledge:'Knowledge','legacy-skill':'Legacy Skill','skill-bundle-skill':'Bundle Skill','skill-bundle-collection':'Bundle Collection'};let html=labeledInput('q','关键字','ID、标题、来源等',q);html+='<label>状态<span class="field-help">按审核/发布状态筛选</span><select name="status"><option value="">全部状态</option>'+Object.entries(statuses).map(([v,l])=>'<option value="'+v+'" '+(q.get('status')===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>';html+='<label>Item Kind<span class="field-help">Candidate / Skill Bundle</span><select name="kind"><option value="">全部</option><option value="candidate" '+(q.get('kind')==='candidate'?'selected':'')+'>Candidate</option><option value="skill-bundle" '+(q.get('kind')==='skill-bundle'?'selected':'')+'>Skill Bundle</option></select></label>';html+='<label>内容类型<span class="field-help">Knowledge / Legacy Skill / Bundle</span><select name="type"><option value="">全部类型</option>'+Object.entries(types).map(([v,l])=>'<option value="'+v+'" '+(q.get('type')===v?'selected':'')+'>'+l+'</option>').join('')+'</select></label>';html+=labeledInput('repository','仓库','Repository',q)+labeledInput('sourceType','来源类型','例如 mcp、manual、codex-summary',q)+labeledInput('reviewer','审核人','Reviewer 用户 ID',q)+labeledInput('submitter','提交人','Submitter / Actor ID',q)+labeledInput('namespace','Namespace / Skill 分类','Bundle Namespace',q)+labeledInput('skillCollection','Skill 分类','Candidate Skill Collection，例如 rd-skills',q);html+='<label>Import Type<span class="field-help">仅 Skill Bundle</span><select name="importType"><option value="">全部</option><option value="skill" '+(q.get('importType')==='skill'?'selected':'')+'>skill</option><option value="collection" '+(q.get('importType')==='collection'?'selected':'')+'>collection</option></select></label>';html+='<label>每页数量<span class="field-help">最多 100</span><select name="limit"><option>20</option><option>50</option><option>100</option></select></label>';return html}
async function reviewList(){const q=new URLSearchParams(location.search);if(!q.get('limit'))q.set('limit','20');document.getElementById('title').textContent='审核中心 · 内容列表';document.getElementById('content').innerHTML='<form id="reviewFilters" class="grid">'+reviewFilters(q)+'</form><div class="actions"><button id="reviewApply">筛选</button><button type="button" class="secondary" id="reviewClear">清除</button><button type="button" class="secondary" id="reviewRefresh">刷新</button><span id="reviewState" class="muted">加载中...</span></div><div class="table-wrap"><table class="table"><thead><tr><th>操作</th><th>ID</th><th>标题/Namespace</th><th>类型</th><th>状态</th><th>来源</th><th>仓库</th><th>提交人</th><th>审核人</th><th>更新时间</th><th>PR/MR</th></tr></thead><tbody id="reviewRows"></tbody></table></div><div class="actions"><button class="secondary" id="reviewPrev">上一页</button><button class="secondary" id="reviewNext">下一页</button><span id="reviewPage" class="muted"></span></div>';const form=document.getElementById('reviewFilters');form.onsubmit=e=>{e.preventDefault();const next=new URLSearchParams(new FormData(form));next.delete('cursor');replaceQuery(next)};document.getElementById('reviewApply').onclick=()=>form.requestSubmit();document.getElementById('reviewClear').onclick=()=>replaceQuery(new URLSearchParams({limit:q.get('limit')||'20'}));document.getElementById('reviewRefresh').onclick=()=>reviewList();document.querySelector('select[name=limit]').value=q.get('limit')||'20';try{const d=await requestJson('/admin/api/review-items?'+q);const rows=d.items||[];document.getElementById('reviewRows').innerHTML=rows.length?rows.map(x=>{const href='/admin/review/items/'+encodeURIComponent(x.kind)+'/'+encodeURIComponent(x.id)+'?return='+encodeURIComponent(location.pathname+location.search);return '<tr><td class="review-list-actions"><button class="secondary small" data-review-id="'+esc(x.id)+'" data-href="'+esc(href)+'">查看</button></td><td>'+esc(x.id)+'</td><td>'+esc(x.title)+'</td><td><span class="review-kind">'+esc(contentTypeLabel(x.contentType))+'</span></td><td>'+esc(statusLabel(x.statusGroup||x.status))+'</td><td>'+esc(sourceLabel(x.sourceType))+'</td><td>'+esc(x.repository||'-')+'</td><td>'+esc(x.submitter||'-')+'</td><td>'+esc(x.reviewer||'-')+'</td><td>'+esc(fmt(x.updatedAt))+'</td><td>'+publicationLink(x.publication)+'</td></tr>'}).join(''):'<tr><td colspan="11" class="empty">暂无记录</td></tr>';document.querySelectorAll('button[data-review-id]').forEach(b=>b.onclick=()=>location.assign(b.dataset.href));const p=d.page||{};const prev=document.getElementById('reviewPrev'),next=document.getElementById('reviewNext');prev.disabled=!p.previousCursor;next.disabled=!p.nextCursor;prev.onclick=()=>{if(!p.previousCursor)return;replaceQuery(queryUrl({cursor:p.previousCursor}))};next.onclick=()=>{if(!p.nextCursor)return;replaceQuery(queryUrl({cursor:p.nextCursor}))};document.getElementById('reviewPage').textContent='共 '+(p.total??rows.length)+' 条 · 当前偏移 '+(p.cursor??0);document.getElementById('reviewState').textContent=rows.length?'已加载':'空结果'}catch(e){document.getElementById('reviewState').className='error';document.getElementById('reviewState').textContent=e.message}}
function candidateNav(active,id,returnPath){const detailPath='/admin/review/items/candidate/'+encodeURIComponent(id),historyPath=detailPath+'/history';return '<p><a class="link" href="'+esc(returnPath)+'">← 返回审核列表</a></p><div class="subnav"><a class="'+(active==='detail'?'active':'')+'" href="'+detailPath+'?return='+encodeURIComponent(returnPath)+'">候选详情</a><a class="'+(active==='history'?'active':'')+'" href="'+historyPath+'?return='+encodeURIComponent(returnPath)+'">历史记录</a></div>'}
function candidatePublicationBody(publication,label='PR/MR 地址'){const url=externalPublicationUrl(publication?.mergeRequestUrl);if(!url)return '';const kind=publication.provider==='github'?'GitHub PR':'GitLab MR';const number=publication.mergeRequestIid?kind+' #'+publication.mergeRequestIid:kind;return '<div class="wide"><b>'+esc(label)+'</b><br><a class="link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">打开 PR/MR · '+esc(number)+'</a><div class="muted" style="margin-top:6px;word-break:break-all">'+esc(url)+'</div></div>'}
function candidateDetailBody(value){const publication=value.publication||{};const kind=publication.provider==='github'?'GitHub PR':publication.provider==='gitlab'?'GitLab MR':'PR/MR';const items=[['ID',value.id],['标题',value.title],['状态',statusLabel(value.status)],['来源',sourceLabel(value.sourceType)],['仓库',value.repository||'-'],['候选类型',value.suggestedType==='knowledge'?'Knowledge':'Skill'],['建议路径',value.suggestedPath||'-'],['审核人',value.reviewer||'-'],['审核原因',value.reviewReason||'-'],['更新时间',fmt(value.updatedAt)],['PR/MR 编号',publication.mergeRequestIid?kind+' #'+publication.mergeRequestIid:'-'],['源分支',publication.branch||'-'],['目标分支',publication.targetBranch||'-'],['发布状态',publication.mergeRequestState||publication.pipelineStatus||'-']];return '<div class="candidate-summary">'+items.map(([k,v])=>'<div><b>'+esc(k)+'</b><br>'+esc(v)+'</div>').join('')+candidatePublicationBody(publication,'发布 PR/MR 地址')+candidatePublicationBody(value.deletionPublication,'删除 PR/MR 地址')+(value.deletionError?'<div class="wide error"><b>删除失败</b><br>'+esc(value.deletionError)+'</div>':'')+'<div class="wide"><b>候选正文</b><div class="candidate-content">'+esc(value.content||'')+'</div></div></div>'}
async function runCandidateAction(button,busyLabel,successLabel,work){const old=button.textContent,state=document.getElementById('actionState');button.disabled=true;button.textContent=busyLabel;if(state){state.textContent=busyLabel;state.className='muted'}try{await work();await candidateDetail(currentReviewRoute.id);const next=document.getElementById('actionState');if(next){next.textContent=successLabel;next.className='ok'}}catch(e){const current=document.getElementById('actionState')||state;if(current){current.textContent=e.message;current.className='error'}button.disabled=false;button.textContent=old}}
let currentReviewRoute=null;
async function candidateHistory(id){const returnPath=safeReturnPath(new URLSearchParams(location.search).get('return'),'/admin/review/items');document.getElementById('title').textContent='审核中心 · Candidate 历史记录';try{const d=await requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id)+'/history');const items=(d.history||[]).map(x=>redact(x));document.getElementById('content').innerHTML=candidateNav('history',id,returnPath)+(items.length?'<div class="history-list">'+items.map(x=>'<div class="history-item"><b>'+esc(statusLabel(x.status))+'</b><div class="history-meta">'+esc(fmt(x.updatedAt))+(x.reviewer?' · 审核人 '+esc(x.reviewer):'')+(x.reviewReason?' · 原因 '+esc(x.reviewReason):'')+'</div>'+(x.reviewNote?'<div style="margin-top:8px">'+esc(x.reviewNote)+'</div>':'')+'</div>').join('')+'</div>':'<div class="empty">暂无历史记录</div>')}catch(e){renderDetailError(e,returnPath)}}
async function candidateDetail(id){currentReviewRoute={kind:'detail',reviewKind:'candidate',id};const returnPath=safeReturnPath(new URLSearchParams(location.search).get('return'),'/admin/review/items');document.getElementById('title').textContent='审核中心 · 候选详情';try{const d=await requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id));const value=redact(d.candidate);const status=value.status;let actionButtons='';if(status==='pending')actionButtons='<button id="approve">批准</button><button id="reject" class="secondary">拒绝</button><button id="deleteCandidate" class="danger">删除 Candidate</button>';else if(status==='approved')actionButtons='<button id="publish">发布 PR/MR</button><button id="reject" class="secondary">拒绝</button><button id="deleteCandidate" class="danger">删除 Candidate</button>';else if(status==='rejected')actionButtons='<button id="reopen">重新批准</button><button id="deleteCandidate" class="danger">删除 Candidate</button>';else if(status==='publish_failed')actionButtons='<button id="publish">重试发布 PR/MR</button><button id="reject" class="secondary">拒绝</button><button id="deleteCandidate" class="danger">删除 Candidate</button>';else if(status==='published')actionButtons='<button id="reconcile" class="secondary">刷新 PR/MR 状态</button><button id="deletePublished" class="danger">删除已发布内容</button>';else if(status==='delete_failed')actionButtons='<button id="deletePublished" class="danger">重试删除已发布内容</button>';else if(['publishing','deleting','deleted'].includes(status))actionButtons='<button id="reconcile" class="secondary">刷新 PR/MR 状态</button>';document.getElementById('content').innerHTML=candidateNav('detail',id,returnPath)+candidateDetailBody(value)+'<div class="actions">'+actionButtons+'<span id="actionState" class="muted"></span></div>';const reviewAction=(button,reviewStatus,label)=>button.onclick=async()=>{if(!confirm('确认'+label+'该候选？'))return;await runCandidateAction(button,'处理中...',label+'成功',()=>requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id)+'/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:reviewStatus,reviewReason:reviewStatus==='approved'?'useful':'false_positive'})}))};const approve=document.getElementById('approve');if(approve)reviewAction(approve,'approved','批准');const reopen=document.getElementById('reopen');if(reopen)reviewAction(reopen,'approved','重新批准');const reject=document.getElementById('reject');if(reject)reviewAction(reject,'rejected','拒绝');const publish=document.getElementById('publish');if(publish)publish.onclick=()=>runCandidateAction(publish,'发布中...','PR/MR 已创建，等待合并',()=>requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id)+'/publish',{method:'POST'}));const reconcile=document.getElementById('reconcile');if(reconcile)reconcile.onclick=()=>runCandidateAction(reconcile,'刷新中...','PR/MR 状态已刷新',()=>requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id)+'/reconcile',{method:'POST'}));const deletePublished=document.getElementById('deletePublished');if(deletePublished)deletePublished.onclick=async()=>{if(!confirm('确认创建删除 PR/MR？'))return;await runCandidateAction(deletePublished,'创建删除 PR/MR...','删除 PR/MR 已创建，等待合并',()=>requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id)+'/delete-published',{method:'POST'}))};const remove=document.getElementById('deleteCandidate');if(remove)remove.onclick=async()=>{if(!confirm('确认永久删除该 Candidate 及全部状态历史？此操作不可撤销。'))return;remove.disabled=true;try{await requestJson('/admin/api/knowledge-candidates/'+encodeURIComponent(id),{method:'DELETE'});location.assign(returnPath)}catch(e){remove.disabled=false;document.getElementById('actionState').textContent=e.message}}}catch(e){renderDetailError(e,returnPath)}}
function bundleActionButtons(x){let html='';if(['pending','review_stale'].includes(x.status))html+='<button data-bundle-action="approve">批准</button><button data-bundle-action="reject" class="secondary">拒绝</button>';if(x.status==='approved')html+='<button data-bundle-action="publish">发布 PR/MR</button><button data-bundle-action="reject" class="secondary">拒绝</button>';if(x.status==='rejected')html+='<button data-bundle-action="approve">重新批准</button>';if(x.status==='publish_failed')html+='<button data-bundle-action="publish">重试发布 PR/MR</button><button data-bundle-action="reject" class="secondary">拒绝</button>';if(['publishing','published','published_drifted','deleting','deleted'].includes(x.status)&&(x.publication?.kind==='pull-request'||x.deletionPublication))html+='<button data-bundle-action="reconcile" class="secondary">刷新 PR/MR 状态</button>';if(x.status==='published'&&x.publication?.kind==='pull-request')html+='<button data-bundle-action="delete-published" class="danger">删除已发布内容</button>';if(x.status==='delete_failed')html+='<button data-bundle-action="delete-published" class="danger">重试删除已发布内容</button>';if(x.status==='published_drifted')html+='<button data-bundle-action="reimport">基于最新 Target 新建 Import</button>';if(['pending','approved','rejected','publish_failed','review_stale'].includes(x.status))html+='<button data-bundle-delete class="danger">删除 Bundle</button>';return html}
async function runBundleAction(button,id,action){if(action==='delete-published'&&!confirm('确认创建删除 PR/MR？'))return;const old=button.textContent,state=document.getElementById('actionState');button.disabled=true;button.textContent='处理中...';if(state){state.textContent='处理中...';state.className='muted'}try{const result=await requestJson('/admin/api/skill-bundles/'+encodeURIComponent(id)+'/'+action,{method:'POST',headers:{'content-type':'application/json'},body:action==='approve'||action==='reject'?JSON.stringify({reason:'admin review'}):'{}'});const nextId=action==='reimport'&&result.import?.id?result.import.id:id;if(nextId!==id){location.assign('/admin/review/items/skill-bundle/'+encodeURIComponent(nextId));return}await bundleDetail(id)}catch(e){if(state){state.textContent=e.message;state.className='error'}button.disabled=false;button.textContent=old}}
async function bundleDetail(id){currentReviewRoute={kind:'detail',reviewKind:'skill-bundle',id};const returnPath=safeReturnPath(new URLSearchParams(location.search).get('return'),'/admin/review/items');document.getElementById('title').textContent='审核中心 · Bundle 详情';try{const d=await requestJson('/admin/api/skill-bundles/'+encodeURIComponent(id));const x=d.import;let preview,history;try{preview=await requestJson('/admin/api/skill-bundles/'+encodeURIComponent(id)+'/preview')}catch{}try{history=await requestJson('/admin/api/skill-bundles/'+encodeURIComponent(id)+'/history')}catch{}const url=externalPublicationUrl(x.publication?.mergeRequestUrl),deletionUrl=externalPublicationUrl(x.deletionPublication?.mergeRequestUrl);const previewDiff=preview?['Added',...(preview.diff?.added||[]),'','Modified',...(preview.diff?.modified||[]),'','Deleted',...(preview.diff?.deleted||[])].map(esc).join('<br>'):'';const historyRows=(history?.history||[]).map(h=>'<div class="history-item"><b>'+esc(statusLabel(h.status))+'</b><div class="history-meta">'+esc(fmt(h.updatedAt))+(h.review?.reviewer?' · 审核人 '+esc(h.review.reviewer):'')+'</div></div>').join('');document.getElementById('content').innerHTML='<p><a class="link" href="'+esc(returnPath)+'">← 返回审核列表</a></p><div class="subnav"><a class="active" href="/admin/review/items/skill-bundle/'+encodeURIComponent(id)+'?return='+encodeURIComponent(returnPath)+'">Bundle 详情</a><a href="#bundleHistory">历史记录</a></div><div class="candidate-summary"><div><b>ID</b><br>'+esc(x.id)+'</div><div><b>Namespace</b><br>'+esc(x.namespace)+'</div><div><b>Import Type</b><br>'+esc(x.importType)+'</div><div><b>状态</b><br>'+esc(statusLabel(x.status))+'</div><div><b>Repository</b><br>'+esc(x.repository)+'</div><div><b>Reviewer</b><br>'+esc(x.review?.reviewer||'-')+'</div><div class="wide"><b>Replacement Root</b><br>'+esc(x.replacementRoot)+'</div><div class="wide"><b>Snapshot</b><br>'+esc(x.snapshotSha256)+'</div><div><b>Skill</b><br>'+esc(x.skillCount??0)+'</div><div><b>Files</b><br>'+esc(x.fileCount??0)+'</div><div><b>Total Bytes</b><br>'+esc(x.totalBytes??0)+'</div><div class="wide"><b>发布 PR/MR</b><br>'+(url?'<a class="link" target="_blank" rel="noopener noreferrer" href="'+esc(url)+'">打开 PR/MR</a>':'-')+'</div><div class="wide"><b>删除 PR/MR</b><br>'+(deletionUrl?'<a class="link" target="_blank" rel="noopener noreferrer" href="'+esc(deletionUrl)+'">打开删除 PR/MR</a>':'-')+'</div>'+(x.deletionError?'<div class="wide error"><b>删除失败</b><br>'+esc(x.deletionError)+'</div>':'')+'</div>'+(x.status==='published_drifted'?'<p class="error"><b>发布内容漂移：</b>最终 Replacement Root 与审核 Snapshot 不一致。</p>':'')+(preview?'<h3>当前 Preview</h3><div class="diff-list">'+previewDiff+'</div>':'')+'<div class="actions" id="bundleActions">'+bundleActionButtons(x)+'<span id="actionState" class="muted"></span></div><h3 id="bundleHistory">Skill Bundle 历史记录</h3>'+(historyRows?'<div class="history-list">'+historyRows+'</div>':'<div class="empty">暂无历史记录</div>');document.querySelectorAll('[data-bundle-action]').forEach(button=>button.onclick=()=>runBundleAction(button,id,button.dataset.bundleAction));const remove=document.querySelector('[data-bundle-delete]');if(remove)remove.onclick=async()=>{if(!confirm('确认永久删除该 Skill Bundle 审核记录及历史？此操作不会删除远端已创建的分支或 PR/MR，且不可撤销。'))return;remove.disabled=true;const state=document.getElementById('actionState');try{await requestJson('/admin/api/skill-bundles/'+encodeURIComponent(id),{method:'DELETE'});location.assign(returnPath)}catch(e){remove.disabled=false;if(state){state.textContent=e.message;state.className='error'}}}}catch(e){renderDetailError(e,returnPath)}}
function renderDetailError(error,returnPath){document.getElementById('content').innerHTML='<p><a class="link" href="'+esc(returnPath)+'">← 返回审核列表</a></p><div class="detail-error"><b>无法加载审核项</b><div class="error" style="margin-top:8px">'+esc(error.message||String(error))+'</div></div>'}
function historyFilters(q){let html='<label>历史类型<span class="field-help">Candidate 与 Skill Bundle 分来源查看，未混合排序</span><select id="historyType" name="historyType"><option value="candidate" '+(q.get('historyType')!=='skill-bundle'?'selected':'')+'>Candidate</option><option value="skill-bundle" '+(q.get('historyType')==='skill-bundle'?'selected':'')+'>Skill Bundle</option></select></label>';html+=labeledInput('q','关键字','ID / 标题 / Namespace',q);html+='<label>状态<span class="field-help">按历史状态筛选</span><input name="status" value="'+esc(q.get('status')||'')+'"></label>';html+='<label>每页数量<span class="field-help">最多 100</span><select name="limit"><option>20</option><option>50</option><option>100</option></select></label>';return html}
async function reviewHistory(){const q=new URLSearchParams(location.search);if(!q.get('limit'))q.set('limit','20');const bundle=q.get('historyType')==='skill-bundle';document.getElementById('title').textContent='审核中心 · 审核历史';document.getElementById('content').innerHTML='<div class="history-source-note">Candidate 与 Skill Bundle 使用不同历史存储；本页一次展示一个来源，未混合排序。</div><form id="historyFilters" class="grid">'+historyFilters(q)+'</form><div class="actions"><button id="historyApply">筛选</button><button id="historyClear" type="button" class="secondary">清除</button><span id="historyState" class="muted">加载中...</span></div><div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>ID</th><th>标题 / Namespace</th><th>状态</th><th>仓库</th><th>审核人</th><th>操作</th></tr></thead><tbody id="historyRows"></tbody></table></div><div class="actions"><button id="historyPrev" class="secondary">上一页</button><button id="historyNext" class="secondary">下一页</button><span id="historyPage" class="muted"></span></div>';const form=document.getElementById('historyFilters');form.onsubmit=e=>{e.preventDefault();const next=new URLSearchParams(new FormData(form));next.delete('cursor');replaceQuery(next)};document.getElementById('historyApply').onclick=()=>form.requestSubmit();document.getElementById('historyClear').onclick=()=>replaceQuery(new URLSearchParams({historyType:bundle?'skill-bundle':'candidate',limit:q.get('limit')||'20'}));document.getElementById('historyType').onchange=()=>form.requestSubmit();document.querySelector('select[name=limit]').value=q.get('limit')||'20';try{let rows,page;if(bundle){const apiQ=new URLSearchParams(q);apiQ.delete('historyType');apiQ.set('kind','skill-bundle');const d=await requestJson('/admin/api/review-items?'+apiQ);rows=(d.items||[]).map(x=>({updatedAt:x.updatedAt,id:x.id,title:x.title,status:x.status,repository:x.repository,reviewer:x.reviewer,kind:'skill-bundle'}));page=d.page}else{const apiQ=new URLSearchParams(q);apiQ.delete('historyType');const d=await requestJson('/admin/api/knowledge-candidates/history?'+apiQ);rows=(d.history||[]).map(x=>({...x,kind:'candidate'}));page=d.page}document.getElementById('historyRows').innerHTML=rows.length?rows.map(x=>{const href=x.kind==='skill-bundle'?'/admin/review/items/skill-bundle/'+encodeURIComponent(x.id)+'?return='+encodeURIComponent(location.pathname+location.search):'/admin/review/items/candidate/'+encodeURIComponent(x.id)+'/history?return='+encodeURIComponent(location.pathname+location.search);return '<tr><td>'+esc(fmt(x.updatedAt))+'</td><td>'+esc(x.id)+'</td><td>'+esc(x.title||'-')+'</td><td>'+esc(statusLabel(x.status))+'</td><td>'+esc(x.repository||'-')+'</td><td>'+esc(x.reviewer||'-')+'</td><td><a class="link" href="'+href+'">'+(x.kind==='skill-bundle'?'查看 Bundle 历史':'查看 Candidate 历史')+'</a></td></tr>'}).join(''):'<tr><td colspan="7" class="empty">暂无历史记录</td></tr>';const prev=document.getElementById('historyPrev'),next=document.getElementById('historyNext');prev.disabled=!page?.previousCursor;next.disabled=!page?.nextCursor;prev.onclick=()=>{if(page?.previousCursor)replaceQuery(queryUrl({cursor:page.previousCursor}))};next.onclick=()=>{if(page?.nextCursor)replaceQuery(queryUrl({cursor:page.nextCursor}))};document.getElementById('historyPage').textContent='共 '+(page?.total??rows.length)+' 条';document.getElementById('historyState').textContent=rows.length?'已加载':'空结果'}catch(e){document.getElementById('historyState').className='error';document.getElementById('historyState').textContent=e.message}}
async function gapsList(){const q=new URLSearchParams(location.search);if(!q.get('limit'))q.set('limit','20');document.getElementById('title').textContent='知识缺口';document.getElementById('content').innerHTML='<form id="gapFilters" class="grid">'+labeledInput('q','关键字','搜索问题 / Key',q)+labeledInput('status','状态','active / resolved / ignored',q)+'<label>每页数量<select name="limit"><option>20</option><option>50</option><option>100</option></select></label></form><div class="actions"><button id="gapApply">筛选</button><button id="gapClear" class="secondary" type="button">清除</button></div><div class="table-wrap"><table class="table"><thead><tr><th>问题</th><th>Key</th><th>状态</th><th>次数</th><th>来源</th><th>最近出现</th><th>候选</th></tr></thead><tbody id="gapRows"></tbody></table></div><div class="actions"><button id="gapPrev" class="secondary">上一页</button><button id="gapNext" class="secondary">下一页</button><span id="gapPage" class="muted"></span></div>';const form=document.getElementById('gapFilters');form.onsubmit=e=>{e.preventDefault();const next=new URLSearchParams(new FormData(form));next.delete('cursor');location.assign('/admin/gaps/items?'+next)};document.getElementById('gapApply').onclick=()=>form.requestSubmit();document.getElementById('gapClear').onclick=()=>location.assign('/admin/gaps/items');document.querySelector('select[name=limit]').value=q.get('limit')||'20';const d=await requestJson('/admin/api/knowledge-gaps?'+q);const rows=d.gaps||[];document.getElementById('gapRows').innerHTML=rows.length?rows.map(x=>'<tr><td><a class="link" href="/admin/gaps/items/'+encodeURIComponent(x.key)+'">'+esc(x.query)+'</a></td><td>'+esc(x.key)+'</td><td>'+esc(x.management?.status||'active')+'</td><td>'+esc(x.occurrences)+'</td><td>'+esc(x.source)+'</td><td>'+esc(fmt(x.lastSeenAt))+'</td><td>'+esc(x.management?.candidateId||'-')+'</td></tr>').join(''):'<tr><td colspan="7" class="empty">暂无记录</td></tr>';const p=d.page||{},prev=document.getElementById('gapPrev'),next=document.getElementById('gapNext');prev.disabled=!p.previousCursor;next.disabled=!p.nextCursor;prev.onclick=()=>{if(!p.previousCursor)return;const nextQuery=new URLSearchParams(q);nextQuery.set('cursor',p.previousCursor);location.assign('/admin/gaps/items?'+nextQuery)};next.onclick=()=>{if(!p.nextCursor)return;const nextQuery=new URLSearchParams(q);nextQuery.set('cursor',p.nextCursor);location.assign('/admin/gaps/items?'+nextQuery)};document.getElementById('gapPage').textContent='共 '+(p.total??rows.length)+' 条 · 当前偏移 '+(p.cursor??0)}
async function gapDetail(id){document.getElementById('title').textContent='知识缺口 · 详情';try{const d=await requestJson('/admin/api/knowledge-gaps/'+encodeURIComponent(id));const value=redact(d.gap||d);document.getElementById('content').innerHTML='<p><a class="link" href="/admin/gaps/items">← 返回</a></p><pre class="raw">'+esc(JSON.stringify(value,null,2))+'</pre><div class="actions"><button id="resolve">标记已解决</button><button id="ignore" class="secondary">忽略</button><button id="candidate">创建候选</button></div>';for(const [name,status] of [['resolve','resolved'],['ignore','ignored']])document.getElementById(name).onclick=async()=>{const b=document.getElementById(name);b.disabled=true;try{await requestJson('/admin/api/knowledge-gaps/'+encodeURIComponent(id),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status})});await gapDetail(id)}catch(e){b.disabled=false;alert(e.message)}};document.getElementById('candidate').onclick=async()=>{const b=document.getElementById('candidate');b.disabled=true;try{await requestJson('/admin/api/knowledge-gaps/'+encodeURIComponent(id)+'/candidate',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await gapDetail(id)}catch(e){b.disabled=false;alert(e.message)}}}catch(e){document.getElementById('content').innerHTML='<p class="error">'+esc(e.message)+'</p>'}}
async function boot(){try{if(legacyReviewRedirect())return;if(review){currentReviewRoute=reviewRoute();if(currentReviewRoute.kind==='list')return await reviewList();if(currentReviewRoute.kind==='history')return await reviewHistory();if(currentReviewRoute.kind==='detail'&&currentReviewRoute.reviewKind==='candidate')return currentReviewRoute.history?await candidateHistory(currentReviewRoute.id):await candidateDetail(currentReviewRoute.id);if(currentReviewRoute.kind==='detail'&&currentReviewRoute.reviewKind==='skill-bundle')return await bundleDetail(currentReviewRoute.id);document.getElementById('content').innerHTML='<p class="error">未知审核路由</p>';return}if(gaps){if(parts.length>=4)return await gapDetail(safeDecode(parts[3]));return await gapsList()}document.getElementById('content').innerHTML='<p class="error">未知 Admin 模块</p>'}catch(e){document.getElementById('content').innerHTML='<p class="error">'+esc(e.message)+'</p>'}}
addEventListener('popstate',boot);boot();
</script></body></html>`;
