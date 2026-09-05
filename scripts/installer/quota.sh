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

rp_install_storage_ready_unit() {
  local repo_root="$1"
  install -d -m 0755 /usr/local/lib/resourceportal
  install -m 0755 "$repo_root/scripts/installer/templates/storage-ready-check" \
    /usr/local/lib/resourceportal/storage-ready-check
  install -m 0644 "$repo_root/scripts/installer/templates/resourceportal-storage-ready.service" \
    /etc/systemd/system/resourceportal-storage-ready.service
  systemctl daemon-reload
  systemctl enable --now resourceportal-storage-ready.service
}
