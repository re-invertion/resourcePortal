#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/acme.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/identity.sh"
source "$repo_root/scripts/installer/config.sh"
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
export RP_CFG_OIDC_CLI_CLIENT_ID='zitadel-cli-client-789'
export RP_CFG_OIDC_SWARM_REF='rp_oidc_client_secret_v42'
export RP_CFG_ZITADEL_KEY_SWARM_REF='zitadel_masterkey_deadbeefcafebabe'
export RP_CFG_ZITADEL_ORGANIZATION_ID='zitadel-org-123'
export RP_CFG_ZITADEL_PROJECT_ID='zitadel-project-456'
export RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_feedfacefeedface'
export RP_CFG_STACK_NAME='resourceportal-control-plane'
export RP_CFG_STORAGE_DEVICE='/dev/sdb'
export RP_CFG_SWARM_ADVERTISE_ADDR='10.20.0.10'
export RP_CFG_STORAGE_SERVER_ADDRESS='10.20.0.10'
export RP_CFG_CLUSTER_CIDR='10.20.0.0/24'
export RP_CFG_RELEASE_VERSION='0.2.0'

bootstrap="$(rp_render_stack bootstrap)"
ingress="$(rp_render_stack ingress)"
final="$(rp_render_stack final)"

contains "$bootstrap" 'replicas: 0 # RP_API_REPLICAS' 'bootstrap gates API'
contains "$bootstrap" 'replicas: 0 # RP_WEB_REPLICAS' 'bootstrap gates Web'
contains "$bootstrap" 'replicas: 0 # RP_WORKER_REPLICAS' 'bootstrap gates worker'
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
contains "$final" 'replicas: 1 # RP_WORKER_REPLICAS' 'final enables worker'
contains "$final" 'replicas: 1 # RP_TRAEFIK_REPLICAS' 'final enables Traefik'
not_contains "$final" 'rp-legacy-portal' 'legacy portal redirect is absent when no legacy domain is configured'
not_contains "$final" 'rp-legacy-auth' 'legacy auth redirect is absent when no legacy auth domain is configured'
export RP_CFG_LEGACY_DOMAIN='portal.rp.example.com'
export RP_CFG_LEGACY_ZITADEL_DOMAIN='auth.portal.rp.example.com'
legacy_final="$(rp_render_stack final)"
contains "$legacy_final" 'Host(`portal.rp.example.com`)' 'legacy portal router uses configured previous domain'
contains "$legacy_final" 'redirectregex.regex=^https?://portal\.rp\.example\.com/(.*)' 'legacy portal redirect treats hostname dots literally'
contains "$legacy_final" 'redirectregex.replacement=https://rp.example.com/$${1}' 'legacy portal redirect targets current ResourcePortal domain'
contains "$legacy_final" 'Host(`auth.portal.rp.example.com`)' 'legacy auth router uses configured previous auth domain'
contains "$legacy_final" 'redirectregex.regex=^https?://auth\.portal\.rp\.example\.com/(.*)' 'legacy auth redirect treats hostname dots literally'
contains "$legacy_final" 'redirectregex.replacement=https://auth.rp.example.com/$${1}' 'legacy auth redirect targets current ZITADEL domain'
contains "$legacy_final" 'traefik.http.routers.rp-legacy-auth-https.tls.certresolver=letsencrypt' 'legacy auth HTTPS redirect uses active ACME resolver'
unset RP_CFG_LEGACY_DOMAIN RP_CFG_LEGACY_ZITADEL_DOMAIN
contains "$final" 'AUTH_MODE: zitadel' 'production API uses Zitadel/OIDC auth'
contains "$final" 'RP_OIDC_EXTRA_CA_B64: ""' 'production API does not add staging CA trust'
contains "$final" 'if [ -n "$${RP_OIDC_EXTRA_CA_B64:-}" ]; then' 'API starts with conditional extra-CA bootstrap only'
contains "$final" 'API_TRUST_PROXY_HOPS: "1"' 'production API trusts exactly one reverse-proxy hop'
contains "$final" 'API_RATE_LIMIT_MAX: "300"' 'production API has an explicit shared rate limit'
contains "$final" 'API_RATE_LIMIT_WINDOW_SECONDS: "60"' 'production API has an explicit rate-limit window'
contains "$final" '--entrypoints.websecure.forwardedheaders.insecure=false' 'Traefik does not trust client-supplied forwarded headers'
not_contains "$final" 'AUTH_MODE: dev' 'production stack never enables dev impersonation auth'
contains "$final" 'command: ["node", "dist/src/worker.runner.js"]' 'final uses unified worker runner'
contains "$final" 'command: ["node", "dist/src/network-egress/egress-guard.runner.js"]' 'final includes tenant egress guard'
contains "$final" 'mode: global' 'egress guard runs on every Swarm node'
egress_guard_section="$(sed -n '/^  egress-guard:/,/^  traefik:/p' <<<"$final")"
contains "$egress_guard_section" 'user: "0"' 'egress guard runs with root network administration identity'
contains "$egress_guard_section" '      - NET_ADMIN' 'egress guard receives NET_ADMIN only for host firewall reconciliation'
contains "$egress_guard_section" '      - NET_RAW' 'egress guard receives NET_RAW for firewall compatibility'
contains "$egress_guard_section" '/var/run/docker.sock:/var/run/docker.sock:ro' 'egress guard reads local Docker task inventory through a read-only socket mount'
contains "$egress_guard_section" '      - host' 'egress guard uses host network namespace'
not_contains "$egress_guard_section" 'DATABASE_URL' 'egress guard has no database credential'
not_contains "$egress_guard_section" 'rp_encryption_key' 'egress guard has no ResourcePortal encryption key'
dockerfile_source="$(cat "$repo_root/Dockerfile")"
contains "$dockerfile_source" '    iptables \' 'API runtime image ships firewall tooling for the egress guard'
not_contains "$final" 'dist/src/internal/deployment-worker.runner.js' 'final no longer uses deployment worker runner'
not_contains "$final" 'dist/src/operations/operation-worker.runner.js' 'final no longer uses operation worker runner'

