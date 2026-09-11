#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/acme.sh"
source "$repo_root/scripts/installer/domain.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reset.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
eq(){ [[ "$1" == "$2" ]] && pass "$3" || { printf 'expected=%s actual=%s\n' "$1" "$2" >&2; fail "$3"; }; }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || { printf 'missing=%s\n' "$2" >&2; fail "$3"; }; }
not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || { printf 'unexpected=%s\n' "$2" >&2; fail "$3"; }; }
status(){ local expected="$1" name="$2"; shift 2; set +e; "$@" >/tmp/rp-acme.out 2>/tmp/rp-acme.err; local actual=$?; set -e; [[ "$actual" == "$expected" ]] && pass "$name" || { printf 'expected_status=%s actual_status=%s\n' "$expected" "$actual" >&2; cat /tmp/rp-acme.err >&2 || true; fail "$name"; }; }

# Environment and resolver selection.
status 0 'production ACME environment accepted' rp_acme_environment_valid production
status 0 'staging ACME environment accepted' rp_acme_environment_valid staging
status 1 'unknown ACME environment rejected' rp_acme_environment_valid development
export RP_CFG_ACME_ENVIRONMENT=production
eq 'letsencrypt-staging' "$(rp_acme_resolver_for_state ingress)" 'ingress always uses staging resolver first'
eq 'letsencrypt' "$(rp_acme_resolver_for_state final)" 'production final uses production resolver'
export RP_CFG_ACME_ENVIRONMENT=staging
eq 'letsencrypt-staging' "$(rp_acme_resolver_for_state final)" 'staging final remains on staging resolver'

# ACME storage parser must inspect only metadata and never print key material.
fixture_dir="$(mktemp -d /tmp/rp-acme-test.XXXXXX)"
trap 'rm -rf "$fixture_dir"' EXIT
cat > "$fixture_dir/acme.json" <<'JSON'
{
  "letsencrypt": {
    "Account": {"Email":"admin@example.com","PrivateKey":"DO-NOT-PRINT"},
    "Certificates": [
      {"domain":{"main":"auth.rp.example.com","sans":["rp.example.com"]},"certificate":"CERT","key":"PRIVATE-CERT-KEY"}
    ]
  }
}
JSON
chmod 0600 "$fixture_dir/acme.json"
status 0 'ACME state finds main certificate domain' rp_acme_storage_has_domain "$fixture_dir/acme.json" letsencrypt auth.rp.example.com
status 0 'ACME state finds SAN certificate domain' rp_acme_storage_has_domain "$fixture_dir/acme.json" letsencrypt rp.example.com
status 1 'ACME state rejects unrelated domain' rp_acme_storage_has_domain "$fixture_dir/acme.json" letsencrypt other.example.com
printf '{broken' > "$fixture_dir/broken.json"
status 1 'ACME state rejects corrupt JSON' rp_acme_storage_has_domain "$fixture_dir/broken.json" letsencrypt auth.rp.example.com

# Production state is restored from a root-only host cache only when active state is absent.
export RP_ACME_PLATFORM_DIR="$fixture_dir/platform"
export RP_ACME_CACHE_DIR="$fixture_dir/cache"
mkdir -p "$RP_ACME_PLATFORM_DIR" "$RP_ACME_CACHE_DIR"
cp "$fixture_dir/acme.json" "$RP_ACME_CACHE_DIR/acme.json"
chmod 0600 "$RP_ACME_CACHE_DIR/acme.json"
status 0 'cached production ACME state restores into empty platform state' rp_acme_restore_cached_state
cmp -s "$RP_ACME_CACHE_DIR/acme.json" "$RP_ACME_PLATFORM_DIR/acme.json" && pass 'restored ACME cache is byte-identical' || fail 'restored ACME cache is byte-identical'
eq '600' "$(stat -c '%a' "$RP_ACME_PLATFORM_DIR/acme.json")" 'restored ACME state is root-only'
printf '{"letsencrypt":{"Certificates":[]}}\n' > "$RP_ACME_PLATFORM_DIR/acme.json"
printf 'sentinel\n' > "$RP_ACME_CACHE_DIR/acme.json"
status 0 'existing active production ACME state is never overwritten by cache' rp_acme_restore_cached_state
grep -q 'Certificates' "$RP_ACME_PLATFORM_DIR/acme.json" && pass 'active ACME state wins over cache' || fail 'active ACME state wins over cache'

