#!/usr/bin/env bash
set -euo pipefail

HUB_URL=""
SERVER_NAME="teamSkillHub"
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
SKIP_MCP="false"
AUTO_KNOWLEDGE="true"
UPGRADE="false"
SERVER_NAME_EXPLICIT="false"
API_KEY_ENV_EXPLICIT="false"
AUTO_KNOWLEDGE_EXPLICIT="false"
HOOK_RUNTIME_VERSION="1.1.0"
HOOK_SCHEMA_VERSION="1"

CLAUDE_BEGIN="<!-- BEGIN TEAM-SKILL-HUB -->"
CLAUDE_END="<!-- END TEAM-SKILL-HUB -->"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) HUB_URL="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; SERVER_NAME_EXPLICIT="true"; shift 2 ;;
    --api-key-env) API_KEY_ENV="${2:-}"; API_KEY_ENV_EXPLICIT="true"; shift 2 ;;
    --skip-mcp) SKIP_MCP="true"; shift ;;
    --auto-knowledge) AUTO_KNOWLEDGE="true"; AUTO_KNOWLEDGE_EXPLICIT="true"; shift ;;
    --no-auto-knowledge) AUTO_KNOWLEDGE="false"; AUTO_KNOWLEDGE_EXPLICIT="true"; shift ;;
    --upgrade) UPGRADE="true"; shift ;;
    -h|--help)
      echo "Usage: setup-claude-code.sh --url <hub-mcp-url> [--server-name <name>] [--api-key-env <name>] [--skip-mcp] [--auto-knowledge|--no-auto-knowledge] [--upgrade]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
HOOKS_DIR="$CLAUDE_DIR/hooks"
HOOK_CONF="$HOOKS_DIR/team-skill-hub.conf"
STOP_GATE="$HOOKS_DIR/team-skill-hub-claude-stop.sh"

