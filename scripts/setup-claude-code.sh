#!/usr/bin/env bash
set -euo pipefail

HUB_URL=""
SERVER_NAME="teamSkillHub"
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
SKIP_MCP="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) HUB_URL="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; shift 2 ;;
    --api-key-env) API_KEY_ENV="${2:-}"; shift 2 ;;
    --skip-mcp) SKIP_MCP="true"; shift ;;
    -h|--help)
      echo "Usage: setup-claude-code.sh --url <hub-mcp-url> [--server-name <name>] [--api-key-env <name>] [--skip-mcp]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$HUB_URL" ]]; then read -r -p "Team Skill Hub MCP URL: " HUB_URL; fi
[[ "$HUB_URL" =~ ^https?:// ]] || { echo "URL must start with http:// or https://" >&2; exit 2; }
[[ "$SERVER_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid server name" >&2; exit 2; }
[[ "$API_KEY_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid API key env name" >&2; exit 2; }

MCP_URL="${HUB_URL%/}"
if [[ "$MCP_URL" != */mcp ]]; then MCP_URL="${MCP_URL%/}/mcp"; fi
BASE_URL="${MCP_URL%/mcp}"
EVENT_URL="${BASE_URL}/client-events/claude-code"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
HEADER_HELPER="$CLAUDE_DIR/team-skill-hub-mcp-headers.sh"

mkdir -p "$CLAUDE_DIR"
export SETTINGS_FILE EVENT_URL API_KEY_ENV

if command -v python3 >/dev/null 2>&1; then
  python3 <<'PY'
import json, os
path=os.environ["SETTINGS_FILE"]; url=os.environ["EVENT_URL"]; key=os.environ["API_KEY_ENV"]
try:
    with open(path,"r",encoding="utf-8") as f: root=json.load(f)
except FileNotFoundError:
    root={}
except json.JSONDecodeError:
    raise SystemExit("Existing Claude settings.json is invalid JSON; leaving it unchanged.")
hooks=root.setdefault("hooks",{})
handler={"type":"http","url":url,"timeout":2,"headers":{"Authorization":"Bearer $"+key},"allowedEnvVars":[key]}
for event in ["SessionStart","UserPromptSubmit","PostToolUse","Stop","SessionEnd"]:
    kept=[]
    for group in hooks.get(event,[]) or []:
        handlers=[h for h in (group.get("hooks",[]) or []) if not (h.get("type")=="http" and "/client-events/claude-code" in str(h.get("url","")))]
        if handlers:
            copy=dict(group); copy["hooks"]=handlers; kept.append(copy)
    kept.append({"hooks":[handler]}); hooks[event]=kept
with open(path,"w",encoding="utf-8") as f:
    json.dump(root,f,ensure_ascii=False,indent=2); f.write("\n")
PY
elif command -v node >/dev/null 2>&1; then
  node <<'NODE'
const fs=require("fs"),path=process.env.SETTINGS_FILE,url=process.env.EVENT_URL,key=process.env.API_KEY_ENV;
let root={};if(fs.existsSync(path)){try{root=JSON.parse(fs.readFileSync(path,"utf8"))}catch{console.error("Existing Claude settings.json is invalid JSON; leaving it unchanged.");process.exit(2)}}
root.hooks ||= {};const handler={type:"http",url,timeout:2,headers:{Authorization:"Bearer $"+key},allowedEnvVars:[key]};
for(const event of ["SessionStart","UserPromptSubmit","PostToolUse","Stop","SessionEnd"]){const kept=[];for(const group of (root.hooks[event]||[])){const hs=(group.hooks||[]).filter(h=>!(h.type==="http"&&String(h.url||"").includes("/client-events/claude-code")));if(hs.length)kept.push({...group,hooks:hs})}kept.push({hooks:[handler]});root.hooks[event]=kept}
fs.writeFileSync(path,JSON.stringify(root,null,2)+"\n","utf8");
NODE
else
  echo "python3 or node is required to merge Claude settings.json" >&2
  exit 2
fi

cat > "$HEADER_HELPER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
API_KEY_ENV_NAME="$API_KEY_ENV"
value="\${!API_KEY_ENV_NAME:-}"
VALUE="\$value" python3 -c 'import json,os; print(json.dumps({"Authorization":"Bearer "+os.environ.get("VALUE","")}))'
EOF
chmod 700 "$HEADER_HELPER"

if [[ "$SKIP_MCP" != "true" ]]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "Warning: claude CLI not found; Hooks installed, MCP registration skipped." >&2
  elif ! command -v python3 >/dev/null 2>&1; then
    echo "Warning: python3 is required by the MCP header helper; MCP registration skipped." >&2
  else
    claude mcp remove "$SERVER_NAME" --scope user >/dev/null 2>&1 || true
    mcp_json="$(MCP_URL="$MCP_URL" HEADER_HELPER="$HEADER_HELPER" python3 -c 'import json,os; print(json.dumps({"type":"http","url":os.environ["MCP_URL"],"headersHelper":os.environ["HEADER_HELPER"]}))')"
    claude mcp add-json "$SERVER_NAME" "$mcp_json" --scope user
  fi
fi

echo "Configured Claude Code hooks: $SETTINGS_FILE"
echo "Hook endpoint: $EVENT_URL"
echo "MCP URL: $MCP_URL"
echo "API key environment variable: $API_KEY_ENV"
echo "Set before starting Claude Code: export $API_KEY_ENV='<your-api-key>'"
echo "Verify with: claude mcp get $SERVER_NAME"
