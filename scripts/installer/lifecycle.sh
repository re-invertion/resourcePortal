#!/usr/bin/env bash

rp_mode_valid() {
  case "$1" in primary|add-node|upgrade|reconfigure|diagnostics) return 0 ;; *) return 1 ;; esac
}

rp_phase_done() {
  local state_file="$1" phase="$2"
  [[ -r "$state_file" ]] && grep -Fxq -- "$phase" "$state_file"
}

rp_phase_mark_done() {
  local state_file="$1" phase="$2"
  mkdir -p "$(dirname "$state_file")"
  touch "$state_file"; chmod 0600 "$state_file"
  rp_phase_done "$state_file" "$phase" || printf '%s\n' "$phase" >>"$state_file"
}

rp_run_phase() {
  local state_file="$1" phase="$2"; shift 2
  rp_phase_done "$state_file" "$phase" && return 0
  rp_log INFO "installer phase started: $phase"
  "$@" || { rp_log ERROR "installer phase failed: $phase"; return 1; }
  rp_phase_mark_done "$state_file" "$phase"
  rp_log INFO "installer phase completed: $phase"
}


rp_prompt_if_empty() {
  local var="$1" title="$2" prompt="$3" default="${4:-}" value
  value="${!var-}"
  [[ -n "$value" ]] && return 0
  value="$(rp_ui_input "$title" "$prompt" "$default")" || return 1
  [[ -n "$value" ]] || return 1
  export "$var=$value"
}

