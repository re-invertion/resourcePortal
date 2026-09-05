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

unit_text="$(cat "$repo_root/scripts/installer/templates/resourceportal-storage-ready.service")"
assert_contains "$unit_text" "Before=docker.service" "storage readiness precedes Docker"
assert_contains "$unit_text" "ExecStart=/usr/local/lib/resourceportal/storage-ready-check" "unit invokes readiness checker"
assert_contains "$unit_text" "RemainAfterExit=yes" "readiness remains active"

quota_source="$(cat "$repo_root/scripts/installer/quota.sh")"
assert_contains "$quota_source" 'systemctl enable --now resourceportal-storage-ready.service' 'storage readiness unit starts immediately'
lifecycle_source="$(cat "$repo_root/scripts/installer/lifecycle.sh")"
assert_contains "$lifecycle_source" 'systemctl is-active --quiet resourceportal-storage-ready.service' 'Primary checks readiness service before applying storage labels'

if (( failures > 0 )); then printf '%s\n' "$failures test(s) failed" >&2; exit 1; fi
printf 'All installer storage tests passed.\n'
