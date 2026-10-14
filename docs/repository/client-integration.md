# Client Integration Architecture

Canonical design for client adapters, lifecycle hooks, event/evidence contracts, and Codex/Claude Code distribution.


## Agent Adapter Contract

### Goal

Team Skill Hub should not implement a separate backend for every IDE or coding agent. Any client that can produce the shared Client Event v1 envelope can connect directly to the generic Client Event API and reuse the existing Session, Project Context, Evidence, Candidate Detector, Knowledge Gap, and Observability pipeline.

### Discovery

Before rollout, adapters should query:

~~~text
GET /client-events/schema
~~~

or the versioned REST alias:

~~~text
GET /api/v1/client-events/schema
~~~

The response advertises:

- current and minimum Client Event schema version;
- compatibility policy;
- Agent Adapter contract version;
- generic POST endpoint;
- authentication policy;
- supported lifecycle events;
- metadata policy;
- Evidence field location.

### Generic endpoint

~~~text
POST /client-events
Authorization: Bearer <client API key>
Content-Type: application/json
~~~

Representative event:

~~~json
{
  "schema_version": 1,
  "client": "ci_agent",
  "event": "PostToolUse",
  "session_id": "pipeline-42",
  "turn_id": "job-test",
  "cwd": "/workspace/ota",
  "model": "internal-agent",
  "permission_mode": "ci",
  "metadata": {
    "adapter": "generic-client-event-v1",
    "tool_name": "ctest",
    "evidence": {
      "success": true,
      "exit_code": 0,
      "tests_run": 18,
      "tests_passed": 18,
      "tests_failed": 0
    }
  }
}
~~~

### Required mapping

Each adapter should provide:

- `schema_version`: query discovery and emit a supported explicit version;
- `client`: stable, non-secret integration identifier such as `ci_agent`, `vscode_agent`, or an internal Agent id;
- `event`: one advertised lifecycle event name;
- `session_id`: stable identifier for one logical Agent work session or CI run;
- `turn_id`: optional stable turn/job identifier;
- `cwd`: optional working directory used for Repository Context resolution;
- `model`: optional model/runtime identifier;
- `permission_mode`: optional execution-policy label;
- `metadata`: allow-listed compact metadata only.

### Lifecycle events

Contract v1 supports:

- SessionStart
- UserPromptSubmit
- PreToolUse
- PostToolUse
- PreCompact
- PostCompact
- Stop
- SessionEnd

A client does not have to emit every event. At minimum, SessionStart/SessionEnd are recommended for session observability, and PostToolUse is recommended when structured engineering Evidence is available.

### Evidence

Put compact execution evidence under `metadata.evidence`.

Supported useful fields include:

~~~json
{
  "success": true,
  "exit_code": 0,
  "tests_run": 10,
  "tests_passed": 10,
  "tests_failed": 0,
  "duration_ms": 1250,
  "status": "passed"
}
~~~

The server normalizes this into the shared Engineering Evidence model.

Do not send raw stdout/stderr, complete tool responses, source files, transcripts, or credentials simply to obtain Evidence. Extract compact counts/status locally whenever possible.

### Data and security boundary

Adapters must not use Client Events as a generic telemetry dump.

Do not send:

- source file contents;
- customer payloads;
- credentials or API keys;
- full transcripts;
- arbitrary tool input/output;
- large logs;
- personal data unless explicitly governed and required.

The server performs sanitization and secret redaction again, but the client adapter remains responsible for minimizing data before transmission.

### Product-specific adapters

Use the generic endpoint directly when the client can construct the v1 envelope.

A dedicated server-side adapter is justified only when an upstream product owns a fixed native payload or response contract. Claude Code is the current example: its native HTTP Hook JSON is translated by `/client-events/claude-code` and successful delivery must return 204 with an empty body.

### Suggested mappings

#### CI agent

- pipeline/job start -> SessionStart
- command/test/build completion -> PostToolUse + Evidence
- pipeline completion -> SessionEnd

#### VS Code / JetBrains agent

- agent conversation start -> SessionStart
- user submit -> UserPromptSubmit
- IDE/tool invocation -> PostToolUse
- agent completion -> Stop
- conversation close -> SessionEnd

#### Internal coding agent

