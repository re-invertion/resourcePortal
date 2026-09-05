#!/usr/bin/env bash

rp_reconfigure_action_valid() {
  case "$1" in
    domain|smtp|rotate-secrets|manager-control-plane|manager-ingress|addresses) return 0 ;;
    *) return 1 ;;
  esac
}

rp_reconfigure_domain() {
  local old_domain="${RP_CFG_DOMAIN:-}" old_zitadel="${RP_CFG_ZITADEL_DOMAIN:-}" old_email="${RP_CFG_ACME_EMAIL:-}" old_ingress="${RP_CFG_INGRESS_ADDRESSES:-}"
  RP_CFG_DOMAIN="$(rp_ui_input 'Reconfigure domain' 'ResourcePortal hostname' "$old_domain")" || return 1
  RP_CFG_ZITADEL_DOMAIN="$(rp_ui_input 'Reconfigure domain' 'ZITADEL hostname' "${old_zitadel:-auth.$RP_CFG_DOMAIN}")" || return 1
  RP_CFG_ACME_EMAIL="$(rp_ui_input 'Reconfigure domain' 'ACME contact email' "$old_email")" || return 1
  RP_CFG_INGRESS_ADDRESSES="$(rp_ui_input 'Reconfigure domain' 'Expected ingress IP address(es), comma-separated' "$old_ingress")" || return 1
  export RP_CFG_DOMAIN RP_CFG_ZITADEL_DOMAIN RP_CFG_ACME_EMAIL RP_CFG_INGRESS_ADDRESSES
  if rp_primary_enable_ingress && rp_primary_deploy_final; then
    rp_primary_persist
    return 0
  fi
  RP_CFG_DOMAIN="$old_domain"; RP_CFG_ZITADEL_DOMAIN="$old_zitadel"; RP_CFG_ACME_EMAIL="$old_email"; RP_CFG_INGRESS_ADDRESSES="$old_ingress"
  export RP_CFG_DOMAIN RP_CFG_ZITADEL_DOMAIN RP_CFG_ACME_EMAIL RP_CFG_INGRESS_ADDRESSES
  rp_deploy_control_plane final >/dev/null 2>&1 || true
  return 1
}

rp_reconfigure_smtp() {
  RP_CFG_SMTP_DEFERRED=false
  RP_CFG_SMTP_CONFIGURED=true
  RP_CFG_SMTP_HOST="$(rp_ui_input 'SMTP' 'SMTP host' "${RP_CFG_SMTP_HOST:-}")" || return 1
  RP_CFG_SMTP_PORT="$(rp_ui_input 'SMTP' 'SMTP port' "${RP_CFG_SMTP_PORT:-587}")" || return 1
  RP_CFG_SMTP_MODE="$(rp_ui_choice 'SMTP' 'SMTP transport mode' "${RP_CFG_SMTP_MODE:-starttls}" starttls 'STARTTLS' tls 'Implicit TLS' plain 'Plain (explicit)')" || return 1
  RP_CFG_SMTP_SENDER="$(rp_ui_input 'SMTP' 'Sender email' "${RP_CFG_SMTP_SENDER:-}")" || return 1
  RP_CFG_SMTP_TEST_RECIPIENT="$(rp_ui_input 'SMTP' 'Test recipient email' "${RP_CFG_SMTP_TEST_RECIPIENT:-}")" || return 1
  RP_CFG_SMTP_USERNAME="$(rp_ui_input 'SMTP' 'SMTP username (empty for no authentication)' "${RP_CFG_SMTP_USERNAME:-}")" || return 1
  if [[ -n "$RP_CFG_SMTP_USERNAME" ]]; then
    RP_SMTP_PASSWORD="$(rp_ui_password 'SMTP' 'SMTP password')" || return 1
    export RP_SMTP_PASSWORD
  fi
  export RP_CFG_SMTP_DEFERRED RP_CFG_SMTP_CONFIGURED RP_CFG_SMTP_HOST RP_CFG_SMTP_PORT RP_CFG_SMTP_MODE RP_CFG_SMTP_SENDER RP_CFG_SMTP_TEST_RECIPIENT RP_CFG_SMTP_USERNAME
  rp_primary_configure_smtp || return 1
  rp_config_write /etc/resourceportal/installer.conf
}

rp_reconfigure_rotate_secret() {
  local kind="${RP_RECONFIGURE_SECRET_KIND:-}" tmp old_ref new_ref
  if [[ -z "$kind" ]]; then
    kind="$(rp_ui_choice 'Rotate managed secret' 'Select a safe rotating secret' cookie cookie 'Browser cookie signing secret' worker 'Internal worker token')" || return 1
  fi
  tmp="$(mktemp /tmp/resourceportal-rotate-secret.XXXXXX)" || return 1
  chmod 0600 "$tmp"
  rp_generate_secret_file "$tmp" 48 || { rm -f "$tmp"; return 1; }
  case "$kind" in
    cookie)
      old_ref="${RP_CFG_COOKIE_SWARM_REF:?missing cookie secret reference}"
      new_ref="$(rp_ensure_versioned_swarm_secret rp_cookie_secret "$tmp")" || { rp_remove_secret_file "$tmp"; return 1; }
      RP_CFG_COOKIE_SWARM_REF="$new_ref"; export RP_CFG_COOKIE_SWARM_REF
      ;;
    worker)
      old_ref="${RP_CFG_WORKER_SWARM_REF:?missing worker token reference}"
      new_ref="$(rp_ensure_versioned_swarm_secret rp_internal_worker_token "$tmp")" || { rp_remove_secret_file "$tmp"; return 1; }
      RP_CFG_WORKER_SWARM_REF="$new_ref"; export RP_CFG_WORKER_SWARM_REF
      ;;
    *) rp_remove_secret_file "$tmp"; return 1 ;;
  esac
  rp_remove_secret_file "$tmp"
  if rp_deploy_control_plane final && rp_wait_for_https_origin "${RP_CFG_DOMAIN:?}" 300; then
    rp_config_write /etc/resourceportal/installer.conf
    rp_write_stack final /etc/resourceportal/stack.yml
    return 0
  fi
  if [[ "$kind" == cookie ]]; then RP_CFG_COOKIE_SWARM_REF="$old_ref"; export RP_CFG_COOKIE_SWARM_REF; else RP_CFG_WORKER_SWARM_REF="$old_ref"; export RP_CFG_WORKER_SWARM_REF; fi
  rp_deploy_control_plane final >/dev/null 2>&1 || true
  return 1
}

