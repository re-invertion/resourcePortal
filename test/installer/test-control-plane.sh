#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/acme.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/secrets.sh"
source "$repo_root/scripts/installer/lifecycle.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
contains(){ local t="$1" n="$2" name="$3"; [[ "$t" == *"$n"* ]] && pass "$name" || fail "$name"; }
not_contains(){ local t="$1" n="$2" name="$3"; [[ "$t" != *"$n"* ]] && pass "$name" || fail "$name"; }
status(){ local expected="$1" name="$2"; shift 2; set +e; "$@" >/tmp/rp-cp.out 2>/tmp/rp-cp.err; local actual=$?; set -e; [[ "$actual" == "$expected" ]] && pass "$name" || fail "$name"; }

export RP_CFG_API_IMAGE='ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export RP_CFG_WEB_IMAGE='ghcr.io/re-invertion/resourceportal-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export RP_CFG_POSTGRES_IMAGE='postgres:17-alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
export RP_CFG_ZITADEL_IMAGE='ghcr.io/zitadel/zitadel:v4.0.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
export RP_CFG_TRAEFIK_IMAGE='traefik:v3.5@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export RP_CFG_DOMAIN='rp.example.com'
export RP_CFG_ZITADEL_DOMAIN='auth.rp.example.com'
export RP_CFG_INGRESS_ADDRESSES='203.0.113.10'
export RP_CFG_ACME_EMAIL='admin@example.com'
export RP_CFG_ACME_ENVIRONMENT='production'
export RP_CFG_COOKIE_SWARM_REF='rp_cookie_secret_0123456789abcdef'
export RP_CFG_WORKER_SWARM_REF='rp_internal_worker_token_0123456789abcdef'
export RP_CFG_PLATFORM_ADMIN_IDS='zitadel-user-1'
export RP_CFG_OIDC_CLIENT_ID='zitadel-client-123'
export RP_CFG_OIDC_SWARM_REF='rp_oidc_client_secret_v42'
export RP_CFG_ZITADEL_KEY_SWARM_REF='zitadel_masterkey_deadbeefcafebabe'
export RP_CFG_STACK_NAME='resourceportal-control-plane'

bootstrap="$(rp_render_stack bootstrap)"
ingress="$(rp_render_stack ingress)"
final="$(rp_render_stack final)"

contains "$bootstrap" 'replicas: 0 # RP_API_REPLICAS' 'bootstrap gates API'
contains "$bootstrap" 'replicas: 0 # RP_WEB_REPLICAS' 'bootstrap gates Web'
contains "$bootstrap" 'replicas: 0 # RP_DEPLOYMENT_WORKER_REPLICAS' 'bootstrap gates deployment worker'
contains "$bootstrap" 'replicas: 0 # RP_OPERATION_WORKER_REPLICAS' 'bootstrap gates operation worker'
contains "$bootstrap" 'replicas: 0 # RP_TRAEFIK_REPLICAS' 'bootstrap gates Traefik before domain/ACME'
contains "$bootstrap" 'replicas: 1 # RP_POSTGRES_RP_REPLICAS' 'bootstrap starts RP PostgreSQL'
contains "$bootstrap" 'replicas: 1 # RP_POSTGRES_ZITADEL_REPLICAS' 'bootstrap starts ZITADEL PostgreSQL'
contains "$bootstrap" 'replicas: 1 # RP_ZITADEL_REPLICAS' 'bootstrap starts ZITADEL'

contains "$ingress" 'replicas: 1 # RP_TRAEFIK_REPLICAS' 'ingress state enables Traefik for ACME'
contains "$ingress" 'replicas: 0 # RP_API_REPLICAS' 'ingress state still gates API'
contains "$ingress" 'replicas: 0 # RP_WEB_REPLICAS' 'ingress state still gates Web'
contains "$ingress" 'replicas: 1 # RP_ZITADEL_REPLICAS' 'ingress state keeps ZITADEL available'
contains "$ingress" 'traefik.swarm.network=resourceportal-control-plane_rp-ingress' 'ZITADEL pins Traefik to ingress network'

