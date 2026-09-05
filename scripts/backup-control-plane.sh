#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_ROOT="${RESOURCE_PORTAL_BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT%/}/resource-portal-${TIMESTAMP}"
DB_DUMP="${BACKUP_DIR}/resource-portal.dump"
CONFIG_ARCHIVE="${BACKUP_DIR}/config.tar.gz"
SECRET_ARCHIVE="${BACKUP_DIR}/secrets.tar.gz"
MANIFEST="${BACKUP_DIR}/manifest.sha256"
SECRET_STORAGE_ROOT="$(realpath -m "${RESOURCE_STORAGE_BASE_PATH:-/srv/resource-portal/storage}/secrets")"

if [[ "$SECRET_STORAGE_ROOT" == "/" ]]; then
  echo "Refusing to use / as RESOURCE_STORAGE_BASE_PATH-derived Secret storage path." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

BACKUP_DIR_REAL="$(realpath "$BACKUP_DIR")"
if [[ "$BACKUP_DIR_REAL" == "$SECRET_STORAGE_ROOT" || "$BACKUP_DIR_REAL" == "$SECRET_STORAGE_ROOT"/* ]]; then
  echo "Backup directory must not be inside RESOURCE_STORAGE_BASE_PATH-derived Secret storage path." >&2
  exit 2
fi

pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$DB_DUMP"

# The DB dump contains control-plane state, encrypted session/registry payloads,
# and Secret metadata. AppGroup Secret payloads stay encrypted in the archive;
# plaintext secrets are never exported.
if [[ -d config ]]; then
  tar -czf "$CONFIG_ARCHIVE" config
fi

if [[ -d "$SECRET_STORAGE_ROOT" ]]; then
  tar -C "$SECRET_STORAGE_ROOT" -czf "$SECRET_ARCHIVE" .
fi

(
  cd "$BACKUP_DIR"
  sha256sum resource-portal.dump > "$(basename "$MANIFEST")"
  if [[ -f config.tar.gz ]]; then
    sha256sum config.tar.gz >> "$(basename "$MANIFEST")"
  fi
  if [[ -f secrets.tar.gz ]]; then
    sha256sum secrets.tar.gz >> "$(basename "$MANIFEST")"
  fi
)

cat > "${BACKUP_DIR}/metadata.txt" <<EOF
created_at=${TIMESTAMP}
format=postgres-custom
contains_encrypted_secret_metadata=true
config_archive=$([[ -f "$CONFIG_ARCHIVE" ]] && echo true || echo false)
secret_archive=$([[ -f "$SECRET_ARCHIVE" ]] && echo true || echo false)
EOF

printf 'Backup created: %s\n' "$BACKUP_DIR"
