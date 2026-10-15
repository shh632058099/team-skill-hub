#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVER_NAME="teamSkillHub"
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
MCP_URL=""
AUTO_KNOWLEDGE="true"
HOOK_RUNTIME_VERSION=""
HOOK_SCHEMA_VERSION=""
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
HUB_BASE_URL="${MCP_BASE%/mcp}"
CLIENT_ROOT="${TEAM_SKILL_HUB_CLIENT_ROOT:-$HOME/.team-skill-hub}"
bash "$SCRIPT_DIR/bootstrap-client-integration.sh" --client codex --config-home "$CODEX_DIR" --hub-base-url "$HUB_BASE_URL" --server-name "$SERVER_NAME" --api-key-env "$API_KEY_ENV"
CLIENT_LAUNCHER="$CLIENT_ROOT/bin/team-skill-hub-client"
CLIENT_RELEASE_FILE="$CLIENT_ROOT/releases/v$(tr -d '\r\n' < "$CLIENT_ROOT/current")/release.json"
CLIENT_RELEASE_DIR="$(dirname "$CLIENT_RELEASE_FILE")"
if command -v python3 >/dev/null 2>&1; then
  HOOK_RUNTIME_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["hookRuntimeVersion"])' "$CLIENT_RELEASE_FILE")"
  HOOK_SCHEMA_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["hookSchemaVersion"])' "$CLIENT_RELEASE_FILE")"
elif command -v node >/dev/null 2>&1; then
  HOOK_RUNTIME_VERSION="$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.hookRuntimeVersion))' "$CLIENT_RELEASE_FILE")"
  HOOK_SCHEMA_VERSION="$(node -e 'const x=require(process.argv[1]);process.stdout.write(String(x.hookSchemaVersion))' "$CLIENT_RELEASE_FILE")"
else
  echo "python3 or node is required to read client integration release metadata" >&2; exit 2
fi

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

# Remove the previously managed block first, then remove any standalone section
# with the same server name. This avoids duplicate TOML sections when upgrading
# from an older setup that already had [mcp_servers.<name>] outside our markers.
tmp="$(mktemp)"
awk -v b="$MCP_BEGIN" -v e="$MCP_END" '$0==b{skip=1;next} skip&&$0==e{skip=0;next} !skip{print}' "$CODEX_CONFIG" > "$tmp"
mv "$tmp" "$CODEX_CONFIG"

tmp="$(mktemp)"
awk -v s="[mcp_servers.$SERVER_NAME]" '$0==s{skip=1;next} skip&&/^\[[^]]+\]/{skip=0} !skip{print}' "$CODEX_CONFIG" > "$tmp"
mv "$tmp" "$CODEX_CONFIG"

mcp_block="$(mktemp)"
cat > "$mcp_block" <<EOF
$MCP_BEGIN
[mcp_servers.$SERVER_NAME]
url = "$MCP_URL"
bearer_token_env_var = "$API_KEY_ENV"
default_tools_approval_mode = "approve"
$MCP_END
EOF
replace_block "$CODEX_CONFIG" "$MCP_BEGIN" "$MCP_END" "$mcp_block"
rm -f "$mcp_block"

if command -v node >/dev/null 2>&1; then
  node --input-type=module - "$CLIENT_RELEASE_DIR/updater/updater.mjs" "$CODEX_CONFIG" "$CLIENT_ROOT" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [updaterFile, configFile, clientRoot] = process.argv.slice(2);
const { ensureCodexWritableRoot } = await import(pathToFileURL(updaterFile).href);
const content = await readFile(configFile, "utf8");
await writeFile(configFile, ensureCodexWritableRoot(content, clientRoot));
NODE
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$CODEX_CONFIG" "$CLIENT_ROOT" <<'PY'
import json, pathlib, re, sys
config_file, client_root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).resolve()
root = str(client_root).replace("\\", "/")
quoted = json.dumps(root)
content = config_file.read_text(encoding="utf-8").replace("\r\n", "\n")
match = re.search(r"(?ms)^\[sandbox_workspace_write\]\s*$.*?(?=^\[[^\]]+\]\s*$|\Z)", content)
if not match:
    base = content.rstrip()
    content = (base + "\n\n" if base else "") + f"[sandbox_workspace_write]\nwritable_roots = [{quoted}]\n"
elif quoted not in match.group(0):
    section = match.group(0)
    array = re.search(r"(?ms)^(\s*writable_roots\s*=\s*\[)(.*?)(\])", section)
    if array:
        existing = array.group(2).strip()
        replacement = array.group(1) + (existing + ", " if existing else "") + quoted + array.group(3)
        section = section[:array.start()] + replacement + section[array.end():]
    else:
        section = section.rstrip() + f"\nwritable_roots = [{quoted}]\n"
    content = content[:match.start()] + section + content[match.end():]
config_file.write_text(content, encoding="utf-8")
PY
else
  echo "node or python3 is required to update Codex sandbox writable_roots" >&2
  exit 2
fi

agents_block="$(mktemp)"
cat > "$agents_block" <<EOF
$AGENTS_BEGIN
## Team Skill Hub

