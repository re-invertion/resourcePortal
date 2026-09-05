#!/usr/bin/env bash

RP_CONFIG_KEYS=(
  RP_CFG_MODE
  RP_CFG_STORAGE_BASE_PATH
  RP_CFG_SWARM_ADVERTISE_ADDR
  RP_CFG_SWARM_DATA_PATH_ADDR
  RP_CFG_STORAGE_SERVER_ADDRESS
  RP_CFG_NFS_ADDRESS
  RP_CFG_DOMAIN
  RP_CFG_ACME_EMAIL
  RP_CFG_SMTP_HOST
  RP_CFG_SMTP_PORT
  RP_CFG_SMTP_MODE
  RP_CFG_SMTP_USERNAME
  RP_CFG_SMTP_SENDER
  RP_CFG_API_IMAGE
  RP_CFG_WEB_IMAGE
  RP_CFG_POSTGRES_IMAGE
  RP_CFG_ZITADEL_IMAGE
  RP_CFG_TRAEFIK_IMAGE
  RP_CFG_PLATFORM_ADMIN_IDS
  RP_CFG_STACK_NAME
  RP_CFG_RELEASE_VERSION
  RP_CFG_INSTALLER_SCHEMA_VERSION
)

rp_config_key_allowed() {
  local candidate="$1" key
  case "$candidate" in
    *PASSWORD*|*SECRET*|*TOKEN*|*MASTERKEY*|*PRIVATE_KEY*|*CREDENTIAL*) return 1 ;;
  esac
  for key in "${RP_CONFIG_KEYS[@]}"; do
    [[ "$candidate" == "$key" ]] && return 0
  done
  return 1
}

rp_config_write() {
  local path="$1" key value tmp
  tmp="${path}.tmp.$$"
  umask 077
  mkdir -p "$(dirname "$path")"
  : >"$tmp"
  for key in "${RP_CONFIG_KEYS[@]}"; do
    rp_config_key_allowed "$key" || continue
    value="${!key-}"
    [[ -n "$value" ]] || continue
    printf '%s=%q\n' "$key" "$value" >>"$tmp"
  done
  chmod 0600 "$tmp"
  mv -f "$tmp" "$path"
}

rp_config_load() {
  local path="$1" line key value
  [[ -r "$path" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    rp_config_key_allowed "$key" || continue
    eval "value=$value"
    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$path"
}
