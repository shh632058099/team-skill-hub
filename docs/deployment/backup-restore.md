# Backup and Restore

## Scope

The Hub provides deterministic filesystem backup/restore for `DATA_DIR`. Git-managed source repositories remain protected by Git and are not replaced by this backup.

Backups include a schema-versioned manifest containing file path, size, and SHA-256.

## Create a backup

~~~bash
npm run backup:data -- \
  --out /backup/team-skill-hub/2026-09-30 \
  --data-dir ./data
~~~

If `--data-dir` is omitted, `DATA_DIR` or `./data` is used.

The destination:

- must be outside `DATA_DIR`;
- must not already exist;
- refuses symbolic links in the source tree.

## Verify before restore

Always verify first:

~~~bash
npm run restore:data -- \
  --backup /backup/team-skill-hub/2026-09-30 \
  --data-dir ./data \
  --verify-only
~~~

Verification checks the manifest and SHA-256 integrity without replacing data.

## Restore

Stop the Hub before a real restore.

~~~bash
npm run restore:data -- \
  --backup /backup/team-skill-hub/2026-09-30 \
  --data-dir ./data \
  --force
~~~

The restore implementation stages data and preserves the previous data directory when replacement is required. The CLI reports `previousDataDir` when available.

## Post-restore validation

1. Start the service.
2. Check `/health/ready`.
3. Check Admin Operational Health.
4. Confirm repositories and active revisions.
5. Run a representative MCP Skill/Knowledge query.
6. Run relevant Evaluation suites.

## Scheduling

For production, schedule backups outside `DATA_DIR` and copy them to independent storage. Retention of backups should be longer than ordinary JSONL observability retention.
