#!/usr/bin/env bash

rp_repair_action_valid() {
  case "$1" in storage-ready|ganesha|control-plane) return 0 ;; *) return 1 ;; esac
}

rp_run_repair() {
  local action="$1" confirmation="${RP_REPAIR_CONFIRMATION:-}"
  rp_repair_action_valid "$action" || return 1
  if [[ -z "$confirmation" ]]; then
    confirmation="$(rp_ui_input 'Repair confirmation' "Type exactly: REPAIR $action" '')" || return 1
  fi
  [[ "$confirmation" == "REPAIR $action" ]] || { printf 'Repair confirmation must be exactly: REPAIR %s\n' "$action" >&2; return 1; }
  case "$action" in
    storage-ready)
      systemctl restart resourceportal-storage-ready.service
      systemctl is-active --quiet resourceportal-storage-ready.service
      ;;
    ganesha)
      rp_validate_ganesha_config /etc/ganesha/resourceportal.conf || return 1
      systemctl restart nfs-ganesha
      systemctl is-active --quiet nfs-ganesha
      ;;
    control-plane)
      rp_deploy_control_plane final
      rp_wait_for_https_origin "${RP_CFG_DOMAIN:?RP_CFG_DOMAIN is required}" 300
      ;;
  esac
}
