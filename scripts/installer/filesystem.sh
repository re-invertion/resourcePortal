#!/usr/bin/env bash

rp_default_filesystem() {
  printf 'xfs\n'
}

rp_validate_filesystem_type() {
  case "${1,,}" in
    xfs|ext4) return 0 ;;
    *) return 1 ;;
  esac
}

rp_project_quota_mount_options() {
  rp_validate_filesystem_type "$1" || return 1
  printf 'defaults,prjquota\n'
}

rp_render_fstab_entry() {
  local uuid="$1" mountpoint="$2" filesystem="${3,,}" pass
  rp_validate_filesystem_type "$filesystem" || return 1
  [[ "$mountpoint" == /* ]] || return 1
  if [[ "$filesystem" == "ext4" ]]; then pass=2; else pass=0; fi
  printf 'UUID=%s %s %s %s 0 %s\n' \
    "$uuid" "$mountpoint" "$filesystem" "$(rp_project_quota_mount_options "$filesystem")" "$pass"
}

rp_format_device() {
  local device="$1" filesystem="${2,,}" system_disk="$3" confirmation="$4"
  rp_validate_filesystem_type "$filesystem" || return 1
  rp_device_is_safe_target "$device" "$system_disk" || return 1
  rp_require_destructive_confirmation "$device" "$confirmation" || return 1
  [[ -b "$device" ]] || return 1
  case "$filesystem" in
    xfs) mkfs.xfs -f "$device" ;;
    ext4) mkfs.ext4 -F -O quota,project "$device" ;;
  esac
}

rp_persist_filesystem_mount() {
  local device="$1" mountpoint="$2" filesystem="${3,,}" fstab_path="${4:-/etc/fstab}"
  local uuid line tmp
  uuid="$(blkid -s UUID -o value "$device")"
  [[ -n "$uuid" ]] || return 1
  line="$(rp_render_fstab_entry "$uuid" "$mountpoint" "$filesystem")"
  mkdir -p "$mountpoint"
  tmp="${fstab_path}.resourceportal.$$"
  awk -v mountpoint="$mountpoint" '$2 != mountpoint { print }' "$fstab_path" >"$tmp"
  printf '%s\n' "$line" >>"$tmp"
  cat "$tmp" >"$fstab_path"
  rm -f "$tmp"
  mount "$mountpoint"
}
