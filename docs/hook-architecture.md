# Hook Architecture

## Purpose

Team Skill Hub Hooks make Codex usage observable without placing the Hub in the model/tool execution path. The runtime is intentionally lightweight, fail-open, and client-side redacted.

## Installed components

The setup scripts install:

- `~/.codex/hooks/team-skill-hub-hook.sh
- `~/.codex/hooks/team-skill-hub-hook.ps1
- `~/.codex/hooks/team-skill-hub.conf
- an idempotent Team Skill Hub block in `~/.codex/hooks.json

They also maintain the Team Skill Hub MCP block in `~/.codex/config.toml` and guidance in global `~/.codex/AGENTS.md`.

## Enabled lifecycle

The current runtime actively sends:

1. `SessionStar
2. `UserPromptSubmi
3. `PostToolUse
4. `Stop
5. `SessionEnd

`PreToolUse`, `PreCompact`, and `PostCompact` remain reserved integration points. Policy enforcement is exposed separately through the synchronous policy API rather than silently blocking ordinary hooks.

## Data flow

~~~tex
Codex
  -> Hook Runtime
     -> local allow-list extraction
     -> local secret redaction
     -> bounded metadata / Evidence
        -> POST /client-events
           -> schema compatibility check
           -> server-side sanitization
           -> append-only observability store
           -> session correlation
           -> auto-candidate detector
              -> pending Review Inbox candidate
~~~

The Hook Runtime never uploads full transcripts, full tool stdout/stderr, arbitrary file contents, or credentials.

## Stop event and automatic Knowledge

Automatic Knowledge is enabled by default. The Stop Hook may send a redacted, bounded final assistant excerpt. The server creates a Candidate only when the same session contains:

- an engineering action;
- strong structured test/build Evidence;
- a reusable result;
- no detector exclusion such as duplicate, low-value-only work, recursion, or rate limit.

Candidates are never automatically approved or merged.

## Runtime and schema versions

Every current Hook event carries:

- `runtime_version
- `hook_schema_version

Current values are defined in `src/client-events.ts` and mirrored by the setup scripts. Admin Session views classify clients as `current`, `outdated`, or `unknown`.

## Failure behavior

Normal lifecycle hooks are fail-open: inability to reach the Hub must not block developer work. Policy checks that are intended to deny an action use the explicit policy path instead.

## Upgrade

Linux/macOS/WSL:

~~~bash
bash scripts/setup-codex-mcp.sh --upgrade
~~~

PowerShell:

~~~powershell
.\scripts\setup-codex-mcp.ps1 -Upgrade
~~~

Upgrade reuses the existing URL, server name, API-key environment reference, and automatic-Knowledge preference unless explicitly overridden.
