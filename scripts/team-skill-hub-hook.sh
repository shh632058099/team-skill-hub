#!/usr/bin/env bash
set -u

CONFIG="${TEAM_SKILL_HUB_HOOK_CONFIG:-}"
if [[ -z "$CONFIG" && -n "${PLUGIN_ROOT:-}" && -f "${PLUGIN_ROOT}/hooks/team-skill-hub.conf" ]]; then
  CONFIG="${PLUGIN_ROOT}/hooks/team-skill-hub.conf"
fi
if [[ -z "$CONFIG" ]]; then CONFIG="${CODEX_HOME:-$HOME/.codex}/hooks/team-skill-hub.conf"; fi
[[ -f "$CONFIG" ]] || exit 0

EVENT_URL=""
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
CAPTURE_STOP_MESSAGE="false"
HOOK_RUNTIME_VERSION="unknown"
HOOK_SCHEMA_VERSION="0"
while IFS='=' read -r key value; do
  case "$key" in
    event_url) EVENT_URL="$value" ;;
    api_key_env) API_KEY_ENV="$value" ;;
    capture_stop_message) CAPTURE_STOP_MESSAGE="$value" ;;
    runtime_version) HOOK_RUNTIME_VERSION="$value" ;;
    hook_schema_version) HOOK_SCHEMA_VERSION="$value" ;;
  esac
done < "$CONFIG"

[[ -n "$EVENT_URL" ]] || exit 0
API_KEY="${!API_KEY_ENV:-}"
[[ -n "$API_KEY" ]] || exit 0
export CAPTURE_STOP_MESSAGE HOOK_RUNTIME_VERSION HOOK_SCHEMA_VERSION

INPUT="$(cat)"
PAYLOAD=""

if command -v python3 >/dev/null 2>&1; then
  PAYLOAD="$(printf '%s' "$INPUT" | python3 -c 'import json,sys,os,re,subprocess
try:
 x=json.load(sys.stdin);m={"runtime_version":os.environ.get("HOOK_RUNTIME_VERSION","unknown"),"hook_schema_version":int(os.environ.get("HOOK_SCHEMA_VERSION","0") or 0)}
 if x.get("hook_event_name")=="SessionStart" and isinstance(x.get("cwd"),str) and x.get("cwd"):
  def git(*args):
   try:return subprocess.check_output(["git","-C",x["cwd"],*args],stderr=subprocess.DEVNULL,text=True,timeout=.4).strip()[:1000]
   except Exception:return ""
  remote=git("config","--get","remote.origin.url")
  if remote:
   remote=re.sub(r"^([a-z][a-z0-9+.-]*://)[^/@]+@",r"\1",remote,flags=re.I)
   m["git_remote"]=remote
  root=git("rev-parse","--show-toplevel")
  if root:m["git_root"]=root[:1000]
  branch=git("branch","--show-current") or git("rev-parse","--abbrev-ref","HEAD")
  if branch and branch!="HEAD":m["git_branch"]=branch[:300]
 for k in ("tool_name","tool_use_id","source","reason","trigger","start_source","end_reason","compact_trigger","stop_hook_active"):
  if k in x and isinstance(x[k],(str,int,float,bool)): m[k]=x[k]
 evidence={}
 aliases={"exit_code":"exit_code","exitCode":"exit_code","returncode":"exit_code","success":"success","ok":"success","tests_run_count":"tests_run","testsRunCount":"tests_run","tests_passed":"tests_passed","testsPassed":"tests_passed","tests_failed":"tests_failed","testsFailed":"tests_failed","duration_ms":"duration_ms","durationMs":"duration_ms","status":"status","execution_state":"status"}
 def walk(v,d=0):
  if d>4:return
  if isinstance(v,dict):
   for k,val in list(v.items())[:50]:
    name=aliases.get(k)
    if name:
     if isinstance(val,(bool,int,float)): evidence.setdefault(name,val)
     elif name=="status" and isinstance(val,str) and len(val)<=40: evidence.setdefault(name,val)
    if isinstance(val,(dict,list)): walk(val,d+1)
  elif isinstance(v,list):
   for item in v[:20]:
    if isinstance(item,(dict,list)): walk(item,d+1)
 if x.get("hook_event_name")=="PostToolUse": walk(x.get("tool_response"))
 if "exit_code" in evidence and "success" not in evidence: evidence["success"]=evidence["exit_code"]==0
 if evidence:m["evidence"]=evidence
 if x.get("hook_event_name")=="Stop" and os.environ.get("CAPTURE_STOP_MESSAGE","").lower()=="true":
  msg=x.get("last_assistant_message")
  if isinstance(msg,str) and msg.strip():
   msg=re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}","[redacted-email]",msg)
   msg=re.sub(r"(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}","[redacted-token]",msg)
   msg=re.sub(r"(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+",r"\1=[redacted]",msg)
   m["assistant_result_excerpt"]=msg.strip()[:4000]
 o={"schema_version":1,"client":"codex","event":str(x.get("hook_event_name","")),"session_id":str(x.get("session_id","")),"turn_id":x.get("turn_id"),"cwd":x.get("cwd"),"model":x.get("model"),"permission_mode":x.get("permission_mode"),"metadata":m}
 if o["event"] and o["session_id"]: print(json.dumps(o,separators=(",",":")))
