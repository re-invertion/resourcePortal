#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/config.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }

RP_CFG_DOMAIN='resource-portal.pl'
unset RP_CFG_MANAGED_DOMAIN_BASE || true
export RP_CFG_DOMAIN
rp_config_apply_defaults
[[ "$RP_CFG_MANAGED_DOMAIN_BASE" == resource-portal.pl ]] && pass 'legacy config defaults managed domain base' || fail 'legacy config defaults managed domain base'

config="$(mktemp /tmp/rp-managed-domain.XXXXXX)"
trap 'rm -f "$config"' EXIT
rp_config_write "$config"
grep -q '^RP_CFG_MANAGED_DOMAIN_BASE=resource-portal.pl$' "$config" && pass 'managed domain base persists' || fail 'managed domain base persists'

if (( failures > 0 )); then exit 1; fi
printf 'All managed-domain default tests passed.\n'
