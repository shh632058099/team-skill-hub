# Troubleshooting Guide

## Service not ready

Check:

~~~tex
GET /health/live
GET /health/ready
GET /admin/api/health
~~~

Use Admin Alerts and Repository Governance to identify repository errors, stale sync, missing configuration, or webhook issues.

## MCP authentication fails

Verify:

- `AUTH_MODE`;
- caller API key;
- `TEAM_SKILL_HUB_API_KEY` environment variable;
- the configured MCP URL;
- repository/role visibility.

The setup script stores only the API-key environment variable name, not the plaintext key.

## Hook events missing

Check:

1. `~/.codex/hooks.json` includes Team Skill Hub handlers.
2. `~/.codex/hooks/team-skill-hub.conf` has the expected event URL.
3. Runtime/schema versions are visible in Admin Sessions.
4. Network access to `/client-events` works.

Normal hooks are fail-open, so Codex may keep working even when event delivery fails.

## Hook schema rejected

Query:

~~~tex
GET /client-events/schema
~~~

Upgrade the client runtime. Explicit unsupported schema versions return HTTP 400 and the supported range.

## Automatic Candidate not created

Open Observability -> Auto Candidate Decisions and inspect the recorded skip reason. Common reasons:

- no engineering action;
- no strong test evidence;
- summary too short;
- low reuse value;
- duplicate;
- session/user limit;
- Stop-hook recursion.

## Knowledge search misses expected conten

Check:

- repository is active and visible to the caller;
- lifecycle state is not hidden;
- applicability context is correct;
- document was indexed/chunked;
- Evaluation result for the query.

Use the Knowledge tab to test retrieval and inspect ranking reasons.

## GitLab publish/reconcile fails

Check the Candidate `publishError`, Repository publishing config, write-token reference, target path, and MR state. Closed MRs are not silently reused. Refresh MR state from Review Inbox.

## Corrupted/large observability files

The observability store recovers malformed JSONL lines and rotates oversized files. Use Data Governance/Operational Health to inspect current storage and retention state.
