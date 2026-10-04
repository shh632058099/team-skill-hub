# Codex Plugin Distribution

## Purpose

Team Skill Hub can be distributed as a portable Agent Plugin for Codex and supported OpenAI plugin surfaces. The package bundles:

- the Team Skill Hub remote MCP connection;
- the Team Skill Hub skill guidance;
- cross-platform lifecycle hooks;
- Hook Runtime and schema version metadata.

Secrets are not embedded in the plugin.

## Build a plugin

Build for a concrete Hub deployment:

~~~bash
npm run plugin:build -- \
  --url https://skill-hub.example.com/mcp \
  --api-key-env TEAM_SKILL_HUB_API_KEY \
  --out dist/plugins/team-skill-hub
~~~

The output contains:

~~~text
team-skill-hub/
  plugin.json
  mcp.json
  skills/
    team-skill-hub/
      SKILL.md
  hooks/
    hooks.json
    team-skill-hub.conf
    team-skill-hub-hook.sh
    team-skill-hub-hook.ps1
~~~

The application version in package.json becomes the plugin version. Hook runtime and Client Event schema versions are written independently from their canonical constants.

## Authentication

The generated mcp.json uses bearer_token_env_var. Only the environment-variable name is stored in the plugin package.

Set the credential before starting Codex:

~~~bash
export TEAM_SKILL_HUB_API_KEY='<api-key>'
~~~

On Windows set the same environment variable through PowerShell or enterprise device management.

## Build a repo marketplace

The builder can create a repository-scoped marketplace and copy the plugin into it:

~~~bash
npm run plugin:build -- \
  --url https://skill-hub.example.com/mcp \
  --marketplace-root ./team-plugin-marketplace \
  --marketplace-name engineering-tools
~~~

This creates:

~~~text
team-plugin-marketplace/
  .agents/plugins/marketplace.json
  plugins/team-skill-hub/
~~~

Add a local marketplace:

~~~bash
codex plugin marketplace add ./team-plugin-marketplace
~~~

For a Git-backed team marketplace, publish that directory to a controlled repository and add the repository URL or owner/repo reference instead.

## Update

1. bump the application semantic version when the plugin package itself changes;
2. update CHANGELOG and migration notes as required;
3. rebuild the plugin against the deployment URL;
4. publish the new marketplace revision/tag;
5. refresh with codex plugin marketplace upgrade.

The standalone setup-codex-mcp.sh and setup-codex-mcp.ps1 installers remain supported for environments that do not use plugin marketplaces.

## Hook trust

Plugin-bundled hooks are not automatically trusted. Users or administrators must review and trust the current hook definition before Codex executes it.

Enterprise environments may instead enforce managed hooks and managed marketplace sources. Required hook scripts must be present in the execution environment.

## Managed rollout

For team rollout:

1. publish the marketplace in a controlled Git repository;
2. pin marketplace ref or commit for staged rollout;
3. configure marketplace sources through system/cloud-managed Codex configuration;
4. distribute the API-key environment variable through the organization secret-management mechanism;
5. validate hook trust policy or managed-hook policy;
6. roll forward by marketplace revision and plugin semantic version;
7. retain the previous plugin revision for rollback.

## Validation

Repository tests validate that the generated package:

- has portable plugin and MCP manifests;
- references the correct Hub URL;
- uses only the API-key environment-variable name;
- includes Unix and Windows Hook commands;
- uses current Hook Runtime / schema versions;
- emits a valid repo marketplace layout;
- never writes the test credential into generated files.

## Upstream references

- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/docs/hooks
