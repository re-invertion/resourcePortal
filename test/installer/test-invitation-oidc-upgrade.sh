#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/app-consumer-actions.sh"

test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
export RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
export RP_CFG_ZITADEL_ORGANIZATION_ID=123456789
export RP_CFG_ZITADEL_PROJECT_ID=987654321
export RP_CFG_ZITADEL_DOMAIN=auth.example.test
export RP_CFG_DOMAIN=rp.example.test
export RP_CFG_OIDC_CLIENT_ID=native-web
export RP_CFG_OIDC_CLI_CLIENT_ID=native-cli
unset RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
mock_created=false mock_post_count=0 mock_secret_found=true mock_wrong_redirect=false
mock_outage=false mock_overflow=false mock_delete_count=0
fail(){ echo "FAIL: $*" >&2; exit 1; }

# A fake HTTPS ZITADEL management API only. All production validation,
# app fingerprint/readback and Swarm-reference decisions run unmodified.
rp_invitation_oidc_http(){
  local method="$1" path="$2" output="$3" body="${4:-}"
  [[ "$mock_outage" != true ]] || return 22
  case "$method $path" in
    'POST /management/v1/projects/987654321/apps/_search')
      jq -e '.query.limit == 100 and (. | has("pagination") | not)' "$body" >/dev/null ||
        fail 'invalid ZITADEL ListApps search pagination schema'
      if [[ "$mock_overflow" == true ]]; then
        printf '{"details":{"totalResult":101},"result":[]}\n' > "$output"
      elif [[ "$mock_created" == true ]]; then
        jq -n '{result:[{id:"321",name:"ResourcePortal Invitation Proof",
            oidcConfig:{clientId:"invitation-physical-123"}}]}' > "$output"
      else printf '{"result":[]}\n' > "$output"; fi ;;
    'POST /management/v1/projects/987654321/apps/oidc')
      jq -e --arg callback "https://rp.example.test/api/invitations/onboard/callback" '
        .redirectUris == [$callback] and
        .grantTypes == ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"] and
        .responseTypes == ["OIDC_RESPONSE_TYPE_CODE"] and
        .authMethodType == "OIDC_AUTH_METHOD_TYPE_BASIC" and
        .appType == "OIDC_APP_TYPE_WEB" and .devMode == false and
        .postLogoutRedirectUris == []
      ' "$body" >/dev/null || fail 'unsafe invitation client creation request'
      ((mock_post_count+=1))
      mock_created=true
      printf '%s\n' '{"appId":"321","clientId":"invitation-physical-123","clientSecret":"confidential-only-test-secret-123456"}' > "$output" ;;
    'DELETE /management/v1/projects/987654321/apps/321')
      ((mock_delete_count+=1))
      mock_created=false
      printf '{}\n' > "$output" ;;
    'GET /management/v1/projects/987654321/apps/321')
      jq -n --arg callback "https://rp.example.test/api/invitations/onboard/callback" \
        --argjson corrupt "$mock_wrong_redirect" '{
          app:{oidcConfig:{clientId:"invitation-physical-123",
            appType:"OIDC_APP_TYPE_WEB",
            authMethodType:"OIDC_AUTH_METHOD_TYPE_BASIC",
            devMode:false,
            responseTypes:["OIDC_RESPONSE_TYPE_CODE"],
            grantTypes:["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
            redirectUris:[(if $corrupt then "https://evil.example.test/callback" else $callback end)]}}
        }' > "$output" ;;
    *) fail "unexpected ZITADEL endpoint $method $path" ;;
  esac
}
docker(){
  if [[ "$1 $2" == 'secret rm' ]]; then
    [[ "$3" == rp_invitation_oidc_secret_0123456789abcdef ]] || return 1
    mock_secret_found=false
    return 0
  fi
  [[ "$1 $2" == 'secret inspect' && "$mock_secret_found" == true &&
     "$3" == rp_invitation_oidc_secret_0123456789abcdef ]]
}
rp_ensure_versioned_swarm_secret(){
  [[ "$1" == rp_invitation_oidc_secret ]] || fail 'wrong logical secret'
  [[ "$(cat "$2")" == confidential-only-test-secret-123456 ]] ||
    fail 'client secret changed before sealed Swarm storage'
  [[ "$(stat -c %a "$2")" == 600 ]] || fail 'client secret not owner-private'
  printf '%s\n' rp_invitation_oidc_secret_0123456789abcdef
}
rp_invitation_oidc_preflight || fail 'valid legacy source unexpectedly blocked'
[[ "$mock_post_count" == 0 ]] || fail 'preflight mutated ZITADEL'

rp_invitation_oidc_prepare || fail 'old certified source did not auto-provision'
[[ "$mock_post_count" == 1 &&
   "$RP_CFG_INVITATION_OIDC_CLIENT_ID" == invitation-physical-123 &&
   "$RP_CFG_INVITATION_OIDC_SWARM_REF" == rp_invitation_oidc_secret_0123456789abcdef ]] ||
  fail 'new client or versioned secret reference not staged'
rp_invitation_oidc_prepare || fail 're-entrant provision failed'
[[ "$mock_post_count" == 1 ]] || fail 'duplicate OAuth client created'
echo 'PASS: v0.2.152 legacy certified Action -> private distinct code-only invitation client, idempotent'

RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=false
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'uncertified Action accepted invitation secret and client references'
fi
RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
mock_wrong_redirect=true
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'wrong redirect URI passed before-shutdown validation'
fi
mock_wrong_redirect=false
mock_secret_found=false
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'missing Swarm secret passed preflight'
fi
mock_secret_found=true
RP_CFG_INVITATION_OIDC_CLIENT_ID=native-web
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'native Web client was reused for invitation flow'
fi
unset RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'orphan client without known secret was silently adopted'
fi
mock_created=false mock_overflow=true
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'incomplete 101-app search page allowed new client creation'
fi
mock_overflow=false mock_outage=true
if rp_invitation_oidc_preflight > /dev/null 2>&1; then
  fail 'unreachable ZITADEL passed preflight'
fi
[[ "$mock_post_count" == 1 ]] || fail 'failed preflight mutated upstream'
echo 'PASS: fail closed before shutdown on client collision, orphan, wrong callback, lost Swarm key and ZITADEL outage'


# Real owner-private recovery journal is exercised independently of the
# unit-test upgrade mock, including a fresh process with no installer refs.
unset RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
export RP_UPGRADE_STATE_DIR="$test_root/upgrade"
export RP_UPGRADE_ACTIVE_CHECKPOINT="$RP_UPGRADE_STATE_DIR"
mkdir -m 700 "$RP_UPGRADE_STATE_DIR"
mock_outage=false
mock_created=false
rp_invitation_oidc_prepare || fail 'checkpointed invitation provisioning failed'
recovery="$RP_UPGRADE_STATE_DIR/invitation-oidc-recovery.json"
[[ -f "$recovery" && ! -L "$recovery" && "$(stat -c %a "$recovery")" == 600 ]] ||
  fail 'missing protected recovery journal'
jq -e --arg client "$RP_CFG_INVITATION_OIDC_CLIENT_ID"   --arg ref "$RP_CFG_INVITATION_OIDC_SWARM_REF" '
  .clientId == $client and .secretRef == $ref and .appId == "321" and
  (has("clientSecret") | not)
' "$recovery" >/dev/null || fail 'journal leaked secret or lost identifiers'
before="$mock_post_count"
unset RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
rp_invitation_oidc_preflight || fail 'rollback replay did not restore verified source refs'
[[ "$RP_CFG_INVITATION_OIDC_CLIENT_ID" == invitation-physical-123 ]] ||
  fail 'rollback recovery client ID mismatch'
rp_invitation_oidc_prepare || fail 'replayed invitation client not reusable'
[[ "$mock_post_count" == "$before" ]] || fail 'image-only rollback created duplicate OIDC app'
rp_invitation_oidc_rollback_recover image-only || fail 'image-only rollback must retain verified refs'
[[ -f "$recovery" && "$mock_created" == true ]] ||
  fail 'image-only rollback deleted reusable confidential client'
echo 'PASS: verified sealed client references survive image-only rollback and re-upgrade'

# No journal may be trusted after wrong issuer/project or permission downgrade.
unset RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
chmod 644 "$recovery"
if rp_invitation_oidc_preflight >/dev/null 2>&1; then
  fail 'insecure journal permissions accepted'
fi
chmod 600 "$recovery"
jq '.appId="666"' "$recovery" > "$test_root/tampered.json"
cp "$test_root/tampered.json" "$recovery"
if rp_invitation_oidc_preflight >/dev/null 2>&1; then
  fail 'wrong physical application ID in owner-private journal accepted'
fi
jq '.appId="321"' "$recovery" > "$test_root/restored.json"
cp "$test_root/restored.json" "$recovery"
RP_CFG_DOMAIN=other.example.test
if rp_invitation_oidc_preflight >/dev/null 2>&1; then
  fail 'wrong-domain recovery journal accepted'
fi
RP_CFG_DOMAIN=rp.example.test
rp_invitation_oidc_preflight || fail 'verified recovery journal unusable after invalid attempt'
echo 'PASS: journal file permissions and physical issuer/callback fingerprint fail closed'

# A tested two-database snapshot reverts the newly provisioned ZITADEL app.
# Its new Swarm secret and recovery journal must be deleted rather than reused.
RP_INVITATION_OIDC_CREATED_IN_ATTEMPT=true
mock_created=false  # represents the restored source ZITADEL database
rp_invitation_oidc_rollback_recover tested ||
  fail 'tested rollback did not remove newly introduced sealed client secret'
[[ ! -e "$recovery" && "$mock_secret_found" == false &&
   -z "${RP_CFG_INVITATION_OIDC_CLIENT_ID:-}" &&
   -z "${RP_CFG_INVITATION_OIDC_SWARM_REF:-}" ]] ||
  fail 'tested DB rollback left an unusable client/secret/journal'
mock_secret_found=true
rp_invitation_oidc_preflight || fail 'tested rollback failed to restore legacy preflight'
echo 'PASS: tested database rollback discards new sealed invitation secret and journal'

# Failed physical app verification must compensate the newly created app
# instead of orphaning it and blocking all future upgrades.
mock_wrong_redirect=true
before="$mock_delete_count"
if rp_invitation_oidc_prepare >/dev/null 2>&1; then
  fail 'malformed client succeeded during fresh provisioning'
fi
[[ "$mock_created" == false && "$mock_delete_count" == "$((before+1))" ]] ||
  fail 'failed verification left an orphaned invitation app'
mock_wrong_redirect=false
rp_invitation_oidc_prepare || fail 'compensated failed create cannot retry'
[[ "$mock_created" == true ]] || fail 'reprovisioning after compensation failed'
echo 'PASS: invalid new physical client is compensated before rollback'