contains "$final" 'DATABASE_URL_FILE: /run/secrets/rp_database_url' 'API consumes DB secret file'
contains "$final" 'RESOURCE_ENCRYPTION_KEY_FILE: /run/secrets/rp_encryption_key' 'API consumes encryption secret file'
contains "$final" 'AUTH_COOKIE_SECRET_FILE: /run/secrets/rp_cookie_secret' 'API consumes cookie secret file'
contains "$final" 'INTERNAL_WORKER_TOKEN_FILE: /run/secrets/rp_internal_worker_token' 'API consumes internal token secret file'
contains "$final" 'ZITADEL_MANAGEMENT_TOKEN_FILE: /run/secrets/rp_zitadel_management_token' 'API consumes ZITADEL management token from secret file'
contains "$final" 'ZITADEL_ORGANIZATION_ID: zitadel-org-123' 'API receives ZITADEL organization id'
contains "$final" 'ZITADEL_PROJECT_ID: zitadel-project-456' 'API receives ZITADEL project id'
contains "$final" 'OIDC_CLI_CLIENT_ID: zitadel-cli-client-789' 'API receives public CLI OAuth client id'
contains "$final" 'MANAGED_DOMAIN_BASE: rp.example.com' 'API receives managed ResourcePortal domain base'
contains "$final" 'RESOURCEPORTAL_PUBLIC_HOSTNAME: rp.example.com' 'API receives canonical DNS target hostname'
contains "$final" 'RESOURCEPORTAL_INTERNAL_NETWORK_CIDRS: 10.20.0.0/24' 'API receives trusted internal network CIDR'
internal_network_cidr_count="$(grep -c 'RESOURCEPORTAL_INTERNAL_NETWORK_CIDRS: 10.20.0.0/24' <<<"$final" || true)"
[[ "$internal_network_cidr_count" == 2 ]] && pass 'API and worker receive trusted internal network CIDR' || fail 'API and worker receive trusted internal network CIDR'
managed_domain_base_count="$(grep -c 'MANAGED_DOMAIN_BASE: rp.example.com' <<<"$final" || true)"
[[ "$managed_domain_base_count" == 2 ]] && pass 'API and worker receive managed ResourcePortal domain base' || fail 'API and worker receive managed ResourcePortal domain base'
managed_domain_target_count="$(grep -c 'RESOURCEPORTAL_PUBLIC_HOSTNAME: rp.example.com' <<<"$final" || true)"
[[ "$managed_domain_target_count" == 2 ]] && pass 'API and worker receive canonical DNS target hostname' || fail 'API and worker receive canonical DNS target hostname'
cli_client_id_count="$(grep -c 'OIDC_CLI_CLIENT_ID:' <<<"$final" || true)"
[[ "$cli_client_id_count" == 1 ]] && pass 'only API receives CLI OAuth client id' || fail 'only API receives CLI OAuth client id'
not_contains "$final" 'OIDC_CLI_CLIENT_SECRET' 'stack never contains a CLI OAuth client secret'
contains "$final" 'name: rp_zitadel_management_token_feedfacefeedface' 'stack aliases versioned ZITADEL management token secret'
management_mount_count="$(grep -c '^      - rp_zitadel_management_token$' <<<"$final" || true)"
[[ "$management_mount_count" == 1 ]] && pass 'only API mounts ZITADEL management token secret' || fail 'only API mounts ZITADEL management token secret'
management_file_count="$(grep -c 'ZITADEL_MANAGEMENT_TOKEN_FILE:' <<<"$final" || true)"
[[ "$management_file_count" == 1 ]] && pass 'only API receives ZITADEL management token file env' || fail 'only API receives ZITADEL management token file env'
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
export ZITADEL_MANAGEMENT_TOKEN='management-token-plaintext-fixture'
not_contains "$final" "$ZITADEL_MANAGEMENT_TOKEN" 'rendered stack never contains plaintext ZITADEL management PAT'
config_fixture="$(mktemp /tmp/rp-installer-config.XXXXXX)"
rp_config_write "$config_fixture"
config_text="$(cat "$config_fixture")"
contains "$config_text" 'RP_CFG_ZITADEL_ORGANIZATION_ID=zitadel-org-123' 'installer config persists ZITADEL organization id'
contains "$config_text" 'RP_CFG_ZITADEL_PROJECT_ID=zitadel-project-456' 'installer config persists ZITADEL project id'
contains "$config_text" 'RP_CFG_OIDC_CLI_CLIENT_ID=zitadel-cli-client-789' 'installer config persists CLI client id metadata'
contains "$config_text" 'RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF=rp_zitadel_management_token_feedfacefeedface' 'installer config persists only management secret ref'
not_contains "$config_text" "$ZITADEL_MANAGEMENT_TOKEN" 'installer config never persists plaintext ZITADEL management PAT'
rm -f "$config_fixture"
unset ZITADEL_MANAGEMENT_TOKEN

