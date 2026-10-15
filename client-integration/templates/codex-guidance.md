<!-- BEGIN TEAM-SKILL-HUB -->
## Team Skill Hub

Use the `{{SERVER_NAME}}` MCP server proactively for team-specific engineering work.

For team-specific engineering tasks and questions, including short questions containing project or technology keywords:
1. Before implementing, reviewing, diagnosing, or answering, call `discover` with the user's original request or its important terms; do not wait for the user to explicitly request Team Skill Hub, name a Skill, or ask for Knowledge.
2. Treat `discover` as the default routing entry point. Let Skills, Knowledge, Prompts, Agents, and Tools compete by relevance instead of pre-classifying every request on the client.
3. If `discover` returns a clearly relevant Skill, call `get_skill` before executing the task. If it returns clearly relevant Knowledge, call `get_knowledge` before answering or changing code. Load Prompts, Agents, or Tools only when they are actually relevant.
4. Use `resolve_skill`, `search_skills`, `search_knowledge`, or other asset-specific search tools only when `discover` is ambiguous, insufficient, or a more precise follow-up search is needed. Do not run Skill and Knowledge searches in parallel by default.
5. Load only the selected assets; do not load every candidate. If no relevant Team Skill Hub asset is found, continue normally and do not invent team-specific guidance.
6. Respect repository visibility, role filtering, and client compatibility.
7. If a retrieved Team Skill Hub asset is clearly outdated or incorrect, use `submit_feedback` with a concise evidence-based reason.
8. When work uncovers durable, verified team-specific knowledge that is missing from the Hub, call `get_knowledge_submission_spec` immediately before submission, follow the returned current rules/template, then call `submit_knowledge_candidate` with the returned `spec_version`. Do not submit raw notes/transcripts, secrets, credentials, customer-sensitive data, or speculative conclusions.
9. When creating or submitting any Skill, including a Skill that contains only one `SKILL.md`, use `submit_skill_bundle`. Use `import_type=skill` for one Skill root and `import_type=collection` only for an explicit multi-Skill namespace snapshot. Do not submit Skills through Knowledge Candidate APIs.
10. Do not call repository sync, rollback, or administrative operations unless the user explicitly requests that operational action.
11. When SessionStart reports a Team Skill Hub client integration update, never upgrade silently. Only when the user explicitly asks to upgrade Team Skill Hub, run `{{CLIENT_LAUNCHER}} upgrade`; after a required update, restart Codex before relying on new integration behavior.

Typical triggers include OTA, Yocto, embedded Linux, firmware, CI/CD, testing, CVE management, release engineering, platform tooling, and project-specific design/API questions.

<!-- END TEAM-SKILL-HUB -->
