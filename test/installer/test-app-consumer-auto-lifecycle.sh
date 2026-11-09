#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/identity.sh"
source "$root/scripts/installer/secrets.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
export RP_CFG_DOMAIN=rp.example.test RP_CFG_ZITADEL_DOMAIN=auth.example.test
export RP_CFG_ZITADEL_ORGANIZATION_ID=12345678
export RP_ZITADEL_MANAGEMENT_PAT_FILE="$tmp/pat"
printf '%s\n' test-only-management-pat >"$tmp/pat"
key=test-only-generated-hmac-key-more-than-32-character-bytes
id=123456789
remote_execution=none
created=0
writes=0
probe_http=403
partial=false
search_response=''
search_error=''
rp_app_action_http() {
  local method="$1" path="$2" out="$3" payload="${4:-}"
  [[ "$out" == /* && -n "$out" ]] || return 1
  if [[ "$method $path" == 'POST /v2/actions/executions/search' ]]; then
    [[ -z "$search_error" ]] || return "$search_error"
    if [[ -n "$search_response" ]]; then
      printf '%s\n' "$search_response" >"$out"
      return 0
    fi
  fi
  case "$method $path" in
    'POST /v2/actions/executions/search')
      if [[ "$partial" == true ]]; then
        printf '{"pagination":{"totalResult":3},"executions":[]}\n' >"$out"
      elif [[ "$remote_execution" == none ]]; then
        printf '{"pagination":{"totalResult":0},"executions":[]}\n' >"$out"
      else
        local target="$id"
        [[ "$remote_execution" == foreign ]] && target=999999
        jq -n --arg id "$target" \
          '{pagination:{totalResult:1},executions:[{condition:{function:{name:"preaccesstoken"}},targets:[$id]}]}' >"$out"
      fi ;;
    'POST /v2/actions/targets')
      [[ "$remote_execution" == none && "$payload" == /* ]] || return 1
      jq -e --arg url "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" \
        '.endpoint==$url and .restWebhook.interruptOnError==true and .payloadType=="PAYLOAD_TYPE_JSON"' "$payload" >/dev/null
      ((created+=1))
      printf '{"id":"123456789","signingKey":"%s"}\n' "$key" >"$out" ;;
    "GET /v2/actions/targets/$id")
      jq -n --arg id "$id" --arg secret "$key" \
        --arg url "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" \
        '{target:{id:$id,signingKey:$secret,endpoint:$url,payloadType:"PAYLOAD_TYPE_JSON",restWebhook:{interruptOnError:true}}}' >"$out" ;;
    'PUT /v2/actions/executions')
      [[ "$payload" == /* ]] || return 1
      local target
      target="$(jq -r '.targets | if length == 0 then "none" else .[0] end' "$payload")"
      if [[ "$target" == none ]]; then remote_execution=none
      elif [[ "$target" == "$id" ]]; then remote_execution=ours
      else return 1; fi
      ((writes+=1))
      printf '{}\n' >"$out" ;;
    *) printf 'Unexpected ZITADEL Action API call: %s %s\n' "$method" "$path" >&2; return 1 ;;
  esac
}
rp_ensure_versioned_swarm_secret() {
  [[ "$1" == rp_app_consumer_action_hmac && -r "$2" ]] || return 1
  [[ "$(cat "$2")" == "$key" ]] || return 1
  rp_versioned_secret_name "$1" "$2"
}
docker() { [[ "$1 $2" == "secret inspect" ]]; }
# The production readonly verifier is already independently covered by the
# original installer test. Here simulate only its binding postcondition.
rp_verify_app_consumer_actions_v2_binding() {
  [[ "$1" == "$id" && "$(cat "$2")" == "$key" ]] || return 1
  local state
  rp_app_action_execution_state "$1" state
  [[ "$state" == ours ]]
}
# The real signer must not require a host Node binary, leak the key into
# process arguments or open any network inside its ephemeral container.
signer="$(declare -f rp_app_action_sign_probe)"
[[ "$signer" == *"docker run"* && "$signer" == *"--network none"* &&
   "$signer" == *"--read-only"* && "$signer" == *"--cap-drop ALL"* &&
   "$signer" == *"--entrypoint node"* &&
   "$signer" != *"command -v node"* ]] || {
  printf 'FAIL: production signer cannot depend on host Node or an unsafe container.\n' >&2
  exit 1
}
# The real signer executes digest-pinned production Node inside an isolated
# Docker container; mocked installer tests do not require a production image.
# Real HMAC signature validity is separately verified by HTTPS issuer E2E.
rp_app_action_sign_probe() {
  local tmp="$1"
  printf 'header = "ZITADEL-Signature: t=%s,v1=%064d"\n' "$(date +%s)" 0 >"$tmp/conf"
}
# Probe must pass real signing code and recognize only a precise 403.
curl() {
  local previous="" path="" conf="" arg
  for arg in "$@"; do
    [[ "$arg" != *"$key"* && "$arg" != *test-only-management-pat* ]] || return 1
    if [[ "$previous" == --config ]]; then conf="$arg"; fi
    [[ "$arg" == https://* ]] && path="$arg"
    previous="$arg"
  done
  [[ "$path" == "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" ]] || return 1
  grep -Eq '^header = "ZITADEL-Signature: t=[0-9]{10},v1=[a-f0-9]{64}"$' "$conf" || return 1
  [[ "$probe_http" == 403 || "$probe_http" == 503 ]] || return 1
  printf '%s' "$probe_http"
}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'PASS: %s\n' "$*"; }
# Exercise the real parser with the exact sparse ZITADEL v4.17.0 response
# observed when upgrading a v0.2.146 installation. Upstream HTTP failures
# are deliberately distinct from successful empty responses.
assert_search() {
  local response="$1" expected="$2" label="$3" state=untouched
  search_response="$response"
  search_error=''
  if [[ "$expected" == reject ]]; then
    if rp_app_action_execution_state "$id" state >"$tmp/parser.stdout" 2>"$tmp/parser.stderr"; then
      fail "accepted unsafe Actions V2 search response: $label"
    fi
    [[ "$state" == untouched ]] || fail "invalid search modified caller state: $label"
    ! grep -qF "$key" "$tmp/parser.stderr" || fail 'secret leaked into diagnostics'
  else
    rp_app_action_execution_state "$id" state || fail "rejected valid Actions V2 search response: $label"
    [[ "$state" == "$expected" ]] || fail "incorrect search classification: $label (got $state)"
  fi
  ok "$label"
}
assert_search '{"pagination":{"appliedLimit":"100"}}' none 'v0.2.146 sparse empty result (missing executions and totalResult)'
assert_search '{"pagination":{"appliedLimit":100}}' none 'numeric appliedLimit on sparse empty result'
assert_search '{"pagination":{"totalResult":"0","appliedLimit":"100"},"executions":[]}' none 'explicit empty result with string total'
assert_search '{"pagination":{"totalResult":0},"executions":[]}' none 'explicit empty result with number total'
assert_search '{"pagination":{"totalResult":1,"appliedLimit":"100"},"executions":[{"condition":{"function":{"name":"postauthentication"}},"targets":["777"]}]}' none 'complete foreign non-pretoken execution does not block'
assert_search '{"pagination":{"totalResult":1,"appliedLimit":"100"},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["123456789"]}]}' ours 'preexisting exact execution is reused'
assert_search '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["999"]}]}' conflict 'foreign preaccesstoken execution is protected'
assert_search '{"pagination":{"totalResult":2},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["123456789"]},{"condition":{"function":{"name":"preaccesstoken"}},"targets":["999"]}]}' conflict 'duplicate preaccesstoken executions are protected'
assert_search '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["123456789","999"]}]}' conflict 'multiple targets on one preaccesstoken are protected'
assert_search '{"pagination":{"appliedLimit":"99"}}' reject 'unverified sparse result with wrong applied limit'
assert_search '{"pagination":{"appliedLimit":"invalid"}}' reject 'unverified sparse result with malformed applied limit'
assert_search '{"pagination":{"appliedLimit":"100"},"executions":[]}' reject 'missing totalResult for explicit list'
assert_search '{"pagination":{"appliedLimit":"100","totalResult":0}}' reject 'missing executions with only totalResult present'
assert_search '{"pagination":{"totalResult":1},"executions":[]}' reject 'incomplete result count'
assert_search '{"pagination":{"totalResult":0},"executions":[{"condition":{"function":{"name":"preaccesstoken"}},"targets":["123456789"]}]}' reject 'inconsistent zero total'
assert_search '{"pagination":{"totalResult":"1.5"},"executions":[]}' reject 'noninteger result total'
assert_search '{"pagination":{"totalResult":0,"appliedLimit":0},"executions":[]}' reject 'invalid applied limit'
assert_search '{"pagination":{"totalResult":0,"appliedLimit":"101"},"executions":[]}' reject 'excessive applied limit'
assert_search '{"executions":[]}' reject 'missing pagination metadata'
assert_search '{"pagination":{"appliedLimit":"100"},"executions":null}' reject 'null executions'
assert_search '{"pagination":{"totalResult":1},"executions":[{"targets":["123456789"]}]}' reject 'execution missing function condition'
assert_search '{"pagination":{"totalResult":1},"executions":[{"condition":{"function":{"name":false}},"targets":["123456789"]}]}' reject 'nonstring function condition'
assert_search '[]' reject 'non-object response'
assert_search '{}' reject 'missing response metadata'
assert_search 'this is not JSON' reject 'invalid JSON'
# Mocked curl --fail response and timeout semantics: no lack-of-execution inference.
search_response=''
for search_error in 22 28 7; do
  state=untouched
  if rp_app_action_execution_state "$id" state >"$tmp/parser.stdout" 2>"$tmp/parser.stderr"; then
    fail "accepted failed Actions V2 HTTP request (curl $search_error)"
  fi
  [[ "$state" == untouched ]] || fail 'transport error modified state'
  ok "ZITADEL HTTP failure/authorization/timeout (curl $search_error) blocked"
done
search_error=''
search_response=''
# Unknown foreign pre-token execution must be protected, never overwritten.
remote_execution=foreign
if rp_app_action_prepare >/dev/null 2>&1; then fail 'overwrote unrelated execution'; fi
[[ "$created" == 0 && "$writes" == 0 ]] || fail 'foreign action modified'
ok 'foreign execution untouched'
remote_execution=none
partial=true
if rp_app_action_prepare >/dev/null 2>&1; then fail 'accepted incomplete pagination'; fi
[[ "$created" == 0 ]] || fail 'created on partial result'
partial=false
ok 'incomplete execution search blocks provisioning'
rp_app_action_prepare
[[ "$created" == 1 && "$writes" == 0 &&
   "$RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED" == true &&
   "$RP_APP_ACTION_UPGRADE_NEW" == true ]] || fail 'target not staged without execution'
ref="$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF"
[[ "$ref" == rp_app_consumer_action_hmac_* ]] || fail 'bad secret ref'
ok 'target + immutable Docker secret automatically provisioned without global hook'
probe_http=503
if rp_app_action_activate >/dev/null 2>&1; then fail 'activated unhealthy callback'; fi
[[ "$remote_execution" == none && "$writes" == 0 ]] || fail 'mutated global execution before callback health'
ok 'callback HTTP 503 blocks global activation'
probe_http=403
rp_app_action_activate
[[ "$remote_execution" == ours && "$writes" == 1 ]] || fail 'did not activate exact hook'
ok 'signed HTTPS negative probe precedes exact global execution binding'
rp_app_action_activate
[[ "$writes" == 1 ]] || fail 'idempotent re-activation rewrote execution'
ok 'repeated activation is idempotent'
# Replay same config and target across a later automatic update.
rp_app_action_prepare
[[ "$RP_APP_ACTION_UPGRADE_NEW" == false && "$created" == 1 ]] || fail 'unnecessary target rotation'
ok 'subsequent update verifies and reuses the existing bound target'
# A failed first-upgrade rollback must detach only its own exact binding.
printf '{"appConsumerAction":{"introduced":true,"targetId":"%s","secretRef":"%s"}}\n' "$id" "$ref" >"$tmp/state.json"
rp_app_action_checkpoint_detach "$tmp"
[[ "$remote_execution" == none && "$writes" == 2 ]] || fail 'rollback did not detach'
rp_app_action_checkpoint_detach "$tmp"
[[ "$writes" == 2 ]] || fail 'rollback detach not idempotent'
ok 'rollback safely detaches new execution; replay is idempotent'
remote_execution=foreign
if rp_app_action_checkpoint_detach "$tmp" >/dev/null 2>&1; then fail 'detached foreign hook'; fi
[[ "$remote_execution" == foreign ]] || fail 'foreign hook changed'
ok 'rollback refuses foreign execution'
remote_execution=ours
printf '{"appConsumerAction":{"introduced":false,"targetId":"%s","secretRef":"%s"}}\n' "$id" "$ref" >"$tmp/state.json"
rp_app_action_checkpoint_detach "$tmp"
[[ "$remote_execution" == ours ]] || fail 'detached compatible source action'
ok 'rollback from already-enabled source preserves its bound action'
echo 'App Consumer automatic installer lifecycle regression passed.'