contains "$final" 'node.labels.resourceportal.storage.platform == true' 'stateful platform services require platform storage'
contains "$final" 'node.labels.resourceportal.storage.authoritative == true' 'worker requires authoritative storage host'
control_plane_source="$(cat "$repo_root/scripts/installer/control-plane.sh")"
contains "$control_plane_source" '--with-registry-auth --prune' 'stack deploy prunes legacy services removed by v0.2 architecture'
contains "$control_plane_source" 'rp_wait_control_plane_converged' 'stack deploy waits for Swarm convergence before returning'

control_plane_convergence_succeeds() (
  docker() {
    case "$1 $2" in
      'stack services') printf 'resourceportal-control-plane_api\nresourceportal-control-plane_worker\n' ;;
      'service inspect') printf 'completed\n' ;;
      'service ps')
        if [[ "$*" == *'{{.ID}}'* ]]; then
          printf 'task-id\n'
        elif [[ "$*" == *'{{.CurrentState}}'* ]]; then
          printf 'Running 2 seconds ago\n'
        fi
        ;;
      *) return 0 ;;
    esac
  }
  rp_wait_control_plane_converged resourceportal-control-plane 2
)
status 0 'control-plane convergence accepts completed updates with all desired tasks running' control_plane_convergence_succeeds

control_plane_convergence_rejects_paused_update() (
  docker() {
    case "$1 $2" in
      'stack services') printf 'resourceportal-control-plane_worker\n' ;;
      'service inspect') printf 'paused\n' ;;
      'service ps') return 0 ;;
      *) return 0 ;;
    esac
  }
  rp_wait_control_plane_converged resourceportal-control-plane 2
)
status 1 'control-plane convergence fails fast on paused rollout' control_plane_convergence_rejects_paused_update
not_contains "$control_plane_source" '--env AUTH_MODE=dev' 'production migration job no longer opts into forbidden dev auth mode'
contains "$final" 'node.role == manager' 'control plane requires managers'
contains "$final" 'node.labels.rp.node.ingress == true' 'Traefik requires v0.2 ingress opt-in'
not_contains "$final" 'node.labels.resourceportal.ingress == true' 'production stack no longer schedules by legacy ingress role'
contains "$final" 'Host(`rp.example.com`)' 'Web router uses production domain'
contains "$final" 'Host(`auth.rp.example.com`)' 'ZITADEL router uses separate auth domain'
contains "$final" 'OIDC_ISSUER_URL: https://auth.rp.example.com' 'API issuer uses auth domain'
contains "$final" 'OIDC_CLIENT_ID: zitadel-client-123' 'stack uses generated ZITADEL client id'
contains "$final" 'OIDC_AUDIENCE: zitadel-client-123' 'stack audience follows generated client id'
contains "$final" 'name: rp_oidc_client_secret_v42' 'stack aliases versioned OIDC client secret'
contains "$final" 'traefik.http.services.resourceportal-web.loadbalancer.server.port=5173' 'Web router targets SSR port'
contains "$final" 'traefik.http.routers.resourceportal-oauth-metadata.rule=Host(`auth.rp.example.com`) && Path(`/.well-known/oauth-authorization-server`)' 'auth host routes RFC 8414 metadata through ResourcePortal web proxy'
contains "$final" 'traefik.http.routers.resourceportal-oauth-metadata.priority=1000' 'OAuth metadata router outranks the generic ZITADEL host router'
contains "$final" 'traefik.http.routers.resourceportal-oauth-metadata.service=resourceportal-web' 'OAuth metadata router uses the ResourcePortal web proxy'
contains "$final" 'traefik.http.services.resourceportal-zitadel.loadbalancer.server.port=8080' 'ZITADEL router targets identity port'
contains "$final" 'RESOURCE_VOLUME_RUNTIME_ROOT: /mnt/resourceportal/volumes' 'runtime volume root is canonical'
contains "$final" 'RESOURCE_SECRET_RUNTIME_ROOT: /mnt/resourceportal/secrets' 'runtime secret root is canonical'
contains "$final" 'RESOURCE_PLATFORM_RUNTIME_ROOT: /mnt/resourceportal/platform' 'runtime platform root is canonical'

