# Team Skill Hub / Internal AI Registry

Git-first MCP service for sharing, searching, routing and loading team Skills, Prompts and Agent manifests.

## License

Team Skill Hub is open source under the [Apache License 2.0](LICENSE).

完整文档导航见 [docs/README.md](docs/README.md)。用户文档与日常使用文档已分别整理到 docs/user/ 和 docs/usage/。

For the recommended **GitHub Hub + private company GitLab Skills** deployment:

- 中文管理员快速部署：`docs/deployment/admin-deployment-guide.zh-CN.md`
- English: `docs/deployment/deployment-github-gitlab.md`
- 中文完整部署：`docs/deployment/deployment-github-gitlab.zh-CN.md`

For ordinary developers using the MCP service:

- 中文快速使用：`docs/user/user-guide.zh-CN.md`
- English: `docs/usage/developer-mcp-guide.md`
- 中文开发者详细指南：`docs/usage/developer-mcp-guide.zh-CN.md`

## Repositories

This server is intentionally separate from the Skill content repository:

```text
skill-hub-workspace/
├── team-skill-hub/
├── rd-skills/
└── customer-skills/
```

## Docker Compose

From `team-skill-hub`:

```bash
docker compose up -d --build
docker compose ps
```

The default image uses Node 24. You can override the build image when needed:

```bash
NODE_IMAGE=node:26-trixie-slim docker compose build
```

Git support is enabled in the production image by default. For a local benchmark that
only mounts local Skill repositories, it can be skipped to avoid the package-manager step:

```bash
INSTALL_GIT=0 docker compose build
```

Health:

```text
http://localhost:8080/health/live
http://localhost:8080/health/ready
```

MCP:

```text
http://localhost:8080/mcp
```

Codex client setup:

```bash
bash scripts/setup-codex-mcp.sh --url http://localhost:8080/mcp
# Optional opt-out: keep Hooks/Observability but disable automatic Knowledge Candidate detection
bash scripts/setup-codex-mcp.sh --url http://localhost:8080/mcp --no-auto-knowledge
# Upgrade an existing installation without re-entering the URL
bash scripts/setup-codex-mcp.sh --upgrade
```

Windows PowerShell:

```powershell
.\scripts\setup-codex-mcp.ps1 -Url http://localhost:8080/mcp
# Optional opt-out
.\scripts\setup-codex-mcp.ps1 -Url http://localhost:8080/mcp -NoAutoKnowledge
# Upgrade an existing installation without re-entering the URL
.\scripts\setup-codex-mcp.ps1 -Upgrade
```

These scripts configure the Codex MCP server and idempotently add Team Skill Hub instructions to the global `~/.codex/AGENTS.md`.
The installed Hook Runtime reports `runtime_version` and `hook_schema_version` on lifecycle events. The Admin Sessions view marks clients as `current`, `outdated`, or `unknown`. `--upgrade` / `-Upgrade` refreshes the managed runtime and preserves the existing Hub URL, server name, API-key environment variable, and Auto Knowledge preference unless explicitly overridden.
They also install a fail-open Codex lifecycle hook runtime and merge Team Skill Hub handlers into the existing global `~/.codex/hooks.json` without deleting unrelated hooks. The framework reserves SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact, Stop, and SessionEnd. V1 actively emits SessionStart, UserPromptSubmit, PostToolUse, Stop, and SessionEnd; PreToolUse, PreCompact, and PostCompact remain reserved with non-matching matchers to avoid unnecessary process overhead. Only allowlisted lifecycle metadata is sent to `/client-events`.
Auto Knowledge is **on by default**. The Stop hook sends only a locally redacted, bounded excerpt of `last_assistant_message` (max 4000 characters). User prompts, full tool input/output, transcript contents and file contents are not uploaded. The Hub creates an automatic `codex-summary` Knowledge Candidate only when the same session contains an engineering action plus structured passing-test evidence. Candidates still require Web review and GitLab MR publication; nothing is auto-merged. Use `--no-auto-knowledge` / `-NoAutoKnowledge` to opt out while keeping Hooks and Observability.

Claude Code setup uses the same MCP server and Client Event pipeline:

~~~bash
bash scripts/setup-claude-code.sh --url http://localhost:8080/mcp
~~~

