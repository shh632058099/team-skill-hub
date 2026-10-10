# Agent Adapter Contract

## Goal

Team Skill Hub should not implement a separate backend for every IDE or coding agent. Any client that can produce the shared Client Event v1 envelope can connect directly to the generic Client Event API and reuse the existing Session, Project Context, Evidence, Candidate Detector, Knowledge Gap, and Observability pipeline.

## Discovery

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

## Generic endpoint

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

## Required mapping

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

## Lifecycle events

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

## Evidence

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

## Data and security boundary

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

## Product-specific adapters

Use the generic endpoint directly when the client can construct the v1 envelope.

A dedicated server-side adapter is justified only when an upstream product owns a fixed native payload or response contract. Claude Code is the current example: its native HTTP Hook JSON is translated by `/client-events/claude-code` and successful delivery must return 204 with an empty body.

## Suggested mappings

### CI agent

- pipeline/job start -> SessionStart
- command/test/build completion -> PostToolUse + Evidence
- pipeline completion -> SessionEnd

### VS Code / JetBrains agent

- agent conversation start -> SessionStart
- user submit -> UserPromptSubmit
- IDE/tool invocation -> PostToolUse
- agent completion -> Stop
- conversation close -> SessionEnd

### Internal coding agent

Prefer the generic v1 envelope natively. This keeps the internal integration independent from Codex/Claude-specific Hook formats.

## Compatibility

Adapters should:

1. query schema discovery during install/startup or controlled rollout;
2. emit an explicit supported schema version;
3. fail open for observational telemetry when the Hub is unavailable, unless the integration is intentionally policy-enforcing;
4. treat HTTP 400 unsupported-schema responses as an upgrade signal, not as permission to silently downgrade unknown data;
5. keep `client` and adapter version visible in metadata for operational diagnosis.

## Validation status

The repository E2E suite includes a generic `ci_agent` event path. It verifies that a non-Codex/non-Claude client can post v1 lifecycle events, reuse structured Evidence, receive server-side redaction, and coexist with existing session correlation behavior.