# Resume can reach ingress with bootstrap already checkpointed. Ingress must
# therefore ensure the Traefik ACME bind source exists immediately before the
# stack enables the Traefik replica.
ingress_prepare_log="$(mktemp /tmp/rp-ingress-prepare.XXXXXX)"
original_ingress_deploy="$(declare -f rp_deploy_control_plane)"
rp_validate_domain_dns(){ return 0; }
mountpoint(){ printf 'mountpoint:%s\n' "$*" >>"$ingress_prepare_log"; return 0; }
install(){ printf 'install:%s\n' "$*" >>"$ingress_prepare_log"; }
rp_deploy_control_plane(){ printf 'deploy:%s\n' "$1" >>"$ingress_prepare_log"; }
rp_acme_restore_cached_state(){ return 0; }
rp_wait_for_acme_certificate(){ printf 'cert:%s:%s\n' "$1" "$2" >>"$ingress_prepare_log"; return 0; }
rp_acme_cache_active_state(){ printf 'cache\n' >>"$ingress_prepare_log"; return 0; }
rp_wait_for_https_origin(){ printf 'origin:%s\n' "$1" >>"$ingress_prepare_log"; return 0; }
rp_primary_enable_ingress
rp_primary_deploy_final
prepare_text="$(cat "$ingress_prepare_log")"
contains "$prepare_text" 'install:-d -m 0700 /mnt/resourceportal/platform/traefik' 'ingress prepares Traefik ACME state directory on resume'
first_prepare="$(sed -n '1p' "$ingress_prepare_log")"
platform_prepare_line="$(grep -nF 'install:-d -m 0700 /mnt/resourceportal/platform/traefik' "$ingress_prepare_log" | head -n1 | cut -d: -f1)"
ingress_deploy_line="$(grep -nF 'deploy:ingress' "$ingress_prepare_log" | head -n1 | cut -d: -f1)"
[[ "$first_prepare" == 'mountpoint:-q /mnt/resourceportal/platform' ]] && pass 'ingress verifies platform mount before Traefik state' || fail 'ingress verifies platform mount before Traefik state'
[[ -n "$platform_prepare_line" && -n "$ingress_deploy_line" && "$platform_prepare_line" -lt "$ingress_deploy_line" ]] && pass 'Traefik state directory is prepared before ingress deploy' || fail 'Traefik state directory is prepared before ingress deploy'
contains "$prepare_text" 'cert:auth.rp.example.com:staging' 'ingress validates ZITADEL ACME challenge with staging'
not_contains "$(sed -n '/deploy:ingress/,/deploy:final/p' "$ingress_prepare_log")" 'cert:rp.example.com' 'ingress does not wait for Web certificate before Web is enabled'
order_tail="$(grep -E '^(deploy|cert|origin|cache)' "$ingress_prepare_log")"
expected_order=$'deploy:ingress\ncert:auth.rp.example.com:staging\ndeploy:final\ncert:auth.rp.example.com:production\ncert:rp.example.com:production\norigin:rp.example.com\ncache'
[[ "$order_tail" == "$expected_order" ]] && pass 'certificate and health checks follow service availability' || fail 'certificate and health checks follow service availability'
unset -f rp_validate_domain_dns mountpoint install rp_acme_restore_cached_state rp_wait_for_acme_certificate rp_acme_cache_active_state rp_wait_for_https_origin
eval "$original_ingress_deploy"
rm -f "$ingress_prepare_log"

contains "$final" 'replicas: 1 # RP_API_REPLICAS' 'final enables API'
contains "$final" 'replicas: 1 # RP_WEB_REPLICAS' 'final enables Web'
contains "$final" 'replicas: 1 # RP_DEPLOYMENT_WORKER_REPLICAS' 'final enables deployment worker'
contains "$final" 'replicas: 1 # RP_OPERATION_WORKER_REPLICAS' 'final enables operation worker'
contains "$final" 'replicas: 1 # RP_TRAEFIK_REPLICAS' 'final enables Traefik'

