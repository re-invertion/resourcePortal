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
  local output='' last='' previous='' item
  for item in "$@"; do
    [[ "$item" != *'test-public-pat-not-production'* ]] || fail 'PAT appeared in curl argv'
    [[ "$item" != *'test-only-key-with-more-than-'* ]] || fail 'HMAC key appeared in curl argv'
    if [[ "$previous" == --output ]]; then output="$item"; fi
    previous="$item"
    last="$item"
  done
  [[ "$last" == https://auth.example.test/* && -n "$output" ]] || fail 'unsafe endpoint or missing output'
  [[ -f "$test_tmp/admin.pat" ]] || fail 'missing test PAT'
  if [[ "$last" == */v2/actions/targets/12345678 ]]; then
    case "$test_mode" in
      wrong-key)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://rp.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"wrong-key","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}}' > "$output" ;;
      wrong-callback)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://attacker.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"test-only-key-with-more-than-32-character-bytes-012345","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}}' > "$output" ;;
      not-interrupting)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://rp.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"test-only-key-with-more-than-32-character-bytes-012345","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":false}}}' > "$output" ;;
      *)
        printf '%s\n' '{"target":{"id":"12345678","endpoint":"https://rp.example.test/api/app-consumer-actions/preaccesstoken","signingKey":"test-only-key-with-more-than-32-character-bytes-012345","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}}' > "$output" ;;
    esac
  elif [[ "$last" == */v2/actions/executions/search ]]; then
    case "$test_mode" in
      multiple)
        printf '%s\n' '{"pagination":{"totalResult":2},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]},{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]}]}' > "$output" ;;
      partial)
        printf '%s\n' '{"pagination":{"totalResult":2},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]}]}' > "$output" ;;
      wrong-target)
        printf '%s\n' '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["999"]}]}' > "$output" ;;
      *)
        printf '%s\n' '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["12345678"]}]}' > "$output" ;;
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

printf 'All App Consumer Actions V2 installer preflight tests passed.\n'
