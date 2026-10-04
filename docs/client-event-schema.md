# Client Event Schema

## Current contrac

The current Client Event schema version is `1`.

Discovery endpoints:

~~~tex
GET /client-events/schema
GET /api/v1/client-events/schema
~~~

The server returns the current/minimum supported version and the compatibility policy.

The discovery response also exposes the generic Agent Adapter contract: contract version, POST endpoint, authentication policy, supported lifecycle event names, metadata policy, and the structured Evidence field.

## Envelope

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

## Compatibility

- Explicit `schema_version: 1`: accepted.
- Missing `schema_version`: accepted as legacy v1 and tagged `implicit-v1`.
- Explicit unsupported, non-integer, or out-of-range version: rejected with HTTP 400.

Successful and rejected event responses include:

~~~tex
x-skill-hub-hook-schema-version: 1
~~~

Unsupported-version responses also include the supported min/max range.

## Metadata rules

Metadata is an allow-listed, sanitized transport, not an arbitrary logging channel. Current useful fields include:

- project/repository context;
- Hook runtime/schema versions;
- tool name and engineering Evidence;
- final assistant excerpt for Stop when automatic Knowledge is enabled;
- stop-hook recursion marker.

Secrets, tokens, passwords, email addresses, and credential-like values are redacted again on the server.

## Generic Agent Adapter contrac

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

## Evolution rules

For a future v2:

1. add the parser/normalizer before emitting v2 from clients;
2. keep a documented compatibility window;
3. add E2E tests for old/current/unsupported versions;
4. expose the accepted range through the discovery endpoint;
5. never silently interpret an unknown explicit version as the current schema.
