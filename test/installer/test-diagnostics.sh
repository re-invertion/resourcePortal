#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/diagnostics.sh"
source "$repo_root/scripts/installer/reconfigure.sh"
failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
eq(){ [[ "$1" == "$2" ]] && pass "$3" || fail "$3"; }
status(){ local e="$1" n="$2"; shift 2; set +e; "$@" >/tmp/rp-diag.out 2>/tmp/rp-diag.err; local a=$?; set -e; [[ "$a" == "$e" ]] && pass "$n" || fail "$n"; }

status 0 'primary mode valid' rp_mode_valid primary
status 0 'add-node mode valid' rp_mode_valid add-node
status 0 'upgrade mode valid' rp_mode_valid upgrade
status 0 'reconfigure mode valid' rp_mode_valid reconfigure
status 0 'diagnostics mode valid' rp_mode_valid diagnostics
status 1 'unknown mode rejected' rp_mode_valid destroy-everything

state="$(mktemp /tmp/rp-phase-state.XXXXXX)"; : >"$state"
count="$(mktemp /tmp/rp-phase-count.XXXXXX)"; echo 0 >"$count"
phase_cmd(){ local n; n="$(cat "$count")"; echo $((n+1)) >"$count"; }
rp_run_phase "$state" preflight phase_cmd
rp_run_phase "$state" preflight phase_cmd
eq '1' "$(cat "$count")" 'completed phase is skipped on replay'
status 0 'phase marker detected' rp_phase_done "$state" preflight
rm -f "$state" "$count"

phases="$(rp_primary_phase_names)"
[[ "$phases" == $'preflight\npackages\ndocker\nstorage\nfirewall\nswarm\nnfs\nrelease\nsecrets\nbootstrap\nmigrations\nidentity\nsmtp\ningress\nfinal\nenrollment\npersist' ]] && pass 'Primary phase order is deterministic' || fail 'Primary phase order is deterministic'

status 0 'domain reconfigure allowed' rp_reconfigure_action_valid domain
status 0 'smtp reconfigure allowed' rp_reconfigure_action_valid smtp
status 0 'secret rotation allowed' rp_reconfigure_action_valid rotate-secrets
status 1 'storage migration not silently allowed' rp_reconfigure_action_valid migrate-storage

diag_source="$(cat "$repo_root/scripts/installer/diagnostics.sh")"
for forbidden in 'systemctl restart' 'docker service update' 'docker node update' 'ufw allow' 'mkfs.' 'wipefs --all'; do
  [[ "$diag_source" != *"$forbidden"* ]] && pass "diagnostics excludes mutating command: $forbidden" || fail "diagnostics excludes mutating command: $forbidden"
done

entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
for module in lifecycle diagnostics reconfigure enrollment upgrade releases control-plane identity domain smtp nfs storage filesystem quota docker firewall swarm secrets; do
  [[ "$entrypoint_source" == *"scripts/installer/${module}.sh"* ]] && pass "entrypoint sources ${module}" || fail "entrypoint sources ${module}"
done
[[ "$entrypoint_source" == *'--mode'* ]] && pass 'entrypoint exposes explicit mode selection' || fail 'entrypoint exposes explicit mode selection'
[[ "$entrypoint_source" == *'rp_primary_install'* ]] && pass 'entrypoint dispatches primary lifecycle' || fail 'entrypoint dispatches primary lifecycle'
[[ "$entrypoint_source" == *'rp_redeem_join_bundle'* ]] && pass 'entrypoint dispatches add-node lifecycle' || fail 'entrypoint dispatches add-node lifecycle'
[[ "$entrypoint_source" == *'rp_upgrade_apply'* ]] && pass 'entrypoint dispatches upgrade lifecycle' || fail 'entrypoint dispatches upgrade lifecycle'
[[ "$entrypoint_source" == *'rp_reconfigure'* ]] && pass 'entrypoint dispatches reconfigure lifecycle' || fail 'entrypoint dispatches reconfigure lifecycle'
[[ "$entrypoint_source" == *'rp_run_diagnostics'* ]] && pass 'entrypoint dispatches diagnostics lifecycle' || fail 'entrypoint dispatches diagnostics lifecycle'


