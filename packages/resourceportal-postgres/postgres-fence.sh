#!/usr/bin/env bash
set -euo pipefail

lock_root="${RP_POSTGRES_FENCE_ROOT:-/mnt/resourceportal/platform/fencing}"
lock_name="${RP_POSTGRES_FENCE_NAME:?RP_POSTGRES_FENCE_NAME is required}"
mkdir -p "$lock_root"
lock_file="$lock_root/${lock_name}.lock"
exec 9>"$lock_file"

# Fail closed: only one writer may hold the authoritative storage lock.
if ! flock -n 9; then
  printf 'ResourcePortal PostgreSQL writer fence is already held: %s\n' "$lock_file" >&2
  exit 73
fi


exec /usr/local/bin/docker-entrypoint.sh "$@"