Prefer the generic v1 envelope natively. This keeps the internal integration independent from Codex/Claude-specific Hook formats.

### Compatibility

Adapters should:

1. query schema discovery during install/startup or controlled rollout;
2. emit an explicit supported schema version;
3. fail open for observational telemetry when the Hub is unavailable, unless the integration is intentionally policy-enforcing;
4. treat HTTP 400 unsupported-schema responses as an upgrade signal, not as permission to silently downgrade unknown data;
5. keep `client` and adapter version visible in metadata for operational diagnosis.

### Validation status

The repository E2E suite includes a generic `ci_agent` event path. It verifies that a non-Codex/non-Claude client can post v1 lifecycle events, reuse structured Evidence, receive server-side redaction, and coexist with existing session correlation behavior.


## Client Event Schema

### Current contrac

The current Client Event schema version is `1`.

Discovery endpoints:

~~~tex
GET /client-events/schema
GET /api/v1/client-events/schema
~~~

The server returns the current/minimum supported version and the compatibility policy.

The discovery response also exposes the generic Agent Adapter contract: contract version, POST endpoint, authentication policy, supported lifecycle event names, metadata policy, and the structured Evidence field.

### Envelope

Representative payload:

~~~json
{
  "schema_version": 1,
  "client": "codex",
  "event": "PostToolUse",
  "session_id": "session-123",
  "turn_id": "turn-7",
  "cwd": "/workspace/ota",
  "model": "codex",
  "permission_mode": "default",
  "metadata": {}
}
~~~

Supported lifecycle event names are defined in `src/observability.ts`.

### Compatibility

- Explicit `schema_version: 1`: accepted.
- Missing `schema_version`: accepted as legacy v1 and tagged `implicit-v1`.
- Explicit unsupported, non-integer, or out-of-range version: rejected with HTTP 400.

Successful and rejected event responses include:

~~~tex
x-skill-hub-hook-schema-version: 1
~~~

Unsupported-version responses also include the supported min/max range.

### Metadata rules

Metadata is an allow-listed, sanitized transport, not an arbitrary logging channel. Current useful fields include:

- project/repository context;
- Hook runtime/schema versions;
- tool name and engineering Evidence;
- final assistant excerpt for Stop when automatic Knowledge is enabled;
- stop-hook recursion marker.

Secrets, tokens, passwords, email addresses, and credential-like values are redacted again on the server.

### Generic Agent Adapter contrac

Any Agent or IDE integration that can emit the v1 envelope may use `POST /client-events` directly. A dedicated backend adapter is only needed when an upstream product has a fixed native Hook payload that cannot emit the shared envelope itself, as with the Claude Code native HTTP Hook adapter.

Adapter requirements:

1. use a stable, non-secret `client` identifier such as `ci_agent`, `vscode_agent`, or an internal Agent name;
2. create a stable session id for one logical Agent work session/run;
3. map lifecycle activity to the advertised v1 event names;
4. send only allow-listed metadata, never raw source files, transcripts, credentials, or arbitrary tool payloads;
5. place compact build/test/tool results in `metadata.evidence` using the existing Evidence shape;
6. query `/client-events/schema` before rolling out a new adapter version and reject unsupported explicit schema versions;
7. reuse the same authentication principal/API key policy as MCP.

This contract lets CI agents, editor agents, and internal coding agents reuse the existing Session, Evidence, Candidate Detector, Knowledge Gap, Project Context, and Observability pipeline without adding product-specific server code.

### Evolution rules

For a future v2:

1. add the parser/normalizer before emitting v2 from clients;
2. keep a documented compatibility window;
3. add E2E tests for old/current/unsupported versions;
4. expose the accepted range through the discovery endpoint;
5. never silently interpret an unknown explicit version as the current schema.


## Engineering Evidence Schema

### Goal

Engineering Evidence is the structured proof used by Session views, the automatic Candidate detector, and Review Inbox. It intentionally carries outcomes, not raw tool output.

### Version

Current Evidence schema:

~~~tex
schemaVersion: 1
~~~

The canonical TypeScript contract and normalizer live in `src/client-events.ts`.

### Common fields

Evidence records can contain:

