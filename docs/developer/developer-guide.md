# Team Skill Hub Developer Guide

This guide is for ordinary developers using Team Skill Hub. Deployment, administration, repository operations, Evaluation, and internal implementation details belong in `../deployment/` and `../repository/`.

## 1. What you need from an administrator

You only need:

```text
MCP URL: https://<skill-hub-host>/mcp
Developer API Key: skh_...
```

Keep the API key only in the local `TEAM_SKILL_HUB_API_KEY` environment variable. Do not put it in the project repository, chat, logs, or tickets.

## 2. Quick Codex setup

Linux / macOS / WSL:

```bash
export TEAM_SKILL_HUB_API_KEY='skh_...'
bash scripts/setup-codex-mcp.sh --url https://<skill-hub-host>/mcp
codex mcp list
```

Windows PowerShell:

```powershell
$env:TEAM_SKILL_HUB_API_KEY='skh_...'
.\scripts\setup-codex-mcp.ps1 -Url https://<skill-hub-host>/mcp
codex mcp list
```

The setup script configures MCP and the pieces required for Knowledge feedback. Ordinary developers do not need to maintain internal hook or agent configuration.

Automatic Knowledge candidates are enabled by default. Use `--no-auto-knowledge` or `-NoAutoKnowledge` if your team does not want them.

### Manual Codex configuration

If you do not use the setup script, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.teamSkillHub]
url = "https://<skill-hub-host>/mcp"
bearer_token_env_var = "TEAM_SKILL_HUB_API_KEY"
```

Then restart Codex.

## 3. Quick Claude Code setup

Linux / macOS / WSL:

```bash
export TEAM_SKILL_HUB_API_KEY='skh_...'
bash scripts/setup-claude-code.sh --url https://<skill-hub-host>/mcp
claude mcp get teamSkillHub
```

Windows PowerShell:

```powershell
$env:TEAM_SKILL_HUB_API_KEY='skh_...'
.\scripts\setup-claude-code.ps1 -Url https://<skill-hub-host>/mcp
claude mcp get teamSkillHub
```

## 4. Verify the connection

Ask the client:

```text
Use teamSkillHub get_server_info to verify the connection,
then list the repositories I can access.
```

Once this succeeds, Team Skill Hub is ready for normal use.

## 5. Daily use

If you are not sure what to use, start with `discover`.

A simple mental model:

- team procedures, standards, and reusable methods: Skill
- designs, APIs, incidents, and project facts: Knowledge
- reusable task instructions: Prompt
- predefined team roles: Agent

Ordinary developers do not need to memorize the full MCP tool list; let the client choose the tools for the task.

### Example: code review

```text
Use teamSkillHub to find the team Skill and Knowledge relevant to this code review.
Load only the useful results before starting the review.
```

### Example: project design

```text
Search teamSkillHub Knowledge for the current OTA power-loss recovery design
and use the most relevant result as the basis for the answer.
```

### Example: complex task

```text
Use teamSkillHub discover to find relevant Skills, Knowledge, Prompts, or Agents.
Load only what is needed for the current task.
```

Prefer progressive loading instead of loading all Skills, Knowledge, and resources at once.

## 6. Create a Skill

When a task produces a stable, reusable, verified procedure, turn it into a Skill.

Ask the client to generate a complete `SKILL.md`, review it, and then submit it as a Candidate. For example:

```text
Turn the verified workflow we just completed into a reusable Skill.
Generate the complete SKILL.md first and let me review it.
After confirmation, use teamSkillHub submit_knowledge_candidate with:
- suggested_type=skill
- content=the complete SKILL.md
```

Submission creates a Skill Candidate only. It does not write directly to the formal repository.

## 7. Feed back Knowledge

Knowledge is for current facts such as design details, API behavior, root causes, test conclusions, and project constraints.

### Automatic feedback

When Codex is installed with the setup script, automatic Knowledge candidates are enabled by default. A Candidate is created only when the task contains a meaningful engineering action, verification evidence, and reusable content.

Automatic candidates still require administrator review and are never published directly.

### Manual feedback

For stable, reusable, verified knowledge, use `submit_knowledge_candidate`.

Recommended structure:

```markdown
# Title

## Problem
## Root cause
## Solution
## Verification
## Scope
## Constraints / limitations
```

Example:

```text
Turn the verified conclusion from this task into a Team Skill Hub Knowledge Candidate.
Use the fixed six-section structure and submit it with submit_knowledge_candidate.
Do not include tokens, passwords, customer-sensitive data, or unverified speculation.
```

## 8. Report bad or outdated content

If a Knowledge or Skill result is outdated, incorrect, or low quality, use `submit_feedback` and provide a short, verifiable reason.

If the existing asset is no longer suitable, you can also submit a new Knowledge or Skill Candidate.

## 9. Get administrator approval

After submitting a Candidate, send the **Candidate ID** to the administrator.

Knowledge and Skill use the same main lifecycle:

```text
pending
  -> approved
  -> publishing  (PR/MR created, waiting for merge)
  -> published   (PR/MR merged)
```

Rejected Candidates can be approved again. Failed publication can be retried.

Important:

- `approved` does not mean formally published;
- creating a PR/MR does not mean formally published;
- only a merged PR/MR transitions the Candidate to `published`.

If a Candidate is rejected, the administrator provides a reason. Update the content and resubmit, or ask the administrator to re-approve the existing Candidate when appropriate.

## 10. Permissions and responsibility boundaries

If an expected Repository, Skill, or Knowledge item is missing:

1. verify that you are using the correct Developer API Key;
2. use `get_server_info` to inspect your available capabilities;
3. verify the query terms;
4. contact the administrator if the asset is still missing.

Do not work around access controls by asking for repository write credentials, server access, or administrator credentials.

Repository sync, rollback, publishing configuration, lifecycle governance, and Evaluation are administrator or platform-maintainer responsibilities, not ordinary developer tasks.

## 11. Common problems

### teamSkillHub is missing from `codex mcp list`

Check that `~/.codex/config.toml` contains the `teamSkillHub` configuration, then restart Codex.

### Authentication fails

Verify that the process starting the client has:

```bash
TEAM_SKILL_HUB_API_KEY
```

Do not print the real key.

### MCP is configured but unreachable

Verify that your machine can reach the MCP URL supplied by the administrator. Connect to the company network or VPN first if required.

### Knowledge or Skill cannot be found

Try a more specific task description and better keywords. If the asset is still missing, send the query and expected asset name to the administrator to check access or content state.

### Automatic Knowledge Candidate was not created

Automatic candidates are intentionally selective and are not created for every session.

If the content should be preserved, submit it manually with `submit_knowledge_candidate`.

### The setup component needs an upgrade

If an administrator tells you the client integration is outdated:

```bash
bash scripts/setup-codex-mcp.sh --upgrade
```

PowerShell:

```powershell
.\scripts\setup-codex-mcp.ps1 -Upgrade
```

Restart Codex after the upgrade.

## 12. Safe usage principles

- Keep the Developer API Key in an environment variable or approved secret store.
- Do not submit API keys, tokens, passwords, or customer-sensitive data to Team Skill Hub.
- Do not submit unverified speculation as Knowledge.
- Team MCP guidance does not bypass code review, security policy, or release controls.
- Review and verify AI-generated code and commands before execution.

For ordinary developers, the main workflow is simple: **connect MCP -> use team assets -> complete and verify the task -> submit a Knowledge / Skill Candidate when useful -> send the Candidate ID to an administrator for approval.**
