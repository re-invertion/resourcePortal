#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/common.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/storage.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/filesystem.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/quota.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/lifecycle.sh"

failures=0
assert_eq() {
  local expected="$1" actual="$2" name="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$name" "$expected" "$actual" >&2
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$name"
  fi
}
assert_status() {
  local expected="$1" name="$2"
  shift 2
  set +e
  "$@" >/tmp/rp-installer-storage.out 2>/tmp/rp-installer-storage.err
  local actual=$?
  set -e
  assert_eq "$expected" "$actual" "$name"
}
assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nmissing: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$name"
  fi
}

assert_status 1 "reject exact system disk" rp_device_is_safe_target /dev/sda /dev/sda
assert_status 1 "reject partition of system disk" rp_device_is_safe_target /dev/sda2 /dev/sda
assert_status 1 "reject nvme partition of system disk" rp_device_is_safe_target /dev/nvme0n1p3 /dev/nvme0n1
assert_status 0 "allow different disk" rp_device_is_safe_target /dev/sdb /dev/sda
assert_status 0 "allow different nvme disk" rp_device_is_safe_target /dev/nvme1n1 /dev/nvme0n1

assert_status 0 "blank non-system disk is autodetect candidate" rp_storage_device_candidate_safe /dev/sdb disk '' '' 0 false /dev/sda
assert_status 1 "system disk is never autodetect candidate" rp_storage_device_candidate_safe /dev/sda disk '' '' 0 false /dev/sda
assert_status 1 "disk with filesystem is not autodetect candidate" rp_storage_device_candidate_safe /dev/sdb disk ext4 '' 0 false /dev/sda
assert_status 1 "disk with partitions is not autodetect candidate" rp_storage_device_candidate_safe /dev/sdb disk '' '' 1 false /dev/sda
assert_status 1 "disk with signatures is not autodetect candidate" rp_storage_device_candidate_safe /dev/sdb disk '' '' 0 true /dev/sda
assert_eq "/dev/sdb" "$(rp_select_single_storage_candidate $'/dev/sdb\n')" "single storage candidate is selected"
assert_status 1 "multiple storage candidates require manual choice" rp_select_single_storage_candidate $'/dev/sdb\n/dev/sdc\n'
assert_status 1 "no storage candidate requires manual choice" rp_select_single_storage_candidate ''

# Partition creation is asynchronous on real hosts: lsblk can expose the new
# partition path before the /dev node is usable. The installer must wait for
# the block device before passing it to mkfs.
partition_wait_marker="$(mktemp /tmp/rp-partition-wait.XXXXXX)"
printf '0\n' >"$partition_wait_marker"
lsblk() {
  if [[ "$*" == '-lnpo NAME,TYPE /dev/sdb' ]]; then
    local n
    n="$(cat "$partition_wait_marker")"
    n=$((n + 1))
    printf '%s\n' "$n" >"$partition_wait_marker"
    printf '/dev/sdb disk\n/dev/sdb1 part\n'
    return 0
  fi
  command lsblk "$@"
}
rp_block_device_exists() {
  [[ "$1" == /dev/sdb1 ]] || return 1
  [[ "$(cat "$partition_wait_marker")" -ge 3 ]]
}
sleep() { :; }
set +e
partition_wait_out="$(rp_wait_for_first_partition /dev/sdb 5 0 2>/tmp/rp-partition-wait.err)"
partition_wait_status=$?
set -e
assert_eq "0" "$partition_wait_status" "partition wait tolerates delayed device node"
assert_eq "/dev/sdb1" "$partition_wait_out" "partition wait returns usable partition"
assert_eq "3" "$(cat "$partition_wait_marker")" "partition wait retries until block device exists"
rm -f "$partition_wait_marker" /tmp/rp-partition-wait.err
unset -f lsblk rp_block_device_exists sleep

# Interactive destructive confirmation should explain an invalid value and retry
# instead of failing the whole storage phase without context.
confirmation_marker="$(mktemp /tmp/rp-confirmation-attempt.XXXXXX)"
rm -f "$confirmation_marker"
rp_ui_input() {
  if [[ ! -e "$confirmation_marker" ]]; then
    : >"$confirmation_marker"
    printf 'wrong\n'
  else
    printf 'FORMAT /dev/sdb\n'
  fi
}
set +e
confirmation_out="$(rp_prompt_destructive_confirmation /dev/sdb 2>&1)"
confirmation_status=$?
set -e
assert_eq "0" "$confirmation_status" "storage confirmation retries after invalid input"
assert_contains "$confirmation_out" "Invalid confirmation. Type exactly: FORMAT /dev/sdb" "storage confirmation explains invalid input"
assert_contains "$confirmation_out" "FORMAT /dev/sdb" "storage confirmation eventually returns exact value"
rm -f "$confirmation_marker"

rp_ui_input() { return 1; }
set +e
cancel_out="$(rp_prompt_destructive_confirmation /dev/sdb 2>&1)"
cancel_status=$?
set -e
assert_eq "1" "$cancel_status" "storage confirmation cancel returns failure"
assert_contains "$cancel_out" "Storage formatting confirmation cancelled for /dev/sdb." "storage confirmation cancel explains failure"

assert_eq "xfs" "$(rp_default_filesystem)" "XFS is default"
assert_status 0 "accept xfs" rp_validate_filesystem_type xfs
assert_status 0 "accept ext4" rp_validate_filesystem_type ext4
assert_status 1 "reject btrfs" rp_validate_filesystem_type btrfs
assert_eq "defaults,prjquota" "$(rp_project_quota_mount_options xfs)" "XFS quota mount options"
assert_eq "defaults,prjquota" "$(rp_project_quota_mount_options ext4)" "ext4 quota mount options"

