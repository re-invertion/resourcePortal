#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
source "$repo_root/scripts/installer/dashboard.sh"
source "$repo_root/scripts/installer/system.sh"
source "$repo_root/scripts/installer/config.sh"
source "$repo_root/scripts/installer/ownership.sh"
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
source "$repo_root/scripts/installer/acme.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/identity.sh"
source "$repo_root/scripts/installer/domain.sh"
source "$repo_root/scripts/installer/smtp.sh"
source "$repo_root/scripts/installer/enrollment.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reset.sh"
source "$repo_root/scripts/installer/reconfigure.sh"
source "$repo_root/scripts/installer/diagnostics.sh"
source "$repo_root/scripts/installer/repair.sh"

RP_INSTALLER_REPO_ROOT="$repo_root"
RP_INSTALLER_VERSION="${RP_INSTALLER_VERSION:-0.1.0}"
export RP_INSTALLER_REPO_ROOT RP_INSTALLER_VERSION

rp_usage() {
  cat <<'USAGE'
Usage:
  sudo ./resourceportal-install.sh --mode primary [--config PATH] [--acme-environment production|staging]
  sudo ./resourceportal-install.sh --mode add-node --bundle PATH [--config PATH]
  sudo ./resourceportal-install.sh --mode issue-bundle --role manager|worker --bundle /ABSOLUTE/PATH [--config PATH]
  sudo ./resourceportal-install.sh --mode upgrade --manifest PATH [--config PATH]
  sudo ./resourceportal-install.sh --mode reconfigure --action ACTION [--config PATH]
  sudo ./resourceportal-install.sh --mode diagnostics [--repair ACTION] [--config PATH]
  sudo ./resourceportal-install.sh --mode reset --scope settings [--config PATH]
  sudo ./resourceportal-install.sh --mode reset --scope installer-state [--config PATH]
  sudo ./resourceportal-install.sh --mode reset --scope factory [--confirm-factory-reset] [--allow-destructive-storage] [--config PATH]

Modes:
  primary       Install or resume the Primary ResourcePortal node.

TLS testing:
  --acme-environment staging  Use Let's Encrypt staging for the complete install. Intended for disposable installer E2E hosts only.
  add-node      Join this host using a single-use pinned-TLS enrollment bundle.
  issue-bundle  Issue a 30-minute single-use enrollment bundle on the Primary.
  upgrade       Apply a selected release manifest.
  reconfigure   Apply one supported configuration change.
  diagnostics   Run read-only diagnostics.
  reset         Clear safe installer state or perform an explicitly confirmed factory reset.
USAGE
}

