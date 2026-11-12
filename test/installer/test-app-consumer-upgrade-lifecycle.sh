#!/usr/bin/env bash
# A source-to-target upgrade must never install global token interception
# before RP is migrated, healthy and its signed callback probed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/upgrade.sh"
source "$root/scripts/installer/identity.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf '{"version":"0.2.149","apiCapabilities":{"appConsumerActionsV2Callback":true}}\n' > "$tmp/manifest"
printf 'old-stack' > "$tmp/previous.yml"
export RP_CFG_DOMAIN=rp.example.test RP_CFG_RELEASE_VERSION=0.2.146
rp_upgrade_check_temporary_files(){ :; }
rp_config_apply_defaults(){ :; }
rp_verify_release_manifest_attestation(){ :; }
rp_upgrade_rollback_allowed(){ :; }
rp_upgrade_identity_preflight(){ :; }
rp_upgrade_app_consumer_actions_v2_rollback_preflight(){ :; }
rp_pull_release_images(){ :; }
rp_apply_release_manifest_images(){ :; }
rp_upgrade_checkpoint_prepare(){ RP_UPGRADE_ACTIVE_CHECKPOINT="$tmp"; export RP_UPGRADE_ACTIVE_CHECKPOINT; }
rp_upgrade_checkpoint_stage(){ printf 'STAGE:%s\n' "$1"; }
rp_upgrade_checkpoint_phase(){ printf 'PHASE:%s\n' "$1"; }
rp_upgrade_ensure_v020_node_labels(){ :; }
rp_upgrade_refresh_firewall(){ :; }
rp_upgrade_quiesce_database_clients(){ printf 'QUIESCE\n'; }
rp_upgrade_database_snapshot_prepare(){ printf 'SNAPSHOT\n'; }
rp_upgrade_prepare_postgres_services(){ printf 'POSTGRES\n'; }
rp_upgrade_prepare_zitadel_for_mcp_oauth(){ printf 'ZITADEL\n'; }
rp_run_zitadel_mcp_oauth_reconcile(){ printf 'MCP\n'; }
rp_app_action_prepare(){ printf 'PROVISION\n'; }
rp_app_action_checkpoint_record(){ printf 'ACTION-JOURNAL\n'; }
rp_invitation_oidc_prepare(){ printf 'INVITATION-READY\n'; }
rp_invitation_oidc_rollback_recover(){ printf 'INVITATION-RECOVER:%s\n' "$1"; }
rp_run_migrations(){ printf 'MIGRATE\n'; }
rp_deploy_control_plane(){ printf 'DEPLOY\n'; }
rp_wait_for_https_origin(){ printf 'HEALTH\n'; }
rp_upgrade_wait_for_tenant_oidc_ready(){ printf 'OIDC-READY\n'; }
rp_app_action_activate(){
  printf 'ACTION-ACTIVATE\n'
  [[ "${FORCE_ACTION_FAIL:-false}" != true ]]
}
rp_upgrade_refresh_enrollment_listener(){ printf 'ENROLL\n'; }
rp_persist_release_manifest(){ printf '%s\n' "$tmp/manifest"; }
rp_config_write(){ printf 'CONFIG\n'; }
rp_write_stack(){ printf 'STACK-PERSIST\n'; }
rp_manifest_value(){ printf '0.2.149\n'; }
rp_upgrade_source_rollback_policy(){ printf 'image-only\n'; }
rp_upgrade_database_restore(){ printf 'DB-RESTORED\n'; }
rp_app_action_checkpoint_detach(){ printf 'ACTION-DETACHED\n'; }
rp_swarm_stack_deploy_retry(){ printf 'OLD-STACK\n'; }
rp_ensure_rollback_agent_capabilities(){ :; }
rp_upgrade_checkpoint_verify(){ :; }
rp_upgrade_restore_manifest_checkpoint(){ :; }
testcase(){
  local expect_fail="$1"
  export FORCE_ACTION_FAIL="$expect_fail"
  if [[ "$expect_fail" == true ]]; then
    if rp_upgrade_apply "$tmp/manifest" "$tmp/previous.yml" >"$tmp/trace" 2>"$tmp/err"; then
      echo 'FAIL: action activation error allowed candidate release to succeed' >&2; exit 1
    fi
  else
    rp_upgrade_apply "$tmp/manifest" "$tmp/previous.yml" >"$tmp/trace" 2>"$tmp/err"
  fi
  local actual expected
  actual="$(grep -Ev '^(STAGE|PHASE):' "$tmp/trace" | grep -v '^$')"
  if [[ "$expect_fail" == true ]]; then
    expected="$(printf '%s\n' QUIESCE SNAPSHOT POSTGRES ZITADEL MCP PROVISION ACTION-JOURNAL INVITATION-READY MIGRATE DEPLOY HEALTH ACTION-ACTIVATE DB-RESTORED ACTION-DETACHED OLD-STACK HEALTH INVITATION-RECOVER:image-only)"
  else
    expected="$(printf '%s\n' QUIESCE SNAPSHOT POSTGRES ZITADEL MCP PROVISION ACTION-JOURNAL INVITATION-READY MIGRATE DEPLOY HEALTH ACTION-ACTIVATE OIDC-READY ENROLL CONFIG STACK-PERSIST)"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: unexpected upgrade/rollback stage order (failed=%s)\nEXPECTED:\n%s\nACTUAL:\n%s\n' "$expect_fail" "$expected" "$actual" >&2; exit 1
  fi
}
testcase false
echo 'PASS: standard upgrade activates ZITADEL Action only after migrated RP API and HTTPS health, before dependent OIDC readiness'
testcase true
echo 'PASS: failed Action activation restores database before detach, and detach before previous stack'