xfs_line="$(rp_render_fstab_entry 1111-2222 /srv/resource-portal/storage xfs)"
ext4_line="$(rp_render_fstab_entry aaaa-bbbb /data/resourceportal ext4)"
assert_eq "UUID=1111-2222 /srv/resource-portal/storage xfs defaults,prjquota 0 0" "$xfs_line" "render XFS UUID fstab"
assert_eq "UUID=aaaa-bbbb /data/resourceportal ext4 defaults,prjquota 0 2" "$ext4_line" "render ext4 UUID fstab"

layout="$(rp_storage_layout_paths /srv/resource-portal/storage)"
assert_contains "$layout" "/srv/resource-portal/storage/volumes" "layout contains volumes"
assert_contains "$layout" "/srv/resource-portal/storage/secrets" "layout contains secrets"
assert_contains "$layout" "/srv/resource-portal/storage/platform" "layout contains platform"
assert_contains "$layout" "/srv/resource-portal/storage/platform/databases/resourceportal-postgres" "layout contains RP postgres"
assert_contains "$layout" "/srv/resource-portal/storage/platform/databases/zitadel-postgres" "layout contains ZITADEL postgres"

assert_eq "/mnt/resourceportal/volumes" "$(rp_runtime_path volumes)" "canonical volumes runtime path"
assert_eq "/mnt/resourceportal/secrets" "$(rp_runtime_path secrets)" "canonical secrets runtime path"
assert_eq "/mnt/resourceportal/platform" "$(rp_runtime_path platform)" "canonical platform runtime path"
assert_status 1 "reject unknown runtime namespace" rp_runtime_path databases

# Runtime namespace mounts use the declared API order: mode, namespace, source.
lifecycle_source="$(cat "$repo_root/scripts/installer/lifecycle.sh")"
assert_contains "$lifecycle_source" 'rp_mount_runtime_namespace local volumes "$base" || return 1' 'Primary mounts volumes with mode-first argument order and fails closed'
assert_contains "$lifecycle_source" 'rp_mount_runtime_namespace local secrets "$base" || return 1' 'Primary mounts secrets with mode-first argument order and fails closed'
assert_contains "$lifecycle_source" 'rp_mount_runtime_namespace local platform "$base" || return 1' 'Primary mounts platform with mode-first argument order and fails closed'

# Bootstrap must verify the runtime platform mount and create bind sources before Swarm deploy.
assert_contains "$lifecycle_source" 'mountpoint -q /mnt/resourceportal/platform || return 1' 'bootstrap requires platform runtime mountpoint'
assert_contains "$lifecycle_source" 'install -d -m 0750 /mnt/resourceportal/platform/databases/resourceportal-postgres' 'bootstrap creates RP PostgreSQL runtime bind source'
assert_contains "$lifecycle_source" 'install -d -m 0750 /mnt/resourceportal/platform/databases/zitadel-postgres' 'bootstrap creates ZITADEL PostgreSQL runtime bind source'
assert_contains "$lifecycle_source" 'install -d -m 0750 /mnt/resourceportal/platform/fencing' 'bootstrap creates fencing runtime directory'

unit_text="$(cat "$repo_root/scripts/installer/templates/resourceportal-storage-ready.service")"
assert_contains "$unit_text" "Before=docker.service" "storage readiness precedes Docker"
assert_contains "$unit_text" "ExecStart=/usr/local/lib/resourceportal/storage-ready-check" "unit invokes readiness checker"
assert_contains "$unit_text" "RemainAfterExit=yes" "readiness remains active"

quota_source="$(cat "$repo_root/scripts/installer/quota.sh")"
assert_contains "$quota_source" 'systemctl enable --now resourceportal-storage-ready.service' 'storage readiness unit starts immediately'
lifecycle_source="$(cat "$repo_root/scripts/installer/lifecycle.sh")"
assert_contains "$lifecycle_source" 'systemctl is-active --quiet resourceportal-storage-ready.service' 'Primary checks readiness service before applying storage labels'
assert_contains "$lifecycle_source" 'findmnt -rn -M "$RP_CFG_STORAGE_BASE_PATH"' 'Primary checks exact storage mountpoint before skipping disk selection'


# Storage readiness starts during the storage phase, so installer.conf must
# exist before systemd starts the readiness unit.
bootstrap_marker="$(mktemp /tmp/rp-storage-config-bootstrap.XXXXXX)"
rm -f "$bootstrap_marker"
export RP_CFG_STORAGE_BASE_PATH=/srv/resource-portal/storage
export RP_CFG_STORAGE_MOUNTPOINT=/srv/resource-portal/storage
export RP_INSTALLER_REPO_ROOT="$repo_root"
findmnt() {
  case "$*" in
    '-rn -M /srv/resource-portal/storage') return 0 ;;
    '-nro FSTYPE -T /srv/resource-portal/storage') printf 'xfs\n' ;;
    *) return 1 ;;
  esac
}
rp_project_quota_enabled() { return 0; }
install() { return 0; }
rp_storage_layout_create() { return 0; }
rp_mount_runtime_namespace() { return 0; }
rp_config_write() { : >"$bootstrap_marker"; }
rp_install_storage_ready_unit() { [[ -e "$bootstrap_marker" ]]; }
assert_status 0 "storage writes runtime config before starting readiness unit" rp_primary_prepare_storage
rm -f "$bootstrap_marker"

if (( failures > 0 )); then printf '%s\n' "$failures test(s) failed" >&2; exit 1; fi
printf 'All installer storage tests passed.\n'
