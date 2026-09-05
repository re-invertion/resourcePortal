#!/usr/bin/env bash

rp_diagnostic_line() { printf '%-34s %s\n' "$1" "$2"; }
rp_diagnostic_cmd() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then rp_diagnostic_line "$name" OK; else rp_diagnostic_line "$name" FAIL; fi; }

rp_run_diagnostics() {
  local base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}" stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}" quorum node_id fstype uuid
  rp_diagnostic_cmd 'supported OS' rp_detect_os
  rp_diagnostic_cmd 'Docker daemon' docker info
  rp_diagnostic_cmd 'UFW status' ufw status
  rp_diagnostic_cmd 'Swarm active' test "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" = active
  quorum="$(rp_check_manager_quorum 2>/dev/null || true)"; rp_diagnostic_line 'manager quorum' "${quorum:-unavailable}"
  node_id="$(docker info --format '{{.Swarm.NodeID}}' 2>/dev/null || true)"
  [[ -n "$node_id" ]] && rp_diagnostic_cmd 'local Swarm node labels' docker node inspect "$node_id"
  rp_diagnostic_cmd 'storage mount' findmnt -T "$base"
  fstype="$(findmnt -nro FSTYPE -T "$base" 2>/dev/null || true)"; rp_diagnostic_line 'storage filesystem' "${fstype:-unavailable}"
  uuid="$(findmnt -nro UUID -T "$base" 2>/dev/null || true)"; rp_diagnostic_line 'storage UUID' "${uuid:-unavailable}"
  rp_diagnostic_cmd 'fstab storage entry' grep -F "$base" /etc/fstab
  rp_diagnostic_cmd 'project quota' rp_project_quota_enabled "$base"
  if command -v df >/dev/null 2>&1; then
    rp_diagnostic_line 'storage capacity' "$(df -B1 --output=size,avail "$base" 2>/dev/null | tail -1 | xargs || printf unavailable)"
  fi
  rp_diagnostic_cmd 'volumes runtime mount' mountpoint -q /mnt/resourceportal/volumes
  rp_diagnostic_cmd 'secrets runtime mount' mountpoint -q /mnt/resourceportal/secrets
  rp_diagnostic_cmd 'platform runtime mount' mountpoint -q /mnt/resourceportal/platform
  rp_diagnostic_cmd 'NFS-Ganesha service' systemctl is-active --quiet nfs-ganesha
  rp_diagnostic_cmd 'NFS-Ganesha managed config' test -r /etc/ganesha/resourceportal.conf
  rp_diagnostic_cmd 'storage readiness service' systemctl is-active --quiet resourceportal-storage-ready
  rp_diagnostic_cmd 'control-plane stack' docker stack services "$stack"
  rp_diagnostic_cmd 'RP PostgreSQL service' docker service inspect "${stack}_postgres-rp"
  rp_diagnostic_cmd 'ZITADEL PostgreSQL service' docker service inspect "${stack}_postgres-zitadel"
  rp_diagnostic_cmd 'ZITADEL service' docker service inspect "${stack}_zitadel"
  rp_diagnostic_cmd 'enrollment listener' docker service inspect "${stack}-installer-enrollment"
  [[ -n "${RP_CFG_DOMAIN:-}" ]] && rp_diagnostic_cmd 'ResourcePortal HTTPS' rp_validate_https_origin "$RP_CFG_DOMAIN"
  [[ -n "${RP_CFG_ZITADEL_DOMAIN:-}" ]] && rp_diagnostic_cmd 'ZITADEL HTTPS certificate' rp_validate_https_certificate "$RP_CFG_ZITADEL_DOMAIN"
  [[ -n "${RP_CFG_RELEASE_VERSION:-}" ]] && rp_diagnostic_line 'installed release' "$RP_CFG_RELEASE_VERSION"
  [[ -n "${RP_CFG_API_IMAGE:-}" ]] && rp_diagnostic_line 'API image' "$RP_CFG_API_IMAGE"
  [[ -n "${RP_CFG_WEB_IMAGE:-}" ]] && rp_diagnostic_line 'Web image' "$RP_CFG_WEB_IMAGE"
  rp_diagnostic_line 'storage HA' 'NOT PROVIDED in v1 (single storage host SPOF)'
  return 0
}
