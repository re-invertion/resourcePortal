#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/acme.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/config.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3"; }

export RP_CFG_API_IMAGE='ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export RP_CFG_WEB_IMAGE='ghcr.io/re-invertion/resourceportal-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export RP_CFG_POSTGRES_IMAGE='postgres:17-alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
export RP_CFG_ZITADEL_IMAGE='ghcr.io/zitadel/zitadel:v4.0.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
export RP_CFG_TRAEFIK_IMAGE='traefik:v3.6.16@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export RP_CFG_DOMAIN='resource-portal.pl'
unset RP_CFG_MANAGED_DOMAIN_BASE || true
export RP_CFG_ZITADEL_DOMAIN='auth.resource-portal.pl'
export RP_CFG_ACME_EMAIL='admin@resource-portal.pl'
export RP_CFG_ACME_ENVIRONMENT='production'
export RP_CFG_COOKIE_SWARM_REF='rp_cookie_secret_0123456789abcdef'
export RP_CFG_WORKER_SWARM_REF='rp_internal_worker_token_0123456789abcdef'
export RP_CFG_OIDC_CLIENT_ID='zitadel-client-123'
export RP_CFG_OIDC_CLI_CLIENT_ID='zitadel-cli-client-789'
export RP_CFG_OIDC_SWARM_REF='rp_oidc_client_secret_v42'
export RP_CFG_ZITADEL_KEY_SWARM_REF='zitadel_masterkey_deadbeefcafebabe'
export RP_CFG_ZITADEL_ORGANIZATION_ID='zitadel-org-123'
export RP_CFG_ZITADEL_PROJECT_ID='zitadel-project-456'
export RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_feedfacefeedface'
export RP_CFG_STORAGE_DEVICE='/dev/sdb'
export RP_CFG_SWARM_ADVERTISE_ADDR='10.20.0.10'
export RP_CFG_STORAGE_SERVER_ADDRESS='10.20.0.10'
export RP_CFG_CLUSTER_CIDR='10.20.0.0/24'
export RP_CFG_RELEASE_VERSION='0.2.0'

rp_config_apply_defaults
[[ "$RP_CFG_MANAGED_DOMAIN_BASE" == resource-portal.pl ]] && pass 'managed domain defaults to portal domain' || fail 'managed domain defaults to portal domain'

final="$(rp_render_stack final)"
contains "$final" 'MANAGED_DOMAIN_BASE: resource-portal.pl' 'API receives managed domain base'
contains "$final" 'TRAEFIK_CERT_RESOLVER: letsencrypt' 'worker receives production resolver'
not_contains "$final" 'TRAEFIK_SWARM_NETWORK: resourceportal-control-plane_rp-ingress' 'worker no longer depends on shared tenant ingress overlay'

worker_block="$(awk '/^  worker:/{flag=1} /^  dr-reconciliation:/{if(flag){exit}} flag' <<<"$final")"
api_block="$(awk '/^  api:/{flag=1} /^  worker:/{if(flag){exit}} flag' <<<"$final")"

contains "$worker_block" 'user: "0"' 'unified worker runs as root for privileged infrastructure operations'
contains "$worker_block" '/var/run/docker.sock:/var/run/docker.sock' 'unified worker owns Docker socket access'
contains "$worker_block" 'SYS_ADMIN' 'unified worker has quota capability'
contains "$worker_block" '/dev/sdb:/dev/sdb' 'unified worker receives storage block device'
contains "$worker_block" 'dist/src/worker.runner.js' 'unified worker uses v0.2 runner'
not_contains "$final" $'\n  deployment-worker:' 'production stack has no deployment-worker service'
not_contains "$final" $'\n  operation-worker:' 'production stack has no operation-worker service'
not_contains "$api_block" '/var/run/docker.sock' 'API has no Docker socket'
not_contains "$api_block" '/mnt/resourceportal/volumes' 'API has no tenant volume mount'

if (( failures > 0 )); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'All v0.1.8 production stabilization installer tests passed.\n'