contains "$final" 'DATABASE_URL_FILE: /run/secrets/rp_database_url' 'API consumes DB secret file'
contains "$final" 'RESOURCE_ENCRYPTION_KEY_FILE: /run/secrets/rp_encryption_key' 'API consumes encryption secret file'
contains "$final" 'AUTH_COOKIE_SECRET_FILE: /run/secrets/rp_cookie_secret' 'API consumes cookie secret file'
contains "$final" 'INTERNAL_WORKER_TOKEN_FILE: /run/secrets/rp_internal_worker_token' 'workers consume token secret file'
contains "$final" '--masterkeyFile' 'ZITADEL uses masterkey file'
contains "$final" '/run/secrets/zitadel_masterkey' 'ZITADEL masterkey comes from Swarm Secret'
contains "$final" 'source: /mnt/resourceportal/platform/zitadel-bootstrap' 'ZITADEL bootstrap PAT source uses platform storage'
contains "$final" 'target: /zitadel/bootstrap' 'ZITADEL bootstrap PAT path is mounted for start-from-init'
lifecycle_source="$(cat "$repo_root/scripts/installer/lifecycle.sh")"
contains "$lifecycle_source" 'rp_prepare_zitadel_bootstrap_dir' 'bootstrap prepares writable ZITADEL PAT directory'
contains "$final" 'name: zitadel_masterkey_deadbeefcafebabe' 'stack aliases versioned ZITADEL masterkey secret'
contains "$final" 'POSTGRES_PASSWORD_FILE: /run/secrets/rp_postgres_password' 'RP postgres uses password file'
contains "$final" 'POSTGRES_PASSWORD_FILE: /run/secrets/zitadel_postgres_password' 'ZITADEL postgres uses password file'

not_contains "$final" 'POSTGRES_PASSWORD:' 'stack never embeds postgres password env'
not_contains "$final" 'ZITADEL_MASTERKEY=' 'stack never embeds ZITADEL masterkey'
not_contains "$final" 'INTERNAL_WORKER_TOKEN: ' 'stack never embeds worker token plaintext'
not_contains "$final" '5432:5432' 'PostgreSQL is not published'

contains "$final" 'node.labels.resourceportal.storage.platform == true' 'stateful platform services require platform storage'
contains "$final" 'node.labels.resourceportal.storage.authoritative == true' 'operation worker requires authoritative storage host'
contains "$final" 'node.role == manager' 'control plane requires managers'
contains "$final" 'node.labels.resourceportal.ingress == true' 'Traefik requires ingress opt-in'
contains "$final" 'Host(`rp.example.com`)' 'Web router uses production domain'
contains "$final" 'Host(`auth.rp.example.com`)' 'ZITADEL router uses separate auth domain'
contains "$final" 'OIDC_ISSUER_URL: https://auth.rp.example.com' 'API issuer uses auth domain'
contains "$final" 'OIDC_CLIENT_ID: zitadel-client-123' 'stack uses generated ZITADEL client id'
contains "$final" 'OIDC_AUDIENCE: zitadel-client-123' 'stack audience follows generated client id'
contains "$final" 'name: rp_oidc_client_secret_v42' 'stack aliases versioned OIDC client secret'
contains "$final" 'traefik.http.services.resourceportal-web.loadbalancer.server.port=5173' 'Web router targets SSR port'
contains "$final" 'traefik.http.services.resourceportal-zitadel.loadbalancer.server.port=8080' 'ZITADEL router targets identity port'
contains "$final" 'RESOURCE_VOLUME_RUNTIME_ROOT: /mnt/resourceportal/volumes' 'runtime volume root is canonical'
contains "$final" 'RESOURCE_SECRET_RUNTIME_ROOT: /mnt/resourceportal/secrets' 'runtime secret root is canonical'
contains "$final" 'RESOURCE_PLATFORM_RUNTIME_ROOT: /mnt/resourceportal/platform' 'runtime platform root is canonical'

status 0 'accept exact digest API image' rp_validate_image_ref "$RP_CFG_API_IMAGE"
status 1 'reject mutable latest image' rp_validate_image_ref 'ghcr.io/re-invertion/resourceportal-api:latest'
status 1 'reject short digest' rp_validate_image_ref 'ghcr.io/re-invertion/resourceportal-api@sha256:abc'