if [[ "$UPGRADE" == "true" && -f "$HOOK_CONF" ]]; then
  existing_event_url="$(awk -F= '$1=="event_url"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_mcp_url="$(awk -F= '$1=="mcp_url"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_server_name="$(awk -F= '$1=="server_name"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_api_key_env="$(awk -F= '$1=="api_key_env"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_auto_knowledge="$(awk -F= '$1=="capture_stop_message"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  if [[ -z "$HUB_URL" ]]; then
    if [[ -n "$existing_mcp_url" ]]; then HUB_URL="$existing_mcp_url";
    elif [[ -n "$existing_event_url" ]]; then HUB_URL="${existing_event_url%/client-events/claude-code}/mcp";
    fi
  fi
  if [[ "$SERVER_NAME_EXPLICIT" != "true" && -n "$existing_server_name" ]]; then SERVER_NAME="$existing_server_name"; fi
  if [[ "$API_KEY_ENV_EXPLICIT" != "true" && -n "$existing_api_key_env" ]]; then API_KEY_ENV="$existing_api_key_env"; fi
  if [[ "$AUTO_KNOWLEDGE_EXPLICIT" != "true" && -n "$existing_auto_knowledge" ]]; then AUTO_KNOWLEDGE="$existing_auto_knowledge"; fi
fi

if [[ -z "$HUB_URL" ]]; then read -r -p "Team Skill Hub MCP URL: " HUB_URL; fi
[[ "$HUB_URL" =~ ^https?:// ]] || { echo "URL must start with http:// or https://" >&2; exit 2; }
[[ "$SERVER_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid server name" >&2; exit 2; }
[[ "$API_KEY_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid API key env name" >&2; exit 2; }

MCP_URL="${HUB_URL%/}"
if [[ "$MCP_URL" != */mcp ]]; then MCP_URL="${MCP_URL%/}/mcp"; fi
BASE_URL="${MCP_URL%/mcp}"
EVENT_URL="${BASE_URL}/client-events/claude-code"

mkdir -p "$CLAUDE_DIR" "$HOOKS_DIR"
touch "$SETTINGS_FILE" "$CLAUDE_MD"
export SETTINGS_FILE EVENT_URL API_KEY_ENV

if command -v python3 >/dev/null 2>&1; then
  python3 <<'PY'
import json, os
path=os.environ["SETTINGS_FILE"]; url=os.environ["EVENT_URL"]; key=os.environ["API_KEY_ENV"]
try:
    with open(path,"r",encoding="utf-8") as f:
        content=f.read().strip()
    root=json.loads(content) if content else {}
except json.JSONDecodeError:
    raise SystemExit("Existing Claude settings.json is invalid JSON; leaving it unchanged.")
hooks=root.setdefault("hooks",{})
http_handler={"type":"http","url":url,"timeout":2,"headers":{"Authorization":"Bearer ${"+key+"}"},"allowedEnvVars":[key]}
for event in ["SessionStart","UserPromptSubmit","PostToolUse","SessionEnd"]:
    kept=[]
    for group in hooks.get(event,[]) or []:
        handlers=[h for h in (group.get("hooks",[]) or []) if not (h.get("type")=="http" and "/client-events/claude-code" in str(h.get("url","")))]
        if handlers:
            copy=dict(group); copy["hooks"]=handlers; kept.append(copy)
    kept.append({"hooks":[http_handler]}); hooks[event]=kept
kept=[]
for group in hooks.get("Stop",[]) or []:
    handlers=[h for h in (group.get("hooks",[]) or []) if "team-skill-hub-claude-stop" not in str(h.get("command",""))]
    if handlers:
        copy=dict(group); copy["hooks"]=handlers; kept.append(copy)
kept.append({"hooks":[{"type":"command","command":'bash "$HOME/.claude/hooks/team-skill-hub-claude-stop.sh"',"timeout":4}]})
hooks["Stop"]=kept
with open(path,"w",encoding="utf-8") as f:
    json.dump(root,f,ensure_ascii=False,indent=2); f.write("\n")
PY
elif command -v node >/dev/null 2>&1; then
  node <<'NODE'
const fs=require("fs"),path=process.env.SETTINGS_FILE,url=process.env.EVENT_URL,key=process.env.API_KEY_ENV;
let root={};if(fs.existsSync(path)&&fs.readFileSync(path,"utf8").trim()){try{root=JSON.parse(fs.readFileSync(path,"utf8"))}catch{console.error("Existing Claude settings.json is invalid JSON; leaving it unchanged.");process.exit(2)}}
root.hooks ||= {};
const httpHandler={type:"http",url,timeout:2,headers:{Authorization:"Bearer ${"+key+"}"},allowedEnvVars:[key]};
for(const event of ["SessionStart","UserPromptSubmit","PostToolUse","SessionEnd"]){const kept=[];for(const group of (root.hooks[event]||[])){const hs=(group.hooks||[]).filter(h=>!(h.type==="http"&&String(h.url||"").includes("/client-events/claude-code")));if(hs.length)kept.push({...group,hooks:hs})}kept.push({hooks:[httpHandler]});root.hooks[event]=kept}
const kept=[];for(const group of (root.hooks.Stop||[])){const hs=(group.hooks||[]).filter(h=>!String(h.command||"").includes("team-skill-hub-claude-stop"));if(hs.length)kept.push({...group,hooks:hs})}kept.push({hooks:[{type:"command",command:'bash "$HOME/.claude/hooks/team-skill-hub-claude-stop.sh"',timeout:4}]});root.hooks.Stop=kept;
fs.writeFileSync(path,JSON.stringify(root,null,2)+"\n","utf8");
NODE
else
  echo "python3 or node is required to merge Claude settings.json" >&2
  exit 2
fi

cp "$(dirname "${BASH_SOURCE[0]}")/team-skill-hub-claude-stop.sh" "$STOP_GATE"
chmod +x "$STOP_GATE"

printf 'event_url=%s\nmcp_url=%s\nserver_name=%s\napi_key_env=%s\ncapture_stop_message=%s\nruntime_version=%s\nhook_schema_version=%s\n' \
  "$EVENT_URL" "$MCP_URL" "$SERVER_NAME" "$API_KEY_ENV" "$AUTO_KNOWLEDGE" "$HOOK_RUNTIME_VERSION" "$HOOK_SCHEMA_VERSION" > "$HOOK_CONF"

replace_block() {
  local file="$1" begin="$2" end="$3" block="$4" tmp
  tmp="$(mktemp)"
  awk -v b="$begin" -v e="$end" '$0==b{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$file" > "$tmp"
  while [[ -s "$tmp" ]] && [[ -z "$(tail -n 1 "$tmp")" ]]; do sed -i '$d' "$tmp"; done
  [[ -s "$tmp" ]] && printf '\n\n' >> "$tmp"
  cat "$block" >> "$tmp"
  printf '\n' >> "$tmp"
  mv "$tmp" "$file"
}

claude_block="$(mktemp)"
cat > "$claude_block" <<EOF
$CLAUDE_BEGIN
## Team Skill Hub

Use the \`$SERVER_NAME\` MCP server proactively for team-specific engineering work.

For non-trivial engineering tasks:
1. Query Team Skill Hub before implementing or reviewing from scratch when reusable internal guidance may exist.
2. Prefer \`discover\` first to get relevant Skills, Knowledge, Prompts, and Agents in one request.
3. Load only the selected assets with \`get_skill\`, \`get_knowledge\`, \`get_prompt\`, or \`get_agent\`; do not load every candidate.
4. Use the category-specific search tools only when \`discover\` needs to be narrowed or a specific asset type is required.
5. Prefer relevant team assets over generic assumptions.
6. Respect repository visibility, role filtering, and client compatibility.
7. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use \`submit_feedback\` with a concise evidence-based reason.
8. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, use \`submit_knowledge_candidate\` with concise source-grounded content. Do not submit secrets, credentials, customer-sensitive data, or speculative conclusions.
9. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.

Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.
$CLAUDE_END
EOF
replace_block "$CLAUDE_MD" "$CLAUDE_BEGIN" "$CLAUDE_END" "$claude_block"
rm -f "$claude_block"

if [[ "$SKIP_MCP" != "true" ]]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "Warning: claude CLI not found; Hooks installed, MCP registration skipped." >&2
  else
    claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1 || true
    mcp_json="$(printf '{"type":"http","url":"%s","headers":{"Authorization":"Bearer ${%s}"}}' "$MCP_URL" "$API_KEY_ENV")"
    claude mcp add-json "$SERVER_NAME" "$mcp_json" --scope user
  fi
fi

echo "Configured Claude Code hooks: $SETTINGS_FILE"
echo "Hook endpoint: $EVENT_URL"
echo "Configured global CLAUDE.md block: $CLAUDE_MD"
echo "Install state: $HOOK_CONF"
echo "Auto Knowledge capture: $AUTO_KNOWLEDGE"
if [[ "$SKIP_MCP" != "true" ]] && command -v claude >/dev/null 2>&1; then
  echo "MCP URL: $MCP_URL"
fi
echo "API key environment variable: $API_KEY_ENV"
echo "Set before starting Claude Code: export $API_KEY_ENV='<your-api-key>'"
echo "Verify with: claude mcp get $SERVER_NAME"