- `type
- `sourceTool
- `success
- `exitCode
- `counts.run
- `counts.passed
- `counts.failed
- `durationMs
- `status

Known evidence types include test, build, lint, static analysis, git change, reproduction, deployment, device test, and other supported engineering outcomes.

Example:

~~~json
{
  "schemaVersion": 1,
  "type": "test",
  "sourceTool": "Bash",
  "success": true,
  "exitCode": 0,
  "counts": {
    "run": 12,
    "passed": 12,
    "failed": 0
  },
  "durationMs": 4820
}
~~~

### Extraction boundary

Hook runtimes extract only compact structured facts from Tool Response. They do not upload stdout/stderr or the complete response body.

The service always calls `normalizeEngineeringEvidence()` before using Evidence for Candidate decisions.

### Detector use

Passing test/build Evidence is a strong signal. The detector rejects weak or ambiguous sessions, including:

- no engineering action;
- no strong passing Evidence;
- one-off formatting or similarly low-reuse-only results;
- duplicate/template summaries;
- recursion and configured rate limits.

### Review use

Generated Candidates retain normalized Evidence. Review Inbox displays type, source tool, success/exit code, counts, duration, and status so the reviewer can judge the claim without opening raw developer transcripts.


## Hook Architecture

### Purpose

Team Skill Hub Hooks make Codex usage observable without placing the Hub in the model/tool execution path. The runtime is intentionally lightweight, fail-open, and client-side redacted.

### Installed components

The setup scripts install:

- `~/.codex/hooks/team-skill-hub-hook.sh
- `~/.codex/hooks/team-skill-hub-hook.ps1
- `~/.codex/hooks/team-skill-hub.conf
- an idempotent Team Skill Hub block in `~/.codex/hooks.json

They also maintain the Team Skill Hub MCP block in `~/.codex/config.toml` and guidance in global `~/.codex/AGENTS.md`.

### Enabled lifecycle

The current runtime actively sends:

1. `SessionStar
2. `UserPromptSubmi
3. `PostToolUse
4. `Stop
5. `SessionEnd

`PreToolUse`, `PreCompact`, and `PostCompact` remain reserved integration points. Policy enforcement is exposed separately through the synchronous policy API rather than silently blocking ordinary hooks.

### Data flow

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

### Stop event and automatic Knowledge

Automatic Knowledge is enabled by default. The Stop Hook may send a redacted, bounded final assistant excerpt. The server creates a Candidate only when the same session contains:

- an engineering action;
- strong structured test/build Evidence;
- a reusable result;
- no detector exclusion such as duplicate, low-value-only work, recursion, or rate limit.

Candidates are never automatically approved or merged.

### Runtime and schema versions

Every current Hook event carries:

- `runtime_version
- `hook_schema_version

Current values are defined in `src/client-events.ts` and mirrored by the setup scripts. Admin Session views classify clients as `current`, `outdated`, or `unknown`.

### Failure behavior

Normal lifecycle hooks are fail-open: inability to reach the Hub must not block developer work. Policy checks that are intended to deny an action use the explicit policy path instead.

### Upgrade

Linux/macOS/WSL:

~~~bash
bash scripts/setup-codex-mcp.sh --upgrade
~~~

PowerShell:

~~~powershell
.\scripts\setup-codex-mcp.ps1 -Upgrade
~~~

Upgrade reuses the existing URL, server name, API-key environment reference, and automatic-Knowledge preference unless explicitly overridden.


## Claude Code Adapter

### Goal

Claude Code uses the same Team Skill Hub MCP server and the same server-side Client Event, Session, Evidence, Candidate, Gap and Observability pipeline as Codex. The adapter exists only at the client boundary and does not fork business logic.

### Supported lifecycle

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

### Data boundary

The adapter normalizes native Hook JSON to Client Event schema v1.

Persisted allow-list includes:

- session and prompt identifier;
- cwd, model and permission mode when present;
- tool name and tool-use identifier;
- bounded lifecycle reason/source metadata;
- structured Evidence extracted from PostToolUse;
- bounded final assistant excerpt from Stop.

The adapter does not persist transcript contents, raw user prompts, raw tool input/output, or arbitrary native Hook JSON. Raw tool response is inspected only in memory to derive compact Evidence and is discarded before persistence.

### Install — Linux / macOS / WSL

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

### Install — Windows PowerShell

