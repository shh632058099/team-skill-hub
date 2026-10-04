# Release Guide

## Current release model

Team Skill Hub uses immutable application versions plus independently versioned Git-managed content repositories.

Do not couple a Hub binary release to a Skill/Knowledge content merge unless a schema/runtime compatibility change requires it.

## Pre-release checklis

Run:

~~~bash
npm ci
npm run check
npm run release:check
~~~

For critical content repositories:

~~~bash
npm run ci:evaluate -- \
  --path <repository> \
  --baseline-path <baseline-repository-or-checkout>
~~~

Also verify:

- Admin embedded JavaScript parses/loads;
- REST v1/OpenAPI endpoints;
- Client Event schema compatibility;
- backup verification;
- Hook setup/upgrade scripts;
- Repository Governance has no unexplained critical issue.

## Version surfaces

Track separately:

- application/package version;
- REST API major version (`/api/v1`);
- Hook Runtime version;
- Client Event/Hook schema version;
- Evidence schema version;
- Evaluation schema version;
- backup manifest schema version.

A change to one surface does not automatically require changing all others.

## Image/tag flow

The deployment workflow builds on pull requests and publishes the image for the configured main branch/tags. Production should deploy an immutable tag such as:

~~~tex
ghcr.io/<org>/team-skill-hub:vX.Y.Z
~~~

Avoid production deployment from `latest`.

For a tag release, validate the exact tag before push/publish:

~~~bash
npm run release:check -- --tag v0.1.0
~~~

The check requires the tag version to match `package.json`, a matching `CHANGELOG.md` section, a versioned migration note under `docs/migrations/`, and immutable tag/SHA image metadata in the Docker workflow.

## Registry acceptance

After the real Git tag has been built and published by GitHub Actions, validate the registry artifacts themselves:

~~~bash
npm run release:registry-acceptance -- \
  --release-image ghcr.io/<org>/team-skill-hub:v0.1.0 \
  --sha-image ghcr.io/<org>/team-skill-hub:sha-<short-sha> \
  --rollback-image ghcr.io/<org>/team-skill-hub:v0.0.9
~~~

The acceptance harness uses the local Docker client and requires registry authentication when the image is private. It verifies:

- release, SHA, and rollback image references are immutable and can all be pulled;
- the release tag and SHA tag resolve to the same content-addressed Docker image ID;
- every image has registry `RepoDigests` evidence;
- the release image contains the expected application version in `/app/package.json`;
- the rollback image remains independently available.

Passing the repository unit test for this harness does not prove the registry release. The command above must be run against the actual published GHCR images after a real tag build.

## Release evidence

Record:

- commit SHA;
- version/tag;
- build/test result;
- Evaluation result and baseline;
- upgrade/rollback notes;
- known compatibility changes;
- backup verification result.

## Rollback

Keep the previous immutable image available. If a content repository causes a regression, use the Hub's validated revision rollback rather than rewriting Git history.

## Post-release

Verify:

1. live/ready endpoints;
2. Operational Health and Alerts;
3. Repository Governance;
4. representative MCP search/load;
5. Hook Runtime current/outdated distribution;
6. automatic Candidate detector quality trends.
