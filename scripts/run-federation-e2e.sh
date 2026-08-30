#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/test/federation/docker-compose.yml"
STATE_DIR="$ROOT_DIR/var/federation"
PAT_FILE="$STATE_DIR/zitadel/admin.pat"
API_LOG="$STATE_DIR/api.log"
API_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi

  if [[ $exit_code -ne 0 ]]; then
    echo "=== Resource Portal API log ==="
    cat "$API_LOG" 2>/dev/null || true
    echo "=== Federation containers ==="
    docker compose -f "$COMPOSE_FILE" logs --no-color 2>/dev/null || true
  fi

  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

wait_for_url() {
  local url=$1
  local name=$2
  for _ in $(seq 1 90); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      echo "$name is ready"
      return 0
    fi
    sleep 1
  done
  echo "$name did not become ready: $url" >&2
  return 1
}

start_api() {
  local auth_mode=$1
  : >"$API_LOG"
  (
    cd "$ROOT_DIR"
    AUTH_MODE="$auth_mode" node packages/resourceportal-api/dist/src/main.js
  ) >"$API_LOG" 2>&1 &
  API_PID=$!
  wait_for_url "http://localhost:3000/api/health/live" "Resource Portal API ($auth_mode)"
}

stop_api() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID"
    wait "$API_PID" 2>/dev/null || true
  fi
  API_PID=""
}

cd "$ROOT_DIR"
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR/zitadel"

docker compose -f "$COMPOSE_FILE" up -d
wait_for_url "http://localhost:8080/debug/healthz" "ZITADEL"
wait_for_url "http://localhost:8180/realms/tenant/.well-known/openid-configuration" "Keycloak"

cat >.env <<EOF
NODE_ENV=test
PORT=3000
DATABASE_URL=postgresql://resource_portal:resource_portal@localhost:55432/resource_portal?schema=public
AUTH_MODE=dev
PUBLIC_API_URL=http://localhost:3000
API_RATE_LIMIT_MAX=1000
API_RATE_LIMIT_WINDOW_SECONDS=60
AUTH_SESSION_COOKIE_NAME=rp_session
AUTH_CSRF_COOKIE_NAME=rp_csrf
AUTH_SESSION_TTL_SECONDS=3600
AUTH_SESSION_IDLE_TIMEOUT_SECONDS=1800
AUTH_COOKIE_SECURE=false
AUTH_COOKIE_SECRET=federation-e2e-cookie-secret
OIDC_ISSUER_URL=http://localhost:8080
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_AUDIENCE=
OIDC_PROVIDER_TYPE=zitadel
OIDC_AUTO_PROVISION_USERS=true
OIDC_REDIRECT_URI=http://localhost:3000/api/auth/callback
OIDC_POST_LOGOUT_REDIRECT_URI=http://localhost:3000/api/auth/logout/callback
OIDC_SCOPES=openid profile email offline_access
ZITADEL_ORGANIZATION_ID=
ZITADEL_MANAGEMENT_URL=http://localhost:8080
ZITADEL_BOOTSTRAP_PAT_FILE=$PAT_FILE
ZITADEL_BOOTSTRAP_ORGANIZATION_NAME=Resource Portal
ZITADEL_BOOTSTRAP_PROJECT_NAME=Resource Portal
ZITADEL_BOOTSTRAP_APP_NAME=Resource Portal Federation E2E
ZITADEL_BOOTSTRAP_REDIRECT_URIS=http://localhost:3000/api/auth/callback
ZITADEL_BOOTSTRAP_POST_LOGOUT_REDIRECT_URIS=http://localhost:3000/api/auth/logout/callback
ZITADEL_BOOTSTRAP_TEST_USER_USERNAME=resource-user
ZITADEL_BOOTSTRAP_TEST_USER_EMAIL=resource-user@example.test
ZITADEL_BOOTSTRAP_TEST_USER_PASSWORD=ResourcePass123!
RESOURCE_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
RESOURCE_SECRET_STORAGE_ROOT=$STATE_DIR/secrets
RESOURCE_STORAGE_ROOT=$STATE_DIR/volumes
INTERNAL_WORKER_TOKEN=federation-worker-token
EOF

for _ in $(seq 1 30); do
  [[ -s "$PAT_FILE" ]] && break
  sleep 1
done
[[ -s "$PAT_FILE" ]] || { echo "ZITADEL bootstrap PAT was not created" >&2; exit 1; }

npm --workspace @resource-portal/api run zitadel:bootstrap

set -a
# shellcheck disable=SC1091
source .env
set +a
export ZITADEL_MANAGEMENT_TOKEN="$(tr -d '\r\n' <"$PAT_FILE")"
export FEDERATION_E2E_STATE_FILE="$STATE_DIR/state.json"
export FEDERATION_E2E_API_URL="http://localhost:3000/api"
export FEDERATION_E2E_KEYCLOAK_URL="http://localhost:8180"

(
  cd packages/resourceportal-api
  npx prisma migrate deploy
)
npm run api:db:seed
npm --workspace @resource-portal/api run build

start_api dev
npm --workspace @resource-portal/api exec -- ts-node --files scripts/setup-federation-e2e.ts
stop_api

start_api oidc
node scripts/run-federation-browser-e2e.mjs

echo "Federation E2E completed successfully"
