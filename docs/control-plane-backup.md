# Resource Portal control-plane backup and restore

## Scope

The control-plane database is the source of truth for tenants, resources, deployments, audit entries, billing/quota state, sessions, registry metadata and encrypted secret/session credential payloads. The backup workflow never exports decrypted secret values.

The optional `config.tar.gz` contains the repository `config/` directory. Runtime `.env` files and external encryption keys must be backed up separately by the infrastructure secret-management process and must never be committed to Git.

## Backup

Requirements: PostgreSQL client tools (`pg_dump`, `sha256sum`, `tar`) and `DATABASE_URL`.

```bash
DATABASE_URL='postgresql://...' npm run backup:control-plane
```

Set `RESOURCE_PORTAL_BACKUP_DIR` to choose a destination. Each backup directory contains:

- `resource-portal.dump` — PostgreSQL custom-format dump,
- `config.tar.gz` — configuration files when `config/` exists,
- `manifest.sha256` — integrity hashes,
- `metadata.txt` — backup metadata.

Copy completed backup directories to storage independent from the Resource Portal host.

## Restore

Restore is destructive and therefore requires an explicit confirmation environment variable:

```bash
DATABASE_URL='postgresql://...' \
RESOURCE_PORTAL_RESTORE_CONFIRM=resource-portal \
npm run restore:control-plane -- ./backups/resource-portal-YYYYMMDDTHHMMSSZ
```

The restore script verifies `manifest.sha256` before calling `pg_restore --clean --if-exists --exit-on-error`.

To restore the repository `config/` archive too, add `RESOURCE_PORTAL_RESTORE_CONFIG=true`.

## After restore

1. Ensure the same `RESOURCE_ENCRYPTION_KEY` used by the backed-up database is available. Without it encrypted session, registry and secret payloads cannot be decrypted.
2. Run the current database migrations.
3. Start the API and workers.
4. Verify `/api/health/ready` before returning traffic.
5. Inspect deployments and runtime state for drift. Full automatic disaster-recovery reconciliation is a separate subsystem and is not provided by these scripts.

## Operational policy

Backups should be run on a schedule by infrastructure automation and retained according to the deployment's retention policy. Restore drills should be performed against an isolated database periodically; successful backup creation alone does not prove recoverability.
