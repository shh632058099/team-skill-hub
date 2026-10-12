#!/usr/bin/env bash
set -u

CONFIG="${TEAM_SKILL_HUB_HOOK_CONFIG:-}"
if [[ -z "$CONFIG" && -n "${CLAUDE_CONFIG_DIR:-}" && -f "${CLAUDE_CONFIG_DIR}/hooks/team-skill-hub.conf" ]]; then
  CONFIG="${CLAUDE_CONFIG_DIR}/hooks/team-skill-hub.conf"
fi
if [[ -z "$CONFIG" ]]; then
  CONFIG="${HOME:-}/.claude/hooks/team-skill-hub.conf"
fi
[[ -f "$CONFIG" ]] || exit 0

EVENT_URL=""
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
CAPTURE_STOP_MESSAGE="true"
while IFS='=' read -r key value; do
  case "$key" in
    event_url) EVENT_URL="$value" ;;
    api_key_env) API_KEY_ENV="$value" ;;
    capture_stop_message) CAPTURE_STOP_MESSAGE="$value" ;;
  esac
done < "$CONFIG"

[[ -n "$EVENT_URL" ]] || exit 0
API_KEY="${!API_KEY_ENV:-}"
[[ -n "$API_KEY" ]] || exit 0

INPUT="$(cat)"
[[ -n "$INPUT" ]] || exit 0
export CAPTURE_STOP_MESSAGE

PAYLOAD=""
if command -v python3 >/dev/null 2>&1; then
  PAYLOAD="$(printf '%s' "$INPUT" | python3 -c 'import json, os, re, sys
try:
    raw = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
if raw.get("hook_event_name") != "Stop":
    raise SystemExit(0)
session_id = raw.get("session_id")
if not isinstance(session_id, str) or not session_id.strip():
    raise SystemExit(0)

def redact(value):
    value = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[redacted-email]", value)
    value = re.sub(r"(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}", "[redacted-token]", value)
    value = re.sub(r"(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+", r"\1=[redacted]", value)
    return value[:4000]

payload = {"hook_event_name": "Stop", "session_id": session_id.strip()}
for key in ("prompt_id", "cwd", "model", "permission_mode", "reason", "stop_hook_active"):
    value = raw.get(key)
    if isinstance(value, (str, int, float, bool)):
        payload[key] = value
if os.environ.get("CAPTURE_STOP_MESSAGE", "true").lower() == "true":
    message = raw.get("last_assistant_message")
    if isinstance(message, str) and message.strip():
        payload["last_assistant_message"] = redact(message.strip())
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))' 2>/dev/null)"
elif command -v node >/dev/null 2>&1; then
  PAYLOAD="$(printf '%s' "$INPUT" | node -e 'let raw="";process.stdin.on("data",chunk=>raw+=chunk).on("end",()=>{try{const x=JSON.parse(raw);if(x.hook_event_name!=="Stop"||typeof x.session_id!=="string"||!x.session_id.trim())process.exit(0);const redact=v=>v.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,"[redacted-email]").replace(/(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}/g,"[redacted-token]").replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,"$1=[redacted]").slice(0,4000);const p={hook_event_name:"Stop",session_id:x.session_id.trim()};for(const k of ["prompt_id","cwd","model","permission_mode","reason","stop_hook_active"])if(["string","number","boolean"].includes(typeof x[k]))p[k]=x[k];if(String(process.env.CAPTURE_STOP_MESSAGE||"true").toLowerCase()==="true"&&typeof x.last_assistant_message==="string"&&x.last_assistant_message.trim())p.last_assistant_message=redact(x.last_assistant_message.trim());process.stdout.write(JSON.stringify(p))}catch{}})' 2>/dev/null)"
fi

[[ -n "$PAYLOAD" ]] || exit 0
curl -fsS --max-time 4   -H "Authorization: Bearer $API_KEY"   -H "Content-Type: application/json"   --data-binary "$PAYLOAD"   "$EVENT_URL" >/dev/null 2>&1 || true
exit 0
