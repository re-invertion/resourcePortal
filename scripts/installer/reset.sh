#!/usr/bin/env bash

RP_PRIMARY_STATE_FILE="${RP_PRIMARY_STATE_FILE:-/var/lib/resourceportal/installer-state/primary.state}"
RP_INSTALLER_CONFIG_FILE="${RP_INSTALLER_CONFIG_FILE:-/etc/resourceportal/installer.conf}"
RP_INSTALLER_STATE_DIR="${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}"

RP_RESET_STATE_DIR="${RP_RESET_STATE_DIR:-/var/lib/resourceportal/reset-state}"
RP_FACTORY_RESET_STATE="${RP_FACTORY_RESET_STATE:-$RP_RESET_STATE_DIR/factory.state}"
RP_FACTORY_RESET_PLAN="${RP_FACTORY_RESET_PLAN:-$RP_RESET_STATE_DIR/factory.plan}"

rp_reset_factory_plan_write() {
  local path="$RP_FACTORY_RESET_PLAN" tmp
  local -a keys=(
    stack storage_device storage_partition storage_base_path storage_mountpoint
    storage_fingerprint docker_remove package_tracking force_untracked_packages
  )
  local key var value
  umask 077
  mkdir -p "$(dirname "$path")" || return 1
  tmp="${path}.tmp.$$"
  : >"$tmp" || return 1
  for key in "${keys[@]}"; do
    case "$key" in
      stack) var=RP_FACTORY_PLAN_STACK ;;
      storage_device) var=RP_FACTORY_PLAN_STORAGE_DEVICE ;;
      storage_partition) var=RP_FACTORY_PLAN_STORAGE_PARTITION ;;
      storage_base_path) var=RP_FACTORY_PLAN_STORAGE_BASE_PATH ;;
      storage_mountpoint) var=RP_FACTORY_PLAN_STORAGE_MOUNTPOINT ;;
      storage_fingerprint) var=RP_FACTORY_PLAN_STORAGE_FINGERPRINT ;;
      docker_remove) var=RP_FACTORY_PLAN_DOCKER_REMOVE ;;
      package_tracking) var=RP_FACTORY_PLAN_PACKAGE_TRACKING ;;
      force_untracked_packages) var=RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES ;;
    esac
    value="${!var-}"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { rm -f "$tmp"; return 1; }
    printf '%s=%s\n' "$key" "$value" >>"$tmp" || { rm -f "$tmp"; return 1; }
  done
  chmod 0600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$path"
}

rp_reset_factory_plan_load() {
  local path="$RP_FACTORY_RESET_PLAN" line key value
  declare -A seen=()
  [[ -r "$path" ]] || return 1

  unset RP_FACTORY_PLAN_STACK RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION \
    RP_FACTORY_PLAN_STORAGE_BASE_PATH RP_FACTORY_PLAN_STORAGE_MOUNTPOINT RP_FACTORY_PLAN_STORAGE_FINGERPRINT \
    RP_FACTORY_PLAN_DOCKER_REMOVE RP_FACTORY_PLAN_PACKAGE_TRACKING RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" && "$line" == *=* ]] || return 1
    key="${line%%=*}"
    value="${line#*=}"
    [[ -z "${seen[$key]+x}" ]] || return 1
    seen[$key]=1
    case "$key" in
      stack) RP_FACTORY_PLAN_STACK="$value" ;;
      storage_device) RP_FACTORY_PLAN_STORAGE_DEVICE="$value" ;;
      storage_partition) RP_FACTORY_PLAN_STORAGE_PARTITION="$value" ;;
      storage_base_path) RP_FACTORY_PLAN_STORAGE_BASE_PATH="$value" ;;
      storage_mountpoint) RP_FACTORY_PLAN_STORAGE_MOUNTPOINT="$value" ;;
      storage_fingerprint) RP_FACTORY_PLAN_STORAGE_FINGERPRINT="$value" ;;
      docker_remove) RP_FACTORY_PLAN_DOCKER_REMOVE="$value" ;;
      package_tracking) RP_FACTORY_PLAN_PACKAGE_TRACKING="$value" ;;
      force_untracked_packages) RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES="$value" ;;
      *) return 1 ;;
    esac
  done <"$path"

  local required
  for required in RP_FACTORY_PLAN_STACK RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_BASE_PATH \
    RP_FACTORY_PLAN_STORAGE_MOUNTPOINT RP_FACTORY_PLAN_STORAGE_FINGERPRINT RP_FACTORY_PLAN_DOCKER_REMOVE \
    RP_FACTORY_PLAN_PACKAGE_TRACKING RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES; do
    [[ -n "${!required-}" ]] || return 1
  done
  export RP_FACTORY_PLAN_STACK RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION \
    RP_FACTORY_PLAN_STORAGE_BASE_PATH RP_FACTORY_PLAN_STORAGE_MOUNTPOINT RP_FACTORY_PLAN_STORAGE_FINGERPRINT \
    RP_FACTORY_PLAN_DOCKER_REMOVE RP_FACTORY_PLAN_PACKAGE_TRACKING RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES
}

