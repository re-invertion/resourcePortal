#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/identity.sh"
source "$repo_root/scripts/installer/secrets.sh"

test_tmp="$(mktemp -d)"
trap 'rm -rf -- "$test_tmp"' EXIT
export RP_CFG_DOMAIN=rp.example.test
export RP_CFG_ZITADEL_DOMAIN=auth.example.test
export RP_CFG_ZITADEL_ORGANIZATION_ID=12345678
export RP_ZITADEL_MANAGEMENT_PAT_FILE="$test_tmp/admin.pat"
printf '%s\n' 'test-public-pat-not-production' > "$test_tmp/admin.pat"
printf '%s' 'test-only-key-with-more-than-32-character-bytes-012345' > "$test_tmp/action.key"
chmod 0600 "$test_tmp/admin.pat" "$test_tmp/action.key"
test_mode=healthy

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
ok() { printf 'PASS: %s\n' "$1"; }

# Mock only HTTPS ZITADEL HTTP replies. The production verifier itself runs
# unchanged with real jq and real private input files.
curl() {
  local mock_response_path='' last='' previous='' item
  for item in "$@"; do
    [[ "$item" != *'test-public-pat-not-production'* ]] || fail 'PAT appeared in curl argv'
    [[ "$item" != *'test-only-key-with-more-than-'* ]] || fail 'HMAC key appeared in curl argv'
    if [[ "$previous" == --output ]]; then mock_response_path="$item"; fi
    previous="$item"
    last="$item"
  done
  [[ "$last" == https://auth.example.test/* && -n "$mock_response_path" ]] || fail 'unsafe endpoint or missing mock_response_path'
  [[ -f "$test_tmp/admin.pat" ]] || fail 'missing test PAT'
  if [[ "$last" == */v2/actions/targets/12345678 ]]; then
    case "$test_mode" in
      wrong-key)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://rp.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"wrong-key","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}}' > "$mock_response_path" ;;
      wrong-callback)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://attacker.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"test-only-key-with-more-than-32-character-bytes-012345","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}}' > "$mock_response_path" ;;
      not-interrupting)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://rp.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"test-only-key-with-more-than-32-character-bytes-012345","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":false}}}' > "$mock_response_path" ;;
      *)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://rp.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"test-only-key-with-more-than-32-character-bytes-012345","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}}' > "$mock_response_path" ;;
    esac
  elif [[ "$last" == */v2/actions/executions/search ]]; then
    case "$test_mode" in
      multiple)
        printf '%s\n' '{"pagination":{"totalResult":2},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]},{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]}]}' > "$mock_response_path" ;;
      partial)
        printf '%s\n' '{"pagination":{"totalResult":2},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]}]}' > "$mock_response_path" ;;
      wrong-target)
        printf '%s\n' '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["999"]}]}' > "$mock_response_path" ;;
      *)
        printf '%s\n' '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]}]}' > "$mock_response_path" ;;
    esac
  else
    fail "unexpected management endpoint"
  fi
}
rp_ensure_versioned_swarm_secret() {
  [[ "$1" == rp_app_consumer_action_hmac && "$2" == "$test_tmp/action.key" ]] || fail 'unexpected secret provisioning'
  touch "$test_tmp/staged"
  printf '%s\n' rp_app_consumer_action_hmac_0123456789abcdef
}

# Read-only verifier must not stage anything: only a completed healthy
# execution can be certified. No tests touch Docker or real ZITADEL.
rp_verify_app_consumer_actions_v2_binding 12345678 "$test_tmp/action.key"
[[ ! -e "$test_tmp/staged" ]] || fail 'read-only verifier staged a secret'
ok 'verified live HTTPS target, key and sole blocking execution'

for test_mode in wrong-key wrong-callback not-interrupting multiple partial wrong-target; do
  if rp_stage_app_consumer_actions_v2_binding 12345678 "$test_tmp/action.key" >/dev/null 2>&1; then
    fail "unsafe target accepted: $test_mode"
  fi
  [[ ! -e "$test_tmp/staged" ]] || fail 'unsafe target staged persistent Docker secret'
  [[ -z "${RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED:-}" ]] || fail 'unsafe target activated installer'
  ok "reject $test_mode before creating a Docker secret"
done

test_mode=healthy
if rp_stage_app_consumer_actions_v2_binding '../escape' "$test_tmp/action.key" >/dev/null 2>&1; then
  fail 'invalid target path accepted'
fi
[[ ! -e "$test_tmp/staged" ]] || fail 'invalid target staged secret'
if rp_stage_app_consumer_actions_v2_binding 12345678 "$test_tmp/missing.key" >/dev/null 2>&1; then
  fail 'missing signing key accepted'
fi
[[ ! -e "$test_tmp/staged" ]] || fail 'missing key staged secret'
ok 'reject malformed input before any external request'

rp_stage_app_consumer_actions_v2_binding 12345678 "$test_tmp/action.key"
[[ -e "$test_tmp/staged" ]] || fail 'verified target not stored in versioned Docker secret'
[[ "$RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED" == true &&
   "$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID" == 12345678 &&
   "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" == rp_app_consumer_action_hmac_0123456789abcdef ]] ||
  fail 'verified target staging did not fill only safe configuration refs'
