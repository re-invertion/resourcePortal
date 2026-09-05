#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/secrets.sh"

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
export RP_CFG_ACME_EMAIL='admin@example.com'
export RP_CFG_PLATFORM_ADMIN_IDS='zitadel-user-1'
export RP_CFG_OIDC_CLIENT_ID='zitadel-client-123'
export RP_CFG_OIDC_SWARM_REF='rp_oidc_client_secret_v42'
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

control_source="$(cat "$repo_root/scripts/installer/control-plane.sh")"
contains "$control_source" 'export DATABASE_URL="$(cat /run/secrets/rp_database_url)"' 'migration reads database URL from Swarm Secret'
not_contains "$final" 'mode: replicated-job' 'stack avoids unsupported DR job mode'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All control-plane installer tests passed.\n'
