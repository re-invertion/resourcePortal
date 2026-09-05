#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/identity.sh"
source "$repo_root/scripts/installer/domain.sh"
source "$repo_root/scripts/installer/smtp.sh"
source "$repo_root/scripts/installer/secrets.sh"
failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
eq(){ [[ "$1" == "$2" ]] && pass "$3" || { printf 'expected=%s actual=%s\n' "$1" "$2" >&2; fail "$3"; }; }
status(){ local e="$1" n="$2"; shift 2; set +e; "$@" >/tmp/rp-id.out 2>/tmp/rp-id.err; local a=$?; set -e; [[ "$a" == "$e" ]] && pass "$n" || fail "$n"; }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3"; }

eq 'a,b,c' "$(rp_merge_platform_admin_ids 'a,b' 'b,c')" 'admin IDs are merged without duplicates'
eq 'new-user' "$(rp_merge_platform_admin_ids '' 'new-user')" 'first admin ID is added'
eq 'a,b' "$(rp_merge_platform_admin_ids 'a,b' '')" 'empty new admin keeps existing IDs'

status 0 'strong admin password accepted' rp_admin_password_valid 'GoodPassword1!'
status 1 'short admin password rejected' rp_admin_password_valid 'Aa1!short'
status 1 'missing uppercase rejected' rp_admin_password_valid 'goodpassword1!'
status 1 'missing lowercase rejected' rp_admin_password_valid 'GOODPASSWORD1!'
status 1 'missing digit rejected' rp_admin_password_valid 'GoodPassword!'
status 1 'missing special rejected' rp_admin_password_valid 'GoodPassword123'

status 0 'DNS accepts expected IPv4' rp_dns_matches_addresses '203.0.113.10' $'203.0.113.10\n2001:db8::10'
status 0 'DNS accepts one of expected addresses' rp_dns_matches_addresses '203.0.113.11,203.0.113.10' $'203.0.113.10\n2001:db8::10'
status 1 'DNS rejects unrelated address' rp_dns_matches_addresses '203.0.113.99' $'203.0.113.10\n2001:db8::10'
status 1 'DNS rejects empty result' rp_dns_matches_addresses '203.0.113.10' ''

status 0 'SMTP TLS mode accepted' rp_validate_smtp_mode tls
status 0 'SMTP STARTTLS mode accepted' rp_validate_smtp_mode starttls
status 0 'SMTP plain mode accepted only when explicitly selected' rp_validate_smtp_mode plain
status 1 'invalid SMTP mode rejected' rp_validate_smtp_mode opportunistic

secret_fixture="$(mktemp /tmp/rp-secret-name.XXXXXX)"
printf 'generated-zitadel-client-secret' >"$secret_fixture"
expected_hash="$(sha256sum "$secret_fixture" | awk '{print substr($1,1,16)}')"
eq "rp_oidc_client_secret_${expected_hash}" "$(rp_versioned_secret_name rp_oidc_client_secret "$secret_fixture")" 'versioned secret name is content-addressed'
rm -f "$secret_fixture"
status 1 'versioned secret name rejects unsafe logical name' rp_versioned_secret_name '../secret' /etc/hosts

identity_source="$(cat "$repo_root/packages/resourceportal-api/scripts/bootstrap-zitadel.ts")"
contains "$identity_source" 'ZITADEL_BOOTSTRAP_MODE' 'bootstrap script supports production mode'
contains "$identity_source" 'ZITADEL_BOOTSTRAP_OUTPUT_FILE' 'bootstrap supports machine-readable output file'
contains "$identity_source" 'ZITADEL_BOOTSTRAP_ADMIN_EMAIL' 'bootstrap supports first admin email'
contains "$identity_source" '["client-secret", app.clientSecret]' 'production bootstrap writes client secret sidecar'
contains "$identity_source" '["client-id", app.clientId]' 'production bootstrap writes client id sidecar'
contains "$identity_source" '["user-id", bootstrapUser.id]' 'production bootstrap writes admin user id sidecar'
bootstrap_out="$(mktemp /tmp/rp-zitadel-output.XXXXXX.json)"
printf '{}\n' >"$bootstrap_out"
printf 'client-generated-42\n' >"${bootstrap_out}.client-id"
printf 'super-secret-generated-value\n' >"${bootstrap_out}.client-secret"
printf 'user-new-42\n' >"${bootstrap_out}.user-id"
export RP_CFG_PLATFORM_ADMIN_IDS='user-existing'
rp_ensure_versioned_swarm_secret(){ [[ "$1" == 'rp_oidc_client_secret' && "$2" == "${bootstrap_out}.client-secret" ]] || return 1; printf 'rp_oidc_client_secret_deadbeefdeadbeef\n'; }
status 0 'bootstrap output applies to installer state' rp_apply_zitadel_bootstrap_output "$bootstrap_out"
eq 'client-generated-42' "${RP_CFG_OIDC_CLIENT_ID:-}" 'generated client id enters installer state'
eq 'rp_oidc_client_secret_deadbeefdeadbeef' "${RP_CFG_OIDC_SWARM_REF:-}" 'only Swarm secret reference enters installer state'
eq 'user-existing,user-new-42' "${RP_CFG_PLATFORM_ADMIN_IDS:-}" 'new Platform Admin preserves existing admins'
[[ ! -e "${bootstrap_out}.client-secret" ]] && pass 'plaintext OIDC client secret sidecar is removed' || fail 'plaintext OIDC client secret sidecar is removed'
rm -f "$bootstrap_out" "${bootstrap_out}.client-id" "${bootstrap_out}.user-id"

not_contains "$identity_source" 'OIDC client secret: ${maskSecret' 'production bootstrap does not print masked OIDC secret line'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All identity/domain installer tests passed.\n'
