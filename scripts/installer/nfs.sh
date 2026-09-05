#!/usr/bin/env bash

rp_nfs_namespace_allowed() {
  case "$1" in
    volumes|secrets|platform) return 0 ;;
    *) return 1 ;;
  esac
}

rp_ganesha_export_id() {
  case "$1" in
    volumes) printf '101\n' ;;
    secrets) printf '102\n' ;;
    platform) printf '103\n' ;;
    *) return 1 ;;
  esac
}

rp_render_ganesha_export() {
  local namespace="$1" base="${2%/}" clients="$3" squash export_id
  rp_nfs_namespace_allowed "$namespace" || return 1
  [[ -n "$clients" ]] || return 1
  export_id="$(rp_ganesha_export_id "$namespace")"
  if [[ "$namespace" == "volumes" ]]; then
    squash="Root_Squash"
  else
    squash="Root_Squash"
  fi
  cat <<EOF_EXPORT
EXPORT {
  Export_Id = $export_id;
  Path = "$base/$namespace";
  Pseudo = "/resourceportal/$namespace";
  Access_Type = RW;
  Squash = $squash;
  Protocols = 4;
  Transports = TCP;
  SecType = sys;

  FSAL {
    Name = VFS;
  }

  CLIENT {
    Clients = $clients;
    Access_Type = RW;
    Squash = $squash;
  }
}
EOF_EXPORT
}

rp_render_ganesha_config() {
  local base="$1" workload_clients="$2" manager_clients="$3"
  [[ -n "$workload_clients" && -n "$manager_clients" ]] || return 1
  cat <<'EOF_HEADER'
# Managed by ResourcePortal Production Installer.
# Do not add unrelated exports to this file.
NFS_CORE_PARAM {
  Protocols = 4;
}

EOF_HEADER
  rp_render_ganesha_export volumes "$base" "$workload_clients"
  printf '\n'
  rp_render_ganesha_export secrets "$base" "$manager_clients"
  printf '\n'
  rp_render_ganesha_export platform "$base" "$manager_clients"
}

rp_validate_ganesha_config() {
  local path="$1"
  if command -v ganesha.nfsd >/dev/null 2>&1; then
    ganesha.nfsd -T -f "$path" >/dev/null
  elif command -v ganesha_conf >/dev/null 2>&1; then
    ganesha_conf "$path" >/dev/null
  else
    printf 'No NFS-Ganesha configuration validator found.\n' >&2
    return 1
  fi
}

rp_install_ganesha_config() {
  local target="${1:-/etc/ganesha/resourceportal.conf}" base="$2" workload_clients="$3" manager_clients="$4"
  local tmp backup=""
  install -d -m 0755 "$(dirname "$target")"
  tmp="${target}.tmp.$$"
  rp_render_ganesha_config "$base" "$workload_clients" "$manager_clients" >"$tmp"
  chmod 0644 "$tmp"
  rp_validate_ganesha_config "$tmp" || { rm -f "$tmp"; return 1; }
  if [[ -f "$target" ]]; then
    backup="${target}.bak.$$"
    cp -a "$target" "$backup"
  fi
  mv -f "$tmp" "$target"
  if ! systemctl reload nfs-ganesha 2>/dev/null && ! systemctl restart nfs-ganesha; then
    if [[ -n "$backup" && -f "$backup" ]]; then
      mv -f "$backup" "$target"
      systemctl restart nfs-ganesha || true
    fi
    return 1
  fi
  [[ -z "$backup" ]] || rm -f "$backup"
}

rp_render_nfs_fstab_entry() {
  local server="$1" namespace="$2"
  rp_nfs_namespace_allowed "$namespace" || return 1
  [[ -n "$server" ]] || return 1
  printf '%s:/resourceportal/%s %s nfs4 rw,hard,_netdev,noatime 0 0\n' \
    "$server" "$namespace" "$(rp_runtime_path "$namespace")"
}

rp_render_local_bind_fstab_entry() {
  local base="${1%/}" namespace="$2"
  rp_nfs_namespace_allowed "$namespace" || return 1
  printf '%s/%s %s none bind 0 0\n' "$base" "$namespace" "$(rp_runtime_path "$namespace")"
}

rp_replace_fstab_mount() {
  local fstab_path="$1" mountpoint="$2" line="$3" tmp
  tmp="${fstab_path}.resourceportal.$$"
  awk -v mountpoint="$mountpoint" '$2 != mountpoint { print }' "$fstab_path" >"$tmp"
  printf '%s\n' "$line" >>"$tmp"
  cat "$tmp" >"$fstab_path"
  rm -f "$tmp"
}

rp_mount_runtime_namespace() {
  local mode="$1" namespace="$2" source="$3" fstab_path="${4:-/etc/fstab}"
  local mountpoint line
  rp_nfs_namespace_allowed "$namespace" || return 1
  mountpoint="$(rp_runtime_path "$namespace")"
  install -d -m 0755 "$mountpoint"
  case "$mode" in
    local)
      line="$(rp_render_local_bind_fstab_entry "$source" "$namespace")"
      ;;
    nfs)
      line="$(rp_render_nfs_fstab_entry "$source" "$namespace")"
      ;;
    *) return 1 ;;
  esac
  rp_replace_fstab_mount "$fstab_path" "$mountpoint" "$line"
  mountpoint -q "$mountpoint" && umount "$mountpoint"
  mount "$mountpoint"
}

rp_storage_label_args() {
  local volumes_ready="$1" secrets_ready="$2" platform_ready="$3"
  [[ "$volumes_ready" == "true" ]] && printf '%s\n' '--label-add resourceportal.storage.volumes=true'
  [[ "$secrets_ready" == "true" ]] && printf '%s\n' '--label-add resourceportal.storage.secrets=true'
  [[ "$platform_ready" == "true" ]] && printf '%s\n' '--label-add resourceportal.storage.platform=true'
}

rp_apply_storage_labels() {
  local node="$1" volumes_ready="$2" secrets_ready="$3" platform_ready="$4"
  local -a args=(node update)
  local label
  while IFS= read -r label; do
    [[ -n "$label" ]] || continue
    args+=( $label )
  done < <(rp_storage_label_args "$volumes_ready" "$secrets_ready" "$platform_ready")
  args+=("$node")
  docker "${args[@]}"
}
