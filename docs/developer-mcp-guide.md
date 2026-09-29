# Developer Guide: Using Team Skill Hub MCP

## 1. Audience

This guide is for ordinary engineers who use Team Skill Hub from Codex or another MCP-capable development client. You do not need to deploy or administer the Hub.

Normally you only need:

- the MCP endpoint provided by the team administrator;
- a Developer API Key;
- Codex or another MCP-capable client;
- network access to the Hub.

The Hub provides team-managed Skills, reusable Prompts, Agent profiles, and deterministic Evaluation suites.

## 2. What to request from the administrator

Ask for:

~~~text
MCP endpoint:
https://<skill-hub-host>/mcp

Developer API key:
<your-developer-key>
~~~

You do not need GitLab Deploy Keys, ADMIN_API_KEY, GITLAB_WEBHOOK_TOKEN, server SSH access, or repository write credentials.

## 3. Recommended: use the setup script

Linux / macOS / WSL:

~~~bash
bash scripts/setup-codex-mcp.sh \
  --url https://<skill-hub-host>/mcp
~~~

Windows PowerShell:

~~~powershell
.\scripts\setup-codex-mcp.ps1 `
  -Url https://<skill-hub-host>/mcp
~~~

The scripts automatically:

1. update the `teamSkillHub` MCP server in `~/.codex/config.toml`;
2. create or update the global **`~/.codex/AGENTS.md`** so Codex proactively uses Team Skill Hub across projects.

The Team Skill Hub section is managed with BEGIN/END markers. Re-running the script updates that section idempotently and preserves unrelated global instructions.

The API key is never written into `config.toml` or the project. Codex references the `TEAM_SKILL_HUB_API_KEY` environment variable.

This is the global **`~/.codex/AGENTS.md`**. Project-level `AGENTS.md` files can still add project-specific rules on top of it.

After setup, export the API key and restart Codex:

~~~bash
export TEAM_SKILL_HUB_API_KEY='<developer-api-key>'
codex mcp list
~~~

PowerShell:

~~~powershell
$env:TEAM_SKILL_HUB_API_KEY="<developer-api-key>"
codex mcp list
~~~

## 4. Manual Codex configuration

Codex CLI and the Codex IDE extension share configuration.

### Administrator: issuing keys for multiple users

Production deployments use `AUTH_MODE=api-key` and an independent
`ADMIN_API_KEY`. After startup, administrators open:

```text
http://<skill-hub-host>:8080/admin
```

and create user API keys in **用户 API Keys**. Each key has a User ID, Tenant and
Roles. The generated `skh_...` plaintext is shown once; the Hub stores only a
hash and metadata. Create, disable and delete operations take effect immediately.

`SKILL_HUB_API_KEYS_JSON` is still accepted as an optional bootstrap /
backward-compatibility mechanism, but normal user lifecycle management should use
the admin UI rather than editing `.env`.

Keep the API key in an environment variable.

Linux/macOS:

~~~bash
export TEAM_SKILL_HUB_API_KEY='<developer-api-key>'
~~~

PowerShell:

~~~powershell
$env:TEAM_SKILL_HUB_API_KEY="<developer-api-key>"
~~~

Add the MCP server to ~/.codex/config.toml:

~~~toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
~~~

For an unauthenticated local development Hub only:

~~~bash
codex mcp add teamSkillHub --url http://127.0.0.1:18080/mcp
~~~

Do not use the unauthenticated development form for a shared production Hub.

## 5. Verify the connection

Check configured MCP servers:

~~~bash
codex mcp list
~~~

Then ask Codex:

~~~text
Use teamSkillHub get_server_info and tell me which capabilities are available to me.
~~~

Also verify repository visibility:

~~~text
Use teamSkillHub to list the repositories I can access.
~~~

A normal internal developer should usually see rd-skills. Repositories outside your role are intentionally hidden.

## 6. Recommended project instruction

Add this to the project's AGENTS.md:

~~~text
When a task could benefit from team-specific engineering knowledge,
use the teamSkillHub MCP server before starting substantial work.

First search or resolve the relevant Skill or Agent.
Load the selected Skill/Prompt only when needed.
Load referenced resources progressively rather than loading everything.

Prefer a domain-specific team asset over generic guidance when both apply.
Do not call repository synchronization, rollback, or administrative operations
unless the user explicitly requests an operational action and has permission.
~~~

## 6. Main assets

### Skills

Skills describe reusable team engineering knowledge and procedures.

Common tools:

~~~text
list_skills
search_skills
resolve_skill
get_skill
get_skill_resource
~~~

Recommended flow:

~~~text
task
  -> resolve_skill
  -> get_skill
  -> get_skill_resource only when required
  -> perform the engineering task
~~~

### Prompts

Prompts are reusable team-approved task instructions.

~~~text
list_prompts
search_prompts
get_prompt
~~~

### Agents

Agents are declarative team profiles that group Skills, Prompts, and permitted tool names.

~~~text
list_agents
search_agents
resolve_agent
get_agent
~~~

The Hub does not select or proxy a language model. Your client continues to use its own model.

### Knowledge / RAG

Knowledge contains current project facts and documents rather than reusable
procedures. Supported sources include Markdown, TXT, text-based PDF and DOCX.

```text
list_knowledge_sources
search_knowledge
get_knowledge
```

Use `search_knowledge` for design documents, APIs, troubleshooting notes,
postmortems, FAQ and similar repository context. Use `get_knowledge` after a
search hit when you need the exact selected chunk or full document. Image-only
scanned PDFs are not OCR'd.

## 7. Typical daily workflows

### OTA code review

~~~text
Use teamSkillHub to find the best Skill for reviewing the current OTA implementation.
Focus on unnecessary APIs, overly long call chains, redundant abstractions,
and give a deletion/change risk for every recommendation.
Load the selected Skill and follow it while reviewing this repository.
~~~

Expected flow:

~~~text
resolve_skill
  -> ota-code-review
  -> get_skill
  -> optional get_skill_resource
  -> repository review
~~~

### Project documentation / RAG

~~~text
Search teamSkillHub Knowledge for the current OTA power-loss recovery design.
Use the most relevant chunks as evidence, then load the selected document/chunk
with get_knowledge before answering.
~~~

Expected flow:

~~~text
search_knowledge
  -> relevant repository chunk
  -> get_knowledge
  -> grounded analysis
~~~

### Reusable Prompt

~~~text
Use teamSkillHub to find the reusable Prompt for OTA API/code review,
load it, then apply it to the current repository.
~~~

### Team Agent

~~~text
Use teamSkillHub to resolve the best Agent for OTA code review and debugging.
Load the Agent definition, then load the referenced Skill and Prompt as needed.
~~~

### Yocto/CVE-style task

~~~text
Search teamSkillHub for Skills, Prompts, or Agents related to Yocto CVE management.
If a suitable team asset exists, load it and use it to prepare the implementation plan.
If nothing relevant is found, tell me that no team asset matched before proceeding.
~~~

Unmatched queries can help the team decide which new assets to create.

## 8. Search versus resolve

Use search when you want alternatives:

~~~text
Search teamSkillHub for OTA review Skills and show me the top matches.
~~~

Use resolve when you want the best match for a concrete task:

~~~text
Resolve the best Skill for simplifying an OTA implementation.
~~~

For most daily work, resolve_skill or resolve_agent should be the first choice.

## 9. Progressive loading

Do not load every Skill and resource at task start.

Preferred pattern:

~~~text
1. search/resolve metadata
2. load the selected Skill/Prompt/Agent
3. load references/resources only when the task reaches that step
~~~

For a Skill:

~~~text
resolve_skill
      |
      v
get_skill
      |
      +--> enough context -> work
      |
      \`--> more detail needed -> get_skill_resource
~~~

## 10. Client compatibility

Skills, Prompts, and Agents can declare client compatibility.

When using Codex, use:

~~~text
client = codex
~~~

Natural-language example:

~~~text
Search teamSkillHub for OTA review Skills that are compatible with Codex.
~~~

Assets explicitly marked incompatible with codex are filtered out.

## 11. Evaluation suites

Evaluation suites are deterministic golden regression tests stored with team assets.

List suites:

~~~text
Use teamSkillHub to list evaluation suites for rd-skills.
~~~

Run the active revision:

~~~text
Use teamSkillHub to run the ota-core-regression evaluation suite for rd-skills
and summarize failed cases, if any.
~~~

Relevant tools:

~~~text
list_evaluation_suites
run_evaluation
list_evaluation_runs
get_evaluation_run
~~~

Evaluation does not call a language model. It checks deterministic routing, required content, and Agent binding expectations.

Normal coding tasks do not need to run Evaluation every time. GitLab CI runs regression suites when team assets change.

## 12. Permission behavior

The Hub applies server-side permission filtering before returning repositories or assets.

If an expected repository or asset is missing:

1. verify that you are using the correct Developer API Key;
2. call get_server_info to inspect your resolved roles;
3. call list_skill_repositories to see visible repositories;
4. contact the Hub administrator if access is still missing.

Do not work around permission filtering by requesting GitLab credentials or direct server access.

## 13. Operations ordinary developers normally should not perform

Operational tools include:

~~~text
sync_skill_repository
rollback_repository_revision
list_sync_audit
~~~

Normal development should use:

~~~text
GitLab MR
  -> review
  -> merge
  -> webhook/polling
  -> Hub validation
  -> activation
~~~

Rollback is an operational recovery action, not a normal developer workflow.

## 14. Common problems

### teamSkillHub is missing from codex mcp list

Check ~/.codex/config.toml:

~~~toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
~~~

Start a new Codex session after changing MCP configuration.

### Authentication fails

Check that the environment variable exists in the process that starts Codex.

Linux/macOS:

~~~bash
test -n "$TEAM_SKILL_HUB_API_KEY" && echo configured || echo missing
~~~

PowerShell:

~~~powershell
if ($env:TEAM_SKILL_HUB_API_KEY) { "configured" } else { "missing" }
~~~

Do not print or paste the actual API key into chat, logs, tickets, or source files.

### MCP is configured but unavailable

Verify that your machine can reach:

~~~text
https://<skill-hub-host>/mcp
~~~

If the Hub is internal-only, connect to the required company network/VPN.

### Search returns no result

Prefer a task-focused query.

Less useful:

~~~text
OTA
~~~

Better:

~~~text
Review OTA implementation for unnecessary interfaces and long call chains.
~~~

If nothing matches, continue with normal engineering reasoning and state that no team asset matched.

### A Skill resource cannot be loaded

Load only resources referenced by the selected Skill. Resources outside the Skill root or your permission scope are intentionally blocked.

### Evaluation fails

Ask for failed case IDs and messages:

~~~text
Run ota-core-regression and explain only the failed golden cases,
including expected versus actual results.
~~~

Do not delete golden cases just to make Evaluation pass. Fix the asset, or update the expected behavior through the normal GitLab review process.

## 15. Safe usage practices

- Keep the Developer API Key in an environment variable or approved secret store.
- Never commit API keys into config files, project files, scripts, or Git.
- Prefer team-managed Skills, Prompts, and Agents for domain-specific procedures.
- MCP guidance does not bypass code review, security policy, or release controls.
- Review generated code and commands before execution.
- Load resources progressively to reduce irrelevant context.
- Do not use sync or rollback as shortcuts around GitLab review.
- If team guidance is outdated, update the source asset through GitLab.

## 16. Quick reference

Connection:

~~~toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
~~~

Verify:

~~~bash
codex mcp list
~~~

Most useful daily tools:

~~~text
get_server_info
list_skill_repositories
search_skills
resolve_skill
get_skill
get_skill_resource
search_prompts
get_prompt
search_agents
resolve_agent
get_agent
list_evaluation_suites
run_evaluation
~~~

Recommended first request in a repository:

~~~text
Before starting substantial work, use teamSkillHub to check whether there is
a relevant team Skill or Agent for this task. If there is, load it and follow it.
~~~
