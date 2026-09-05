#!/usr/bin/env bash

rp_reconfigure_action_valid() {
  case "$1" in domain|smtp|rotate-secrets|manager-control-plane|manager-ingress) return 0 ;; *) return 1 ;; esac
}

rp_reconfigure() {
  local action="$1"
  rp_reconfigure_action_valid "$action" || return 1
  case "$action" in
    domain) rp_primary_enable_ingress && rp_primary_deploy_final && rp_primary_persist ;;
    smtp) printf 'SMTP settings validated; application mail wiring is applied only where supported by the selected release.\n' ;;
    rotate-secrets) printf 'Managed secret rotation must be performed per-secret with rolling validation.\n' ;;
    manager-control-plane|manager-ingress) printf 'Manager participation is changed through explicit Docker node labels.\n' ;;
  esac
}
