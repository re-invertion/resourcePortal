#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
source "$repo_root/scripts/installer/system.sh"
source "$repo_root/scripts/installer/config.sh"
source "$repo_root/scripts/installer/filesystem.sh"
source "$repo_root/scripts/installer/quota.sh"
source "$repo_root/scripts/installer/storage.sh"
source "$repo_root/scripts/installer/nfs.sh"
source "$repo_root/scripts/installer/docker.sh"
source "$repo_root/scripts/installer/firewall.sh"
source "$repo_root/scripts/installer/swarm.sh"
source "$repo_root/scripts/installer/secrets.sh"
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/identity.sh"
source "$repo_root/scripts/installer/domain.sh"
source "$repo_root/scripts/installer/smtp.sh"
source "$repo_root/scripts/installer/enrollment.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reconfigure.sh"
source "$repo_root/scripts/installer/diagnostics.sh"

RP_INSTALLER_REPO_ROOT="$repo_root"
RP_INSTALLER_VERSION="${RP_INSTALLER_VERSION:-0.1.0}"
export RP_INSTALLER_REPO_ROOT RP_INSTALLER_VERSION

rp_usage() {
  cat <<'USAGE'
Usage:
  sudo ./resourceportal-install.sh --mode primary [--config PATH]
  sudo ./resourceportal-install.sh --mode add-node --bundle PATH [--config PATH]
  sudo ./resourceportal-install.sh --mode upgrade --manifest PATH [--config PATH]
  sudo ./resourceportal-install.sh --mode reconfigure --action ACTION [--config PATH]
  sudo ./resourceportal-install.sh --mode diagnostics [--config PATH]

Modes:
  primary       Install or resume the Primary ResourcePortal node.
  add-node      Join this host using a single-use pinned-TLS enrollment bundle.
  upgrade       Apply a selected release manifest.
  reconfigure   Apply one supported configuration change.
  diagnostics   Run read-only diagnostics.
USAGE
}

rp_dispatch() {
  local mode="$1" bundle="$2" action="$3" manifest="$4"
  case "$mode" in
    primary)
      rp_primary_install
      ;;
    add-node)
      [[ -n "$bundle" ]] || { printf '%s\n' '--bundle is required for add-node' >&2; return 2; }
      rp_prepare_host_packages
      rp_ensure_docker "${RP_CFG_MIN_DOCKER_VERSION:-27.0.0}"
      rp_redeem_join_bundle "$bundle"
      ;;
    upgrade)
      [[ -n "$manifest" ]] || { printf '%s\n' '--manifest is required for upgrade' >&2; return 2; }
      local previous_stack="${RP_CFG_PREVIOUS_STACK_FILE:-/etc/resourceportal/stack.yml}"
      local docker_version current_version
      docker_version="$(docker version --format '{{.Server.Version}}')" || return 1
      current_version="${RP_CFG_RELEASE_VERSION:-0.0.0}"
      rp_upgrade_preflight "$manifest" "$RP_INSTALLER_VERSION" "$current_version" "$docker_version" || return 1
      rp_upgrade_apply "$manifest" "$previous_stack"
      ;;
    reconfigure)
      [[ -n "$action" ]] || { printf '%s\n' '--action is required for reconfigure' >&2; return 2; }
      rp_reconfigure "$action"
      ;;
    diagnostics)
      rp_run_diagnostics
      ;;
    *)
      printf 'Unknown installer mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
}

rp_main() {
  local config_path="/etc/resourceportal/installer.conf" mode="" bundle="" action="" manifest=""
  while (($#)); do
    case "$1" in
      --config)
        [[ $# -ge 2 ]] || { printf '%s\n' '--config requires a path' >&2; return 2; }
        config_path="$2"; shift 2 ;;
      --mode)
        [[ $# -ge 2 ]] || { printf '%s\n' '--mode requires a value' >&2; return 2; }
        mode="$2"; shift 2 ;;
      --bundle)
        [[ $# -ge 2 ]] || { printf '%s\n' '--bundle requires a path' >&2; return 2; }
        bundle="$2"; shift 2 ;;
      --action)
        [[ $# -ge 2 ]] || { printf '%s\n' '--action requires a value' >&2; return 2; }
        action="$2"; shift 2 ;;
      --manifest)
        [[ $# -ge 2 ]] || { printf '%s\n' '--manifest requires a path' >&2; return 2; }
        manifest="$2"; shift 2 ;;
      --help|-h)
        rp_usage; return 0 ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2; return 2 ;;
    esac
  done

  rp_require_root
  if [[ -r "$config_path" ]]; then
    rp_config_load "$config_path"
  fi
  mode="${mode:-${RP_CFG_MODE:-}}"
  if [[ -z "$mode" ]]; then
    mode="$(rp_ui_choice 'ResourcePortal Production Installer' 'Choose installer mode' primary \
      primary 'Install Primary / Control Plane' \
      add-node 'Add Swarm Node' \
      upgrade 'Upgrade ResourcePortal' \
      reconfigure 'Reconfigure Installation' \
      diagnostics 'Repair / Diagnostics')" || return 1
  fi
  rp_mode_valid "$mode" || { printf 'Unsupported installer mode: %s\n' "$mode" >&2; return 2; }
  RP_CFG_MODE="$mode"; export RP_CFG_MODE
  rp_dispatch "$mode" "$bundle" "$action" "$manifest"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  rp_main "$@"
fi