rp_dispatch() {
  local mode="$1" bundle="$2" action="$3" manifest="$4" scope="${5:-}" role="${6:-}"
  local previous_stack docker_version current_version ui_was_tui=false
  case "$mode" in
    primary)
      rp_primary_install || return $?
      if declare -F rp_dashboard_complete >/dev/null; then rp_dashboard_complete primary || true; fi
      ;;
    add-node)
      [[ -n "$bundle" ]] || { printf '%s\n' '--bundle is required for add-node' >&2; return 2; }
      [[ "${RP_UI_MODE:-text}" == tui ]] && ui_was_tui=true
      if declare -F rp_ui_mode_dashboard_start >/dev/null; then rp_ui_mode_dashboard_start add-node || true; fi
      rp_ui_mode_operation add-node packages 'Preparing host packages' rp_prepare_host_packages || return $?
      if [[ "$ui_was_tui" != true ]] && declare -F rp_ui_try_enable_tui >/dev/null; then
        rp_ui_try_enable_tui || return 1
        if [[ "${RP_UI_MODE:-text}" == tui ]]; then
          rp_ui_mode_dashboard_start add-node || true
          rp_ui_event phase_completed packages 'Preparing host packages completed' || true
        fi
      fi
      rp_ui_mode_operation add-node docker 'Validating Docker' rp_ensure_docker "${RP_CFG_MIN_DOCKER_VERSION:-27.0.0}" || return $?
      rp_ui_mode_operation add-node enrollment 'Joining ResourcePortal node' rp_redeem_join_bundle "$bundle" || return $?
      if declare -F rp_dashboard_complete >/dev/null; then rp_dashboard_complete add-node || true; fi
      ;;
    issue-bundle)
      [[ -n "$bundle" ]] || { printf '%s\n' '--bundle is required for issue-bundle' >&2; return 2; }
      [[ -n "$role" ]] || { printf '%s\n' '--role is required for issue-bundle' >&2; return 2; }
      rp_ui_mode_operation issue-bundle issue 'Issuing ResourcePortal node enrollment bundle' rp_issue_node_bundle_cli "$role" "$bundle" || return $?
      printf 'Enrollment bundle written to %s\n' "$bundle"
      ;;
    upgrade)
      [[ -n "$manifest" ]] || { printf '%s\n' '--manifest is required for upgrade' >&2; return 2; }
      if declare -F rp_ui_mode_dashboard_start >/dev/null; then rp_ui_mode_dashboard_start upgrade || true; fi
      previous_stack="${RP_CFG_PREVIOUS_STACK_FILE:-/etc/resourceportal/stack.yml}"
      docker_version="$(docker version --format '{{.Server.Version}}')" || return 1
      current_version="${RP_CFG_RELEASE_VERSION:-0.0.0}"
      rp_ui_mode_operation upgrade preflight 'Validating upgrade compatibility' rp_upgrade_preflight "$manifest" "$RP_INSTALLER_VERSION" "$current_version" "$docker_version" || return $?
      rp_ui_mode_operation upgrade apply 'Applying ResourcePortal upgrade' rp_upgrade_apply "$manifest" "$previous_stack" || return $?
      if declare -F rp_dashboard_complete >/dev/null; then rp_dashboard_complete upgrade || true; fi
      ;;
    reconfigure)
      [[ -n "$action" ]] || { printf '%s\n' '--action is required for reconfigure' >&2; return 2; }
      if declare -F rp_ui_mode_dashboard_start >/dev/null; then rp_ui_mode_dashboard_start reconfigure || true; fi
      rp_ui_mode_operation reconfigure apply "Applying reconfiguration: $action" rp_reconfigure "$action" || return $?
      if declare -F rp_dashboard_complete >/dev/null; then rp_dashboard_complete reconfigure || true; fi
      ;;
    diagnostics)
      if declare -F rp_ui_mode_dashboard_start >/dev/null; then rp_ui_mode_dashboard_start diagnostics || true; fi
      rp_ui_mode_operation diagnostics inspect 'Running ResourcePortal diagnostics' rp_run_diagnostics || return $?
      if declare -F rp_dashboard_complete >/dev/null; then rp_dashboard_complete diagnostics || true; fi
      ;;
    reset)
      rp_reset "$scope" || return $?
      if declare -F rp_dashboard_complete >/dev/null; then
        if [[ "$scope" == factory ]]; then rp_dashboard_complete reset-factory || true; else rp_dashboard_complete reset || true; fi
      fi
      ;;
    *)
      printf 'Unknown installer mode: %s\n' "$mode" >&2
      return 2
      ;;
  esac
}

