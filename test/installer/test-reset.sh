#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/config.sh"
source "$repo_root/scripts/installer/ownership.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reset.sh"

failures=0
assert_eq() {
  local expected="$1" actual="$2" name="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$name" "$expected" "$actual" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_status() {
  local expected="$1" name="$2"; shift 2
  set +e
  "$@" >/tmp/rp-installer-reset.out 2>/tmp/rp-installer-reset.err
  local actual=$?
  set -e
  assert_eq "$expected" "$actual" "$name"
}
assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nmissing: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL: %s\nunexpected: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_file_exists() {
  local path="$1" name="$2"
  [[ -e "$path" ]] && printf 'PASS: %s\n' "$name" || { printf 'FAIL: %s\nmissing file: %s\n' "$name" "$path" >&2; failures=$((failures + 1)); }
}
assert_file_missing() {
  local path="$1" name="$2"
  [[ ! -e "$path" ]] && printf 'PASS: %s\n' "$name" || { printf 'FAIL: %s\nunexpected file: %s\n' "$name" "$path" >&2; failures=$((failures + 1)); }
}

assert_status 0 'reset mode valid' rp_mode_valid reset
assert_status 0 'settings scope valid' rp_reset_scope_valid settings
assert_status 0 'installer-state scope valid' rp_reset_scope_valid installer-state
assert_status 0 'factory scope valid' rp_reset_scope_valid factory
assert_status 1 'unknown reset scope rejected' rp_reset_scope_valid wipe

entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
assert_contains "$entrypoint_source" '--scope' 'help/parser supports reset scope'
assert_contains "$entrypoint_source" '--confirm-factory-reset' 'parser supports factory confirmation flag'
assert_contains "$entrypoint_source" '--force-remove-untracked-packages' 'parser supports legacy package override'
assert_contains "$entrypoint_source" 'Reset / Clear ResourcePortal' 'interactive mode chooser exposes reset'

source "$repo_root/resourceportal-install.sh"

main_noninteractive_without_scope() (
  unset RP_CFG_MODE RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
  rp_require_root() { :; }
  rp_log_init() { :; }
  rp_ui_init() { RP_UI_MODE=text; export RP_UI_MODE; }
  rp_ui_cleanup() { :; }
  rp_main --config /definitely/missing.conf --mode reset --non-interactive
)
assert_status 2 'non-interactive reset requires explicit scope' main_noninteractive_without_scope

main_settings_rejects_factory_flag() (
  unset RP_CFG_MODE RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
  rp_require_root() { :; }
  rp_log_init() { :; }
  rp_ui_init() { RP_UI_MODE=text; export RP_UI_MODE; }
  rp_ui_cleanup() { :; }
  rp_main --config /definitely/missing.conf --mode reset --scope settings --confirm-factory-reset
)
assert_status 2 'settings rejects factory-only confirmation flag' main_settings_rejects_factory_flag

main_interactive_scope_choice() (
  unset RP_CFG_MODE RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
  rp_require_root() { :; }
  rp_log_init() { :; }
  rp_ui_init() { RP_UI_MODE=text; export RP_UI_MODE; }
  rp_ui_cleanup() { :; }
  rp_ui_choice() { printf 'settings\n'; }
  rp_reset() { printf 'RESET:%s\n' "$1"; }
  rp_main --config /definitely/missing.conf --mode reset
)
interactive_out="$(main_interactive_scope_choice 2>/tmp/rp-reset-interactive.err || true)"
assert_contains "$interactive_out" 'RESET:settings' 'interactive reset prompts and dispatches selected scope'

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
RP_INSTALLER_STATE_DIR="$tmpdir/state"
RP_PRIMARY_STATE_FILE="$RP_INSTALLER_STATE_DIR/primary.state"
RP_INSTALLER_CONFIG_FILE="$tmpdir/installer.conf"
RP_CFG_STORAGE_BASE_PATH="$tmpdir/storage"
RP_OWNERSHIP_MANIFEST="$RP_INSTALLER_STATE_DIR/owned-resources"
export RP_INSTALLER_STATE_DIR RP_PRIMARY_STATE_FILE RP_INSTALLER_CONFIG_FILE RP_CFG_STORAGE_BASE_PATH RP_OWNERSHIP_MANIFEST
mkdir -p "$RP_INSTALLER_STATE_DIR" "$RP_CFG_STORAGE_BASE_PATH"

printf 'RP_CFG_MODE=primary\n' >"$RP_INSTALLER_CONFIG_FILE"
rp_reset_active_control_plane() { return 1; }
rp_reset_settings
assert_file_missing "$RP_INSTALLER_CONFIG_FILE" 'safe incomplete settings reset removes config'

printf 'RP_CFG_MODE=primary\n' >"$RP_INSTALLER_CONFIG_FILE"
printf 'final\n' >"$RP_PRIMARY_STATE_FILE"
assert_status 1 'final checkpoint refuses settings reset' rp_reset_settings
assert_file_exists "$RP_INSTALLER_CONFIG_FILE" 'final checkpoint preserves config'

printf 'preflight\n' >"$RP_PRIMARY_STATE_FILE"
rp_reset_active_control_plane() { return 0; }
assert_status 1 'active control plane refuses settings reset' rp_reset_settings
assert_file_exists "$RP_INSTALLER_CONFIG_FILE" 'active control plane preserves config'

rp_reset_active_control_plane() { return 1; }
mkdir -p "$RP_INSTALLER_STATE_DIR/secrets" "$RP_CFG_STORAGE_BASE_PATH/platform/databases/resourceportal-postgres"
printf 'secret-state\n' >"$RP_INSTALLER_STATE_DIR/secrets/encryption"
printf 'db-state\n' >"$RP_CFG_STORAGE_BASE_PATH/platform/databases/resourceportal-postgres/PG_VERSION"
printf 'preflight\n' >"$RP_PRIMARY_STATE_FILE"
printf 'package nfs-ganesha\n' >"$RP_OWNERSHIP_MANIFEST"
mountpoint() { [[ "$2" == /mnt/resourceportal/platform ]]; }
assert_status 1 'protected runtime refuses installer-state reset' rp_reset_installer_state
assert_file_exists "$RP_PRIMARY_STATE_FILE" 'protected reset preserves primary checkpoint'
assert_file_exists "$RP_OWNERSHIP_MANIFEST" 'protected reset preserves ownership manifest'
unset -f mountpoint

rm -rf "$RP_INSTALLER_STATE_DIR/secrets" "$RP_CFG_STORAGE_BASE_PATH/platform/databases/resourceportal-postgres"
printf 'preflight\npackages\n' >"$RP_PRIMARY_STATE_FILE"
printf '{}\n' >"$RP_INSTALLER_STATE_DIR/release.json"
mkdir -p "$RP_INSTALLER_STATE_DIR/enrollment" "$RP_INSTALLER_STATE_DIR/identity-bootstrap"
printf 'keep\n' >"$RP_OWNERSHIP_MANIFEST"
rp_reset_runtime_mount_present() { return 1; }
rp_reset_managed_swarm_secret_present() { return 1; }
rp_reset_installer_state
assert_file_missing "$RP_PRIMARY_STATE_FILE" 'safe installer-state reset removes primary checkpoint'
assert_file_missing "$RP_INSTALLER_STATE_DIR/release.json" 'safe installer-state reset removes release replay state'
assert_file_exists "$RP_OWNERSHIP_MANIFEST" 'safe installer-state reset preserves provenance manifest'

RP_RESET_STATE_DIR="$tmpdir/reset-state"
RP_FACTORY_RESET_STATE="$RP_RESET_STATE_DIR/factory.state"
RP_FACTORY_RESET_PLAN="$RP_RESET_STATE_DIR/factory.plan"
export RP_RESET_STATE_DIR RP_FACTORY_RESET_STATE RP_FACTORY_RESET_PLAN

RP_NON_INTERACTIVE=true
RP_CONFIRM_FACTORY_RESET=false
RP_ALLOW_DESTRUCTIVE_STORAGE=true
export RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_ALLOW_DESTRUCTIVE_STORAGE
assert_status 1 'noninteractive factory requires explicit factory flag' rp_reset_factory_confirm
RP_CONFIRM_FACTORY_RESET=true
RP_ALLOW_DESTRUCTIVE_STORAGE=false
assert_status 1 'noninteractive factory also requires destructive storage flag' rp_reset_factory_confirm

RP_NON_INTERACTIVE=false
RP_CONFIRM_FACTORY_RESET=false
RP_ALLOW_DESTRUCTIVE_STORAGE=false
rp_ui_input() { printf 'wrong\n'; }
assert_status 1 'wrong interactive factory phrase aborts' rp_reset_factory_confirm
rp_ui_input() { printf 'FACTORY RESET RESOURCEPORTAL\n'; }
assert_status 0 'exact interactive factory phrase succeeds' rp_reset_factory_confirm
unset -f rp_ui_input

RP_FACTORY_PLAN_STACK=resourceportal-control-plane
RP_FACTORY_PLAN_STORAGE_DEVICE=/dev/sdb
RP_FACTORY_PLAN_STORAGE_PARTITION=/dev/sdb1
RP_FACTORY_PLAN_STORAGE_BASE_PATH=/srv/resource-portal/storage
RP_FACTORY_PLAN_STORAGE_MOUNTPOINT=/srv/resource-portal/storage
RP_FACTORY_PLAN_STORAGE_FINGERPRINT='type=disk;size=2147483648;id=ID_SERIAL=SERIAL-123'
RP_FACTORY_PLAN_DOCKER_REMOVE=true
RP_FACTORY_PLAN_PACKAGE_TRACKING=tracked
RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES=false
export RP_FACTORY_PLAN_STACK RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION \
  RP_FACTORY_PLAN_STORAGE_BASE_PATH RP_FACTORY_PLAN_STORAGE_MOUNTPOINT RP_FACTORY_PLAN_STORAGE_FINGERPRINT \
  RP_FACTORY_PLAN_DOCKER_REMOVE RP_FACTORY_PLAN_PACKAGE_TRACKING RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES
rp_reset_factory_plan_write
assert_eq 600 "$(stat -c '%a' "$RP_FACTORY_RESET_PLAN")" 'factory plan is root-only'
unset RP_FACTORY_PLAN_STACK RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION \
  RP_FACTORY_PLAN_STORAGE_BASE_PATH RP_FACTORY_PLAN_STORAGE_MOUNTPOINT RP_FACTORY_PLAN_STORAGE_FINGERPRINT \
  RP_FACTORY_PLAN_DOCKER_REMOVE RP_FACTORY_PLAN_PACKAGE_TRACKING RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES
rp_reset_factory_plan_load
assert_eq resourceportal-control-plane "$RP_FACTORY_PLAN_STACK" 'factory plan restores stack'
assert_eq /dev/sdb "$RP_FACTORY_PLAN_STORAGE_DEVICE" 'factory plan restores storage device'
printf 'unknown=value\n' >>"$RP_FACTORY_RESET_PLAN"
assert_status 1 'factory plan rejects unknown keys' rp_reset_factory_plan_load
# Restore clean plan for subsequent checks.
sed -i '/^unknown=/d' "$RP_FACTORY_RESET_PLAN"

summary="$(rp_reset_factory_summary)"
assert_contains "$summary" 'resourceportal-control-plane' 'factory summary includes stack name'
assert_contains "$summary" '/dev/sdb' 'factory summary includes storage device'
assert_contains "$summary" '/srv/resource-portal/storage' 'factory summary includes storage path'
assert_contains "$summary" 'Docker removal: true' 'factory summary includes Docker decision'
assert_contains "$summary" 'Package tracking: tracked' 'factory summary includes package tracking state'
assert_contains "$summary" 'tenant volumes and databases will be destroyed' 'factory summary warns about tenant/database destruction'
assert_contains "$summary" 'leave Docker Swarm' 'factory summary warns about Swarm leave'

preflight_base() {
  RP_NON_INTERACTIVE=true
  RP_CONFIRM_FACTORY_RESET=true
  RP_ALLOW_DESTRUCTIVE_STORAGE=true
  RP_FORCE_REMOVE_UNTRACKED_PACKAGES=false
  RP_OWNERSHIP_MANIFEST="$tmpdir/preflight-owned"
  RP_FACTORY_RESET_PLAN="$tmpdir/preflight.plan"
  RP_RESET_STATE_DIR="$tmpdir/preflight-state"
  RP_FACTORY_RESET_STATE="$RP_RESET_STATE_DIR/factory.state"
  RP_CFG_STACK_NAME=resourceportal-control-plane
  RP_CFG_STORAGE_BASE_PATH=/srv/resource-portal/storage
  RP_CFG_STORAGE_MOUNTPOINT=/srv/resource-portal/storage
  export RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_ALLOW_DESTRUCTIVE_STORAGE RP_FORCE_REMOVE_UNTRACKED_PACKAGES \
    RP_OWNERSHIP_MANIFEST RP_FACTORY_RESET_PLAN RP_RESET_STATE_DIR RP_FACTORY_RESET_STATE RP_CFG_STACK_NAME \
    RP_CFG_STORAGE_BASE_PATH RP_CFG_STORAGE_MOUNTPOINT
  rm -f "$RP_FACTORY_RESET_PLAN" "$RP_OWNERSHIP_MANIFEST"
  rp_require_root() { return 0; }
  rp_block_device_exists() { return 0; }
  readlink() { [[ "$1" == -f ]] && printf '%s\n' "$2"; }
  rp_storage_related_to_root() { return 0; }
  rp_storage_fingerprint() { printf 'type=disk;size=2147483648;id=ID_SERIAL=SERIAL-123\n'; }
  rp_swarm_unrelated_resources() { return 0; }
}

test_preflight_missing_storage() (
  preflight_base
  unset RP_CFG_STORAGE_DEVICE
  rp_reset_factory_preflight
)
assert_status 1 'factory preflight rejects missing storage target' test_preflight_missing_storage

test_preflight_root_storage() (
  preflight_base
  RP_CFG_STORAGE_DEVICE=/dev/sda
  export RP_CFG_STORAGE_DEVICE
  rp_storage_related_to_root() { return 1; }
  rp_reset_factory_preflight
)
assert_status 1 'factory preflight rejects root-related storage target' test_preflight_root_storage

test_preflight_changed_fingerprint() (
  preflight_base
  cat >"$RP_FACTORY_RESET_PLAN" <<'PLAN'
stack=resourceportal-control-plane
storage_device=/dev/sdb
storage_partition=/dev/sdb1
storage_base_path=/srv/resource-portal/storage
storage_mountpoint=/srv/resource-portal/storage
storage_fingerprint=type=disk;size=2147483648;id=ID_SERIAL=OLD
 docker_remove=false
PLAN
  # Rewrite without accidental leading space while retaining a stale identity.
  sed -i 's/^ docker_remove=/docker_remove=/' "$RP_FACTORY_RESET_PLAN"
  cat >>"$RP_FACTORY_RESET_PLAN" <<'PLAN'
package_tracking=legacy-untracked
force_untracked_packages=false
PLAN
  chmod 0600 "$RP_FACTORY_RESET_PLAN"
  RP_CFG_STORAGE_DEVICE=/dev/sdb
  export RP_CFG_STORAGE_DEVICE
  rp_storage_fingerprint() { printf 'type=disk;size=2147483648;id=ID_SERIAL=NEW\n'; }
  rp_reset_factory_preflight
)
assert_status 1 'factory preflight rejects changed storage fingerprint' test_preflight_changed_fingerprint

test_preflight_unrelated_swarm() (
  preflight_base
  RP_CFG_STORAGE_DEVICE=/dev/sdb
  export RP_CFG_STORAGE_DEVICE
  rp_swarm_unrelated_resources() { printf 'service other_stack_web\n'; }
  rp_reset_factory_preflight
)
assert_status 1 'factory preflight rejects unrelated Swarm resources' test_preflight_unrelated_swarm

fstab_test="$tmpdir/fstab"
cat >"$fstab_test" <<'FSTAB'
UUID=system / ext4 defaults 0 1
UUID=rp /srv/resource-portal/storage xfs defaults,prjquota 0 0
server:/other /mnt/other nfs4 defaults 0 0
/srv/resource-portal/storage/volumes /mnt/resourceportal/volumes none bind 0 0
FSTAB
rp_remove_fstab_mount "$fstab_test" /srv/resource-portal/storage
rp_remove_fstab_mount "$fstab_test" /mnt/resourceportal/volumes
fstab_after="$(cat "$fstab_test")"
assert_contains "$fstab_after" 'UUID=system / ext4 defaults 0 1' 'fstab cleanup preserves root entry'
assert_contains "$fstab_after" 'server:/other /mnt/other nfs4 defaults 0 0' 'fstab cleanup preserves unrelated NFS entry'
assert_not_contains "$fstab_after" '/srv/resource-portal/storage xfs' 'fstab cleanup removes RP storage mount'
assert_not_contains "$fstab_after" '/mnt/resourceportal/volumes none bind' 'fstab cleanup removes RP runtime mount'

systemd_log="$tmpdir/systemd-cleanup.log"
: >"$systemd_log"
RP_OWNERSHIP_MANIFEST="$tmpdir/systemd-owned"
export RP_OWNERSHIP_MANIFEST
rp_ownership_record systemd-unit resourceportal-storage-ready.service
rp_ownership_record systemd-helper /usr/local/lib/resourceportal/storage-ready-check
systemd_fake_bin="$tmpdir/systemd-fake-bin"
mkdir -p "$systemd_fake_bin"
cat >"$systemd_fake_bin/systemctl" <<EOF_SYSTEMCTL
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >>"$systemd_log"
EOF_SYSTEMCTL
cat >"$systemd_fake_bin/rm" <<EOF_RM
#!/usr/bin/env bash
printf 'rm %s\n' "\$*" >>"$systemd_log"
EOF_RM
chmod +x "$systemd_fake_bin/systemctl" "$systemd_fake_bin/rm"
PATH="$systemd_fake_bin:$PATH" rp_remove_storage_ready_unit
systemd_text="$(cat "$systemd_log")"
assert_contains "$systemd_text" 'resourceportal-storage-ready.service' 'systemd cleanup targets RP storage-ready unit'
assert_contains "$systemd_text" '/usr/local/lib/resourceportal/storage-ready-check' 'systemd cleanup targets RP helper'
assert_not_contains "$systemd_text" 'unrelated.service' 'systemd cleanup never targets unrelated unit'

test_leave_swarm_refuses_unrelated() (
  rp_swarm_unrelated_resources() { printf 'service other_stack_web\n'; }
  docker() { printf 'unexpected docker mutation\n' >&2; return 99; }
  rp_reset_leave_swarm
)
assert_status 1 'leave-swarm refuses when unrelated resources remain' test_leave_swarm_refuses_unrelated

test_leave_single_manager_force() (
  rp_swarm_unrelated_resources() { return 0; }
  docker() {
    if [[ "$1 $2 $3" == "info --format {{.Swarm.LocalNodeState}}" ]]; then printf 'active\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.ControlAvailable}}" ]]; then printf 'true\n'; return 0; fi
    if [[ "$1 $2 $3" == 'swarm leave --force' ]]; then return 0; fi
    return 1
  }
  rp_reset_leave_swarm
)
assert_status 0 'factory reset force-leaves manager Swarm after safety classification' test_leave_single_manager_force


# Task 6: Docker/package provenance and storage-wipe safety.
legacy_manifest="$tmpdir/task6-owned"
: >"$legacy_manifest"
RP_OWNERSHIP_MANIFEST="$legacy_manifest"
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=false
unset RP_FACTORY_PLAN_DOCKER_REMOVE RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES
export RP_OWNERSHIP_MANIFEST RP_FORCE_REMOVE_UNTRACKED_PACKAGES
assert_status 1 'legacy Docker not authorized by default' rp_reset_docker_removal_authorized
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true
assert_status 0 'legacy override authorizes known Docker removal' rp_reset_docker_removal_authorized
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=false
rp_ownership_record docker installed-by-resourceportal
assert_status 0 'tracked Docker authorizes removal' rp_reset_docker_removal_authorized

package_log="$tmpdir/task6-packages.log"
: >"$package_log"
RP_OWNERSHIP_MANIFEST="$tmpdir/task6-package-owned"
: >"$RP_OWNERSHIP_MANIFEST"
rp_ownership_record package nfs-ganesha
rp_ownership_record package curl
rp_package_installed() { [[ "$1" == nfs-ganesha || "$1" == curl || "$1" == bind9-dnsutils ]]; }
apt-get() {
  if [[ "${1:-} ${2:-}" == '-s purge' ]]; then
    printf 'Purg %s [test]\n' "${3:-}"
    return 0
  fi
  printf 'apt-get %s\n' "$*" >>"$package_log"
  return 0
}
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=false
rp_reset_remove_packages
package_text="$(cat "$package_log")"
assert_contains "$package_text" 'purge -y' 'package cleanup uses purge'
assert_contains "$package_text" 'nfs-ganesha' 'package cleanup removes owned package'
assert_contains "$package_text" 'curl' 'package cleanup removes second owned package'
assert_not_contains "$package_text" 'bind9-dnsutils' 'package cleanup retains untracked package by default'
assert_not_contains "$package_text" 'autoremove' 'package cleanup never uses unrestricted autoremove'
: >"$package_log"
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true
RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES=true
export RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES
rp_reset_remove_packages
package_text="$(cat "$package_log")"
assert_contains "$package_text" 'bind9-dnsutils' 'legacy override permits fixed installer package candidates'
assert_not_contains "$package_text" 'autoremove' 'legacy override still avoids autoremove'
unset -f apt-get rp_package_installed

# Legacy package force must never remove essential/protected packages or unrelated reverse dependencies.
test_legacy_purge_rejects_essential() (
  RP_OWNERSHIP_MANIFEST="$tmpdir/task6-essential-owned"; : >"$RP_OWNERSHIP_MANIFEST"
  dpkg-query() { printf 'yes\nno\n'; }
  apt-get() { printf 'Purg util-linux [2.40]\n'; }
  rp_reset_package_purge_safe util-linux true
)
assert_status 1 'legacy package override rejects Essential package' test_legacy_purge_rejects_essential

test_legacy_purge_rejects_unrelated_closure() (
  RP_OWNERSHIP_MANIFEST="$tmpdir/task6-closure-owned"; : >"$RP_OWNERSHIP_MANIFEST"
  dpkg-query() { printf 'no\nno\n'; }
  apt-get() { printf 'Purg parted [3.6]\nPurg udisks2 [2.10]\n'; }
  rp_reset_package_purge_safe parted true
)
assert_status 1 'legacy package override rejects unrelated purge closure' test_legacy_purge_rejects_unrelated_closure

test_legacy_purge_accepts_authorized_closure() (
  RP_OWNERSHIP_MANIFEST="$tmpdir/task6-safe-closure-owned"; : >"$RP_OWNERSHIP_MANIFEST"
  dpkg-query() { printf 'no\nno\n'; }
  apt-get() { printf 'Purg nfs-common [1:2.8]\nPurg nfs-ganesha [6.5]\nPurg nfs-ganesha-vfs [6.5]\n'; }
  rp_reset_package_purge_safe nfs-common true
)
assert_status 0 'legacy package override accepts RP-only purge closure' test_legacy_purge_accepts_authorized_closure


test_tracked_purge_accepts_apt_arch_normalization() (
  RP_OWNERSHIP_MANIFEST="$tmpdir/task6-arch-owned"; : >"$RP_OWNERSHIP_MANIFEST"
  rp_ownership_record package 'libevent-core-2.1-7t64:amd64'
  dpkg-query() {
    if [[ "$*" == *'${binary:Package}'* ]]; then
      printf 'libevent-core-2.1-7t64:amd64\n'
    else
      printf 'no\nno\n'
    fi
  }
  apt-get() { printf 'Purg libevent-core-2.1-7t64 [2.1.12]\n'; }
  rp_reset_package_purge_safe 'libevent-core-2.1-7t64:amd64' false
)
assert_status 0 'tracked package purge accepts apt architecture-normalized name' test_tracked_purge_accepts_apt_arch_normalization


wipe_test_base() {
  RP_FACTORY_PLAN_STORAGE_DEVICE=/dev/sdb
  RP_FACTORY_PLAN_STORAGE_PARTITION=/dev/sdb1
  RP_FACTORY_PLAN_STORAGE_MOUNTPOINT=/srv/resource-portal/storage
  RP_FACTORY_PLAN_STORAGE_BASE_PATH=/srv/resource-portal/storage
  RP_FACTORY_PLAN_STORAGE_FINGERPRINT='fingerprint-ok'
  RP_OWNERSHIP_MANIFEST="$tmpdir/task6-wipe-owned"
  : >"$RP_OWNERSHIP_MANIFEST"
  export RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION RP_FACTORY_PLAN_STORAGE_MOUNTPOINT \
    RP_FACTORY_PLAN_STORAGE_BASE_PATH RP_FACTORY_PLAN_STORAGE_FINGERPRINT RP_OWNERSHIP_MANIFEST
  rp_block_device_exists() { return 0; }
  readlink() { [[ "$1" == -f ]] && printf '%s\n' "$2"; }
  rp_storage_fingerprint() { printf 'fingerprint-ok\n'; }
  rp_storage_related_to_root() { return 0; }
  mountpoint() { return 1; }
}

test_wipe_rejects_mounted_target() (
  wipe_test_base
  rp_ownership_record storage-device /dev/sdb
  mountpoint() { [[ "$2" == /srv/resource-portal/storage ]]; }
  wipefs() { printf 'MUTATION wipefs\n' >&2; return 99; }
  sgdisk() { printf 'MUTATION sgdisk\n' >&2; return 99; }
  rp_reset_wipe_storage
)
assert_status 1 'storage wipe rejects mounted target before mutation' test_wipe_rejects_mounted_target

test_wipe_rejects_changed_fingerprint() (
  wipe_test_base
  rp_ownership_record storage-device /dev/sdb
  rp_storage_fingerprint() { printf 'fingerprint-changed\n'; }
  wipefs() { printf 'MUTATION wipefs\n' >&2; return 99; }
  sgdisk() { printf 'MUTATION sgdisk\n' >&2; return 99; }
  rp_reset_wipe_storage
)
assert_status 1 'storage wipe rejects changed fingerprint before mutation' test_wipe_rejects_changed_fingerprint

test_wipe_rejects_root_even_with_package_override() (
  wipe_test_base
  rp_ownership_record storage-device /dev/sdb
  RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true
  rp_storage_related_to_root() { return 1; }
  wipefs() { printf 'MUTATION wipefs\n' >&2; return 99; }
  sgdisk() { printf 'MUTATION sgdisk\n' >&2; return 99; }
  rp_reset_wipe_storage
)
assert_status 1 'package override never bypasses root-disk storage safety' test_wipe_rejects_root_even_with_package_override

test_partition_only_wipe() (
  wipe_test_base
  RP_FACTORY_PLAN_STORAGE_DEVICE=/dev/sdb1
  RP_FACTORY_PLAN_STORAGE_PARTITION=/dev/sdb1
  export RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION
  : >"$RP_OWNERSHIP_MANIFEST"
  rp_ownership_record storage-partition /dev/sdb1
  log="$tmpdir/task6-partition-wipe.log"; : >"$log"
  wipefs() { printf 'wipefs %s\n' "$*" >>"$log"; return 0; }
  sgdisk() { printf 'sgdisk %s\n' "$*" >>"$log"; return 0; }
  rp_reset_wipe_storage || return 1
  cat "$log"
)
partition_wipe_text="$(test_partition_only_wipe)"
assert_contains "$partition_wipe_text" 'wipefs -a /dev/sdb1' 'partition-only reset wipes owned partition signature'
assert_not_contains "$partition_wipe_text" 'sgdisk' 'partition-only reset never zaps parent disk'

test_whole_disk_wipe() (
  wipe_test_base
  rp_ownership_record storage-device /dev/sdb
  rp_ownership_record storage-partition /dev/sdb1
  log="$tmpdir/task6-disk-wipe.log"; : >"$log"
  lsblk() {
    if [[ "$*" == '-lnpo NAME,TYPE /dev/sdb' ]]; then printf '/dev/sdb disk\n/dev/sdb1 part\n/dev/sdb2 part\n'; return 0; fi
    return 1
  }
  wipefs() { printf 'wipefs %s\n' "$*" >>"$log"; return 0; }
  sgdisk() { printf 'sgdisk %s\n' "$*" >>"$log"; return 0; }
  command() { [[ "$1 $2" == '-v udevadm' || "$1 $2" == '-v partprobe' ]] && return 1; builtin command "$@"; }
  rp_reset_wipe_storage || return 1
  cat "$log"
)
disk_wipe_text="$(test_whole_disk_wipe)"
assert_contains "$disk_wipe_text" 'wipefs -a /dev/sdb1' 'whole-disk reset wipes first child signature'
assert_contains "$disk_wipe_text" 'wipefs -a /dev/sdb2' 'whole-disk reset wipes all child signatures'
assert_contains "$disk_wipe_text" 'sgdisk --zap-all /dev/sdb' 'whole-disk reset zaps approved disk partition table'
assert_contains "$disk_wipe_text" 'wipefs -a /dev/sdb' 'whole-disk reset wipes approved disk signatures'



# E2E-discovered regression: factory reset must remove unknown legacy installer-state files too.
test_remove_installer_state_clears_legacy_files() (
  local root="$tmpdir/task7-legacy-state"
  rm -rf "$root"; mkdir -p "$root/installer-state" "$root/installer-ui"
  RP_INSTALLER_STATE_DIR="$root/installer-state"
  RP_INSTALLER_UI_DIR="$root/installer-ui"
  export RP_INSTALLER_STATE_DIR RP_INSTALLER_UI_DIR
  printf 'legacy\n' >"$RP_INSTALLER_STATE_DIR/primary.state.pre-pr101"
  printf 'legacy\n' >"$RP_INSTALLER_STATE_DIR/release.json.pre-pr108"
  rp_reset_remove_installer_state || return 1
  [[ ! -e "$RP_INSTALLER_STATE_DIR" ]] || return 1
)
assert_status 0 'factory reset removes unknown legacy installer-state leftovers' test_remove_installer_state_clears_legacy_files

# Task 7: stable factory phase order and resumable reset journal.
expected_factory_phases=$'preflight\nstop-services\nremove-stack\nremove-swarm-resources\nremove-enrollment\nremove-system-config\nunmount-runtime\nleave-swarm\nremove-docker\nremove-docker-data\nwipe-storage\nremove-rp-data\nremove-packages\nremove-installer-state\nfinal-cleanup'
assert_eq "$expected_factory_phases" "$(rp_factory_reset_phase_names 2>/dev/null || true)" 'factory reset phase order is stable'

test_factory_resume_journal() (
  local root="$tmpdir/task7-resume" calls="$tmpdir/task7-resume.calls" fail_marker="$tmpdir/task7-resume.fail"
  rm -rf "$root" "$calls" "$fail_marker"; mkdir -p "$root/installer-state" "$root/reset-state" "$root/log"
  RP_FACTORY_RESET_STATE="$root/reset-state/factory.state"
  RP_FACTORY_RESET_PLAN="$root/reset-state/factory.plan"
  RP_RESET_STATE_DIR="$root/reset-state"
  RP_INSTALLER_STATE_DIR="$root/installer-state"
  RP_INSTALLER_CONFIG_FILE="$root/installer.conf"
  RP_INSTALLER_UI_DIR="$root/installer-ui"
  RP_RESET_LOG_DIR="$root/log"
  RP_UI_MODE=text
  export RP_FACTORY_RESET_STATE RP_FACTORY_RESET_PLAN RP_RESET_STATE_DIR RP_INSTALLER_STATE_DIR \
    RP_INSTALLER_CONFIG_FILE RP_INSTALLER_UI_DIR RP_RESET_LOG_DIR RP_UI_MODE
  printf 'stack=resourceportal-control-plane\n' >"$RP_FACTORY_RESET_PLAN"

  rp_reset_factory_preflight(){ printf 'preflight\n' >>"$calls"; return 0; }
  rp_reset_stop_services(){ printf 'stop-services\n' >>"$calls"; }
  rp_reset_remove_stack(){ printf 'remove-stack\n' >>"$calls"; }
  rp_reset_remove_swarm_resources(){ printf 'remove-swarm-resources\n' >>"$calls"; }
  rp_reset_remove_enrollment(){ printf 'remove-enrollment\n' >>"$calls"; }
  rp_reset_remove_system_config(){ printf 'remove-system-config\n' >>"$calls"; }
  rp_reset_unmount_runtime(){ printf 'unmount-runtime\n' >>"$calls"; }
  rp_reset_leave_swarm(){ printf 'leave-swarm\n' >>"$calls"; }
  rp_reset_remove_docker(){ printf 'remove-docker\n' >>"$calls"; }
  rp_reset_remove_docker_data(){ printf 'remove-docker-data\n' >>"$calls"; }
  rp_reset_wipe_storage(){ printf 'wipe-storage\n' >>"$calls"; }
  rp_reset_remove_rp_data(){
    printf 'remove-rp-data\n' >>"$calls"
    if [[ ! -e "$fail_marker" ]]; then : >"$fail_marker"; return 1; fi
    return 0
  }
  rp_reset_remove_packages(){ printf 'remove-packages\n' >>"$calls"; }
  rp_primary_install(){ printf 'FORBIDDEN-primary-install\n' >>"$calls"; return 99; }
  rp_primary_create_platform_secrets(){ printf 'FORBIDDEN-secret-generation\n' >>"$calls"; return 99; }

  set +e
  rp_reset_factory >/dev/null 2>&1
  first_rc=$?
  set -e
  [[ "$first_rc" == 1 ]] || return 1
  grep -Fxq wipe-storage "$RP_FACTORY_RESET_STATE" || return 1
  ! grep -Fxq remove-rp-data "$RP_FACTORY_RESET_STATE" || return 1
  first_count="$(wc -l <"$calls" | tr -d ' ')"

  rp_reset_factory >/dev/null 2>&1 || return 1
  second_calls="$(tail -n +$((first_count + 1)) "$calls")"
  [[ "$second_calls" == $'preflight\nremove-rp-data\nremove-packages' ]] || return 1
  [[ ! -e "$RP_FACTORY_RESET_STATE" ]] || return 1
  [[ ! -e "$RP_FACTORY_RESET_PLAN" ]] || return 1
  ! grep -q '^FORBIDDEN-' "$calls" || return 1
)
assert_status 0 'factory reset resumes after wipe without replaying completed destructive stages' test_factory_resume_journal

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi
printf 'All installer reset interface/safe-scope tests passed.\n'
