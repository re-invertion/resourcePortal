#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/control-plane.sh"

# Reproduce exact Docker CLI canonical names seen on the failed 0.2.93 update.
calls=()
capabilities='null'
docker() {
  case "$1 $2" in
    'service inspect') printf '%s\n' "$capabilities" ;;
    'service update')
      calls+=("$*")
      capabilities='["CAP_NET_ADMIN","CAP_SYS_ADMIN","CAP_SYS_PTRACE"]'
      ;;
    *) printf 'unexpected docker call: %s\n' "$*" >&2; return 9 ;;
  esac
}
rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN SYS_PTRACE
[[ "${#calls[@]}" == 1 ]] || { echo 'expected exactly one update' >&2; exit 1; }
[[ "${calls[0]}" == *'--cap-add NET_ADMIN'* &&
   "${calls[0]}" == *'--cap-add SYS_ADMIN'* &&
   "${calls[0]}" == *'--cap-add SYS_PTRACE'* ]] || exit 1
rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN SYS_PTRACE
[[ "${#calls[@]}" == 1 ]] || { echo 'canonical CAP_ values triggered unnecessary redeploy' >&2; exit 1; }
# Legacy bare-name inspect values are also supported.
capabilities='["NET_ADMIN","SYS_ADMIN","SYS_PTRACE"]'
rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN SYS_PTRACE
[[ "${#calls[@]}" == 1 ]] || exit 1

# A transient optimistic-lock conflict must be retried; arbitrary update
# failures must never be retried/hidden.
(
  counter=0
  capabilities='null'
  sleep() { :; }
  docker() {
    case "$1 $2" in
      'service inspect') printf '%s\n' "$capabilities" ;;
      'service update')
        counter=$((counter + 1))
        if (( counter == 1 )); then
          echo 'rpc error: code = Unknown desc = update out of sequence' >&2
          return 1
        fi
        capabilities='["CAP_NET_ADMIN","CAP_SYS_ADMIN","CAP_SYS_PTRACE"]'
        ;;
      *) return 9 ;;
    esac
  }
  rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN SYS_PTRACE
  [[ "$counter" == 2 ]]
)
(
  counter=0
  capabilities='null'
  sleep() { :; }
  docker() {
    case "$1 $2" in
      'service inspect') printf '%s\n' "$capabilities" ;;
      'service update') counter=$((counter + 1)); echo 'permission denied' >&2; return 1 ;;
      *) return 9 ;;
    esac
  }
  if rp_ensure_swarm_service_capabilities test_router NET_ADMIN 2>/dev/null; then
    echo 'unexpected success after permission denied' >&2; exit 1
  fi
  [[ "$counter" == 1 ]] || exit 1
)

# Rollback and forward stack deploy use the same bounded, conflict-only helper.
(
  count=0
  sleep() { :; }
  docker() {
    [[ "$1 $2" == 'stack deploy' ]] || return 9
    count=$((count + 1))
    if (( count == 1 )); then echo 'failed to update service resourceportal-control-plane_web: update out of sequence' >&2; return 1; fi
  }
  rp_swarm_stack_deploy_retry /tmp/previous-stack.yml resourceportal-control-plane
  [[ "$count" == 2 ]]
)
(
  count=0
  export RP_SWARM_CONFLICT_MAX_ATTEMPTS=2
  sleep() { :; }
  docker() {
    count=$((count + 1))
    echo 'update out of sequence' >&2
    return 1
  }
  if rp_swarm_stack_deploy_retry /tmp/previous-stack.yml resourceportal-control-plane 2>/dev/null; then
    echo 'unbounded retry erroneously succeeded' >&2; exit 1
  fi
  [[ "$count" == 2 ]]
)
(
  count=0
  docker() {
    count=$((count + 1))
    echo 'unauthorized Swarm operation' >&2
    return 1
  }
  if rp_swarm_stack_deploy_retry /tmp/previous-stack.yml resourceportal-control-plane 2>/dev/null; then
    exit 1
  fi
  [[ "$count" == 1 ]]
)
# Refuse malformed or non-JSON capability inspections, also if Docker claims success.
capabilities='{"CAP_NET_ADMIN":true}'
if rp_ensure_swarm_service_capabilities test_router NET_ADMIN 2>/dev/null; then
  echo 'malformed service capability spec accepted' >&2; exit 1
fi

echo 'PASS canonical CAP_ capabilities, Swarm conflicts, fail-closed rollback'
