# Upgrade Guide

## Server upgrade

1. Back up `DATA_DIR`.
2. Record the current image/version and configuration.
3. Run the candidate build/test/Evaluation gates.
4. Deploy the immutable new image/tag.
5. Confirm `/health/live`, `/health/ready`, Operational Health, and repository sync state.
6. Keep the previous image available for rollback.

The REST v1 surface preserves legacy routes while clients migrate.

## Codex Hook Runtime upgrade

Linux/macOS/WSL:

~~~bash
bash scripts/setup-codex-mcp.sh --upgrade
~~~

PowerShell:

~~~powershell
.\scripts\setup-codex-mcp.ps1 -Upgrade
~~~

Upgrade preserves existing Hub URL, server name, API-key environment reference, and automatic Knowledge preference unless explicitly overridden.

## Compatibility checks

Admin Sessions display Hook Runtime state:

- `curren
- `outdated
- `unknown

Client Event schema discovery:

~~~tex
GET /client-events/schema
GET /api/v1/client-events/schema
~~~

Unknown explicit schema versions are rejected rather than silently reinterpreted.

## Rollback

Server rollback:

- deploy the previous immutable image;
- preserve/restore compatible `DATA_DIR`;
- use repository last-known-good revision when a repository update caused the issue.

Client rollback:

- reinstall the previously approved Hook Runtime/setup package;
- verify runtime/schema status in Admin.

## Required gates

Before production upgrade:

~~~bash
npm run check
npm run ci:evaluate -- --path <critical-repository>
~~~

Also parse/visit Admin UI and run a representative MCP call.
