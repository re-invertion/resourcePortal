#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

runtime_dir="$repo_root/var/codespaces"
runtime_env="$runtime_dir/runtime.env"
log_dir="$runtime_dir/logs"
pid_dir="$runtime_dir/pids"

if [[ ! -f "$runtime_env" ]]; then
  bash "$repo_root/scripts/codespace-setup.sh"
fi

set -a
# shellcheck disable=SC1090
source "$runtime_env"
set +a

mkdir -p "$log_dir" "$pid_dir" "$RESOURCE_SECRET_STORAGE_ROOT" "$RESOURCE_STORAGE_ROOT" "$RESOURCE_PORTAL_BACKUP_DIR"

compose() {
  docker compose --env-file "$runtime_env" "$@"
}

start_background() {
  local name="$1"
  shift
  local pid_file="$pid_dir/$name.pid"
  local log_file="$log_dir/$name.log"

  if [[ -f "$pid_file" ]]; then
    local existing_pid
    existing_pid="$(cat "$pid_file")"
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "$name already running (pid $existing_pid)"
      return 0
    fi
    rm -f "$pid_file"
  fi

  nohup "$@" >"$log_file" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" > "$pid_file"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name failed to start; last log lines:" >&2
    tail -n 80 "$log_file" >&2 || true
    return 1
  fi
  echo "$name started (pid $pid)"
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local log_file="$3"
  for _ in $(seq 1 90); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$name did not become ready at $url; last log lines:" >&2
  tail -n 100 "$log_file" >&2 || true
  return 1
}

echo "Starting PostgreSQL..."
compose up -d postgres
postgres_ready=0
for _ in $(seq 1 60); do
  if compose exec -T postgres pg_isready -U resource_portal -d resource_portal >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  sleep 1
done
if [[ "$postgres_ready" -ne 1 ]]; then
  compose logs postgres >&2 || true
  echo "PostgreSQL did not become ready" >&2
  exit 1
fi

npm exec --workspace @resource-portal/api -- prisma migrate deploy
npm run api:db:seed

(
  cd "$repo_root/packages/resourceportal-api"
  node --input-type=module <<'EOF_NODE'
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const id = process.env.RESOURCE_PORTAL_DEV_USER_ID;
if (!id) throw new Error("RESOURCE_PORTAL_DEV_USER_ID is required");

await prisma.user.upsert({
  where: { id },
  update: {
    email: "codespace-admin@resourceportal.local",
    displayName: "Codespaces Admin",
    status: "Active",
  },
  create: {
    id,
    email: "codespace-admin@resourceportal.local",
    displayName: "Codespaces Admin",
    status: "Active",
  },
});

await prisma.$disconnect();
EOF_NODE
)

swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
if [[ "$swarm_state" != "active" ]]; then
  docker swarm init >"$log_dir/swarm-init.log" 2>&1 || true
fi
swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"

start_background api npm run api:start
wait_for_url "ResourcePortal API" "http://127.0.0.1:3000/api/health" "$log_dir/api.log"

seed_response="$runtime_dir/tenants.json"
curl --fail --silent --show-error \
  -H "x-dev-user-id: $RESOURCE_PORTAL_DEV_USER_ID" \
  "http://127.0.0.1:3000/api/tenants" > "$seed_response"

tenant_id="$(node - "$seed_response" <<'EOF_NODE'
const fs = require("node:fs");
const tenants = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const tenant = Array.isArray(tenants) ? tenants.find((item) => item?.name === "codespace-demo") : undefined;
process.stdout.write(tenant?.id ?? "");
EOF_NODE
)"

if [[ -z "$tenant_id" ]]; then
  curl --fail --silent --show-error \
    -X POST \
    -H "content-type: application/json" \
    -H "x-dev-user-id: $RESOURCE_PORTAL_DEV_USER_ID" \
    --data '{"name":"codespace-demo","displayName":"Codespaces Demo","description":"Local preview tenant created automatically by GitHub Codespaces.","contactEmail":"codespace-admin@resourceportal.local"}' \
    "http://127.0.0.1:3000/api/tenants" > "$runtime_dir/tenant-created.json"
  tenant_id="$(node - "$runtime_dir/tenant-created.json" <<'EOF_NODE'
const fs = require("node:fs");
const tenant = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(tenant.id ?? "");
EOF_NODE
)"

  curl --fail --silent --show-error \
    -X PATCH \
    -H "content-type: application/json" \
    -H "x-dev-user-id: $RESOURCE_PORTAL_DEV_USER_ID" \
    --data '{"cpu":4,"memoryBytes":4294967296,"gpu":0,"storageBytes":10737418240,"maxSingleApps":20,"maxVolumes":10}' \
    "http://127.0.0.1:3000/api/tenants/$tenant_id/quota" >/dev/null

  curl --fail --silent --show-error \
    -X POST \
    -H "content-type: application/json" \
    -H "x-dev-user-id: $RESOURCE_PORTAL_DEV_USER_ID" \
    --data '{"amount":1000,"reference":"Codespaces demo credit"}' \
    "http://127.0.0.1:3000/api/tenants/$tenant_id/billing/top-up" >/dev/null
fi

start_background operations-worker npm --workspace @resource-portal/api run worker:operations
if [[ "$swarm_state" == "active" ]]; then
  start_background deployment-worker npm run api:worker:deployments
else
  echo "Docker Swarm could not be initialized; deployment execution is disabled in this Codespace." >&2
fi

start_background web env HOST=0.0.0.0 PORT=5173 npm --workspace @resource-portal/web run dev
wait_for_url "ResourcePortal Web Console" "http://127.0.0.1:5173/health" "$log_dir/web.log"

if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  preview_url="https://${CODESPACE_NAME}-5173.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  preview_url="http://127.0.0.1:5173"
fi

cat <<EOF_STATUS

ResourcePortal Codespaces preview is ready.
Web Console: $preview_url
Demo user: Codespaces Admin ($RESOURCE_PORTAL_DEV_USER_ID)
Demo tenant: codespace-demo ($tenant_id)
Auth mode: development header injection; production OIDC/ZITADEL is intentionally not enabled.
Logs: $log_dir
EOF_STATUS