rp_collect_primary_config() {
  local state_file="${1:-${RP_INSTALLER_STATE_FILE:-/var/lib/resourceportal/installer-state/primary.state}}"
  rp_prompt_if_empty RP_CFG_CLUSTER_CIDR 'Cluster network' 'Trusted private cluster CIDR' '10.20.0.0/24'
  rp_prompt_if_empty RP_CFG_SWARM_ADVERTISE_ADDR 'Swarm' 'Primary advertise address' ''
  [[ -n "${RP_CFG_SWARM_DATA_PATH_ADDR:-}" ]] || { RP_CFG_SWARM_DATA_PATH_ADDR="$RP_CFG_SWARM_ADVERTISE_ADDR"; export RP_CFG_SWARM_DATA_PATH_ADDR; }
  [[ -n "${RP_CFG_STORAGE_SERVER_ADDRESS:-}" ]] || { RP_CFG_STORAGE_SERVER_ADDRESS="$RP_CFG_SWARM_ADVERTISE_ADDR"; export RP_CFG_STORAGE_SERVER_ADDRESS; }
  [[ -n "${RP_CFG_NFS_ADDRESS:-}" ]] || { RP_CFG_NFS_ADDRESS="$RP_CFG_STORAGE_SERVER_ADDRESS"; export RP_CFG_NFS_ADDRESS; }
  rp_prompt_if_empty RP_CFG_STORAGE_BASE_PATH 'Storage' 'Storage base path' '/srv/resource-portal/storage'
  if ! findmnt -rn -T "$RP_CFG_STORAGE_BASE_PATH" >/dev/null 2>&1; then
    rp_prompt_if_empty RP_CFG_STORAGE_DEVICE 'Storage' 'Dedicated storage block device (for example /dev/sdb)' ''
    if [[ -z "${RP_CFG_FILESYSTEM:-}" ]]; then
      RP_CFG_FILESYSTEM="$(rp_ui_choice 'Storage filesystem' 'Choose the storage filesystem' xfs 'xfs' 'XFS (recommended)' ext4 'ext4')" || return 1
      export RP_CFG_FILESYSTEM
    fi
  fi
  rp_prompt_if_empty RP_CFG_DOMAIN 'ResourcePortal domain' 'Public ResourcePortal hostname' ''
  [[ -n "${RP_CFG_ZITADEL_DOMAIN:-}" ]] || { RP_CFG_ZITADEL_DOMAIN="auth.${RP_CFG_DOMAIN}"; export RP_CFG_ZITADEL_DOMAIN; }
  rp_prompt_if_empty RP_CFG_INGRESS_ADDRESSES 'Ingress' 'Expected public ingress IP address(es), comma-separated' "$RP_CFG_SWARM_ADVERTISE_ADDR"
  rp_prompt_if_empty RP_CFG_ACME_EMAIL 'TLS / ACME' 'ACME contact email' ''
  rp_prompt_if_empty RP_CFG_RELEASE_VERSION 'Release' 'ResourcePortal release version (for example 1.0.0)' ''
  if ! rp_phase_done "$state_file" identity; then
    rp_prompt_if_empty RP_ADMIN_USERNAME 'First Platform Admin' 'Admin username' 'admin'
    rp_prompt_if_empty RP_ADMIN_EMAIL 'First Platform Admin' 'Admin email' ''
    if [[ -z "${RP_ADMIN_PASSWORD:-}" ]]; then
      RP_ADMIN_PASSWORD="$(rp_ui_password 'First Platform Admin' 'Admin password (12+ chars, upper/lower/digit/special)')" || return 1
      rp_admin_password_valid "$RP_ADMIN_PASSWORD" || { printf 'Admin password does not meet policy.\n' >&2; return 1; }
      export RP_ADMIN_PASSWORD
    fi
  fi
  if ! rp_phase_done "$state_file" smtp && [[ -z "${RP_CFG_SMTP_DEFERRED:-}" && -z "${RP_CFG_SMTP_CONFIGURED:-}" ]]; then
    case "$(rp_ui_choice 'SMTP' 'Configure SMTP now or defer it?' defer defer 'Defer SMTP' configure 'Configure and validate SMTP')" in
      defer) RP_CFG_SMTP_DEFERRED=true; RP_CFG_SMTP_CONFIGURED=false ;;
      configure)
        RP_CFG_SMTP_DEFERRED=false; RP_CFG_SMTP_CONFIGURED=true
        rp_prompt_if_empty RP_CFG_SMTP_HOST 'SMTP' 'SMTP host' ''
        rp_prompt_if_empty RP_CFG_SMTP_PORT 'SMTP' 'SMTP port' '587'
        RP_CFG_SMTP_MODE="${RP_CFG_SMTP_MODE:-$(rp_ui_choice 'SMTP' 'SMTP transport mode' starttls starttls 'STARTTLS' tls 'Implicit TLS' plain 'Plain (explicit)')}"
        rp_prompt_if_empty RP_CFG_SMTP_SENDER 'SMTP' 'Sender email' "$RP_ADMIN_EMAIL"
        rp_prompt_if_empty RP_CFG_SMTP_TEST_RECIPIENT 'SMTP' 'Test recipient email' "$RP_ADMIN_EMAIL"
        if [[ -z "${RP_CFG_SMTP_USERNAME:-}" ]]; then RP_CFG_SMTP_USERNAME="$(rp_ui_input 'SMTP' 'SMTP username (empty for no authentication)' '')"; fi
        if [[ -n "$RP_CFG_SMTP_USERNAME" && -z "${RP_SMTP_PASSWORD:-}" ]]; then RP_SMTP_PASSWORD="$(rp_ui_password 'SMTP' 'SMTP password')"; export RP_SMTP_PASSWORD; fi
        export RP_CFG_SMTP_HOST RP_CFG_SMTP_PORT RP_CFG_SMTP_MODE RP_CFG_SMTP_USERNAME RP_CFG_SMTP_SENDER RP_CFG_SMTP_TEST_RECIPIENT
        ;;
      *) return 1 ;;
    esac
    export RP_CFG_SMTP_DEFERRED RP_CFG_SMTP_CONFIGURED
  fi
}

rp_primary_phase_names() {
  printf '%s\n' preflight packages docker storage firewall swarm nfs release secrets bootstrap migrations identity smtp ingress final enrollment persist
}

