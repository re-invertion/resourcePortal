#!/usr/bin/env bash
# A source-to-target upgrade must never install global token interception
# before RP is migrated, healthy and its signed callback probed.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/upgrade.sh"
source "$root/scripts/installer/identity.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf '{"version":"0.2.147","apiCapabilities":{"appConsumerActionsV2Callback":true}}\n' > "$tmp/manifest"
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
rp_manifest_value(){ printf '0.2.147\n'; }
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
    expected="$(printf '%s\n' QUIESCE SNAPSHOT POSTGRES ZITADEL MCP PROVISION ACTION-JOURNAL MIGRATE DEPLOY HEALTH ACTION-ACTIVATE DB-RESTORED ACTION-DETACHED OLD-STACK HEALTH)"
  else
    expected="$(printf '%s\n' QUIESCE SNAPSHOT POSTGRES ZITADEL MCP PROVISION ACTION-JOURNAL MIGRATE DEPLOY HEALTH ACTION-ACTIVATE OIDC-READY ENROLL CONFIG STACK-PERSIST)"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: unexpected upgrade/rollback stage order (failed=%s)\nEXPECTED:\n%s\nACTUAL:\n%s\n' "$expect_fail" "$expected" "$actual" >&2; exit 1
  fi
}
testcase false
echo 'PASS: standard upgrade activates ZITADEL Action only after migrated RP API and HTTPS health, before dependent OIDC readiness'
testcase true
echo 'PASS: failed Action activation restores database before detach, and detach before previous stack'
