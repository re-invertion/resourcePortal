#!/usr/bin/env bash

rp_diagnostic_line() { printf '%-34s %s\n' "$1" "$2"; }
rp_diagnostic_cmd() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then rp_diagnostic_line "$name" OK; else rp_diagnostic_line "$name" FAIL; fi; }

rp_run_diagnostics() {
  local base="${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}" stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}" quorum
  rp_diagnostic_cmd 'supported OS' rp_detect_os
  rp_diagnostic_cmd 'Docker daemon' docker info
  rp_diagnostic_cmd 'Swarm active' test "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)" = active
  quorum="$(rp_check_manager_quorum 2>/dev/null || true)"; rp_diagnostic_line 'manager quorum' "${quorum:-unavailable}"
  rp_diagnostic_cmd 'storage mount' findmnt -T "$base"
  rp_diagnostic_cmd 'project quota' rp_project_quota_enabled "$base"
  rp_diagnostic_cmd 'volumes runtime mount' mountpoint -q /mnt/resourceportal/volumes
  rp_diagnostic_cmd 'secrets runtime mount' mountpoint -q /mnt/resourceportal/secrets
  rp_diagnostic_cmd 'platform runtime mount' mountpoint -q /mnt/resourceportal/platform
  rp_diagnostic_cmd 'NFS-Ganesha service' systemctl is-active --quiet nfs-ganesha
  rp_diagnostic_cmd 'storage readiness service' systemctl is-active --quiet resourceportal-storage-ready
  rp_diagnostic_cmd 'control-plane stack' docker stack services "$stack"
  [[ -n "${RP_CFG_DOMAIN:-}" ]] && rp_diagnostic_cmd 'ResourcePortal HTTPS' rp_validate_https_origin "$RP_CFG_DOMAIN"
  [[ -n "${RP_CFG_ZITADEL_DOMAIN:-}" ]] && rp_diagnostic_cmd 'ZITADEL HTTPS certificate' rp_validate_https_certificate "$RP_CFG_ZITADEL_DOMAIN"
  [[ -n "${RP_CFG_RELEASE_VERSION:-}" ]] && rp_diagnostic_line 'installed release' "$RP_CFG_RELEASE_VERSION"
  rp_diagnostic_line 'storage HA' 'NOT PROVIDED in v1 (single storage host SPOF)'
  return 0
}
