#!/usr/bin/env bash

RP_PRIMARY_STATE_FILE="${RP_PRIMARY_STATE_FILE:-/var/lib/resourceportal/installer-state/primary.state}"
RP_INSTALLER_CONFIG_FILE="${RP_INSTALLER_CONFIG_FILE:-/etc/resourceportal/installer.conf}"
RP_INSTALLER_STATE_DIR="${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}"

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

# Task 5 replaces this fail-safe stub with real Swarm secret classification.
rp_reset_managed_swarm_secret_present() {
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
