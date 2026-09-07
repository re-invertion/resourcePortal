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

rp_prompt_destructive_confirmation() {
  local device="$1" confirmation
  while true; do
    confirmation="$(rp_ui_input 'Destructive storage confirmation' "Type exactly: FORMAT $device" '')" || {
      printf 'Storage formatting confirmation cancelled for %s.\n' "$device" >&2
      return 1
    }
    if rp_require_destructive_confirmation "$device" "$confirmation"; then
      printf '%s\n' "$confirmation"
      return 0
    fi
    printf 'Invalid confirmation. Type exactly: FORMAT %s\n' "$device" >&2
  done
}

rp_block_device_exists() {
  [[ -b "$1" ]]
}

rp_wait_for_first_partition() {
  local device="$1" attempts="${2:-100}" delay="${3:-0.1}" partition i
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || return 1
  for ((i = 0; i < attempts; i++)); do
    partition="$(lsblk -lnpo NAME,TYPE "$device" 2>/dev/null | awk '$2=="part" {print $1; exit}')"
    if [[ -n "$partition" ]] && rp_block_device_exists "$partition"; then
      printf '%s\n' "$partition"
      return 0
    fi
    sleep "$delay"
  done
  printf 'Timed out waiting for storage partition on %s.\n' "$device" >&2
  return 1
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
  if command -v udevadm >/dev/null 2>&1; then
    udevadm settle --timeout=10 || true
  fi
}

rp_storage_device_candidate_safe() {
  local device="$1" type="$2" fstype="$3" mountpoints="$4" child_count="$5" has_signatures="$6" system_disk="$7"
  [[ "$type" == "disk" ]] || return 1
  rp_device_is_safe_target "$device" "$system_disk" || return 1
  [[ -z "$fstype" && -z "$mountpoints" ]] || return 1
  [[ "$child_count" =~ ^[0-9]+$ ]] || return 1
  (( child_count == 0 )) || return 1
  [[ "$has_signatures" == "false" ]] || return 1
}

rp_select_single_storage_candidate() {
  local candidates="$1" candidate count=0 selected=""
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    count=$((count + 1))
    selected="$candidate"
  done <<<"$candidates"
  (( count == 1 )) || return 1
  printf '%s\n' "$selected"
}

rp_detect_single_empty_storage_device() {
  command -v lsblk >/dev/null 2>&1 || return 1
  command -v wipefs >/dev/null 2>&1 || return 1
  local system_disk device type fstype mountpoints child_count has_signatures candidates=""
  system_disk="$(rp_system_disk)" || return 1
  while IFS= read -r device; do
    [[ -n "$device" ]] || continue
    type="$(lsblk -dnro TYPE "$device" 2>/dev/null | head -n1)"
    fstype="$(lsblk -dnro FSTYPE "$device" 2>/dev/null | head -n1)"
    mountpoints="$(lsblk -dnro MOUNTPOINTS "$device" 2>/dev/null | sed '/^[[:space:]]*$/d')"
    child_count="$(lsblk -nrpo TYPE "$device" 2>/dev/null | tail -n +2 | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
    has_signatures=false
    if wipefs -n "$device" 2>/dev/null | grep -q '[^[:space:]]'; then has_signatures=true; fi
    if rp_storage_device_candidate_safe "$device" "$type" "$fstype" "$mountpoints" "$child_count" "$has_signatures" "$system_disk"; then
      candidates+="${device}"$'\n'
    fi
  done < <(lsblk -dnpo PATH,TYPE 2>/dev/null | awk '$2 == "disk" { print $1 }')
  rp_select_single_storage_candidate "$candidates"
}