rp_prepare_host_packages() {
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl gnupg jq openssl iproute2 util-linux parted gdisk \
    xfsprogs e2fsprogs quota nfs-common nfs-ganesha nfs-ganesha-vfs ufw dnsutils whiptail
}

rp_primary_prepare_storage() {
  local base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}"
  local mountpoint="${RP_CFG_STORAGE_MOUNTPOINT:-$base}" fs system_disk device type partition
  if findmnt -rn -T "$mountpoint" >/dev/null 2>&1; then
    fs="$(findmnt -nro FSTYPE -T "$mountpoint")"
    rp_validate_filesystem_type "$fs" || return 1
    rp_project_quota_enabled "$mountpoint" || return 1
  else
    device="${RP_CFG_STORAGE_DEVICE:-}"
    [[ -n "$device" ]] || { printf 'RP_CFG_STORAGE_DEVICE is required when no existing storage mount is available.\n' >&2; return 1; }
    system_disk="$(rp_system_disk)" || return 1
    rp_device_is_safe_target "$device" "$system_disk" || return 1
    rp_inspect_block_device "$device"
    if [[ -n "${RP_DESTRUCTIVE_CONFIRMATION:-}" && ! -t 0 && "${RP_ALLOW_DESTRUCTIVE_STORAGE:-false}" != true ]]; then
      printf 'Unattended destructive storage requires --allow-destructive-storage.\n' >&2
      return 1
    fi
    if [[ -z "${RP_DESTRUCTIVE_CONFIRMATION:-}" ]]; then
      RP_DESTRUCTIVE_CONFIRMATION="$(rp_ui_input 'Destructive storage confirmation' "Type exactly: FORMAT $device" '')" || return 1
    fi
    rp_require_destructive_confirmation "$device" "$RP_DESTRUCTIVE_CONFIRMATION" || return 1
    type="$(lsblk -ndo TYPE "$device")" || return 1
    fs="${RP_CFG_FILESYSTEM:-$(rp_default_filesystem)}"
    rp_validate_filesystem_type "$fs" || return 1
    if [[ "$type" == "disk" ]]; then
      rp_partition_empty_disk "$device" "$system_disk" "${RP_DESTRUCTIVE_CONFIRMATION:-}" || return 1
      partition="$(lsblk -lnpo NAME,TYPE "$device" | awk '$2=="part" {print $1; exit}')"
      [[ -n "$partition" ]] || return 1
      device="$partition"
    fi
    local format_confirmation="${RP_DESTRUCTIVE_CONFIRMATION:-}"
    [[ "$type" == "disk" ]] && format_confirmation="FORMAT $device"
    rp_format_device "$device" "$fs" "$system_disk" "$format_confirmation" || return 1
    rp_persist_filesystem_mount "$device" "$mountpoint" "$fs"
  fi
  install -d -m 0750 "$base"
  rp_storage_layout_create "$base"
  rp_mount_runtime_namespace volumes local "$base"
  rp_mount_runtime_namespace secrets local "$base"
  rp_mount_runtime_namespace platform local "$base"
  rp_project_quota_enabled "$mountpoint"
  rp_install_storage_ready_unit "$RP_INSTALLER_REPO_ROOT"
}

rp_primary_configure_firewall() {
  local ssh_port
  ssh_port="$(rp_detect_ssh_port)" || return 1
  rp_configure_ufw "$ssh_port" "${RP_CFG_CLUSTER_CIDR:?RP_CFG_CLUSTER_CIDR is required}" true
}

rp_primary_init_swarm() {
  systemctl is-active --quiet resourceportal-storage-ready.service || return 1
  rp_swarm_init "${RP_CFG_SWARM_ADVERTISE_ADDR:?}" "${RP_CFG_SWARM_DATA_PATH_ADDR:-$RP_CFG_SWARM_ADVERTISE_ADDR}"
  local node
  node="$(docker info --format '{{.Swarm.NodeID}}')" || return 1
  rp_apply_storage_labels "$node" true true true
  docker node update \
    --label-add resourceportal.storage.authoritative=true \
    --label-add resourceportal.platform.postgres-rp-writer=true \
    --label-add resourceportal.platform.postgres-zitadel-writer=true \
    --label-add resourceportal.control-plane=true \
    --label-add resourceportal.ingress=true "$node"
}

