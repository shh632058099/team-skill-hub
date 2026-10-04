# Changelog

All notable Team Skill Hub application changes are recorded here.

The project uses Semantic Versioning. Git-managed Skills, Knowledge, Prompts, Agents and Tools have independent repository/revision lifecycles and are not versioned by this application changelog.

## [Unreleased]

### Added

- Release validation checks semantic version, changelog entry, migration note and immutable image-tag configuration.
- Claude Code native HTTP Hook adapter and user-level MCP setup for the shared Client Event pipeline.
- Portable Codex Agent Plugin builder with versioned MCP, Skill, cross-platform Hooks, and repo marketplace output.
- Generic Agent Adapter Contract v1 discovery plus non-Codex/non-Claude CI-agent E2E coverage.
- Two-phase GitLab sandbox acceptance CLI for real Candidate→MR→human merge→webhook→sync→RAG verification.
- Registry acceptance harness for immutable release/SHA/rollback image verification.

## [0.1.0] - 2026-09-30

### Added

- MCP Skill/Knowledge/Prompt/Agent/Tool registries and unified discovery.
- Git/local Repository sync with validated revisions, last-known-good rollback and audit history.
- Knowledge lifecycle metadata, version applicability, deterministic ranking and retrieval evaluation.
- Codex Hook Runtime, Client Event schema, structured Engineering Evidence and Session Timeline.
- Automatic Knowledge Candidate detection with human Review Inbox and GitLab MR publishing/reconcile.
- Project Context, Tool Registry, policy checks, operational health, alerts and governance views.
- Data retention/rotation, backup/restore and 30-user capacity harness.
- Versioned REST v1/OpenAPI surfaces and compatibility discovery.

### Security

- Secret redaction/data governance boundaries for observability and Hook events.
- API-key authentication and role/repository access controls.

### Notes

- The first production GitLab sandbox acceptance remains an external deployment gate; mock/integration coverage does not replace a real sandbox MR/webhook exercise.