~~~powershell
$env:TEAM_SKILL_HUB_API_KEY = '<api-key>'
.\scripts\setup-claude-code.ps1 -Url https://skill-hub.example.com/mcp
~~~

The PowerShell installer has the same merge and secret-handling behavior.

### Authentication

HTTP Hooks reference the configured API-key environment variable in the Authorization header and explicitly allow it through Claude Code allowedEnvVars.

The MCP connection uses a user-scope headersHelper. The helper reads the configured environment variable when Claude connects or reconnects; only the environment-variable name is stored on disk.

### Server mapping

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

### Verification

~~~bash
claude mcp get teamSkillHub
~~~

Then open Admin Sessions and verify client = claude_code, current Hook schema, Repository Context when cwd resolves to a configured repository, and Evidence after successful tool/test runs.

### Upstream references

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp

Re-check those contracts before adding new native lifecycle events.


## Codex Plugin Distribution

### Purpose

Team Skill Hub can be distributed as a portable Agent Plugin for Codex and supported OpenAI plugin surfaces. The package bundles:

- the Team Skill Hub remote MCP connection;
- the Team Skill Hub skill guidance;
- cross-platform lifecycle hooks;
- Hook Runtime and schema version metadata.

Secrets are not embedded in the plugin.

### Build a plugin

Build for a concrete Hub deployment:

~~~bash
npm run plugin:build -- \
  --url https://skill-hub.example.com/mcp \
  --api-key-env TEAM_SKILL_HUB_API_KEY \
  --out dist/plugins/team-skill-hub
~~~

The output contains:

~~~text
team-skill-hub/
  plugin.json
  mcp.json
  skills/
    team-skill-hub/
      SKILL.md
  hooks/
    hooks.json
    team-skill-hub.conf
    team-skill-hub-hook.sh
    team-skill-hub-hook.ps1
~~~

The application version in package.json becomes the plugin version. Hook runtime and Client Event schema versions are written independently from their canonical constants.

### Authentication

The generated mcp.json uses bearer_token_env_var. Only the environment-variable name is stored in the plugin package.

Set the credential before starting Codex:

~~~bash
export TEAM_SKILL_HUB_API_KEY='<api-key>'
~~~

On Windows set the same environment variable through PowerShell or enterprise device management.

### Build a repo marketplace

The builder can create a repository-scoped marketplace and copy the plugin into it:

~~~bash
npm run plugin:build -- \
  --url https://skill-hub.example.com/mcp \
  --marketplace-root ./team-plugin-marketplace \
  --marketplace-name engineering-tools
~~~

This creates:

~~~text
team-plugin-marketplace/
  .agents/plugins/marketplace.json
  plugins/team-skill-hub/
~~~

Add a local marketplace:

~~~bash
codex plugin marketplace add ./team-plugin-marketplace
~~~

For a Git-backed team marketplace, publish that directory to a controlled repository and add the repository URL or owner/repo reference instead.

### Update

1. bump the application semantic version when the plugin package itself changes;
2. update CHANGELOG and migration notes as required;
3. rebuild the plugin against the deployment URL;
4. publish the new marketplace revision/tag;
5. refresh with codex plugin marketplace upgrade.

The standalone setup-codex-mcp.sh and setup-codex-mcp.ps1 installers remain supported for environments that do not use plugin marketplaces.

### Hook trust

Plugin-bundled hooks are not automatically trusted. Users or administrators must review and trust the current hook definition before Codex executes it.

Enterprise environments may instead enforce managed hooks and managed marketplace sources. Required hook scripts must be present in the execution environment.

### Managed rollout

For team rollout:

1. publish the marketplace in a controlled Git repository;
2. pin marketplace ref or commit for staged rollout;
3. configure marketplace sources through system/cloud-managed Codex configuration;
4. distribute the API-key environment variable through the organization secret-management mechanism;
5. validate hook trust policy or managed-hook policy;
6. roll forward by marketplace revision and plugin semantic version;
7. retain the previous plugin revision for rollback.

### Validation

Repository tests validate that the generated package:

- has portable plugin and MCP manifests;
- references the correct Hub URL;
- uses only the API-key environment-variable name;
- includes Unix and Windows Hook commands;
- uses current Hook Runtime / schema versions;
- emits a valid repo marketplace layout;
- never writes the test credential into generated files.

### Upstream references

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/docs/hooks