rp_primary_configure_nfs() {
  local base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}"
  rp_install_ganesha_config /etc/ganesha/resourceportal.conf "$base" "${RP_CFG_CLUSTER_CIDR:?}" "${RP_CFG_MANAGER_CIDR:-$RP_CFG_CLUSTER_CIDR}"
}

rp_primary_resolve_release() {
  local manifest="${RP_CFG_RELEASE_MANIFEST:-/var/lib/resourceportal/installer-state/release.json}" docker_version current_version
  if [[ ! -r "$manifest" ]]; then
    [[ -n "${RP_CFG_RELEASE_VERSION:-}" ]] || return 1
    mkdir -p "$(dirname "$manifest")"
    rp_download_release_manifest "$RP_CFG_RELEASE_VERSION" "$manifest" || return 1
  fi
  docker_version="$(docker version --format '{{.Server.Version}}')" || return 1
  current_version="${RP_CFG_INSTALLED_VERSION:-0.0.0}"
  rp_release_compatible "$manifest" "${RP_INSTALLER_VERSION:-0.1.0}" "$current_version" "$docker_version" || return 1
  rp_apply_release_manifest_images "$manifest"
  RP_CFG_RELEASE_MANIFEST="$manifest"; export RP_CFG_RELEASE_MANIFEST
}

rp_primary_create_platform_secrets() {
  local dir=/var/lib/resourceportal/installer-state/secrets dbpass zdbpass master enc cookie worker oidc_placeholder dburl
  install -d -m 0700 "$dir"
  for name in encryption cookie worker oidc-placeholder; do
    [[ -r "$dir/$name" ]] || rp_generate_secret_file "$dir/$name" 32
  done
  [[ -r "$dir/rp-postgres" ]] || { umask 077; openssl rand -hex 24 >"$dir/rp-postgres"; chmod 0600 "$dir/rp-postgres"; }
  [[ -r "$dir/zitadel-postgres" ]] || { umask 077; openssl rand -hex 24 >"$dir/zitadel-postgres"; chmod 0600 "$dir/zitadel-postgres"; }
  [[ -r "$dir/zitadel-master" ]] || { umask 077; openssl rand -hex 16 >"$dir/zitadel-master"; chmod 0600 "$dir/zitadel-master"; }
  dbpass="$dir/rp-postgres"; zdbpass="$dir/zitadel-postgres"; master="$dir/zitadel-master"; enc="$dir/encryption"; cookie="$dir/cookie"; worker="$dir/worker"; oidc_placeholder="$dir/oidc-placeholder"
  dburl="$dir/database-url"
  printf 'postgresql://resource_portal:%s@postgres-rp:5432/resource_portal?schema=public' "$(cat "$dbpass")" >"$dburl"; chmod 0600 "$dburl"
  rp_ensure_swarm_secret rp_postgres_password "$dbpass"
  rp_ensure_swarm_secret zitadel_postgres_password "$zdbpass"
  rp_ensure_swarm_secret zitadel_masterkey "$master"
  rp_ensure_swarm_secret rp_encryption_key "$enc"
  RP_CFG_COOKIE_SWARM_REF="$(rp_ensure_versioned_swarm_secret rp_cookie_secret "$cookie")" || return 1
  RP_CFG_WORKER_SWARM_REF="$(rp_ensure_versioned_swarm_secret rp_internal_worker_token "$worker")" || return 1
  export RP_CFG_COOKIE_SWARM_REF RP_CFG_WORKER_SWARM_REF
  rp_ensure_swarm_secret rp_database_url "$dburl"
  RP_CFG_OIDC_SWARM_REF="$(rp_ensure_versioned_swarm_secret rp_oidc_client_secret "$oidc_placeholder")"
  RP_CFG_OIDC_CLIENT_ID="bootstrap-pending"
  export RP_CFG_OIDC_SWARM_REF RP_CFG_OIDC_CLIENT_ID
}

