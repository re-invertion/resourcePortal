#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/common.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/ui.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/system.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/config.sh"

rp_usage() {
  cat <<'USAGE'
Usage: sudo ./resourceportal-install.sh [--config PATH] [--help]

ResourcePortal Production Installer v1.
USAGE
}

rp_main() {
  local config_path=""
  while (($#)); do
    case "$1" in
      --config)
        [[ $# -ge 2 ]] || { printf '%s\n' '--config requires a path' >&2; return 2; }
        config_path="$2"
        shift 2
        ;;
      --help|-h)
        rp_usage
        return 0
        ;;
      *)
        printf 'Unknown argument: %s\n' "$1" >&2
        return 2
        ;;
    esac
  done

  rp_preflight_system >/dev/null
  if [[ -n "$config_path" ]]; then
    rp_config_load "$config_path"
  fi
  rp_ui_message "ResourcePortal" "Production Installer core preflight passed."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  rp_main "$@"
fi
