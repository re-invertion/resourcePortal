#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${1:?Usage: scripts/restore-control-plane.sh <backup-directory>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$1"
DB_DUMP="${BACKUP_DIR%/}/resource-portal.dump"
MANIFEST="${BACKUP_DIR%/}/manifest.sha256"
SECRET_ARCHIVE="${BACKUP_DIR%/}/secrets.tar.gz"
SECRET_STORAGE_ROOT="$(realpath -m "${RESOURCE_SECRET_STORAGE_ROOT:-/rp/secrets}")"

if [[ "$SECRET_STORAGE_ROOT" == "/" ]]; then
  echo "Refusing to use / as RESOURCE_SECRET_STORAGE_ROOT." >&2
  exit 2
fi

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

if [[ -f "$SECRET_ARCHIVE" ]]; then
  if tar -tzf "$SECRET_ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    echo "Refusing unsafe paths in encrypted Secret payload archive." >&2
    exit 2
  fi
  mkdir -p -m 700 "$SECRET_STORAGE_ROOT"
  tar -xzf "$SECRET_ARCHIVE" -C "$SECRET_STORAGE_ROOT"
else
  printf 'Warning: backup has no encrypted Secret payload archive.\n' >&2
fi

(
  cd "$REPO_ROOT"
  npm exec --workspace @resource-portal/api -- prisma migrate deploy
  npm --workspace @resource-portal/api run dr:reconcile
)

printf 'Restore and post-restore reconciliation completed from: %s\n' "$BACKUP_DIR"
