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
.ok{color:#117a45}.error{color:#b42318}.muted{color:#667085;font-size:13px}code{background:#eef2f7;padding:2px 5px;border-radius:4px}.key-list{display:grid;gap:10px;margin-top:14px}.key-row{border:1px solid #e4e8f0;border-radius:10px;padding:12px}.key-row-top{display:flex;justify-content:space-between;gap:12px;align-items:center}.key-meta{font-size:13px;color:#667085;margin-top:6px}.one-time{display:none;margin-top:14px;padding:14px;border:1px solid #a6c8ff;background:#f1f7ff;border-radius:10px}.one-time input{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
@media(max-width:760px){.grid{grid-template-columns:1fr}.wrap{padding:14px}}
</style>
</head>
<body><div class="wrap">
<h1>Team Skill Hub</h1><div class="muted">后台管理 · 动态配置</div>
<div class="card">
<h2>管理员认证</h2>
<label>Admin API Key</label><input id="key" type="password" autocomplete="current-password" placeholder="ADMIN_API_KEY">
<div class="muted">Key 仅保存在当前浏览器 sessionStorage，不会写入服务端配置文件。</div>
</div>
<div class="card">
<h2>运行参数</h2>
<div class="grid">
<div><label>Revision Retention</label><input id="retention" type="number" min="2"></div>
<div><label>Webhook Dedup Entries</label><input id="dedupEntries" type="number" min="100"></div>
<div><label>Webhook Dedup TTL (s)</label><input id="dedupTtl" type="number" min="3600"></div>
</div>
<label>Default Roles（逗号分隔）</label><input id="roles">
</div>
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
<div class="card">
<h2>Repositories</h2>
<div class="muted">编辑仓库运行配置。Git 密钥/Token 推荐继续使用环境变量或 Docker Secret；这里保存的是引用和非敏感配置。</div>
<label>Repository JSON</label><textarea id="repos"></textarea>
<div class="actions"><button id="save">保存并立即应用</button><button id="reload" class="secondary">重新加载</button><span id="status"></span></div>
</div>
<div class="card">
<h2>Bootstrap / Secrets</h2><div id="bootstrap" class="muted">加载中...</div>
</div>
</div>
<script>
const key = document.getElementById("key");
key.value = sessionStorage.getItem("skillHubAdminKey") || "";
key.addEventListener("change",()=>sessionStorage.setItem("skillHubAdminKey",key.value));
const statusEl=document.getElementById("status");
const apiKeyStatus=document.getElementById("apiKeyStatus");
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
 if(!confirm("确定删除这个 API Key？删除后客户端会立即失效。"))return;
 const r=await fetch("/admin/api/api-keys/"+encodeURIComponent(id),{method:"DELETE",headers:headers()});const data=await r.json();
 if(!r.ok){apiKeyStatus.textContent=data.error||"删除失败";apiKeyStatus.className="error";return}
 await loadApiKeys();
}
function headers(){return {"content-type":"application/json","x-skill-hub-admin-key":key.value}}
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
 document.getElementById("bootstrap").innerHTML=
   "Admin API Key: <b>"+(data.bootstrap.adminKeyConfigured?"已配置":"未配置")+"</b>　"+
   "Webhook Secret: <b>"+(data.bootstrap.webhookSecretConfigured?"已配置":"未配置")+"</b>　"+
   "GitLab Token: <b>"+(data.bootstrap.gitlabTokenConfigured?"已配置":"未配置")+"</b>";
 statusEl.textContent="已加载";statusEl.className="ok";
 await loadApiKeys();
}
async function save(){
 try{
  sessionStorage.setItem("skillHubAdminKey",key.value);
  const body={
   defaultRoles:document.getElementById("roles").value.split(",").map(x=>x.trim()).filter(Boolean),
   revisionRetentionMax:Number(document.getElementById("retention").value),
   webhookDedupMaxEntries:Number(document.getElementById("dedupEntries").value),
   webhookDedupTtlSeconds:Number(document.getElementById("dedupTtl").value),
   repositories:JSON.parse(document.getElementById("repos").value)
  };
  statusEl.textContent="保存中...";statusEl.className="";
  const r=await fetch("/admin/api/config",{method:"PUT",headers:headers(),body:JSON.stringify(body)});
  const data=await r.json();
  if(!r.ok)throw new Error(data.error||"保存失败");
  statusEl.textContent="已保存并应用";statusEl.className="ok";
  await load();
 }catch(e){statusEl.textContent=e.message||String(e);statusEl.className="error"}
}
document.getElementById("createApiKey").onclick=createApiKey;
document.getElementById("copyApiKey").onclick=async()=>{await navigator.clipboard.writeText(document.getElementById("newApiKey").value);apiKeyStatus.textContent="已复制";apiKeyStatus.className="ok"};
document.getElementById("save").onclick=save;
document.getElementById("reload").onclick=load;
load();
</script>
</body></html>`;
