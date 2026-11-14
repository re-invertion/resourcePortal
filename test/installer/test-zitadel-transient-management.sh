#!/usr/bin/env bash
# #444: real installer HTTP wrappers must tolerate only transient READ errors.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/app-consumer-actions.sh"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
export RP_CFG_ZITADEL_DOMAIN=auth.example.test
export RP_CFG_ZITADEL_ORGANIZATION_ID=12345678
export RP_CFG_ZITADEL_PROJECT_ID=99887766
export RP_ZITADEL_MANAGEMENT_PAT_FILE="$scratch/pat"
printf '%s\n' 'inert-zitadel-management-pat-do-not-log' >"$scratch/pat"
chmod 0600 "$scratch/pat"
mode=recover
fail(){ printf 'FAIL #444: %s\n' "$*" >&2; exit 1; }
sleep(){ [[ "$1" == 3 ]] || fail 'unbounded retry interval'; }
reset(){ mode="$1"; : > "$scratch/calls"; }
count(){ wc -l < "$scratch/calls"; }

# Mock at the network boundary, never mock installer validation. Require the
# exact HTTPS URL, Bearer PAT only via owner-private curl config, and TLS checks.
curl() {
  local output='' url='' prev='' item write_status=false config='' method=''
  local proto=false insecure=false redirected=false
  for item in "$@"; do
    case "$prev" in
      --output) output="$item" ;;
      --config) config="$item" ;;
      --request) method="$item" ;;
      --proto) [[ "$item" == '=https' ]] && proto=true ;;
    esac
    [[ "$item" != --write-out ]] || write_status=true
    [[ "$item" != --insecure && "$item" != -k ]] || insecure=true
    [[ "$item" != --location && "$item" != -L ]] || redirected=true
    url="$item"; prev="$item"
  done
  [[ "$url" == https://auth.example.test/* && "$proto" == true &&
     "$insecure" == false && "$redirected" == false &&
     "$output" == "$scratch"/* && -r "$config" ]] ||
    fail 'unsafe ZITADEL request: HTTPS, TLS, no redirects and config required'
  [[ "$(cat "$config")" == *'Authorization: Bearer inert-zitadel-management-pat-do-not-log'* ]] ||
    fail 'request lost private authenticated config'
  for item in "$@"; do
    [[ "$item" != *'inert-zitadel-management-pat-do-not-log'* ]] ||
      fail 'PAT leaked in command line'
  done
  printf '%s %s\n' "$method" "$url" >> "$scratch/calls"
  local attempt
  attempt="$(count)"
  case "$mode" in
    recover)
      if [[ "$attempt" == 1 ]]; then
        printf '{"message":"Traefik no router"}' > "$output"
        [[ "$write_status" != true ]] || printf '404'
        return 0
      elif [[ "$attempt" == 2 ]]; then
        [[ "$write_status" != true ]] || printf '000'
        return 35
      fi
      printf '%s\n' '{"result":[]}' > "$output"
      [[ "$write_status" != true ]] || printf '200'
      return 0 ;;
    always404)
      printf '{"message":"Not Found"}' > "$output"
      [[ "$write_status" != true ]] || printf '404'
      return 0 ;;
    unauthorized)
      printf '{"message":"Unauthorized"}' > "$output"
      [[ "$write_status" != true ]] || printf '401'
      return 0 ;;
    badcertificate)
      [[ "$write_status" != true ]] || printf '000'
      return 60 ;;
    malformed)
      printf '%s\n' '{"result":"not-an-array"}' > "$output"
      [[ "$write_status" != true ]] || printf '200'
      return 0 ;;
    write-failure)
      [[ "$write_status" == false ]] || fail 'write operation was converted to retrying read'
      return 22 ;;
    *) fail 'missing fixture' ;;
  esac
}

printf '{"query":{"limit":100}}\n' > "$scratch/search"
printf '{"pagination":{"limit":100}}\n' > "$scratch/action-search"
reset recover
rp_invitation_oidc_search "$scratch/apps" 2> "$scratch/log" ||
  fail 'POST /management/apps/_search did not recover after transient 404 and curl 35'
[[ "$(count)" == 3 ]] || fail 'search must retry exactly 404 then curl35 then HTTP200'
grep -q 'invitation-oidc.*method=POST.*apps/_search.*http=404.*retrying' "$scratch/log" ||
  fail 'missing sanitized method/path/404 diagnostic'
grep -q 'invitation-oidc.*method=POST.*apps/_search.*curl=35.*retrying' "$scratch/log" ||
  fail 'missing sanitized broken-TLS diagnostic'
! grep -q 'inert-zitadel-management-pat-do-not-log' "$scratch/log" ||
  fail 'PAT leaked in retry log'
printf 'PASS: ZITADEL Management POST /search 404 → TLS curl35 → 200 recovered with TLS preserved\n'

reset recover
rp_app_action_http GET /v2/actions/targets/123456 "$scratch/target" 2> "$scratch/log" ||
  fail 'Actions V2 GET target failed after transient 404 and TLS drop'
[[ "$(count)" == 3 ]] || fail 'Actions V2 GET should recover in three attempts'
printf 'PASS: Actions V2 target read recovered through the exact authenticated HTTPS route\n'

reset recover
rp_app_action_http POST /v2/actions/executions/search "$scratch/executions" "$scratch/action-search" 2> "$scratch/log" ||
  fail 'read-only Actions V2 execution search did not recover'
[[ "$(count)" == 3 ]] || fail 'Actions V2 execution read should retry'
printf 'PASS: Actions V2 issuer-global execution search remains verifiable after transient routing loss\n'

reset always404
if rp_invitation_oidc_search "$scratch/apps" 2> "$scratch/log"; then
  fail 'permanent missing management endpoint was treated as an empty app listing'
fi
[[ "$(count)" == 6 ]] || fail 'persistent 404 must stop after bounded attempts'
grep -q 'attempt=6/6.*http=404.*stopped' "$scratch/log" ||
  fail 'persistent 404 did not fail closed with final diagnostic'
printf 'PASS: persistent 404 fails closed, no fallback to empty ZITADEL configuration\n'

reset unauthorized
if rp_app_action_http GET /v2/actions/targets/123456 "$scratch/target" 2> "$scratch/log"; then
  fail 'HTTP 401 was accepted by Actions V2 read'
fi
[[ "$(count)" == 1 ]] || fail 'authentication failure must not be retried'
printf 'PASS: management authorization errors reject immediately\n'

reset badcertificate
if rp_invitation_oidc_search "$scratch/apps" 2> "$scratch/log"; then
  fail 'curl certificate validation error 60 was accepted'
fi
[[ "$(count)" == 6 ]] || fail 'certificate error must fail after finite verified attempts'
printf 'PASS: TLS certificate error never bypassed by retry\n'

reset malformed
if rp_invitation_oidc_search "$scratch/apps" 2> "$scratch/log"; then
  fail 'HTTP 200 malformed/incomplete ZITADEL listing bypassed schema check'
fi
[[ "$(count)" == 1 ]] || fail 'invalid JSON shape must not be retried as a network outage'
printf 'PASS: valid HTTP status cannot bypass response-shape validation\n'

reset write-failure
if rp_invitation_oidc_http POST /management/v1/projects/99887766/apps/oidc "$scratch/created" "$scratch/search" 2> "$scratch/log"; then
  fail 'non-idempotent client creation unexpectedly succeeded'
fi
[[ "$(count)" == 1 ]] || fail 'installer retried client creation after an ambiguous write failure'
reset write-failure
if rp_app_action_http POST /v2/actions/targets "$scratch/created" "$scratch/search" 2> "$scratch/log"; then
  fail 'non-idempotent Action target creation unexpectedly succeeded'
fi
[[ "$(count)" == 1 ]] || fail 'installer retried Action target creation'
printf 'PASS: mutating ZITADEL calls are never automatically replayed\n'

printf 'All #444 transient management verification regressions passed.\n'