except Exception: pass' 2>/dev/null)"
elif command -v node >/dev/null 2>&1; then
  PAYLOAD="$(printf '%s' "$INPUT" | node -e 'const {execFileSync}=require("child_process");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const x=JSON.parse(s),m={runtime_version:process.env.HOOK_RUNTIME_VERSION||"unknown",hook_schema_version:Number(process.env.HOOK_SCHEMA_VERSION||0)},e={};if(x.hook_event_name==="SessionStart"&&typeof x.cwd==="string"&&x.cwd){const git=(...a)=>{try{return execFileSync("git",["-C",x.cwd,...a],{encoding:"utf8",timeout:400,stdio:["ignore","pipe","ignore"]}).trim().slice(0,1000)}catch{return""}};let remote=git("config","--get","remote.origin.url");if(remote){remote=remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i,"$1");m.git_remote=remote}const root=git("rev-parse","--show-toplevel");if(root)m.git_root=root;const branch=git("branch","--show-current")||git("rev-parse","--abbrev-ref","HEAD");if(branch&&branch!=="HEAD")m.git_branch=branch.slice(0,300)};for(const k of ["tool_name","tool_use_id","source","reason","trigger","start_source","end_reason","compact_trigger","stop_hook_active"])if(["string","number","boolean"].includes(typeof x[k]))m[k]=x[k];const a={exit_code:"exit_code",exitCode:"exit_code",returncode:"exit_code",success:"success",ok:"success",tests_run_count:"tests_run",testsRunCount:"tests_run",tests_passed:"tests_passed",testsPassed:"tests_passed",tests_failed:"tests_failed",testsFailed:"tests_failed",duration_ms:"duration_ms",durationMs:"duration_ms",status:"status",execution_state:"status"};const walk=(v,d=0)=>{if(d>4||v==null)return;if(Array.isArray(v)){for(const i of v.slice(0,20))if(i&&typeof i==="object")walk(i,d+1);return}if(typeof v!=="object")return;for(const [k,val] of Object.entries(v).slice(0,50)){const n=a[k];if(n){if(["boolean","number"].includes(typeof val))e[n]??=val;else if(n==="status"&&typeof val==="string"&&val.length<=40)e[n]??=val}if(val&&typeof val==="object")walk(val,d+1)}};if(x.hook_event_name==="PostToolUse")walk(x.tool_response);if(e.exit_code!==undefined&&e.success===undefined)e.success=e.exit_code===0;if(Object.keys(e).length)m.evidence=e;if(x.hook_event_name==="Stop"&&String(process.env.CAPTURE_STOP_MESSAGE||"").toLowerCase()==="true"&&typeof x.last_assistant_message==="string"){let msg=x.last_assistant_message.trim().replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,"[redacted-email]").replace(/(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}/g,"[redacted-token]").replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"$1=[redacted]");if(msg)m.assistant_result_excerpt=msg.slice(0,4000)}const o={schema_version:1,client:"codex",event:String(x.hook_event_name||""),session_id:String(x.session_id||""),turn_id:x.turn_id,cwd:x.cwd,model:x.model,permission_mode:x.permission_mode,metadata:m};if(o.event&&o.session_id)process.stdout.write(JSON.stringify(o))}catch{}})' 2>/dev/null)"
fi

[[ -n "$PAYLOAD" ]] || exit 0
curl -fsS --max-time 2 -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" --data-binary "$PAYLOAD" "$EVENT_URL" >/dev/null 2>&1 || true
exit 0