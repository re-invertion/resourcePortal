#!/usr/bin/env bash

RP_CONFIG_KEYS=(
  RP_CFG_MODE
  RP_CFG_STORAGE_BASE_PATH
  RP_CFG_SWARM_ADVERTISE_ADDR
  RP_CFG_SWARM_DATA_PATH_ADDR
  RP_CFG_STORAGE_SERVER_ADDRESS
  RP_CFG_NFS_ADDRESS
  RP_CFG_DOMAIN
  RP_CFG_GATE_ENDPOINT_HOST
  RP_CFG_MANAGED_DOMAIN_BASE
  RP_CFG_ZITADEL_DOMAIN
  RP_CFG_LEGACY_DOMAIN
  RP_CFG_LEGACY_ZITADEL_DOMAIN
  RP_CFG_ACME_EMAIL
  RP_CFG_ACME_ENVIRONMENT
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
  RP_CFG_OIDC_CLIENT_ID
  RP_CFG_OIDC_CLI_CLIENT_ID
  RP_CFG_OIDC_SWARM_REF
  RP_CFG_OIDC_EXTRA_CA_B64
  RP_CFG_ZITADEL_KEY_SWARM_REF
  RP_CFG_ZITADEL_ORGANIZATION_ID
  RP_CFG_ZITADEL_PROJECT_ID
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  RP_CFG_ZITADEL_PUBLIC_CONFIG_REF
  RP_CFG_COOKIE_SWARM_REF
  RP_CFG_WORKER_SWARM_REF
  RP_CFG_STACK_NAME
  RP_CFG_RELEASE_VERSION
  RP_CFG_STORAGE_MOUNTPOINT
  RP_CFG_STORAGE_DEVICE
  RP_CFG_FILESYSTEM
  RP_CFG_CLUSTER_CIDR
  RP_CFG_MANAGER_CIDR
  RP_CFG_INGRESS_ADDRESSES
  RP_CFG_RELEASE_MANIFEST
  RP_CFG_INSTALLED_VERSION
  RP_CFG_MIN_DOCKER_VERSION
  RP_CFG_ENROLLMENT_PIN
  RP_CFG_ENROLLMENT_PORT
  RP_CFG_SMTP_CONFIGURED
  RP_CFG_SMTP_DEFERRED
  RP_CFG_SMTP_TEST_RECIPIENT
  RP_CFG_SMTP_SWARM_REF
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

rp_config_apply_defaults() {
  if [[ -n "${RP_CFG_DOMAIN:-}" && -z "${RP_CFG_MANAGED_DOMAIN_BASE:-}" ]]; then
    RP_CFG_MANAGED_DOMAIN_BASE="$RP_CFG_DOMAIN"
    export RP_CFG_MANAGED_DOMAIN_BASE
  fi
  if [[ -n "${RP_CFG_DOMAIN:-}" && -z "${RP_CFG_GATE_ENDPOINT_HOST:-}" ]]; then
    RP_CFG_GATE_ENDPOINT_HOST="$RP_CFG_DOMAIN"
    export RP_CFG_GATE_ENDPOINT_HOST
  fi
  if [[ "${RP_CFG_ACME_ENVIRONMENT:-production}" == production ]]; then
    unset RP_CFG_OIDC_EXTRA_CA_B64
  fi
}

rp_config_write() {
  local path="$1" key value tmp
  rp_config_apply_defaults
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

# Strictly parse the printf %q serialization instead of executing it.
# REPLY is filled only on success; no shell code from config runs.
rp_config_decode_value() {
  local encoded="$1" i=0 char result="" body
  if [[ "$encoded" == "''" ]]; then REPLY=""; return 0; fi
  if [[ "${encoded:0:2}" == "\$'" ]]; then
    [[ "${encoded: -1}" == "'" && ${#encoded} -ge 3 ]] || return 1
    body="${encoded:2:${#encoded}-3}"
    while (( i < ${#body} )); do
      char="${body:i:1}"
      if [[ "$char" == "\\" ]]; then
        ((i+=1)); (( i < ${#body} )) || return 1
      elif [[ "$char" == "'" ]]; then
        return 1
      fi
      ((i+=1))
    done
    printf -v REPLY '%b' "$body"
    return 0
  fi
  while (( i < ${#encoded} )); do
    char="${encoded:i:1}"
    if [[ "$char" == "\\" ]]; then
      ((i+=1)); (( i < ${#encoded} )) || return 1
      result+="${encoded:i:1}"
    elif [[ "$char" =~ ^[a-zA-Z0-9_./:@%+=,#-]$ ]]; then
      result+="$char"
    else
      return 1
    fi
    ((i+=1))
  done
  REPLY="$result"
}

rp_config_load() {
  local path="$1" line key encoded i owner mode
  local -a keys=() values=()
  [[ -f "$path" && -r "$path" && ! -L "$path" ]] || return 1
  if [[ "$EUID" -eq 0 ]]; then
    owner="$(stat -c '%u' -- "$path")" || return 1
    mode="$(stat -c '%a' -- "$path")" || return 1
    [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
    (( (8#$mode & 0022) == 0 )) || return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || return 1
    key="${line%%=*}"
    encoded="${line#*=}"
    rp_config_key_allowed "$key" || continue
    rp_config_decode_value "$encoded" || return 1
    keys+=("$key")
    values+=("$REPLY")
  done <"$path"
  for (( i=0; i<${#keys[@]}; i++ )); do
    export "${keys[i]}=${values[i]}"
  done
  rp_config_apply_defaults
}