ok 'real target preflight stages only an immutable Docker secret reference'


# The shared issuer-global Action cannot be switched on in Swarm unless a
# physically separate confidential enrollment client has been registered.
# Mock only the public stack-render dependencies; no Docker operations occur.
source "$repo_root/scripts/installer/control-plane.sh"
rp_acme_resolver_for_state(){ printf 'letsencrypt-production\n'; }
rp_acme_ca_server_for_environment(){ printf 'https://acme.example.test/directory\n'; }
rp_storage_worker_device(){ printf '/dev/mock-storage\n'; }
RP_CFG_API_IMAGE="ghcr.io/rp/api@sha256:$(printf 'a%.0s' {1..64})"
RP_CFG_WEB_IMAGE="ghcr.io/rp/web@sha256:$(printf 'b%.0s' {1..64})"
RP_CFG_POSTGRES_IMAGE="postgres@sha256:$(printf 'c%.0s' {1..64})"
RP_CFG_ZITADEL_IMAGE="zitadel@sha256:$(printf 'd%.0s' {1..64})"
RP_CFG_TRAEFIK_IMAGE="traefik@sha256:$(printf 'e%.0s' {1..64})"
RP_CFG_OIDC_CLIENT_ID=rp-web-physical
RP_CFG_OIDC_CLI_CLIENT_ID=rp-cli-physical
RP_CFG_OIDC_SWARM_REF=rp_web_secret_test
RP_CFG_COOKIE_SWARM_REF=rp_cookie_secret_test
RP_CFG_WORKER_SWARM_REF=rp_worker_secret_test
RP_CFG_ZITADEL_KEY_SWARM_REF=rp_zitadel_key_test
RP_CFG_STORAGE_DEVICE=/dev/mock-storage
RP_CFG_ACME_EMAIL=acme@example.test
RP_CFG_SWARM_ADVERTISE_ADDR=10.1.2.3
RP_CFG_STORAGE_SERVER_ADDRESS=10.1.2.3
RP_CFG_CLUSTER_CIDR=10.0.0.0/8
RP_CFG_ACME_ENVIRONMENT=production

# Uncertified deployments and rollback to an older release must not require
# the new client or secret, or silently render onboarding enabled.
unset RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID \
  RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF
base_stack="$(rp_render_stack final)"
[[ "$base_stack" != *RP_INVITATION_ONBOARDING_ENABLED* &&
   "$base_stack" != *rp_invitation_oidc_secret* ]] || fail 'default stack includes new onboarding secret'
ok 'normal and rollback stacks remain free from optional onboarding client'

RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID=12345678
RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF=rp_app_consumer_action_hmac_0123456789abcdef
if rp_render_stack final >"$test_tmp/invalid-stack.yml" 2>/dev/null; then
  fail 'issuer-global gate activated without verified distinct onboarding client'
fi
RP_CFG_INVITATION_OIDC_CLIENT_ID=rp-web-physical
RP_CFG_INVITATION_OIDC_SWARM_REF=rp_invitation_oidc_secret_0123456789abcdef
if rp_render_stack final >"$test_tmp/invalid-stack.yml" 2>/dev/null; then
  fail 'issuer-global gate reused native RP Web physical client'
fi
RP_CFG_INVITATION_OIDC_CLIENT_ID=rp-cli-physical
if rp_render_stack final >"$test_tmp/invalid-stack.yml" 2>/dev/null; then
  fail 'issuer-global gate reused native RP CLI physical client'
fi
RP_CFG_INVITATION_OIDC_CLIENT_ID=separate-onboard-client
stack="$(rp_render_stack final)"
grep -q 'RP_INVITATION_ONBOARDING_ENABLED: "true"' <<<"$stack" ||
  fail 'certified Action did not enable isolated onboarding in API'
grep -q 'OIDC_INVITATION_CLIENT_ID: "separate-onboard-client"' <<<"$stack" ||
  fail 'stack dropped the exact isolated OIDC client'
grep -q 'OIDC_INVITATION_CLIENT_SECRET_FILE: /run/secrets/rp_invitation_oidc_secret' <<<"$stack" ||
  fail 'stack exposed or omitted the confidential enrollment client secret'
grep -q 'name: rp_invitation_oidc_secret_0123456789abcdef' <<<"$stack" ||
  fail 'stack does not pin the immutable onboarding Swarm secret'
grep -q '      - rp_invitation_oidc_secret' <<<"$stack" ||
  fail 'onboarding secret was not mounted to API'
grep -q 'OIDC_INVITATION_REDIRECT_URI: "https://rp.example.test/api/invitations/onboard/callback"' <<<"$stack" ||
  fail 'isolated callback has incorrect external HTTPS origin'
if grep -Eq 'RP_INVITATION_ONBOARDING_(ENV|SECRET_DECL|API_SECRET)' <<<"$stack"; then
  fail 'onboarding placeholders leaked into rendered stack'
fi
ok 'certified Action requires exact isolated client, HTTPS callback and secret-only Swarm mounting'

printf 'All App Consumer Actions V2 installer preflight tests passed.\n'