rp_reset_factory_summary() {
  cat <<EOF_SUMMARY
ResourcePortal factory reset plan
Stack: ${RP_FACTORY_PLAN_STACK:-unknown}
Storage device: ${RP_FACTORY_PLAN_STORAGE_DEVICE:-unknown}
Storage partition: ${RP_FACTORY_PLAN_STORAGE_PARTITION:-none}
Storage path: ${RP_FACTORY_PLAN_STORAGE_BASE_PATH:-unknown}
Storage mountpoint: ${RP_FACTORY_PLAN_STORAGE_MOUNTPOINT:-unknown}
Docker removal: ${RP_FACTORY_PLAN_DOCKER_REMOVE:-false}
Package tracking: ${RP_FACTORY_PLAN_PACKAGE_TRACKING:-unknown}
All tenant volumes and databases will be destroyed.
This host will leave Docker Swarm.
EOF_SUMMARY
}

rp_reset_factory_confirm() {
  local confirmation
  if [[ "${RP_NON_INTERACTIVE:-false}" == true ]]; then
    [[ "${RP_CONFIRM_FACTORY_RESET:-false}" == true ]] || {
      printf '%s\n' 'Non-interactive factory reset requires --confirm-factory-reset.' >&2
      return 1
    }
    [[ "${RP_ALLOW_DESTRUCTIVE_STORAGE:-false}" == true ]] || {
      printf '%s\n' 'Non-interactive factory reset requires --allow-destructive-storage.' >&2
      return 1
    }
    return 0
  fi

  confirmation="$(rp_ui_input 'Factory reset confirmation' 'Type exactly: FACTORY RESET RESOURCEPORTAL' '')" || return 1
  [[ "$confirmation" == 'FACTORY RESET RESOURCEPORTAL' ]] || {
    printf '%s\n' 'Factory reset confirmation did not match exactly.' >&2
    return 1
  }
}

rp_reset_factory_plan_set() {
  RP_FACTORY_PLAN_STACK="$1"
  RP_FACTORY_PLAN_STORAGE_DEVICE="$2"
  RP_FACTORY_PLAN_STORAGE_PARTITION="$3"
  RP_FACTORY_PLAN_STORAGE_BASE_PATH="$4"
  RP_FACTORY_PLAN_STORAGE_MOUNTPOINT="$5"
  RP_FACTORY_PLAN_STORAGE_FINGERPRINT="$6"
  RP_FACTORY_PLAN_DOCKER_REMOVE="$7"
  RP_FACTORY_PLAN_PACKAGE_TRACKING="$8"
  RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES="$9"
  export RP_FACTORY_PLAN_STACK RP_FACTORY_PLAN_STORAGE_DEVICE RP_FACTORY_PLAN_STORAGE_PARTITION \
    RP_FACTORY_PLAN_STORAGE_BASE_PATH RP_FACTORY_PLAN_STORAGE_MOUNTPOINT RP_FACTORY_PLAN_STORAGE_FINGERPRINT \
    RP_FACTORY_PLAN_DOCKER_REMOVE RP_FACTORY_PLAN_PACKAGE_TRACKING RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES
}