# Active production ACME state is cached atomically after issuance.
cp "$fixture_dir/acme.json" "$RP_ACME_PLATFORM_DIR/acme.json"
# Intentional late rm() regression double exists below.
# shellcheck disable=SC2218
rm -f "$RP_ACME_CACHE_DIR/acme.json"
status 0 'active production ACME state is cached for reinstall reuse' rp_acme_cache_active_state
cmp -s "$RP_ACME_PLATFORM_DIR/acme.json" "$RP_ACME_CACHE_DIR/acme.json" && pass 'cached ACME state matches active state' || fail 'cached ACME state matches active state'
eq '700' "$(stat -c '%a' "$RP_ACME_CACHE_DIR")" 'ACME cache directory is root-only'
eq '600' "$(stat -c '%a' "$RP_ACME_CACHE_DIR/acme.json")" 'cached ACME file is root-only'

# Real observed Let's Encrypt error must be classified as terminal and expose retry-after.
rate_log='ERR Unable to obtain ACME certificate for domains error="unable to generate a certificate for the domains [auth.resource-portal.pl]: acme: error: 429 :: POST :: https://acme-v02.api.letsencrypt.org/acme/new-order :: urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after 2026-09-11 15:44:09 UTC" domains=["auth.resource-portal.pl"]'
summary="$(rp_acme_classify_error auth.resource-portal.pl "$rate_log")"
contains "$summary" 'rate limit' 'rate-limit error is classified explicitly'
contains "$summary" '2026-09-11 15:44:09 UTC' 'rate-limit error preserves retry-after timestamp'
not_contains "$summary" 'PRIVATE' 'ACME error summary does not expose private key material'

# Certificate wait must fail immediately on a terminal rate-limit instead of sleeping for 300s.
validate_calls=0
sleep_calls=0
rp_validate_https_certificate(){ validate_calls=$((validate_calls+1)); return 1; }
rp_traefik_acme_error_for_domain(){ printf '%s\n' "$rate_log"; }
sleep(){ sleep_calls=$((sleep_calls+1)); }
export RP_CFG_ACME_ENVIRONMENT=production
set +e
# Intentional late rp_wait_for_acme_certificate() regression double exists below.
# shellcheck disable=SC2218
rp_wait_for_acme_certificate auth.resource-portal.pl production 300 >/tmp/rp-acme-rate.out 2>/tmp/rp-acme-rate.err
rate_status=$?
set -e
[[ "$rate_status" == 1 ]] && pass 'production certificate wait fails on terminal ACME rate-limit' || fail 'production certificate wait fails on terminal ACME rate-limit'
eq '0' "$sleep_calls" 'terminal ACME error fails before any retry sleep'
contains "$(cat /tmp/rp-acme-rate.err)" '2026-09-11 15:44:09 UTC' 'terminal ACME failure reports exact retry-after'
unset -f rp_validate_https_certificate rp_traefik_acme_error_for_domain sleep
source "$repo_root/scripts/installer/domain.sh"

# Staging certificate readiness is proven from staging ACME state, not public trust.
export RP_ACME_PLATFORM_DIR="$fixture_dir/staging-platform"
mkdir -p "$RP_ACME_PLATFORM_DIR"
cat > "$RP_ACME_PLATFORM_DIR/acme-staging.json" <<'JSON'
{"letsencrypt-staging":{"Certificates":[{"domain":{"main":"auth.rp.example.com","sans":[]},"certificate":"CERT","key":"KEY"}]}}
JSON
status 0 'staging certificate wait accepts issued staging certificate metadata' rp_wait_for_acme_certificate auth.rp.example.com staging 1

# Strict production origin checks must never disable TLS verification; staging may for test-only installs.
curl_log="$fixture_dir/curl.log"
curl(){ printf '%s\n' "$*" >>"$curl_log"; return 0; }
export RP_CFG_ACME_ENVIRONMENT=production
status 0 'production HTTPS origin check succeeds through strict curl path' rp_validate_https_origin rp.example.com
prod_args="$(tail -n1 "$curl_log")"
not_contains "$prod_args" '--insecure' 'production HTTPS origin check never uses --insecure'
contains "$prod_args" '--resolve rp.example.com:443:127.0.0.1' 'production HTTPS origin check targets local Traefik while preserving SNI'
export RP_CFG_ACME_ENVIRONMENT=staging
status 0 'staging HTTPS origin check can exercise application with untrusted staging certificate' rp_validate_https_origin rp.example.com
staging_args="$(tail -n1 "$curl_log")"
contains "$staging_args" '--insecure' 'staging HTTPS origin check uses explicit test-only --insecure'
unset -f curl

