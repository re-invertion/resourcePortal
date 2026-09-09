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
    factory)
      printf 'Factory reset lifecycle is not available until destructive preflight is initialized.\n' >&2
      return 2
      ;;
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
