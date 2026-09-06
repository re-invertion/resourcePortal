#!/usr/bin/env bash

rp_parent_block_device() {
  local device="$1" parent
  parent="$(lsblk -ndo PKNAME "$device" 2>/dev/null | head -n1 || true)"
  if [[ -n "$parent" ]]; then
    printf '/dev/%s\n' "$parent"
  fi
}

rp_system_disk() {
  local source current parent
  source="$(findmnt -nro SOURCE / 2>/dev/null | head -n1)" || return 1
  [[ "$source" == /dev/* ]] || return 1
  current="$source"
  while true; do
    parent="$(rp_parent_block_device "$current")"
    [[ -n "$parent" ]] || break
    current="$parent"
  done
  printf '%s\n' "$current"
}

rp_device_is_safe_target() {
  local target="$1" system_disk="$2"
  [[ "$target" == /dev/* && "$system_disk" == /dev/* ]] || return 1
  [[ "$target" != "$system_disk" ]] || return 1

  case "$system_disk" in
    /dev/nvme*|/dev/mmcblk*)
      [[ "$target" != "${system_disk}p"[0-9]* ]] || return 1
      ;;
    *)
      [[ "$target" != "${system_disk}"[0-9]* ]] || return 1
      ;;
  esac
  return 0
}

rp_inspect_block_device() {
  local device="$1"
  lsblk -o NAME,PATH,SIZE,MODEL,FSTYPE,UUID,MOUNTPOINTS "$device"
  printf '%s\n' '--- signatures ---'
  wipefs -n "$device" 2>/dev/null || true
}

rp_require_destructive_confirmation() {
  local device="$1" confirmation="$2"
  [[ "$confirmation" == "FORMAT $device" ]]
}

rp_partition_empty_disk() {
  local device="$1" system_disk="$2" confirmation="$3"
  rp_device_is_safe_target "$device" "$system_disk" || {
    printf 'Refusing unsafe storage target: %s\n' "$device" >&2
    return 1
  }
  rp_require_destructive_confirmation "$device" "$confirmation" || {
    printf 'Destructive confirmation must be exactly: FORMAT %s\n' "$device" >&2
    return 1
  }
  [[ -b "$device" ]] || return 1
  wipefs --all "$device"
  parted --script "$device" mklabel gpt
  parted --script "$device" mkpart primary 1MiB 100%
  partprobe "$device"
}
