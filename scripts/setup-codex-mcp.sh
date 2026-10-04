#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVER_NAME="teamSkillHub"
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
MCP_URL=""
AUTO_KNOWLEDGE="true"
HOOK_RUNTIME_VERSION="1.1.0"
HOOK_SCHEMA_VERSION="1"
UPGRADE="false"
SERVER_NAME_EXPLICIT="false"
API_KEY_ENV_EXPLICIT="false"
AUTO_KNOWLEDGE_EXPLICIT="false"

MCP_BEGIN="# BEGIN TEAM-SKILL-HUB MCP"
MCP_END="# END TEAM-SKILL-HUB MCP"
AGENTS_BEGIN="<!-- BEGIN TEAM-SKILL-HUB -->"
AGENTS_END="<!-- END TEAM-SKILL-HUB -->"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) MCP_URL="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; SERVER_NAME_EXPLICIT="true"; shift 2 ;;
    --api-key-env) API_KEY_ENV="${2:-}"; API_KEY_ENV_EXPLICIT="true"; shift 2 ;;
    --auto-knowledge) AUTO_KNOWLEDGE="true"; AUTO_KNOWLEDGE_EXPLICIT="true"; shift ;;
    --no-auto-knowledge) AUTO_KNOWLEDGE="false"; AUTO_KNOWLEDGE_EXPLICIT="true"; shift ;;
    --upgrade) UPGRADE="true"; shift ;;
    -h|--help)
      echo "Usage: setup-codex-mcp.sh [--url <mcp-url>] [--server-name <name>] [--api-key-env <name>] [--auto-knowledge|--no-auto-knowledge] [--upgrade]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_DIR/config.toml"
