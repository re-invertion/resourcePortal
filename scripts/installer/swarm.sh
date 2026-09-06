#!/usr/bin/env bash

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