rp_primary_bootstrap_stack() {
  local etc=/etc/resourceportal secret_dir=/var/lib/resourceportal/installer-state/secrets
  install -d -m 0700 "$etc" "${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}/platform/zitadel-bootstrap"
  install -m 0555 "$RP_INSTALLER_REPO_ROOT/config/production/postgres-fence.sh" "$etc/postgres-fence.sh"
  rp_render_zitadel_public_config "$RP_CFG_ZITADEL_DOMAIN" >"$etc/zitadel-config.yaml"; chmod 0644 "$etc/zitadel-config.yaml"
  rp_render_zitadel_secret_config postgres "$(cat "$secret_dir/zitadel-postgres")" "$(cat "$secret_dir/zitadel-postgres")" >"$secret_dir/zitadel-secret.yaml"; chmod 0600 "$secret_dir/zitadel-secret.yaml"
  rp_render_zitadel_init_steps resourceportal-bootstrap "$(cat "$secret_dir/cookie")" >"$secret_dir/zitadel-init.yaml"; chmod 0600 "$secret_dir/zitadel-init.yaml"
  rp_ensure_swarm_secret zitadel_secret_config "$secret_dir/zitadel-secret.yaml"
  rp_ensure_swarm_secret zitadel_init_steps "$secret_dir/zitadel-init.yaml"
  rp_deploy_control_plane bootstrap
}

rp_wait_service_replicas() {
  local service="$1" wanted="${2:-1}" timeout="${3:-300}" elapsed=0 actual
  while (( elapsed < timeout )); do
    actual="$(docker service inspect "$service" --format '{{if .ServiceStatus}}{{.ServiceStatus.RunningTasks}}{{else}}0{{end}}' 2>/dev/null || printf 0)"
    [[ "$actual" == "$wanted" ]] && return 0
    sleep 2; elapsed=$((elapsed+2))
  done
  return 1
}

rp_primary_run_migrations() {
  local stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  rp_wait_service_replicas "${stack}_postgres-rp" 1 300 || return 1
  rp_wait_service_replicas "${stack}_zitadel" 1 300 || return 1
  rp_run_migrations
}

rp_primary_bootstrap_identity() {
  local secret_dir=/var/lib/resourceportal/installer-state/secrets output=/var/lib/resourceportal/installer-state/zitadel-bootstrap.json
  local admin_file="$secret_dir/first-admin-password"
  [[ -n "${RP_ADMIN_EMAIL:-}" && -n "${RP_ADMIN_USERNAME:-}" && -n "${RP_ADMIN_PASSWORD:-}" ]] || return 1
  rp_admin_password_valid "$RP_ADMIN_PASSWORD" || return 1
  printf '%s' "$RP_ADMIN_PASSWORD" >"$admin_file"; chmod 0600 "$admin_file"
  rp_ensure_swarm_secret rp_first_admin_password "$admin_file"
  rp_run_zitadel_bootstrap "$output" "$RP_ADMIN_USERNAME" "$RP_ADMIN_EMAIL" "$admin_file" || return 1
  rp_apply_zitadel_bootstrap_output "$output" || return 1
  rp_remove_secret_file "$admin_file"
  unset RP_ADMIN_PASSWORD
}