~~~powershell
.\scripts\setup-claude-code.ps1 -Url http://localhost:8080/mcp
~~~

The Claude installer merges user-level HTTP Hooks for SessionStart, UserPromptSubmit, PostToolUse, Stop, and SessionEnd into ~/.claude/settings.json without removing unrelated hooks. It registers the Hub as a user-scoped HTTP MCP server when the claude CLI is available. Authentication is read dynamically from TEAM_SKILL_HUB_API_KEY (or the configured environment variable); the installer does not persist the token value. Native Claude Hook payloads are accepted at /client-events/claude-code, normalized to the same v1 Client Event model, and reuse Session, Evidence, Candidate Detector, Knowledge Gap, and Observability logic. See docs/development/claude-code-adapter.md.

For Codex marketplace distribution, build a portable Agent Plugin for a concrete Hub URL:

~~~bash
npm run plugin:build -- --url https://skill-hub.example.com/mcp --marketplace-root ./team-plugin-marketplace
codex plugin marketplace add ./team-plugin-marketplace
~~~

The generated package contains the remote MCP configuration, Team Skill Hub skill guidance, and cross-platform lifecycle hooks. It stores only the API-key environment-variable name, never the token value. See docs/development/codex-plugin-distribution.md.

Observability now groups Hook Events and MCP calls into Codex Sessions. MCP calls are auto-linked only when the principal has exactly one active Codex session; concurrent sessions are left unbound unless the client supplies an explicit session ID. Skill and Knowledge FTS queries also apply allowed Repository filters before the FTS candidate LIMIT.
For normal task discovery, clients can now call `discover` once to retrieve visible, client-compatible Skill, Knowledge, Prompt, Agent, and Tool candidates together. Existing category-specific search tools remain available for narrower follow-up searches.

Webhook:

```text
POST http://localhost:8080/webhooks/git
X-Gitlab-Token: <GITLAB_WEBHOOK_TOKEN>
```

GitLab project payloads are mapped through `project.path_with_namespace`, `project.web_url`, repository name, repository ID, or configured `webhook_aliases`. The older `x-skill-hub-repository` + `x-skill-hub-secret` form remains supported. The webhook is fail-closed if neither `GITLAB_WEBHOOK_TOKEN` nor `WEBHOOK_SECRET` is configured.

Operational HTTP endpoints use a separate admin key:

```text
POST /repositories/<id>/sync
GET  /audit
x-skill-hub-admin-key: <ADMIN_API_KEY>
```

If `ADMIN_API_KEY` is not configured, those operational HTTP endpoints deny access.

The default Compose configuration mounts both sibling Skill repositories read-only:

```text
../rd-skills       -> /skills/rd-skills
../customer-skills -> /skills/customer-skills
```

## Local development

```bash
npm install
CONFIG_PATH=./config/repositories.local.yaml npm run dev
```

On PowerShell:

```powershell
$env:CONFIG_PATH="./config/repositories.local.yaml"
npm run dev
```

The local development config listens on `http://127.0.0.1:18080` to avoid
conflicting with the Docker endpoint on port `8080`.

## Authentication modes

Development mode keeps the current local/Codex workflow unchanged:

```text
AUTH_MODE=development
```

Production should use request-scoped API keys:

```text
AUTH_MODE=api-key
ADMIN_API_KEY=<long-random-admin-key>
```

After startup, open `http://<hub-host>:8080/admin` and create user API keys from
the **用户 API Keys** section. A generated key is shown once; the server persists
only its SHA-256 hash, last four characters, Principal, roles, tenant and enabled
state. Create/disable/delete operations take effect immediately without restart.

`SKILL_HUB_API_KEYS_JSON` remains supported only as an optional bootstrap /
backward-compatibility mechanism. It may be empty:

```dotenv
AUTH_MODE=api-key
SKILL_HUB_API_KEYS_JSON=
ADMIN_API_KEY=<long-random-admin-key>
```

Use the admin UI for normal key lifecycle management rather than editing `.env`.

Clients send either:

```text
x-skill-hub-api-key: <key>
```

or:

```text
Authorization: Bearer <key>
```

The resolved Principal is scoped to the individual MCP request. A developer key cannot list or load customer-only repositories, and a customer key cannot list or load internal R&D repositories.

## Codex

```bash
codex mcp add teamSkillHub --url http://localhost:8080/mcp
codex mcp list
```

