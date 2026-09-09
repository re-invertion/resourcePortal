#!/usr/bin/env bash

rp_default_route_interface_text() {
  local text="$1"
  awk '{ for (i=1; i<=NF; i++) if ($i == "dev" && i < NF) { print $(i+1); exit } }' <<<"$text"
}

rp_default_route_address_text() {
  local text="$1"
  awk '{ for (i=1; i<=NF; i++) if ($i == "src" && i < NF) { print $(i+1); exit } }' <<<"$text"
}

rp_ipv4_network_cidr() {
  local value="$1" ip prefix a b c d network mask
  [[ "$value" == */* ]] || return 1
  ip="${value%/*}"
  prefix="${value#*/}"
  [[ "$prefix" =~ ^[0-9]+$ ]] || return 1
  (( prefix >= 0 && prefix <= 32 )) || return 1
  IFS=. read -r a b c d <<<"$ip"
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]+$ ]] || return 1
    (( 10#$octet >= 0 && 10#$octet <= 255 )) || return 1
  done
  network=$(( (10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d ))
  if (( prefix == 0 )); then
    mask=0
  else
    mask=$(( (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
  fi
  network=$(( network & mask ))
  printf '%d.%d.%d.%d/%d\n' \
    $(( (network >> 24) & 255 )) \
    $(( (network >> 16) & 255 )) \
    $(( (network >> 8) & 255 )) \
    $(( network & 255 )) \
    "$prefix"
}

rp_detect_default_route_interface() {
  command -v ip >/dev/null 2>&1 || return 1
  local route interface
  route="$(ip -o -4 route show default 2>/dev/null | head -n1)"
  interface="$(rp_default_route_interface_text "$route")"
  [[ -n "$interface" ]] || return 1
  printf '%s\n' "$interface"
}

rp_detect_default_route_address() {
  command -v ip >/dev/null 2>&1 || return 1
  local route address
  route="$(ip -o -4 route show default 2>/dev/null | head -n1)"
  address="$(rp_default_route_address_text "$route")"
  if [[ -z "$address" ]]; then
    route="$(ip -o -4 route get 1.1.1.1 2>/dev/null | head -n1)"
    address="$(rp_default_route_address_text "$route")"
  fi
  [[ -n "$address" ]] || return 1
  printf '%s\n' "$address"
}

rp_detect_default_route_cidr() {
  command -v ip >/dev/null 2>&1 || return 1
  local interface address host_cidr
  interface="$(rp_detect_default_route_interface)" || return 1
  address="$(rp_detect_default_route_address)" || return 1
  host_cidr="$(ip -o -4 addr show dev "$interface" scope global 2>/dev/null \
    | awk -v address="$address" '$4 ~ ("^" address "/") { print $4; exit }')"
  [[ -n "$host_cidr" ]] || return 1
  rp_ipv4_network_cidr "$host_cidr"
}

rp_host_addresses() {
  ip -o addr show scope global | awk '{split($4,a,"/"); print a[1]}'
}

rp_validate_host_address() {
  local wanted="$1" addresses="${2:-}"
  if [[ -z "$addresses" ]]; then
    addresses="$(rp_host_addresses)"
  fi
  grep -Fxq -- "$wanted" <<<"$addresses"
}

rp_swarm_init() {
  local advertise_addr="$1" data_path_addr="${2:-$1}" state control
  rp_validate_host_address "$advertise_addr" || {
    printf 'Swarm advertise address is not assigned to this host: %s\n' "$advertise_addr" >&2
    return 1
  }
  rp_validate_host_address "$data_path_addr" || {
    printf 'Swarm data-path address is not assigned to this host: %s\n' "$data_path_addr" >&2
    return 1
  }
  state="$(docker info --format '{{.Swarm.LocalNodeState}}')"
  if [[ "$state" == "active" ]]; then
    control="$(docker info --format '{{.Swarm.ControlAvailable}}')"
    [[ "$control" == "true" ]] || {
      printf 'Host already belongs to a Swarm but is not a manager.\n' >&2
      return 1
    }
    return 0
  fi
  [[ "$state" == "inactive" ]] || {
    printf 'Docker Swarm is not in an initializable state: %s\n' "$state" >&2
    return 1
  }
  docker swarm init --advertise-addr "$advertise_addr" --data-path-addr "$data_path_addr"
}

rp_swarm_join() {
  local role="$1" manager_addr="$2" token="$3" advertise_addr="$4" data_path_addr="${5:-$4}"
  case "$role" in worker|manager) ;; *) return 1 ;; esac
  [[ -n "$manager_addr" && -n "$token" ]] || return 1
  rp_validate_host_address "$advertise_addr" || return 1
  rp_validate_host_address "$data_path_addr" || return 1
  docker swarm join \
    --token "$token" \
    --advertise-addr "$advertise_addr" \
    --data-path-addr "$data_path_addr" \
    "$manager_addr"
}

rp_manager_quorum_state() {
  local total="$1" reachable="$2" majority
  (( total > 0 && reachable >= 0 )) || return 1
  majority=$((total / 2 + 1))
  if (( reachable >= majority )); then
    printf 'healthy\n'
  else
    printf 'degraded\n'
  fi
}

rp_manager_quorum_recommendation() {
  local total="$1"
  (( total > 0 )) || return 1
  if (( total < 3 )); then
    printf 'recommend-3\n'
  elif (( total % 2 == 0 )); then
    printf 'recommend-odd\n'
  else
    printf 'ok\n'
  fi
}

rp_check_manager_quorum() {
  local total reachable state recommendation
  total="$(docker node ls --filter role=manager --format '{{.ID}}' | wc -l | tr -d ' ')"
  reachable="$(docker node ls --filter role=manager --format '{{.ManagerStatus.Reachability}}' | grep -c '^reachable$' || true)"
  state="$(rp_manager_quorum_state "$total" "$reachable")"
  recommendation="$(rp_manager_quorum_recommendation "$total")"
  printf 'state=%s managers=%s reachable=%s recommendation=%s\n' "$state" "$total" "$reachable" "$recommendation"
  [[ "$state" == "healthy" ]]
}



rp_swarm_resourceportal_secret_name() {
  local name="$1" var ref
  case "$name" in
    rp_postgres_password|zitadel_postgres_password|rp_encryption_key|rp_database_url|zitadel_secret_config|zitadel_init_steps|rp_first_admin_password|zitadel_masterkey)
      return 0
      ;;
    rp_cookie_secret_*|rp_internal_worker_token_*|rp_oidc_client_secret_*|zitadel_masterkey_*|rp_smtp_password_*|installer_swarm_worker_token_*|installer_swarm_manager_token_*|installer_enrollment_tls_cert_*|installer_enrollment_tls_key_*)
      return 0
      ;;
  esac
  for var in \
    RP_CFG_OIDC_SWARM_REF RP_CFG_ZITADEL_KEY_SWARM_REF RP_CFG_COOKIE_SWARM_REF RP_CFG_WORKER_SWARM_REF \
    RP_CFG_SMTP_SWARM_REF RP_CFG_ENROLLMENT_WORKER_TOKEN_REF RP_CFG_ENROLLMENT_MANAGER_TOKEN_REF; do
    ref="${!var-}"
    [[ -n "$ref" && "$name" == "$ref" ]] && return 0
  done
  return 1
}

rp_swarm_resourceportal_service_name() {
  local name="$1" stack="${2:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}"
  case "$name" in
    "${stack}_"*|"${stack}-installer-enrollment"|"${stack}-migration-"*|"${stack}-zitadel-bootstrap-"*|"${stack}-enrollment-issue-"*|rp-storage-runtime-probe-*) return 0 ;;
    *) return 1 ;;
  esac
}

rp_swarm_resourceportal_config_name() {
  local name="$1" stack="${2:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}"
  [[ "$name" == "${stack}_"* ]]
}

rp_swarm_unrelated_resources() {
  local stack="${RP_FACTORY_PLAN_STACK:-${RP_CFG_STACK_NAME:-resourceportal-control-plane}}" state name
  command -v docker >/dev/null 2>&1 || return 0
  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  [[ "$state" == active ]] || return 0

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    rp_swarm_resourceportal_service_name "$name" "$stack" || printf 'service %s\n' "$name"
  done < <(docker service ls --format '{{.Name}}' 2>/dev/null || true)

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    rp_swarm_resourceportal_secret_name "$name" || printf 'secret %s\n' "$name"
  done < <(docker secret ls --format '{{.Name}}' 2>/dev/null || true)

  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    rp_swarm_resourceportal_config_name "$name" "$stack" || printf 'config %s\n' "$name"
  done < <(docker config ls --format '{{.Name}}' 2>/dev/null || true)
}
