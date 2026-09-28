# Team Skill Hub / Internal AI Registry

Git-first MCP service for sharing, searching, routing and loading team Skills, Prompts and Agent manifests.

## License

Team Skill Hub is open source under the [Apache License 2.0](LICENSE).

For the recommended **GitHub Hub + private company GitLab Skills** deployment:

- English: `docs/deployment-github-gitlab.md`
- 中文：`docs/deployment-github-gitlab.zh-CN.md`

For ordinary developers using the MCP service:

- English: `docs/developer-mcp-guide.md`
- 中文：`docs/developer-mcp-guide.zh-CN.md`

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

Production can switch to request-scoped API keys without changing MCP tools:

```text
AUTH_MODE=api-key
SKILL_HUB_API_KEYS_JSON={"dev-key":{"id":"dev-a","roles":["developer","internal"],"tenantId":"rd"},"customer-key":{"id":"customer-a","roles":["customer"],"tenantId":"customer-a"}}
```

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
- `list_evaluation_suites`
- `run_evaluation`
- `list_evaluation_runs`
- `get_evaluation_run`

Example request:

```text
Use teamSkillHub to find the best skill for reviewing the current OTA implementation
for unnecessary APIs and long call chains. Load the selected skill and follow it.
```

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

See `docs/evaluation-framework.md` for the full format and workflow.

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
