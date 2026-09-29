#!/usr/bin/env bash
set -euo pipefail

SERVER_NAME="teamSkillHub"
API_KEY_ENV="TEAM_SKILL_HUB_API_KEY"
MCP_URL=""

MCP_BEGIN="# BEGIN TEAM-SKILL-HUB MCP"
MCP_END="# END TEAM-SKILL-HUB MCP"
AGENTS_BEGIN="<!-- BEGIN TEAM-SKILL-HUB -->"
AGENTS_END="<!-- END TEAM-SKILL-HUB -->"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) MCP_URL="${2:-}"; shift 2 ;;
    --server-name) SERVER_NAME="${2:-}"; shift 2 ;;
    --api-key-env) API_KEY_ENV="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: setup-codex-mcp.sh --url <mcp-url> [--server-name <name>] [--api-key-env <name>]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$MCP_URL" ]]; then
  read -r -p "Team Skill Hub MCP URL: " MCP_URL
fi

[[ "$MCP_URL" =~ ^https?:// ]] || { echo "MCP URL must start with http:// or https://" >&2; exit 2; }
[[ "$SERVER_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid server name" >&2; exit 2; }
[[ "$API_KEY_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid API key env name" >&2; exit 2; }

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_DIR/config.toml"
AGENTS_FILE="$CODEX_DIR/AGENTS.md"

mkdir -p "$CODEX_DIR"
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
1. Search Team Skill Hub before implementing or reviewing from scratch when reusable internal guidance may exist.
2. Use \`search_skills\` when the correct internal Skill is unknown.
3. After selecting a Skill, call \`get_skill\` and follow its instructions.
4. Use \`search_knowledge\` for current project design documents, APIs, troubleshooting notes, postmortems, FAQ, test documentation, and other repository facts.
5. After selecting a Knowledge result, use \`get_knowledge\` when exact document or chunk context is needed.
6. Prefer relevant team Skill/Knowledge over generic assumptions.
7. Respect repository visibility and role filtering.
8. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use \`submit_feedback\` with a concise evidence-based reason.
9. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, use \`submit_knowledge_candidate\` with concise source-grounded content. Do not submit secrets, credentials, customer-sensitive data, or speculative conclusions.
10. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.

Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.
$AGENTS_END
EOF
replace_block "$AGENTS_FILE" "$AGENTS_BEGIN" "$AGENTS_END" "$agents_block"
rm -f "$agents_block"

echo "Configured MCP: $CODEX_CONFIG"
echo "Configured global AGENTS.md: $AGENTS_FILE"
echo
echo "Set the API key before restarting Codex:"
echo "  export $API_KEY_ENV='<your-api-key>'"
echo
echo "Then verify: codex mcp list"
