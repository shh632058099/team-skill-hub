# Internal AI Platform for a ~30-person Engineering Team

## Positioning

This project is intentionally **not** a model gateway. Models remain owned by Codex, Claude Code, ChatGPT, or other clients. The platform manages reusable team AI assets and the engineering context around them.

```text
Codex / Claude Code / internal clients
                 |
                 v
             MCP / API
                 |
      +----------+----------+
      |          |          |
   Skills      Prompts     Agents
      |          |          |
      +----------+----------+
                 |
          Git repositories
                 |
        GitLab review / CI
```

For a team of roughly 30 people, keep the runtime single-instance and low-ops. PostgreSQL, Redis, vector databases, Kubernetes, SSO, and model gateways are deliberately deferred.

## Registry assets

### Skill

`SKILL.md` describes reusable domain procedure and engineering knowledge.

### Prompt

`PROMPT.md` is reusable wording/instruction content that can be loaded independently or referenced by an Agent.

### Agent

`AGENT.yaml` is a declarative team Agent profile. It binds reusable assets but does not select or proxy a model.

```yaml
schema_version: 1
name: ota-expert
description: Internal OTA engineering agent.
metadata:
  audience: [developer]
  visibility: [internal]
  keywords: [ota, debugging]
  owner: ota-team
  compatibility:
    codex: true
skills:
  - ota-code-review
prompts:
  - ota-code-review-prompt
tools:
  - git
  - repository-read
```

The Hub validates same-repository Skill and Prompt references before activating a new revision.

## MCP capabilities

Skill tools:

```text
list_skills
search_skills
resolve_skill
get_skill
get_skill_resource
```

Prompt tools:

```text
list_prompts
search_prompts
get_prompt
```

Agent tools:

```text
list_agents
search_agents
resolve_agent
get_agent
```

Repository governance is shared by all asset types:

```text
sync_skill_repository
list_repository_revisions
rollback_repository_revision
list_sync_audit
```

## Usage analytics

The Hub records best-effort local usage events for:

```text
skill  search / resolve / load
prompt search / load
agent  search / resolve / load
```

Events are stored under:

```text
<data_dir>/analytics/usage.jsonl
```

The store is bounded. Query capture performs basic redaction for email addresses and common token prefixes before persistence.

Admin APIs:

```text
GET /analytics/usage?limit=200
GET /analytics/usage?limit=200&unmatched=true
GET /analytics/summary?limit=10
```

All analytics endpoints require the admin key.

The summary exposes total/matched/unmatched activity, usage by asset type/action, most frequently selected assets, and frequent sanitized unmatched queries. The unmatched-query list should drive the next Skill/Prompt/Agent improvements.

## Recommended workflow

```text
Engineer identifies repeated task
        |
        +--> procedure -> SKILL.md
        |
        +--> reusable wording -> PROMPT.md
        |
        +--> stable bundle -> AGENT.yaml
                    |
                    v
                GitLab MR
                    |
                    v
          validate:repo in CI
                    |
                    v
              review + merge
                    |
                    v
            GitLab webhook
                    |
                    v
      validate -> snapshot -> activate
```

## Evaluation

A deterministic Evaluation Framework is now part of the platform. Golden cases are stored as `EVALUATION.yaml` in the same GitLab repository as the assets they protect. It supports Skill/Prompt/Agent search/resolve/get expectations, content contracts, Agent binding contracts, baseline-vs-candidate comparison, persisted evaluation runs, MCP/HTTP querying, and CI failure on regression.

For details, see `docs/evaluation/evaluation-framework.md`.

## What to build next

For this team size, the next useful work is:

1. grow the golden datasets from real historical engineering tasks;
2. add lightweight human useful/not-useful feedback to complement deterministic checks;
3. add change-impact reporting that maps modified assets to affected suites;
4. build a small Admin UI over health, revision, audit, analytics, and evaluation APIs;
5. defer external databases and model-based judges until deterministic evaluation is no longer enough.
