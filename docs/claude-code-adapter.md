# Claude Code Adapter

## Goal

Claude Code uses the same Team Skill Hub MCP server and the same server-side Client Event, Session, Evidence, Candidate, Gap and Observability pipeline as Codex. The adapter exists only at the client boundary and does not fork business logic.

## Supported lifecycle

The first adapter version accepts these native Claude Code HTTP Hook events:

- SessionStart
- UserPromptSubmit
- PostToolUse
- Stop
- SessionEnd

Endpoint:

~~~text
POST /client-events/claude-code
~~~

Successful delivery returns 204 No Content. This is intentional because Claude Code treats a non-empty 2xx JSON Hook response as Hook control output.

## Data boundary

The adapter normalizes native Hook JSON to Client Event schema v1.

Persisted allow-list includes:

- session and prompt identifier;
- cwd, model and permission mode when present;
- tool name and tool-use identifier;
- bounded lifecycle reason/source metadata;
- structured Evidence extracted from PostToolUse;
- bounded final assistant excerpt from Stop.

The adapter does not persist transcript contents, raw user prompts, raw tool input/output, or arbitrary native Hook JSON. Raw tool response is inspected only in memory to derive compact Evidence and is discarded before persistence.

## Install — Linux / macOS / WSL

~~~bash
export TEAM_SKILL_HUB_API_KEY='<api-key>'
bash scripts/setup-claude-code.sh --url https://skill-hub.example.com/mcp
~~~

Optional parameters:

~~~text
--server-name teamSkillHub
--api-key-env TEAM_SKILL_HUB_API_KEY
--skip-mcp
~~~

The script merges Team Skill Hub HTTP Hooks into ~/.claude/settings.json, preserves unrelated user hooks, keeps exactly one Hub handler per supported event across repeated installs, creates a user-local MCP header helper, and registers the remote MCP server at user scope when the claude CLI is available.

## Install — Windows PowerShell

~~~powershell
$env:TEAM_SKILL_HUB_API_KEY = '<api-key>'
.\scripts\setup-claude-code.ps1 -Url https://skill-hub.example.com/mcp
~~~

The PowerShell installer has the same merge and secret-handling behavior.

## Authentication

HTTP Hooks reference the configured API-key environment variable in the Authorization header and explicitly allow it through Claude Code allowedEnvVars.

The MCP connection uses a user-scope headersHelper. The helper reads the configured environment variable when Claude connects or reconnects; only the environment-variable name is stored on disk.

## Server mapping

| Claude Hook | Shared event | Important normalized fields |
| --- | --- | --- |
| SessionStart | SessionStart | cwd, model, permission mode, source |
| UserPromptSubmit | UserPromptSubmit | prompt id, prompt length only |
| PostToolUse | PostToolUse | tool name/id, structured Evidence |
| Stop | Stop | stop-hook flag, bounded assistant result |
| SessionEnd | SessionEnd | reason |

Once normalized, the event follows the same path:

~~~text
Client Event
 -> schema validation and sanitization
 -> Session Timeline
 -> Evidence normalization
 -> automatic Candidate detector
 -> Knowledge Gap and Observability
 -> human Review Inbox
~~~

## Verification

~~~bash
claude mcp get teamSkillHub
~~~

Then open Admin Sessions and verify client = claude_code, current Hook schema, Repository Context when cwd resolves to a configured repository, and Evidence after successful tool/test runs.

## Upstream references

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp

Re-check those contracts before adding new native lifecycle events.