# Deployment must fail closed when rendering or Docker rejects the stack.
original_render_stack="$(declare -f rp_render_stack)"
original_docker="$(declare -f docker 2>/dev/null || true)"
rp_render_stack(){ return 1; }
docker(){ return 0; }
status 1 'control-plane deploy fails when stack rendering fails' rp_deploy_control_plane bootstrap
eval "$original_render_stack"
docker(){
  if [[ "$1 $2" == 'stack config' ]]; then return 0; fi
  if [[ "$1 $2" == 'stack deploy' ]]; then return 1; fi
  return 0
}
status 1 'control-plane deploy fails when docker stack deploy fails' rp_deploy_control_plane bootstrap
eval "$original_render_stack"
if [[ -n "$original_docker" ]]; then eval "$original_docker"; else unset -f docker; fi

control_source="$(cat "$repo_root/scripts/installer/control-plane.sh")"
contains "$control_source" 'export DATABASE_URL="$(cat /run/secrets/rp_database_url)"' 'migration reads database URL from Swarm Secret'
migration_source="$(sed -n '/rp_run_migrations()/,/^}/p' "$repo_root/scripts/installer/control-plane.sh")"
contains "$migration_source" '--detach' 'migration one-shot service is created detached before explicit polling'
contains "$migration_source" 'node dist/src/prisma/seed.js' 'migration one-shot seeds required RBAC roles after schema migration'
dockerfile_source="$(cat "$repo_root/Dockerfile")"
contains "$dockerfile_source" 'COPY --chown=node:node --from=production-dependencies /app/node_modules /app/node_modules' 'runtime node user can prepare Prisma migration engines'
not_contains "$final" 'mode: replicated-job' 'stack avoids unsupported DR job mode'
not_contains "$final" 'condition: on-failure' 'long-running stack services restart after clean task exit'


contains "$final" '/usr/local/bin/resourceportal-postgres-fence' 'RP PostgreSQL starts through storage fencing wrapper'
contains "$final" 'RP_POSTGRES_FENCE_NAME: resourceportal-postgres' 'RP PostgreSQL has distinct fencing lock name'
contains "$final" 'RP_POSTGRES_FENCE_NAME: zitadel-postgres' 'ZITADEL PostgreSQL has distinct fencing lock name'
contains "$final" '/mnt/resourceportal/platform/fencing' 'PostgreSQL fencing state lives on authoritative platform storage'
control_template="$(cat "$repo_root/config/production/stack.yml.tpl")"
contains "$control_template" 'source: postgres_fence_script' 'stack ships PostgreSQL fencing wrapper as config'


rp_pg_block="$(awk '/^  postgres-rp:/{flag=1} /^  postgres-zitadel:/{if(flag){exit}} flag' <<<"$final")"
zitadel_pg_block="$(awk '/^  postgres-zitadel:/{flag=1} /^  zitadel:/{if(flag){exit}} flag' <<<"$final")"
contains "$rp_pg_block" 'node.labels.resourceportal.storage.platform == true' 'RP PostgreSQL can run on any platform-storage manager'
not_contains "$rp_pg_block" 'resourceportal.storage.authoritative' 'RP PostgreSQL is not pinned to authoritative storage host'
not_contains "$rp_pg_block" 'postgres-rp-writer' 'RP PostgreSQL no longer relies on static writer label'
contains "$zitadel_pg_block" 'node.labels.resourceportal.storage.platform == true' 'ZITADEL PostgreSQL can run on any platform-storage manager'
not_contains "$zitadel_pg_block" 'resourceportal.storage.authoritative' 'ZITADEL PostgreSQL is not pinned to authoritative storage host'
not_contains "$zitadel_pg_block" 'postgres-zitadel-writer' 'ZITADEL PostgreSQL no longer relies on static writer label'


contains "$final" 'name: rp_cookie_secret_' 'stack aliases versioned cookie secret'
contains "$final" 'name: rp_internal_worker_token_' 'stack aliases versioned internal worker token'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All control-plane installer tests passed.\n'
