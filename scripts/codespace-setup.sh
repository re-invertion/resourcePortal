#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

runtime_dir="$repo_root/var/codespaces"
demo_user_id="00000000-0000-4000-8000-000000000001"
mkdir -p "$runtime_dir/logs" "$runtime_dir/pids" "$runtime_dir/secrets" "$runtime_dir/volumes" "$runtime_dir/backups"

cat > "$runtime_dir/runtime.env" <<EOF_ENV
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://resource_portal:resource_portal@127.0.0.1:5433/resource_portal?schema=public
AUTH_MODE=dev
PUBLIC_API_URL=http://127.0.0.1:3000
AUTH_COOKIE_SECURE=false
PLATFORM_ADMIN_USER_IDS=$demo_user_id
RESOURCE_PORTAL_DEV_USER_ID=$demo_user_id
RESOURCE_PORTAL_API_ORIGIN=http://127.0.0.1:3000
RESOURCE_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
RESOURCE_SECRET_STORAGE_ROOT=$runtime_dir/secrets
RESOURCE_PORTAL_BACKUP_DIR=$runtime_dir/backups
RESOURCE_STORAGE_ROOT=$runtime_dir/volumes
INTERNAL_WORKER_TOKEN=codespaces-worker-token
DOCKER_CONTEXT=default
WORKER_ID=codespaces-worker
WORKER_POLL_INTERVAL_MS=2000
STORAGE_REMOTE_VALIDATION_ENABLED=false
ZITADEL_VERSION=stable
ZITADEL_PORT=8080
ZITADEL_MASTERKEY=0123456789abcdef0123456789abcdef
ZITADEL_POSTGRES_ADMIN_PASSWORD=codespaces-zitadel-postgres
EOF_ENV

npm ci
set -a
# shellcheck disable=SC1090
source "$runtime_dir/runtime.env"
set +a
npm run api:prisma:generate

echo "ResourcePortal Codespaces dependencies and runtime configuration are ready."
