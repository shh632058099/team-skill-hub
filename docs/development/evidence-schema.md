# Engineering Evidence Schema

## Goal

Engineering Evidence is the structured proof used by Session views, the automatic Candidate detector, and Review Inbox. It intentionally carries outcomes, not raw tool output.

## Version

Current Evidence schema:

~~~tex
schemaVersion: 1
~~~

The canonical TypeScript contract and normalizer live in `src/client-events.ts`.

## Common fields

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

## Extraction boundary

Hook runtimes extract only compact structured facts from Tool Response. They do not upload stdout/stderr or the complete response body.

The service always calls `normalizeEngineeringEvidence()` before using Evidence for Candidate decisions.

## Detector use

Passing test/build Evidence is a strong signal. The detector rejects weak or ambiguous sessions, including:

- no engineering action;
- no strong passing Evidence;
- one-off formatting or similarly low-reuse-only results;
- duplicate/template summaries;
- recursion and configured rate limits.

## Review use

Generated Candidates retain normalized Evidence. Review Inbox displays type, source tool, success/exit code, counts, duration, and status so the reviewer can judge the claim without opening raw developer transcripts.