# Integration regression: actual v0.2.146 -> v0.2.149 installer apply with
# sparse ZITADEL Actions V2 response. Other components are mocked here;
# real Swarm/ZITADEL validation remains a separate release gate.
source "$root/scripts/installer/app-consumer-actions.sh"
# This fixture isolates legacy Action pagination/rollback ordering; the
# invitation client is verified separately by test-invitation-oidc-upgrade.sh.
rp_invitation_oidc_preflight(){ :; }
rp_invitation_oidc_prepare(){ :; }
export RP_CFG_RELEASE_VERSION=0.2.146 RP_CFG_ZITADEL_DOMAIN=auth.example.test
export RP_CFG_ZITADEL_ORGANIZATION_ID=123456789
unset RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED
mock_target=123456789
mock_signing_key=mock-only-app-consumer-key-more-than-32-bytes
mock_execution=none
mock_create_count=0
mock_execution_writes=0
mock_search_error=false
rp_app_action_http() {
  local method="$1" path="$2" reply_file="$3" request=''
  if (( $# >= 4 )); then request="$4"; fi
  case "$method $path" in
    'POST /v2/actions/executions/search')
      [[ "$mock_search_error" != true ]] || return 22
      if [[ "$mock_execution" == none ]]; then
        printf '{"pagination":{"appliedLimit":"100"}}\n' >"$reply_file"
      else
        jq -n --arg id "$mock_target" \
          '{pagination:{appliedLimit:"100",totalResult:"1"},
            executions:[{condition:{function:{name:"preaccesstoken"}},targets:[$id]}]}' >"$reply_file"
      fi ;;
    'POST /v2/actions/targets')
      jq -e --arg url "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" \
        '.endpoint == $url and .restWebhook.interruptOnError == true and .payloadType == "PAYLOAD_TYPE_JSON"' \
        "$request" >/dev/null || return 1
      ((mock_create_count+=1))
      jq -n --arg id "$mock_target" '{id:$id}' >"$reply_file" ;;
    "GET /v2/actions/targets/$mock_target")
      jq -n --arg id "$mock_target" --arg key "$mock_signing_key" \
        --arg url "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" \
        '{target:{id:$id,signingKey:$key,endpoint:$url,payloadType:"PAYLOAD_TYPE_JSON",
                  restWebhook:{interruptOnError:true}}}' >"$reply_file" ;;
    'PUT /v2/actions/executions')
      [[ "$mock_execution" == none ]] || return 1
      jq -e --arg id "$mock_target" \
        '.condition.function.name=="preaccesstoken" and .targets==[$id]' "$request" >/dev/null || return 1
      mock_execution=ours
      ((mock_execution_writes+=1))
      printf '{}\n' >"$reply_file" ;;
    *) printf 'Unexpected mock Actions V2 endpoint: %s %s\n' "$method" "$path" >&2; return 1 ;;
  esac
}
rp_ensure_versioned_swarm_secret() {
  [[ "$1" == rp_app_consumer_action_hmac && "$(cat "$2")" == "$mock_signing_key" ]] || return 1
  printf 'rp_app_consumer_action_hmac_0123456789abcdef\n'
}
rp_versioned_secret_name() {
  [[ "$1" == rp_app_consumer_action_hmac && "$(cat "$2")" == "$mock_signing_key" ]] || return 1
  printf 'rp_app_consumer_action_hmac_0123456789abcdef\n'
}
docker() { [[ "$1 $2" == 'secret inspect' ]]; }
rp_app_action_probe() { [[ "$1" == "$mock_target" && "$2" == rp_app_consumer_action_hmac_0123456789abcdef ]]; }
rp_verify_app_consumer_actions_v2_binding() {
  [[ "$1" == "$mock_target" && "$(cat "$2")" == "$mock_signing_key" ]] || return 1
  local state=invalid
  rp_app_action_execution_state "$1" state && [[ "$state" == ours ]]
}
rp_app_action_checkpoint_record(){ printf 'ACTION-JOURNAL\n'; }
rp_upgrade_apply "$tmp/manifest" "$tmp/previous.yml" >"$tmp/sparse-upgrade.trace" 2>"$tmp/sparse-upgrade.err" || {
  cat "$tmp/sparse-upgrade.err" >&2
  echo 'FAIL: valid sparse Actions V2 page rolled back v0.2.146 -> v0.2.149 upgrade' >&2
  exit 1
}
[[ "$mock_create_count" == 1 && "$mock_execution_writes" == 1 && "$mock_execution" == ours &&
   "$RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED" == true &&
   "$RP_CFG_RELEASE_VERSION" == 0.2.149 ]] || {
  echo 'FAIL: sparse source upgrade did not complete exactly once' >&2; exit 1
}
grep -q 'MIGRATE' "$tmp/sparse-upgrade.trace" &&
grep -q 'DEPLOY' "$tmp/sparse-upgrade.trace" &&
grep -q 'OIDC-READY' "$tmp/sparse-upgrade.trace" || {
  echo 'FAIL: installer did not progress beyond Actions target provisioning' >&2; exit 1
}
echo 'PASS: actual rp_upgrade_apply from v0.2.146 accepts sparse ZITADEL, provisions and activates exact Action once'
rp_app_action_prepare
[[ "$RP_APP_ACTION_UPGRADE_NEW" == false && "$mock_create_count" == 1 &&
   "$mock_execution_writes" == 1 ]] || {
  echo 'FAIL: repeated provisioning created duplicate target or execution' >&2; exit 1
}
echo 'PASS: restarted provisioning reuses certified target and execution with zero duplicates'
# A non-successful Actions V2 search must abort BEFORE a second target is
# created, and the upgrade must execute its normal rollback path.
unset RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED
export RP_CFG_RELEASE_VERSION=0.2.146
mock_execution=none
mock_search_error=true
rp_app_action_checkpoint_detach(){ printf 'ACTION-DETACHED\n'; }
if rp_upgrade_apply "$tmp/manifest" "$tmp/previous.yml" >"$tmp/rejected-upgrade.trace" 2>"$tmp/rejected-upgrade.err"; then
  echo 'FAIL: rejected upstream management request allowed installer upgrade' >&2
  exit 1
fi
grep -q 'App Consumer target provisioning' "$tmp/rejected-upgrade.err" &&
grep -q 'DB-RESTORED' "$tmp/rejected-upgrade.trace" &&
grep -q 'ACTION-DETACHED' "$tmp/rejected-upgrade.trace" &&
grep -q 'OLD-STACK' "$tmp/rejected-upgrade.trace" || {
  echo 'FAIL: provision failure did not invoke normal database/stack rollback' >&2
  exit 1
}
[[ "$mock_create_count" == 1 && "$mock_execution_writes" == 1 ]] || {
  echo 'FAIL: rejected management request created a target or wrote global execution' >&2
  exit 1
}
echo 'PASS: failed/forbidden ZITADEL search aborts provisioning and restores previous databases/stack'