api_section="$(sed -n '/^  api:/,/^  worker:/p' <<<"$final")"
worker_section="$(sed -n '/^  worker:/,/^  dr-reconciliation:/p' <<<"$final")"
web_section="$(sed -n '/^  web:/,/^  egress-guard:/p' <<<"$final")"
traefik_section="$(sed -n '/^  traefik:/,/^configs:/p' <<<"$final")"
contains "$api_section" '      - rp-web-api' 'API joins the dedicated Web-to-API overlay'
not_contains "$api_section" '      - rp-ingress' 'API is not directly reachable from the public ingress overlay'
contains "$web_section" '      - rp-ingress' 'Web remains reachable from Traefik ingress'
contains "$web_section" 'traefik.swarm.network=resourceportal-control-plane_rp-ingress' 'Web pins Traefik service discovery to the shared ingress overlay'
contains "$web_section" '      - rp-web-api' 'Web proxies API requests over the dedicated internal overlay'
not_contains "$traefik_section" 'rp-web-api' 'Traefik cannot directly reach the API-only proxy overlay'
not_contains "$api_section" '/var/run/docker.sock' 'API has no Docker socket mount'
not_contains "$api_section" '/mnt/resourceportal/volumes' 'API has no tenant volume mount'
not_contains "$api_section" '/mnt/resourceportal/secrets' 'API has no secret filesystem mount'
not_contains "$api_section" 'RESOURCE_STORAGE_BASE_PATH:' 'API has no host storage root configuration'
contains "$worker_section" '/var/run/docker.sock:/var/run/docker.sock' 'worker owns Docker socket access'
contains "$worker_section" '/mnt/resourceportal/volumes:/mnt/resourceportal/volumes' 'worker owns tenant volume access'
contains "$worker_section" '/mnt/resourceportal/secrets:/mnt/resourceportal/secrets:ro' 'worker can read legacy secret filesystem during upgrade'
contains "$worker_section" '/srv/resource-portal/storage:/srv/resource-portal/storage' 'worker has authoritative storage path for resumable legacy Secret cleanup'
contains "$worker_section" 'node.labels.rp.node.control-plane == true' 'worker is placed on v0.2 control-plane capable node'
contains "$worker_section" 'node.labels.rp.node.storage == true' 'worker requires v0.2 storage role'
not_contains "$worker_section" 'node.labels.resourceportal.control-plane == true' 'worker no longer schedules by legacy control-plane role'

status 0 'accept exact digest API image' rp_validate_image_ref "$RP_CFG_API_IMAGE"
status 1 'reject mutable latest image' rp_validate_image_ref 'ghcr.io/re-invertion/resourceportal-api:latest'
status 1 'reject short digest' rp_validate_image_ref 'ghcr.io/re-invertion/resourceportal-api@sha256:abc'
saved_org="$RP_CFG_ZITADEL_ORGANIZATION_ID"; unset RP_CFG_ZITADEL_ORGANIZATION_ID
status 1 'final stack config requires ZITADEL organization id' rp_require_stack_config final
export RP_CFG_ZITADEL_ORGANIZATION_ID="$saved_org"
saved_project="$RP_CFG_ZITADEL_PROJECT_ID"; unset RP_CFG_ZITADEL_PROJECT_ID
status 1 'final stack config requires ZITADEL project id' rp_require_stack_config final
export RP_CFG_ZITADEL_PROJECT_ID="$saved_project"
saved_cli_client_id="$RP_CFG_OIDC_CLI_CLIENT_ID"; unset RP_CFG_OIDC_CLI_CLIENT_ID
status 1 'final stack config requires CLI OAuth client id' rp_require_stack_config final
export RP_CFG_OIDC_CLI_CLIENT_ID="$saved_cli_client_id"
saved_management_ref="$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF"; unset RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
status 1 'final stack config requires ZITADEL management secret ref' rp_require_stack_config final
export RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF="$saved_management_ref"

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
contains "$control_source" 'rp_recover_zitadel_management_state' 'every final stack deploy recovers legacy ZITADEL management state before rendering'
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