# Production certificate checks must validate the local ingress endpoint rather than hairpinning to another NAT target.
curl(){ printf '%s\n' "$*" >"$fixture_dir/cert-curl.log"; printf '302'; return 0; }
status 0 'production certificate validator accepts local Traefik response with trusted certificate' rp_validate_https_certificate auth.rp.example.com
cert_args="$(cat "$fixture_dir/cert-curl.log")"
contains "$cert_args" '--resolve auth.rp.example.com:443:127.0.0.1' 'certificate validator pins hostname to local Traefik'
not_contains "$cert_args" '--insecure' 'certificate validator never disables trust verification'
unset -f curl

# Reinstall may skip a new staging order only when the preserved production certificate is still valid and covers both hostnames.
reuse_dir="$fixture_dir/reuse"
mkdir -p "$reuse_dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -subj '/CN=auth.rp.example.com' \
  -addext 'subjectAltName=DNS:auth.rp.example.com,DNS:rp.example.com' \
  -keyout "$reuse_dir/key.pem" -out "$reuse_dir/cert.pem" >/dev/null 2>&1
cert_b64="$(base64 -w0 "$reuse_dir/cert.pem")"
cat >"$reuse_dir/acme.json" <<JSON
{"letsencrypt":{"Certificates":[{"domain":{"main":"auth.rp.example.com","sans":["rp.example.com"]},"certificate":"$cert_b64","key":"IGNORED"}]}}
JSON
status 0 'valid preserved production certificate is reusable for both public hostnames' rp_acme_production_state_reusable "$reuse_dir/acme.json" auth.rp.example.com rp.example.com
status 1 'preserved production certificate is not reusable for an unrelated hostname' rp_acme_production_state_reusable "$reuse_dir/acme.json" auth.rp.example.com other.example.com

# Stack rendering must define isolated staging/production resolvers and switch router resolver by phase.
export RP_CFG_API_IMAGE='ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export RP_CFG_WEB_IMAGE='ghcr.io/re-invertion/resourceportal-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export RP_CFG_POSTGRES_IMAGE='postgres:17-alpine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
export RP_CFG_ZITADEL_IMAGE='ghcr.io/zitadel/zitadel:v4.0.0@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
export RP_CFG_TRAEFIK_IMAGE='traefik:v3.5@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
export RP_CFG_DOMAIN='rp.example.com'
export RP_CFG_ZITADEL_DOMAIN='auth.rp.example.com'
export RP_CFG_INGRESS_ADDRESSES='203.0.113.10'
export RP_CFG_ACME_EMAIL='admin@example.com'
export RP_CFG_COOKIE_SWARM_REF='rp_cookie_secret_0123456789abcdef'
export RP_CFG_WORKER_SWARM_REF='rp_internal_worker_token_0123456789abcdef'
export RP_CFG_PLATFORM_ADMIN_IDS='zitadel-user-1'
export RP_CFG_OIDC_CLIENT_ID='zitadel-client-123'
export RP_CFG_OIDC_SWARM_REF='rp_oidc_client_secret_v42'
export RP_CFG_ZITADEL_KEY_SWARM_REF='zitadel_masterkey_deadbeefcafebabe'
export RP_CFG_STACK_NAME='resourceportal-control-plane'
export RP_CFG_ACME_ENVIRONMENT=production
ingress="$(rp_render_stack ingress)"
final="$(rp_render_stack final)"
contains "$ingress" 'tls.certresolver=letsencrypt-staging' 'ingress router uses staging ACME resolver'
contains "$ingress" 'certificatesresolvers.letsencrypt-staging.acme.storage=/platform/traefik/acme-staging.json' 'ingress loads staging ACME storage'
not_contains "$ingress" 'certificatesresolvers.letsencrypt.acme.storage=/platform/traefik/acme.json' 'ingress does not load production ACME resolver into shared TLS store'
contains "$final" 'tls.certresolver=letsencrypt' 'final production router uses production ACME resolver'
contains "$final" 'certificatesresolvers.letsencrypt.acme.storage=/platform/traefik/acme.json' 'final production loads production ACME storage'
not_contains "$final" 'certificatesresolvers.letsencrypt-staging.' 'final production does not load staging resolver or staging certificates'
contains "$final" 'traefik.http.routers.resourceportal-zitadel.tls.domains[0].main=auth.rp.example.com' 'auth router requests canonical combined certificate main domain'
contains "$final" 'traefik.http.routers.resourceportal-zitadel.tls.domains[0].sans=rp.example.com' 'auth router includes Web hostname as SAN'
contains "$final" 'traefik.http.routers.resourceportal-web.tls.domains[0].main=auth.rp.example.com' 'Web router reuses canonical combined certificate main domain'
contains "$final" 'traefik.http.routers.resourceportal-web.tls.domains[0].sans=rp.example.com' 'Web router reuses the same SAN set'
export RP_CFG_ACME_ENVIRONMENT=staging
staging_final="$(rp_render_stack final)"
contains "$staging_final" 'tls.certresolver=letsencrypt-staging' 'test-only staging install never switches router to production ACME'
contains "$staging_final" 'certificatesresolvers.letsencrypt-staging.acme.storage=/platform/traefik/acme-staging.json' 'test-only staging final loads staging ACME storage'
not_contains "$staging_final" 'certificatesresolvers.letsencrypt.acme.storage=/platform/traefik/acme.json' 'test-only staging final does not load production ACME resolver'

