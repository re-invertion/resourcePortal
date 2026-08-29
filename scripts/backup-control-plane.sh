#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

BACKUP_ROOT="${RESOURCE_PORTAL_BACKUP_DIR:-./backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT%/}/resource-portal-${TIMESTAMP}"
DB_DUMP="${BACKUP_DIR}/resource-portal.dump"
CONFIG_ARCHIVE="${BACKUP_DIR}/config.tar.gz"
MANIFEST="${BACKUP_DIR}/manifest.sha256"

mkdir -p "$BACKUP_DIR"

pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$DB_DUMP"

# The DB dump contains control-plane state, encrypted session/registry/secret
# payloads, and all secret metadata. Plaintext secrets are not exported.
if [[ -d config ]]; then
  tar -czf "$CONFIG_ARCHIVE" config
fi

(
  cd "$BACKUP_DIR"
  sha256sum resource-portal.dump > "$(basename "$MANIFEST")"
  if [[ -f config.tar.gz ]]; then
    sha256sum config.tar.gz >> "$(basename "$MANIFEST")"
  fi
)

cat > "${BACKUP_DIR}/metadata.txt" <<EOF
created_at=${TIMESTAMP}
format=postgres-custom
contains_encrypted_secret_metadata=true
config_archive=$([[ -f "$CONFIG_ARCHIVE" ]] && echo true || echo false)
EOF

printf 'Backup created: %s\n' "$BACKUP_DIR"