lifecycle_source="$(cat "$repo_root/scripts/installer/lifecycle.sh")"
for required in 'rp_collect_primary_config' 'RP_CFG_CLUSTER_CIDR' 'RP_CFG_SWARM_ADVERTISE_ADDR' 'RP_CFG_STORAGE_BASE_PATH' 'RP_CFG_DOMAIN' 'RP_CFG_ZITADEL_DOMAIN' 'RP_CFG_ACME_EMAIL' 'RP_CFG_RELEASE_VERSION' 'RP_ADMIN_EMAIL' 'RP_ADMIN_PASSWORD' 'RP_CFG_SMTP_DEFERRED'; do
  [[ "$lifecycle_source" == *"$required"* ]] && pass "interactive Primary covers $required" || fail "interactive Primary covers $required"
done
[[ "$lifecycle_source" == *'RP_ADMIN_PASSWORD="$(rp_ui_password'* ]] && pass 'admin password is collected with password UI' || fail 'admin password is collected with password UI'
[[ "$entrypoint_source" == *'rp_ui_choice'* ]] && pass 'first run can choose top-level mode interactively' || fail 'first run can choose top-level mode interactively'


[[ "$lifecycle_source" == *'rp_phase_done "$state_file" identity'* ]] && pass 'resume skips first-admin prompts after identity checkpoint' || fail 'resume skips first-admin prompts after identity checkpoint'
[[ "$lifecycle_source" == *'rp_inspect_block_device "$device"'* ]] && pass 'destructive storage shows target identity first' || fail 'destructive storage shows target identity first'
[[ "$lifecycle_source" == *"FORMAT \$device"* ]] && pass 'destructive storage requests exact device confirmation' || fail 'destructive storage requests exact device confirmation'


common_source="$(cat "$repo_root/scripts/installer/common.sh")"
contains_log(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
contains_log "$common_source" '/var/log/resourceportal/installer.log' 'installer has canonical log path'
contains_log "$entrypoint_source" 'rp_log_init' 'entrypoint initializes installer log'
for check in 'ufw status' 'docker node inspect' 'findmnt -nro FSTYPE' 'findmnt -nro UUID' '/etc/fstab' 'ganesha' 'postgres-rp' 'installer-enrollment' 'RP_CFG_API_IMAGE' 'RP_CFG_WEB_IMAGE'; do
  [[ "$diag_source" == *"$check"* ]] && pass "diagnostics covers $check" || fail "diagnostics covers $check"
done


reconfigure_source="$(cat "$repo_root/scripts/installer/reconfigure.sh")"
for behavior in 'rp_primary_configure_smtp' 'rp_ensure_versioned_swarm_secret' 'rp_deploy_control_plane final' 'rp_wait_for_https_origin' 'docker node update' 'resourceportal.control-plane' 'resourceportal.ingress' 'availability drain' 'rp_mount_runtime_namespace' 'rp_install_ganesha_config'; do
  [[ "$reconfigure_source" == *"$behavior"* ]] && pass "reconfigure implements $behavior" || fail "reconfigure implements $behavior"
done
status 0 'address migration reconfigure allowed' rp_reconfigure_action_valid addresses


entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
[[ "$entrypoint_source" == *'--allow-destructive-storage'* ]] && pass 'entrypoint exposes explicit unattended destructive-storage opt-in' || fail 'entrypoint exposes explicit unattended destructive-storage opt-in'
[[ "$lifecycle_source" == *'RP_ALLOW_DESTRUCTIVE_STORAGE'* ]] && pass 'unattended destructive storage requires explicit opt-in' || fail 'unattended destructive storage requires explicit opt-in'
[[ "$entrypoint_source" == *'--repair'* ]] && pass 'entrypoint exposes explicit repair action' || fail 'entrypoint exposes explicit repair action'
[[ "$entrypoint_source" == *'rp_run_repair'* ]] && pass 'repair is dispatched separately from diagnostics' || fail 'repair is dispatched separately from diagnostics'
repair_source="$(cat "$repo_root/scripts/installer/repair.sh" 2>/dev/null || true)"
for action in 'storage-ready' 'ganesha' 'control-plane'; do
  [[ "$repair_source" == *"$action"* ]] && pass "repair supports $action" || fail "repair supports $action"
done
[[ "$repair_source" == *'REPAIR $action'* ]] && pass 'repair requires exact typed confirmation' || fail 'repair requires exact typed confirmation'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer lifecycle/diagnostics tests passed.\n'