Use the \`$SERVER_NAME\` MCP server proactively for team-specific engineering work.

For team-specific engineering tasks and questions, including short questions containing project or technology keywords:
1. Before implementing, reviewing, diagnosing, or answering, call \`discover\` with the user's original request or its important terms; do not wait for the user to explicitly request Team Skill Hub, name a Skill, or ask for Knowledge.
2. Treat \`discover\` as the default routing entry point. Let Skills, Knowledge, Prompts, Agents, and Tools compete by relevance instead of pre-classifying every request on the client.
3. If \`discover\` returns a clearly relevant Skill, call \`get_skill\` before executing the task. If it returns clearly relevant Knowledge, call \`get_knowledge\` before answering or changing code. Load Prompts, Agents, or Tools only when they are actually relevant.
4. Use \`resolve_skill\`, \`search_skills\`, \`search_knowledge\`, or other asset-specific search tools only when \`discover\` is ambiguous, insufficient, or a more precise follow-up search is needed. Do not run Skill and Knowledge searches in parallel by default.
5. Load only the selected assets; do not load every candidate. If no relevant Team Skill Hub asset is found, continue normally and do not invent team-specific guidance.
6. Respect repository visibility, role filtering, and client compatibility.
7. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use \`submit_feedback\` with a concise evidence-based reason.
8. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, call \`get_knowledge_submission_spec\` immediately before submission, follow the returned current rules/template, then call \`submit_knowledge_candidate\` with the returned \`spec_version\`. Do not submit raw notes/transcripts, secrets, credentials, customer-sensitive data, or speculative conclusions.
9. When creating or submitting any Skill, including a Skill that contains only one \`SKILL.md\`, use \`submit_skill_bundle\`. Use \`import_type=skill\` for one Skill root and \`import_type=collection\` only for an explicit multi-Skill namespace snapshot. Do not submit Skills through Knowledge Candidate APIs.
10. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.
11. When SessionStart reports a Team Skill Hub client integration update, never upgrade silently. Only when the user explicitly asks to upgrade Team Skill Hub, run \`"$CLIENT_LAUNCHER" upgrade\`; after a required update, restart Codex before relying on new integration behavior.

Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.

$AGENTS_END
EOF
replace_block "$AGENTS_FILE" "$AGENTS_BEGIN" "$AGENTS_END" "$agents_block"
rm -f "$agents_block"

cp "$SCRIPT_DIR/team-skill-hub-hook.sh" "$SH_HOOK"
cp "$SCRIPT_DIR/team-skill-hub-hook.ps1" "$PS_HOOK"
chmod +x "$SH_HOOK"
printf 'event_url=%s\nserver_name=%s\napi_key_env=%s\ncapture_stop_message=%s\nruntime_version=%s\nhook_schema_version=%s\n' "$EVENT_URL" "$SERVER_NAME" "$API_KEY_ENV" "$AUTO_KNOWLEDGE" "$HOOK_RUNTIME_VERSION" "$HOOK_SCHEMA_VERSION" > "$HOOK_CONF"

export HOOKS_JSON SH_HOOK PS_HOOK CLIENT_LAUNCHER
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
for event in events:
    handler={"type":"command","command":f'bash "{sh}"',"commandWindows":f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{ps}"',"async":event not in ("SessionStart","PostToolUse","Stop","SessionEnd"),"timeout":2}
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
client=os.environ["CLIENT_LAUNCHER"].replace("\\","/")
kept=[]
for group in hooks.get("SessionStart",[]) or []:
    handlers=[h for h in (group.get("hooks",[]) or []) if "team-skill-hub-client" not in str(h.get("command","")) and "team-skill-hub-client" not in str(h.get("commandWindows",""))]
    if handlers:
        copy=dict(group);copy["hooks"]=handlers;kept.append(copy)
kept.append({"hooks":[{"type":"command","command":f'"{client}" session-start --client codex',"timeout":2}]})
hooks["SessionStart"]=kept
root.setdefault("description","Codex lifecycle hooks including Team Skill Hub client events.")
with open(path,"w",encoding="utf-8") as f: json.dump(root,f,ensure_ascii=False,indent=2);f.write("\n")
PY
elif command -v node >/dev/null 2>&1; then
  node <<'NODE'
const fs=require("fs");const path=process.env.HOOKS_JSON;let root={};if(fs.existsSync(path)){try{root=JSON.parse(fs.readFileSync(path,"utf8"))}catch{console.error("Existing hooks.json is invalid JSON; leaving it unchanged.");process.exit(2)}}
root.hooks ||= {};
const events=["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PreCompact","PostCompact","Stop","SessionEnd"];
for(const event of events){const handler={type:"command",command:`bash "${process.env.SH_HOOK.replaceAll("\\","/")}"`,commandWindows:`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${process.env.PS_HOOK}"`,async:!["SessionStart","PostToolUse","Stop","SessionEnd"].includes(event),timeout:2};const kept=[];for(const group of (root.hooks[event]||[])){const hs=(group.hooks||[]).filter(h=>!String(h.command||"").includes("team-skill-hub-hook")&&!String(h.commandWindows||"").includes("team-skill-hub-hook"));if(hs.length)kept.push({...group,hooks:hs})}const group={hooks:[handler]};if(["PreToolUse","PreCompact","PostCompact"].includes(event))group.matcher="^__team_skill_hub_reserved__$";kept.push(group);root.hooks[event]=kept}
const client=process.env.CLIENT_LAUNCHER.replaceAll("\\","/");const sk=[];for(const group of (root.hooks.SessionStart||[])){const hs=(group.hooks||[]).filter(h=>!String(h.command||"").includes("team-skill-hub-client")&&!String(h.commandWindows||"").includes("team-skill-hub-client"));if(hs.length)sk.push({...group,hooks:hs})}sk.push({hooks:[{type:"command",command:`"${client}" session-start --client codex`,timeout:2}]});root.hooks.SessionStart=sk;
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