rp_primary_configure_smtp() {
  [[ "${RP_CFG_SMTP_DEFERRED:-false}" == "true" ]] && return 0
  [[ "${RP_CFG_SMTP_CONFIGURED:-false}" == "true" ]] || return 1
  local password_file="" ref=""
  if [[ -n "${RP_CFG_SMTP_USERNAME:-}" ]]; then
    [[ -n "${RP_SMTP_PASSWORD:-}" ]] || return 1
    password_file="$(mktemp /tmp/resourceportal-smtp-password.XXXXXX)" || return 1
    chmod 0600 "$password_file"; printf '%s' "$RP_SMTP_PASSWORD" >"$password_file"
  fi
  rp_test_smtp "$RP_CFG_SMTP_HOST" "$RP_CFG_SMTP_PORT" "$RP_CFG_SMTP_MODE" "${RP_CFG_SMTP_USERNAME:-}" "$password_file" "$RP_CFG_SMTP_SENDER" "$RP_CFG_SMTP_TEST_RECIPIENT" || { [[ -z "$password_file" ]] || rp_remove_secret_file "$password_file"; return 1; }
  if [[ -n "$password_file" ]]; then
    ref="$(rp_ensure_versioned_swarm_secret rp_smtp_password "$password_file")" || return 1
    RP_CFG_SMTP_SWARM_REF="$ref"; export RP_CFG_SMTP_SWARM_REF
    rp_remove_secret_file "$password_file"; unset RP_SMTP_PASSWORD
  fi
}

rp_primary_enable_ingress() {
  rp_validate_domain_dns "$RP_CFG_DOMAIN" "$RP_CFG_INGRESS_ADDRESSES" || return 1
  rp_validate_domain_dns "$RP_CFG_ZITADEL_DOMAIN" "$RP_CFG_INGRESS_ADDRESSES" || return 1
  rp_deploy_control_plane ingress
  rp_wait_for_https_certificate "$RP_CFG_DOMAIN" 300 || return 1
  rp_wait_for_https_certificate "$RP_CFG_ZITADEL_DOMAIN" 300
}

rp_primary_deploy_final() {
  rp_deploy_control_plane final
  rp_wait_for_https_origin "$RP_CFG_DOMAIN" 300
}

rp_primary_start_enrollment() {
  local dir=/var/lib/resourceportal/installer-state/enrollment
  local cert="$dir/tls.crt" key="$dir/tls.key"
  install -d -m 0700 "$dir"
  [[ -r "$cert" && -r "$key" ]] || rp_generate_enrollment_tls_identity "$cert" "$key" "$RP_CFG_SWARM_ADVERTISE_ADDR"
  rp_start_enrollment_listener "$cert" "$key"
  RP_CFG_ENROLLMENT_PIN="$(rp_spki_pin "$cert")"; export RP_CFG_ENROLLMENT_PIN
}

rp_primary_persist() {
  rp_config_write /etc/resourceportal/installer.conf
  rp_write_stack final /etc/resourceportal/stack.yml
}

rp_primary_install() {
  local state_file="${RP_INSTALLER_STATE_FILE:-/var/lib/resourceportal/installer-state/primary.state}"
  rp_collect_primary_config "$state_file" || return 1
  rp_run_phase "$state_file" preflight rp_preflight_system
  rp_run_phase "$state_file" packages rp_prepare_host_packages
  rp_run_phase "$state_file" docker rp_ensure_docker "${RP_CFG_MIN_DOCKER_VERSION:-27.0.0}"
  rp_run_phase "$state_file" storage rp_primary_prepare_storage
  rp_run_phase "$state_file" firewall rp_primary_configure_firewall
  rp_run_phase "$state_file" swarm rp_primary_init_swarm
  rp_run_phase "$state_file" nfs rp_primary_configure_nfs
  rp_run_phase "$state_file" release rp_primary_resolve_release
  rp_run_phase "$state_file" secrets rp_primary_create_platform_secrets
  rp_run_phase "$state_file" bootstrap rp_primary_bootstrap_stack
  rp_run_phase "$state_file" migrations rp_primary_run_migrations
  rp_run_phase "$state_file" identity rp_primary_bootstrap_identity
  rp_run_phase "$state_file" smtp rp_primary_configure_smtp
  rp_run_phase "$state_file" ingress rp_primary_enable_ingress
  rp_run_phase "$state_file" final rp_primary_deploy_final
  rp_run_phase "$state_file" enrollment rp_primary_start_enrollment
  rp_run_phase "$state_file" persist rp_primary_persist
}