Useful tools:

- `discover`
- `list_skill_repositories`
- `list_skills`
- `search_skills`
- `resolve_skill`
- `get_skill`
- `get_skill_resource`
- `sync_skill_repository`
- `list_sync_audit`
- `list_repository_revisions`
- `rollback_repository_revision`
- `list_prompts`
- `search_prompts`
- `get_prompt`
- `list_agents`
- `search_agents`
- `resolve_agent`
- `get_agent`
- `list_tools`
- `search_tools`
- `get_tool`
- `list_evaluation_suites`
- `run_evaluation`
- `list_evaluation_runs`
- `get_evaluation_run`
- `list_knowledge_sources`
- `search_knowledge`
- `get_knowledge`
- `submit_feedback`
- `submit_knowledge_candidate`

Example request:

```text
Use teamSkillHub to find the best skill for reviewing the current OTA implementation
for unnecessary APIs and long call chains. Load the selected skill and follow it.
For broader tasks, prefer `discover` first so Skill, Knowledge, Prompt, Agent, and Tool candidates are returned together.
```

## Tool Registry

Repositories may register non-secret tool metadata with `TOOL.yaml`. A Tool describes its type, owner, audience/visibility, compatible clients, supported environments and capabilities, plus an optional authentication **reference**. Credential values are never stored in the Tool manifest or returned by MCP.

Example:

```yaml
schema_version: 1
name: git
description: Git source control repository operations.
type: cli
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [git, repository]
  owner: platform-team
  compatibility:
    codex: true
environments: [development, ci]
capabilities: [status, diff, commit]
authentication:
  type: environment
  reference: GIT_CREDENTIAL_HELPER
```

Agent manifests may reference local Tool names. Repository activation fails if a local Tool binding is missing.

## Knowledge / RAG

Repository documentation can be indexed as lightweight RAG context without a
vector database or model gateway. Supported text sources are:

- Markdown (`.md`)
- plain text (`.txt`)
- text-based PDF (`.pdf`)
- DOCX (`.docx`)

Scanned/image-only PDFs are not OCR'd in the current version.

Each Repository has an optional Knowledge Source configuration. When omitted, the
backward-compatible default is:

```yaml
knowledge:
  enabled: true
  include:
    - "**/*.md"
    - "**/*.txt"
    - "**/*.pdf"
    - "**/*.docx"
  exclude: []
  max_document_bytes: 2097152
  chunk_size_chars: 1400
  chunk_overlap_chars: 180
```

Administrators can edit these settings at `/admin`. Saving immediately
re-synchronizes that Repository and rebuilds its Knowledge index. Dynamic
configuration is persisted under `<data_dir>/config/admin-config.json`.

Knowledge retrieval uses SQLite FTS5 plus metadata/manual scoring. Repository
read-role filtering is applied before results are exposed. Use
`search_knowledge` to retrieve relevant chunks and `get_knowledge` for the
selected document/chunk.

## MCP observability and knowledge feedback loop

All MCP tools are registered through a common tracing wrapper. The Hub records
tool name, caller identity, trace/session identifiers when available, latency,
success/failure, and sanitized argument summaries. Secrets and API keys are
redacted and full tool response bodies are not duplicated into call logs.

Developers can submit explicit result feedback with `submit_feedback`, or send a
new `submit_knowledge_candidate` item to the human review queue. The `/admin`
console exposes Observability, Feedback, Review Inbox, and Knowledge Gaps views.
Administrators can edit and approve a Knowledge candidate, then publish it through
a GitLab branch + commit + Merge Request. The Hub never merges directly; after the
normal GitLab review/merge, the existing repository sync path validates and reindexes
Knowledge. A separate write token is used for publishing so repository sync can stay
read-only.

## Deterministic Evaluation

Golden regression suites live with the AI assets as `EVALUATION.yaml` and are versioned/reviewed in GitLab together with `SKILL.md`, `PROMPT.md`, and `AGENT.yaml`.

Run all suites in a repository:

```bash
npm run evaluate:repo -- --path ../rd-skills --id rd-skills
```

Compare a candidate working tree with a baseline checkout:

```bash
npm run evaluate:repo -- \
  --path ../rd-skills \
  --baseline-path ../rd-skills-baseline \
  --id rd-skills \
  --revision candidate \
  --baseline-revision main
```

