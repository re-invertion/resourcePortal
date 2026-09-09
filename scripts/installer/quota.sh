#!/usr/bin/env bash

rp_storage_layout_paths() {
  local base="${1%/}"
  printf '%s\n' \
    "$base/volumes" \
    "$base/secrets" \
    "$base/platform" \
    "$base/platform/databases" \
    "$base/platform/databases/resourceportal-postgres" \
    "$base/platform/databases/zitadel-postgres"
}

rp_runtime_path() {
  case "$1" in
    volumes) printf '/mnt/resourceportal/volumes\n' ;;
    secrets) printf '/mnt/resourceportal/secrets\n' ;;
    platform) printf '/mnt/resourceportal/platform\n' ;;
    *) return 1 ;;
  esac
}

rp_storage_layout_create() {
  local base="$1" path
  while IFS= read -r path; do
    install -d -m 0750 "$path"
  done < <(rp_storage_layout_paths "$base")
  install -d -m 0755 /mnt/resourceportal
  for path in volumes secrets platform; do
    install -d -m 0755 "$(rp_runtime_path "$path")"
  done
}

rp_project_quota_enabled() {
  local mountpoint="$1" filesystem options source features
  filesystem="$(findmnt -nro FSTYPE -T "$mountpoint" 2>/dev/null)" || return 1
  options="$(findmnt -nro OPTIONS -T "$mountpoint" 2>/dev/null)" || return 1
  rp_validate_filesystem_type "$filesystem" || return 1
  [[ ",$options," == *,prjquota,* || ",$options," == *,pquota,* ]] || return 1

  if [[ "$filesystem" == "ext4" ]]; then
    source="$(findmnt -nro SOURCE -T "$mountpoint" 2>/dev/null)" || return 1
    features="$(tune2fs -l "$source" 2>/dev/null | awk -F: '/Filesystem features:/ {print $2}')"
    [[ " $features " == *" project "* && " $features " == *" quota "* ]] || return 1
  fi
  return 0
}

rp_storage_ready_helper_path() {
  printf '/usr/local/lib/resourceportal/storage-ready-check\n'
}

rp_storage_ready_unit_path() {
  printf '/etc/systemd/system/resourceportal-storage-ready.service\n'
}

rp_install_storage_ready_unit() {
  local repo_root="$1" helper unit
  helper="$(rp_storage_ready_helper_path)"
  unit="$(rp_storage_ready_unit_path)"
  install -d -m 0755 "$(dirname "$helper")"
  install -m 0755 "$repo_root/scripts/installer/templates/storage-ready-check" "$helper"
  install -m 0644 "$repo_root/scripts/installer/templates/resourceportal-storage-ready.service" "$unit"
  systemctl daemon-reload
  systemctl enable --now resourceportal-storage-ready.service
}

rp_remove_storage_ready_unit() {
  local unit helper unit_owned=false helper_owned=false
  unit="$(rp_storage_ready_unit_path)"
  helper="$(rp_storage_ready_helper_path)"

  if declare -F rp_ownership_has >/dev/null && rp_ownership_has systemd-unit resourceportal-storage-ready.service; then
    unit_owned=true
  elif [[ -f "$unit" ]] && grep -Fq 'ResourcePortal' "$unit" 2>/dev/null; then
    unit_owned=true
  fi
  if declare -F rp_ownership_has >/dev/null && rp_ownership_has systemd-helper "$helper"; then
    helper_owned=true
  elif [[ "$unit_owned" == true && -e "$helper" ]]; then
    helper_owned=true
  fi

  if [[ "$unit_owned" == true ]]; then
    systemctl disable --now resourceportal-storage-ready.service >/dev/null 2>&1 || true
    rm -f "$unit" || return 1
  fi
  if [[ "$helper_owned" == true ]]; then
    rm -f "$helper" || return 1
  fi
  if [[ "$unit_owned" == true || "$helper_owned" == true ]]; then
    systemctl daemon-reload || return 1
  fi
}