rp_reconfigure_manager_label() {
  local label="$1" node="${RP_RECONFIGURE_NODE:-}" enabled="${RP_RECONFIGURE_ENABLED:-}"
  [[ -n "$node" ]] || node="$(rp_ui_input 'Manager participation' 'Docker node ID/name' '')" || return 1
  [[ "$(docker node inspect "$node" --format '{{.Spec.Role}}' 2>/dev/null)" == manager ]] || { printf 'Target node is not a Swarm manager.\n' >&2; return 1; }
  if [[ -z "$enabled" ]]; then enabled="$(rp_ui_choice 'Manager participation' 'Enable or disable participation?' true true 'Enable' false 'Disable')" || return 1; fi
  case "$enabled" in
    true) docker node update --label-add "${label}=true" "$node" ;;
    false) docker node update --label-rm "$label" "$node" ;;
    *) return 1 ;;
  esac
}

rp_nfs_server_reachable() {
  local host="$1"
  [[ -n "$host" ]] || return 1
  timeout 5 bash -c "exec 3<>/dev/tcp/${host}/2049" 2>/dev/null
}

rp_reconfigure_addresses() {
  local old_cidr="${RP_CFG_CLUSTER_CIDR:?}" old_storage="${RP_CFG_STORAGE_SERVER_ADDRESS:?}" new_cidr new_storage node role authoritative ssh_port
  new_cidr="${RP_RECONFIGURE_CLUSTER_CIDR_NEW:-$(rp_ui_input 'Network migration' 'New trusted cluster CIDR' "$old_cidr")}" || return 1
  new_storage="${RP_RECONFIGURE_STORAGE_SERVER_NEW:-$(rp_ui_input 'Network migration' 'New NFS/storage server address' "$old_storage")}" || return 1
  rp_nfs_server_reachable "$new_storage" || { printf 'New NFS/storage server is not reachable on TCP/2049.\n' >&2; return 1; }
  ssh_port="$(rp_detect_ssh_port)" || return 1
  # Add new firewall rules before touching existing connectivity; old rules remain during migration.
  rp_configure_ufw "$ssh_port" "$new_cidr" "${RP_JOIN_INGRESS:-false}" || return 1
  node="$(docker info --format '{{.Swarm.NodeID}}')" || return 1
  role="$(docker info --format '{{if .Swarm.ControlAvailable}}manager{{else}}worker{{end}}')" || return 1
  authoritative="$(docker node inspect "$node" --format '{{index .Spec.Labels "resourceportal.storage.authoritative"}}' 2>/dev/null || true)"
  if [[ "$authoritative" == true ]]; then
    # During migration accept both client networks. Final removal of the old CIDR is a separate confirmed operation.
    rp_install_ganesha_config /etc/ganesha/resourceportal.conf "${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}" "${old_cidr},${new_cidr}" "${old_cidr},${new_cidr}" || return 1
  else
    docker node update --availability drain "$node" || return 1
    if ! rp_mount_runtime_namespace volumes nfs "$new_storage"; then docker node update --availability active "$node" || true; return 1; fi
    if [[ "$role" == manager ]]; then
      if ! rp_mount_runtime_namespace secrets nfs "$new_storage" || ! rp_mount_runtime_namespace platform nfs "$new_storage"; then docker node update --availability active "$node" || true; return 1; fi
    fi
    docker node update --availability active "$node" || return 1
  fi
  RP_CFG_CLUSTER_CIDR="$new_cidr"; RP_CFG_STORAGE_SERVER_ADDRESS="$new_storage"; RP_CFG_NFS_ADDRESS="$new_storage"
  export RP_CFG_CLUSTER_CIDR RP_CFG_STORAGE_SERVER_ADDRESS RP_CFG_NFS_ADDRESS
  rp_config_write /etc/resourceportal/installer.conf
}

rp_reconfigure() {
  local action="$1"
  rp_reconfigure_action_valid "$action" || return 1
  case "$action" in
    domain) rp_reconfigure_domain ;;
    smtp) rp_reconfigure_smtp ;;
    rotate-secrets) rp_reconfigure_rotate_secret ;;
    manager-control-plane) rp_reconfigure_manager_label resourceportal.control-plane ;;
    manager-ingress) rp_reconfigure_manager_label resourceportal.ingress ;;
    addresses) rp_reconfigure_addresses ;;
  esac
}