# A production reinstall with a valid restored certificate must not create a new staging order.
ingress_reuse_log="$fixture_dir/ingress-reuse.log"
rp_validate_domain_dns(){ return 0; }
mountpoint(){ return 0; }
rp_acme_prepare_state(){ return 0; }
rp_deploy_control_plane(){ printf 'deploy:%s\n' "$1" >>"$ingress_reuse_log"; }
rp_acme_production_state_reusable(){ return 0; }
rp_wait_for_acme_certificate(){ printf 'unexpected-cert:%s:%s\n' "$1" "$2" >>"$ingress_reuse_log"; return 0; }
export RP_CFG_ACME_ENVIRONMENT=production RP_ACME_PLATFORM_DIR="$reuse_dir"
status 0 'production reinstall ingress reuses valid preserved certificate without staging issuance' rp_primary_enable_ingress
reuse_calls="$(cat "$ingress_reuse_log")"
contains "$reuse_calls" 'deploy:ingress' 'production reinstall still deploys ingress phase'
not_contains "$reuse_calls" 'unexpected-cert:' 'production reinstall skips staging certificate order when cache is reusable'
unset -f rp_validate_domain_dns mountpoint rp_acme_prepare_state rp_deploy_control_plane rp_acme_production_state_reusable rp_wait_for_acme_certificate

# Final deployment in production must wait for both public certificates before health and cache state afterwards.
call_log="$fixture_dir/final-calls.log"
rp_deploy_control_plane(){ printf 'deploy:%s\n' "$1" >>"$call_log"; }
rp_wait_for_acme_certificate(){ printf 'cert:%s:%s\n' "$1" "$2" >>"$call_log"; return 0; }
rp_wait_for_https_origin(){ printf 'origin:%s\n' "$1" >>"$call_log"; return 0; }
rp_acme_cache_active_state(){ printf 'cache\n' >>"$call_log"; return 0; }
export RP_CFG_ACME_ENVIRONMENT=production
rp_primary_deploy_final
final_calls="$(cat "$call_log")"
contains "$final_calls" 'cert:auth.rp.example.com:production' 'final production waits for auth certificate'
contains "$final_calls" 'cert:rp.example.com:production' 'final production waits for web certificate'
contains "$final_calls" 'origin:rp.example.com' 'final production verifies application health after certificates'
contains "$final_calls" 'cache' 'final production caches ACME state after successful issuance'
unset -f rp_deploy_control_plane rp_wait_for_acme_certificate rp_wait_for_https_origin rp_acme_cache_active_state

# Factory reset must preserve the host ACME reuse cache while destroying ResourcePortal runtime data.
reset_rm_log="$fixture_dir/reset-rm.log"
findmnt(){ return 1; }
rm(){ printf '%s\n' "$*" >>"$reset_rm_log"; return 0; }
mkdir -p "$fixture_dir/reset-data"
export RP_FACTORY_PLAN_STORAGE_BASE_PATH="$fixture_dir/reset-data"
status 0 'factory reset ResourcePortal data cleanup succeeds with mocked removals' rp_reset_remove_rp_data
reset_rm_text="$(cat "$reset_rm_log")"
not_contains "$reset_rm_text" '/var/lib/resourceportal/acme-cache' 'factory reset preserves ACME reuse cache'
unset -f findmnt rm

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All ACME resilience installer tests passed.\n'
