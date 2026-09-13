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

rp_config_apply_defaults
[[ "$RP_CFG_MANAGED_DOMAIN_BASE" == resource-portal.pl ]] && pass 'managed domain defaults to portal domain' || fail 'managed domain defaults to portal domain'

final="$(rp_render_stack final)"
contains "$final" 'MANAGED_DOMAIN_BASE: resource-portal.pl' 'API receives managed domain base'
contains "$final" 'TRAEFIK_CERT_RESOLVER: letsencrypt' 'deployment worker receives production resolver'
contains "$final" 'TRAEFIK_SWARM_NETWORK: resourceportal-control-plane_rp-ingress' 'deployment worker receives ingress overlay name'

deployment_block="$(awk '/^  deployment-worker:/{flag=1} /^  operation-worker:/{if(flag){exit}} flag' <<<"$final")"
operation_block="$(awk '/^  operation-worker:/{flag=1} /^  dr-reconciliation:/{if(flag){exit}} flag' <<<"$final")"
api_block="$(awk '/^  api:/{flag=1} /^  deployment-worker:/{if(flag){exit}} flag' <<<"$final")"

contains "$deployment_block" 'user: "0"' 'deployment worker runs as root for Docker socket'
contains "$deployment_block" '/var/run/docker.sock:/var/run/docker.sock' 'deployment worker owns Docker socket access'
contains "$operation_block" 'user: "0"' 'operation worker runs as root for quota mutation'
contains "$operation_block" 'SYS_ADMIN' 'operation worker has SYS_ADMIN capability'
contains "$operation_block" '/dev/sdb:/dev/sdb' 'operation worker receives storage block device'
not_contains "$operation_block" '/var/run/docker.sock' 'operation worker has no Docker socket'
not_contains "$api_block" '/var/run/docker.sock' 'API has no Docker socket'

if (( failures > 0 )); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'All v0.1.8 production stabilization installer tests passed.\n'