rp_main() {
  local config_path="/etc/resourceportal/installer.conf" mode="" bundle="" action="" manifest="" repair="" scope="" role="" acme_environment_override=""
  RP_CONFIRM_FACTORY_RESET=false
  RP_FORCE_REMOVE_UNTRACKED_PACKAGES=false
  export RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
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
      --role)
        [[ $# -ge 2 ]] || { printf '%s\n' '--role requires a value' >&2; return 2; }
        role="$2"; shift 2 ;;
      --action)
        [[ $# -ge 2 ]] || { printf '%s\n' '--action requires a value' >&2; return 2; }
        action="$2"; shift 2 ;;
      --manifest)
        [[ $# -ge 2 ]] || { printf '%s\n' '--manifest requires a path' >&2; return 2; }
        manifest="$2"; shift 2 ;;
      --acme-environment)
        [[ $# -ge 2 ]] || { printf '%s\n' '--acme-environment requires production or staging' >&2; return 2; }
        acme_environment_override="$2"; shift 2 ;;
      --repair)
        [[ $# -ge 2 ]] || { printf '%s\n' '--repair requires an action' >&2; return 2; }
        repair="$2"; shift 2 ;;
      --scope)
        [[ $# -ge 2 ]] || { printf '%s\n' '--scope requires a value' >&2; return 2; }
        scope="$2"; shift 2 ;;
      --confirm-factory-reset)
        RP_CONFIRM_FACTORY_RESET=true; export RP_CONFIRM_FACTORY_RESET; shift ;;
      --force-remove-untracked-packages)
        RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true; export RP_FORCE_REMOVE_UNTRACKED_PACKAGES; shift ;;
      --non-interactive)
        RP_NON_INTERACTIVE=true; export RP_NON_INTERACTIVE; shift ;;
      --allow-destructive-storage)
        RP_ALLOW_DESTRUCTIVE_STORAGE=true; export RP_ALLOW_DESTRUCTIVE_STORAGE; shift ;;
      --help|-h)
        rp_usage; return 0 ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2; return 2 ;;
    esac
  done

  rp_require_root
  rp_log_init
  RP_NON_INTERACTIVE="${RP_NON_INTERACTIVE:-false}"; export RP_NON_INTERACTIVE
  rp_ui_init
  trap 'rp_ui_cleanup' EXIT
  trap 'rp_ui_cleanup; exit 130' INT
  trap 'rp_ui_cleanup; exit 143' TERM
  if [[ -r "$config_path" ]]; then
    rp_config_load "$config_path"
  fi
  if [[ -n "$acme_environment_override" ]]; then
    rp_acme_environment_valid "$acme_environment_override" || { printf 'Unsupported ACME environment: %s\n' "$acme_environment_override" >&2; return 2; }
    RP_CFG_ACME_ENVIRONMENT="$acme_environment_override"; export RP_CFG_ACME_ENVIRONMENT
  fi
  mode="${mode:-${RP_CFG_MODE:-}}"
  if [[ -z "$mode" ]]; then
    mode="$(rp_ui_choice 'ResourcePortal Production Installer' 'Choose installer mode' primary \
      primary 'Install Primary / Control Plane' \
      add-node 'Add Swarm Node' \
      issue-bundle 'Issue Node Enrollment Bundle' \
      upgrade 'Upgrade ResourcePortal' \
      reconfigure 'Reconfigure Installation' \
      diagnostics 'Repair / Diagnostics' \
      reset 'Reset / Clear ResourcePortal')" || return 1
  fi
  rp_mode_valid "$mode" || { printf 'Unsupported installer mode: %s\n' "$mode" >&2; return 2; }
  if [[ "$mode" == reset ]]; then
    if [[ -z "$scope" ]]; then
      if [[ "$RP_NON_INTERACTIVE" == true ]]; then
        printf '%s\n' '--scope is required for non-interactive reset' >&2
        return 2
      fi
      scope="$(rp_ui_choice 'ResourcePortal reset' 'Choose reset scope' settings \
        settings 'Clear saved installer settings' \
        installer-state 'Clear safe incomplete installer state' \
        factory 'Factory reset (DESTROYS ALL RESOURCEPORTAL DATA)')" || return 1
    fi
    rp_reset_scope_valid "$scope" || { printf 'Unsupported reset scope: %s\n' "$scope" >&2; return 2; }
    rp_reset_flags_valid "$scope" || return $?
  elif [[ "$RP_CONFIRM_FACTORY_RESET" == true || "$RP_FORCE_REMOVE_UNTRACKED_PACKAGES" == true ]]; then
    printf '%s\n' 'Factory-reset-only flags require --mode reset --scope factory.' >&2
    return 2
  fi
  RP_CFG_MODE="$mode"; export RP_CFG_MODE
  if [[ -n "$repair" ]]; then
    if declare -F rp_ui_mode_dashboard_start >/dev/null; then rp_ui_mode_dashboard_start repair || true; fi
    rp_ui_mode_operation repair repair "Running repair: $repair" rp_run_repair "$repair" || return $?
    if declare -F rp_dashboard_complete >/dev/null; then rp_dashboard_complete repair || true; fi
  else
    rp_dispatch "$mode" "$bundle" "$action" "$manifest" "$scope" "$role"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  rp_require_root || exit $?
  rp_installer_lock_acquire || exit $?
  trap 'rp_installer_lock_release; rp_ui_cleanup' EXIT
  rp_main "$@"
fi