rp_reset_factory_preflight() {
  local device canonical current_fingerprint configured_canonical unrelated partition=""
  local stack base mountpoint docker_remove=false package_tracking=legacy-untracked force_untracked
  rp_require_root || return 1

  force_untracked="${RP_FORCE_REMOVE_UNTRACKED_PACKAGES:-false}"

  if [[ -r "$RP_FACTORY_RESET_PLAN" ]]; then
    rp_reset_factory_plan_load || return 1
    device="$RP_FACTORY_PLAN_STORAGE_DEVICE"
    rp_block_device_exists "$device" || {
      printf 'Factory reset storage device no longer exists: %s\n' "$device" >&2
      return 1
    }
    canonical="$(readlink -f "$device" 2>/dev/null)" || return 1
    [[ "$canonical" == "$device" ]] || {
      printf 'Factory reset storage device identity path changed: %s -> %s\n' "$device" "$canonical" >&2
      return 1
    }
    if [[ -n "${RP_CFG_STORAGE_DEVICE:-}" ]]; then
      configured_canonical="$(readlink -f "$RP_CFG_STORAGE_DEVICE" 2>/dev/null)" || return 1
      [[ "$configured_canonical" == "$device" ]] || {
        printf 'Configured storage target differs from approved factory plan.\n' >&2
        return 1
      }
    fi
    rp_storage_related_to_root "$device" || {
      printf 'Refusing root/system-related factory reset target: %s\n' "$device" >&2
      return 1
    }
    current_fingerprint="$(rp_storage_fingerprint "$device")" || return 1
    [[ "$current_fingerprint" == "$RP_FACTORY_PLAN_STORAGE_FINGERPRINT" ]] || {
      printf 'Factory reset storage fingerprint changed.\n' >&2
      return 1
    }
    unrelated="$(rp_swarm_unrelated_resources 2>/dev/null || true)"
    [[ -z "$unrelated" ]] || {
      printf 'Unrelated Swarm resources block factory reset:\n%s\n' "$unrelated" >&2
      return 1
    }
    rp_reset_factory_summary
    rp_reset_factory_confirm
    return $?
  fi

  device="${RP_CFG_STORAGE_DEVICE:-}"
  [[ -n "$device" ]] || {
    printf '%s\n' 'Factory reset requires an explicit configured ResourcePortal storage device.' >&2
    return 1
  }
  canonical="$(readlink -f "$device" 2>/dev/null)" || return 1
  [[ -n "$canonical" && "$canonical" == /dev/* ]] || return 1
  rp_block_device_exists "$canonical" || {
    printf 'Factory reset storage target is not a block device: %s\n' "$canonical" >&2
    return 1
  }
  rp_storage_related_to_root "$canonical" || {
    printf 'Refusing root/system-related factory reset target: %s\n' "$canonical" >&2
    return 1
  }
  current_fingerprint="$(rp_storage_fingerprint "$canonical")" || {
    printf 'Cannot establish stable identity for storage target: %s\n' "$canonical" >&2
    return 1
  }

  if [[ -r "$RP_OWNERSHIP_MANIFEST" ]]; then
    package_tracking=tracked
    local owned_devices
    owned_devices="$(rp_ownership_values storage-device)"
    if [[ -n "$owned_devices" ]] && ! grep -Fxq -- "$canonical" <<<"$owned_devices" && ! grep -Fxq -- "$device" <<<"$owned_devices"; then
      printf 'Configured storage device does not match ResourcePortal ownership metadata.\n' >&2
      return 1
    fi
    partition="$(rp_ownership_values storage-partition | head -n1)"
    if rp_ownership_has docker installed-by-resourceportal; then docker_remove=true; fi
  fi
  if [[ "$force_untracked" == true ]]; then docker_remove=true; fi

  unrelated="$(rp_swarm_unrelated_resources 2>/dev/null || true)"
  [[ -z "$unrelated" ]] || {
    printf 'Unrelated Swarm resources block factory reset:\n%s\n' "$unrelated" >&2
    return 1
  }

  stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}"
  mountpoint="${RP_CFG_STORAGE_MOUNTPOINT:-$base}"
  rp_reset_factory_plan_set "$stack" "$canonical" "$partition" "$base" "$mountpoint" \
    "$current_fingerprint" "$docker_remove" "$package_tracking" "$force_untracked"
  rp_reset_factory_plan_write || return 1
  rp_reset_factory_summary
  rp_reset_factory_confirm
}

rp_reset_scope_valid() {
  case "$1" in
    settings|installer-state|factory) return 0 ;;
    *) return 1 ;;
  esac
}

rp_reset_flags_valid() {
  local scope="$1"
  rp_reset_scope_valid "$scope" || {
    printf 'Unsupported reset scope: %s\n' "$scope" >&2
    return 2
  }

  if [[ "$scope" != factory ]]; then
    if [[ "${RP_CONFIRM_FACTORY_RESET:-false}" == true ||
          "${RP_FORCE_REMOVE_UNTRACKED_PACKAGES:-false}" == true ||
          "${RP_ALLOW_DESTRUCTIVE_STORAGE:-false}" == true ]]; then
      printf 'Factory-reset-only flags are not valid for reset scope %s.\n' "$scope" >&2
      return 2
    fi
  fi
}

rp_reset_final_checkpoint_present() {
  rp_phase_done "$RP_PRIMARY_STATE_FILE" final
}

rp_reset_active_control_plane() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  docker service ls \
    --filter "label=com.docker.stack.namespace=${RP_CFG_STACK_NAME:-resourceportal-control-plane}" \
    --format '{{.Name}}' 2>/dev/null | grep -q .
}

rp_reset_runtime_mount_present() {
  local path
  for path in /mnt/resourceportal/volumes /mnt/resourceportal/secrets /mnt/resourceportal/platform; do
    mountpoint -q "$path" 2>/dev/null && return 0
  done
  return 1
}

rp_reset_managed_swarm_secret_present() {
  local state name
  command -v docker >/dev/null 2>&1 || return 1
  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  [[ "$state" == active ]] || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    rp_swarm_resourceportal_secret_name "$name" && return 0
  done < <(docker secret ls --format '{{.Name}}' 2>/dev/null || true)
  return 1
}

rp_reset_directory_has_content() {
  local path="$1"
  [[ -d "$path" ]] || return 1
  find "$path" -mindepth 1 -print -quit 2>/dev/null | grep -q .
}

rp_reset_protected_state_present() {
  local base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}"
  rp_reset_directory_has_content "$RP_INSTALLER_STATE_DIR/secrets" && return 0
  rp_reset_directory_has_content "$base/platform/databases/resourceportal-postgres" && return 0
  rp_reset_directory_has_content "$base/platform/databases/zitadel-postgres" && return 0
  rp_reset_runtime_mount_present && return 0
  rp_reset_managed_swarm_secret_present && return 0
  return 1
}

rp_reset_settings() {
  if rp_reset_final_checkpoint_present; then
    printf 'Settings reset refused: installation reached the final checkpoint. Use reconfigure or factory reset.\n' >&2
    return 1
  fi
  if rp_reset_active_control_plane; then
    printf 'Settings reset refused: an active ResourcePortal control plane was detected. Use reconfigure or factory reset.\n' >&2
    return 1
  fi
  rm -f "$RP_INSTALLER_CONFIG_FILE"
}

rp_reset_installer_state() {
  if rp_reset_final_checkpoint_present; then
    printf 'Installer-state reset refused: installation reached the final checkpoint.\n' >&2
    return 1
  fi
  if rp_reset_active_control_plane; then
    printf 'Installer-state reset refused: an active ResourcePortal control plane was detected.\n' >&2
    return 1
  fi
  if rp_reset_protected_state_present; then
    printf 'Installer-state reset refused: protected ResourcePortal runtime state exists.\n' >&2
    return 1
  fi

  rm -f \
    "$RP_INSTALLER_STATE_DIR/primary.state" \
    "$RP_INSTALLER_STATE_DIR/release.json" \
    "$RP_INSTALLER_STATE_DIR/zitadel-bootstrap.json"
  rm -rf \
    "$RP_INSTALLER_STATE_DIR/secrets" \
    "$RP_INSTALLER_STATE_DIR/enrollment" \
    "$RP_INSTALLER_STATE_DIR/identity-bootstrap"
  rm -f "$RP_INSTALLER_CONFIG_FILE"
}

rp_reset() {
  local scope="$1"
  rp_reset_flags_valid "$scope" || return $?
  case "$scope" in
    settings) rp_reset_settings ;;
    installer-state) rp_reset_installer_state ;;
    factory) rp_reset_factory ;;
    *) return 2 ;;
  esac
}


rp_reset_swarm_active() {
  command -v docker >/dev/null 2>&1 || return 1
  [[ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" == active ]]
}

rp_reset_stop_services() {
  local stack="${RP_FACTORY_PLAN_STACK:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}" service mode
  rp_reset_swarm_active || return 0
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    mode="$(docker service inspect "$service" --format '{{if .Spec.Mode.Replicated}}replicated{{else}}other{{end}}' 2>/dev/null || true)"
    [[ "$mode" == replicated ]] || continue
    docker service update --replicas 0 "$service" >/dev/null || return 1
  done < <(docker service ls --filter "label=com.docker.stack.namespace=$stack" --format '{{.Name}}' 2>/dev/null || true)
}

rp_reset_remove_stack() {
  local stack="${RP_FACTORY_PLAN_STACK:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}" remaining
  local attempts="${RP_RESET_STACK_REMOVE_ATTEMPTS:-60}" delay="${RP_RESET_STACK_REMOVE_DELAY:-1}" i
  rp_reset_swarm_active || return 0
  docker stack rm "$stack" >/dev/null 2>&1 || true
  for ((i = 0; i < attempts; i++)); do
    remaining="$(docker service ls --filter "label=com.docker.stack.namespace=$stack" --format '{{.Name}}' 2>/dev/null || true)"
    [[ -z "$remaining" ]] && return 0
    sleep "$delay"
  done
  printf 'Timed out waiting for ResourcePortal stack removal: %s\n' "$stack" >&2
  return 1
}

rp_reset_remove_swarm_resources() {
  local stack="${RP_FACTORY_PLAN_STACK:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}" name
  rp_reset_swarm_active || return 0
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if rp_swarm_resourceportal_secret_name "$name"; then
      docker secret rm "$name" >/dev/null 2>&1 || true
    fi
  done < <(docker secret ls --format '{{.Name}}' 2>/dev/null || true)
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if rp_swarm_resourceportal_config_name "$name" "$stack"; then
      docker config rm "$name" >/dev/null 2>&1 || true
    fi
  done < <(docker config ls --format '{{.Name}}' 2>/dev/null || true)
}

rp_reset_remove_enrollment() {
  local stack="${RP_FACTORY_PLAN_STACK:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}" service
  if rp_reset_swarm_active; then
    while IFS= read -r service; do
      [[ -n "$service" ]] || continue
      case "$service" in
        "${stack}-installer-enrollment"|"${stack}-migration-"*|"${stack}-zitadel-bootstrap-"*|"${stack}-enrollment-issue-"*)
          docker service rm "$service" >/dev/null 2>&1 || true
          ;;
      esac
    done < <(docker service ls --format '{{.Name}}' 2>/dev/null || true)
  fi
  rm -rf "$RP_INSTALLER_STATE_DIR/enrollment"
}

rp_reset_remove_system_config() {
  local ganesha="${RP_GANESHA_CONFIG_PATH:-/etc/ganesha/resourceportal.conf}"
  rp_remove_resourceportal_ufw_rules || return 1
  rp_remove_resourceportal_ganesha_config "$ganesha" || return 1
  rp_remove_storage_ready_unit || return 1
}

rp_reset_unmount_runtime() {
  local mountpoint="${RP_FACTORY_PLAN_STORAGE_MOUNTPOINT:-${RP_CFG_STORAGE_MOUNTPOINT:-${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}}}"
  local fstab="${RP_FSTAB_PATH:-/etc/fstab}" path
  rp_unmount_resourceportal_runtime || return 1
  if mountpoint -q "$mountpoint" 2>/dev/null; then
    umount "$mountpoint" || return 1
  fi
  for path in /mnt/resourceportal/platform /mnt/resourceportal/secrets /mnt/resourceportal/volumes "$mountpoint"; do
    rp_remove_fstab_mount "$fstab" "$path" || return 1
  done
}

rp_reset_leave_swarm() {
  local unrelated state control
  unrelated="$(rp_swarm_unrelated_resources 2>/dev/null || true)"
  [[ -z "$unrelated" ]] || {
    printf 'Unrelated Swarm resources still exist; refusing to leave Swarm:\n%s\n' "$unrelated" >&2
    return 1
  }
  command -v docker >/dev/null 2>&1 || return 0
  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  [[ "$state" == inactive || -z "$state" ]] && return 0
  [[ "$state" == active ]] || return 1
  control="$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || true)"
  if [[ "$control" == true ]]; then
    docker swarm leave --force >/dev/null
  else
    docker swarm leave >/dev/null
  fi
}

rp_reset_docker_removal_authorized() {
  if [[ "${RP_FACTORY_PLAN_DOCKER_REMOVE:-false}" == true ]]; then
    return 0
  fi
  if rp_ownership_has docker installed-by-resourceportal; then
    return 0
  fi
  [[ "${RP_FORCE_REMOVE_UNTRACKED_PACKAGES:-${RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES:-false}}" == true ]]
}

rp_reset_remove_docker() {
  local remove="${RP_FACTORY_PLAN_DOCKER_REMOVE:-false}" force
  local package key source
  local -a installed=()
  force="${RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES:-${RP_FORCE_REMOVE_UNTRACKED_PACKAGES:-false}}"

  [[ "$remove" == true ]] || {
    rp_log INFO 'factory reset retained Docker because installer ownership was not proven' 2>/dev/null || true
    return 0
  }

  for service in docker.service docker.socket containerd.service; do
    systemctl disable --now "$service" >/dev/null 2>&1 || true
  done

  while IFS= read -r package; do
    [[ -n "$package" ]] || continue
    rp_package_installed "$package" && installed+=("$package")
  done < <(rp_docker_package_names)
  if ((${#installed[@]} > 0)); then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y "${installed[@]}" || return 1
  fi

  key="$(rp_docker_apt_key_path)"
  source="$(rp_docker_apt_source_path)"
  if [[ "$force" == true ]] || rp_ownership_has apt-key "$key"; then rm -f "$key"; fi
  if [[ "$force" == true ]] || rp_ownership_has apt-source "$source"; then rm -f "$source"; fi
}

rp_reset_remove_docker_data() {
  [[ "${RP_FACTORY_PLAN_DOCKER_REMOVE:-false}" == true ]] || return 0
  if findmnt -rn -M /var/lib/docker >/dev/null 2>&1; then
    printf '%s\n' 'Refusing to remove /var/lib/docker while it is a mountpoint.' >&2
    return 1
  fi
  rm -rf /var/lib/docker
}

rp_reset_host_package_candidates() {
  printf '%s\n' \
    ca-certificates curl gnupg jq openssl iproute2 util-linux parted gdisk \
    xfsprogs e2fsprogs quota nfs-common nfs-ganesha nfs-ganesha-vfs ufw dnsutils
}

rp_reset_remove_packages() {
  local package force
  local -a candidates=() installed=() unique=()
  local seen=' '
  force="${RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES:-${RP_FORCE_REMOVE_UNTRACKED_PACKAGES:-false}}"

  while IFS= read -r package; do
    [[ -n "$package" ]] && candidates+=("$package")
  done < <(rp_ownership_values package)
  if [[ "$force" == true ]]; then
    while IFS= read -r package; do
      [[ -n "$package" ]] && candidates+=("$package")
    done < <(rp_reset_host_package_candidates)
  fi

  for package in "${candidates[@]}"; do
    [[ "$seen" == *" $package "* ]] && continue
    seen+="$package "
    unique+=("$package")
  done
  for package in "${unique[@]}"; do
    rp_package_installed "$package" && installed+=("$package")
  done
  if ((${#installed[@]} > 0)); then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y "${installed[@]}" || return 1
  fi
}

rp_reset_storage_revalidate() {
  local device="${RP_FACTORY_PLAN_STORAGE_DEVICE:-}" canonical current path
  [[ -n "$device" ]] || return 1
  rp_block_device_exists "$device" || return 1
  canonical="$(readlink -f "$device" 2>/dev/null)" || return 1
  [[ "$canonical" == "$device" ]] || return 1
  rp_storage_related_to_root "$device" || return 1
  current="$(rp_storage_fingerprint "$device")" || return 1
  [[ "$current" == "${RP_FACTORY_PLAN_STORAGE_FINGERPRINT:-}" ]] || return 1
  for path in /mnt/resourceportal/platform /mnt/resourceportal/secrets /mnt/resourceportal/volumes "${RP_FACTORY_PLAN_STORAGE_MOUNTPOINT:-}"; do
    [[ -n "$path" ]] || continue
    mountpoint -q "$path" 2>/dev/null && return 1
  done
  return 0
}

rp_reset_wipe_storage() {
  local device="${RP_FACTORY_PLAN_STORAGE_DEVICE:-}" partition="${RP_FACTORY_PLAN_STORAGE_PARTITION:-}" child type
  local whole_disk=false partition_only=false
  rp_reset_storage_revalidate || return 1

  if rp_ownership_has storage-device "$device"; then
    whole_disk=true
  elif rp_ownership_has storage-partition "$device"; then
    partition_only=true
  else
    type="$(lsblk -dnro TYPE "$device" 2>/dev/null | head -n1 || true)"
    case "$type" in
      disk) whole_disk=true ;;
      part) partition_only=true ;;
      *)
        if [[ -n "$partition" && "$partition" == "$device" ]]; then partition_only=true; else return 1; fi
        ;;
    esac
  fi

  if [[ "$partition_only" == true ]]; then
    wipefs -a "$device" || return 1
    return 0
  fi

  [[ "$whole_disk" == true ]] || return 1
  while read -r child type; do
    [[ "$type" == part && -n "$child" ]] || continue
    wipefs -a "$child" || return 1
  done < <(lsblk -lnpo NAME,TYPE "$device" 2>/dev/null || true)
  sgdisk --zap-all "$device" || return 1
  wipefs -a "$device" || return 1
  if command -v partprobe >/dev/null 2>&1; then partprobe "$device" >/dev/null 2>&1 || true; fi
  if command -v udevadm >/dev/null 2>&1; then udevadm settle --timeout=10 >/dev/null 2>&1 || true; fi
}

rp_reset_remove_rp_data() {
  local base="${RP_FACTORY_PLAN_STORAGE_BASE_PATH:-${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}}" path
  local -a paths=("$base" /etc/resourceportal /mnt/resourceportal /srv/resource-portal)
  local seen=' '
  for path in "${paths[@]}"; do
    [[ -n "$path" ]] || continue
    [[ "$seen" == *" $path "* ]] && continue
    seen+="$path "
    [[ -e "$path" ]] || continue
    if findmnt -rn -M "$path" >/dev/null 2>&1; then
      printf 'Refusing to remove ResourcePortal path that is still mounted: %s\n' "$path" >&2
      return 1
    fi
    rm -rf -- "$path" || return 1
  done
}

rp_factory_reset_phase_names() {
  printf '%s\n' \
    preflight \
    stop-services \
    remove-stack \
    remove-swarm-resources \
    remove-enrollment \
    remove-system-config \
    unmount-runtime \
    leave-swarm \
    remove-docker \
    remove-docker-data \
    wipe-storage \
    remove-rp-data \
    remove-packages \
    remove-installer-state \
    final-cleanup
}

rp_reset_run_phase() {
  local phase="$1"; shift
  local action rc
  [[ -n "${RP_FACTORY_RESET_STATE:-}" ]] || return 1
  rp_phase_done "$RP_FACTORY_RESET_STATE" "$phase" && return 0

  rp_log INFO "factory reset phase started: $phase"
  if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_started "$phase" "Starting factory reset phase: $phase" || true; fi

  while true; do
    if "$@"; then
      if [[ "$phase" != final-cleanup ]]; then
        rp_phase_mark_done "$RP_FACTORY_RESET_STATE" "$phase" || return 1
        rp_log INFO "factory reset phase completed: $phase"
      fi
      if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_completed "$phase" "Completed factory reset phase: $phase" || true; fi
      return 0
    else
      rc=$?
    fi

    rp_log ERROR "factory reset phase failed: $phase"
    if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_failed "$phase" "Factory reset stage failed: $phase" || true; fi
    if [[ "${RP_UI_MODE:-text}" != tui ]] || ! declare -F rp_ui_failure_action >/dev/null; then
      return "$rc"
    fi
    action="$(rp_ui_failure_action "$phase" "Factory reset stage failed: $phase")" || return "$rc"
    case "$action" in
      retry)
        rp_log INFO "factory reset phase retry requested: $phase"
        if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_started "$phase" "Retrying factory reset phase: $phase" || true; fi
        ;;
      exit|*) return "$rc" ;;
    esac
  done
}

rp_reset_remove_installer_state() {
  local ui_dir="${RP_INSTALLER_UI_DIR:-${RP_GUM_INSTALL_DIR:-/var/lib/resourceportal/installer-ui}}"
  rm -f \
    "$RP_INSTALLER_STATE_DIR/primary.state" \
    "$RP_INSTALLER_STATE_DIR/release.json" \
    "$RP_INSTALLER_STATE_DIR/zitadel-bootstrap.json" \
    "$RP_INSTALLER_STATE_DIR/owned-resources" || return 1
  rm -rf \
    "$RP_INSTALLER_STATE_DIR/secrets" \
    "$RP_INSTALLER_STATE_DIR/enrollment" \
    "$RP_INSTALLER_STATE_DIR/identity-bootstrap" \
    "$ui_dir" || return 1
  rmdir "$RP_INSTALLER_STATE_DIR" >/dev/null 2>&1 || true
}

rp_reset_final_cleanup() {
  local message='Factory reset complete: ResourcePortal data and storage were destroyed.'
  local log_dir="${RP_RESET_LOG_DIR:-/var/log/resourceportal}"

  if [[ "${RP_UI_MODE:-text}" == tui ]] && declare -F rp_ui_event >/dev/null; then
    rp_ui_event operation_updated final-cleanup "$message" || true
  else
    printf '%s\n' "$message"
  fi

  rm -rf "$log_dir" || return 1
  rm -f "$RP_FACTORY_RESET_PLAN" || return 1
  rm -f "$RP_FACTORY_RESET_STATE" || return 1
  rmdir "$RP_RESET_STATE_DIR" >/dev/null 2>&1 || true
}

rp_reset_factory_phase_command() {
  case "$1" in
    stop-services) printf 'rp_reset_stop_services\n' ;;
    remove-stack) printf 'rp_reset_remove_stack\n' ;;
    remove-swarm-resources) printf 'rp_reset_remove_swarm_resources\n' ;;
    remove-enrollment) printf 'rp_reset_remove_enrollment\n' ;;
    remove-system-config) printf 'rp_reset_remove_system_config\n' ;;
    unmount-runtime) printf 'rp_reset_unmount_runtime\n' ;;
    leave-swarm) printf 'rp_reset_leave_swarm\n' ;;
    remove-docker) printf 'rp_reset_remove_docker\n' ;;
    remove-docker-data) printf 'rp_reset_remove_docker_data\n' ;;
    wipe-storage) printf 'rp_reset_wipe_storage\n' ;;
    remove-rp-data) printf 'rp_reset_remove_rp_data\n' ;;
    remove-packages) printf 'rp_reset_remove_packages\n' ;;
    remove-installer-state) printf 'rp_reset_remove_installer_state\n' ;;
    final-cleanup) printf 'rp_reset_final_cleanup\n' ;;
    *) return 1 ;;
  esac
}

rp_reset_factory() {
  local phase command

  if [[ "${RP_UI_MODE:-text}" == tui ]] && declare -F rp_dashboard_init >/dev/null; then
    rp_dashboard_init reset-factory "$RP_FACTORY_RESET_STATE"
    if declare -F rp_dashboard_enter >/dev/null; then rp_dashboard_enter || true; fi
  fi

  # Preflight is intentionally re-run on every process invocation. On resume it
  # reloads and revalidates the already-approved factory.plan instead of selecting
  # a new destructive target.
  rp_reset_factory_preflight || return 1
  if ! rp_phase_done "$RP_FACTORY_RESET_STATE" preflight; then
    rp_phase_mark_done "$RP_FACTORY_RESET_STATE" preflight || return 1
    if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_completed preflight 'Factory reset preflight completed' || true; fi
  fi

  while IFS= read -r phase; do
    [[ "$phase" == preflight ]] && continue
    command="$(rp_reset_factory_phase_command "$phase")" || return 1
    rp_reset_run_phase "$phase" "$command" || return $?
  done < <(rp_factory_reset_phase_names)
}
