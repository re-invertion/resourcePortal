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

# DNS propagation checks must use public recursive DNS, not the host NSS/default
# resolver, because split-DNS may intentionally map the public hostname to a
# private address on the local network.
dig(){
  case "$*" in
    *'@1.1.1.1'*) printf '203.0.113.10\n' ;;
    *'@8.8.8.8'*) printf '203.0.113.10\n' ;;
    *) return 1 ;;
  esac
}
getent(){ printf '192.168.100.100 STREAM resource-portal.example\n'; }
eq '203.0.113.10' "$(rp_resolve_domain_addresses resource-portal.example)" 'DNS resolver ignores local split-DNS override'
unset -f dig getent

# DNS gate must block until both public domains resolve to the configured ingress address.
_dns_attempt=0
rp_resolve_domain_addresses(){
  case "$1" in
    resource-portal.example)
      if (( _dns_attempt < 1 )); then printf '198.51.100.99\n'; else printf '203.0.113.10\n'; fi
      ;;
    auth.resource-portal.example)
      if (( _dns_attempt < 2 )); then printf '\n'; else printf '203.0.113.10\n'; fi
      ;;
  esac
}
sleep(){ _dns_attempt=$((_dns_attempt+1)); }
dns_event_log="$(mktemp /tmp/rp-dns-events.XXXXXX)"
rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$dns_event_log"; }
status 0 'DNS gate waits until both domains match ingress' rp_wait_for_required_dns resource-portal.example auth.resource-portal.example 203.0.113.10 1
[[ "$_dns_attempt" -ge 2 ]] && pass 'DNS gate blocks across invalid DNS states' || fail 'DNS gate blocks across invalid DNS states'
dns_events="$(cat "$dns_event_log")"
contains "$dns_events" 'phase_blocked|dns|Waiting for required DNS A records' 'DNS gate emits blocked state'
contains "$dns_events" 'operation_updated|dns|resource-portal.example: 198.51.100.99 (wrong)' 'DNS gate reports wrong application address'
contains "$dns_events" 'operation_updated|dns|auth.resource-portal.example: missing' 'DNS gate reports missing auth address'
contains "$dns_events" 'phase_unblocked|dns|Required DNS records are ready' 'DNS gate emits unblocked state'
rm -f "$dns_event_log"
unset -f rp_ui_event rp_resolve_domain_addresses sleep

# Public ingress discovery must accept only a real IPv4 response and try the
# next HTTPS endpoint when the first one fails.
curl(){
  if [[ "$*" == *api.ipify.org* ]]; then printf 'not-an-ip\n'; else printf '198.51.100.42\n'; fi
}
eq '198.51.100.42' "$(rp_detect_public_ipv4)" 'public IPv4 discovery skips invalid provider response'
unset -f curl

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
contains "$identity_source" 'x-zitadel-instance-host' 'bootstrap sends ZITADEL instance host header'
contains "$identity_source" 'x-zitadel-public-host' 'bootstrap sends ZITADEL public host header'
identity_wait_source="$(sed -n '/async function waitForZitadel/,/^}/p' "$repo_root/packages/resourceportal-api/scripts/bootstrap-zitadel.ts")"
contains "$identity_wait_source" '/debug/ready' 'bootstrap waits for ZITADEL readiness endpoint'
not_contains "$identity_wait_source" '/debug/healthz' 'bootstrap does not treat liveness as readiness'
identity_shell_source="$(cat "$repo_root/scripts/installer/identity.sh")"
contains "$identity_shell_source" 'ZITADEL_BOOTSTRAP_INSTANCE_HOST=' 'installer passes public ZITADEL instance host to bootstrap'
bootstrap_runner_source="$(sed -n '/rp_run_zitadel_bootstrap()/,/^}/p' "$repo_root/scripts/installer/identity.sh")"
contains "$bootstrap_runner_source" '--detach' 'identity bootstrap one-shot service is created detached'
contains "$bootstrap_runner_source" '/debug/ready' 'installer bootstrap service gates release image on ZITADEL readiness'
contains "$bootstrap_runner_source" '--entrypoint /bin/sh' 'installer controls bootstrap command sequencing'
contains "$bootstrap_runner_source" 'docker service ps --no-trunc' 'identity bootstrap explicitly polls one-shot service state'
contains "$identity_shell_source" 'rp_prepare_api_bootstrap_output_dir' 'identity bootstrap prepares non-root output directory'
contains "$bootstrap_runner_source" 'identity-bootstrap' 'identity bootstrap isolates writable output under installer state'
contains "$bootstrap_runner_source" 'chown -R root:root' 'identity bootstrap returns output ownership to root'
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
