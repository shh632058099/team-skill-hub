# Disaster Recovery

## Recovery objectives

The Hub is designed so Git remains the durable source of Skills, Knowledge, Prompts, Agents, Tools, and Evaluation suites. `DATA_DIR` contains runtime state, indexes, observability, reviews, and generated metadata that should be backed up separately.

## Failure classes

### Service/container loss

Recreate the container/image, restore configuration/secrets, mount the existing `DATA_DIR`, and start normally.

### DATA_DIR loss/corruption

1. Stop the service.
2. Verify the latest backup with `npm run restore:data -- --verify-only`.
3. Restore the backup.
4. Start the service.
5. Resync configured repositories.
6. Validate health and Evaluation.

### Repository snapshot/index loss

If Git credentials and remote repositories remain available, resync repositories. The validated revision/snapshot process rebuilds active assets and indexes from Git.

### GitLab unavailable

Read/search operations can continue from the last validated active revision. Publishing new Candidate MRs and remote syncs will fail until GitLab recovers. Do not discard the last known good revision.

## Recovery order

~~~tex
configuration + secrets
 -> service runtime
 -> DATA_DIR restore
 -> repository connectivity
 -> repository resync
 -> health checks
 -> Evaluation
 -> client traffic
~~~

## Required verification

After a recovery, verify:

- liveness and readiness;
- Admin Operational Health and alerts;
- Repository Governance, especially last-good revision and sync lag;
- API-key authentication;
- MCP search/get;
- Review Inbox state;
- one Evaluation suite per critical repository.

## Practice

Perform restore drills using a disposable directory/host. A backup that has never passed `--verify-only` plus a real restore drill should not be treated as a proven DR backup.