AGENTS_FILE="$CODEX_DIR/AGENTS.md"
HOOKS_DIR="$CODEX_DIR/hooks"
HOOKS_JSON="$CODEX_DIR/hooks.json"
HOOK_CONF="$HOOKS_DIR/team-skill-hub.conf"
SH_HOOK="$HOOKS_DIR/team-skill-hub-hook.sh"
PS_HOOK="$HOOKS_DIR/team-skill-hub-hook.ps1"
if [[ "$UPGRADE" == "true" && -f "$HOOK_CONF" ]]; then
  existing_event_url="$(awk -F= '$1=="event_url"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_server_name="$(awk -F= '$1=="server_name"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_api_key_env="$(awk -F= '$1=="api_key_env"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  existing_auto_knowledge="$(awk -F= '$1=="capture_stop_message"{print substr($0,index($0,"=")+1);exit}' "$HOOK_CONF")"
  if [[ -z "$MCP_URL" && -n "$existing_event_url" ]]; then MCP_URL="${existing_event_url%/client-events}/mcp"; fi
  if [[ "$SERVER_NAME_EXPLICIT" != "true" && -n "$existing_server_name" ]]; then SERVER_NAME="$existing_server_name"; fi
  if [[ "$API_KEY_ENV_EXPLICIT" != "true" && -n "$existing_api_key_env" ]]; then API_KEY_ENV="$existing_api_key_env"; fi
  if [[ "$AUTO_KNOWLEDGE_EXPLICIT" != "true" && -n "$existing_auto_knowledge" ]]; then AUTO_KNOWLEDGE="$existing_auto_knowledge"; fi
fi

if [[ -z "$MCP_URL" ]]; then
  read -r -p "Team Skill Hub MCP URL: " MCP_URL
fi

[[ "$MCP_URL" =~ ^https?:// ]] || { echo "MCP URL must start with http:// or https://" >&2; exit 2; }
[[ "$SERVER_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid server name" >&2; exit 2; }
[[ "$API_KEY_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid API key env name" >&2; exit 2; }
MCP_BASE="${MCP_URL%/}"
EVENT_URL="${MCP_BASE%/mcp}/client-events"

mkdir -p "$CODEX_DIR" "$HOOKS_DIR"
touch "$CODEX_CONFIG" "$AGENTS_FILE"

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

if ! grep -Fqx "$MCP_BEGIN" "$CODEX_CONFIG"; then
  tmp="$(mktemp)"
  awk -v s="[mcp_servers.$SERVER_NAME]" '$0==s{skip=1;next} skip&&/^\[[^]]+\]/{skip=0} !skip{print}' "$CODEX_CONFIG" > "$tmp"
  mv "$tmp" "$CODEX_CONFIG"
fi

mcp_block="$(mktemp)"
cat > "$mcp_block" <<EOF
$MCP_BEGIN
[mcp_servers.$SERVER_NAME]
url = "$MCP_URL"
bearer_token_env_var = "$API_KEY_ENV"
$MCP_END
EOF
replace_block "$CODEX_CONFIG" "$MCP_BEGIN" "$MCP_END" "$mcp_block"
rm -f "$mcp_block"

agents_block="$(mktemp)"
cat > "$agents_block" <<EOF
$AGENTS_BEGIN
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
$AGENTS_END
EOF
replace_block "$AGENTS_FILE" "$AGENTS_BEGIN" "$AGENTS_END" "$agents_block"
rm -f "$agents_block"

cp "$SCRIPT_DIR/team-skill-hub-hook.sh" "$SH_HOOK"
cp "$SCRIPT_DIR/team-skill-hub-hook.ps1" "$PS_HOOK"
chmod +x "$SH_HOOK"
printf 'event_url=%s\nserver_name=%s\napi_key_env=%s\ncapture_stop_message=%s\nruntime_version=%s\nhook_schema_version=%s\n' "$EVENT_URL" "$SERVER_NAME" "$API_KEY_ENV" "$AUTO_KNOWLEDGE" "$HOOK_RUNTIME_VERSION" "$HOOK_SCHEMA_VERSION" > "$HOOK_CONF"

export HOOKS_JSON SH_HOOK PS_HOOK
if command -v python3 >/dev/null 2>&1; then
  python3 <<'PY'
import json,os
path=os.environ["HOOKS_JSON"]
try:
    with open(path,"r",encoding="utf-8") as f: root=json.load(f)
except FileNotFoundError:
    root={}
except json.JSONDecodeError:
    raise SystemExit("Existing hooks.json is invalid JSON; leaving it unchanged.")
hooks=root.setdefault("hooks",{})
events=["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PreCompact","PostCompact","Stop","SessionEnd"]
sh=os.environ["SH_HOOK"].replace("\\","/")
ps=os.environ["PS_HOOK"]
handler={"type":"command","command":f'bash "{sh}"',"commandWindows":f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{ps}"',"async":True,"timeout":2}
for event in events:
    kept=[]
    for group in hooks.get(event,[]) or []:
        handlers=[h for h in (group.get("hooks",[]) or []) if "team-skill-hub-hook" not in str(h.get("command","")) and "team-skill-hub-hook" not in str(h.get("commandWindows",""))]
        if handlers:
            g=dict(group);g["hooks"]=handlers;kept.append(g)
    group={"hooks":[handler]}
    if event in ("PreToolUse","PreCompact","PostCompact"):
        group["matcher"]="^__team_skill_hub_reserved__$"
    kept.append(group)
    hooks[event]=kept
root.setdefault("description","Codex lifecycle hooks including Team Skill Hub client events.")
with open(path,"w",encoding="utf-8") as f: json.dump(root,f,ensure_ascii=False,indent=2);f.write("\n")
PY
elif command -v node >/dev/null 2>&1; then
  node <<'NODE'
const fs=require("fs");const path=process.env.HOOKS_JSON;let root={};if(fs.existsSync(path)){try{root=JSON.parse(fs.readFileSync(path,"utf8"))}catch{console.error("Existing hooks.json is invalid JSON; leaving it unchanged.");process.exit(2)}}
root.hooks ||= {};
const events=["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PreCompact","PostCompact","Stop","SessionEnd"];
const handler={type:"command",command:`bash "${process.env.SH_HOOK.replaceAll("\\","/")}"`,commandWindows:`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${process.env.PS_HOOK}"`,async:true,timeout:2};
for(const event of events){const kept=[];for(const group of (root.hooks[event]||[])){const hs=(group.hooks||[]).filter(h=>!String(h.command||"").includes("team-skill-hub-hook")&&!String(h.commandWindows||"").includes("team-skill-hub-hook"));if(hs.length)kept.push({...group,hooks:hs})}const group={hooks:[handler]};if(["PreToolUse","PreCompact","PostCompact"].includes(event))group.matcher="^__team_skill_hub_reserved__$";kept.push(group);root.hooks[event]=kept}
root.description ||= "Codex lifecycle hooks including Team Skill Hub client events.";
fs.writeFileSync(path,JSON.stringify(root,null,2)+"\n","utf8");
NODE
else
  echo "Warning: python3 or node is required to merge hooks.json; MCP and AGENTS.md were configured, hooks were not." >&2
fi

echo "Configured MCP: $CODEX_CONFIG"
echo "Configured global AGENTS.md: $AGENTS_FILE"
echo "Configured Codex hooks: $HOOKS_JSON"
echo "Auto Knowledge capture: $AUTO_KNOWLEDGE"
echo
echo "Set the API key before restarting Codex:"
echo "  export $API_KEY_ENV='<your-api-key>'"
echo
echo "Then verify: codex mcp list"