The command exits non-zero when a golden case fails, a candidate regresses versus baseline, or a previously passing baseline case/suite is removed. The GitLab CI example performs this comparison automatically for merge requests.

See `docs/evaluation/evaluation-framework.md` for the full format and workflow.

## Benchmark

With the Docker service running:

```bash
npm run benchmark
```

Or run the benchmark from inside the container:

```bash
docker compose exec team-skill-hub npm run benchmark
```

Tune the run:

```bash
BENCH_ITERATIONS=1000 BENCH_CONCURRENCY=50 npm run benchmark
```

PowerShell:

```powershell
$env:BENCH_ITERATIONS="1000"
$env:BENCH_CONCURRENCY="50"
npm run benchmark
```

The benchmark reports requests/second and p50/p95/p99 latency for `resolve_skill`.

## Metrics

Prometheus-style metrics are available at:

```text
GET /metrics
```

Current counters/timers include Skill search/resolve/load, repository sync results and durations, and rollback results.

## Repository access policy

Each repository can independently define read and manual-sync roles:

```yaml
access:
  read_roles: [developer, internal]
  sync_roles: [developer, admin]
```

An empty `read_roles` list means the repository is readable without a role requirement,
subject to its visibility policy. Polling, startup and authenticated webhook synchronization
are system-triggered; manual MCP/HTTP synchronization requires a configured sync role.

## Sync audit

Synchronization attempts are appended to:

```text
<data_dir>/audit/events.jsonl
```

Visible audit events can be queried through MCP `list_sync_audit`. Operators can also use:

```text
GET /audit?repository=rd-skills&limit=100
x-skill-hub-admin-key: <ADMIN_API_KEY>
```

Repository listings intentionally do not expose local filesystem paths, Git URLs, or
configured role policy details to MCP callers.

## Revision history and rollback

Every successfully validated repository revision is stored as an immutable snapshot under the Skill Hub data directory. Use MCP:

```text
list_repository_revisions
rollback_repository_revision
```

or the admin HTTP endpoints:

```text
GET  /repositories/<id>/revisions
POST /repositories/<id>/rollback
x-skill-hub-admin-key: <ADMIN_API_KEY>
```

Rollback accepts only an already validated local snapshot and is recorded in audit history.

## Skill dependencies and client compatibility

Schema version 1 now supports optional metadata:

```yaml
depends_on:
  - common-log-analysis

compatibility:
  codex: true
  claude_code: true
  customer_agent: false
```

Same-repository dependencies are validated during sync. Cross-repository references are reserved for Registry-level validation. Passing `client` to `list_skills`, `search_skills`, or `resolve_skill` filters out Skills explicitly marked incompatible with that client.

The current routing pipeline is:

```text
permission / metadata filter
  -> SQLite FTS5 + lexical scoring
  -> candidate reranker interface
  -> top-k
```

The default reranker is pass-through. A semantic or LLM reranker can be added later without changing MCP tool contracts.

## Skill repository validation and CI

Validate a Skill repository before merge:

```bash
npm run validate:repo -- --path ../rd-skills --id rd-skills --visibility internal
npm run validate:repo -- --path ../customer-skills --id customer-skills --visibility customer
```

The validator runs the same parser and validation rules used by the server, including required metadata, duplicate names, same-repository dependencies, and repository visibility boundaries.

Reusable CI templates are provided under:

```text
examples/ci/github-actions-skill-validation.yml
examples/ci/gitlab-ci-skill-validation.yml
```

The GitHub template contains a placeholder `YOUR_ORG/team-skill-hub`; the GitLab template expects `TEAM_SKILL_HUB_REPO` to be supplied by CI configuration.

## Private GitLab repositories

Git repositories support three auth modes:

```yaml
git_auth:
  type: none
```

```yaml
git_auth:
  type: ssh
  ssh_key_path: /run/secrets/gitlab_ssh_key
  known_hosts_path: /run/secrets/gitlab_known_hosts
```

```yaml
git_auth:
  type: https-token
  token_env: GITLAB_TOKEN
  username_env: GITLAB_USERNAME
```

SSH Deploy Key is the recommended production mode. HTTPS tokens are injected through Git's askpass mechanism rather than embedded in `git_url` or persisted in repository configuration.
