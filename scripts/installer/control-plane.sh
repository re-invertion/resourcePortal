#!/usr/bin/env bash

rp_validate_image_ref() {
  [[ "$1" =~ ^[^[:space:]@]+@sha256:[a-fA-F0-9]{64}$ ]]
}

rp_require_stack_config() {
  local key value
  for key in \
    RP_CFG_API_IMAGE RP_CFG_WEB_IMAGE RP_CFG_POSTGRES_IMAGE RP_CFG_ZITADEL_IMAGE \
    RP_CFG_TRAEFIK_IMAGE RP_CFG_DOMAIN RP_CFG_ZITADEL_DOMAIN RP_CFG_ACME_EMAIL \
    RP_CFG_OIDC_CLIENT_ID RP_CFG_OIDC_SWARM_REF; do
    value="${!key-}"
    [[ -n "$value" ]] || { printf 'Missing stack configuration: %s\n' "$key" >&2; return 1; }
  done
  for key in RP_CFG_API_IMAGE RP_CFG_WEB_IMAGE RP_CFG_POSTGRES_IMAGE RP_CFG_ZITADEL_IMAGE RP_CFG_TRAEFIK_IMAGE; do
    rp_validate_image_ref "${!key}" || { printf 'Image must be pinned by sha256 digest: %s\n' "$key" >&2; return 1; }
  done
}

rp_stack_replica_value() {
  local state="$1" service="$2"
  case "$state:$service" in
    bootstrap:postgres-rp|bootstrap:postgres-zitadel|bootstrap:zitadel) printf '1\n' ;;
    bootstrap:*) printf '0\n' ;;
    ingress:postgres-rp|ingress:postgres-zitadel|ingress:zitadel|ingress:traefik) printf '1\n' ;;
    ingress:*) printf '0\n' ;;
    final:postgres-rp|final:postgres-zitadel|final:zitadel|final:api|final:web|final:deployment-worker|final:operation-worker|final:traefik) printf '1\n' ;;
    final:dr-reconciliation) printf '0\n' ;;
    *) return 1 ;;
  esac
}

rp_escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

rp_render_stack() {
  local state="$1" repo_root template storage_base platform_admin_ids output
  case "$state" in bootstrap|ingress|final) ;; *) return 1 ;; esac
  rp_require_stack_config || return 1
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  template="$repo_root/config/production/stack.yml.tpl"
  [[ -r "$template" ]] || return 1
  storage_base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}"
  platform_admin_ids="${RP_CFG_PLATFORM_ADMIN_IDS:-}"
  output="$(cat "$template")"

  local -a pairs=(
    "POSTGRES_IMAGE|$RP_CFG_POSTGRES_IMAGE"
    "ZITADEL_IMAGE|$RP_CFG_ZITADEL_IMAGE"
    "API_IMAGE|$RP_CFG_API_IMAGE"
    "WEB_IMAGE|$RP_CFG_WEB_IMAGE"
    "TRAEFIK_IMAGE|$RP_CFG_TRAEFIK_IMAGE"
    "DOMAIN|$RP_CFG_DOMAIN"
    "ZITADEL_DOMAIN|$RP_CFG_ZITADEL_DOMAIN"
    "ACME_EMAIL|$RP_CFG_ACME_EMAIL"
    "PLATFORM_ADMIN_IDS|$platform_admin_ids"
    "OIDC_CLIENT_ID|$RP_CFG_OIDC_CLIENT_ID"
    "OIDC_SWARM_REF|$RP_CFG_OIDC_SWARM_REF"
    "STORAGE_BASE_PATH|$storage_base"
    "POSTGRES_RP_REPLICAS|$(rp_stack_replica_value "$state" postgres-rp)"
    "POSTGRES_ZITADEL_REPLICAS|$(rp_stack_replica_value "$state" postgres-zitadel)"
    "ZITADEL_REPLICAS|$(rp_stack_replica_value "$state" zitadel)"
    "API_REPLICAS|$(rp_stack_replica_value "$state" api)"
    "WEB_REPLICAS|$(rp_stack_replica_value "$state" web)"
    "DEPLOYMENT_WORKER_REPLICAS|$(rp_stack_replica_value "$state" deployment-worker)"
    "OPERATION_WORKER_REPLICAS|$(rp_stack_replica_value "$state" operation-worker)"
    "DR_RECONCILIATION_REPLICAS|$(rp_stack_replica_value "$state" dr-reconciliation)"
    "TRAEFIK_REPLICAS|$(rp_stack_replica_value "$state" traefik)"
  )
  local pair key value escaped
  for pair in "${pairs[@]}"; do
    key="${pair%%|*}"; value="${pair#*|}"; escaped="$(rp_escape_sed_replacement "$value")"
    output="$(sed "s|__${key}__|${escaped}|g" <<<"$output")"
  done
  if grep -q '__[A-Z0-9_]*__' <<<"$output"; then
    printf 'Unresolved production stack placeholder.\n' >&2
    return 1
  fi
  printf '%s\n' "$output"
}

rp_write_stack() {
  local state="$1" target="${2:-/etc/resourceportal/stack.yml}" tmp
  tmp="${target}.tmp.$$"
  mkdir -p "$(dirname "$target")"
  rp_render_stack "$state" >"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$target"
}

rp_deploy_control_plane() {
  local state="$1" stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}" stack_file
  stack_file="$(mktemp /tmp/resourceportal-stack.XXXXXX.yml)"
  trap 'rm -f "$stack_file"' RETURN
  rp_render_stack "$state" >"$stack_file"
  docker stack config --compose-file "$stack_file" >/dev/null
  docker stack deploy --compose-file "$stack_file" --with-registry-auth "$stack_name"
  rm -f "$stack_file"
  trap - RETURN
}

rp_run_migrations() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name="${stack_name}-migration-$(date +%s)" timeout="${RP_MIGRATION_TIMEOUT_SECONDS:-300}"
  rp_validate_image_ref "${RP_CFG_API_IMAGE:-}" || return 1
  docker service create \
    --name "$service_name" \
    --restart-condition none \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --network "${stack_name}_rp-control" \
    --secret source=rp_database_url,target=rp_database_url \
    --env NODE_ENV=production \
    --env AUTH_MODE=dev \
    --env DATABASE_URL_FILE=/run/secrets/rp_database_url \
    "$RP_CFG_API_IMAGE" \
    sh -ec 'export DATABASE_URL="$(cat /run/secrets/rp_database_url)"; exec /app/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma' >/dev/null

  local elapsed=0 state
  while (( elapsed < timeout )); do
    state="$(docker service ps --no-trunc --format '{{.CurrentState}}|{{.Error}}' "$service_name" | head -n1)"
    case "$state" in
      Complete*) docker service rm "$service_name" >/dev/null; return 0 ;;
      Failed*|Rejected*) docker service logs "$service_name" >&2 || true; docker service rm "$service_name" >/dev/null; return 1 ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done
  docker service logs "$service_name" >&2 || true
  docker service rm "$service_name" >/dev/null || true
  printf 'ResourcePortal schema migration timed out.\n' >&2
  return 1
}
