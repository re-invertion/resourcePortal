#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${1:?Usage: scripts/restore-control-plane.sh <backup-directory>}"

BACKUP_DIR="$1"
DB_DUMP="${BACKUP_DIR%/}/resource-portal.dump"
MANIFEST="${BACKUP_DIR%/}/manifest.sha256"

if [[ "${RESOURCE_PORTAL_RESTORE_CONFIRM:-}" != "resource-portal" ]]; then
  echo "Refusing destructive restore. Set RESOURCE_PORTAL_RESTORE_CONFIRM=resource-portal." >&2
  exit 2
fi

if [[ ! -f "$DB_DUMP" || ! -f "$MANIFEST" ]]; then
  echo "Backup directory is incomplete: expected resource-portal.dump and manifest.sha256" >&2
  exit 2
fi

(
  cd "$BACKUP_DIR"
  sha256sum --check "$(basename "$MANIFEST")"
)

pg_restore \
  --dbname="$DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$DB_DUMP"

if [[ -f "${BACKUP_DIR%/}/config.tar.gz" && "${RESOURCE_PORTAL_RESTORE_CONFIG:-false}" == "true" ]]; then
  tar -xzf "${BACKUP_DIR%/}/config.tar.gz"
fi

printf 'Restore completed from: %s\n' "$BACKUP_DIR"
printf 'Run database migrations and readiness checks before returning traffic.\n'
